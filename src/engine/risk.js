'use strict';
/**
 * Risk engine — decides what to do with an open position on every price tick.
 *
 * This is the module that implements the user-facing exit rules:
 *
 *   • stop loss            — hard per-trade loss limit
 *   • trailing stop        — ratchets up with the peak, never down
 *   • break-even stop      — moves the stop above entry once in profit
 *   • tiered partial sells — "sell X% once up Y%", repeatable, gapped-safe
 *   • time stop            — max hold duration
 *   • liquidity exit       — bail if the curve's liquidity collapses
 *
 * Pure functions only: give it a position + config + market state, get back a
 * list of decisions. No I/O, no side effects — so it is trivially testable and
 * can never itself execute a trade.
 *
 * EXIT PRECEDENCE (safety first, then profit):
 *   1. effective stop level  = max(hard SL, break-even floor, trailing level)
 *   2. take-profit tiers     = every unfilled tier whose gain has been reached
 *   3. time stop
 *   4. liquidity exit
 */

/**
 * Compute the effective stop level as a *negative-or-positive % of entry*.
 * The trailing stop is expressed as an absolute floor derived from the peak,
 * then the highest (tightest) of the three candidates wins. Because
 * `highWaterPrice` only ever increases, the trailing floor can only ratchet up.
 */
function effectiveStopPct(position, cfg) {
  const { stopLossPct } = cfg.exits;
  const gain = position.priceGainPct();
  const peak = position.peakGainPct();

  let level = -Math.abs(stopLossPct);

  // Break-even: once we've been up activationPct, never allow a full round-trip.
  if (cfg.exits.breakEven?.enabled && peak >= cfg.exits.breakEven.activationPct) {
    level = Math.max(level, cfg.exits.breakEven.offsetPct);
  }

  // Trailing: floor = peak - trailPct, only once the trail has been activated.
  if (cfg.exits.trailing?.enabled && peak >= cfg.exits.trailing.activationPct) {
    let trailFloor = peak - cfg.exits.trailing.trailPct;
    // Optional step quantisation: only move the stop in `stepPct` increments,
    // which avoids over-tight stops on noisy micro-pumps.
    if (cfg.exits.trailing.stepPct > 0) {
      trailFloor = Math.floor(trailFloor / cfg.exits.trailing.stepPct) * cfg.exits.trailing.stepPct;
    }
    level = Math.max(level, trailFloor);
  }

  return level;
}

/**
 * Which take-profit tiers should fire right now?
 * Returns them highest-gain-first so a gap through several tiers sells the
 * most profitable ones first and the caller can walk the list.
 * `sellPct` is a share of the ORIGINAL position.
 */
function dueTiers(position, cfg) {
  const gain = position.priceGainPct();
  const due = [];
  cfg.exits.takeProfitTiers.forEach((tier, index) => {
    const state = position.tiers[index];
    if (!state || state.filled) return;
    if (gain >= tier.gainPct) due.push({ index, ...tier });
  });
  return due.sort((a, b) => b.gainPct - a.gainPct);
}

/**
 * Decide what to do with `position`.
 *
 * IMPORTANT: sell decisions carry an ABSOLUTE token amount (`tokens`), not a
 * percentage. Several tiers can fire in a single tick, and the caller applies
 * them sequentially — if we returned percentages they would each be measured
 * against a shrinking remainder and every tier after the first would undersell.
 *
 * @returns {Array<{action:'SELL'|'MOVE_STOP'|'HOLD', tokens?:bigint, pct?:number, reason, tier?}>}
 */
