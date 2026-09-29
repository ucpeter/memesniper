'use strict';
/**
 * pump.fun bonding-curve mathematics.
 *
 * The curve is a constant-product (x*y=k) AMM with virtual reserves:
 *   initialVirtualSolReserves   = 30 SOL
 *   initialVirtualTokenReserves = 1,073,000,000 * 1e6
 *   initialRealTokenReserves    =   793,100,000 * 1e6
 *
 * All arithmetic is BigInt. Token amounts are 6-decimal base units and SOL is
 * lamports, and float64 cannot represent those exactly — rounding drift here
 * would silently mis-price every exit decision, so we never use floats for
 * money in this module.
 */

const LAMPORTS = 1_000_000_000n;
const TOKEN_DECIMALS = 6n;
const ONE_TOKEN = 10n ** TOKEN_DECIMALS;

const INITIAL_VIRTUAL_SOL_RESERVES = 30n * LAMPORTS;
const INITIAL_VIRTUAL_TOKEN_RESERVES = 1_073_000_000n * ONE_TOKEN;
const INITIAL_REAL_TOKEN_RESERVES = 793_100_000n * ONE_TOKEN;
const TOTAL_SUPPLY = 1_000_000_000n * ONE_TOKEN;

/** Migration (graduation) target — real SOL raised before moving to an AMM. */
const MIGRATION_SOL_TARGET = 85n * LAMPORTS;

const BPS = 10_000n;

/** Apply a fee in basis points, rounding down (favours the pool, as on-chain). */
function applyFee(amount, feeBps) {
  return (amount * (BPS - BigInt(feeBps))) / BPS;
}

/**
 * Tokens received for a given SOL input.
 * @returns {bigint} token base units out
 */
function tokensOutForSolIn(solInLamports, vSol, vTok, feeBps = 100) {
  if (solInLamports <= 0n) return 0n;
  const solAfterFee = applyFee(solInLamports, feeBps);
  const k = vSol * vTok;
  const newVSol = vSol + solAfterFee;
  return vTok - k / newVSol;
}

/**
 * SOL received for a given token input.
 * @returns {bigint} lamports out (net of fee)
 */
function solOutForTokensIn(tokenAmount, vSol, vTok, feeBps = 100) {
  if (tokenAmount <= 0n) return 0n;
  const k = vSol * vTok;
  const newVTok = vTok + tokenAmount;
  const gross = vSol - k / newVTok;
  return applyFee(gross, feeBps);
}

/**
 * Spot price in LAMPORTS PER WHOLE TOKEN.
 *
 * Unit derivation (this is worth stating because getting it wrong silently
 * inflates every P&L figure by ~1000x):
 *
 *   vSol   is in lamports
 *   vTok   is in token BASE UNITS (6 decimals)
 *   vSol / vTok          -> lamports per base unit
 *   × 10^6 (ONE_TOKEN)   -> lamports per whole token
 *
 * The entry price stored on a Position is computed the same way, so both sides
 * of every gain calculation share this unit and the ratio is meaningful.
 */
function spotPriceScaled(vSol, vTok) {
  if (vTok === 0n) return 0n;
  return (vSol * ONE_TOKEN) / vTok;
}

/** Market cap in lamports at current reserves (price/whole-token × whole tokens). */
function marketCapLamports(vSol, vTok) {
  return (spotPriceScaled(vSol, vTok) * TOTAL_SUPPLY) / ONE_TOKEN;
}

/** Curve progress 0–100 given real SOL raised. */
function bondingCurvePct(realSolReserves) {
  const pct = (realSolReserves * 100n) / MIGRATION_SOL_TARGET;
  return Number(pct > 100n ? 100n : pct);
}

/**
 * Price impact of a trade, in basis points — used to reject trades whose
 * slippage would be insane before we ever build a transaction.
 */
function priceImpactBps(solInLamports, vSol, vTok) {
  if (vSol === 0n) return 10_000;
  const before = spotPriceScaled(vSol, vTok);
  const solAfter = vSol + solInLamports;
  const out = tokensOutForSolIn(solInLamports, vSol, vTok, 0);
  const vTokAfter = vTok - out;
  if (vTokAfter <= 0n) return 10_000;
  const after = spotPriceScaled(solAfter, vTokAfter);
  if (before === 0n) return 10_000;
  const bps = ((after - before) * BPS) / before;
  return Number(bps < 0n ? 0n : bps);
}

/* ------------------------------------------------------------------ *
 * Working with normalised (float) values for display / P&L only.
 * These never feed transaction construction.
 * ------------------------------------------------------------------ */
const lamportsToSol = (l) => Number(l) / 1e9;
const solToLamports = (s) => BigInt(Math.round(Number(s) * 1e9));
const baseUnitsToTokens = (u) => Number(u) / 1e6;
const tokensToBaseUnits = (t) => BigInt(Math.round(Number(t) * 1e6));

/** Convenience: price in SOL per whole token (display only — never used for money math). */
const pricePerToken = (vSol, vTok) => Number(spotPriceScaled(vSol, vTok)) / 1e9;

module.exports = {
  LAMPORTS,
  ONE_TOKEN,
  BPS,
  TOTAL_SUPPLY,
  INITIAL_VIRTUAL_SOL_RESERVES,
  INITIAL_VIRTUAL_TOKEN_RESERVES,
  INITIAL_REAL_TOKEN_RESERVES,
  MIGRATION_SOL_TARGET,
  tokensOutForSolIn,
  solOutForTokensIn,
  spotPriceScaled,
  marketCapLamports,
  bondingCurvePct,
  priceImpactBps,
  lamportsToSol,
  solToLamports,
  baseUnitsToTokens,
  tokensToBaseUnits,
  pricePerToken,
};
