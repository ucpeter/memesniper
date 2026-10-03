'use strict';
/**
 * RPC plumbing: one endpoint chain, one timeout, one place to look.
 *
 * WHAT WAS WRONG
 * The executor built one Connection per configured endpoint and round-robined
 * between them. That fails in the two ways that actually happen in production:
 *
 *  1. NO TIMEOUT. web3.js will wait on a socket that never answers. A stalled
 *     endpoint holds an evaluation slot until the engine's own eval timeout fires —
 *     the bot looks alive while doing nothing.
 *  2. ROUND-ROBIN IS NOT FAILOVER. It moves to the next endpoint on the *next*
 *     request, so the request that hit the dead one still fails. A 429 from the
 *     public RPC is not retried anywhere; it becomes "rpc_unavailable" for that
 *     token, which is exactly the misattribution that made every launch look like a
 *     scam before.
 *
 * WHAT THIS DOES
 * Every call gets a timeout, and on a timeout, a network error, a 429 or a 5xx it
 * retries the SAME call against the next endpoint in the chain — primary, then an
 * optional configured fallback, then the public RPC. This is the shape the reference
 * sniper uses (a fetch wrapper handed to Connection), and it is the right shape
 * because it needs no other code change: `new Connection(url, { fetch })` makes every
 * JSON-RPC call inherit it.
 *
 * Deliberately stateless. No circuit breaker, no "provider X is unhealthy" memory:
 * a decision made two seconds ago is often wrong by the time the next call arrives,
 * and stale health state is its own failure mode.
 */
const PUBLIC_RPC_FALLBACK = 'https://api.mainnet-beta.solana.com';
const ATTEMPT_TIMEOUT_MS = Number(process.env.RPC_ATTEMPT_TIMEOUT_MS || 8000);

/**
 * The endpoint chain, in order of preference.
 *
 * RPC_URL and RPC_URL_FALLBACK are the documented names; RPC_ENDPOINTS is accepted
 * because that is what the config file and the dashboard's settings box use.
 */
function endpointChain(configured = []) {
  const chain = [];
  const push = (url) => {
    const u = String(url || '').trim();
    if (u && !chain.includes(u)) chain.push(u);
  };

  push(process.env.RPC_URL);
  push(process.env.RPC_URL_FALLBACK);
  (configured || []).forEach(push);
  push(PUBLIC_RPC_FALLBACK);
  return chain;
}

/**
 * A fetch that walks the chain.
 *
 * `_info` is ignored on purpose: substituting a different endpoint on failure is the
 * entire point, so whatever URL the caller originally aimed at is not authoritative.
 */
/** Never include endpoint URLs (which often embed API keys) in logs or errors. */
function transportKind(err) {
  const name = String(err?.name || '');
  const code = String(err?.cause?.code || err?.code || '').toUpperCase();
  if (name === 'TimeoutError' || name === 'AbortError' || /TIMEOUT/.test(code)) return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) return 'dns_failure';
  if (['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return code.toLowerCase();
  return 'network_failure';
}

function resilientRpcFetch(chain = endpointChain()) {
  return async function rpcFetch(_info, init) {
    const failures = [];
    for (const [index, url] of chain.entries()) {
      const label = `endpoint ${index + 1}`;
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
        if (res.ok) {
          let body;
          try { body = await res.clone().json(); } catch { /* non-JSON response */ }
          const err = body && body.error;
          const message = String(err && err.message || '');
          const busy = err && (err.code === 429 || err.code === -32005 ||
            /rate limit|too many requests|node is behind|block not available/i.test(message));
          if (!busy) return res; // legitimate JSON-RPC error belongs to caller
          failures.push(`${label}: rate_limited`);
          continue;
        }
        // 401/403/invalid request are not transient. Preserve the real HTTP
        // response for web3.js; the diagnostic probe will report its safe code.
        if (res.status !== 429 && res.status < 500) return res;
        failures.push(`${label}: HTTP ${res.status}`);
      } catch (err) {
        failures.push(`${label}: ${transportKind(err)}`);
      }
    }
    // Safe to log or show: endpoint indexes and status codes ONLY. No host,
    // query string or third-party response body containing a provider key.
    throw new Error(`RPC_ENDPOINTS_FAILED [${failures.join('; ') || 'no endpoints'}]`);
  };
}

/** A one-shot, bounded check of the SAME getAccountInfo method safety needs.
 * This bypasses failover so the operator can see which endpoint is broken.
 * No URL or provider error body is returned (API keys are often in either). */
async function probeRpcEndpoints(chain = endpointChain(), fetchImpl = (...args) => fetch(...args)) {
  const checked = (chain || []).slice(0, 5);
  const results = await Promise.all(checked.map(async (url, index) => {
    const label = `endpoint ${index + 1}`;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
          params: ['11111111111111111111111111111111', { encoding: 'base64', commitment: 'processed' }] }),
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (!res.ok) return { label, ok: false, status: `HTTP ${res.status}` };
      let body;
      try { body = await res.json(); }
      catch { return { label, ok: false, status: 'invalid_json' }; }
      if (body && body.error) {
        const code = Number(body.error.code);
        return { label, ok: false, status: Number.isSafeInteger(code) ? `JSON-RPC ${code}` : 'rpc_error' };
      }
      return { label, ok: Boolean(body && body.result && body.result.value),
        status: body && body.result && body.result.value ? 'getAccountInfo OK' : 'no_account_data' };
    } catch (err) {
      return { label, ok: false, status: transportKind(err) };
    }
  }));
  return { results, omitted: Math.max(0, (chain || []).length - checked.length) };
}

/**
 * Extra submission channels, tried in PARALLEL with the normal RPC.
 *
 * A sniped entry competes in the same slot as everyone else's; whichever channel
 * lands first wins and the others are wasted. So these are broadcast simultaneously
 * rather than in sequence. Both Helius Sender and QuickNode's Fastlane accept a
 * plain JSON-RPC `sendTransaction`, so one generic mechanism covers them both —
 * configure with FAST_SEND_URLS, comma separated.
 */
function fastSendEndpoints() {
  return String(process.env.FAST_SEND_URLS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** POST a signed transaction to one JSON-RPC endpoint, returning its signature. */
async function sendViaJsonRpc(url, base64Tx, label) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now().toString(),
      method: 'sendTransaction',
      params: [base64Tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${label}: ${json.error.message || JSON.stringify(json.error)}`);
  if (!json.result) throw new Error(`${label}: no signature returned`);
  return json.result;
}

module.exports = {
  PUBLIC_RPC_FALLBACK,
  ATTEMPT_TIMEOUT_MS,
  endpointChain,
  resilientRpcFetch,
  probeRpcEndpoints,
  fastSendEndpoints,
  sendViaJsonRpc,
};
