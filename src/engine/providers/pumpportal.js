'use strict';
/**
 * PumpPortal provider — the DEFAULT route for bonding-curve trades.
 *
 * How it works, and why it is the safer default:
 *   1. We POST trade intent (mint, size, slippage) to PumpPortal.
 *   2. They return a SERIALIZED (unsigned) transaction.
 *   3. We deserialize, sign LOCALLY with the wallet's keypair, and broadcast.
 *
 * Your private key never leaves this machine — the remote service builds an
 * unsigned transaction and has no ability to sign it. This is the opposite of
 * the "Alternative Connection / requires wallet update" pattern you found on
 * the scam site, where a remote party obtains signatures.
 *
 * Docs: https://pumpportal.fun/ — endpoints are configurable below because
 * third-party APIs move. Verify before you go live.
 */
const { VersionedTransaction, Transaction, Connection } = require('@solana/web3.js');

const API_BASE = process.env.PUMPPORTAL_API || 'https://pumpportal.fun/api';

async function buildTrade({ publicKey, action, mint, amount, denominatedInSol, slippageBps, priorityFeeSol, pool }) {
  const body = {
    publicKey,
    action, // 'buy' | 'sell'
    mint,
    amount: String(amount),
    denominatedInSol: String(denominatedInSol), // 'true' = amount is SOL, 'false' = token units
    slippage: Number((slippageBps / 100).toFixed(2)), // API takes percent
    priorityFee: Number(priorityFeeSol ?? 0.0005),
    pool: pool || 'pump',
  };

  const res = await fetch(`${API_BASE}/trade-local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`pumpportal_http_${res.status}${text ? `:${text.slice(0, 140)}` : ''}`);
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) throw new Error('pumpportal_empty_transaction');

  // The API returns a serialized VersionedTransaction.
  return VersionedTransaction.deserialize(bytes);
}

async function buy({ publicKey, mint, solAmount, slippageBps, priorityFeeSol }) {
  const tx = await buildTrade({
    publicKey,
    action: 'buy',
    mint,
    amount: solAmount,
    denominatedInSol: 'true',
    slippageBps,
    priorityFeeSol,
  });
  return { tx, kind: 'versioned' };
}

async function sell({ publicKey, mint, tokenAmount, slippageBps, priorityFeeSol, walletCode }) {
  const tx = await buildTrade({
    publicKey,
    action: 'sell',
    mint,
    amount: tokenAmount,
    denominatedInSol: 'false',
    slippageBps,
    priorityFeeSol,
    pool: 'auto', // let the service route curve vs. migrated pool
  });
  return { tx, kind: 'versioned' };
}

module.exports = { name: 'pumpportal', buy, sell, buildTrade };
