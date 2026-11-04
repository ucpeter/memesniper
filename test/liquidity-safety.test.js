'use strict';
// Offline regression for the r34 audit. No real RPC, wallet key or submission.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-liquidity-fix-'));
const { Keypair } = require('@solana/web3.js');
const Engine = require('../src/engine/engine');
const Trader = require('../src/engine/trader');
const Position = require('../src/engine/position');
const safety = require('../src/engine/safety');
const curve = require('../src/engine/curve');

const mint = Keypair.generate().publicKey.toBase58();
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const parsedInfo = (sol) => ({ data: {
  realSolReserves: BigInt(sol) * 1_000_000_000n,
  virtualSolReserves: (30n + BigInt(sol)) * 1_000_000_000n,
  virtualTokenReserves: curve.INITIAL_VIRTUAL_TOKEN_RESERVES,
  complete: false,
} });

async function pollSerialization() {
  const originalInterval = global.setInterval;
  const originalParse = safety.parseBondingCurve;
  let tick;
  const pending = [];
  const engine = Object.create(Engine.prototype);
  engine.running = true;
  engine.priceCache = new Map();
  engine.priceHealth = { ok: true, consecutiveFailures: 0, lastOkAt: 0 };
  let managed = 0;
  engine.traders = new Map([['paper', {
    openPositions: () => [{ mint, isOpen: true }],
    manage: async () => { managed += 1; },
  }]]);
  engine.executor = { conn: () => ({ getMultipleAccountsInfo: () => {
    const p = defer(); pending.push(p); return p.promise;
  } }) };
  global.setInterval = (fn) => { tick = fn; return { unref() {} }; };
  safety.parseBondingCurve = (x) => x;
  try {
    engine._startPricePoller();
    const older = tick();
    await tick();
    assert.equal(pending.length, 1, 'overlapping interval does not start another RPC');
    pending[0].resolve([parsedInfo(4)]);
    await older;
    assert.equal(managed, 1);
    const newer = tick();
    pending[1].resolve([parsedInfo(10)]);
    await newer;
    assert.equal(engine.priceCache.get(mint).realSolReserves, 10_000_000_000n,
      'chronological 4→10 SOL must end with the 10 SOL observation');
    assert.equal(engine.priceCache.get(mint).peakLiquiditySol, undefined,
      'historical liquidity peaks must not live in the per-mint cache');
    assert.equal(managed, 2);

    engine.priceCache.get(mint).slot = 10;
    const previousExecutor = engine.executor;
    engine.executor = { conn: () => ({ getMultipleAccountsInfoAndContext: () => {
      const p = defer(); pending.push(p); return p.promise;
    } }) };
    const staleSlot = tick();
    pending[2].resolve({ value: [parsedInfo(1)], context: { slot: 9 } });
    await staleSlot;
    assert.equal(engine.priceCache.get(mint).realSolReserves, 10_000_000_000n,
      'older RPC slot cannot roll back a later confirmed observation');
    engine.executor = previousExecutor;

    const slowSell = defer();
    engine.traders.get('paper').manage = async () => { managed += 1; await slowSell.promise; };
    const whileSelling = tick();
    pending[3].resolve([parsedInfo(10)]);
    await whileSelling;
    const nextRead = tick();
    assert.equal(pending.length, 5, 'a pending sell must not block fresh price reads for other wallets');
    pending[4].resolve([parsedInfo(10)]);
    await nextRead;
    slowSell.resolve();

    const abandoned = tick();
    engine.running = false;
    engine._pricePollGeneration = 1;
    engine._pricePollBusy = false;
    pending[5].resolve([parsedInfo(1)]);
    await abandoned;
    assert.equal(managed, 5, 'a stopped generation cannot evaluate positions');
    assert.equal(Number(engine.priceCache.get(mint).realSolReserves), 10_000_000_000,
      'a stopped generation cannot replace the mark');
  } finally {
    global.setInterval = originalInterval;
    safety.parseBondingCurve = originalParse;
  }
}

function independentPeaks() {
  const t = Object.create(Trader.prototype);
  t.cfg = { exits: { liquidityDropExitPct: 55 } };
  const make = () => new Position({ walletId: 'w', mint, symbol: 'TEST',
    entryPrice: 30n, tokensHeld: 1_000_000n, solSpent: 3000n });
  const earlier = make();
  const later = make();
  assert.equal(t._observeLiquidity(earlier, { realSolReserves: 10_000_000_000n, ts: 1 }), 0);
  assert.equal(t._observeLiquidity(earlier, { realSolReserves: 4_000_000_000n, ts: 2 }), 60);
  assert.equal(t._observeLiquidity(later, { realSolReserves: 4_000_000_000n, ts: 2 }), 0,
    'later position must not inherit the older position’s peak');
  assert.equal(earlier.lastLiquidityObservation.thresholdPct, 55);
  const restored = Position.fromSnapshot(earlier.snapshot());
  assert.equal(t._observeLiquidity(restored, { realSolReserves: 3_000_000_000n, ts: 3 }), 70,
    'a restart must preserve each open position’s peak');
  assert.equal(t._observeLiquidity(later, { realSolReserves: 3_000_000_000n, ts: 3 }), 25);
}

