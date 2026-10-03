'use strict';
/**
 * API test — boots the REAL server against a real Engine and calls the routes
 * over HTTP.
 *
 * Why this suite exists
 * --------------------
 * Round 8 shipped three user-visible bugs that every existing suite was blind to,
 * because each one lived in the seam between two correct pieces:
 *
 *   1. `LiveFeed` was complete, tested, and never constructed. `/api/scan` read
 *      `engine.liveFeed`, which was undefined, so the launch scanner panel stayed
 *      empty while the "tokens scanned" counter climbed. A unit test on the class
 *      cannot see that; a test on the ROUTE can.
 *   2. `POST /api/wallets/:id/start` called `trader.resume()`, which clears
 *      `stats.paused` — but the entry gate reads `cfg.enabled`, which is false on
 *      every wallet you create. Start therefore did nothing a second time, and no
 *      dry-run (paper) trade could ever open.
 *   3. `POST /api/wallets` created a wallet and the dashboard offered "⏸ Stop"
 *      immediately, because the card keyed off `paused` rather than an armed
 *      state. Creating a wallet must not look like starting one.
 *
 * Run: node test/api.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* Configure the process BEFORE anything reads it:
 *  · SESSION_TOKEN is read at require-time by src/server.js, so the test knows it.
 *  · DATA_DIR is read at require-time by src/config.js, so the real data/ folder
 *    is never touched by a test run. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'meme-sniper-api-'));
process.env.DATA_DIR = TMP;
process.env.SESSION_TOKEN = 'test-session-token';
process.env.DRY_RUN = 'true';

const { Keypair, Transaction, SystemProgram, PublicKey } = require('@solana/web3.js');
const bs58 = require('bs58');
const cfg = require('../src/config');
const keystore = require('../src/wallets/keystore');
const Engine = require('../src/engine/engine');
const bus = require('../src/util/events');
const { createServer } = require('../src/server');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  }
}

/* ───────────────────────────── the harness ───────────────────────────── */

// A keystore stand-in. The routes only ever ask it three questions here.
const REAL_KEYSTORE = {
  isUnlocked: keystore.isUnlocked,
  generateKey: keystore.generateKey,
  getKeypair: keystore.getKeypair,
  has: keystore.has,
};
keystore.isUnlocked = () => true;
keystore.generateKey = (id) => `TESTPUBKEY${id}`.padEnd(44, 'x').slice(0, 44);
keystore.has = () => true;
keystore.getKeypair = (id) => ({ publicKey: { toBase58: () => `TESTPUBKEY${id}`.padEnd(44, 'x').slice(0, 44) } });

const globalCfg = cfg.defaultGlobalConfig();
const config = { global: globalCfg, wallets: [] };
let saves = 0;
const engine = new Engine({ config, keystore });
let startCalls = 0;
engine.start = () => { startCalls += 1; engine.running = true; }; // no scanner, no network

const { server } = createServer(engine, {
  getGlobal: () => config.global,
  getFull: () => config,
  save: () => { saves += 1; },
});

let PORT = 0;
const DEST = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OTHER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const get = (url) => api('GET', url);
const post = (url, body) => api('POST', url, body);
const api = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-session-token': process.env.SESSION_TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not json */ }
  return { status: res.status, body: json };
};

