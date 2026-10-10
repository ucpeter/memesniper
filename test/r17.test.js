'use strict';
/** Offline regressions for the stopped-wallet scanner and missing curve values. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const Scanner = require('../src/engine/scanner');
const Engine = require('../src/engine/engine');
const { LiveFeed, deriveRisk } = require('../src/engine/livefeed');
const bus = require('../src/util/events');
const ROOT = path.join(__dirname, '..');
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`); }
const next = () => new Promise((resolve) => setTimeout(resolve, 0));

(async () => {
  console.log('\nScanner is public; wallet feed shows only wallet decisions\n');
  await test('missing/null/blank curve fields remain unread, but numeric zero stays zero', () => {
    for (const value of [null, undefined, '', ' ', 'invalid']) {
      assert.equal(Scanner.finiteEventNumber(value), null, `missing value ${String(value)} became zero`);
    }
    assert.equal(Scanner.finiteEventNumber(0), 0);
    assert.equal(Scanner.finiteEventNumber('0'), 0);
    assert.equal(Scanner.finiteEventNumber('1.25'), 1.25);
  });
  await test('the real feed prints unread for missing curve data, $0 only for a measured zero', () => {
    const feed = new LiveFeed({ globalConfig: () => ({ risk: { maxDevHoldPct: 15, minLiquidityUsd: 2000 } }) });
    const a = feed.note({ mint: 'missing', initialBuy: null, vSolInBondingCurve: Scanner.finiteEventNumber(null) });
    assert.equal(a.liquidityUsd, null);
    assert.equal(a.riskScore, null);
    const partial = feed.note({ mint: 'partial', initialBuy: 0, vSolInBondingCurve: null });
    assert.equal(partial.riskScore, null, 'an unread curve plus a harmless dev figure is not risk 0');
    assert.equal(deriveRisk({ devHoldPct: 0, liquidityUsd: null },
      { maxDevHoldPct: 15, minLiquidityUsd: 2000 }).score, null);
    const b = feed.note({ mint: 'actual-zero', initialBuy: 0, vSolInBondingCurve: Scanner.finiteEventNumber(0) });
    assert.equal(b.liquiditySol, 0);
    assert.equal(b.liquidityUsd, 0);
    assert.equal(b.riskScore, null, 'zero VIRTUAL SOL is not a measured real deposit');
  });
  await test('wallet stopped: new launches reach public feed, not wallet feed; start evaluates and labels rejection', async () => {
    const engine = Object.create(Engine.prototype);
    engine.running = true; // shared scanner stays running even when all wallets are stopped
    engine.config = { global: { scanner: { evaluateConcurrency: 1, evalTimeoutMs: 1000 } } };
    engine.stats = { detected: 0, evaluated: 0, bought: 0, skipped: 0 };
    engine._evalQueue = 0;
    engine._recon = () => { throw new Error('complete event needs no recon'); };
    const feed = new LiveFeed();
    const events = [];
    const onFinal = (payload) => { events.push(payload); feed.finalize(payload); };
    bus.on('scan:final', onFinal);
    let calls = 0;
    const active = { cfg: { id: 'active', name: 'Sniper 1', enabled: false }, stats: { paused: false },
      consider: async () => { calls++; return 'skip:liquidity_below_min_usd($0<$150)'; } };
    const paused = { cfg: { id: 'paused', name: 'Sniper 2', enabled: true }, stats: { paused: true },
      consider: async () => { throw new Error('paused wallet must not receive a launch'); } };
    engine.traders = new Map([[active.cfg.id, active], [paused.cfg.id, paused]]);
    try {
      const stoppedLaunch = { mint: 'stopped-launch', symbol: 'SKIP', initialBuy: 0, vSolInBondingCurve: 0 };
      feed.note(stoppedLaunch); // public scanner is independent
      engine._onToken(stoppedLaunch);
      await next();
      assert.ok(feed.snapshot().some((r) => r.mint === stoppedLaunch.mint));
      assert.deepEqual(feed.rows.get(stoppedLaunch.mint).wallets, []);
      assert.equal(calls, 0);
      assert.equal(events.length, 0);
      active.cfg.enabled = true;
      const liveLaunch = { ...stoppedLaunch, mint: 'active-launch' };
      feed.note(liveLaunch);
      engine._onToken(liveLaunch);
      await next();
      assert.equal(calls, 1);
      assert.equal(events.length, 1);
      assert.deepEqual(events[0].walletIds, ['active']);
      const mine = feed.rows.get(liveLaunch.mint).wallets;
      assert.equal(mine.length, 1);
      assert.equal(mine[0].walletId, 'active');
      assert.match(mine[0].reason, /liquidity_below_min/);
      assert.equal(mine[0].action, 'skipped');
      active.cfg.enabled = false;
      const afterStop = { ...stoppedLaunch, mint: 'after-stop' };
      feed.note(afterStop);
      engine._onToken(afterStop);
      await next();
      assert.deepEqual(feed.rows.get(afterStop.mint).wallets, []);
    } finally { bus.off('scan:final', onFinal); }
  });
  await test('queue watchdog marks pending at deadline, then reports a late skip honestly', async () => {
    const engine = Object.create(Engine.prototype);
    engine.running = true;
    engine.config = { global: { scanner: { evaluateConcurrency: 1, evalTimeoutMs: 100, unresolvedWarnMs: 210 } } };
    engine.stats = { detected: 0, evaluated: 0, bought: 0, skipped: 0, evalTimeouts: 0 };
    engine._evalQueue = 0;
    engine._recon = () => {};
    let finish;
    const t = { cfg: { id: 'slow', name: 'Slow wallet', enabled: true }, stats: { paused: false },
      consider: () => new Promise((resolve) => { finish = resolve; }) };
    engine.traders = new Map([['slow', t]]);
    const feed = new LiveFeed();
    const handlers = [['scan:started', (e) => feed.start(e)],
      ['scan:slow', (e) => feed.slow(e)], ['scan:stalled', (e) => feed.stalled(e)],
      ['scan:final', (e) => feed.finalize(e)]];
    for (const [event, fn] of handlers) bus.on(event, fn);
    try {
      const launch = { mint: 'slow-launch', initialBuy: 0, vSolInBondingCurve: 30 };
      feed.note(launch);
      engine._onToken(launch);
      await next();
      assert.equal(feed.snapshot()[0].wallets[0].action, 'checking');
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(engine._evalQueue, 0, 'watchdog frees the scanner queue');
      assert.equal(feed.snapshot()[0].wallets[0].action, 'slow', 'not falsely marked as skipped');
      await new Promise((resolve) => setTimeout(resolve, 110));
      assert.equal(feed.snapshot()[0].wallets[0].action, 'unconfirmed', 'eventual unknown is not infinite evaluating');
      finish('skip:balance_unknown');
      await next();
      assert.equal(feed.snapshot()[0].wallets[0].action, 'skipped');
      assert.equal(feed.snapshot()[0].wallets[0].reason, 'balance_unknown');
    } finally { for (const [event, fn] of handlers) bus.off(event, fn); }
  });

  await test('one rejecting wallet cannot freeze another wallet or the final scan', async () => {
    const engine = Object.create(Engine.prototype);
    engine.running = true;
    engine.config = { global: { scanner: { evaluateConcurrency: 1, evalTimeoutMs: 500 } } };
    engine.stats = { detected: 0, evaluated: 0, bought: 0, skipped: 0 };
    engine._evalQueue = 0;
    engine._recon = () => {};
    engine.traders = new Map([
      ['broken', { cfg: { id: 'broken', name: 'Broken', enabled: true }, stats: { paused: false },
        consider: async () => { throw new Error('test_only'); } }],
      ['healthy', { cfg: { id: 'healthy', name: 'Healthy', enabled: true }, stats: { paused: false },
        consider: async () => 'skip:cooldown' }],
    ]);
    let finished;
    const onFinal = (evt) => { finished = evt; };
    bus.on('scan:final', onFinal);
    try {
      engine._onToken({ mint: 'caught-error', initialBuy: 0, vSolInBondingCurve: 30 });
      await next();
      assert.deepEqual(finished.outcomes, ['error:evaluation_failed', 'skip:cooldown']);
      assert.deepEqual(finished.walletIds, ['broken', 'healthy']);
    } finally { bus.off('scan:final', onFinal); }
  });

  await test('wallet scanner keeps the previous column order and USD liquidity', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const app = fs.readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');
    const dom = new JSDOM(html.replace('<script src="./app.js"></script>', ''), {
      runScripts: 'dangerously', pretendToBeVisual: true, url: 'http://localhost/terminal',
    });
    const { window } = dom;
    window.fetch = async () => { throw Error('offline'); };
    window.WebSocket = class { constructor() { this.readyState = 3; } addEventListener() {} close() {} send() {} };
    window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
    const script = window.document.createElement('script'); script.textContent = app;
    window.document.body.appendChild(script);
    await next();
    window.eval(`(function(){
      S.wallets = [{ id: 'w1', name: 'Sniper 1' }];
      S.scanFeed = [{ mint:'Mint1', symbol:'TINY', liquiditySol: 0.001, liquidityUsd: 0,
        devHoldPct: 0, riskScore: 40,
        wallets:[{ walletId:'w1', name:'Sniper 1', action:'filtered',
          reason:'liquidity_below_min_usd($0<$150)' }] },
        { mint:'Mint2', symbol:'UNKNOWN', liquiditySol:null, liquidityUsd:null,
          devHoldPct:null, riskScore:null, wallets:[{walletId:'w1', name:'Sniper 1',
            action:'skipped',reason:'balance_unknown'}] }];
      document.body.innerHTML = walletFeedTable(S.wallets[0]);
    })()`);
    const table = window.document.querySelector('table');
    const heads = [...table.querySelectorAll('th')].map((x) => x.textContent.trim());
    assert.deepEqual(heads, ['Token', 'Dev hold', 'Liquidity', 'Risk', 'What Sniper 1 did']);
    assert.ok(!app.includes('wallet-feed-hint'), 'remove the extra explanatory line');
    const first = table.querySelector('tbody tr');
    const cells = [...first.querySelectorAll('td')].map((x) => x.textContent.trim());
    assert.match(cells[4], /filtered.*liquidity below min usd/is);
    assert.match(cells[2], /<\$1 virtual/, 'a small positive virtual value must not display as zero');
    assert.match(cells[2], /real unread/, 'real backing is not inferred from a virtual value');
    assert.match(table.querySelectorAll('tbody tr')[1].textContent, /unread/);
    dom.window.close();
  });
  console.log(`\n${passed} passed\n`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
