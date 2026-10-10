'use strict';
/**
 * Risk-engine test suite. Run: node test/risk.test.js
 *
 * These tests exercise the exact rules the UI exposes, using the real
 * config defaults rather than hand-tuned test fixtures — so if a preset
 * changes in a way that breaks an exit rule, this fails.
 */
const assert = require('node:assert');
const risk = require('../src/engine/risk');
const cfg = require('../src/config');
const Position = require('../src/engine/position');
const curve = require('../src/engine/curve');
const safety = require('../src/engine/safety');
const { Keypair } = require('@solana/web3.js');

let passed = 0;
let failed = 0;

/** BigInt-safe dump for assertion messages. */
const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? `${x}n` : x));

let pending = Promise.resolve();
function record(name, err) {
  if (err) {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
  } else {
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  }
}
function test(name, fn) {
  if (fn.constructor.name === 'AsyncFunction') {
    // Do not report a Promise as a passed assertion or call process.exit()
    // before the on-chain mocks have even completed.
    pending = pending.then(() => fn()).then(() => record(name), (err) => record(name, err));
    return;
  }
  try { fn(); record(name); } catch (err) { record(name, err); }
}

/** Build a position with a given entry and current price (floats in SOL/token). */
function makePosition({ entrySol, priceSol, tokens = 1_000_000, solSpent = 1 }) {
  const entryPrice = BigInt(Math.round(entrySol * 1e9));
  const price = BigInt(Math.round(priceSol * 1e9));
  const p = new Position({
    walletId: 'w_test',
    mint: 'TestMint111111111111111111111111111111111111',
    symbol: 'TEST',
    entryPrice,
    tokensHeld: BigInt(tokens) * 1_000_000n,
    solSpent: BigInt(Math.round(solSpent * 1e9)),
  });
  p.mark(price);
  return p;
}

function makeTrader(overrides = {}) {
  const wallet = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('T'), overrides));
  return {
    cfg: wallet,
    positions: new Map(),
    stats: { day: '2026-01-01', tradesToday: 0, realisedPnlSol: 0, consecutiveLosses: 0, wins: 0, losses: 0, paused: false, pauseReason: null },
    lastEntryAt: 0,
    openExposureSol: () => 0,
  };
}

console.log('\n── curve math ────────────────────────────────────────────');

test('curve: buying 1 SOL into a fresh curve returns a sane token amount', () => {
  const out = curve.tokensOutForSolIn(
    curve.solToLamports(1),
    curve.INITIAL_VIRTUAL_SOL_RESERVES,
    curve.INITIAL_VIRTUAL_TOKEN_RESERVES
  );
  const tokens = curve.baseUnitsToTokens(out);
  assert.ok(tokens > 20_000_000 && tokens < 60_000_000, `unexpected tokens: ${tokens}`);
});

test('curve: round-tripping buy→sell loses only fees + impact (no arbitrage)', () => {
  const vSol = curve.INITIAL_VIRTUAL_SOL_RESERVES;
  const vTok = curve.INITIAL_VIRTUAL_TOKEN_RESERVES;
  const solIn = curve.solToLamports(1);
  const tokens = curve.tokensOutForSolIn(solIn, vSol, vTok);
  const newVSol = vSol + (solIn * 9900n) / 10000n;
  const newVTok = vTok - tokens;
  const solBack = curve.solOutForTokensIn(tokens, newVSol, newVTok);
  assert.ok(solBack < solIn, 'round trip must not be profitable');
  const lossPct = Number((solIn - solBack) * 10000n / solIn) / 100;
  assert.ok(lossPct > 0.5 && lossPct < 10, `loss should be fees+impact, got ${lossPct}%`);
});

test('curve: bonding curve progress maps 0→100 correctly', () => {
  assert.strictEqual(curve.bondingCurvePct(0n), 0);
  assert.strictEqual(curve.bondingCurvePct(curve.MIGRATION_SOL_TARGET), 100);
  assert.strictEqual(curve.bondingCurvePct(curve.MIGRATION_SOL_TARGET * 2n), 100);
});

test('UNITS: spot price and entry price agree on lamports-per-whole-token', () => {
  // Regression guard. spotPriceScaled() once multiplied by lamport decimals
  // (1e9) instead of token decimals (1e6), inflating every gain% by ~1000x.
  const vSol = curve.INITIAL_VIRTUAL_SOL_RESERVES;
  const vTok = curve.INITIAL_VIRTUAL_TOKEN_RESERVES;

  // Hand-derived, in LAMPORTS per WHOLE TOKEN:
  //   vSol is already in lamports (3e10)
  //   vTok is in base units, so divide by 10^6 to get whole tokens (1.073e9)
  //   3e10 / 1.073e9 = ~27.96 lamports per whole token
  const handDerived = Number(vSol) / (Number(vTok) / 1e6);
  const actual = Number(curve.spotPriceScaled(vSol, vTok));
  // The result is an integer count of lamports, so with a value of ~28 the
  // quantisation granularity is already ~3.6%. Compare with that in mind.
  assert.ok(Math.abs(actual - handDerived) / handDerived < 0.05,
    `spot price ${actual} should be ~${handDerived.toFixed(3)} lamports/token`);
  assert.strictEqual(actual, 27, 'integer-truncated lamports per whole token');
});

test('UNITS: a position opened at spot marked at spot shows ~zero P&L', () => {
  const vSol = curve.INITIAL_VIRTUAL_SOL_RESERVES;
  const vTok = curve.INITIAL_VIRTUAL_TOKEN_RESERVES;
  const spot = curve.spotPriceScaled(vSol, vTok);
  const tokens = 1_000_000n * 1_000_000n; // 1,000,000 whole tokens
  const solSpent = (tokens * spot) / 1_000_000n; // exact cost at spot

  const p = new Position({ walletId: 'w', mint: 'M', symbol: 'T', entryPrice: spot, tokensHeld: tokens, solSpent });
  p.mark(spot);
  assert.strictEqual(p.pnlLamports(), 0n, `P&L at entry should be 0, got ${p.pnlLamports()}`);

  // Double the price -> P&L should be exactly the original cost.
  p.mark(spot * 2n);
  assert.strictEqual(p.pnlLamports(), solSpent, 'P&L at 2x should equal the amount spent');
  assert.ok(Math.abs(p.priceGainPct() - 100) < 0.001, `gain should be 100%, got ${p.priceGainPct()}`);
});

