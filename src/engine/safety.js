'use strict';
/**
 * Pre-buy safety filter.
 *
 * Every check is labelled with its confidence so you can reason about what you
 * are actually trusting:
 *
 *   [HARD]   derived from on-chain account data — authoritative.
 *   [HEUR]   a heuristic. Useful signal, not proof.
 *   [EXT]    depends on a third-party endpoint being up and honest.
 *
 * A tokend that fails a HARD check is never bought. HEUR failures are scored.
 */
const { PublicKey } = require('@solana/web3.js');
const { bondingCurvePct, lamportsToSol } = require('./curve');

const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022_PROGRAM = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');

/* ------------------------------------------------------------------ *
 * Account decoders
 * ------------------------------------------------------------------ */

/** SPL Token Mint layout — decimals @44, freezeAuthorityOption @46. */
function parseMint(data) {
  if (data.length < 82) return null;
  return {
    mintAuthorityOption: data.readUInt32LE(0),
    mintAuthority: data.readUInt32LE(0) === 1 ? new PublicKey(data.subarray(4, 36)).toBase58() : null,
    supply: data.readBigUInt64LE(36),
    decimals: data.readUInt8(44),
    isInitialised: data.readUInt8(45) === 1,
    freezeAuthorityOption: data.readUInt32LE(46),
    freezeAuthority: data.readUInt32LE(46) === 1 ? new PublicKey(data.subarray(50, 82)).toBase58() : null,
  };
}

/** pump.fun BondingCurve account layout. */
function parseBondingCurve(data) {
  if (data.length < 49) return null;
  return {
    virtualTokenReserves: data.readBigUInt64LE(8),
    virtualSolReserves: data.readBigUInt64LE(16),
    realTokenReserves: data.readBigUInt64LE(24),
    realSolReserves: data.readBigUInt64LE(32),
    tokenTotalSupply: data.readBigUInt64LE(40),
    complete: data.readUInt8(48) === 1,
  };
}

function bondingCurvePda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()],
    PUMP_PROGRAM
  )[0];
}

/* ------------------------------------------------------------------ *
 * Freshness-tolerant account fetch
 * ------------------------------------------------------------------ */

/**
 * Fetch an account, tolerating the chain/RPC propagation delay that always
 * exists immediately after a token is created.
 *
 * A brand-new mint is detected from the websocket the instant the Create
 * instruction lands, but a node may not yet serve that account — and different
 * commitment levels disagree for a short window. Without retrying here the bot
 * rejects every launch with `bonding_curve_not_found` and buys nothing.
 *
 * Strategy: try `processed` (fastest, most likely to already have it), then
 * fall back to the configured commitment, retrying with a short backoff that
 * fits inside the snipe window.
 */
/** Is this RPC error a rate limit / transport failure rather than an answer? */
function isTransportError(err) {
  const m = String((err && err.message) || err || '').toLowerCase();
  return (
    m.includes('429') ||
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('timeout') ||
    m.includes('timed out') ||
    m.includes('fetch failed') ||
    m.includes('econnreset') ||
    m.includes('enotfound') ||
    m.includes('502') ||
    m.includes('503') ||
    m.includes('504')
  );
}

async function fetchAccountResilient(conn, address, opts = {}) {
  const {
    attempts = 3,
    baseDelayMs = 150,
    maxDelayMs = 600,
  } = opts;

  const commitments = ['processed', 'confirmed'];
  let lastErr = null;
  let sawDefinitiveAbsence = false; // RPC answered, and the answer was "no such account"

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const commitment of commitments) {
      try {
        const info = await conn.getAccountInfo(address, commitment);
        if (info) return { info, commitment, attempt };
        // A null answer from a healthy RPC is a real verdict.
        sawDefinitiveAbsence = true;
      } catch (err) {
        lastErr = err;
        // Retrying a rate limit just deepens the hole. Bail immediately and
        // report it as an infrastructure problem so the operator can see that
        // their RPC is the issue rather than blaming the token.
        if (isTransportError(err)) {
          return { info: null, absent: false, transportError: true, error: err.message };
        }
      }
    }
    if (attempt < attempts - 1) {
      const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (sawDefinitiveAbsence) {
    return { info: null, absent: true, transportError: false };
  }
  return {
    info: null,
    absent: false,
    transportError: true,
    error: lastErr ? lastErr.message : 'unknown',
  };
}

/* ------------------------------------------------------------------ *
 * Checks
 * ------------------------------------------------------------------ */

