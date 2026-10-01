'use strict';
/**
 * SOL/USD, in one place.
 *
 * WHY THIS EXISTS
 * The scanner table used to express liquidity in SOL, which cannot be compared
 * against anything a human knows — "0.98 SOL" is not a number anyone can judge.
 * The reference bot this one is measured against prices the curve in dollars
 * (its `minLiquidityUsd` / `maxLiquidityUsd` filters and its `liquidityUsd`
 * column), and its `getSolPriceUsd()` is a 20-second cache in front of a public
 * price API. This is the same idea with one difference that matters for a table
 * a human reads before money moves: **a fallback is marked as a fallback**.
 *
 * The reference falls back to a hard-coded 150 USD when the price API is
 * unreachable. That is fine for a filter that only has to be roughly right, and
 * dishonest in a column labelled LIQUIDITY — a $ number nobody can distinguish
 * from a real quote. So:
 *
 *   · a real provider price  → `source: 'coingecko' | 'binance' | 'coinbase'`
 *   · a previously read price that is now stale → `stale: true`
 *   · nothing ever read, everything unreachable → `source: 'fallback'`, and the
 *     table says so next to the figure instead of printing it as if it were real.
 *
 * No API key is needed for any of the three providers. Nothing is sent to them
 * but the request itself.
 */

const TTL_MS = 20_000; // the reference bot's cache window
const TIMEOUT_MS = 3_500;

/** The reference bot's last-resort constant. Kept, but never passed off as live. */
const FALLBACK_USD = 150;

const PROVIDERS = [
  {
    name: 'coingecko',
    url: 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    pick: (j) => Number(j && j.solana && j.solana.usd),
  },
  {
    name: 'binance',
    url: 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
    pick: (j) => Number(j && j.price),
  },
  {
    name: 'coinbase',
    url: 'https://api.coinbase.com/v2/prices/SOL-USD/spot',
    pick: (j) => Number(j && j.data && j.data.amount),
  },
];

let state = {
  usd: null,
  source: 'none',
  at: 0,
  stale: false,
  ok: false,
  error: null,
};

let fetchImpl = typeof fetch === 'function' ? fetch : null;
let inflight = null;

/** Same 20s cache the reference bot uses. */
function isFresh() {
  return state.ok && Date.now() - state.at < TTL_MS;
}

/** What we know right now, without any I/O. Never throws, never blocks. */
function lastKnown() {
  return { ...state, stale: !isFresh() && state.ok };
}

/**
 * The number to use in arithmetic. `null` when nothing has ever been read —
 * callers must handle that rather than inventing a price.
 */
function usdNow() {
  if (isFresh()) return state.usd;
  if (state.ok) return state.usd; // stale but real; `lastKnown().stale` says so
  return null;
}

/**
 * The number to use in arithmetic when a *display* figure is wanted and a
 * marked fallback is acceptable (the reference bot's behaviour).
 */
function usdOrFallback() {
  const real = usdNow();
  if (real !== null) return real;
  return FALLBACK_USD;
}

async function fetchOne(provider) {
  if (!fetchImpl) throw new Error('no fetch available');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(provider.url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const price = provider.pick(json);
    if (!Number.isFinite(price) || price <= 0) throw new Error('unusable price payload');
    return price;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Refresh the price, at most once per TTL_MS unless `force`.
 * Concurrent callers share one request rather than stampeding the provider.
 */
async function get({ force = false } = {}) {
  if (!force && isFresh()) return lastKnown();
  if (inflight) return inflight;

  inflight = (async () => {
    const errors = [];
    for (const provider of PROVIDERS) {
      try {
        const price = await fetchOne(provider);
        state = { usd: price, source: provider.name, at: Date.now(), stale: false, ok: true, error: null };
        return lastKnown();
      } catch (err) {
        errors.push(`${provider.name}: ${err.message}`);
      }
    }
    // Every provider failed. Keep a previous real reading if we have one; only
    // fall back to the constant when we have never had one.
    state = {
      ...state,
      stale: Boolean(state.ok),
      ok: Boolean(state.ok),
      source: state.ok ? state.source : 'fallback',
      usd: state.ok ? state.usd : FALLBACK_USD,
      error: errors.join('; ') || 'no provider reachable',
    };
    return lastKnown();
  })().finally(() => { inflight = null; });

  return inflight;
}

/* ------------------------------ test hooks ------------------------------ */

/** Test seam: swap the network out. Not used by the running bot. */
function __setFetch(fn) { fetchImpl = fn; }

/** Test seam: install a known price without any I/O. */
function __setPrice(usd, source = 'test') {
  state = { usd, source, at: Date.now(), stale: false, ok: true, error: null };
}

function __reset() {
  state = { usd: null, source: 'none', at: 0, stale: false, ok: false, error: null };
  fetchImpl = typeof fetch === 'function' ? fetch : null;
  inflight = null;
}

module.exports = {
  TTL_MS,
  FALLBACK_USD,
  PROVIDERS,
  get,
  lastKnown,
  usdNow,
  usdOrFallback,
  __setFetch,
  __setPrice,
  __reset,
};