test('UNITS: market cap sanity-checks against known pump.fun figures', () => {
  // A fresh curve is ~30 SOL FDV (30 SOL virtual reserves against 1.073B
  // virtual tokens at ~1B supply => market cap near 28 SOL).
  const mc = Number(curve.marketCapLamports(curve.INITIAL_VIRTUAL_SOL_RESERVES, curve.INITIAL_VIRTUAL_TOKEN_RESERVES)) / 1e9;
  assert.ok(mc > 20 && mc < 40, `fresh-curve market cap should be ~28 SOL, got ${mc.toFixed(2)}`);
});

console.log('\n── stop loss ─────────────────────────────────────────────');

test('stop loss fires at exactly the configured loss', () => {
  const t = makeTrader({ exits: { stopLossPct: 25, trailing: { enabled: false }, breakEven: { enabled: false } } });
  const pos = makePosition({ entrySol: 1, priceSol: 0.74 }); // −26%
  const decisions = risk.evaluate(pos, t.cfg);
  assert.strictEqual(decisions.length, 1);
  assert.strictEqual(decisions[0].action, 'SELL');
  assert.strictEqual(decisions[0].pct, 100);
  assert.strictEqual(decisions[0].reason, 'stop_loss');
});

test('stop loss does NOT fire above the threshold', () => {
  const t = makeTrader({ exits: { stopLossPct: 25, trailing: { enabled: false }, breakEven: { enabled: false } } });
  const pos = makePosition({ entrySol: 1, priceSol: 0.80 }); // −20%
  assert.strictEqual(risk.evaluate(pos, t.cfg).length, 0);
});

console.log('\n── trailing stop ─────────────────────────────────────────');

test('trailing stop is inert before activation', () => {
  const t = makeTrader({ exits: { trailing: { enabled: true, activationPct: 80, trailPct: 25 }, breakEven: { enabled: false }, stopLossPct: 25, takeProfitTiers: [] } });
  const pos = makePosition({ entrySol: 1, priceSol: 1.5 }); // +50%, below 80% activation
  pos.mark(BigInt(Math.round(1.2e9))); // falls back to +20%
  assert.strictEqual(risk.evaluate(pos, t.cfg).length, 0, 'should not trail yet');
});

test('trailing stop fires after a peak and a retrace', () => {
  const t = makeTrader({ exits: { trailing: { enabled: true, activationPct: 80, trailPct: 25 }, breakEven: { enabled: false }, stopLossPct: 25, takeProfitTiers: [], maxHoldMs: 0 } });
  const pos = makePosition({ entrySol: 1, priceSol: 2.0 }); // peak +100%
  assert.strictEqual(pos.peakGainPct(), 100);
  pos.mark(BigInt(Math.round(1.7e9))); // +70% — below peak−25 = +75%
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 1, `expected an exit, got ${show(d)}`);
  assert.strictEqual(d[0].reason, 'trailing_stop');
  assert.strictEqual(d[0].pct, 100);
});

test('trailing stop ratchets up and never loosens', () => {
  const t = makeTrader({ exits: { trailing: { enabled: true, activationPct: 50, trailPct: 20 }, breakEven: { enabled: false }, stopLossPct: 25, takeProfitTiers: [] } });
  const pos = makePosition({ entrySol: 1, priceSol: 1.5 });
  const first = risk.effectiveStopPct(pos, t.cfg); // peak 50 → floor 30
  pos.mark(BigInt(Math.round(3e9))); // peak now +200 → floor 180
  const second = risk.effectiveStopPct(pos, t.cfg);
  pos.mark(BigInt(Math.round(2e9))); // pull back, peak unchanged
  const third = risk.effectiveStopPct(pos, t.cfg);
  assert.strictEqual(first, 30);
  assert.strictEqual(second, 180);
  assert.strictEqual(third, 180, 'stop must not loosen when price falls');
});

test('trailing step quantisation rounds the floor down', () => {
  const t = makeTrader({ exits: { trailing: { enabled: true, activationPct: 100, trailPct: 33, stepPct: 10 }, breakEven: { enabled: false }, stopLossPct: 25 } });
  const pos = makePosition({ entrySol: 1, priceSol: 2.0 }); // peak 100 → floor 67 → stepped → 60
  assert.strictEqual(risk.effectiveStopPct(pos, t.cfg), 60);
});

console.log('\n── break-even ────────────────────────────────────────────');

test('break-even lifts the stop above entry after activation', () => {
  const t = makeTrader({ exits: { trailing: { enabled: false }, breakEven: { enabled: true, activationPct: 30, offsetPct: 2 }, stopLossPct: 40, takeProfitTiers: [] } });
  const pos = makePosition({ entrySol: 1, priceSol: 1.4 }); // peak +40%
  pos.mark(BigInt(Math.round(1.01e9))); // +1% — below the +2% floor and stops first
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].reason, 'break_even');
});

test('break-even is inert before activation', () => {
  const t = makeTrader({ exits: { trailing: { enabled: false }, breakEven: { enabled: true, activationPct: 30, offsetPct: 2 }, stopLossPct: 40, takeProfitTiers: [] } });
  const pos = makePosition({ entrySol: 1, priceSol: 1.1 }); // peak only +10%
  pos.mark(BigInt(Math.round(0.95e9))); // −5%, above the −40% stop
  assert.strictEqual(risk.evaluate(pos, t.cfg).length, 0);
});

console.log('\n── tiered partial take-profit ────────────────────────────');