async function checkMintAuthorities(conn, mint) {
  try {
    const addr = new PublicKey(mint);
    const { info, absent, transportError, error } = await fetchAccountResilient(conn, addr);
    if (!info) {
      if (transportError) return { pass: false, reason: `rpc_unavailable(${String(error).slice(0, 60)})`, confidence: 'INFRA' };
      return { pass: false, reason: 'mint_account_not_found', confidence: 'HARD', absent: Boolean(absent) };
    }
    const parsed = parseMint(info.data);
    if (!parsed) return { pass: false, reason: 'mint_parse_failed', confidence: 'HARD' };
    return {
      pass: true,
      confidence: 'HARD',
      mintAuthorityRevoked: parsed.mintAuthorityOption === 0,
      freezeAuthorityRevoked: parsed.freezeAuthorityOption === 0,
      decimals: parsed.decimals,
      supply: parsed.supply,
    };
  } catch (err) {
    return { pass: false, reason: `mint_rpc_error:${err.message}`, confidence: 'HARD' };
  }
}

async function checkCurve(conn, mint) {
  try {
    const pda = bondingCurvePda(mint);
    const { info, absent, transportError, error } = await fetchAccountResilient(conn, pda);
    if (!info) {
      if (transportError) return { pass: false, reason: `rpc_unavailable(${String(error).slice(0, 60)})`, confidence: 'INFRA' };
      return { pass: false, reason: 'bonding_curve_not_found', confidence: 'HARD', absent: Boolean(absent) };
    }
    const curve = parseBondingCurve(info.data);
    if (!curve) return { pass: false, reason: 'curve_parse_failed', confidence: 'HARD' };
    if (curve.complete) return { pass: false, reason: 'already_migrated', confidence: 'HARD' };
    return {
      pass: true,
      confidence: 'HARD',
      curve,
      liquiditySol: lamportsToSol(curve.realSolReserves),
      progressPct: bondingCurvePct(curve.realSolReserves),
    };
  } catch (err) {
    return { pass: false, reason: `curve_rpc_error:${err.message}`, confidence: 'HARD' };
  }
}

/**
 * [HEUR] Concentration check.
 * On a brand-new launch almost all supply sits in the curve itself, so raw
 * "top holder holds 60%" rejections are useless. We therefore exclude the
 * bonding curve's own token account and measure concentration among real
 * holders only.
 */
async function checkDistribution(conn, mint, curvePda) {
  try {
    const largest = await conn.getTokenLargestAccounts(new PublicKey(mint), 'confirmed');
    if (!largest?.value?.length) return { pass: true, confidence: 'HEUR', skipped: 'no_token_accounts_yet' };

    const entries = largest.value
      .filter((a) => a.address.toBase58() !== curvePda.toBase58())
      .map((a) => ({ address: a.address.toBase58(), amount: BigInt(a.amount) }));

    const total = entries.reduce((acc, e) => acc + e.amount, 0n);
    const top10 = entries.slice(0, 10).reduce((acc, e) => acc + e.amount, 0n);
    const top10Pct = total === 0n ? 0 : Number((top10 * 10000n) / total) / 100;

    return {
      pass: true,
      confidence: 'HEUR',
      top10Pct,
      holderSample: entries.length,
      largestHolderPct: entries[0] && total > 0n ? Number((entries[0].amount * 10000n) / total) / 100 : 0,
    };
  } catch (err) {
    return { pass: true, confidence: 'HEUR', skipped: `distribution_unavailable:${err.message}` };
  }
}

/**
 * [HEUR] Dev-hold estimate.
 * The pump.fun `create` instruction does not expose the creator in the bonding
 * curve account, so we cannot read "the dev's balance" directly without an
 * indexer. We approximate with the single largest non-curve holder, which for
 * a fresh launch is normally the creator's initial buy.
 * If you wire in an indexer (Helius/SolanaTracker), replace this with the real
 * creator balance — this is the weakest check in the file and it is flagged so.
 */
function estimateDevHold(distribution) {
  if (!distribution || distribution.skipped) return null;
  return distribution.largestHolderPct ?? null;
}

/**
 * [EXT] Off-chain metadata: socials + copycat detection.
 * Sources pump.fun's public metadata for the mint.
 */
