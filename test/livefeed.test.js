'use strict';
/**
 * The live launch scanner feed.
 *
 * Its whole job is to answer the question the counters cannot: "the engine is
 * running and buying nothing — why?" So the tests are about the ANSWER, not the
 * plumbing: a launch that is filtered must carry the reason, a launch every wallet
 * declined must be distinguishable from one that was bought, and an RPC failure
 * must never be reported as a verdict on the token.
 *
 * Run: node test/livefeed.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { LiveFeed, DECISION } = require(path.join(ROOT, 'src/engine/livefeed'));
const bus = require(path.join(ROOT, 'src/util/events'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u{1B}[32m✓\u{1B}[0m ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  \u{1B}[31m✗\u{1B}[0m ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

/** A fresh feed on its own bus listeners, removed after each test. */
function withFeed(fn) {
  const feed = new LiveFeed({ max: 5 }).attach();
  try { fn(feed); } finally {
    // The bus keeps listeners for the process, so the feed is reused across the
    // tests below through this helper and its map is what each test inspects.
    feed.clear();
  }
  return feed;
}

const candidate = (n) => ({
  mint: `Mint${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  symbol: `TOK${n}`,
  name: `Token ${n}`,
  creator: `Dev${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
  detectedAt: Date.now(),
});

(async () => {
  console.log('\nThe live launch scanner feed\n');

  await test('a detected launch appears immediately, as "checking"', () => {
    withFeed((feed) => {
      feed.note(candidate(1));
      const rows = feed.snapshot();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].decision, DECISION.CHECKING);
      assert.strictEqual(rows[0].symbol, 'TOK1');
      assert.strictEqual(rows[0].devWallet, 'Dev1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    });
  });

  await test('the checks publish liquidity, dev holdings and honeypot risk for the row', () => {
    withFeed((feed) => {
      const c = candidate(2);
      feed.note(c);
      feed.analyze({
        wallet: 'Alpha', candidate: c, ok: true, reasons: [],
        report: { liquiditySol: 12.5, devHoldPct: 3.4, top10Pct: 22, honeypot: { risk: 0, notes: [] } },
      });
      const row = feed.snapshot()[0];
      assert.strictEqual(row.liquiditySol, 12.5, 'liquidity must be shown');
      assert.strictEqual(row.devHoldPct, 3.4, 'dev holdings must be shown');
      assert.strictEqual(row.riskScore, 0);
    });
  });

  await test('a filtered launch carries the REASON, not just a verdict', () => {
    withFeed((feed) => {
      const c = candidate(3);
      feed.note(c);
      feed.analyze({
        wallet: 'Alpha', candidate: c, ok: false, hard: true, reasons: ['dev_hold_high(47.0%>20%)'],
        report: { liquiditySol: 2.1, devHoldPct: 47, honeypot: { risk: 25, notes: ['mint_authority_live'] } },
      });
      feed.skip({ wallet: 'Alpha', candidate: c, reasons: ['dev_hold_high(47.0%>20%)'], hard: true });
      feed.finalize({ mint: c.mint, outcomes: ['skip:dev_hold_high(47.0%>20%)'], walletNames: ['Alpha'] });

      const row = feed.snapshot()[0];
      assert.strictEqual(row.decision, DECISION.SKIPPED);
      assert.match(row.skipReason, /dev_hold_high/, 'the reason is the whole point of the row');
      assert.deepStrictEqual(row.riskNotes, ['mint_authority_live']);
      assert.strictEqual(row.wallets[0].action, 'skipped');
    });
  });

  await test('every wallet declining is NOT the same as one wallet buying', () => {
    withFeed((feed) => {
      const declined = candidate(4);
      feed.note(declined);
      feed.finalize({ mint: declined.mint, outcomes: ['skip:filters', 'skip:filters'], walletNames: ['Alpha', 'Scalper'] });
      assert.strictEqual(feed.snapshot()[0].decision, DECISION.SKIPPED);

      const taken = candidate(5);
      feed.note(taken);
      feed.bought({ mint: taken.mint, wallet: 'Alpha' });
      feed.finalize({ mint: taken.mint, outcomes: ['bought', 'skip:insufficient_balance'], walletNames: ['Alpha', 'Scalper'] });
      const row = feed.snapshot()[0];
      assert.strictEqual(row.decision, DECISION.BOUGHT, 'one fill makes the launch bought');
      assert.strictEqual(row.skipReason, null, 'and must not keep a rejection reason attached');
    });
  });

  await test('an unreachable RPC is reported as infrastructure, never as a bad token', () => {
    // This distinction was a real bug elsewhere in the bot: a rate-limited RPC made
    // every launch look like a scam. The feed must not repeat it.
    withFeed((feed) => {
      const c = candidate(6);
      feed.note(c);
      feed.skip({ wallet: 'Alpha', candidate: c, reasons: ['rpc_unavailable(429)'], infra: true });
      feed.finalize({ mint: c.mint, outcomes: ['skip:rpc_unavailable'], walletNames: ['Alpha'] });

      const row = feed.snapshot()[0];
      assert.strictEqual(row.decision, DECISION.ERROR);
      assert.match(row.skipReason, /infrastructure, not the token/i);
    });
  });

  await test('newest first, and the ring is bounded', () => {
    const feed = new LiveFeed({ max: 3 }).attach();
    for (let i = 1; i <= 5; i += 1) feed.note(candidate(10 + i));
    const rows = feed.snapshot();
    assert.strictEqual(rows.length, 3, 'the ring must not grow without limit');
    assert.strictEqual(rows[0].symbol, 'TOK15', 'the newest launch must be at the top');
    assert.strictEqual(rows[2].symbol, 'TOK13');
    feed.clear();
  });

  await test('the same mint is one row, however many wallets look at it', () => {
    withFeed((feed) => {
      const c = candidate(7);
      feed.note(c);
      feed.analyze({ wallet: 'Alpha', candidate: c, ok: true, reasons: [], report: { liquiditySol: 9 } });
      feed.analyze({ wallet: 'Scalper', candidate: c, ok: true, reasons: [], report: { liquiditySol: 9 } });
      feed.analyze({ wallet: 'Degen', candidate: c, ok: false, reasons: ['min_holders'], report: { liquiditySol: 9 } });

      const rows = feed.snapshot();
      assert.strictEqual(rows.length, 1, 'three wallets must not produce three identical rows');
      assert.strictEqual(rows[0].wallets.length, 3, 'but each wallet verdict must be visible');
      assert.ok(rows[0].wallets.some((w) => w.name === 'Degen' && w.action === 'filtered'));
    });
  });

  await test('a shallower later report never erases a real number', () => {
    // A token rejected on mint authorities never reaches the curve, so its report
    // has no liquidity. Nulling the column would hide what was already learned.
    withFeed((feed) => {
      const c = candidate(8);
      feed.note(c);
      feed.analyze({ wallet: 'Alpha', candidate: c, ok: true, reasons: [], report: { liquiditySol: 4.4, devHoldPct: 9 } });
      feed.analyze({ wallet: 'Scalper', candidate: c, ok: false, reasons: ['mint_authority_live'], report: { liquiditySol: null, devHoldPct: null } });

      const row = feed.snapshot()[0];
      assert.strictEqual(row.liquiditySol, 4.4, 'a real liquidity figure must survive');
      assert.strictEqual(row.devHoldPct, 9, 'and so must the dev holding');
    });
  });

  await test('the highest risk seen wins across wallets', () => {
    withFeed((feed) => {
      const c = candidate(9);
      feed.note(c);
      feed.analyze({ wallet: 'Alpha', candidate: c, ok: true, reasons: [], report: { honeypot: { risk: 0, notes: [] } } });
      feed.analyze({ wallet: 'Degen', candidate: c, ok: true, reasons: [], report: { honeypot: { risk: 60, notes: ['freeze_authority_live'] } } });
      assert.strictEqual(feed.snapshot()[0].riskScore, 60, 'a permissive wallet must not mask a strict one');
    });
  });

  await test('the row is broadcast so the dashboard can patch it live', () => {
    const seen = [];
    const h = (row) => seen.push(row.mint);
    bus.on('scan:update', h);
    try {
      const feed = new LiveFeed().attach();
      feed.note(candidate(11));
      feed.finalize({ mint: candidate(11).mint, outcomes: ['bought'], walletNames: ['Alpha'] });
      assert.ok(seen.length >= 2, 'at least the detection and the decision must be pushed');
      feed.clear();
    } finally {
      bus.off('scan:update', h);
    }
  });

  await test('a launch is one row per WALLET NAME — never the same wallet twice', () => {
    // Seen on the live deployment: the row listed "PaperProbe: checking" and
    // "w_99fde369a87a: bought" for the same wallet, because token:analyzed keys by
    // name and position:opened arrived keyed by id. A wallet is one entry.
    withFeed((feed) => {
      const c = candidate(9);
      bus.safeEmit('token:detected', c);
      bus.safeEmit('token:analyzed', { wallet: 'PaperProbe', candidate: c, ok: true, report: {} });
      bus.safeEmit('position:opened', { mint: c.mint, wallet: 'PaperProbe', walletId: 'w_99fde369a87a' });

      const row = feed.snapshot()[0];
      assert.strictEqual(row.decision, DECISION.BOUGHT);
      assert.strictEqual(row.wallets.length, 1, `one entry per wallet, got ${JSON.stringify(row.wallets)}`);
      assert.strictEqual(row.wallets[0].name, 'PaperProbe');
      assert.strictEqual(row.wallets[0].action, 'bought', 'and the final verdict, not the earlier checking state');
      assert.strictEqual(row.boughtBy, 'PaperProbe', 'the buyer is named, not keyed by id');
    });
  });

  await test('garbage in the event stream cannot throw into the engine', () => {
    withFeed((feed) => {
      assert.doesNotThrow(() => feed.note(null));
      assert.doesNotThrow(() => feed.note({}));
      assert.doesNotThrow(() => feed.analyze({}));
      assert.doesNotThrow(() => feed.analyze({ candidate: { mint: 'unknown-mint' } }));
      assert.doesNotThrow(() => feed.skip({ candidate: { mint: 'unknown-mint' } }));
      assert.doesNotThrow(() => feed.finalize({ mint: 'unknown-mint', outcomes: null }));
      assert.strictEqual(feed.snapshot().length, 0, 'none of it should have created a row');
    });
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