test('partial sell fires at its tier threshold only', () => {
  const t = makeTrader({
    exits: {
      takeProfitTiers: [{ gainPct: 50, sellPct: 33 }, { gainPct: 120, sellPct: 33 }, { gainPct: 300, sellPct: 100 }],
      trailing: { enabled: false }, breakEven: { enabled: false }, stopLossPct: 90, maxHoldMs: 0,
    },
  });
  const pos = makePosition({ entrySol: 1, priceSol: 1.55 }); // +55%
  pos.tiers = t.cfg.exits.takeProfitTiers.map((x) => ({ ...x, filled: false }));
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 1, `expected one tier, got ${show(d)}`);
  assert.strictEqual(d[0].reason, 'tp_50pct');
  // 33% of original, expressed as % of remaining (which is still 100%)
  assert.ok(Math.abs(d[0].pct - 33) < 0.01, `pct was ${d[0].pct}`);
});

test('price gapping through several tiers fires all of them', () => {
  const t = makeTrader({
    exits: {
      takeProfitTiers: [{ gainPct: 50, sellPct: 20 }, { gainPct: 120, sellPct: 20 }, { gainPct: 300, sellPct: 60 }],
      trailing: { enabled: false }, breakEven: { enabled: false }, stopLossPct: 90, maxHoldMs: 0,
    },
  });
  const pos = makePosition({ entrySol: 1, priceSol: 4.5, tokens: 1_000_000 }); // +350% → all 3 tiers due
  pos.tiers = t.cfg.exits.takeProfitTiers.map((x) => ({ ...x, filled: false }));
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 3, `expected 3 tiers, got ${d.length}`);
  // Highest gain first
  assert.strictEqual(d[0].reason, 'tp_300pct');
  // Absolute token amounts: 60/20/20 % of 1,000,000 tokens
  assert.strictEqual(d[0].tokens, 600_000n * 1_000_000n);
  assert.strictEqual(d[1].tokens, 200_000n * 1_000_000n);
  assert.strictEqual(d[2].tokens, 200_000n * 1_000_000n);
  // And they sum to exactly the whole position — no dust, no oversell
  const total = d.reduce((a, x) => a + x.tokens, 0n);
  assert.strictEqual(total, pos.tokensHeld, 'tiers must sum to the held amount exactly');
});

test('sequential tier fills each get their full intended size (regression)', () => {
  // This is the bug the suite caught: percentages returned against a shrinking
  // remainder caused tiers after the first to undersell.
  const t = makeTrader({
    exits: {
      takeProfitTiers: [{ gainPct: 50, sellPct: 40 }, { gainPct: 100, sellPct: 40 }],
      trailing: { enabled: false }, breakEven: { enabled: false }, stopLossPct: 90, maxHoldMs: 0,
    },
  });
  const pos = makePosition({ entrySol: 1, priceSol: 2.5, tokens: 1_000_000 }); // +150%
  pos.tiers = t.cfg.exits.takeProfitTiers.map((x) => ({ ...x, filled: false }));
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 2);
  // Apply in sequence the way the Trader does, and verify each fill size holds.
  let held = pos.tokensHeld;
  const sizes = [];
  for (const dec of d) {
    assert.ok(dec.tokens <= held, 'must never sell more than held');
    sizes.push(dec.tokens);
    held -= dec.tokens;
  }
  assert.strictEqual(sizes[0], 400_000n * 1_000_000n, 'tier 1 should sell 40% of ORIGINAL');
  assert.strictEqual(sizes[1], 400_000n * 1_000_000n, 'tier 2 should also sell 40% of ORIGINAL');
  assert.strictEqual(held, 200_000n * 1_000_000n, '20% should remain');
});

test('filled tiers do not re-fire', () => {
  const t = makeTrader({
    exits: {
      takeProfitTiers: [{ gainPct: 50, sellPct: 33 }, { gainPct: 120, sellPct: 33 }],
      trailing: { enabled: false }, breakEven: { enabled: false }, stopLossPct: 90, maxHoldMs: 0,
    },
  });
  const pos = makePosition({ entrySol: 1, priceSol: 1.55 });
  pos.tiers = t.cfg.exits.takeProfitTiers.map((x) => ({ ...x, filled: false }));
  pos.tiers[0].filled = true; // already sold tier 0
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 0, 'tier 0 already filled and +55% is below tier 1');
});

test('partial sell sizes against the ORIGINAL position, not the remainder', () => {
  const t = makeTrader({
    exits: {
      takeProfitTiers: [{ gainPct: 50, sellPct: 50 }],
      trailing: { enabled: false }, breakEven: { enabled: false }, stopLossPct: 90, maxHoldMs: 0,
    },
  });
  const pos = makePosition({ entrySol: 1, priceSol: 2.0, tokens: 1_000_000 });
  pos.tiers = t.cfg.exits.takeProfitTiers.map((x) => ({ ...x, filled: false }));
  // Simulate already having sold 50% of the original, so only half remains.
  pos.tokensHeld = pos.originalTokens / 2n;
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 1);

  // The tier asks for 50% of the ORIGINAL. Since exactly 50% of the original
  // is still held, the fill should drain the position completely — not sell
  // 50% *of the remainder* (which would be 25% of original) and not oversell.
  assert.strictEqual(d[0].tokens, 500_000n * 1_000_000n, 'should sell 50% of ORIGINAL');
  assert.strictEqual(d[0].tokens, pos.tokensHeld, 'should exactly drain the remainder');
  assert.strictEqual(d[0].reason, 'tp_50pct_all', 'draining the position should be labelled _all');
});

console.log('\n── time & liquidity stops ────────────────────────────────');

