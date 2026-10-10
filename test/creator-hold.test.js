'use strict';
// Offline regression: the curve ATA is not a developer wallet; wallet-specific
// saved limits must veto entries on verified facts, not on the UI's global Risk.
const assert = require('node:assert/strict');
const { Keypair, PublicKey } = require('@solana/web3.js');
const safety = require('../src/engine/safety');
const cfg = require('../src/config');
const price = require('../src/engine/solprice');

const mint = Keypair.generate().publicKey;
const creator = Keypair.generate().publicKey;
const other = Keypair.generate().publicKey;
const supply = 1_000_000_000_000_000n;
const curvePda = safety.bondingCurvePda(mint);
const reserve = safety.curveTokenAccount(mint, curvePda);
const creatorAta = Keypair.generate().publicKey;
const otherAta = Keypair.generate().publicKey;
let realSol = 15_000_000_000n;
let creatorBalance = 20_000_000_000_000n;
let ownersAvailable = true;
let creatorAvailable = true;
let reserveBalance = 700_000_000_000_000n;

function tokenAccount(owner, amount) {
  const data = Buffer.alloc(165);
  mint.toBuffer().copy(data, 0);
  owner.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  return { owner: safety.TOKEN_PROGRAM, data };
}
const conn = {
  getAccountInfo: async (address) => {
    if (address.equals(mint)) {
      const data = Buffer.alloc(82);
      data.writeBigUInt64LE(supply, 36);
      data.writeUInt8(6, 44);
      data.writeUInt8(1, 45);
      return { owner: safety.TOKEN_PROGRAM, data };
    }
    if (address.equals(curvePda)) {
      const data = Buffer.alloc(80);
      data.writeBigUInt64LE(supply, 8);
      data.writeBigUInt64LE(30_000_000_000n, 16);
      data.writeBigUInt64LE(reserveBalance, 24);
      data.writeBigUInt64LE(realSol, 32);
      data.writeBigUInt64LE(supply, 40);
      return { owner: safety.PUMP_PROGRAM, data };
    }
    return null;
  },
  getTokenLargestAccounts: async () => ({ value: [
    { address: reserve, amount: String(reserveBalance) },
    { address: otherAta, amount: '250000000000000' },
    { address: creatorAta, amount: String(creatorBalance) },
  ] }),
  getMultipleAccountsInfo: async (addresses) => ownersAvailable ? addresses.map((address) => {
    if (address.equals(creatorAta)) return tokenAccount(creator, creatorBalance);
    if (address.equals(otherAta)) return tokenAccount(other, 250_000_000_000_000n);
    return null;
  }) : null,
  getTokenAccountsByOwner: async (owner, { mint: requestedMint }) => {
    assert.ok(owner.equals(creator) && requestedMint.equals(mint));
    return creatorAvailable ? { value: [{ account: tokenAccount(creator, creatorBalance) }] } : null;
  },
};
const candidate = { mint: mint.toBase58(), creator: creator.toBase58(), symbol: 'SAFE', initialBuy: 10_000_000 };
const wallet = cfg.normaliseWallet(cfg.deepMerge(cfg.defaultWalletConfig('Creator'), { filters: {
  minLiquidityUsd: 2000, maxDevHoldPct: 20, maxTop10HoldersPct: 35, minHolders: 2,
} }));
const globalConfig = cfg.defaultGlobalConfig();
const verdict = () => safety.evaluate(candidate, wallet, { conn, config: globalConfig });
const test = async (label, fn) => { await fn(); console.log(`  ✓ ${label}`); };

(async () => {
  const oldFetch = global.fetch;
  global.fetch = async () => ({ ok: false }); // offline metadata lookup
  try {
    price.__setPrice(200);
    await test('curve token account excluded; percentages use minted supply', async () => {
      const closeToFullCurve = {
        getTokenLargestAccounts: async () => ({ value: [
          { address: reserve, amount: '970000000000000' },
          { address: otherAta, amount: '20000000000000' },
          { address: creatorAta, amount: '10000000000000' },
        ] }),
        getMultipleAccountsInfo: async () => [
          tokenAccount(other, 20_000_000_000_000n),
          tokenAccount(creator, 10_000_000_000_000n),
        ],
      };
      const report = await safety.checkDistribution(closeToFullCurve, candidate.mint, curvePda, supply);
      assert.equal(report.largestHolderPct, 2);
      assert.equal(report.top10Pct, 3);
      assert.equal(report.top10UpperPct, 3);
    });
    await test('saved $2,000 real SOL floor passes at $3,000; global Risk does not veto', async () => {
      const out = await verdict();
      assert.equal(out.ok, true, JSON.stringify(out.reasons));
      assert.equal(out.report.devHoldPct, 2);
      assert.equal(out.report.openingBuyPct, 1);
      assert.equal(out.report.distribution.top10UpperPct, 30);
      assert.equal(out.report.distribution.uniqueHolderSample, 2);
    });
    await test('high current creator balance hard-blocks even when opening buy is low', async () => {
      creatorBalance = 250_000_000_000_000n;
      const out = await verdict();
      assert.equal(out.ok, false);
      assert.equal(out.hard, true);
      assert.ok(out.reasons.some((r) => r.startsWith('dev_hold_high(25.0%>20%)')), out.reasons.join(','));
      creatorBalance = 20_000_000_000_000n;
    });
    await test('high creator opening buy hard-blocks despite low current holdings', async () => {
      candidate.initialBuy = 300_000_000;
      const out = await verdict();
      assert.equal(out.ok, false);
      assert.ok(out.reasons.some((r) => r.startsWith('dev_opening_buy_high(30.0%>20%)')));
      candidate.initialBuy = 10_000_000;
    });
    await test('unread current creator balance or owner sample fails closed', async () => {
      creatorAvailable = false;
      assert.ok((await verdict()).reasons.includes('dev_hold_unread'));
      creatorAvailable = true;
      ownersAvailable = false;
      assert.ok((await verdict()).reasons.includes('holders_unverified'));
      ownersAvailable = true;
    });
    await test('top-ten lower bound and ambiguous upper bound cannot approve a buy', async () => {
      wallet.filters.maxTop10HoldersPct = 25;
      assert.ok((await verdict()).reasons.some((r) => r.startsWith('top10_concentrated')));
      wallet.filters.maxTop10HoldersPct = 29;
      assert.ok((await verdict()).reasons.includes('top10_unverified'));
      wallet.filters.maxTop10HoldersPct = 35;
      wallet.filters.minHolders = 3;
      assert.ok((await verdict()).reasons.includes('holders_below_min(2<3)'));
      wallet.filters.minHolders = 2;
    });
    await test('the saved real-dollar floor does not compare against virtual reserves', async () => {
      realSol = 8_000_000_000n; // virtual remains 30 SOL ($6,000)
      safety._reportCache.clear();
      const out = await verdict();
      assert.equal(out.ok, false);
      assert.ok(out.reasons.includes('liquidity_below_min_usd($1600<$2000)'), out.reasons.join(','));
      realSol = 15_000_000_000n;
      safety._reportCache.clear();
    });
    await test('unavailable SOL/USD quote cannot satisfy a saved dollar ceiling', async () => {
      price.__reset();
      assert.ok((await verdict()).reasons.includes('sol_usd_quote_unavailable'));
    });
  } finally {
    global.fetch = oldFetch;
    price.__reset();
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