async function exitSerialization() {
  const p = new Position({ walletId: 'w', mint, symbol: 'TEST',
    entryPrice: 30n, tokensHeld: 1_000_000_000_000n, solSpent: 30_000_000n,
    meta: { simulated: true } });
  const cache = new Map([[mint, {
    price: 30n, virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: curve.INITIAL_VIRTUAL_TOKEN_RESERVES, ts: Date.now(),
  }]]);
  const t = Object.create(Trader.prototype);
  t.cfg = { id: 'w', name: 'Audit paper', buy: { slippageBps: 1000 } };
  t.priceCache = cache;
  t.positions = new Map([[p.id, p]]);
  t.getConfig = () => ({ execution: { priorityFeeMicroLamports: 0 } });
  t._providerFor = () => null;
  let closes = 0;
  t._onPositionClosed = () => { closes += 1; };
  const pending = [];
  t.executor = { dryRun: true, signAndSend: async () => {
    const d = defer(); pending.push(d); return d.promise;
  } };
  const decision = [{ action: 'SELL', tokens: p.tokensHeld, pct: 100, reason: 'liquidity_exit',
    liquidity: { currentLamports: '4', peakLamports: '10', dropPct: 60, thresholdPct: 55 } }];
  const first = t._act(p, decision, {});
  await t._act(p, decision, {});
  const manual = await t.killPosition(p.id);
  assert.equal(manual.error, 'exit_in_progress');
  assert.equal(pending.length, 1, 'only one sell may be submitted for the position');
  pending[0].resolve({ ok: true, signature: 'SIM_ONLY' });
  await first;
  assert.equal(p.realisedTokens, p.originalTokens);
  assert.equal(closes, 1);
  assert.equal(p.exits.length, 1);
  assert.equal(p.exits[0].liquidity.dropPct, 60);
  assert.equal(p.exits[0].proceedsSource, 'paper_curve_quote');
  assert.equal(p.exits[0].tokensSold, p.originalTokens.toString());
  await t._act(p, decision, {});
  assert.equal(pending.length, 1, 'closed position cannot sell again');
}

function durableClosedHistory() {
  const p = new Position({ walletId: 'w', mint, symbol: 'HISTORY',
    entryPrice: 30n, tokensHeld: 100n, solSpent: 10_000n });
  const e = Object.create(Engine.prototype);
  const t = { positions: new Map([[p.id, p]]) };
  e.traders = new Map([['w', t]]);
  e.closedHistory = [];
  p.recordExit({ pctSold: 100, tokensSold: 100n, solReceived: 9_000n,
    reason: 'liquidity_exit', liquidity: { peakLamports: '10000000000',
      currentLamports: '4000000000', dropPct: 60, thresholdPct: 55 } });
  e._recordClosedPosition(p);
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'closed-positions.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].exits[0].liquidity.dropPct, 60);
  assert.equal(t.closedHistory[0].id, p.id);
}

async function observedLiveDelta() {
  const owner = Keypair.generate().publicKey.toBase58();
  const p = new Position({ walletId: 'w', mint, symbol: 'LIVE',
    entryPrice: 30n, tokensHeld: 1_000_000_000_000n, solSpent: 30_000_000n,
    meta: { simulated: false } });
  const t = Object.create(Trader.prototype);
  t.publicKey = owner;
  t.cfg = { id: 'w', name: 'Audit live mock', buy: { slippageBps: 1000 } };
  t.priceCache = new Map([[mint, { virtualSolReserves: 30_000_000_000n,
    virtualTokenReserves: curve.INITIAL_VIRTUAL_TOKEN_RESERVES, ts: Date.now() }]]);
  t.getConfig = () => ({ execution: { priorityFeeMicroLamports: 0 } });
  t._providerFor = () => ({ sell: async () => ({ tx: {} }) });
  let closes = 0;
  t._onPositionClosed = () => { closes += 1; };
  t.executor = { dryRun: false, conn: () => ({ getParsedTransaction: async () => ({
    meta: { preBalances: [100_000_000], postBalances: [129_000_000], err: null },
    transaction: { message: { accountKeys: [{ pubkey: owner }] } },
  }) }), sellWithEscalation: async () => ({ ok: true, signature: 'MOCK_ONLY' }) };
  await t._act(p, [{ action: 'SELL', tokens: p.tokensHeld, pct: 100, reason: 'liquidity_exit' }], {});
  assert.equal(p.realisedSol, 29_000_000n, 'LIVE proceeds follow chain wallet delta, not the curve quote');
  assert.equal(p.exits[0].proceedsSource, 'live_wallet_delta');
  assert.equal(closes, 1);

  // A confirmed signature is not proof that the fill RPC is readable yet.
  // Never silently relabel a quote as an on-chain wallet delta.
  const unread = new Position({ walletId: 'w', mint, symbol: 'UNREAD', entryPrice: 30n,
    tokensHeld: 1_000_000_000_000n, solSpent: 30_000_000n, meta: { simulated: false } });
  t.executor.conn = () => ({});
  await t._act(unread, [{ action: 'SELL', tokens: unread.tokensHeld, pct: 100,
    reason: 'liquidity_exit' }], {});
  assert.equal(unread.exits[0].proceedsSource, 'live_curve_estimate');
  assert.equal(closes, 2);
}

(async () => {
  await pollSerialization();
  independentPeaks();
  await exitSerialization();
  durableClosedHistory();
  await observedLiveDelta();
  console.log('liquidity safety: 5 offline regressions passed');
})().catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true }));