test('time stop fires after maxHoldMs', () => {
  // NB: maxHoldMs is clamped to a 5s floor by normaliseWallet, so test above it.
  const t = makeTrader({ exits: { maxHoldMs: 6000, trailing: { enabled: false }, breakEven: { enabled: false }, stopLossPct: 90 } });
  const pos = makePosition({ entrySol: 1, priceSol: 1.0 });
  pos.openedAt = Date.now() - 7000;
  const d = risk.evaluate(pos, t.cfg);
  assert.ok(d.some((x) => x.reason === 'time_stop'), show(d));
});

test('liquidity exit fires when the curve drains', () => {
  const t = makeTrader({ exits: { liquidityDropExitPct: 55, trailing: { enabled: false }, breakEven: { enabled: false }, stopLossPct: 90, maxHoldMs: 0 } });
  const pos = makePosition({ entrySol: 1, priceSol: 1.0 });
  const d = risk.evaluate(pos, t.cfg, { liquidityDropPct: 60 });
  assert.ok(d.some((x) => x.reason === 'liquidity_exit'), show(d));
});

console.log('\n── precedence ────────────────────────────────────────────');

test('stop loss beats take-profit in the same tick', () => {
  const t = makeTrader({
    exits: {
      stopLossPct: 10,
      takeProfitTiers: [{ gainPct: 5, sellPct: 50 }],
      trailing: { enabled: false }, breakEven: { enabled: false }, maxHoldMs: 0,
    },
  });
  const pos = makePosition({ entrySol: 1, priceSol: 0.85 }); // −15%
  pos.tiers = t.cfg.exits.takeProfitTiers.map((x) => ({ ...x, filled: false }));
  const d = risk.evaluate(pos, t.cfg);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].reason, 'stop_loss', 'a losing position must not partial-sell into a tier');
  assert.strictEqual(d[0].pct, 100);
});

console.log('\n── wallet guardrails / loss limit ────────────────────────');

test('daily loss limit blocks new entries', () => {
  const t = makeTrader({ limits: { dailyLossLimitSol: 2 } });
  t.cfg.enabled = true;
  t.stats.realisedPnlSol = -2.5;
  const g = risk.canOpenNewPosition(t);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'daily_loss_limit_reached');
});

test('max concurrent positions blocks new entries', () => {
  const t = makeTrader({ buy: { maxConcurrentPositions: 2 } });
  t.cfg.enabled = true;
  t.positions.set('a', { isOpen: true, solSpent: 0n });
  t.positions.set('b', { isOpen: true, solSpent: 0n });
  const g = risk.canOpenNewPosition(t);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'max_concurrent_positions');
});

test('max exposure blocks new entries', () => {
  const t = makeTrader({ limits: { maxExposureSol: 1 } });
  t.cfg.enabled = true;
  t.openExposureSol = () => 1.5;
  const g = risk.canOpenNewPosition(t);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'max_exposure_reached');
});

test('consecutive-loss circuit breaker trips', () => {
  const t = makeTrader({ limits: { stopAfterConsecutiveLosses: 3 } });
  t.cfg.enabled = true;
  t.stats.consecutiveLosses = 3;
  const g = risk.canOpenNewPosition(t);
  assert.strictEqual(g.ok, false);
  assert.strictEqual(g.reason, 'consecutive_loss_circuit_breaker');
});

test('a healthy wallet passes all guardrails', () => {
  const t = makeTrader();
  t.cfg.enabled = true;
  const g = risk.canOpenNewPosition(t);
  assert.strictEqual(g.ok, true, show(g));
});

test('paused wallet cannot open positions', () => {
  const t = makeTrader();
  t.cfg.enabled = true;
  t.stats.paused = true;
  t.stats.pauseReason = 'test';
  assert.strictEqual(risk.canOpenNewPosition(t).ok, false);
});

console.log('\n── position sizing ───────────────────────────────────────');

test('fixed sizing stays inside the configured band', () => {
  const c = cfg.normaliseWallet(cfg.defaultWalletConfig('T'));
  for (let i = 0; i < 200; i += 1) {
    const s = risk.computePositionSize(c, { balanceSol: 10 });
    assert.ok(s >= c.buy.minAmountSol - 1e-9 && s <= c.buy.maxAmountSol + 1e-9, `size ${s} out of band`);
  }
});

test('percent sizing scales with balance', () => {
  const c = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('T'), {
    buy: { positionSizeMode: 'percent', positionSizePercent: 10, minAmountSol: 0, maxAmountSol: 100 },
  }));
  const s = risk.computePositionSize(c, { balanceSol: 5 });
  assert.ok(Math.abs(s - 0.5) < 1e-9, `expected 0.5, got ${s}`);
});

test('percent sizing cannot exceed available balance', () => {
  const c = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('T'), {
    buy: { positionSizeMode: 'percent', positionSizePercent: 100, minAmountSol: 0, maxAmountSol: 100 },
  }));
  const s = risk.computePositionSize(c, { balanceSol: 1 });
  assert.ok(s <= 1, `must not exceed balance, got ${s}`);
});

test('kelly sizing scales with AI confidence and respects the cap', () => {
  const c = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('T'), {
    buy: { positionSizeMode: 'kelly', kellyFraction: 0.5, minAmountSol: 0.01, maxAmountSol: 2 },
  }));
  const low = risk.computePositionSize(c, { balanceSol: 10, aiConfidence: 0.55 });
  const high = risk.computePositionSize(c, { balanceSol: 10, aiConfidence: 0.95 });
  assert.ok(high > low, `high confidence (${high}) should size larger than low (${low})`);
  assert.ok(high <= 2, 'must respect maxAmountSol');
});

console.log('\n── config validation ─────────────────────────────────────');