(async () => {
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  PORT = server.address().port;
  console.log(`\n── HTTP routes against a real Engine (port ${PORT}) ──────`);

  /* ── the launch feed ─────────────────────────────────────────────────── */

  await test('the engine OWNS a live feed, attached to the bus the scanner publishes on', () => {
    assert.ok(engine.liveFeed, 'engine.liveFeed must exist — this is the round-8 bug');
    assert.strictEqual(typeof engine.liveFeed.snapshot, 'function');
    assert.strictEqual(engine.liveFeed.size, 0, 'starts empty');
  });

  await test('every detected launch becomes exactly one row, and a duplicate does not', () => {
    const launch = {
      mint: 'MintRound8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      symbol: 'R8', name: 'Round 8', creator: 'Dev1111111111111111111111111111111111111111',
      liquiditySol: 12.5, detectedAt: Date.now(), source: 'pumpportal',
    };
    bus.safeEmit('token:detected', launch);
    bus.safeEmit('token:detected', { ...launch }); // same mint again
    assert.strictEqual(engine.liveFeed.size, 1, 'one mint = one row');
    assert.strictEqual(engine.liveFeed.stats.seen, 1, 'and one "seen"');
  });

  await test('the ENGINE\'s own feed scores risk with the configured thresholds', () => {
    // It was built as `new LiveFeed()` — no thresholds — so every row scored 0
    // against an empty config and the RISK column meant nothing at all. The unit
    // tests passed because they built a feed correctly; the engine did not.
    const g = engine.liveFeed.globalConfig();
    assert.ok(g && g.risk, 'the feed must be handed the live config, not an empty object');
    assert.strictEqual(g.risk.minLiquidityUsd, globalCfg.risk.minLiquidityUsd, 'including the liquidity floor');

    const thin = {
      mint: 'MintThinAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      symbol: 'THIN', name: 'Thin', creator: 'Dev1111111111111111111111111111111111111111',
      // A dev holding 40% and a curve with almost nothing in it: both penalties.
      initialBuy: 400_000_000, vSolInBondingCurve: 0.5, vTokensInBondingCurve: 600_000_000,
      detectedAt: Date.now(), source: 'pumpportal',
    };
    bus.safeEmit('token:detected', thin);
    const row = engine.liveFeed.rows.get(thin.mint);
    assert.ok(row, 'the launch must become a row');
    assert.ok(row.riskScore > 50, `a 40%-dev, $60-liquidity launch must score dangerous, not ${row.riskScore}`);
    assert.ok(row.riskNotes.some((n) => /liquidity \$/.test(n)), 'and say which floor it fell through');
    assert.ok(row.riskNotes.some((n) => /dev holds/.test(n)), 'and that the dev is over the ceiling');
  });

  await test('status().scan reports what the panel is showing', () => {
    const st = engine.status();
    assert.ok(st.scan, 'status must carry the feed tally, or the UI cannot reconcile the counters');
    assert.strictEqual(st.scan.rows, 2, 'two launches have been seen by now');
    assert.strictEqual(typeof st.scan.seen, 'number');
  });

  await test('GET /api/scan serves the rows instead of an empty list', async () => {
    const r = await api('GET', '/api/scan?limit=10');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.rows.length, 2, 'the panel reads exactly this');
    assert.strictEqual(r.body.rows.find((x) => x.symbol === 'R8').symbol, 'R8');
    assert.strictEqual(r.body.rows.every((x) => x.decision === 'checking'), true, 'a fresh launch is still being evaluated');
    assert.ok(r.body.stats, 'stats must not be null — that is what made the panel look broken');
    assert.strictEqual(r.body.scanner.source, globalCfg.scanner.source);
  });

  await test('a wallet verdict patches the SAME row (no second row per wallet)', () => {
    const mint = 'MintRound8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    bus.safeEmit('token:analyzed', {
      candidate: { mint }, wallet: 'Alpha', ok: true,
      report: { liquiditySol: 12.5, devHoldPct: 3.1, honeypot: { risk: 0, notes: [] } },
    });
    bus.safeEmit('scan:final', { mint, outcomes: ['skip:liquidity_below_min(12.5)'], walletNames: ['Alpha'] });
    const rows = engine.liveFeed.snapshot(10);
    assert.strictEqual(rows.filter((r) => r.mint === mint).length, 1, 'still one row for that mint');
    const row = rows.find((r) => r.mint === mint);
    assert.strictEqual(row.liquiditySol, 12.5, 'the checks filled it in');
    assert.strictEqual(row.decision, 'skipped');
    assert.match(row.skipReason, /liquidity/, 'and say WHY, in words');
  });

  /* ── creating a wallet ───────────────────────────────────────────────── */

  let createdId = null;
  await test('POST /api/wallets creates a wallet that is NOT armed', async () => {
    const r = await api('POST', '/api/wallets', { name: 'Fresh', preset: 'balanced' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    createdId = r.body.wallet;
    const stored = config.wallets.find((w) => w.id === createdId);
    assert.ok(stored, 'it is in the config');
    assert.strictEqual(stored.enabled, false, 'creating a wallet is not a decision to trade');
    const trader = engine.traders.get(createdId);
    assert.ok(trader, 'and it is live in the engine');
    assert.strictEqual(trader.toJSON().armed, false, 'the card shows ▶ Start, not ⏸ Stop');
  });

  await test('an un-armed wallet refuses entries with a reason, rather than trading', async () => {
    const trader = engine.traders.get(createdId);
    const outcome = await trader.consider(
      { mint: 'MintDisarmedAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', symbol: 'NO', detectedAt: Date.now() },
      { engine }
    );
    assert.strictEqual(outcome, 'skip:wallet_disabled');
  });

  /* ── starting and stopping a wallet ──────────────────────────────────── */

  await test('POST /api/wallets/:id/start ARMS the wallet (enabled + unpaused)', async () => {
    const before = startCalls;
    const r = await api('POST', `/api/wallets/${createdId}/start`, {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.enabled, true, 'enabled is what the entry gate reads');
    assert.strictEqual(r.body.paused, false);
    assert.strictEqual(r.body.armed, true);
    assert.strictEqual(r.body.dryRun, true, 'and it says which mode it armed into');
    assert.strictEqual(engine.traders.get(createdId).cfg.enabled, true, 'the live trader is armed');
    assert.strictEqual(config.wallets.find((w) => w.id === createdId).enabled, true, 'and it is persisted');
    assert.strictEqual(startCalls, before + 1, 'starting a wallet starts the engine too');
    assert.ok(saves > 0, 'the arming is written to disk');
  });

  await test('an armed dry-run wallet actually TAKES a (paper) trade', async () => {
    const trader = engine.traders.get(createdId);
    const outcome = await trader.consider(
      {
        mint: 'MintPaperFillAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        symbol: 'PAPER', name: 'Paper', detectedAt: Date.now(),
      },
      { engine }
    );
    // The stubbed safety/curve layer in the real modules cannot reach the chain
    // here, so any outcome EXCEPT wallet_disabled proves the gate opened. That is
    // the precise thing that was broken.
    assert.notStrictEqual(outcome, 'skip:wallet_disabled', `expected the gate to be open, got ${outcome}`);
  });

  await test('POST /api/wallets/:id/stop DISARMS the wallet', async () => {
    const r = await api('POST', `/api/wallets/${createdId}/stop`, {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.enabled, false);
    assert.strictEqual(r.body.paused, true);
    assert.strictEqual(engine.traders.get(createdId).cfg.enabled, false);
    assert.strictEqual(config.wallets.find((w) => w.id === createdId).enabled, false, 'persisted too');
    assert.match(r.body.note, /open positions are still managed/i, 'the promise is still made');
  });

  await test('a stopped wallet is still allowed to MANAGE what it holds', () => {
    // Entries are gated on cfg.enabled; exits must never be. The guard in
    // Trader.manage() returned early for a stopped wallet, which would have left
    // an open position without a stop loss — the opposite of what Stop promises.
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'engine', 'trader.js'), 'utf8');
    const i = src.indexOf('async manage(ctx)');
    assert.ok(i > -1, 'manage() not found');
    const head = src.slice(i, i + 700);
    assert.ok(!/if \(!this\.cfg\.enabled\) return;/.test(head), 'manage() must not early-return on a stopped wallet');
  });

  /* ── the mode switch ─────────────────────────────────────────────────── */

  await test('POST /api/engine/dry-run refuses to arm LIVE without the typed confirmation', async () => {
    const r = await api('POST', '/api/engine/dry-run', { dryRun: false });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.body.error, 'live_confirmation_required');
    assert.strictEqual(config.global.dryRun, true, 'and it must NOT have changed anything');
  });

  await test('POST /api/engine/dry-run arms and disarms with the confirmation', async () => {
    let r = await api('POST', '/api/engine/dry-run', { dryRun: false, confirm: 'I_UNDERSTAND_THE_RISK' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dryRun, false, 'live');
    r = await api('POST', '/api/engine/dry-run', { dryRun: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.dryRun, true, 'and back to dry run needs no phrase — stopping risk is free');
  });

  await test('the WebSocket snapshot carries the launch feed', async () => {
    // The client used to ignore this field, which is half the reason the panel
    // stayed empty on a live page while a reload would have filled it.
    const { WebSocket } = require('ws');
    const snapshot = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const timer = setTimeout(() => { ws.terminate(); reject(new Error('no snapshot')); }, 4000);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'snapshot') return;
        clearTimeout(timer);
        ws.close();
        resolve(msg.data);
      });
      ws.on('error', reject);
    });
    assert.ok(Array.isArray(snapshot.scanFeed), 'scanFeed must be an array');
    assert.ok(snapshot.scanFeed.length >= 1, 'and carry the rows already scanned');
    assert.ok(snapshot.scan, 'with the feed tally beside it');
  });

  /* ──────────────── the browser-held wallet, through the API ─────────── */

  console.log('\nThe wallet the browser holds — register, arm, lock\n');

  /* The stubbed keystore above answers "yes" to everything — `has()` is true for
   * wallets that have no key at all. That is precisely what this model does NOT
   * do, so these tests run against the real module's answers: a wallet exists
   * server-side with no key, and one arrives only when it is armed. */
  const STUBBED_KEYSTORE = { has: keystore.has, getKeypair: keystore.getKeypair, isUnlocked: keystore.isUnlocked };
  keystore.has = REAL_KEYSTORE.has;
  keystore.getKeypair = REAL_KEYSTORE.getKeypair;
  keystore.isUnlocked = REAL_KEYSTORE.isUnlocked;

  await test('a wallet generated in the BROWSER is registered without any server keystore', async () => {
    // This is the fix for "the wallet just abruptly deleted itself": the key is
    // made in the browser, only the address is registered here, and nothing about
    // it depends on the server's disk surviving.
    const paired = Keypair.generate();
    const address = paired.publicKey.toBase58();
    const res = await post('/api/wallets', { name: 'Browser Alpha', address });
    assert.strictEqual(res.status, 201, `expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.publicKey, address, 'the address is what comes back');
    assert.strictEqual(res.body.keyHolder, 'browser', 'and it is recorded as browser-held');

    const list = await get('/api/wallets');
    const found = list.body.find((w) => w.publicKey === address);
    assert.ok(found, 'the wallet is listed');
    assert.strictEqual(found.keyArmed, false, 'but NOT armed — no key has been handed over');
    assert.strictEqual(found.enabled, false, 'and it is not trading');
  });

  await test('WS snapshot AND heartbeat keep a registered, locked browser wallet visible', async () => {
    // The actual reported failure: GET returned the wallet, but the next 2s
    // heartbeat replaced that list with traders ONLY (zero while the key is
    // sealed here). Two wallets then fell back to "Register again" forever.
    const WebSocket = require('ws');
    const address = Keypair.generate().publicKey.toBase58();
    const result = await post('/api/wallets', { name: 'Visible after tick', address });
    assert.strictEqual(result.status, 201);
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    try {
      const [snapshot, tick] = await new Promise((resolve, reject) => {
        const messages = [];
        const timer = setTimeout(() => reject(new Error('heartbeat missing')), 5000);
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'snapshot' || msg.type === 'tick') messages.push(msg);
          if (messages.length === 2) { clearTimeout(timer); resolve(messages); }
        });
        ws.on('error', (err) => { clearTimeout(timer); reject(err); });
      });
      for (const message of [snapshot, tick]) {
        const w = message.data.wallets.find((x) => x.publicKey === address);
        assert.ok(w, `${message.type} must include a wallet with a sealed browser key`);
        assert.strictEqual(w.name, 'Visible after tick');
        assert.strictEqual(w.keyLocked, true);
        assert.strictEqual(w.persistent, false);
      }
    } finally { ws.close(); }
  });

  await test('the home launch endpoint has NO wallet fields and uses fixed public risk rules', async () => {
    const mint = Keypair.generate().publicKey.toBase58();
    engine.liveFeed.note({ mint, symbol: 'HOME', creator: 'DevAddress',
      initialBuy: 300000000, vSolInBondingCurve: 1.2 });
    const before = engine.running;
    const savedRisk = config.global.risk;
    config.global.risk = { maxDevHoldPct: 99, minLiquidityUsd: 0 }; // a wallet/global setting
    const response = await fetch(`http://127.0.0.1:${PORT}/api/launches`); // NO session token
    assert.strictEqual(response.status, 200, 'public launch stream does not need a wallet session');
    const got = { status: response.status, body: await response.json() };
    config.global.risk = savedRisk;
    assert.strictEqual(got.status, 200);
    const row = got.body.rows.find((r) => r.mint === mint);
    assert.ok(row, 'the public stream shows a token even with no wallet trading');
    assert.strictEqual(row.devHoldPct, 30);
    assert.ok(row.liquidityUsd !== null);
    assert.ok(row.riskScore > 0, 'informational risk ignores wallet/global trading thresholds');
    assert.strictEqual(engine.running, before, 'reading the launch does NOT start trading');
    for (const name of ['wallets', 'boughtBy', 'walletId', 'skipReason', 'config', 'secretKey']) {
      assert.ok(!(name in row), `public feed must not expose ${name}`);
    }
  });

  await test('re-registering the same address returns the SAME wallet, not a duplicate', async () => {
    const paired = Keypair.generate();
    const address = paired.publicKey.toBase58();
    const first = await post('/api/wallets', { name: 'Twice', address });
    const again = await post('/api/wallets', { name: 'Twice', address });
    assert.strictEqual(again.status, 200, 'the second call is not a create');
    assert.strictEqual(again.body.wallet, first.body.wallet, 'same wallet id — the card comes back as itself');
    const list = await get('/api/wallets');
    assert.strictEqual(list.body.filter((w) => w.publicKey === address).length, 1, 'one card for one address');
  });

  await test('a key that belongs to a DIFFERENT address is refused, not armed', async () => {
    const paired = Keypair.generate();
    const other = Keypair.generate();
    const created = await post('/api/wallets', { name: 'Mismatch', address: paired.publicKey.toBase58() });
    const b58 = (bs58.default ? bs58.default : bs58).encode(other.secretKey);
    const res = await post(`/api/wallets/${created.body.wallet}/arm`, { secretKey: b58 });
    assert.strictEqual(res.status, 400, 'a key that does not match the address must not arm the wallet');
    assert.strictEqual(res.body.error, 'cannot_arm', `got ${JSON.stringify(res.body)}`);
    const list = await get('/api/wallets');
    const w = list.body.find((x) => x.id === created.body.wallet);
    assert.strictEqual(w.keyArmed, false, 'and the wallet is still not armed');
  });

  await test('arming a wallet loads its key for the session, and the key is never written to disk', async () => {
    const paired = Keypair.generate();
    const address = paired.publicKey.toBase58();
    const created = await post('/api/wallets', { name: 'Armed', address });
    const id = created.body.wallet;
    const b58 = (bs58.default ? bs58.default : bs58).encode(paired.secretKey);

    const armRes = await post(`/api/wallets/${id}/arm`, { secretKey: b58 });
    assert.strictEqual(armRes.status, 200, `arm failed: ${JSON.stringify(armRes.body)}`);
    assert.strictEqual(armRes.body.armed, true);
    assert.strictEqual(armRes.body.keyArmed, true, 'and it says so with the same word the list uses');

    const list = await get('/api/wallets');
    const w = list.body.find((x) => x.id === id);
    assert.ok(w, 'the wallet is now a live trader, not a locked record');
    assert.strictEqual(w.keyArmed, true, 'and the API says it is armed');

    // The whole point: the key is in MEMORY. Nothing anywhere under DATA_DIR may
    // contain it — not the config, not any keystore file.
    const files = fs.readdirSync(TMP);
    for (const f of files) {
      const body = fs.readFileSync(path.join(TMP, f), 'utf8');
      assert.ok(!body.includes(b58), `${f} contains the private key — it must never be written to disk`);
    }
  });

  await test('locking a wallet drops its key and stops it trading', async () => {
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'ToLock', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;
    await post(`/api/wallets/${id}/arm`, { secretKey: (bs58.default ? bs58.default : bs58).encode(paired.secretKey) });
    await post(`/api/wallets/${id}/start`, {});

    const active = await post(`/api/wallets/${id}/lock`, {});
    assert.strictEqual(active.status, 409, 'cannot discard a running trader');
    assert.strictEqual(engine.traders.get(id).cfg.enabled, true);
    await post(`/api/wallets/${id}/stop`, {});
    const trader = engine.traders.get(id);
    const realOpenPositions = trader.openPositions;
    trader.openPositions = () => [{ mint: 'unsold' }];
    try {
      for (const url of [`/api/wallets/${id}/lock`, `/api/wallets/${id}/unpersist`,
        `/api/wallets/${id}`]) {
        const result = await api(url === `/api/wallets/${id}` ? 'DELETE' : 'POST', url, {});
        assert.strictEqual(result.status, 409, `${url} must not abandon an open position`);
      }
      const ksLock = await post('/api/keystore/lock', {});
      assert.strictEqual(ksLock.status, 409, 'closing the keystore must not abandon exits');
      const reset = await post('/api/keystore/reset', { confirm: 'RESET', passphrase: 'passphrase9' });
      assert.strictEqual(reset.status, 409);
    } finally { trader.openPositions = realOpenPositions; }
    const locked = await post(`/api/wallets/${id}/lock`, {});
    assert.strictEqual(locked.status, 200);
    assert.strictEqual(locked.body.armed, false);
    assert.strictEqual(locked.body.keyArmed, false, 'no key is held any more');

    const list = await get('/api/wallets');
    const w = list.body.find((x) => x.id === id);
    assert.strictEqual(w.keyLocked, true, 'the wallet is back to a locked card');
    assert.notStrictEqual(w.keyMissing, true, 'and it is NOT reported as gone — its key is simply not loaded here');

    const start = await post(`/api/wallets/${id}/start`, {});
    assert.strictEqual(start.status, 400, 'starting a locked wallet is refused');
    assert.strictEqual(start.body.error, 'wallet_not_armed', `got ${JSON.stringify(start.body)}`);
    assert.match(String(start.body.hint || ''), /unlock/i, 'with a hint in the user\'s words');
  });

  /* ───────────── a withdrawal signed in the browser, over HTTP ──────────── */

  console.log('\nThe two-step withdrawal — sign in the tab, broadcast here\n');

  await test('the intent step needs NO key: it builds the transfer from the address alone', async () => {
    // This is what makes a withdrawal possible while the wallet is LOCKED — the
    // property the reference bot has, because the key is in the tab, not on the
    // server. Reading a balance and building a transfer need only the public
    // address, and `keystore.has` is stubbed to answer "no" for everything here.
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'Withdrawable', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;

    const realConn = engine.executor.conn;
    engine.executor.conn = () => ({
      getBalance: async () => 2_000_000_000,
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999 }),
    });
    try {
      const res = await post(`/api/wallets/${id}/withdraw/intent`, { destination: DEST, amountSol: 1.5 });
      assert.strictEqual(res.status, 200, `intent failed: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.txBase64, 'the unsigned transfer comes back as bytes');
      assert.strictEqual(res.body.lamports, '1500000000', 'for exactly the amount asked');
      assert.strictEqual(res.body.from, paired.publicKey.toBase58(), 'from this wallet');

      const tx = Transaction.from(Buffer.from(res.body.txBase64, 'base64'));
      assert.strictEqual(tx.instructions.length, 1, 'one instruction: the transfer');
      assert.strictEqual(tx.feePayer.toBase58(), paired.publicKey.toBase58(), 'paid by the wallet being withdrawn from');
      const sigs = tx.signatures.map((sig) => Uint8Array.from(sig));
      assert.ok(sigs.length >= 1, 'the transfer has a signature slot waiting');
      assert.ok(sigs.every((sig) => sig.every((b) => b === 0)), 'and it is UNSIGNED — the key never leaves the browser');
    } finally {
      engine.executor.conn = realConn;
    }
  });

  await test('the submit step refuses signed bytes that do not match the intent', async () => {
    // The intent is the promise about what will be broadcast. A page can sign
    // anything; the server checks the bytes against the intent, not against
    // whatever the request body claims now.
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'Mismatch2', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;

    const realConn = engine.executor.conn;
    const broadcast = [];
    engine.executor.conn = () => ({
      getBalance: async () => 2_000_000_000,
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999 }),
      sendRawTransaction: async (raw) => { broadcast.push(raw); return 'S'.repeat(64) + '111'; },
      getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    });
    try {
      const intent = await post(`/api/wallets/${id}/withdraw/intent`, { destination: DEST, amountSol: 1 });
      const unsigned = Transaction.from(Buffer.from(intent.body.txBase64, 'base64'));

      // Sign a DIFFERENT transfer than the one that was asked for.
      const wrong = new Transaction().add(SystemProgram.transfer({
        fromPubkey: paired.publicKey,
        toPubkey: new PublicKey(OTHER),
        lamports: 1_000_000_000,
      }));
      wrong.feePayer = paired.publicKey;
      wrong.recentBlockhash = '11111111111111111111111111111111';
      wrong.sign(paired);

      const bad = await post(`/api/wallets/${id}/withdraw/submit`, {
        intentId: intent.body.intentId,
        txBase64: Buffer.from(wrong.serialize()).toString('base64'),
      });
      assert.strictEqual(bad.status, 400, `a mismatched transfer must be refused: ${JSON.stringify(bad.body)}`);
      assert.match(String(bad.body.error), /refused|mismatch/);
      assert.strictEqual(broadcast.length, 0, 'and nothing may reach the chain');
      void unsigned;

      // Now the real one: sign exactly what the intent describes.
      unsigned.sign(paired);
      const good = await post(`/api/wallets/${id}/withdraw/submit`, {
        intentId: intent.body.intentId,
        txBase64: Buffer.from(unsigned.serialize()).toString('base64'),
      });
      assert.strictEqual(good.status, 200, `the right transfer must go out: ${JSON.stringify(good.body)}`);
      assert.strictEqual(good.body.signedBy, 'browser', 'and be reported as browser-signed');
      assert.strictEqual(broadcast.length, 1, 'exactly one broadcast');

      // An intent is single-use: the same one cannot be replayed with new bytes.
      const replay = await post(`/api/wallets/${id}/withdraw/submit`, {
        intentId: intent.body.intentId,
        txBase64: Buffer.from(unsigned.serialize()).toString('base64'),
      });
      assert.strictEqual(replay.status, 400, 'a used intent must not be replayable');
      assert.strictEqual(broadcast.length, 1, 'and must not broadcast twice');
    } finally {
      engine.executor.conn = realConn;
    }
  });

  await test('the signed path works for a wallet the bot has NO key for — that is the point', async () => {
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'NoKeyHere', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;

    const list = await get('/api/wallets');
    const row = list.body.find((w) => w.id === id);
    assert.strictEqual(row.keyArmed, false, 'the bot holds no key for it');

    const realConn = engine.executor.conn;
    engine.executor.conn = () => ({
      getBalance: async () => 1_000_000_000,
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999999 }),
      sendRawTransaction: async () => 'T'.repeat(64) + '111',
      getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    });
    try {
      const intent = await post(`/api/wallets/${id}/withdraw/intent`, { destination: DEST, mode: 'all' });
      assert.strictEqual(intent.status, 200, `even an "all" withdrawal can be prepared with no key: ${JSON.stringify(intent.body)}`);
      assert.ok(Number(intent.body.amountSol) > 0, 'and it has an amount');
      assert.ok(Number(intent.body.amountSol) < 1, 'keeping back the fee and the rent reserve');

      // The old, server-signed route still insists on a key — unchanged.
      const serverPath = await post(`/api/wallets/${id}/withdraw`, {
        destination: DEST, mode: 'all', confirm: 'WITHDRAW',
      });
      assert.strictEqual(serverPath.status, 400, 'the server-key path must still refuse an unarmed wallet');
      assert.strictEqual(serverPath.body.error, 'wallet_not_armed');
    } finally {
      engine.executor.conn = realConn;
    }
  });

  await test('a signed withdrawal that FAILS on chain is still spent once — no replay', async () => {
    // The intent is consumed when the signed bytes are accepted, not when the
    // network says yes. Otherwise a failure invites a retry of the same bytes,
    // and the "single use" the dialog promises is not single use.
    const paired = Keypair.generate();
    const dest = Keypair.generate().publicKey.toBase58();
    const created = await post('/api/wallets', { name: 'Replay', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;

    const realConn = engine.executor.conn;
    engine.executor.conn = () => ({
      getMultipleAccountsInfo: async () => [],
      getBalance: async () => 0, // the intent route quotes the wallet before building
      getLatestBlockhash: async () => ({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }),
      sendRawTransaction: async () => {
        throw new Error('Simulation failed. \nMessage: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit..');
      },
    });
    try {
      const intent = await post(`/api/wallets/${id}/withdraw/intent`, { destination: dest, mode: 'custom', amountSol: 0.01 });
      assert.ok(intent.body.txBase64, 'the intent hands the browser an unsigned transaction');
      assert.ok(!/secret|private/i.test(JSON.stringify(intent.body)), 'and never anything key-shaped');

      const tx = Transaction.from(Buffer.from(intent.body.txBase64, 'base64'));
      tx.sign(paired);
      const signed = Buffer.from(tx.serialize()).toString('base64');

      const first = await post(`/api/wallets/${id}/withdraw/submit`, { intentId: intent.body.intentId, txBase64: signed });
      assert.strictEqual(first.status, 400, 'the send fails');
      assert.match(String(first.body.error), /does not hold enough SOL/i, 'with a sentence, not an RPC dump');
      assert.ok(!/Simulation failed|getLogs/.test(String(first.body.error)), 'and none of the raw text');

      const second = await post(`/api/wallets/${id}/withdraw/submit`, { intentId: intent.body.intentId, txBase64: signed });
      assert.strictEqual(second.status, 400, 'the same bytes cannot be relayed twice');
      assert.match(String(second.body.error), /unknown_or_expired_intent/, 'because the intent was spent by the first attempt');
    } finally {
      engine.executor.conn = realConn;
    }
  });

  /* ───────────── sending a key to the bot — the repo's persistent-bot/start ───────────── */

  console.log('\nSending a wallet to the bot\n');

  await test('POST /persist stores the key ONLY when it matches the address', async () => {
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'PersistMe', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;

    // A keystore stand-in that records what the route asked it to do, so this test
    // is about the WIRING (which key, under which id, with which checks) and not
    // about the crypto, which test/keystore.test.js covers against the real file.
    const calls = [];
    Object.assign(keystore, {
      isUnlocked: () => false,
      isInitialised: () => true,
      unlock: (pass) => { calls.push(['unlock', pass]); return true; },
      init: (pass) => { calls.push(['init', pass]); return true; },
      importKey: (wid, secret) => { calls.push(['importKey', wid, String(secret).slice(0, 4)]); return Keypair.fromSecretKey((bs58.default ? bs58.default : bs58).decode(secret)).publicKey.toBase58(); },
      remove: (wid) => { calls.push(['remove', wid]); return true; },
      arm: () => { calls.push(['arm']); return 'ok'; },
    });
    try {
      // 1. no secret → refused before anything else happens
      const noKey = await post(`/api/wallets/${id}/persist`, { keystorePassphrase: 'longenough' });
      assert.strictEqual(noKey.status, 400);
      assert.strictEqual(noKey.body.error, 'secret_key_required');

      // 2. no keystore passphrase and the vault is closed → refused, in words
      const noPass = await post(`/api/wallets/${id}/persist`, { secretKey: 'whatever' });
      assert.strictEqual(noPass.body.error, 'keystore_passphrase_required');
      assert.ok(!/vault/i.test(noPass.body.hint), 'the user-facing word is keystore');
      assert.match(noPass.body.hint, /8 characters/, 'and the rule is stated');

      // 3. a key for a DIFFERENT address → refused, and nothing left behind
      const wrong = Keypair.generate();
      const wrongB58 = (bs58.default ? bs58.default : bs58).encode(wrong.secretKey);
      const mismatch = await post(`/api/wallets/${id}/persist`, { secretKey: wrongB58, keystorePassphrase: 'longenough' });
      assert.strictEqual(mismatch.status, 400);
      assert.strictEqual(mismatch.body.error, 'key_address_mismatch');
      assert.ok(calls.some((c) => c[0] === 'remove' && c[1] === id), 'and the wrong key is removed from the vault');

      // 4. the right key → stored, sealed, and the wallet is flagged as the bot's
      const goodB58 = (bs58.default ? bs58.default : bs58).encode(paired.secretKey);
      const ok = await post(`/api/wallets/${id}/persist`, { secretKey: goodB58, keystorePassphrase: 'longenough' });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.persistent, true);
      assert.strictEqual(ok.body.keyHolder, 'server');
      const stored = config.wallets.find((w) => w.id === id);
      assert.strictEqual(stored.persistent, true, 'the flag is saved with the wallet, so a restart knows');
      assert.strictEqual(stored.keyHolder, 'server');
      assert.ok(!/secretkey|privkey/i.test(JSON.stringify(stored)), 'and the KEY is not in config.json — it lives in the keystore');
      assert.ok(calls.some((c) => c[0] === 'importKey' && c[1] === id), 'the route handed the key to the keystore under the wallet id');
    } finally {
      Object.assign(keystore, REAL_KEYSTORE);
    }
  });

  await test('a wallet sent to the bot SAYS SO in the list the cards are rendered from', async () => {
    // The card cannot know it is on the bot unless the payload says so — found by
    // running it: `persistent` was set in the config and missing from /api/wallets,
    // so the button appeared to do nothing.
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'OnTheBot', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;
    const stored = config.wallets.find((w) => w.id === id);
    stored.persistent = true;

    const list = await get('/api/wallets');
    const row = list.body.find((w) => w.id === id);
    assert.strictEqual(row.persistent, true, 'the flag is in the payload');
    assert.strictEqual(row.keyHolder, 'server', 'and it says who holds the key');

    stored.persistent = false;
    const after = await get('/api/wallets');
    assert.strictEqual(after.body.find((w) => w.id === id).persistent, false, 'and it goes away again');
  });

  await test('POST /unpersist takes the key back out and leaves the browser in charge', async () => {
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'ComeBack', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;
    const stored = config.wallets.find((w) => w.id === id);
    stored.persistent = true;
    stored.keyHolder = 'server';

    const removed = [];
    const realRemove = keystore.remove;
    const realIsUnlocked = keystore.isUnlocked;
    keystore.remove = (wid) => { removed.push(wid); return true; };
    // A LOCKED vault cannot rewrite its own file, so the route must ask for the
    // passphrase rather than throwing a 500 and leaving the key on disk.
    keystore.isUnlocked = () => false;
    try {
      const locked = await post(`/api/wallets/${id}/unpersist`, {});
      assert.strictEqual(locked.status, 400, 'a closed keystore cannot delete a key from its file');
      assert.strictEqual(locked.body.error, 'keystore_passphrase_required');
      assert.deepStrictEqual(removed, [], 'and nothing was claimed');

      keystore.isUnlocked = () => true;
      const out = await post(`/api/wallets/${id}/unpersist`, {});
      assert.strictEqual(out.status, 200, JSON.stringify(out.body));
      assert.strictEqual(out.body.persistent, false);
      assert.strictEqual(out.body.keyHolder, 'browser');
      assert.deepStrictEqual(removed, [id], 'the key is removed from the server');
      assert.strictEqual(stored.persistent, false, 'and the flag is cleared');
      assert.strictEqual(stored.keyHolder, 'browser');
      assert.strictEqual(stored.enabled, false, 'a wallet the bot can no longer sign for is not left "running"');
      assert.match(out.body.note, /browser/i, 'and the answer says where the key still is');
    } finally {
      keystore.remove = realRemove;
      keystore.isUnlocked = realIsUnlocked;
    }
  });

  /* ───────────── a locked wallet still shows what it holds ───────────── */

  console.log('\nA locked wallet is not an empty wallet\n');

  await test('the balance of a wallet with NO key here is read and shown, not hidden', async () => {
    // The reference bot polls every stored wallet's balance — locked ones too —
    // because reading a balance only needs the public key. Showing "locked" where
    // the money is hides the one fact people open the dashboard to check.
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'Funded', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;

    const realConn = engine.executor.conn;
    engine.executor.conn = () => ({
      getMultipleAccountsInfo: async (keys) => keys.map(() => ({ lamports: 4_250_000_000 })),
    });
    try {
      const read = await engine.refreshLockedBalances();
      assert.ok(read >= 1, 'the read must cover the keyless wallet');
      const list = await get('/api/wallets');
      const row = list.body.find((w) => w.id === id);
      assert.strictEqual(row.keyArmed, false, 'the bot still holds no key for it');
      assert.strictEqual(row.balanceSol, 4.25, 'and its balance is still reported');
    } finally {
      engine.executor.conn = realConn;
    }
  });

  await test('a failed balance read leaves the balance UNKNOWN, not zero', async () => {
    const paired = Keypair.generate();
    const created = await post('/api/wallets', { name: 'Unreadable', address: paired.publicKey.toBase58() });
    const id = created.body.wallet;

    const realConn = engine.executor.conn;
    engine.executor.conn = () => ({ getMultipleAccountsInfo: async () => { throw new Error('429 rate limited'); } });
    try {
      await engine.refreshLockedBalances();
      const list = await get('/api/wallets');
      const row = list.body.find((w) => w.id === id);
      assert.strictEqual(row.balanceSol, null, 'an unreadable balance must be null — never 0, which would read as "your SOL is gone"');
    } finally {
      engine.executor.conn = realConn;
    }
  });

  await test('Settings PUT changes the RPC used by the running executor, not just config.json', async () => {
    const oldList = [...config.global.rpc.endpoints];
    const oldConn = engine.executor.conn();
    try {
      const saved = await api('PUT', '/api/config', { rpc: { endpoints: ['https://replacement.invalid'] } });
      assert.strictEqual(saved.status, 200);
      assert.ok(engine.executor.rpcChain.includes('https://replacement.invalid'));
      assert.notStrictEqual(engine.executor.conn(), oldConn, 'Connection must be rebuilt on save');
    } finally { await api('PUT', '/api/config', { rpc: { endpoints: oldList } }); }
  });

  await test('public status/config mask RPC URL keys; saving placeholders preserves real URLs', async () => {
    const secret = 'PRIVATE_RPC_KEY_DO_NOT_EXPOSE';
    const previous = [...config.global.rpc.endpoints];
    const wsPrevious = config.global.rpc.wsEndpoint;
    config.global.rpc.endpoints = [`https://secret.test/?api-key=${secret}`];
    config.global.rpc.wsEndpoint = `wss://secret.test/${secret}`;
    engine.executor.configureRpc();
    try {
      const status = await get('/api/status');
      const configRes = await get('/api/config');
      for (const r of [status, configRes]) {
        assert.strictEqual(r.status, 200);
        assert.ok(!JSON.stringify(r.body).includes(secret), 'never disclose a provider credential');
      }
      const saved = await api('PUT', '/api/config', { rpc: {
        endpoints: configRes.body.rpc.endpoints, wsEndpoint: configRes.body.rpc.wsEndpoint,
      } });
      assert.strictEqual(saved.status, 200, JSON.stringify(saved.body));
      assert.strictEqual(config.global.rpc.endpoints[0], `https://secret.test/?api-key=${secret}`);
      assert.strictEqual(config.global.rpc.wsEndpoint, `wss://secret.test/${secret}`);
      assert.ok(!JSON.stringify(saved.body).includes(secret));
    } finally {
      config.global.rpc.endpoints = previous;
      config.global.rpc.wsEndpoint = wsPrevious;
      engine.executor.configureRpc();
    }
  });

  await test('RPC diagnostics require a token and reveal status but never endpoint keys', async () => {
    const unauth = await fetch(`http://127.0.0.1:${PORT}/api/rpc/diagnostics`, { method: 'POST' });
    assert.strictEqual(unauth.status, 401);
    const realProbe = engine.executor.probeRpc;
    engine.executor.probeRpc = async () => ({ envPriority: true,
      results: [{ label: 'endpoint 1', ok: false, status: 'HTTP 429' }], omitted: 0 });
    try {
      const r = await post('/api/rpc/diagnostics', {});
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.results[0].status, 'HTTP 429');
      assert.ok(!JSON.stringify(r.body).includes('https://'));
    } finally { engine.executor.probeRpc = realProbe; }
  });

  Object.assign(keystore, { has: STUBBED_KEYSTORE.has, getKeypair: STUBBED_KEYSTORE.getKeypair, isUnlocked: STUBBED_KEYSTORE.isUnlocked });

  /* ───────────────────────────────────────────────────────────────────── */

  server.close();
  for (const [k, v] of Object.entries(REAL_KEYSTORE)) keystore[k] = v;
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
