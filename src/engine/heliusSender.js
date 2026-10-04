'use strict';
/** Helius Sender Max (transaction submission ONLY, never an account-read RPC).
 * Tip destinations and minimum are taken from Helius's official Sender docs:
 * https://www.helius.dev/docs/sending-transactions/sender
 * Review that list when updating provider integration. Never accept arbitrary tip
 * destinations from a dashboard, a transaction builder or an environment variable.
 */
const bs58 = require('bs58');
const { PublicKey } = require('@solana/web3.js');
const URL = 'https://sender.helius-rpc.com/fast';
const TIP_LAMPORTS = 1_000_000; // Sender Max: 0.001 SOL per landed transaction.
const TIP_ACCOUNTS = Object.freeze([
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
]);
function tipAccount() {
  return new PublicKey(TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)]);
}
function localSignature(tx) {
  const first = tx.signatures[0];
  const bytes = first && (first.signature || first);
  if (!bytes || bytes.length !== 64 || !Buffer.from(bytes).some((v) => v !== 0)) {
    throw new Error('helius_sender_unsigned_transaction');
  }
  return bs58.encode(Buffer.from(bytes));
}
async function send(signedTx, fetchImpl = (...args) => fetch(...args)) {
  const expected = localSignature(signedTx);
  let response;
  try {
    response = await fetchImpl(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now().toString(), method: 'sendTransaction',
        params: [Buffer.from(signedTx.serialize()).toString('base64'),
          { encoding: 'base64', skipPreflight: true, maxRetries: 0 }] }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new Error('helius_sender_timeout');
    throw new Error('helius_sender_network_failure'); // provider URLs/body may contain secrets
  }
  if (!response.ok) throw new Error(`helius_sender_http_${response.status}`);
  let body;
  try { body = await response.json(); } catch { throw new Error('helius_sender_invalid_response'); }
  if (body?.error) {
    const code = Number(body.error.code);
    throw new Error(Number.isSafeInteger(code) ? `helius_sender_rpc_${code}` : 'helius_sender_rpc_error');
  }
  if (body?.result !== expected) throw new Error('helius_sender_signature_mismatch');
  return expected; // accepted for submission, NOT confirmed on-chain
}
module.exports = { URL, TIP_LAMPORTS, TIP_ACCOUNTS, tipAccount, localSignature, send };
