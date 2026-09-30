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
 * Every call gets a timeout, and on a timeout, a network error or a non-2xx it
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
  (configured || []).forEach(push);
  push(process.env.RPC_URL_FALLBACK);
  push(PUBLIC_RPC_FALLBACK);
  return chain;
}

/**
 * A fetch that walks the chain.
 *
 * `_info` is ignored on purpose: substituting a different endpoint on failure is the
 * entire point, so whatever URL the caller originally aimed at is not authoritative.
 */
function resilientRpcFetch(chain = endpointChain()) {
  return async function rpcFetch(_info, init) {
    let lastError = null;
    for (const url of chain) {
      try {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) });
        if (res.ok) return res;
        // A 429 or a 5xx is precisely the case worth failing over for.
        lastError = new Error(`${url} responded HTTP ${res.status}`);
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('all RPC endpoints failed');
  };
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
  fastSendEndpoints,
  sendViaJsonRpc,
};