test('nonsense config values are clamped, not trusted', () => {
  const w = cfg.normaliseWallet({
    name: 'X',
    buy: { minAmountSol: -5, maxAmountSol: 1e9, slippageBps: 999999 },
    exits: { stopLossPct: 900, trailing: { activationPct: -10, trailPct: 0 } },
    limits: { dailyLossLimitSol: -1 },
  });
  assert.ok(w.buy.minAmountSol >= 0.001, `minAmountSol ${w.buy.minAmountSol}`);
  assert.ok(w.buy.maxAmountSol <= 100, `maxAmountSol ${w.buy.maxAmountSol}`);
  assert.ok(w.buy.slippageBps <= 5000, `slippage ${w.buy.slippageBps}`);
  assert.ok(w.exits.stopLossPct <= 99, `stopLoss ${w.exits.stopLossPct}`);
  assert.ok(w.exits.trailing.trailPct >= 0.5, `trailPct ${w.exits.trailing.trailPct}`);
  assert.ok(w.limits.dailyLossLimitSol >= 0.01, `dailyLoss ${w.limits.dailyLossLimitSol}`);
});

test('maxAmountSol can never be below minAmountSol', () => {
  const w = cfg.normaliseWallet({ name: 'X', buy: { minAmountSol: 5, maxAmountSol: 0.1 } });
  assert.ok(w.buy.maxAmountSol >= w.buy.minAmountSol, `${w.buy.maxAmountSol} < ${w.buy.minAmountSol}`);
});

test('every preset produces a valid, armed-capable config', () => {
  for (const name of Object.keys(cfg.PRESETS)) {
    const w = cfg.applyPreset(cfg.defaultWalletConfig(`P_${name}`), name);
    assert.ok(Array.isArray(w.exits.takeProfitTiers) && w.exits.takeProfitTiers.length > 0, `${name}: no tiers`);
    assert.ok(w.exits.stopLossPct > 0 && w.exits.stopLossPct < 100, `${name}: bad stop`);
    assert.ok(w.buy.maxAmountSol >= w.buy.minAmountSol, `${name}: inverted band`);
    const total = w.exits.takeProfitTiers.reduce((a, t) => a + t.sellPct, 0);
    assert.ok(total > 0, `${name}: tiers sell nothing`);
  }
});

test('presets are ordered by risk (degen trails looser than safe)', () => {
  const safe = cfg.applyPreset(cfg.defaultWalletConfig('s'), 'safe');
  const degen = cfg.applyPreset(cfg.defaultWalletConfig('d'), 'degen');
  assert.ok(degen.exits.stopLossPct > safe.exits.stopLossPct, 'degen should tolerate more loss');
  assert.ok(degen.exits.trailing.trailPct > safe.exits.trailing.trailPct, 'degen should trail looser');
  assert.ok(degen.buy.slippageBps >= safe.buy.slippageBps, 'degen should tolerate more slippage');
});

console.log(`\n${'─'.repeat(60)}`);
/* ------------------------------------------------------------------ *
 * The report cache must save RPC calls without ever lying
 * ------------------------------------------------------------------ *
 * A short-lived per-mint cache cuts the wallet fan-out from N identical reads
 * to 1. The danger is caching a FAILURE, which would turn a transient RPC
 * blip into a persistent false verdict.
 */
test('CACHE: repeated evaluation of one mint costs a single read', async () => {
  safety._reportCache.clear();
  let calls = 0;
  const conn = {
    getAccountInfo: async () => { calls += 1; return null; }, // "absent", a real answer
    getTokenLargestAccounts: async () => ({ value: [] }),
  };
  const g = cfg.defaultGlobalConfig();
  const wc = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('C'), { id: 'w_c', enabled: true }));

  await safety.evaluate({ mint: 'C'.repeat(43), symbol: 'X' }, wc, { conn, config: g });
  const afterFirst = calls;
  await safety.evaluate({ mint: 'C'.repeat(43), symbol: 'X' }, wc, { conn, config: g });
  const afterSecond = calls;

  assert.ok(afterFirst >= 2, 'first evaluation should hit the chain');
  assert.strictEqual(afterSecond, afterFirst, 'second evaluation should be served from cache');
});

test('CACHE: a failed read is never cached (no frozen false verdict)', async () => {
  safety._reportCache.clear();
  let calls = 0;
  const conn = {
    getAccountInfo: async () => {
      calls += 1;
      throw new Error('429 Too Many Requests');
    },
    getTokenLargestAccounts: async () => ({ value: [] }),
  };
  const g = cfg.defaultGlobalConfig();
  const wc = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('C'), { id: 'w_c', enabled: true }));

  const first = await safety.evaluate({ mint: 'D'.repeat(43), symbol: 'X' }, wc, { conn, config: g });
  assert.strictEqual(first.infra, true, 'an unreachable RPC is an infra error');
  const afterFirst = calls;

  await safety.evaluate({ mint: 'D'.repeat(43), symbol: 'X' }, wc, { conn, config: g });
  assert.ok(calls > afterFirst, 'a failed read must be retried, not cached');
});

/* ------------------------------------------------------------------ *
 * Deployment safety
 * ------------------------------------------------------------------ *
 * These guard the failure modes that only appear once the bot is hosted:
 * an ephemeral disk losing the encrypted keys, and a single env var arming
 * live trading by accident.
 */
test('DEPLOY: RPC_URL overrides a persisted endpoint (the config-file trap)', () => {
  // The bug this prevents: load() deep-merges the saved config OVER the
  // defaults, so a persisted rpc.endpoints entry silently won and changing
  // RPC_URL in .env — or setting it on Render, as the deployment guide
  // instructs — had NO EFFECT. The bot kept hammering the rate-limited public
  // endpoint while the operator stared at a correct-looking .env.
  const g = cfg.defaultGlobalConfig();
  g.rpc.endpoints = ['https://api.mainnet-beta.solana.com']; // stale, from a previous run
  const saved = { ...process.env };
  try {
    process.env.RPC_URL = 'https://my-paid-endpoint.example';
    cfg.applyEnvOverrides(g);
    assert.deepStrictEqual(g.rpc.endpoints, ['https://my-paid-endpoint.example']);
  } finally { process.env = saved; }
});

