'use strict';
/**
 * DEV HOLD, LIQUIDITY and RISK — the columns that were blank.
 *
 * The complaint, from the phone screenshot of the live app: "on the screenshot dev
 * hold and risk is not displayed". They were blank because nothing filled them from
 * the launch itself: the table waited on an RPC read for every launch, and a launch
 * whose read was rate-limited showed three dashes while the bot was demonstrably
 * alive and scanning.
 *
 * The reference bot this project is measured against derives dev hold and liquidity
 * from the CREATE EVENT — `initialBuy` against pump.fun's fixed 1e9 supply, and
 * `vSolInBondingCurve` for the curve — with no RPC call at all. These tests pin that
 * behaviour, the dollar conversion the user asked for, and the honesty rule that
 * survives it: a cell is never filled with an invented number.
 *
 * Run: node test/scannerfacts.test.js
 */
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { LiveFeed, deriveRisk, PUMP_FUN_TOTAL_SUPPLY } = require(path.join(ROOT, 'src/engine/livefeed'));
const solprice = require(path.join(ROOT, 'src/engine/solprice'));
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

const MINT = (n) => `${String(n).repeat(40).slice(0, 40)}`;
const THRESHOLDS = { maxDevHoldPct: 15, minLiquidityUsd: 2000 };

/** A launch exactly as PumpPortal sends it — curve state included. */
const launch = (over = {}) => ({
  mint: MINT('a'),
  symbol: 'TEST',
  name: 'Test',
  creator: 'DEVWALLET',
  initialBuy: 30_000_000, // 3% of supply
  vSolInBondingCurve: 12.5,
  vTokensInBondingCurve: 1e9,
  detectedAt: Date.now(),
  ...over,
});

function withFeed(fn, thresholds = THRESHOLDS) {
  const feed = new LiveFeed({ max: 5, globalConfig: () => ({ risk: thresholds }) }).attach();
  try {
    return fn(feed);
  } finally {
    feed.clear();
  }
}

