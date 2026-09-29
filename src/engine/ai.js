'use strict';
/**
 * Pluggable AI safety layer.
 *
 * Unlike the site, these are real adapters against real APIs with real model
 * identifiers you can change in config. The agent's job is narrow and useful:
 * given the structured on-chain facts about a candidate token, return a
 * confidence score and either `allow` or `skip`.
 *
 * Safety properties that matter here:
 *   • Hard timeout. A slow model must never delay a time-critical buy past its
 *     window — we abort and apply `onFailure`.
 *   • Fail-closed by default (`onFailure: 'skip'`). If the model is unreachable
 *     we do NOT buy on its behalf; the deterministic filters already ran.
 *   • The agent can only ever VETO. It can never raise position size beyond the
 *     wallet's configured band, and it can never trigger a buy by itself.
 *   • Results are cached per mint so repeated candidates cost one call.
 */
const log = require('../util/logger');

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // mint -> { verdict, ts }

/** The contract every provider must satisfy. */
const PROVIDERS = {
  /* ------------------------------- OpenAI ------------------------------- */
  openai: {
    label: 'OpenAI',
    defaultModel: 'gpt-4o-mini',
    async call({ apiKey, model, prompt, timeoutMs }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.1,
          max_tokens: 300,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`openai_http_${res.status}`);
      const j = await res.json();
      return j.choices?.[0]?.message?.content ?? '';
    },
  },

  /* ------------------------------ Anthropic ----------------------------- */
  anthropic: {
    label: 'Anthropic',
    defaultModel: 'claude-3-5-haiku-latest',
    async call({ apiKey, model, prompt, timeoutMs }) {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 300,
          temperature: 0.1,
          system: `${prompt.system}\nRespond with ONLY a JSON object.`,
          messages: [{ role: 'user', content: prompt.user }],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`anthropic_http_${res.status}`);
      const j = await res.json();
      return j.content?.[0]?.text ?? '';
    },
  },

  /* -------------------------------- Gemini ------------------------------ */
  gemini: {
    label: 'Google Gemini',
    defaultModel: 'gemini-2.0-flash',
    async call({ apiKey, model, prompt, timeoutMs }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 300, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`gemini_http_${res.status}`);
      const j = await res.json();
      return j.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    },
  },

  /* --------------------------------- xAI -------------------------------- */
  xai: {
    label: 'xAI Grok',
    defaultModel: 'grok-2-latest',
    async call({ apiKey, model, prompt, timeoutMs }) {
      const res = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user },
          ],
          temperature: 0.1,
          max_tokens: 300,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`xai_http_${res.status}`);
      const j = await res.json();
      return j.choices?.[0]?.message?.content ?? '';
    },
  },
};

const SYSTEM_PROMPT = `You are a risk analyst vetting brand-new Solana memecoin launches on pump.fun before an automated bot buys them.

You will receive structured on-chain facts. Judge ONLY from the facts given — you have no ability to look anything up, and inventing information is worse than abstaining.

Meme launches are inherently high-variance; being over-cautious is also a failure. Focus on genuine rug indicators:
- live mint/freeze authority (deployer can mint or freeze at will)
- extreme holder concentration
- the metadata looking like a deliberate clone of a well-known ticker
- a curve that has already run up substantially (late entry)
- socials that are missing when the name implies an established brand

Return STRICT JSON, no prose, exactly this shape:
{"confidence": <number 0..1, your conviction this is a legitimate trade>, "verdict": "allow" | "skip", "primary_risk": "<max 60 chars or empty>", "reasoning": "<max 200 chars>"}`;

function buildUserPrompt(candidate, report) {
  const { curveReport, distribution, metadata, devHoldPct } = report;
  const facts = {
    mint: candidate.mint,
    symbol: metadata?.symbol ?? candidate.symbol ?? null,
    name: metadata?.name ?? null,
    age_seconds: candidate.detectedAt ? Math.round((Date.now() - candidate.detectedAt) / 1000) : null,
    liquidity_sol: curveReport ? Number(curveReport.liquiditySol.toFixed(3)) : null,
    bonding_curve_progress_pct: curveReport?.progressPct ?? null,
    mint_authority_revoked: report.mintReport?.mintAuthorityRevoked ?? null,
    freeze_authority_revoked: report.mintReport?.freezeAuthorityRevoked ?? null,
    largest_non_curve_holder_pct: distribution?.largestHolderPct ?? null,
    top10_holder_pct: distribution?.top10Pct ?? null,
    holder_sample_size: distribution?.holderSample ?? null,
    dev_hold_estimate_pct: devHoldPct ?? null,
    socials: metadata?.socials ?? null,
    unicode_lookalike_name: metadata?.lookalike ?? null,
    symbol_collides_with_known_ticker: metadata?.symbolCollision ?? null,
    description: metadata?.description ?? null,
  };
  return `Evaluate this token launch:\n${JSON.stringify(facts, null, 2)}`;
}