async function checkMetadata(mint, { blockCopycatNames = true, knownSymbols = new Set() } = {}) {
  try {
    const res = await fetch(`https://frontend-api-v3.pump.fun/coins/${mint}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { pass: true, confidence: 'EXT', skipped: `metadata_http_${res.status}` };
    const j = await res.json();

    const name = (j.name || '').trim();
    const symbol = (j.symbol || '').trim();
    const hasTwitter = Boolean(j.twitter);
    const hasTelegram = Boolean(j.telegram);
    const hasWebsite = Boolean(j.website);

    // Copycat heuristic: a symbol colliding with an established ticker plus a
    // name stuffed with unicode lookalikes is a classic ride-the-wave scam.
    const lookalike = /[\u0400-\u04FF\u0370-\u03FF\uFF00-\uFFEF]/.test(name);
    const symbolCollision = blockCopycatNames && symbol && knownSymbols.has(symbol.toUpperCase());

    return {
      pass: true,
      confidence: 'EXT',
      name,
      symbol,
      hasSocial: hasTwitter || hasTelegram || hasWebsite,
      socials: { twitter: Boolean(j.twitter), telegram: Boolean(j.telegram), website: Boolean(j.website) },
      lookalike,
      symbolCollision,
      creator: j.creator || null,
      created: j.created_timestamp ? Number(j.created_timestamp) : null,
      usdMarketCap: j.usd_market_cap ?? null,
      image: j.image_uri || null,
      description: (j.description || '').slice(0, 280),
    };
  } catch (err) {
    return { pass: true, confidence: 'EXT', skipped: `metadata_error:${err.message}` };
  }
}

/**
 * [HEUR] Honeypot / transfer-tax probe.
 * A true simulation requires the wallet to actually hold the token. Pre-buy,
 * the honest signal available is the freeze authority plus metadata: a live
 * freeze authority lets the deployer brick every holder's account at will,
 * which is the mechanism behind most pump.fun "can't sell" reports.
 */
function assessHoneypotRisk(mintReport, filters) {
  const notes = [];
  let risk = 0;

  if (mintReport && mintReport.freezeAuthorityRevoked === false) {
    notes.push('freeze_authority_live');
    risk += 60;
  }
  if (mintReport && mintReport.mintAuthorityRevoked === false) {
    notes.push('mint_authority_live');
    risk += 25;
  }
  return { risk, notes, pass: risk < (filters.maxHoneypotRisk ?? 50) };
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */
/**
 * Run every filter for a candidate token against a wallet's config.
 * @returns {{ok:boolean, score:number, reasons:string[], report:object}}
 */
/* ------------------------------------------------------------------ *
 * Per-mint report cache
 * ------------------------------------------------------------------ *
 * One candidate fans out to EVERY wallet, and each wallet's filters need the
 * same chain data for that mint. Without a cache that is 3 identical
 * getAccountInfo + getTokenLargestAccounts round trips per token — pure waste
 * on the hottest path, and it pushes a public RPC straight into its rate limit.
 *
 * The TTL is deliberately short. Within a single launch's fan-out the data is
 * identical; across launches it is not, and a stale curve would be a real
 * trading error. Only SUCCESSFUL reads are cached — caching a failure would
 * turn a transient outage into a persistent one.
 */
const _reportCache = new Map(); // mint -> { bundle, ts }

function _cacheGet(mint, ttlMs) {
  const hit = _reportCache.get(mint);
  if (!hit) return null;
  if (Date.now() - hit.ts > ttlMs) { _reportCache.delete(mint); return null; }
  return hit.bundle;
}

function _cacheSet(mint, bundle, ttlMs) {
  _reportCache.set(mint, { bundle, ts: Date.now() });
  // Bound the map so a launch storm cannot grow it without limit.
  if (_reportCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of _reportCache) if (now - v.ts > ttlMs) _reportCache.delete(k);
    while (_reportCache.size > 500) _reportCache.delete(_reportCache.keys().next().value);
  }
}

/**
 * [RECON] The shared facts about a launch, with NO verdict attached.
 *
 * WHY THIS EXISTS
 * The scanner table shows dev hold, liquidity and risk per launch. Those numbers
 * were only ever produced as a side effect of a WALLET evaluating the token, and
 * `evaluate()` returns early on its first hard failure — so a token rejected on
 * liquidity never reached the distribution check, and a token seen while no
 * wallet was armed was never evaluated at all. Both cases left the columns empty
 * on screen, reported from the live app as "dev hold and risk is not displayed".
 *
 * This runs ONCE per mint for the table, independent of every wallet:
 *   · it shares the per-mint report cache, so an armed wallet evaluating the same
 *     launch does not pay for these reads twice;
 *   · it never decides anything — no filters, no score, no refusal;
 *   · it is best-effort by construction. An RPC that cannot be reached returns
 *     nulls and the caller leaves the cells blank rather than inventing numbers.
 */
async function recon(candidate, ctx = {}) {
  const conn = ctx.conn;
  const config = ctx.config;
  const ttlMs = config?.scanner?.reportCacheMs ?? 2000;

  if (!conn || !candidate || !candidate.mint) return { ok: false, reason: 'no_connection' };

  let bundle = _cacheGet(candidate.mint, ttlMs);
  if (!bundle) {
    const [mintReportFresh, curveReportFresh] = await Promise.all([
      checkMintAuthorities(conn, candidate.mint),
      checkCurve(conn, candidate.mint),
    ]);
    bundle = { mintReport: mintReportFresh, curveReport: curveReportFresh };
    const good = mintReportFresh.pass || mintReportFresh.absent || mintReportFresh.confidence !== 'INFRA';
    const goodCurve = curveReportFresh.pass || curveReportFresh.absent || curveReportFresh.confidence !== 'INFRA';
    if (good && goodCurve) _cacheSet(candidate.mint, bundle, ttlMs);
  }
  const { mintReport, curveReport } = bundle;

  const unreachable = [mintReport, curveReport].filter((r) => r.confidence === 'INFRA');
  const distribution = unreachable.length
    ? null
    // A curve read that failed still gives us a mint report worth showing; a
    // distribution read that fails gives null and leaves the cell blank.
    : await checkDistribution(conn, candidate.mint, bondingCurvePda(candidate.mint)).catch(() => null);

  // Risk is judged against the HARDEST reasonable reading of the mint account
  // (live freeze authority, live mint authority) — no wallet's preferences are
  // involved, because this number is shown to a human, not used to buy.
  const honeypot = mintReport && mintReport.confidence !== 'INFRA'
    ? assessHoneypotRisk(mintReport, { maxHoneypotRisk: 50 })
    : null;

  return {
    ok: unreachable.length === 0,
    infra: unreachable.length > 0,
    reason: unreachable.length ? unreachable.map((r) => r.reason).join('; ') : null,
    report: {
      liquiditySol: curveReport && curveReport.confidence !== 'INFRA' ? curveReport.liquiditySol ?? null : null,
      progressPct: curveReport && curveReport.confidence !== 'INFRA' ? curveReport.progressPct ?? null : null,
      devHoldPct: distribution ? estimateDevHold(distribution) : null,
      top10Pct: distribution && distribution.top10Pct !== undefined ? distribution.top10Pct : null,
      holderSample: distribution ? distribution.holderSample ?? null : null,
      honeypot,
    },
  };
}

async function evaluate(candidate, cfg, ctx) {
  const { conn, config } = ctx;
  const f = cfg.filters;
  const reasons = [];
  const hardFails = [];
  let score = 0;

  // Reuse a very recent read if another wallet is evaluating this same mint
  // right now. Walks the same code path otherwise.
  const ttlMs = config?.scanner?.reportCacheMs ?? 2000;
  let bundle = _cacheGet(candidate.mint, ttlMs);
  if (!bundle) {
    const [mintReportFresh, curveReportFresh] = await Promise.all([
      checkMintAuthorities(conn, candidate.mint),
      checkCurve(conn, candidate.mint),
    ]);
    bundle = { mintReport: mintReportFresh, curveReport: curveReportFresh };
    // Only cache a genuine answer. A failed read must be retried by the next
    // wallet rather than frozen into a false verdict.
    const good = mintReportFresh.pass || mintReportFresh.absent || (!mintReportFresh.confidence || mintReportFresh.confidence !== 'INFRA');
    const goodCurve = curveReportFresh.pass || curveReportFresh.absent || (curveReportFresh.confidence !== 'INFRA');
    if (good && goodCurve) _cacheSet(candidate.mint, bundle, ttlMs);
  }
  const { mintReport, curveReport } = bundle;

  // An RPC we could not reach tells us NOTHING about the token. Report it as an
  // infrastructure error so "why is nothing buying?" points at the RPC instead
  // of slandering every launch as a bad token.
  const infra = [mintReport, curveReport].filter((r) => r.confidence === 'INFRA');
  if (infra.length) {
    return {
      ok: false,
      score: 0,
      reasons: [...new Set(infra.map((r) => r.reason))],
      hard: false,
      infra: true,
      report: { mintReport, curveReport },
    };
  }

  if (!mintReport.pass) hardFails.push(mintReport.reason);
  if (!curveReport.pass) hardFails.push(curveReport.reason);

  if (hardFails.length) {
    return { ok: false, score: 0, reasons: hardFails, hard: true, report: { mintReport, curveReport } };
  }

  /* ---- HARD gates ---- */
  if (f.requireMintAuthorityRevoked && !mintReport.mintAuthorityRevoked) {
    hardFails.push('mint_authority_not_revoked');
  }
  if (f.requireFreezeAuthorityRevoked && !mintReport.freezeAuthorityRevoked) {
    hardFails.push('freeze_authority_not_revoked');
  }

  const liquiditySol = curveReport.liquiditySol;
  if (liquiditySol < f.minLiquiditySol) hardFails.push(`liquidity_below_min(${liquiditySol.toFixed(2)})`);
  // Upper bound: 0 means no ceiling. Lets you skip launches that are already
  // crowded — by the time a curve holds a lot of SOL the easy multiple is gone
  // and you are buying someone else's exit.
  if (f.maxLiquiditySol > 0 && liquiditySol > f.maxLiquiditySol) {
    hardFails.push(`liquidity_above_max(${liquiditySol.toFixed(2)}>${f.maxLiquiditySol})`);
  }
  if (curveReport.progressPct > f.maxBondingCurvePct) hardFails.push(`curve_already_ran(${curveReport.progressPct}%)`);

  const age = candidate.detectedAt ? Date.now() - candidate.detectedAt : 0;
  if (f.maxAgeMs > 0 && age > f.maxAgeMs) hardFails.push(`token_too_old(${Math.round(age / 1000)}s)`);

  if (hardFails.length) {
    return { ok: false, score: 0, reasons: hardFails, hard: true, report: { mintReport, curveReport } };
  }

  /* ---- HEUR / EXT scoring ---- */
  const distribution = await checkDistribution(conn, candidate.mint, bondingCurvePda(candidate.mint));
  const metadata = await checkMetadata(candidate.mint, { blockCopycatNames: f.blockCopycatNames });
  const devHoldPct = estimateDevHold(distribution);

  if (devHoldPct !== null && devHoldPct > f.maxDevHoldPct) {
    reasons.push(`dev_hold_high(${devHoldPct.toFixed(1)}%>${f.maxDevHoldPct}%)`);
    score -= 25;
  }
  if (distribution.top10Pct !== undefined && distribution.top10Pct > f.maxTop10HoldersPct) {
    reasons.push(`top10_concentrated(${distribution.top10Pct.toFixed(1)}%)`);
    score -= 15;
  }
  if (f.requireSocial && metadata.socials && !metadata.hasSocial) {
    reasons.push('no_socials');
    score -= 20;
  }
  if (metadata.lookalike) {
    reasons.push('unicode_lookalike_name');
    score -= 30;
  }
  if (metadata.symbolCollision) {
    reasons.push('symbol_collides_with_known_ticker');
    score -= 25;
  }
  if (metadata.creator && f.devBlacklist.includes(metadata.creator)) {
    hardFails.push('dev_blacklisted');
  }
  if (f.mintBlacklist.includes(candidate.mint)) {
    hardFails.push('mint_blacklisted');
  }
  if (metadata.created && Date.now() - metadata.created < 1000) {
    // Sub-second-old metadata usually means the frontend API is stale, not a real signal.
    reasons.push('metadata_very_fresh');
  }

  const honeypot = assessHoneypotRisk(mintReport, f);
  if (!honeypot.pass) {
    reasons.push(...honeypot.notes);
    score -= honeypot.risk;
  }

  if (hardFails.length) {
    return { ok: false, score: 0, reasons: [...hardFails, ...reasons], hard: true, report: { mintReport, curveReport, distribution, metadata } };
  }

  // Base score rewards a healthy curve with real liquidity.
  score += Math.min(40, liquiditySol * 2) + Math.min(20, distribution.holderSample || 0);

  return {
    ok: score >= (config.scanner.minScoreToEvaluate ?? 0) - 30, // tolerant default: block only clear negatives
    score,
    reasons,
    hard: false,
    report: { mintReport, curveReport, distribution, metadata, devHoldPct, honeypot },
  };
}

module.exports = {
  fetchAccountResilient,
  _reportCache, // exposed for tests
  PUMP_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  parseMint,
  parseBondingCurve,
  bondingCurvePda,
  checkMintAuthorities,
  checkCurve,
  checkDistribution,
  checkMetadata,
  assessHoneypotRisk,
  recon,
  evaluate,
};