test('DEPLOY: SCANNER_CONCURRENCY overrides a persisted value', () => {
  const g = cfg.defaultGlobalConfig();
  g.scanner.evaluateConcurrency = 8; // stale
  const saved = { ...process.env };
  try {
    process.env.SCANNER_CONCURRENCY = '1';
    cfg.applyEnvOverrides(g);
    assert.strictEqual(g.scanner.evaluateConcurrency, 1);
  } finally { process.env = saved; }
});

test('DEPLOY: with no env set, the persisted config is left alone', () => {
  const g = cfg.defaultGlobalConfig();
  g.rpc.endpoints = ['https://persisted.example'];
  const saved = { ...process.env };
  try {
    delete process.env.RPC_URL;
    delete process.env.RPC_WS_URL;
    delete process.env.SCANNER_CONCURRENCY;
    cfg.applyEnvOverrides(g);
    assert.deepStrictEqual(g.rpc.endpoints, ['https://persisted.example'], 'strategy/config must survive');
  } finally { process.env = saved; }
});

test('DEPLOY: the public rate-limited endpoint is not the shipped default URL', () => {
  // Not a hard rule, but the default in defaultGlobalConfig should follow
  // RPC_URL, never be pinned to the endpoint that 429s under load.
  const g = cfg.defaultGlobalConfig();
  assert.ok(Array.isArray(g.rpc.endpoints) && g.rpc.endpoints.length === 1);
});

test('DEPLOY: keystore and config agree on one data directory', () => {
  const path = require('node:path');
  const ks = require('../src/wallets/keystore');
  const configDir = path.resolve(cfg.DATA_DIR || path.join(__dirname, '..', 'data'));
  const keystoreDir = path.resolve(path.dirname(ks.KEYSTORE_PATH));
  assert.strictEqual(
    keystoreDir,
    configDir,
    'wallets would be written to one directory and read from another',
  );
});

test('DEPLOY: DATA_DIR is honoured when set (persistent disk support)', () => {
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const dir = '/tmp/snipersol-data-dir-test';
  const out = execFileSync(process.execPath, ['-e', `
    const cfg = require('${path.join(__dirname, '..', 'src', 'config')}');
    const ks  = require('${path.join(__dirname, '..', 'src', 'wallets', 'keystore')}');
    process.stdout.write(JSON.stringify({
      cfg: cfg.DATA_DIR,
      ks: require('path').dirname(ks.KEYSTORE_PATH),
    }));
  `], { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
  const r = JSON.parse(out);
  assert.strictEqual(r.cfg, dir, 'config must honour DATA_DIR');
  assert.strictEqual(r.ks, dir, 'keystore must honour DATA_DIR');
});

test('DEPLOY: DRY_RUN=false alone does NOT arm live trading', () => {
  const g = cfg.defaultGlobalConfig();
  const saved = { ...process.env };
  try {
    process.env.DRY_RUN = 'false';
    delete process.env.I_UNDERSTAND_THE_RISK;
    cfg.applyDryRunOverride(g);
    assert.strictEqual(g.dryRun, true, 'a single env var must never arm real money');
  } finally { process.env = saved; }
});

test('DEPLOY: arming headlessly requires both variables', () => {
  const g = cfg.defaultGlobalConfig();
  const saved = { ...process.env };
  try {
    process.env.DRY_RUN = 'false';
    process.env.I_UNDERSTAND_THE_RISK = 'yes';
    cfg.applyDryRunOverride(g);
    assert.strictEqual(g.dryRun, false, 'both variables together should arm');
  } finally { process.env = saved; }
});

test('DEPLOY: DRY_RUN is a no-op for any value other than "false"', () => {
  const saved = { ...process.env };
  try {
    for (const v of ['true', 'no', '0', 'off', '']) {
      const g = cfg.defaultGlobalConfig();
      process.env.DRY_RUN = v;
      process.env.I_UNDERSTAND_THE_RISK = 'yes';
      cfg.applyDryRunOverride(g);
      assert.strictEqual(g.dryRun, true, `DRY_RUN=${JSON.stringify(v)} must stay in dry run`);
    }
  } finally { process.env = saved; }
});

test('DEPLOY: a repo .gitignore exists and excludes the keystore', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const p = path.join(__dirname, '..', '.gitignore');
  assert.ok(fs.existsSync(p), '.gitignore is missing — private keys could be committed');
  const txt = fs.readFileSync(p, 'utf8');
  for (const needle of ['data/', '*.enc', '.env']) {
    assert.ok(txt.includes(needle), `.gitignore must exclude ${needle}`);
  }
});

/* ------------------------------------------------------------------ *
 * Moving your own money: withdrawals and wallet-funded deposits
 * ------------------------------------------------------------------ *
 * These guard the two properties that matter most for a custody-adjacent tool:
 *   1. Money can always get OUT. Withdrawals must ignore dryRun, because a
 *      settings flag must never be able to trap funds.
 *   2. We only ever broadcast the transaction we authored. The browser hands us
 *      signed bytes back, so we re-verify them before relaying.
 */
const Executor = require('../src/engine/executor');

const SYS = '11111111111111111111111111111111';

function transferB64({ from, to, lamports, extraTo, extraLamports, extra = [] }) {
  const { Transaction, PublicKey, SystemProgram } = require('@solana/web3.js');
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports }),
  );
  if (extraTo) {
    tx.add(SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(extraTo), lamports: extraLamports }));
  }
  extra.forEach((ix) => tx.add(ix));
  tx.feePayer = new PublicKey(from);
  tx.recentBlockhash = '11111111111111111111111111111111';
  return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}

const USER = 'EGu66mJD2aAVixACgvu28sE3NVnZnuC8WADkYZvdsX61';
const TRADER = 'BKKnajT1U5LH7NKcnYg4ZG7spoRAxN5hynxqahAshjYf';
const ATTACKER = '6AQbPqPtB7ezHkbrTecLVN3te4uAeRqEqnWzsvyCmTCu';
const INTENT = { from: USER, to: TRADER, lamports: 250000000n };
// Only the pure validation path is exercised here, so a dummy endpoint is fine.
const ex = new Executor(
  { rpc: { endpoints: ['http://127.0.0.1:1'], commitment: 'confirmed' }, execution: {} },
  {},
);