function evaluate(position, cfg, market = {}) {
  const decisions = [];
  if (!position.isOpen || position.tokensHeld === 0n) return decisions;

  /* If the price feed is stale/absent we know nothing about the current value,
   * so every price-derived rule (stop, trailing, tiers, liquidity) is skipped —
   * acting on a stale mark could fire a phantom exit. The TIME STOP is
   * deliberately still enforced, because it depends only on how long we have
   * held, and a dead price feed is exactly when a position most needs a way out. */
  if (market.priceStale) {
    const staleAge = Date.now() - position.openedAt;
    if (cfg.exits.maxHoldMs > 0 && staleAge >= cfg.exits.maxHoldMs) {
      decisions.push({ action: 'SELL', tokens: position.tokensHeld, pct: 100, reason: 'time_stop' });
    }
    return decisions;
  }

  const gain = position.priceGainPct();
  const peak = position.peakGainPct();
  const stopLevel = effectiveStopPct(position, cfg);
  position.stopLevelPct = stopLevel;

  /* -------------------- 1. STOP LOSS / TRAILING / BREAK-EVEN ---------------- */
  if (gain <= stopLevel) {
    const trailArmed = cfg.exits.trailing?.enabled && peak >= cfg.exits.trailing.activationPct;
    const trailFloor = trailArmed ? peak - cfg.exits.trailing.trailPct : -Infinity;
    const reason =
      stopLevel <= -Math.abs(cfg.exits.stopLossPct) + 1e-9 ? 'stop_loss'
        : stopLevel > 0 && Math.abs(stopLevel - trailFloor) < 1e-9 ? 'trailing_stop'
          : stopLevel > 0 ? 'break_even'
            : 'trailing_stop';
    decisions.push({ action: 'SELL', tokens: position.tokensHeld, pct: 100, reason, stopLevel });
    // A full exit voids every other rule for this tick.
    return decisions;
  }

  /* ------------------------------ 2. TAKE-PROFIT ---------------------------- */
  const due = dueTiers(position, cfg);
  let remaining = position.tokensHeld;
  for (const tier of due) {
    if (remaining <= 0n) break;
    // `sellPct` is expressed as a share of the ORIGINAL position.
    let tokens = (position.originalTokens * BigInt(Math.round(tier.sellPct * 100))) / 10000n;
    if (tokens <= 0n) continue;

    const drainsPosition = tokens >= remaining;
    if (drainsPosition) tokens = remaining;

    decisions.push({
      action: 'SELL',
      tokens,
      pct: Number((tokens * 10000n) / (position.originalTokens === 0n ? 1n : position.originalTokens)) / 100,
      reason: drainsPosition ? `tp_${tier.gainPct}pct_all` : `tp_${tier.gainPct}pct`,
      tier: tier.index,
    });
    remaining -= tokens;
  }

  /* -------------------------------- 3. TIME STOP ---------------------------- */
  const age = Date.now() - position.openedAt;
  if (cfg.exits.maxHoldMs > 0 && age >= cfg.exits.maxHoldMs) {
    decisions.push({ action: 'SELL', tokens: remaining > 0n ? remaining : position.tokensHeld, pct: 100, reason: 'time_stop' });
    return decisions;
  }

  /* ----------------------------- 4. LIQUIDITY EXIT -------------------------- */
  if (market.liquidityDropPct !== undefined && market.liquidityDropPct >= cfg.exits.liquidityDropExitPct) {
    decisions.push({ action: 'SELL', tokens: remaining > 0n ? remaining : position.tokensHeld, pct: 100, reason: 'liquidity_exit' });
    return decisions;
  }

  return decisions;
}

/* ------------------------------------------------------------------ *
 * Wallet-level guardrails. Evaluated BEFORE every buy, and on every
 * realised trade. These are the "loss limit" the user asked for.
 * ------------------------------------------------------------------ */
