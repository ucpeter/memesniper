'use strict';
const assert = require('node:assert/strict');
const { Keypair } = require('@solana/web3.js');
const cfg = require('../src/config');
const safety = require('../src/engine/safety');
const solprice = require('../src/engine/solprice');
const rpc = require('../src/engine/rpc');
const Engine = require('../src/engine/engine');
const Trader = require('../src/engine/trader');
let passed = 0;
async function test(name, fn) {
  await fn(); passed++; console.log(`  ✓ ${name}`);
}
const mint = Keypair.generate().publicKey.toBase58();
const mintData = Buffer.alloc(82); mintData[45] = 1;
const curveData = Buffer.alloc(80);
curveData.writeBigUInt64LE(1_000_000_000_000_000n, 8);
curveData.writeBigUInt64LE(30_000_000_000n, 16);
curveData.writeBigUInt64LE(500_000_000_000_000n, 24);
curveData.writeBigUInt64LE(2_500_000_000n, 32);
curveData.writeBigUInt64LE(1_000_000_000_000_000n, 40);
const conn = {
  getAccountInfo: async (_, __) => {
    conn.calls++;
    return { data: conn.calls % 2 ? mintData : curveData,
      owner: conn.calls % 2 ? safety.TOKEN_PROGRAM : safety.PUMP_PROGRAM, lamports: 1 };
  },
  calls: 0,
  getTokenLargestAccounts: async () => ({ value: [] }),
};
async function check(filters) {
  safety._reportCache.clear(); conn.calls = 0;
  const w = cfg.normaliseWallet({ name: 'USD', filters });
  return safety.evaluate({ mint, symbol: 'USD', detectedAt: Date.now() }, w,
    { conn, config: cfg.defaultGlobalConfig() });
}
(async () => {
  console.log('\nUSD liquidity migration and RPC failover\n');
  await test('new wallets use fixed dollar liquidity, not relabeled SOL', () => {
    const w = cfg.defaultWalletConfig('Default');
    assert.equal(w.filters.minLiquidityUsd, 150);
    assert.equal(cfg.applyPreset(cfg.defaultWalletConfig('Safe'), 'safe').filters.minLiquidityUsd, 300);
  });
  await test('old SOL-only records retain SOL semantics through normalisation', () => {
    const w = cfg.normaliseWallet({ name: 'Old', filters: { minLiquiditySol: 3, maxLiquiditySol: 5 } });
    assert.equal(w.filters.minLiquidityUsd, undefined);
    assert.equal(w.filters.minLiquiditySol, 3);
    assert.equal(w.filters.maxLiquidityUsd, undefined);
    assert.equal(w.filters.maxLiquiditySol, 5);
  });
  solprice.__setPrice(200, 'test');
  try {
    await test('$600 floor rejects 2.5 SOL at $200 ($500), but $450 floor does not', async () => {
      const low = await check({ minLiquiditySol: 0, minLiquidityUsd: 600, maxLiquidityUsd: 0 });
      assert.ok(low.reasons.some((r) => /liquidity_below_min_usd\(\$500<\$600\)/.test(r)), low.reasons.join(', '));
      const okay = await check({ minLiquiditySol: 500, minLiquidityUsd: 450, maxLiquidityUsd: 0 });
      assert.ok(!okay.reasons.some((r) => /liquidity_below_min/.test(r)), okay.reasons.join(', '));
    });
    await test('USD max is also enforced in USD', async () => {
      const v = await check({ minLiquiditySol: 0, minLiquidityUsd: 0, maxLiquidityUsd: 400 });
      assert.ok(v.reasons.some((r) => /liquidity_above_max_usd\(\$500>\$400\)/.test(r)), v.reasons.join(', '));
    });
    await test('legacy SOL floor remains SOL, even when SOL/USD changes', async () => {
      const v = await check({ minLiquiditySol: 3, maxLiquiditySol: 0 });
      assert.ok(v.reasons.some((r) => /liquidity_below_min\(2.50\)/.test(r)), v.reasons.join(', '));
      assert.ok(!v.reasons.some((r) => r.includes('_usd')), v.reasons.join(', '));
    });
  } finally { solprice.__reset(); }
  await test('JSON-RPC 200 rate limit retries same request on configured fallback', async () => {
    const old = global.fetch; const calls = [];
    global.fetch = async (url) => {
      calls.push(url);
      return Response.json(url === 'https://first' ? { error: { code: -32005, message: 'rate limited' } } : { result: 42 });
    };
    try {
      const result = await rpc.resilientRpcFetch(['https://first', 'https://backup'])('ignored', { method: 'POST' });
      assert.equal((await result.json()).result, 42);
      assert.deepEqual(calls, ['https://first', 'https://backup']);
    } finally { global.fetch = old; }
  });
  await test('non-retryable RPC errors stay errors; all bad providers fail closed', async () => {
    const old = global.fetch; const calls = [];
    try {
      global.fetch = async (url) => { calls.push(url); return Response.json({ error: { code: -32602, message: 'bad parameters' } }); };
      const res = await rpc.resilientRpcFetch(['https://first','https://backup'])('ignored', {});
      assert.deepEqual(calls, ['https://first']);
      assert.equal((await res.json()).error.code, -32602);
      global.fetch = async () => Response.json({ error: { code: 429, message: 'too many requests' } });
      await assert.rejects(rpc.resilientRpcFetch(['https://first','https://backup'])('ignored', {}), /rate_limited/);
    } finally { global.fetch = old; }
  });
  await test('wallet rejects event-below-USD-floor without RPC, but eligible event fails closed on RPC outage', async () => {
    const globalCfg = cfg.defaultGlobalConfig();
    const wallet = cfg.normaliseWallet({ name: 'Gate', id: 'gate', enabled: true,
      filters: { minLiquidityUsd: 600, maxLiquidityUsd: 0 } });
    let reads = 0;
    const trader = new Trader({ cfg: wallet, getConfig: () => globalCfg,
      executor: { dryRun: true, conn: () => ({ getAccountInfo: async () => {
        reads++; throw new Error('429 Too Many Requests');
      } }) }, keystore: {} });
    const ctx = { engine: { traders: new Map([['gate', trader]]), stats: {} } };
    solprice.__setPrice(200, 'test');
    try {
      const weak = await trader.consider({ mint, initialBuy: 0, vSolInBondingCurve: 2.5 }, ctx);
      assert.match(weak, /liquidity_below_min_usd/);
      assert.equal(reads, 0, 'no redundant RPC for an event already below the floor');
      safety._reportCache.clear();
      const eligible = await trader.consider({ mint, initialBuy: 0, vSolInBondingCurve: 10 }, ctx);
      assert.match(eligible, /rpc_unavailable|infra|error/, eligible);
      assert.ok(reads > 0, 'eligible launch still requires authoritative RPC reads');
    } finally { solprice.__reset(); }
  });
  await test('no recon RPC on fully populated launch; missing facts still request recon', async () => {
    const engine = Object.create(Engine.prototype);
    engine.running = false;
    engine.liveFeed = { note: () => {} };
    engine._recon = () => { engine.calls = (engine.calls || 0) + 1; };
    engine._onToken({ mint, initialBuy: 0, vSolInBondingCurve: 0 });
    assert.equal(engine.calls || 0, 0);
    engine._onToken({ mint, initialBuy: null, vSolInBondingCurve: 0 });
    assert.equal(engine.calls, 1);
  });
  console.log(`\n${passed} passed\n`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