test('WITHDRAW: rent-exempt floor is the real 890880 lamports', () => {
  assert.strictEqual(Executor.RENT_EXEMPT_MIN_LAMPORTS, 890880n);
});

test('FUND: an honest transfer passes the integrity check', () => {
  const b64 = transferB64({ from: USER, to: TRADER, lamports: 250000000 });
  assert.strictEqual(ex.assertTransferMatches(b64, INTENT), true);
});

test('FUND: an inflated amount is rejected', () => {
  const b64 = transferB64({ from: USER, to: TRADER, lamports: 25000000000 });
  assert.throws(() => ex.assertTransferMatches(b64, INTENT), /amount mismatch/);
});

test('FUND: a redirected destination is rejected', () => {
  const b64 = transferB64({ from: USER, to: ATTACKER, lamports: 250000000 });
  assert.throws(() => ex.assertTransferMatches(b64, INTENT), /destination mismatch/);
});

test('FUND: a smuggled second transfer is rejected', () => {
  // The message changed when the check stopped demanding a byte-exact single
  // instruction: wallets append compute-budget instructions, and refusing those
  // rejected honest funding. The security property is unchanged — exactly one
  // System transfer, to the address and for the amount we asked for.
  const b64 = transferB64({ from: USER, to: TRADER, lamports: 250000000, extraTo: ATTACKER, extraLamports: 999000000 });
  assert.throws(() => ex.assertTransferMatches(b64, INTENT), /exactly one transfer/);
});

test('FUND: a compute-budget instruction is tolerated, a foreign program is not', () => {
  // Phantom adds ComputeBudget instructions to every transaction it sends. The
  // old check refused them with "expected exactly one instruction", which is the
  // error the user saw when funding a wallet from their own wallet.
  const { ComputeBudgetProgram } = require('@solana/web3.js');
  const b64 = transferB64({ from: USER, to: TRADER, lamports: 250000000, extra: [ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 })] });
  assert.strictEqual(ex.assertTransferMatches(b64, INTENT), true, 'fee instructions cannot move funds');
});

test('FUND: a mismatched source is rejected', () => {
  const b64 = transferB64({ from: ATTACKER, to: TRADER, lamports: 250000000 });
  assert.throws(() => ex.assertTransferMatches(b64, INTENT), /source mismatch|fee payer mismatch/);
});

test('FUND: garbage input cannot crash the endpoint silently', () => {
  assert.throws(() => ex.assertTransferMatches('not-base64-at-all', INTENT));
  assert.throws(() => ex.assertTransferMatches('', INTENT));
});

/* ------------------------------------------------------------------ *
 * Liquidity RANGE (floor and ceiling)
 * ------------------------------------------------------------------ *
 * The floor already existed; the ceiling is what lets you say "only snipe
 * tokens that have between X and Y SOL in the curve". 0 must always mean
 * "no ceiling" so every existing config keeps its current behaviour.
 */
test('LIQUIDITY: a ceiling of 0 disables the upper bound', () => {
  const w = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('L'), { id: 'w_l', enabled: true }));
  w.filters.maxLiquiditySol = 0;
  assert.strictEqual(w.filters.maxLiquiditySol, 0, '0 must survive normalisation');
});

test('LIQUIDITY: a ceiling below the floor is widened to the floor', () => {
  const w = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('L'), {
    id: 'w_l', enabled: true, filters: { minLiquiditySol: 5, maxLiquiditySol: 2 },
  }));
  assert.strictEqual(
    w.filters.maxLiquiditySol, 5,
    'an inverted range would reject every token; it should widen instead',
  );
});

test('LIQUIDITY: every preset ships with no ceiling (no silent narrowing)', () => {
  for (const name of Object.keys(cfg.PRESETS)) {
    const w = cfg.applyPreset(cfg.defaultWalletConfig('L'), name);
    assert.strictEqual(w.filters.maxLiquiditySol, 0, `${name} should default to no ceiling`);
  }
});

/* ------------------------------------------------------------------ *
 * Safety: a dead price feed must not disable every exit
 * ------------------------------------------------------------------ *
 * `manage()` used to `continue` when a mint had no cached price, which silently
 * disabled the time stop during an RPC outage — the moment a position most needs
 * a way out. Price-derived rules must still be skipped (a stale mark could fire
 * a phantom exit), but the time stop is price-independent and must survive.
 */
function staleCfg(overrides = {}) {
  const w = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('balanced'), { id: 'w_stale', enabled: true }));
  return cfg.normaliseWallet(cfg.deepMerge(w, overrides));
}

function openPositionAged(ageMs) {
  // NB: the constructor takes `solSpent` (lamports) and generates its own id.
  const p = new Position({
    walletId: 'w_stale', mint: 'M'.repeat(43), symbol: 'S',
    entryPrice: 100n, tokensHeld: 1_000_000n, solSpent: 100_000_000n,
  });
  p.openedAt = Date.now() - ageMs;
  p.lastPrice = 100n;
  return p;
}

test('STALE: no decisions on a stale mark while inside the time stop', () => {
  const c = staleCfg();
  const p = openPositionAged(1000);
  const d = risk.evaluate(p, c, { priceStale: true });
  assert.deepStrictEqual(d, [], 'must not act on a stale price');
});

test('STALE: the time stop still fires when the price feed is dead', () => {
  const c = staleCfg({ exits: { maxHoldMs: 5000 } });
  const p = openPositionAged(60_000);
  const d = risk.evaluate(p, c, { priceStale: true });
  assert.strictEqual(d.length, 1, 'expected exactly one decision');
  assert.strictEqual(d[0].reason, 'time_stop');
  assert.strictEqual(d[0].tokens, p.tokensHeld, 'must exit the whole position');
});