function canOpenNewPosition(trader) {
  const { cfg, positions, stats } = trader;

  if (!cfg.enabled) return { ok: false, reason: 'wallet_disabled' };
  if (stats.paused) return { ok: false, reason: `paused:${stats.pauseReason}` };

  const openCount = [...positions.values()].filter((p) => p.isOpen).length;
  if (openCount >= cfg.buy.maxConcurrentPositions) return { ok: false, reason: 'max_concurrent_positions' };

  if (stats.tradesToday >= cfg.limits.maxTradesPerDay) return { ok: false, reason: 'max_trades_per_day' };

  // Daily loss limit — the hard stop.
  if (stats.realisedPnlSol <= -Math.abs(cfg.limits.dailyLossLimitSol)) {
    return { ok: false, reason: 'daily_loss_limit_reached' };
  }
  // Daily profit target (0 = disabled).
  if (cfg.limits.dailyProfitTargetSol > 0 && stats.realisedPnlSol >= cfg.limits.dailyProfitTargetSol) {
    return { ok: false, reason: 'daily_profit_target_reached' };
  }
  if (stats.consecutiveLosses >= cfg.limits.stopAfterConsecutiveLosses) {
    return { ok: false, reason: 'consecutive_loss_circuit_breaker' };
  }

  // Exposure cap: cost of open positions + realised exposure for the day.
  // Uses the trader's own accessor when present so there is a single source of
  // truth for exposure rather than two implementations that can drift.
  const openExposure = typeof trader.openExposureSol === 'function'
    ? trader.openExposureSol()
    : [...positions.values()].filter((p) => p.isOpen).reduce((acc, p) => acc + Number(p.solSpent) / 1e9, 0);
  if (openExposure >= cfg.limits.maxExposureSol) return { ok: false, reason: 'max_exposure_reached' };

  // Cooldown between entries.
  if (trader.lastEntryAt && Date.now() - trader.lastEntryAt < cfg.buy.cooldownMs) {
    return { ok: false, reason: 'cooldown' };
  }

  return { ok: true };
}

/** Global ceiling — enforced across all wallets no matter their config. */
function globalGuardrails(engine, globalCfg) {
  // Defensive: a malformed engine reference must never break the trade
  // pipeline. If we cannot read the portfolio, apply no global ceiling —
  // the per-wallet limits still apply.
  if (!engine || !engine.traders || typeof engine.traders.values !== 'function') {
    return { ok: true, reason: 'no_engine_context' };
  }
  const all = [...engine.traders.values()];
  const totalExposure = all.reduce((acc, t) => acc + t.openExposureSol(), 0);
  const totalDailyPnl = all.reduce((acc, t) => acc + t.stats.realisedPnlSol, 0);

  if (totalExposure >= globalCfg.riskGlobal.maxTotalExposureSol) {
    return { ok: false, reason: 'global_max_exposure' };
  }
  if (globalCfg.riskGlobal.pauseOnDailyLoss && totalDailyPnl <= -Math.abs(globalCfg.riskGlobal.dailyLossLimitSol)) {
    return { ok: false, reason: 'global_daily_loss_limit' };
  }
  return { ok: true };
}

/**
 * Position sizing.
 *   fixed   — random within [min, max] (randomised so parallel snipes don't
 *             create an identical, predictable footprint)
 *   percent — % of current wallet balance
 *   kelly   — scaled by AI conviction, capped by the wallet max
 */
function computePositionSize(cfg, { balanceSol, aiConfidence = null }) {
  const { minAmountSol, maxAmountSol, positionSizeMode, positionSizePercent, kellyFraction } = cfg.buy;
  let size;

  switch (positionSizeMode) {
    case 'percent':
      size = (balanceSol * positionSizePercent) / 100;
      break;
    case 'kelly': {
      const conf = aiConfidence ?? 0.5;
      const edge = Math.max(0, conf - 0.5) * 2; // 0..1
      size = balanceSol * kellyFraction * edge;
      if (size <= 0) size = minAmountSol;
      break;
    }
    case 'fixed':
    default:
      size = minAmountSol + Math.random() * (maxAmountSol - minAmountSol);
      break;
  }

  // Never exceed the configured band, never exceed the wallet's free balance.
  size = Math.min(size, maxAmountSol);
  size = Math.min(size, balanceSol * 0.95);
  return Math.max(0, size);
}

module.exports = { evaluate, effectiveStopPct, dueTiers, canOpenNewPosition, globalGuardrails, computePositionSize };
