'use strict';
/**
 * Integration test — drives complete trade lifecycles through the real Trader
 * with a stubbed executor, so buy → partial exits → trailing stop → loss limit
 * are all exercised end to end without touching the network or real funds.
 *
 * Run: node test/integration.test.js
 */
const assert = require('node:assert');
const cfg = require('../src/config');
const curve = require('../src/engine/curve');
const Position = require('../src/engine/position');

/* ------------------------------------------------------------------ *
 * Stubs — the modules Trader requires, patched in place.
 * ------------------------------------------------------------------ */
const risk = require('../src/engine/risk');
const safety = require('../src/engine/safety');
const ai = require('../src/engine/ai');

// Stub: pretend every candidate is clean.
safety.evaluate = async () => ({
  ok: true,
  score: 100,
  reasons: [],
  hard: false,
  report: {
    mintReport: { pass: true, mintAuthorityRevoked: true, freezeAuthorityRevoked: true, decimals: 6 },
    curveReport: {
      pass: true,
      curve: {
        virtualTokenReserves: curve.INITIAL_VIRTUAL_TOKEN_RESERVES,
        virtualSolReserves: curve.INITIAL_VIRTUAL_SOL_RESERVES,
        realTokenReserves: curve.INITIAL_REAL_TOKEN_RESERVES,
        realSolReserves: curve.INITIAL_VIRTUAL_SOL_RESERVES,
        tokenTotalSupply: curve.TOTAL_SUPPLY,
        complete: false,
      },
      liquiditySol: 30,
      progressPct: 35,
    },
    distribution: { top10Pct: 20, holderSample: 12, largestHolderPct: 8 },
    metadata: { symbol: 'TEST', name: 'Test Token', socials: { twitter: true }, hasSocial: true },
    devHoldPct: 8,
  },
});

// Stub: AI layer off.
ai.review = async () => ({ ok: true, verdict: 'allow', confidence: 0.8, source: 'stub' });

const Trader = require('../src/engine/trader');

/** Executor stub: records every fill, never touches the network. */
function makeExecutor() {
  const fills = [];
  return {
    dryRun: true,
    fills,
    conn: () => ({}),
    getBalanceSol: async () => 10,
    getTokenBalanceRaw: async () => 0n,
    signAndSend: async ({ label, simulate }) => {
      fills.push({ label, simulate });
      return { ok: true, signature: `SIM_${fills.length}`, simulated: true };
    },
    sellWithEscalation: async ({ label, simulate }) => {
      fills.push({ label, simulate });
      return { ok: true, signature: `SIM_${fills.length}`, simulated: true };
    },
  };
}

const KEYSTORE_STUB = { getKeypair: () => ({ publicKey: { toBase58: () => 'STUBpubkey111111111111111111111111111111111111' } }), has: () => true };

let passed = 0;
let failed = 0;
/** Disable the entry cooldown + pin sizing so multi-buy tests are deterministic. */
const NO_COOLDOWN = { buy: { cooldownMs: 0 } };

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

/** Build a Trader with a specific preset and stubbed I/O. */
function makeTrader(preset, overrides = {}) {
  const wcfg = cfg.applyPreset(cfg.defaultWalletConfig(`T_${preset}`), preset);
  // Deep-merge overrides: a shallow Object.assign would replace whole nested
  // blocks (buy/exits/limits) and silently drop the preset's other fields.
  // Defaults first, caller overrides LAST so they always win.
  const merged = cfg.normaliseWallet(cfg.deepMerge(wcfg, { id: `w_${preset}`, enabled: true, ...overrides }));
  merged.id = `w_${preset}`;
  const wcfgFinal = merged; // caller overrides (incl. enabled:false) are preserved

  const executor = makeExecutor();
  const priceCache = new Map();
  const globalCfg = cfg.defaultGlobalConfig();
  globalCfg.dryRun = true;

  const trader = new Trader({
    cfg: wcfgFinal,
    keystore: KEYSTORE_STUB,
    executor,
    getConfig: () => ({ ...globalCfg, _defaultProvider: null }),
    priceCache,
  });
  trader.init();
  trader.balanceSol = 10;
  return { trader, executor, priceCache };
}

/** Minimal engine stub — risk.globalGuardrails reads engine.traders. */
const ENGINE = { traders: new Map() };
ENGINE.traders.set('self', { openExposureSol: () => 0, stats: { realisedPnlSol: 0 } });

const CANDIDATE = {
  mint: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  symbol: 'TEST',
  name: 'Test Token',
  creator: 'Creator1111111111111111111111111111111111111',
  detectedAt: Date.now(),
  source: 'test',
};

/**
 * Drive one manage() pass at a chosen gain relative to a position's ENTRY.
 *
 * We express the tick as "+50% from entry" and back out the reserves that
 * produce that spot price. This matters because entryPrice includes buy
 * slippage, so reserves cannot simply be scaled by (1 + gain).
 *
 *   spotPrice = vSol * 1e6 / vTok     =>     vSol = targetPrice * vTok / 1e6
 */
async function tickAt(trader, priceCache, mint, entryPrice, gainPct, extra = {}) {
  const vTok = curve.INITIAL_VIRTUAL_TOKEN_RESERVES;
  const targetPrice = (BigInt(entryPrice) * BigInt(Math.round((100 + gainPct) * 1000))) / 100000n;
  const vSol = (targetPrice * vTok) / 1_000_000n;

  priceCache.set(mint, {
    price: curve.spotPriceScaled(vSol, vTok),
    virtualSolReserves: vSol,
    virtualTokenReserves: vTok,
    realSolReserves: vSol,
    complete: false,
    liquidityDropPct: extra.liquidityDropPct ?? 0,
    peakLiquiditySol: 30,
    ts: Date.now(),
  });
  await trader.manage({ engine: ENGINE });
}

/** Convenience for the common single-position case. */
async function tick(trader, priceCache, gainPct, extra = {}) {
  const p = trader.openPositions()[0] || [...trader.positions.values()][0];
  return tickAt(trader, priceCache, p.mint, p.entryPrice, gainPct, extra);
}