/** Tolerant JSON extraction — models occasionally wrap output in fences. */
function parseVerdict(raw) {
  if (!raw) return null;
  let text = String(raw).trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  try {
    const j = JSON.parse(text.slice(start, end + 1));
    const confidence = Math.max(0, Math.min(1, Number(j.confidence ?? 0)));
    const verdict = j.verdict === 'allow' ? 'allow' : 'skip';
    return {
      confidence,
      verdict,
      primaryRisk: String(j.primary_risk ?? '').slice(0, 80),
      reasoning: String(j.reasoning ?? '').slice(0, 300),
    };
  } catch {
    return null;
  }
}

/**
 * Ask the configured agent about a candidate.
 * @returns {{ok:boolean, verdict:'allow'|'skip', confidence:number, source:string, detail?:string}}
 */
async function review(candidate, report, globalAi, walletAi = {}) {
  const enabled = walletAi.enabled === true;
  if (!enabled) return { ok: true, verdict: 'allow', confidence: 1, source: 'disabled' };

  const providerName = walletAi.overrideProvider || globalAi.provider;
  const provider = PROVIDERS[providerName];
  if (!provider) return failure(globalAi, `unknown_provider:${providerName}`);

  const apiKey = globalAi.apiKey || process.env[`${providerName.toUpperCase()}_API_KEY`] || '';
  if (!apiKey) return failure(globalAi, 'no_api_key');

  const cached = cache.get(candidate.mint);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.verdict, source: 'cache' };
  }

  const model = globalAi.model || provider.defaultModel;
  const minConfidence = Math.max(Number(walletAi.minConfidence || 0), Number(globalAi.minConfidence || 0));
  const timeoutMs = Math.min(Number(globalAi.timeoutMs || 5000), Number(globalAi.maxLatencyMs || 4000));

  const t0 = Date.now();
  try {
    const raw = await provider.call({
      apiKey,
      model,
      prompt: { system: SYSTEM_PROMPT, user: buildUserPrompt(candidate, report) },
      timeoutMs,
    });
    const elapsed = Date.now() - t0;
    const parsed = parseVerdict(raw);
    if (!parsed) return failure(globalAi, 'unparseable_response');

    let verdict = parsed.verdict;
    // Confidence gate: a low-conviction "allow" is treated as a skip.
    if (verdict === 'allow' && parsed.confidence < minConfidence) {
      verdict = 'skip';
      parsed.primaryRisk = parsed.primaryRisk || `below_min_confidence(${parsed.confidence.toFixed(2)}<${minConfidence})`;
    }

    const result = {
      ok: true,
      verdict,
      confidence: parsed.confidence,
      primaryRisk: parsed.primaryRisk,
      reasoning: parsed.reasoning,
      source: `${providerName}:${model}`,
      latencyMs: elapsed,
    };
    cache.set(candidate.mint, { verdict: result, ts: Date.now() });
    log.debug(`AI ${verdict} (${parsed.confidence.toFixed(2)}) on ${candidate.symbol || candidate.mint.slice(0, 6)} in ${elapsed}ms`, { data: result });
    return result;
  } catch (err) {
    const detail = err.name === 'TimeoutError' ? 'timeout' : err.message;
    log.warn(`AI agent unavailable (${detail}) — applying onFailure=${globalAi.onFailure}`);
    return failure(globalAi, detail);
  }
}

function failure(globalAi, detail) {
  const allow = globalAi.onFailure === 'allow';
  return {
    ok: false,
    verdict: allow ? 'allow' : 'skip',
    confidence: 0,
    source: 'fallback',
    detail,
  };
}

/** Cheap reachability probe used by the UI. */
async function probe(globalAi) {
  const provider = PROVIDERS[globalAi.provider];
  if (!provider) return { ok: false, error: 'unknown_provider' };
  const apiKey = globalAi.apiKey || process.env[`${globalAi.provider.toUpperCase()}_API_KEY`] || '';
  if (!apiKey) return { ok: false, error: 'no_api_key' };
  try {
    const raw = await provider.call({
      apiKey,
      model: globalAi.model || provider.defaultModel,
      prompt: { system: SYSTEM_PROMPT, user: 'Return {"confidence":0.5,"verdict":"skip","primary_risk":"probe","reasoning":"reachability probe"}' },
      timeoutMs: 8000,
    });
    return { ok: Boolean(raw), sample: String(raw).slice(0, 120) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { review, probe, parseVerdict, PROVIDERS };
