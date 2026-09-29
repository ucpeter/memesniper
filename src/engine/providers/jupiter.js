'use strict';
/**
 * Jupiter provider — used automatically once a token has MIGRATED off the
 * pump.fun bonding curve (or for any non-pump token you add manually).
 *
 * Same contract as every provider: fetch an unsigned swap, sign locally.
 * Endpoints are configurable because Jupiter periodically moves and rate-limits
 * their public tiers.
 */
const { VersionedTransaction } = require('@solana/web3.js');

const QUOTE_ENDPOINTS = [
  process.env.JUPITER_QUOTE_API || 'https://lite-api.jup.ag/swap/v1/quote',
  'https://quote-api.jup.ag/v6/quote',
];
const SWAP_ENDPOINTS = [
  process.env.JUPITER_SWAP_API || 'https://lite-api.jup.ag/swap/v1/swap',
  'https://quote-api.jup.ag/v6/swap',
];

const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

async function tryEndpoints(endpoints, path, init) {
  let lastErr;
  for (const base of endpoints) {
    try {
      const res = await fetch(base, init);
      if (!res.ok) throw new Error(`http_${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`jupiter_all_endpoints_failed:${lastErr?.message}`);
}

async function quote({ inputMint, outputMint, amount, slippageBps }) {
  const qs = new URLSearchParams({
    inputMint,
    outputMint,
    amount: String(amount),
    slippageBps: String(slippageBps),
    onlyDirectRoutes: 'false',
    maxAccounts: '64',
  });
  return tryEndpoints(QUOTE_ENDPOINTS, `/quote?${qs}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(6000),
  });
}

async function buildSwap({ publicKey, quoteResponse, priorityFeeMicroLamports }) {
  const j = await tryEndpoints(SWAP_ENDPOINTS, '/swap', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: publicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: priorityFeeMicroLamports
        ? { priorityLevelWithMaxLamports: { maxLamports: priorityFeeMicroLamports, global: false, priorityLevel: 'high' } }
        : undefined,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!j.swapTransaction) throw new Error('jupiter_no_swap_transaction');
  return VersionedTransaction.deserialize(Buffer.from(j.swapTransaction, 'base64'));
}

async function buy({ publicKey, mint, solLamports, slippageBps, priorityFeeMicroLamports }) {
  const q = await quote({ inputMint: WSOL, outputMint: mint, amount: solLamports, slippageBps });
  const tx = await buildSwap({ publicKey, quoteResponse: q, priorityFeeMicroLamports });
  return { tx, kind: 'versioned', expectedOut: q.outAmount, priceImpactPct: Number(q.priceImpactPct || 0) };
}

async function sell({ publicKey, mint, tokenAmountRaw, slippageBps, priorityFeeMicroLamports }) {
  const q = await quote({ inputMint: mint, outputMint: WSOL, amount: tokenAmountRaw, slippageBps });
  const tx = await buildSwap({ publicKey, quoteResponse: q, priorityFeeMicroLamports });
  return { tx, kind: 'versioned', expectedOut: q.outAmount, priceImpactPct: Number(q.priceImpactPct || 0) };
}

module.exports = { name: 'jupiter', buy, sell, quote, WSOL, USDC };