(async () => {
  console.log('\n── full lifecycle: balanced preset ───────────────────────');

  await test('buy opens a position with tier state initialised', async () => {
    const { trader, executor } = makeTrader('balanced');
    const outcome = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(outcome, 'bought', `expected bought, got ${outcome}`);
    assert.strictEqual(trader.openPositions().length, 1);
    const p = trader.openPositions()[0];
    assert.deepStrictEqual(p.tiers.map((t) => t.filled), [false, false, false], 'tiers should start unfilled');
    assert.strictEqual(executor.fills.length, 1, 'exactly one buy fill');
    assert.ok(p.tokensHeld > 0n, 'position should hold tokens');
  });

  await test('same mint cannot be bought twice by the same wallet', async () => {
    const { trader } = makeTrader('balanced', NO_COOLDOWN);
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const second = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(second, 'skip:already_held');
    assert.strictEqual(trader.openPositions().length, 1);
  });

  await test('first take-profit tier fires a partial sell at +50%', async () => {
    const { trader, executor, priceCache } = makeTrader('balanced');
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];
    const before = p.tokensHeld;

    await tick(trader, priceCache, 55); // balanced tier 1 = +50% for 33%

    assert.strictEqual(p.tiers[0].filled, true, 'tier 0 should be filled');
    assert.strictEqual(p.tiers[1].filled, false, 'tier 1 should not be filled yet');
    assert.strictEqual(executor.fills.length, 2, 'buy + one partial sell');
    // 33% of the ORIGINAL should have gone.
    const sold = before - p.tokensHeld;
    const pctOfOriginal = Number(sold * 10000n / p.originalTokens) / 100;
    assert.ok(Math.abs(pctOfOriginal - 33) < 0.5, `expected ~33% sold, got ${pctOfOriginal}%`);
    assert.strictEqual(p.realisedSol > 0n, true, 'should have banked SOL');
  });

  await test('tier does not re-fire on a later tick below the next threshold', async () => {
    const { trader, executor, priceCache } = makeTrader('balanced');
    await trader.consider(CANDIDATE, { engine: ENGINE });
    await tick(trader, priceCache, 55);
    const fillsAfterTier1 = executor.fills.length;
    await tick(trader, priceCache, 60); // above tier 1, below tier 2 (+120%)
    assert.strictEqual(executor.fills.length, fillsAfterTier1, 'no extra fill should occur');
  });

  await test('a gap through all tiers sells the whole position exactly once', async () => {
    const { trader, priceCache } = makeTrader('balanced');
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];

    await tick(trader, priceCache, 350); // gaps past +50 / +120 / +300

    assert.strictEqual(p.tokensHeld, 0n, 'position should be fully closed');
    assert.strictEqual(p.status, 'CLOSED');
    assert.deepStrictEqual(p.tiers.map((t) => t.filled), [true, true, true], 'all tiers marked filled');
    assert.strictEqual(trader.openPositions().length, 0);
    // Realised proceeds should exceed what was spent — this was a winner.
    assert.ok(p.realisedSol > p.solSpent, `realised ${p.realisedSol} should exceed spent ${p.solSpent}`);
  });

  console.log('\n── trailing stop ─────────────────────────────────────────');

  await test('trailing stop closes the remainder after a peak and retrace', async () => {
    const { trader, priceCache } = makeTrader('balanced');
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];

    await tick(trader, priceCache, 200); // peak +200% → floors tiers, arms trailing (act +40, trail 18)
    assert.ok(p.peakGainPct() >= 200, `peak was ${p.peakGainPct()}`);

    await tick(trader, priceCache, 150); // +150% is below peak-18 = +182% → trailing exit

    assert.strictEqual(p.status, 'CLOSED', 'trailing stop should have closed it');
    assert.ok(['trailing_stop', 'tp_300pct_all', 'tp_120pct_all'].includes(p.exitReason), `reason: ${p.exitReason}`);
  });

  await test('trailing does not fire while price keeps making new highs', async () => {
    const { trader, priceCache } = makeTrader('balanced');
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];

    for (const g of [60, 90, 130, 180, 240]) await tick(trader, priceCache, g);

    // Every tick made a new high, so the trailing floor was never breached.
    assert.strictEqual(p.status, 'OPEN', `should still be open, closed with ${p.exitReason}`);
    // The tick helper quantises price to integer lamports, so allow ~1% slack.
    assert.ok(p.peakGainPct() >= 235, `peak should be ~240, got ${p.peakGainPct()}`);
  });

  console.log('\n── stop loss & loss limit ────────────────────────────────');

  await test('stop loss closes a losing position', async () => {
    const { trader, priceCache } = makeTrader('balanced');
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];
    await tick(trader, priceCache, -30); // balanced SL = 25%
    assert.strictEqual(p.status, 'CLOSED');
    assert.strictEqual(p.exitReason, 'stop_loss');
  });

  await test('daily loss limit pauses the wallet and blocks further buys', async () => {
    // Pin the position size so the realised loss is deterministic: 1 SOL at a
    // 15% stop is a ~0.15 SOL loss, comfortably past a 0.10 SOL limit.
    const { trader, priceCache } = makeTrader('safe', {
      buy: { minAmountSol: 1, maxAmountSol: 1, cooldownMs: 0 },
      limits: { dailyLossLimitSol: 0.1 },
    });
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];
    await tick(trader, priceCache, -20); // safe SL = 15% → closes at a loss > limit

    assert.strictEqual(p.status, 'CLOSED');
    assert.strictEqual(trader.stats.paused, true, 'wallet should be paused');
    assert.match(trader.stats.pauseReason, /daily_loss_limit/);

    const next = await trader.consider({ ...CANDIDATE, mint: 'MintB'.padEnd(43, 'B') }, { engine: ENGINE });
    assert.ok(next.startsWith('skip:paused'), `expected skip:paused, got ${next}`);
  });

  await test('consecutive-loss breaker trips after N losses', async () => {
    const { trader, priceCache } = makeTrader('safe', { buy: { ...NO_COOLDOWN.buy }, limits: { stopAfterConsecutiveLosses: 2, dailyLossLimitSol: 1000 } });
    for (let i = 0; i < 2; i += 1) {
      const mint = `Mint${i}`.padEnd(43, 'X');
      await trader.consider({ ...CANDIDATE, mint }, { engine: ENGINE });
      const p = trader.openPositions()[0];
      // Point the cache at this mint so manage() sees it.
      const vSol = (curve.INITIAL_VIRTUAL_SOL_RESERVES * 70n) / 100n;
      priceCache.set(mint, {
        price: curve.spotPriceScaled(vSol, curve.INITIAL_VIRTUAL_TOKEN_RESERVES),
        virtualSolReserves: vSol, virtualTokenReserves: curve.INITIAL_VIRTUAL_TOKEN_RESERVES,
        realSolReserves: vSol, complete: false, liquidityDropPct: 0, peakLiquiditySol: 30, ts: Date.now(),
      });
      await trader.manage({ engine: ENGINE });
      assert.strictEqual(p.status, 'CLOSED');
    }
    assert.strictEqual(trader.stats.consecutiveLosses, 2);
    assert.strictEqual(trader.stats.paused, true);
    assert.match(trader.stats.pauseReason, /consecutive/);
  });

  await test('a winning trade resets the consecutive-loss counter', async () => {
    const { trader, priceCache } = makeTrader('safe', { limits: { stopAfterConsecutiveLosses: 5, dailyLossLimitSol: 1000 } });
    trader.stats.consecutiveLosses = 3;
    await trader.consider(CANDIDATE, { engine: ENGINE });
    await tick(trader, priceCache, 400); // big win closes everything
    assert.strictEqual(trader.stats.consecutiveLosses, 0, 'a win should reset the streak');
    assert.strictEqual(trader.stats.paused, false);
  });

  console.log('\n── risk exits ────────────────────────────────────────────');

  await test('liquidity exit fires when the curve drains', async () => {
    const { trader, priceCache } = makeTrader('balanced');
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];
    await tick(trader, priceCache, 5, { liquidityDropPct: 80 }); // balanced threshold = 55%
    assert.strictEqual(p.status, 'CLOSED');
    assert.strictEqual(p.exitReason, 'liquidity_exit');
  });

  await test('time stop closes a stale position', async () => {
    const { trader, priceCache } = makeTrader('balanced', { exits: { maxHoldMs: 5000 } });
    await trader.consider(CANDIDATE, { engine: ENGINE });
    const p = trader.openPositions()[0];
    p.openedAt = Date.now() - 6000;
    await tick(trader, priceCache, 3);
    assert.strictEqual(p.status, 'CLOSED');
    assert.strictEqual(p.exitReason, 'time_stop');
  });

  console.log('\n── multi-wallet independence ─────────────────────────────');

  await test('two wallets with different presets exit the same token differently', async () => {
    const A = makeTrader('scalper'); // TP1 at +15%, SL 10%
    const B = makeTrader('degen');   // TP1 at +300%, SL 60%

    await A.trader.consider(CANDIDATE, { engine: ENGINE });
    await B.trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(A.trader.openPositions().length, 1);
    assert.strictEqual(B.trader.openPositions().length, 1);

    // +20%: the scalper's first tier has fired, the degen's has not.
    // Drive both from the same entry price so the comparison is apples-to-apples.
    const entry = A.trader.openPositions()[0].entryPrice;
    await tickAt(A.trader, A.priceCache, CANDIDATE.mint, entry, 20);
    await tickAt(B.trader, B.priceCache, CANDIDATE.mint, entry, 20);

    const pa = A.trader.openPositions()[0];
    const pb = B.trader.openPositions()[0];

    assert.strictEqual(pa.tiers[0].filled, true, 'scalper tier 1 (+15%) should be filled');
    assert.strictEqual(pb.tiers[0].filled, false, 'degen tier 1 (+300%) should NOT be filled');
    assert.ok(pa.tokensHeld < pa.originalTokens, 'scalper should have partially sold');
    assert.strictEqual(pb.tokensHeld, pb.originalTokens, 'degen should be untouched');

    // Different banks of realised SOL — proof the configs are truly independent.
    assert.ok(pa.realisedSol > 0n, 'scalper banked something');
    assert.strictEqual(pb.realisedSol, 0n, 'degen banked nothing yet');
  });

  await test('pausing one wallet does not affect another', async () => {
    const A = makeTrader('safe', { limits: { dailyLossLimitSol: 0.01 } });
    const B = makeTrader('balanced');

    await A.trader.consider(CANDIDATE, { engine: ENGINE });
    await tick(A.trader, A.priceCache, -20); // trips A's tiny loss limit
    assert.strictEqual(A.trader.stats.paused, true, 'A should be paused');

    const outB = await B.trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(outB, 'bought', 'B must remain fully operational');
    assert.strictEqual(B.trader.stats.paused, false);
  });

  await test('each wallet gets its own position size within its own band', async () => {
    const A = makeTrader('safe');     // 0.05–0.3
    const B = makeTrader('aggressive'); // 0.3–2.0
    await A.trader.consider(CANDIDATE, { engine: ENGINE });
    await B.trader.consider(CANDIDATE, { engine: ENGINE });

    const spentA = Number(A.trader.openPositions()[0].solSpent) / 1e9;
    const spentB = Number(B.trader.openPositions()[0].solSpent) / 1e9;

    assert.ok(spentA >= 0.05 - 1e-9 && spentA <= 0.3 + 1e-9, `A size ${spentA} outside safe band`);
    assert.ok(spentB >= 0.3 - 1e-9 && spentB <= 2.0 + 1e-9, `B size ${spentB} outside aggressive band`);
  });

  console.log('\n── guardrails ────────────────────────────────────────────');

  await test('max concurrent positions is enforced per wallet', async () => {
    const { trader } = makeTrader('balanced', { buy: { maxConcurrentPositions: 2, cooldownMs: 0 } });
    const r1 = await trader.consider({ ...CANDIDATE, mint: 'M1'.padEnd(43, 'A') }, { engine: ENGINE });
    const r2 = await trader.consider({ ...CANDIDATE, mint: 'M2'.padEnd(43, 'B') }, { engine: ENGINE });
    const r3 = await trader.consider({ ...CANDIDATE, mint: 'M3'.padEnd(43, 'C') }, { engine: ENGINE });
    assert.strictEqual(r1, 'bought');
    assert.strictEqual(r2, 'bought');
    assert.strictEqual(r3, 'skip:max_concurrent_positions');
  });

  await test('disabled wallet never trades', async () => {
    const { trader } = makeTrader('balanced', { enabled: false });
    const out = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(out, 'skip:wallet_disabled');
  });

  await test('closeAll flattens every open position', async () => {
    const { trader } = makeTrader('balanced', NO_COOLDOWN);
    await trader.consider({ ...CANDIDATE, mint: 'M1'.padEnd(43, 'A') }, { engine: ENGINE });
    await trader.consider({ ...CANDIDATE, mint: 'M2'.padEnd(43, 'B') }, { engine: ENGINE });
    assert.strictEqual(trader.openPositions().length, 2);
    await trader.closeAll('test');
    assert.strictEqual(trader.openPositions().length, 0, 'all positions should be closed');
  });

  /* ---------------------------------------------------------------- *
   * Wallets must be visible before the engine is started
   * ---------------------------------------------------------------- *
   * They are only built in Engine.start(), so the dashboard showed an empty
   * wallets panel until Start was pressed — with no way to read a wallet's
   * address in order to fund it. hydrate() decouples "loaded" from "running".
   */
  await test('HYDRATE: configured wallets load without the engine running', async () => {
    const Engine = require('../src/engine/engine');
    const KEY = { id: 'w_h', enabled: true };
    const engine = new Engine({
      config: {
        global: cfg.defaultGlobalConfig(),
        wallets: [cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('H'), KEY))],
      },
      keystore: {
        has: () => true,
        getKeypair: () => ({ publicKey: { toBase58: () => 'HyDrAtEdWaLLeT111111111111111111111111111111' } }),
      },
      executor: { dryRun: true, conn: () => ({}) },
    });

    assert.strictEqual(engine.running, false, 'engine must not be running');
    assert.strictEqual(engine.traders.size, 0, 'nothing loaded before hydrate');

    const added = engine.hydrate();
    assert.strictEqual(added, 1, 'hydrate should load the configured wallet');
    assert.strictEqual(engine.traders.size, 1, 'wallet must be present');
    assert.strictEqual(engine.running, false, 'hydrating must NOT start trading');

    // Idempotent: calling it again must not duplicate or throw.
    assert.strictEqual(engine.hydrate(), 0, 'second hydrate is a no-op');
    assert.strictEqual(engine.traders.size, 1, 'no duplicates');
  });

  /* ---------------------------------------------------------------- *
   * Demo fixtures must never contain a sendable address
   * ---------------------------------------------------------------- *
   * Regression guard for a real hazard: the dashboard's offline demo data
   * originally used genuine mainnet token-MINT accounts (WIF, BONK, …) as fake
   * "wallet" public keys. A user who copied one out of the preview and sent SOL
   * to it would have destroyed the funds, because a mint account is owned by the
   * SPL Token program and no human can spend from it. Every demo address must
   * therefore be structurally un-sendable.
   */
  /* ---------------------------------------------------------------- *
   * A wallet whose key is not loaded is still a wallet
   * ---------------------------------------------------------------- *
   * hydrate() skips any wallet it cannot build — correct, since a trader needs a
   * keypair — but the WALLET LIST then returned nothing while the keystore was
   * closed, which is how the bot boots. A user who had created three wallets saw
   * an empty dashboard and concluded they were gone. The record (name, on-chain
   * address, strategy) lives in config.json and needs no passphrase.
   */
  await test('LOCKED WALLETS: reported with their address while the keystore is closed', async () => {
    const Engine = require('../src/engine/engine');
    const A = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('Alpha'), { id: 'w_a', enabled: true }));
    A.publicKey = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
    const engine = new Engine({
      config: { global: cfg.defaultGlobalConfig(), wallets: [A] },
      keystore: { has: () => false, getKeypair: () => null, isUnlocked: () => false }, // closed: no keys loaded
      executor: { dryRun: true, conn: () => ({}) },
    });

    assert.strictEqual(engine.hydrate(), 0, 'nothing to hydrate without keys');
    assert.deepStrictEqual(
      [...engine.traders.values()].map((t) => t.toJSON()),
      [],
      'the live list really is empty — that is the situation being fixed',
    );

    const locked = engine.lockedWallets();
    assert.strictEqual(locked.length, 1, 'the configured wallet must still be reported');
    assert.strictEqual(locked[0].name, 'Alpha', 'with its name');
    assert.strictEqual(locked[0].publicKey, A.publicKey, 'and its on-chain address');
    assert.strictEqual(locked[0].keyLocked, true, 'flagged as locked');
    assert.strictEqual(locked[0].keyMissing, false, 'not as missing — an open keystore may still hold it');
    assert.strictEqual(locked[0].balanceSol, null, 'balance is unknown, and null says unknown, not zero');
    assert.strictEqual(locked[0].stats, null, 'and no invented statistics');
    assert.ok(!engine.traders.has('w_a'), 'it must NOT become a trader: no key, no trading');
  });

  await test('MISSING KEYS: with the keystore OPEN, an absent key is reported as gone, not locked', async () => {
    // This is the state a keystore RESET leaves behind: the wallet record and its
    // on-chain address survive, the key does not. Telling the user "open your
    // keystore and this wallet trades again" would be false, so the two cases must
    // be distinguishable from the payload alone.
    const Engine = require('../src/engine/engine');
    const A = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('Archived'), { id: 'w_gone' }));
    A.publicKey = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
    const engine = new Engine({
      config: { global: cfg.defaultGlobalConfig(), wallets: [A] },
      keystore: { has: () => false, getKeypair: () => null, isUnlocked: () => true },
      executor: { dryRun: true, conn: () => ({}) },
    });

    engine.hydrate();
    const [w] = engine.lockedWallets();
    assert.strictEqual(w.keyLocked, true, 'still not usable');
    assert.strictEqual(w.keyMissing, true, 'but reported as MISSING, because the keystore is open and it is not in there');
    assert.strictEqual(w.publicKey, A.publicKey, 'the address is still reported, so funds can be located');
  });

  await test('LOCKED WALLETS: once hydrate() has them, they are not listed twice', async () => {
    const Engine = require('../src/engine/engine');
    const A = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('Alpha'), { id: 'w_a' }));
    const engine = new Engine({
      config: { global: cfg.defaultGlobalConfig(), wallets: [A] },
      keystore: {
        has: () => true,
        getKeypair: () => ({ publicKey: { toBase58: () => 'LoadedWaLLeT11111111111111111111111111111111' } }),
      },
      executor: { dryRun: true, conn: () => ({}) },
      priceCache: new Map(),
    });

    engine.hydrate();
    assert.strictEqual(engine.traders.size, 1, 'the key is loaded, so it is a real trader');
    assert.deepStrictEqual(engine.lockedWallets(), [], 'and it must not appear in the locked list');
  });

  await test('DEMO DATA: no demo fixture looks like a real, sendable address', () => {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
    const isReal = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);

    // Every publicKey literal declared in the demo fixtures.
    const keys = [...src.matchAll(/publicKey:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.ok(keys.length >= 3, `expected demo fixtures to declare keys, found ${keys.length}`);

    const sendable = keys.filter(isReal);
    assert.deepStrictEqual(
      sendable, [],
      `demo fixtures must not contain real-looking addresses (these could receive funds): ${sendable.join(', ')}`,
    );
  });

  /* ---------------------------------------------------------------- *
   * An unreadable balance is not an empty wallet
   * ---------------------------------------------------------------- *
   * getBalanceSol used to return 0 on failure. In live mode that made the
   * trader report `skip:insufficient_balance`, so a transient RPC blip was
   * indistinguishable from an unfunded wallet and the bot silently stopped.
   */
  await test('BALANCE: a failed read reports balance_unknown, not insufficient_balance', async () => {
    const { trader, executor } = makeTrader('balanced', NO_COOLDOWN);
    executor.dryRun = false; // live: no notional balance to fall back on
    executor.getBalanceSol = async () => {
      const e = new Error('balance_unavailable: 429');
      e.code = 'BALANCE_UNAVAILABLE';
      throw e;
    };
    trader.balanceKnown = false;

    const out = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(out, 'skip:balance_unknown', `expected balance_unknown, got "${out}"`);
    assert.notStrictEqual(out, 'skip:insufficient_balance', 'must not claim the wallet is empty');
  });

  await test('BALANCE: a failed read does not overwrite the last known balance', async () => {
    const { trader, executor } = makeTrader('balanced', NO_COOLDOWN);
    trader.balanceSol = 3.5;
    trader.balanceKnown = true;
    executor.getBalanceSol = async () => { throw new Error('balance_unavailable: 429'); };

    await trader.refreshBalance();
    assert.strictEqual(trader.balanceSol, 3.5, 'the last good number must survive a failed read');
    assert.strictEqual(trader.balanceKnown, false, 'and it must be flagged as stale');
  });

  /* ---------------------------------------------------------------- *
   * Paper trading: an unfunded wallet must still exercise the pipeline
   * ---------------------------------------------------------------- *
   * Without a notional balance a dry-run wallet sizes every position to 0 and
   * never trades, so there is no safe way to validate exits before funding.
   */
  await test('PAPER: an unfunded dry-run wallet still sizes and buys', async () => {
    const { trader } = makeTrader('balanced', NO_COOLDOWN);
    trader.balanceSol = 0; // no real funds, as a fresh wallet would have
    const out = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(out, 'bought', `expected a paper fill, got "${out}"`);
    const pos = trader.openPositions()[0];
    assert.ok(pos, 'position should be open');
    assert.ok(Number(pos.solSpent) > 0, 'paper position must have a real size');
    assert.ok(Number(pos.solSpent) / 1e9 <= 10, 'must stay inside the notional balance');
  });

  await test('PAPER: a live wallet with no funds correctly refuses to trade', async () => {
    const { trader, executor } = makeTrader('balanced', NO_COOLDOWN);
    executor.dryRun = false; // LIVE: no notional balance may be substituted
    // consider() re-reads the chain balance, so the stub must report zero too —
    // otherwise the default stub's 10 SOL masks the very path under test.
    executor.getBalanceSol = async () => 0;
    trader.balanceSol = 0;
    const out = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(out, 'skip:insufficient_balance', `expected a refusal, got "${out}"`);
    assert.strictEqual(trader.openPositions().length, 0, 'must not open a live position it cannot fund');
  });

  /* ─────────────── KILL / FLATTEN / PANIC (money-critical) ─────────────── */

  /**
   * A Trader wired to the REAL sellWithEscalation, a stubbed signAndSend and a
   * fake provider. This is the only way to prove a kill really builds and sends
   * a sell: the previous implementation booked a fake fill instead.
   */
  function makeKillTrader() {
    const Executor = require('../src/engine/executor');
    const wcfg = cfg.normaliseWallet(cfg.deepMerge(
      cfg.applyPreset(cfg.defaultWalletConfig('Kill'), 'balanced'),
      { id: 'w_kill', enabled: true }
    ));
    wcfg.id = 'w_kill';

    const executor = makeExecutor();
    executor.dryRun = false;                        // LIVE: no simulated fill allowed
    executor.config = { execution: { sellRetryAttempts: 3 } };
    executor.sellWithEscalation = Executor.prototype.sellWithEscalation;
    const sends = [];
    executor.signAndSend = async ({ label }) => {
      sends.push(label);
      return { ok: true, signature: `SELL_${sends.length}` };
    };

    const provider = { calls: [], sell: async (args) => { provider.calls.push(args); return { tx: { fake: true } }; } };
    const priceCache = new Map();
    const trader = new Trader({
      cfg: wcfg,
      keystore: KEYSTORE_STUB,
      executor,
      getConfig: () => ({ ...cfg.defaultGlobalConfig(), _defaultProvider: provider }),
      priceCache,
    });
    trader.init();
    trader.balanceSol = 10;

    // A live position: 1.0 token (6dp) bought for 0.03 SOL.
    const MINT = 'KillMint111111111111111111111111111111111111';
    const pos = new Position({
      walletId: 'w_kill', mint: MINT, symbol: 'KILLME',
      entryPrice: 30_000_000n, tokensHeld: 1_000_000n, solSpent: 30_000_000n, txSignature: 'buy_sig',
    });
    trader.positions.set(pos.id, pos);
    trader.byMint.set(MINT, pos.id);
    priceCache.set(MINT, {
      price: 30_000_000n,
      virtualSolReserves: curve.INITIAL_VIRTUAL_SOL_RESERVES,
      virtualTokenReserves: curve.INITIAL_VIRTUAL_TOKEN_RESERVES,
      ts: Date.now(),
    });
    return { trader, executor, provider, sends, pos, MINT };
  }

  await test('KILL: builds and sends a real sell — not a simulated fill', async () => {
    const { trader, executor, provider, sends, pos, MINT } = makeKillTrader();

    const res = await trader.killPosition(pos.id, 'test_kill');

    assert.strictEqual(res.ok, true, `kill failed: ${res.error}`);
    assert.strictEqual(provider.calls.length >= 1, true, 'the provider must be asked to build a sell');
    assert.strictEqual(provider.calls[0].mint, MINT, 'sell must target the position mint');
    assert.strictEqual(provider.calls[0].tokenAmount, '1000000', 'must sell the entire holding');
    assert.strictEqual(sends.length, 1, 'exactly one transaction submitted');
    assert.strictEqual(executor.fills.length, 0, 'no simulated fill may be booked for a live kill');
    assert.strictEqual(pos.status, 'CLOSED', 'position must close');
    assert.strictEqual(pos.tokensHeld, 0n, 'nothing left held');
    assert.strictEqual(trader.openPositions().length, 0, 'no open positions remain');
  });

  await test('KILL: honest failure — position stays open, nothing is forgotten', async () => {
    const { trader, provider, pos } = makeKillTrader();
    provider.sell = async () => { throw new Error('no_route_available'); };

    const res = await trader.killPosition(pos.id, 'test_kill_fail');

    assert.strictEqual(res.ok, false, 'a failed sell must not report success');
    assert.strictEqual(res.exhausted, true, 'escalation must report exhaustion');
    assert.strictEqual(pos.status, 'OPEN', 'the position is still real and must stay open');
    assert.strictEqual(pos.tokensHeld, 1_000_000n, 'the holding must be intact');
    assert.strictEqual(trader.openPositions().length, 1, 'still managed, so exits can retry');
    assert.strictEqual(trader.byMint.has(pos.mint), true, 'the mint guard must not be released');
  });

  await test('KILL ALL: reports sold and failed separately', async () => {
    const { trader, provider, pos } = makeKillTrader();
    // Second position whose sell will fail.
    const pos2 = new Position({
      walletId: 'w_kill', mint: 'KillMint222222222222222222222222222222222222', symbol: 'STUCK',
      entryPrice: 30_000_000n, tokensHeld: 2_000_000n, solSpent: 60_000_000n, txSignature: 'buy2',
    });
    trader.positions.set(pos2.id, pos2);
    trader.byMint.set(pos2.mint, pos2.id);
    provider.sell = async (args) => {
      if (args.mint === pos2.mint) throw new Error('pool_dead');
      return { tx: { fake: true } };
    };

    const results = await trader.closeAll('kill_all_test');
    const sold = results.filter((r) => r.ok).length;

    assert.strictEqual(results.length, 2, 'both positions attempted');
    assert.strictEqual(sold, 1, 'one sold, one refused');
    assert.strictEqual(pos.status, 'CLOSED', 'the sellable one closed');
    assert.strictEqual(pos2.status, 'OPEN', 'the stuck one is still open and still ours');
  });

  await test('PANIC: liquidates, pauses wallets, and does NOT flip dryRun', async () => {
    const Engine = require('../src/engine/engine');
    const { trader, executor, pos } = makeKillTrader();
    const engine = new Engine({
      config: { global: cfg.defaultGlobalConfig(), wallets: [] },
      keystore: { has: () => false },
    });
    engine.executor = executor;                 // dryRun === false
    engine.traders.set('w_kill', trader);

    const out = await engine.panic('test_panic');

    assert.strictEqual(executor.dryRun, false, 'panic must not silently turn a live bot into a paper bot');
    assert.strictEqual(pos.status, 'CLOSED', 'panic must actually close the position');
    assert.strictEqual(out.sold, 1, 'panic reports what it sold');
    assert.strictEqual(trader.stats.paused, true, 'panic blocks new entries by pausing the wallet');
    assert.match(String(trader.stats.pauseReason), /panic/, 'the pause reason must be explicit');
  });

  /* ───────────────────── restart recovery (adoption) ───────────────────── */

  await test('SNAPSHOT: survives a JSON round trip with BigInts intact', () => {
    const { pos } = makeKillTrader();
    pos.mark(45_000_000n, Date.now());

    const back = Position.fromSnapshot(JSON.parse(JSON.stringify(pos.snapshot())));

    assert.strictEqual(back.id, pos.id, 'id must be stable so the UI does not churn');
    assert.strictEqual(back.entryPrice, pos.entryPrice, 'entry price is the basis for every exit rule');
    assert.strictEqual(back.tokensHeld, pos.tokensHeld, 'size must survive');
    assert.strictEqual(back.solSpent, pos.solSpent, 'cost basis must survive');
    assert.strictEqual(back.highWaterPrice, pos.highWaterPrice, 'the peak drives the trailing stop');
    assert.strictEqual(typeof back.entryPrice, 'bigint', 'never float64 for money');
  });

  await test('ADOPT: chain is the truth, not the file', async () => {
    const { trader, pos } = makeKillTrader();
    const snap = JSON.parse(JSON.stringify(pos.snapshot()));
    trader.positions.clear();
    trader.byMint.clear();
    trader.executor.getTokenBalanceRawOrThrow = async () => 400_000n; // 0.4 of the 1.0 on file

    const adopted = await trader.adoptPosition(snap);

    assert.ok(adopted, 'a held position must be re-adopted');
    assert.strictEqual(adopted.tokensHeld, 400_000n, 'adopt what is really there, not what the file claims');
    assert.strictEqual(adopted.adopted, true, 'flagged so the dashboard can label it');
    assert.strictEqual(trader.openPositions().length, 1, 'back under management');
    assert.strictEqual(adopted.entryPrice, snap.entryPrice === undefined ? adopted.entryPrice : BigInt(snap.entryPrice), 'cost basis restored');
  });

  await test('ADOPT: a failed balance read must not erase a live position', async () => {
    const { trader, pos } = makeKillTrader();
    const snap = JSON.parse(JSON.stringify(pos.snapshot()));
    trader.positions.clear();
    trader.byMint.clear();
    trader.executor.getTokenBalanceRawOrThrow = async () => {
      const e = new Error('BALANCE_UNAVAILABLE'); e.code = 'BALANCE_UNAVAILABLE'; throw e;
    };

    await assert.rejects(() => trader.adoptPosition(snap), /BALANCE_UNAVAILABLE/);
    assert.strictEqual(trader.openPositions().length, 0, 'unknown is not zero: adopt nothing');
  });

  await test('ADOPT: tokens already sold are not resurrected', async () => {
    const { trader, pos } = makeKillTrader();
    const snap = JSON.parse(JSON.stringify(pos.snapshot()));
    trader.positions.clear();
    trader.byMint.clear();
    trader.executor.getTokenBalanceRawOrThrow = async () => 0n;

    const adopted = await trader.adoptPosition(snap);
    assert.strictEqual(adopted, null, 'an empty wallet means nothing to manage');
    assert.strictEqual(trader.openPositions().length, 0, 'no phantom position');
  });

  await test('ADOPT: resumeAfterRestart:false opts a wallet out', async () => {
    const { trader, pos } = makeKillTrader();
    const snap = JSON.parse(JSON.stringify(pos.snapshot()));
    trader.positions.clear();
    trader.byMint.clear();
    trader.cfg.resumeAfterRestart = false;
    trader.executor.getTokenBalanceRawOrThrow = async () => 400_000n;

    assert.strictEqual(await trader.adoptPosition(snap), null, 'an opted-out wallet must start flat');
  });

  await test('PERSIST: never writes the snapshot before resume() has run', async () => {
    const Engine = require('../src/engine/engine');
    const engine = new Engine({
      config: { global: cfg.defaultGlobalConfig(), wallets: [] },
      keystore: { has: () => false },
    });
    // hydrate() starts with an empty book; writing that would destroy the only
    // record of positions a restart is supposed to recover.
    assert.strictEqual(engine._resumed, false, 'sanity: not resumed yet');
    assert.strictEqual(engine.persistPositions(), 0, 'must refuse to write before the first resume');
  });

  await test('RECOVER: an end-to-end restart keeps the snapshot and re-adopts it', () => {
    const { execFileSync } = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snipersol-recover-'));
    const root = path.join(__dirname, '..');

    const script = `
      const cfg = require('${root}/src/config');
      const Position = require('${root}/src/engine/position');
      const Trader = require('${root}/src/engine/trader');
      const Engine = require('${root}/src/engine/engine');
      const path = require('path');
      const fs = require('fs');

      const snap = {
        id: 'pos_old', walletId: 'w_hold', mint: 'Hold1111111111111111111111111111111111111111',
        symbol: 'HODL', name: 'Hodl', meta: {}, openedAt: Date.now() - 3600000,
        entryPrice: '30000000', lastPrice: '30000000', highWaterPrice: '90000000',
        originalTokens: '1000000', tokensHeld: '1000000', solSpent: '30000000',
        realisedSol: '0', realisedTokens: '0', entryTxSignature: 'buy', tiers: [], exits: [],
      };
      fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
      fs.writeFileSync(path.join(cfg.DATA_DIR, 'positions.json'),
        JSON.stringify({ savedAt: Date.now(), wallets: { w_hold: [snap] } }));

      const log = [];
      (async () => {
        // ── 1. Boot with the keystore still locked: no trader exists, so the
        //      snapshot must be preserved for a later attempt.
        const locked = new Engine({ config: { global: cfg.defaultGlobalConfig(), wallets: [] },
                                    keystore: { has: () => false } });
        await locked.resume();
        const afterLocked = JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, 'positions.json'), 'utf8'));
        log.push(['keptWhileLocked', Boolean(afterLocked.wallets.w_hold && afterLocked.wallets.w_hold.length === 1)]);

        // ── 2. Unlocked: the wallet still holds 0.4 of the original 1.0.
        const wcfg = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('Hold'), { id: 'w_hold', enabled: true }));
        wcfg.id = 'w_hold';
        const trader = new Trader({
          cfg: wcfg,
          keystore: { getKeypair: () => ({ publicKey: { toBase58: () => 'HoldWallet' } }) },
          executor: { dryRun: true, getBalanceSol: async () => 1, getTokenBalanceRawOrThrow: async () => 400000n },
          getConfig: () => ({ ...cfg.defaultGlobalConfig(), _defaultProvider: null }),
          priceCache: new Map(),
        });
        trader.init();
        const engine = new Engine({ config: { global: cfg.defaultGlobalConfig(), wallets: [] },
                                    keystore: { has: () => false } });
        engine.traders.set('w_hold', trader);
        const adopted = await engine.resume();
        const open = trader.openPositions();
        log.push(['adopted', adopted]);
        log.push(['tokens', open.length ? open[0].tokensHeld.toString() : 'none']);
        log.push(['peakKept', open.length ? open[0].highWaterPrice.toString() : 'none']);
        log.push(['statusRecovered', engine.status().recoveredPositions]);
        log.push(['fileNow', JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, 'positions.json'), 'utf8')).wallets.w_hold.length]);

        // ── 3. Once sold, it must not come back from the dead.
        open[0].recordExit({ pctSold: 100, tokensSold: open[0].tokensHeld, solReceived: 1n, reason: 'test' });
        engine.persistPositions();
        const finalFile = JSON.parse(fs.readFileSync(path.join(cfg.DATA_DIR, 'positions.json'), 'utf8'));
        log.push(['clearedAfterClose', !finalFile.wallets.w_hold]);
        process.stdout.write('###RESULT###' + JSON.stringify(log));
      })().catch((e) => { process.stdout.write('###RESULT###' + JSON.stringify({ error: e.message })); });
    `;

    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8',
    });
    // The child's logger writes its own (ANSI-coloured) lines to stdout, so our
    // result is framed and read from the last marker rather than the whole pipe.
    const marker = out.lastIndexOf('###RESULT###');
    assert.ok(marker !== -1, `no result marker in child output: ${out.slice(-400)}`);
    const r = Object.fromEntries(JSON.parse(out.slice(marker + '###RESULT###'.length)));
    assert.ok(!r.error, `recovery script errored: ${r.error}`);
    assert.strictEqual(r.keptWhileLocked, true, 'a locked boot must not wipe the recovery file');
    assert.strictEqual(r.adopted, 1, 'the position must be re-adopted once the keys are available');
    assert.strictEqual(r.tokens, '400000', 'adopt the on-chain amount');
    assert.strictEqual(r.peakKept, '90000000', 'the trailing-stop peak must survive, or a 24h hold re-risks its gains');
    assert.strictEqual(r.statusRecovered, 1, 'status must report the recovery');
    assert.strictEqual(r.fileNow, 1, 'still tracked while open');
    assert.strictEqual(r.clearedAfterClose, true, 'a closed position must not be resurrected on the next restart');
  });

  /* ──────────────── per-wallet stop / kill semantics ──────────────── */

  await test('STOP is per wallet: blocks new entries, keeps managing exits', () => {
    const { trader, priceCache } = makeTrader('balanced', NO_COOLDOWN);

    // A live position that will be stopped on.
    const MINT = 'StopMint1111111111111111111111111111111111111';
    const pos = new Position({
      walletId: 'w_balanced', mint: MINT, symbol: 'STOPME',
      entryPrice: 30_000_000n, tokensHeld: 1_000_000n, solSpent: 30_000_000n, txSignature: 'b',
    });
    trader.positions.set(pos.id, pos);
    trader.byMint.set(MINT, pos.id);

    trader.pause('stopped from the dashboard');

    const gate = risk.canOpenNewPosition(trader);
    assert.strictEqual(gate.ok, false, 'a stopped wallet must not open anything new');
    assert.match(gate.reason, /paused/, 'and it must say why');

    // The important half: exit management must still run, or stopping a wallet
    // would silently remove the stop loss from an open position.
    pos.mark(12_000_000n, Date.now()); // -60%: far below any stop
    priceCache.set(MINT, {
      price: 12_000_000n,
      virtualSolReserves: curve.INITIAL_VIRTUAL_SOL_RESERVES,
      virtualTokenReserves: curve.INITIAL_VIRTUAL_TOKEN_RESERVES,
      ts: Date.now(),
    });
    const decisions = risk.evaluate(pos, trader.cfg, {});
    assert.ok(decisions.length > 0, 'a stopped wallet must still evaluate its exits');
    assert.ok(
      decisions.some((d) => d.action === 'SELL'),
      'the stop loss must still fire while the wallet is stopped'
    );
  });

  await test('a STOPPED wallet still manages its open position through manage()', async () => {
    // The promise on the Stop button is "open positions are still managed, so
    // your stops keep working". manage() used to return early unless
    // cfg.enabled, which made that promise false: a stopped wallet's position had
    // no stop loss. This drives the REAL manage() path, not risk.evaluate().
    const { trader, executor, priceCache } = makeTrader('balanced', { enabled: false });
    assert.strictEqual(trader.cfg.enabled, false, 'sanity: the wallet is stopped');

    // An open position it is managing, sized at the default 0.35 SOL entry.
    const p = new Position({
      walletId: trader.cfg.id,
      mint: CANDIDATE.mint,
      symbol: 'STOPPED',
      name: 'Stopped bag',
      entryPrice: 1_000_000n,
      tokensHeld: 350_000n,
      solSpent: 350_000_000n,
      txSignature: 'SIM',
      meta: {},
    });
    p.tiers = trader.cfg.exits.takeProfitTiers.map((t) => ({ ...t, filled: false }));
    trader.positions.set(p.id, p);
    trader.byMint.set(p.mint, p.id);

    const fillsBefore = executor.fills.length;
    await tickAt(trader, priceCache, p.mint, p.entryPrice, -60); // far below any stop
    assert.ok(
      executor.fills.length > fillsBefore,
      'a stopped wallet must still SELL when its stop loss is hit — otherwise Stop strands the bag'
    );
  });

  await test('a DISARMED wallet takes nothing, and Start is what fixes it', async () => {
    const { trader } = makeTrader('balanced', { enabled: false });
    const blocked = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(blocked, 'skip:wallet_disabled', 'the entry gate reads cfg.enabled');

    // What POST /api/wallets/:id/start now does, in order.
    trader.cfg.enabled = true;
    trader.resume();
    const outcome = await trader.consider(CANDIDATE, { engine: ENGINE });
    assert.strictEqual(outcome, 'bought', 'and then it trades');
  });

  await test('STOP does not touch other wallets (per-wallet, not global)', () => {
    const a = makeTrader('balanced', NO_COOLDOWN);
    const b = makeTrader('aggressive', NO_COOLDOWN);
    a.trader.pause('stopped from the dashboard');

    assert.strictEqual(risk.canOpenNewPosition(a.trader).ok, false, 'the stopped wallet is blocked');
    assert.strictEqual(risk.canOpenNewPosition(b.trader).ok, true, 'the other wallet must keep trading');
  });

  await test('START clears the pause and re-allows entries', () => {
    const { trader } = makeTrader('balanced', NO_COOLDOWN);
    trader.pause('stopped from the dashboard');
    assert.strictEqual(risk.canOpenNewPosition(trader).ok, false, 'sanity: blocked while stopped');
    trader.resume();
    assert.strictEqual(trader.stats.paused, false, 'resume clears the flag');
    assert.strictEqual(risk.canOpenNewPosition(trader).ok, true, 'entries allowed again');
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
