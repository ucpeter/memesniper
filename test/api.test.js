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

  await test('status().scan reports what the panel is showing', () => {
    const st = engine.status();
    assert.ok(st.scan, 'status must carry the feed tally, or the UI cannot reconcile the counters');
    assert.strictEqual(st.scan.rows, 1);
    assert.strictEqual(typeof st.scan.seen, 'number');
  });

  await test('GET /api/scan serves the rows instead of an empty list', async () => {
    const r = await api('GET', '/api/scan?limit=10');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.rows.length, 1, 'the panel reads exactly this');
    assert.strictEqual(r.body.rows[0].symbol, 'R8');
    assert.strictEqual(r.body.rows[0].decision, 'checking', 'a fresh launch is still being evaluated');
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
    assert.strictEqual(rows.length, 1, 'still one row');
    assert.strictEqual(rows[0].liquiditySol, 12.5, 'the checks filled it in');
    assert.strictEqual(rows[0].decision, 'skipped');
    assert.match(rows[0].skipReason, /liquidity/, 'and say WHY, in words');
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

  /* ───────────────────────────────────────────────────────────────────── */

  server.close();
  for (const [k, v] of Object.entries(REAL_KEYSTORE)) keystore[k] = v;
  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
