'use strict';
/** Regression tests for the real Solana RPC failure reported from Render. */
const assert = require('node:assert/strict');
const { Connection, Keypair } = require('@solana/web3.js');
const rpc = require('../src/engine/rpc');
const safety = require('../src/engine/safety');
const cfg = require('../src/config');
const Executor = require('../src/engine/executor');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const MINT = Keypair.generate().publicKey.toBase58();

(async () => {
  console.log('\nRender RPC diagnostics, secret safety and live settings\n');
  await test('web3.js wraps account address; infra report shows REAL failover status, not the address prefix', async () => {
    const oldFetch = global.fetch;
    const secret = 'PRIVATE_PROVIDER_API_KEY_DO_NOT_LOG';
    global.fetch = async (url) => url.includes('primary')
      ? Response.json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'Rate limit' } })
      : new Response('', { status: 503 });
    const chain = [`https://primary.test/?api-key=${secret}`, 'https://fallback.test'];
    try {
      const conn = new Connection(chain[0], {
        commitment: 'processed', fetch: rpc.resilientRpcFetch(chain), disableRetryOnRateLimit: true,
      });
      safety._reportCache.clear();
      const w = cfg.normaliseWallet({ name: 'Test', filters: { minLiquidityUsd: 0 } });
      const verdict = await safety.evaluate({ mint: MINT }, w, { conn, config: cfg.defaultGlobalConfig() });
      assert.equal(verdict.infra, true, JSON.stringify(verdict.reasons));
      assert.equal(verdict.ok, false);
      const reasons = verdict.reasons.join(', ');
      assert.match(reasons, /endpoint 1: rate_limited/);
      assert.match(reasons, /endpoint 2: HTTP 503/);
      assert.doesNotMatch(reasons, /failed to get info about account/);
      assert.ok(!reasons.includes(secret), 'never echo private endpoint keys');
    } finally { global.fetch = oldFetch; }
  });
  await test('probe tests real getAccountInfo and returns safe code but no URL or provider body', async () => {
    const secret = 'MY_PRIVATE_QUERY_SECRET';
    const url = `https://private.test/?api-key=${secret}`;
    const called = [];
    const probe = await rpc.probeRpcEndpoints([url, 'https://second.test'], async (endpoint, init) => {
      called.push({ endpoint, body: JSON.parse(init.body) });
      if (endpoint === url) return Response.json({ error: { code: -32005, message: `bad key ${secret}` } });
      return Response.json({ jsonrpc: '2.0', result: { value: { executable: true } } });
    });
    assert.equal(called[0].body.method, 'getAccountInfo');
    assert.equal(probe.results[0].status, 'JSON-RPC -32005');
    assert.equal(probe.results[1].ok, true);
    assert.equal(probe.results[1].status, 'getAccountInfo OK');
    assert.ok(!JSON.stringify(probe).includes(secret));
    assert.ok(!JSON.stringify(probe).includes('private.test'));
  });
  await test('HTTP auth errors, timeouts and provider body stay safely classified', async () => {
    const url = 'https://rpc.test/privatekey';
    const unauthorized = await rpc.probeRpcEndpoints([url], async () => new Response('secret URL leaked', { status: 401 }));
    assert.deepEqual(unauthorized.results, [{ label: 'endpoint 1', ok: false, status: 'HTTP 401' }]);
    const timed = await rpc.probeRpcEndpoints([url], async () => { throw new DOMException('timed out', 'TimeoutError'); });
    assert.equal(timed.results[0].status, 'timeout');
  });
  await test('saving a new RPC rebuilds the active Connection without deleting traders', () => {
    const previousEnv = process.env.RPC_URL;
    delete process.env.RPC_URL;
    try {
      const global = cfg.defaultGlobalConfig();
      global.rpc.endpoints = ['https://old.test'];
      const executor = new Executor(global, {});
      const old = executor.conn();
      global.rpc.endpoints = ['https://new.test'];
      assert.equal(executor.configureRpc(), true);
      assert.notEqual(executor.conn(), old);
      assert.equal(executor.rpcChain[0], 'https://new.test');
      assert.equal(executor.configureRpc(), false, 'unchanged settings need no rebuild');
    } finally { if (previousEnv === undefined) delete process.env.RPC_URL; else process.env.RPC_URL = previousEnv; }
  });
  await test('startup override logs never disclose RPC API keys', () => {
    const oldUrl = process.env.RPC_URL, oldLog = console.log;
    const lines = [];
    process.env.RPC_URL = 'https://rpc.example/?api-key=PRIVATE_KEY_SHOULD_STAY_HIDDEN';
    console.log = (message) => lines.push(String(message));
    try {
      const globalCfg = cfg.defaultGlobalConfig();
      globalCfg.rpc.endpoints = ['https://old.example/?api-key=OLDER_PRIVATE_KEY'];
      cfg.applyEnvOverrides(globalCfg);
      assert.ok(!lines.join(' ').includes('PRIVATE_KEY_SHOULD_STAY_HIDDEN'));
      assert.ok(!lines.join(' ').includes('OLDER_PRIVATE_KEY'));
      assert.ok(globalCfg.rpc.endpoints[0].includes('PRIVATE_KEY_SHOULD_STAY_HIDDEN'));
    } finally {
      console.log = oldLog;
      if (oldUrl === undefined) delete process.env.RPC_URL; else process.env.RPC_URL = oldUrl;
    }
  });
  await test('Render fallback is tried before stale saved public endpoints', () => {
    const primary = process.env.RPC_URL, backup = process.env.RPC_URL_FALLBACK;
    process.env.RPC_URL = 'https://first.test';
    process.env.RPC_URL_FALLBACK = 'https://backup.test';
    try { assert.deepEqual(rpc.endpointChain(['https://api.mainnet-beta.solana.com']).slice(0, 3),
      ['https://first.test', 'https://backup.test', 'https://api.mainnet-beta.solana.com']); }
    finally {
      if (primary === undefined) delete process.env.RPC_URL; else process.env.RPC_URL = primary;
      if (backup === undefined) delete process.env.RPC_URL_FALLBACK; else process.env.RPC_URL_FALLBACK = backup;
    }
  });
  await test('Render RPC_URL wins over a configured dashboard endpoint', () => {
    const old = process.env.RPC_URL;
    process.env.RPC_URL = 'https://env-priority.test';
    try { assert.deepEqual(rpc.endpointChain(['https://settings.test']).slice(0, 2),
      ['https://env-priority.test', 'https://settings.test']); }
    finally { if (old === undefined) delete process.env.RPC_URL; else process.env.RPC_URL = old; }
  });
  console.log(`\n${passed} passed\n`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
