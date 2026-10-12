'use strict';
/**
 * The shared duration is a global SETTING; the streak, pause and timestamp are
 * PER WALLET. Expiry never starts a wallet. Only its owner pressing Start/Resume
 * may clear an expired streak. A duration of 0 retains the original UTC-day
 * reset, rather than silently allowing immediate retries.
 */
const MAX_MINUTES = 24 * 60;

function durationMs(global) {
  const n = Number(global?.lossStreakCooldownMinutes);
  return Number.isInteger(n) && n >= 0 && n <= MAX_MINUTES ? n * 60000 : 0;
}

function status(trader, global, now = Date.now()) {
  const stats = trader.stats || {};
  const limit = Number(trader.cfg?.limits?.stopAfterConsecutiveLosses);
  const streak = Number(stats.consecutiveLosses || 0);
  const duration = durationMs(global);
  // A winning close can reset the *streak*, but cannot cancel an already
  // triggered timed stop. Only explicit recovery after expiry clears this latch.
  const tripped = (Number.isFinite(limit) && limit > 0 && streak >= limit) ||
    (duration > 0 && stats.lossCooldownPending === true);
  const startedAt = Number(stats.consecutiveLossCooldownAt);
  const validStart = Number.isFinite(startedAt) && startedAt > 0 && startedAt <= now;
  const until = tripped && duration > 0 && validStart ? startedAt + duration : null;
  return {
    tripped, streak, limit, durationMs: duration,
    startedAt: validStart ? startedAt : null,
    until,
    remainingMs: tripped && duration > 0
      ? (until === null ? duration : Math.max(0, until - now))
      : null,
    ready: tripped && until !== null && now >= until,
  };
}

/** Called only on explicit Start/Resume. If a legacy record has no timestamp,
 * conservatively begin its wait NOW; never bypass a historical loss streak. */
function requireManualRecovery(trader, global, now = Date.now()) {
  let info = status(trader, global, now);
  if (!info.tripped) {
    // In the legacy 0-minute mode, a later winning close still permits the
    // old manual resume behavior; remove its dormant timer on that Start.
    if (info.durationMs === 0 && trader.stats.lossCooldownPending) {
      trader.stats.lossCooldownPending = false;
      trader.stats.consecutiveLossCooldownAt = 0;
    }
    return { ...info, allowed: true, reset: false };
  }
  if (info.durationMs === 0) return { ...info, allowed: false, reset: false };
  if (!info.startedAt) {
    trader.stats.consecutiveLossCooldownAt = now;
    info = status(trader, global, now);
  }
  if (!info.ready) return { ...info, allowed: false, reset: false };
  trader.stats.consecutiveLosses = 0;
  trader.stats.consecutiveLossCooldownAt = 0;
  trader.stats.lossCooldownPending = false;
  return { ...info, allowed: true, reset: true };
}

module.exports = { MAX_MINUTES, durationMs, status, requireManualRecovery };