(async () => {
  console.log('\nDEV HOLD, LIQUIDITY and RISK — from the launch itself\n');

  await test('a launch fills DEV HOLD and LIQUIDITY with NO RPC call at all', () => {
    // The whole point: these numbers are IN the create event. Nothing here touches
    // a connection — there is no connection to touch.
    withFeed((feed) => {
      bus.safeEmit('token:detected', launch());
      const row = feed.rows.get(MINT('a'));

      assert.strictEqual(row.devHoldPct, 3, 'opening buy = initialBuy / 1e9 = 3%; current hold unread');
      assert.strictEqual(row.liquiditySol, 12.5, 'liquidity = the curve, in SOL');
      assert.strictEqual(row.facts.devHold, 'opening_buy_event', 'and the row records where it came from');
      assert.strictEqual(row.facts.liquidity, 'virtual_event');
      assert.strictEqual(row.realLiquiditySol, null, 'an event does not prove deposited SOL');
    });
  });

  await test('the supply constant is pump.fun\'s own', () => {
    assert.strictEqual(PUMP_FUN_TOTAL_SUPPLY, 1_000_000_000, 'the reference bot divides by exactly this');
  });

  await test('LIQUIDITY is converted to dollars, which is the form the user asked for', () => {
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', launch());
        const row = feed.rows.get(MINT('a'));
        assert.strictEqual(row.liquidityUsd, 2500, '12.5 SOL at $200 = $2,500');
        assert.strictEqual(row.solUsd, 200, 'and the rate it used is on the row');
        assert.strictEqual(row.solUsdSource, 'test', 'with its source');
        assert.strictEqual(row.solUsdStale, false, 'and whether it was stale');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('virtual launch liquidity cannot pass the real-SOL risk floor', () => {
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', launch());
        const row = feed.rows.get(MINT('a'));
        assert.strictEqual(row.virtualLiquidityUsd, 2500);
        assert.strictEqual(row.realLiquidityUsd, null);
        assert.strictEqual(row.riskScore, null, 'real SOL not yet read — never claim a safe zero');
        assert.strictEqual(row.facts.risk, null);
        bus.safeEmit('token:recon', { candidate: { mint: MINT('a') },
          report: { honeypot: { risk: 0, notes: [] } } });
        assert.strictEqual(row.riskScore, null, 'one clean check cannot make virtual SOL safe');
      });
    } finally { solprice.__reset(); }
  });

  await test('a dangerous launch scores dangerous, a clean one does not', () => {
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        // 40% dev hold ($60k supply? no — 40% of 1e9) into a $240 curve.
        bus.safeEmit('token:detected', launch({ mint: MINT('b'), initialBuy: 400_000_000, vSolInBondingCurve: 1.2 }));
        bus.safeEmit('token:detected', launch({ mint: MINT('c'), initialBuy: 1_000_000, vSolInBondingCurve: 50 }));

        const bad = feed.rows.get(MINT('b'));
        const good = feed.rows.get(MINT('c'));
        assert.ok(bad.riskScore >= 40, `a 40% dev holding is risky (got ${bad.riskScore})`);
        assert.strictEqual(good.riskScore, null, 'a large virtual curve alone cannot prove safety');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('higher risk means more dangerous — the same direction as the reference bot', () => {
    const clean = deriveRisk({ devHoldPct: 1, realLiquidityUsd: 50_000 }, THRESHOLDS);
    const dirty = deriveRisk({ devHoldPct: 60, realLiquidityUsd: 100 }, THRESHOLDS);
    assert.ok(dirty.score > clean.score, 'more danger must score higher');
    assert.strictEqual(clean.score, 0, 'and an unremarkable launch scores 0');
  });

  await test('a row that gets its liquidity ON CHAIN is scored again, not left at 0', () => {
    // Live-run bug: a create event with no curve data scored 0 against a null
    // liquidity, and the on-chain read that filled the liquidity in a moment later
    // never re-scored it. Thin launches — the dangerous ones — all showed 0.
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        // No vSolInBondingCurve at all: the risky case.
        bus.safeEmit('token:detected', launch({ mint: MINT('i'), vSolInBondingCurve: undefined, initialBuy: undefined }));
        const row = feed.rows.get(MINT('i'));
        assert.strictEqual(row.riskScore, null, 'nothing is known yet, so nothing is claimed');

        // The on-chain read arrives with a very thin curve and a small dev bag.
        bus.safeEmit('token:recon', {
          candidate: { mint: MINT('i') },
          report: { liquiditySol: 0.1, devHoldPct: 1.2 },
        });
        assert.strictEqual(row.facts.realLiquidity, 'real_onchain', 'deposited SOL comes from the chain');
        assert.ok(row.riskScore >= 35, `thin liquidity must score dangerous, got ${row.riskScore}`);
        assert.ok(row.riskNotes.some((n) => /real SOL backing \$/.test(n)), 'and say which floor it fell through');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('re-scoring never LOWERS a risk already recorded', () => {
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        // A launch that is already dangerous from its own event: 30% dev hold.
        bus.safeEmit('token:detected', launch({ mint: MINT('j'), initialBuy: 300_000_000, vSolInBondingCurve: 1 }));
        const row = feed.rows.get(MINT('j'));
        const before = row.riskScore;
        assert.ok(before >= 40, `30% dev hold must be dangerous, got ${before}`);
        // A later, healthier on-chain reading must not talk the number down.
        bus.safeEmit('token:recon', { candidate: { mint: MINT('j') }, report: { liquiditySol: 40, devHoldPct: 2 } });
        assert.strictEqual(row.riskScore, before, 'the worst known signal stays');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('a row with no fresh price ASKS for one instead of waiting to be told', () => {
    // Found by running the real bot: `lastKnown()` never fetches, and nothing else
    // called `get()`, so every row converted at the fallback constant forever — the
    // table would have said `≈` on a machine with a working internet connection.
    solprice.__reset();
    const asked = [];
    solprice.__setFetch(async (url) => {
      asked.push(url);
      return { ok: true, json: async () => ({ solana: { usd: 210 } }) };
    });
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', launch({ mint: MINT('g') }));
        const row = feed.rows.get(MINT('g'));
        // Synchronously the row is still priced at the fallback — a row must never
        // block on a price API…
        assert.strictEqual(row.solUsdSource, 'fallback');
      });
      // …but the request went out, and the next row is priced from the real quote.
      assert.ok(asked.length >= 1, 'the row path must trigger a price fetch, not just read the cache');
      return (async () => {
        await new Promise((r) => setTimeout(r, 25));
        withFeed((feed) => {
          bus.safeEmit('token:detected', launch({ mint: MINT('h') }));
          const row = feed.rows.get(MINT('h'));
          assert.strictEqual(row.solUsd, 210, 'once a provider answers, rows use it');
          assert.strictEqual(row.solUsdSource, 'coingecko', 'and say which provider');
          assert.strictEqual(row.liquidityUsd, Math.round(12.5 * 210), 'with the dollars recomputed');
        });
      })();
    } finally {
      solprice.__reset();
    }
  });

  await test('a row priced with the FALLBACK rate is labelled a fallback, not "none"', () => {
    // Found by running the real thing: with every price provider unreachable the
    // dollars were computed at the constant while the row said `source: 'none'`,
    // so the table would have shown an invented figure with no marker.
    solprice.__reset(); // nothing ever read
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', launch({ mint: MINT('f') }));
        const row = feed.rows.get(MINT('f'));
        assert.strictEqual(row.solUsdSource, 'fallback', 'the provenance must name the fallback');
        assert.strictEqual(row.solUsd, solprice.FALLBACK_USD, 'and report the rate that was used');
        assert.strictEqual(row.liquidityUsd, Math.round(12.5 * solprice.FALLBACK_USD), 'the figure must match that rate');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('a dev who bought NOTHING is 0% dev hold — a fact, not an unknown', () => {
    // Most pump.fun launches carry `initialBuy: 0` when the dev opens with no
    // buy. Treating that as "unknown" would print `unread` on most rows, which
    // would be the same mistake in the other direction.
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', launch({ mint: MINT('e'), initialBuy: 0 }));
        const row = feed.rows.get(MINT('e'));
        assert.strictEqual(row.devHoldPct, 0, 'zero is zero');
        assert.strictEqual(row.facts.devHold, 'opening_buy_event', 'and it still came from the event');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('a launch with NO curve data leaves the cells EMPTY, not zero', () => {
    // The opposite failure from the reported one, and the more dangerous of the
    // two: printing 0% dev hold for a launch nobody could read is a fabricated
    // assurance. Empty is the honest answer, and the table says "unread".
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', { mint: MINT('d'), symbol: 'NODATA', detectedAt: Date.now() });
        const row = feed.rows.get(MINT('d'));
        assert.strictEqual(row.devHoldPct, null, 'dev hold stays unknown');
        assert.strictEqual(row.liquiditySol, null, 'liquidity stays unknown');
        assert.strictEqual(row.liquidityUsd, null, 'and so does its dollar figure');
        assert.strictEqual(row.riskScore, null, 'nothing was scored');
        assert.strictEqual(row.facts.devHold, null, 'with no provenance claimed');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('an on-chain read REFINES the event facts and takes over the provenance', () => {
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', launch());
        bus.safeEmit('token:recon', {
          candidate: { mint: MINT('a') },
          report: { liquiditySol: 20, devHoldPct: 9.5, honeypot: { risk: 40, notes: ['freeze authority live'] } },
        });
        const row = feed.rows.get(MINT('a'));
        assert.strictEqual(row.liquiditySol, 12.5, 'the virtual event figure remains virtual');
        assert.strictEqual(row.virtualLiquidityUsd, 2500);
        assert.strictEqual(row.realLiquiditySol, 20, 'real deposited SOL is separate');
        assert.strictEqual(row.realLiquidityUsd, 4000);
        assert.strictEqual(row.facts.liquidity, 'virtual_event');
        assert.strictEqual(row.facts.realLiquidity, 'real_onchain');
        assert.strictEqual(row.devHoldPct, 3, 'the opening buy must not be overwritten');
        assert.strictEqual(row.currentDevHoldPct, 9.5, 'current on-chain creator hold is separate');
        assert.strictEqual(row.facts.currentDevHold, 'creator_onchain');
        assert.ok(row.riskScore >= 40, 'and the honeypot reading joins the score');
        assert.ok(row.riskNotes.join(' ').includes('freeze'), 'carrying its note with it');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('the worst known signal wins — a clean honeypot does not erase a bad dev', () => {
    solprice.__setPrice(200, 'test');
    try {
      withFeed((feed) => {
        bus.safeEmit('token:detected', launch({ initialBuy: 400_000_000, vSolInBondingCurve: 1.2 }));
        const before = feed.rows.get(MINT('a')).riskScore;
        bus.safeEmit('token:recon', {
          candidate: { mint: MINT('a') },
          report: { honeypot: { risk: 0, notes: [] } },
        });
        const after = feed.rows.get(MINT('a')).riskScore;
        assert.ok(after >= before, 'the score must not drop to 0 because one check came back clean');
      });
    } finally {
      solprice.__reset();
    }
  });

  await test('the SOL price is cached, and a cached read is not a silent guess', async () => {
    solprice.__reset();
    let calls = 0;
    solprice.__setFetch(async () => {
      calls += 1;
      return { ok: true, json: async () => ({ solana: { usd: 175 } }) };
    });
    try {
      const first = await solprice.get();
      const second = await solprice.get();
      assert.strictEqual(first.usd, 175, 'the price comes from the provider');
      assert.strictEqual(first.source, 'coingecko', 'and is labelled with where it came from');
      assert.strictEqual(calls, 1, 'the second call inside the cache window must not hit the network');
      assert.strictEqual(second.stale, false, 'and it is not stale');
    } finally {
      solprice.__reset();
    }
  });

  await test('with every provider down, the fallback is MARKED, not passed off as a quote', async () => {
    solprice.__reset();
    solprice.__setFetch(async () => { throw new Error('offline'); });
    try {
      const out = await solprice.get({ force: true });
      assert.strictEqual(out.ok, false, 'a failed read must not report success');
      assert.strictEqual(out.source, 'fallback', 'it must say the figure is a fallback');
      assert.strictEqual(out.usd, solprice.FALLBACK_USD, 'and give the constant the reference bot uses');
      assert.ok(out.error, 'with the reason it fell back');
    } finally {
      solprice.__reset();
    }
  });

  await test('a real price that has gone stale keeps its real value and says it is stale', async () => {
    solprice.__reset();
    solprice.__setFetch(async () => ({ ok: true, json: async () => ({ solana: { usd: 300 } }) }));
    try {
      await solprice.get();
      // Reach past the TTL by pinning the clock rather than waiting 20 seconds.
      const realNow = Date.now;
      Date.now = () => realNow() + solprice.TTL_MS + 1;
      const later = solprice.lastKnown();
      Date.now = realNow;
      assert.strictEqual(later.usd, 300, 'a stale REAL price is still worth more than a made-up one');
      assert.strictEqual(later.stale, true, 'as long as it is marked stale');
      assert.strictEqual(later.source, 'coingecko', 'and keeps its provenance');
    } finally {
      solprice.__reset();
    }
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