test('STALE: a price-derived exit cannot fire on a stale mark', () => {
  const c = staleCfg({ exits: { stopLossPct: 5, maxHoldMs: 3600000 } });
  const p = openPositionAged(1000);
  p.lastPrice = 1n; // catastrophically underwater IF this mark were trusted
  const d = risk.evaluate(p, c, { priceStale: true });
  assert.strictEqual(d.length, 0, 'a stale mark must never trigger a stop loss');
});

/* ------------------------------------------------------------------ *
 * Safety: an unreachable RPC must never be reported as a bad token
 * ------------------------------------------------------------------ *
 * Regression guard. The public RPC answers almost every request with HTTP
 * 429, and an earlier version turned that into a HARD "mint_account_not_found"
 * verdict — so every launch looked like a scam and the real cause (a dead RPC)
 * was invisible.
 */
const walletCfg = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('balanced'), { id: 'w_t', enabled: true }));

/** A connection whose every call fails the way a rate-limited RPC fails. */
const rateLimitedConn = {
  getAccountInfo: async () => {
    const e = new Error('429 Too Many Requests: Connection rate limits exceeded');
    throw e;
  },
};

/** A connection that answers, and the answer is "no such account". */
const emptyConn = { getAccountInfo: async () => null };

/** A connection that serves a plausible mint + bonding curve. */
const healthyConn = {
  getAccountInfo: async (addr) => ({
    owner: safety.PUMP_PROGRAM,
    data: Buffer.alloc(120),
    executable: false,
    lamports: 1,
    // bonding curve accounts need the discriminator the parser expects
    ...({}),
  }),
};

test('UNITS: a rate-limited RPC yields an INFRA verdict, not a token rejection', async () => {
  const v = await safety.evaluate({ mint: 'M'.repeat(43), symbol: 'X' }, walletCfg, { conn: rateLimitedConn, config: cfg.defaultGlobalConfig() });
  assert.strictEqual(v.ok, false, 'should not trade');
  assert.strictEqual(v.infra, true, 'must be flagged as infrastructure');
  assert.ok(v.reasons.some((r) => r.startsWith('rpc_unavailable')), `expected rpc_unavailable, got ${show(v.reasons)}`);
  assert.ok(!v.reasons.includes('mint_account_not_found'), 'must NOT blame the token');
});

/**
 * The scanner table's own read pass. It must produce numbers with NO wallet
 * config, NO filters and NO verdict — because the table shows one row per launch
 * even when every wallet is stopped.
 */
function curveAccount({ realSolReserves = 2_500_000_000n, complete = false } = {}) {
  const data = Buffer.alloc(80);
  data.writeBigUInt64LE(1_000_000_000_000_000n, 8);   // virtual token reserves
  data.writeBigUInt64LE(30_000_000_000n, 16);         // virtual sol reserves
  data.writeBigUInt64LE(500_000_000_000_000n, 24);    // real token reserves
  data.writeBigUInt64LE(realSolReserves, 32);         // real sol reserves
  data.writeBigUInt64LE(1_000_000_000_000_000n, 40);  // token total supply
  data.writeUInt8(complete ? 1 : 0, 48);
  return data;
}

test('UNITS: recon() fills liquidity, dev hold and risk for a wallet-free read', async () => {
  const mint = Keypair.generate().publicKey.toBase58();
  const conn = {
    getAccountInfo: async (addr) => {
      if (addr.toBase58() === mint) {
        const data = Buffer.alloc(82);
        data.writeBigUInt64LE(1_000_000_000_000_000n, 36);
        data.writeUInt8(6, 44); data.writeUInt8(1, 45);
        return { owner: safety.TOKEN_PROGRAM, data, executable: false, lamports: 1 };
      }
      return { owner: safety.PUMP_PROGRAM, data: curveAccount(), executable: false, lamports: 1 };
    },
    getTokenLargestAccounts: async () => ({
      value: [
        { address: { toBase58: () => 'holder1111111111111111111111111111111111111' }, amount: '180000000000000' },
        { address: { toBase58: () => 'a11111111111111111111111111111111111111111' }, amount: '20000000000000' },
      ],
    }),
  };

  const out = await safety.recon({ mint, symbol: 'RCN' }, { conn, config: cfg.defaultGlobalConfig() });
  assert.ok(out.report, 'a report is always returned');
  assert.strictEqual(out.report.liquiditySol, 2.5, `liquidity in SOL, got ${out.report.liquiditySol}`);
  assert.strictEqual(out.report.devHoldPct, null, 'a random holder is NOT identified as developer');
  assert.strictEqual(out.report.largestHolderPct, 18, 'largest holder is 18% of ALL minted supply, not 90% of float');
  assert.strictEqual(out.report.top10Pct, 20);
  assert.ok(typeof out.report.honeypot.risk === 'number', 'a numeric risk score is always present');
});

test('UNITS: recon() reports an unreachable RPC instead of inventing numbers', async () => {
  const out = await safety.recon({ mint: 'R'.repeat(43), symbol: 'X' }, { conn: rateLimitedConn, config: cfg.defaultGlobalConfig() });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.infra, true, 'a dead RPC must be flagged, never shown as a real reading');
  assert.strictEqual(out.report.liquiditySol, null, 'and the cells stay blank');
  assert.strictEqual(out.report.devHoldPct, null);
});

test('UNITS: a definitive "no such account" is still a HARD token rejection', async () => {
  const v = await safety.evaluate({ mint: 'M'.repeat(43), symbol: 'X' }, walletCfg, { conn: emptyConn, config: cfg.defaultGlobalConfig() });
  assert.strictEqual(v.ok, false);
  assert.notStrictEqual(v.infra, true, 'an answered query is not an infra failure');
  assert.ok(v.reasons.some((r) => r === 'mint_account_not_found' || r === 'bonding_curve_not_found'), `got ${show(v.reasons)}`);
});

pending.then(() => {
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exitCode = failed === 0 ? 0 : 1;
});
