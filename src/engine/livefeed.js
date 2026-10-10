'use strict';
/**
 * Live launch scanner feed — one row per token the bot has looked at.
 *
 * WHY THIS EXISTS
 * The counters ("detected 1,284 / filtered 46") say how much happened; they do not
 * say WHAT happened or WHY. So when the engine is running and buying nothing, the
 * only honest answer available was "something filtered it". This keeps the actual
 * decisions: every launch that came through the scanner, what the checks found
 * (dev holdings, liquidity, honeypot risk), and what each wallet did about it —
 * bought, or skipped with the reason in words.
 *
 * The shape follows the convention used by the reference sniper this bot was
 * measured against: Token / Dev / Dev hold / Liquidity / Risk / Decision, plus the
 * skip reason underneath the decision.
 *
 * DESIGN
 *  · Bounded ring. A launch storm must not grow memory without limit; the oldest
 *    rows drop off and the newest are always kept.
 *  · One row per MINT, not per wallet. Several wallets evaluate the same launch and
 *    would otherwise produce several identical rows.
 *  · Pure in-memory, no disk: this is a live view, not a record. Trades and
 *    positions are persisted; this is not.
 *  · Emits `scan:update` so the browser can patch a single row instead of
 *    re-rendering the whole table.
 */
const bus = require('../util/events');
const solprice = require('./solprice');

/**
 * pump.fun mints 1,000,000,000 tokens per launch, always — the same constant the
 * reference bot divides by to get dev hold (`initialBuy / 1e9`). The dev's
 * opening buy is reported in TOKENS, so this is the whole calculation.
 */
const PUMP_FUN_TOTAL_SUPPLY = 1_000_000_000;

/** How long a row stays in the ring before it is considered stale. */
const MAX_ROWS = 200;

/** Decisions, in the order they happen for one token. */
const DECISION = {
  CHECKING: 'checking', // detected, evaluation in flight
  BOUGHT: 'bought',     // at least one wallet took it
  SKIPPED: 'skipped',   // every wallet declined
  ERROR: 'error',       // infrastructure failure, not a token verdict
};

/**
 * RISK, 0–100, where **higher means more dangerous** — the same direction as the
 * reference bot's RiskBadge. It uses the event dev holding immediately, and
 * REAL on-chain SOL when available; a clean score remains unread until the
 * actual deposited reserve has been checked:
 *
 *   · dev concentration vs the configured ceiling
 *   · REAL SOL deposited in the curve (in dollars) vs the configured floor.
 * The launch's virtual SOL is useful for price discovery, NOT actual cash
 * backing; it must not be substituted for real deposits when scoring safety.
 *
 * An on-chain honeypot reading, when one arrives, is merged in as a floor: the
 * table shows the worst thing known about the token, never the most reassuring.
 * A row with no facts at all gets `null` — the table prints an explicit "unread"
 * rather than a 0, because "we could not read it" and "we read it, it is perfect"
 * are different answers and only one of them is safe to act on.
 */
function deriveRisk(row, thresholds) {
  const devLimit = thresholds.maxDevHoldPct;
  const liqFloor = thresholds.minLiquidityUsd;

  const hasDev = Number.isFinite(row.devHoldPct);
  // Never accept the compatibility alias (virtual USD) as deposited real SOL.
  const liq = row.realLiquidityUsd;
  const hasLiq = Number.isFinite(liq);
  if (!hasDev && !hasLiq) return { score: null, notes: [] };

  const notes = [];
  let score = 0;

  if (hasDev && devLimit > 0) {
    const over = row.devHoldPct - devLimit;
    if (over > 0) {
      // Scales with how far past the ceiling it is, capped at 45 — the same order
      // of magnitude as the reference bot's own dev-hold penalty.
      score += Math.min(45, Math.round(6 + over * 3));
      notes.push(`dev holds ${row.devHoldPct.toFixed(1)}% (limit ${devLimit}%)`);
    } else if (row.devHoldPct > 0) {
      notes.push(`dev holds ${row.devHoldPct.toFixed(1)}%`);
    }
  }

  if (hasLiq && liqFloor > 0 && liq < liqFloor) {
    // The real SOL is the only reserve the wallet's USD floor actually checks.
    const shortfall = (liqFloor - liq) / liqFloor; // 0..1+
    score += Math.min(40, Math.round(12 + shortfall * 28));
    notes.push(`real SOL backing $${Math.round(liq).toLocaleString('en-US')} below floor $${Math.round(liqFloor).toLocaleString('en-US')}`);
  }

  // A partial event can establish danger, but cannot establish safety. If one
  // required fact is unread, a "0 risk" score would pretend all checks passed.
  if (score === 0 && (!hasDev || !hasLiq)) return { score: null, notes };
  return { score: Math.max(0, Math.min(100, score)), notes };
}

class LiveFeed {
  constructor({ max = MAX_ROWS, globalConfig = () => ({}) } = {}) {
    this.max = max;
    /**
     * Read live rather than captured, so editing the thresholds in the config
     * changes what new rows show without restarting the engine.
     */
    this.globalConfig = globalConfig;
    this.rows = new Map(); // mint -> row (Map keeps insertion order)
    this._bound = false;
    this.stats = { seen: 0, bought: 0, skipped: 0, errors: 0, dropped: 0 };
  }

  /** Start listening to engine events. Safe to call twice. */
  attach() {
    if (this._bound) return this;
    this._bound = true;

    bus.on('token:detected', (c) => this.note(c));
    bus.on('scan:started', (e) => this.start(e));
    bus.on('scan:slow', (e) => this.slow(e));
    bus.on('scan:stalled', (e) => this.stalled(e));
    bus.on('token:stage', (e) => this.stage(e));
    bus.on('token:recon', (e) => this.recon(e));
    bus.on('token:analyzed', (e) => this.analyze(e));
    bus.on('token:skipped', (e) => this.skip(e));
    bus.on('position:opened', (p) => this.bought(p));
    bus.on('scan:final', (e) => this.finalize(e));
    return this;
  }

  /* ------------------------------- writing -------------------------------- */

  /** A launch just arrived from the scanner. */
  note(candidate) {
    if (!candidate || !candidate.mint) return null;
    if (this.rows.has(candidate.mint)) return this.rows.get(candidate.mint);

    const row = {
      mint: candidate.mint,
      symbol: candidate.symbol || '',
      name: candidate.name || '',
      devWallet: candidate.creator || candidate.traderPublicKey || null,
      /* Derived from the launch event, not from an RPC.
       *
       * `initialBuy` is the dev's opening buy in tokens against a fixed 1e9
       * supply; `vSolInBondingCurve` is VIRTUAL SOL (~30 SOL at launch), not
       * SOL deposited by buyers. Keep the event's virtual reserve separate from
       * on-chain real SOL, or simply starting a wallet changes the meaning of
       * the displayed liquidity from ~$4,500 to ~$7 for the SAME token. */
      devHoldPct: Number.isFinite(Number(candidate.initialBuy)) && candidate.initialBuy !== null
        ? (Number(candidate.initialBuy) / PUMP_FUN_TOTAL_SUPPLY) * 100
        : null,
      virtualLiquiditySol: Number.isFinite(candidate.vSolInBondingCurve) ? candidate.vSolInBondingCurve : null,
      virtualLiquidityUsd: null,
      realLiquiditySol: null,
      realLiquidityUsd: null,
      // Compatibility for existing feed clients: primary displayed figure is
      // VIRTUAL SOL; real SOL is separately and explicitly labelled.
      liquiditySol: Number.isFinite(candidate.vSolInBondingCurve) ? candidate.vSolInBondingCurve : null,
      liquidityUsd: null,
      // Where each of those came from, so the table can be honest about it.
      facts: {
        devHold: Number.isFinite(Number(candidate.initialBuy)) && candidate.initialBuy !== null ? 'event' : null,
        liquidity: Number.isFinite(candidate.vSolInBondingCurve) ? 'virtual_event' : null,
        realLiquidity: null,
        risk: null,
      },
      riskScore: null,
      riskNotes: [],
      decision: DECISION.CHECKING,
      skipReason: null,
      wallets: [],           // per-wallet verdicts: { name, action, reason }
      detectedAt: candidate.detectedAt || Date.now(),
      decidedAt: null,
      marketCapSol: candidate.marketCapSol ?? null,
    };

    this._price(row);
    this._score(row);

    this.rows.set(candidate.mint, row);
    this.stats.seen += 1;
    this._trim();
    this._emit(row);
    return row;
  }

  /**
   * Liquidity in dollars, which is the form a human can judge.
   *
   * `solUsd` and `solUsdSource` ride along so the table can mark a figure that was
   * converted at a last-resort constant instead of a real quote. That is the one
   * place this deliberately differs from the reference bot, which prints its
   * fallback price as though it were live.
   */
  _price(row) {
    const hasVirtual = Number.isFinite(row.virtualLiquiditySol);
    const hasReal = Number.isFinite(row.realLiquiditySol);
    if (!hasVirtual && !hasReal) {
      row.liquiditySol = row.liquidityUsd = null;
      row.virtualLiquidityUsd = row.realLiquidityUsd = null;
      return;
    }
    /* Fetch asynchronously and share the cached SOL quote across all launches. */
    const price = solprice.lastKnown();
    if (price.usd === null || price.stale) solprice.get().catch(() => {});
    const never = price.usd === null || price.source === 'none';
    row.solUsd = never ? solprice.FALLBACK_USD : price.usd;
    row.solUsdSource = never ? 'fallback' : price.source;
    row.solUsdStale = Boolean(price.stale);
    row.virtualLiquidityUsd = hasVirtual ? Math.round(row.virtualLiquiditySol * row.solUsd) : null;
    row.realLiquidityUsd = hasReal ? Math.round(row.realLiquiditySol * row.solUsd) : null;
    row.liquiditySol = row.virtualLiquiditySol;
    row.liquidityUsd = row.virtualLiquidityUsd;
  }

  /** Risk, from whatever is known right now. */
  _score(row) {
    const g = this.globalConfig() || {};
    const risk = g.risk || {};
    const thresholds = {
      maxDevHoldPct: Number(risk.maxDevHoldPct ?? 15),
      minLiquidityUsd: Number(risk.minLiquidityUsd ?? 2000),
    };
    const { score, notes } = deriveRisk(row, thresholds);
    if (score === null) return;
    row.riskScore = row.riskScore === null ? score : Math.max(row.riskScore, score);
    row.riskNotes = [...new Set([...(row.riskNotes || []), ...notes])];
    if (row.facts) row.facts.risk = row.facts.risk || 'derived';
  }

  /**
   * The deterministic checks finished for one wallet.
   *
   * Every wallet runs its own filters against the same launch, so this carries the
   * shared facts (liquidity, dev holdings, honeypot risk) plus this wallet's verdict.
   */
  analyze(evt) {
    const row = evt && evt.candidate ? this.rows.get(evt.candidate.mint) : null;
    if (!row) return null;

    this._mergeFacts(row, evt.report || {});
    void evt;

    this._pushWallet(row, evt.wallet, evt.ok === false ? 'filtered' : 'checking', (evt.reasons || [])[0] || null, evt.walletId);
    this._emit(row);
    return row;
  }

  /**
   * The shared facts about a launch, from whoever read them first.
   *
   * This is separate from any wallet's verdict on purpose. The table's Dev hold
   * and Risk columns are facts about the TOKEN; they used to arrive only when an
   * armed wallet ran its filters, so a launch seen while every wallet was stopped
   * showed two empty columns. `token:recon` now delivers them for every launch.
   */
  recon(evt) {
    const row = evt && evt.candidate ? this.rows.get(evt.candidate.mint) : null;
    if (!row) return null;
    this._mergeFacts(row, evt.report || {});
    this._emit(row);
    return row;
  }

  /**
   * Merge one report into a row, without overwriting a real number with a blank.
   *
   * Reports arrive at different depths — a token rejected on mint authorities
   * never reaches the curve, and a failed distribution read returns nothing —
   * so "later report wins" would erase good data with null.
   */
  _mergeFacts(row, r) {
    if (!row.facts) row.facts = { devHold: null, liquidity: null, realLiquidity: null, risk: null };
    if (r.virtualLiquiditySol !== undefined && r.virtualLiquiditySol !== null &&
        !Number.isFinite(row.virtualLiquiditySol)) {
      row.virtualLiquiditySol = r.virtualLiquiditySol;
      row.facts.liquidity = 'virtual_onchain';
    }
    if (r.liquiditySol !== undefined && r.liquiditySol !== null) {
      row.realLiquiditySol = r.liquiditySol;
      row.facts.realLiquidity = 'real_onchain';
    }
    // Never replace the virtual launch figure with real SOL: they are different
    // numbers and starting/stopping the bot must not change a column's meaning.
    this._price(row);
    if (r.devHoldPct !== undefined && r.devHoldPct !== null) {
      row.devHoldPct = r.devHoldPct;
      row.facts.devHold = 'onchain';
    }
    if (r.honeypot && typeof r.honeypot.risk === 'number') {
      // Highest risk seen wins: one wallet's stricter view must not be masked by
      // another's more permissive one.
      // The worst known signal wins: a honeypot that reads clean does not
      // cancel a dev holding half the supply.
      // A clean honeypot read is only one check: without a real-SOL read it
      // cannot claim this launch is zero-risk (or clear the wallet's floor).
      if (r.honeypot.risk > 0 || row.riskScore !== null) {
        row.riskScore = row.riskScore === null ? r.honeypot.risk : Math.max(row.riskScore, r.honeypot.risk);
        if (row.facts) row.facts.risk = 'onchain';
      }
      if (Array.isArray(r.honeypot.notes)) {
        row.riskNotes = [...new Set([...(row.riskNotes || []), ...r.honeypot.notes])];
      }
      for (const n of r.honeypot.notes || []) if (!row.riskNotes.includes(n)) row.riskNotes.push(n);
    }
    if (r.top10Pct !== undefined && r.top10Pct !== null) row.top10Pct = r.top10Pct;
    if (r.progressPct !== undefined && r.progressPct !== null) row.curvePct = r.progressPct;

    /* Score AGAIN, now that the facts are better.
     *
     * This is the bug that made the RISK column read 0 on the live table: a launch
     * whose create event carries no curve data scored against `null` liquidity, came
     * out 0, and kept that 0 when the on-chain read filled the liquidity in a moment
     * later. Eleven of nineteen rows in one live run were wrong this way — a column
     * that looks alive and means nothing, which is worse than the blank cell it
     * replaced, because a blank cell is visibly missing.
     *
     * `_score` only ever raises the number (Math.max), so re-running it cannot undo a
     * worse earlier reading. */
    this._score(row);
  }

  /** One wallet declined this launch, with its reason. */
  skip(evt) {
    const row = evt && evt.candidate ? this.rows.get(evt.candidate.mint) : null;
    if (!row) return null;
    const reason = (evt.reasons || [])[0] || 'filters';
    this._pushWallet(row, evt.wallet, evt.infra ? 'rpc_error' : 'skipped', reason, evt.walletId);
    if (evt.infra) {
      row.decision = DECISION.ERROR;
      row.skipReason = 'rpc unavailable — this is infrastructure, not the token';
    } else if (row.decision === DECISION.CHECKING) {
      row.decision = DECISION.SKIPPED;
      row.skipReason = reason;
    }
    this._emit(row);
    return row;
  }

  /** A wallet actually took a position. */
  bought(position) {
    const row = position ? this.rows.get(position.mint) : null;
    if (!row) return null;
    row.decision = DECISION.BOUGHT;
    row.skipReason = null;
    row.decidedAt = Date.now();
    // `wallet` is the name, `walletId` the key. Prefer the name: the row already
    // has one entry per wallet from token:analyzed keyed by name, and keying this
    // one by id listed the same wallet twice under two different labels.
    row.boughtBy = position.wallet || position.walletId || null;
    row.boughtById = position.walletId || null;
    this.stats.bought += 1;
    this._pushWallet(row, row.boughtBy, 'bought', null, position.walletId);
    this._emit(row);
    return row;
  }

  /** The engine admitted a token to the entry queue for these wallets only. */
  start({ mint, walletNames = [], walletIds = [] }) {
    const row = mint ? this.rows.get(mint) : null;
    if (!row) return null;
    walletNames.forEach((name, i) => this._pushWallet(row, name, 'checking', null, walletIds[i]));
    this._emit(row);
    return row;
  }

  /** Progress is informational, not a verdict or permission to trade. */
  stage({ candidate, walletId, wallet, stage }) {
    const row = candidate?.mint ? this.rows.get(candidate.mint) : null;
    if (!row) return null;
    const entry = row.wallets.find((w) => walletId && w.walletId
      ? w.walletId === walletId : w.name === wallet);
    if (entry && ['checking', 'slow'].includes(entry.action)) {
      entry.stage = stage;
      this._emit(row);
    }
    return row;
  }

  /** A slow read or in-flight submission is NOT a confirmed skip or buy. */
  slow({ mint, walletNames = [], walletIds = [] }) {
    const row = mint ? this.rows.get(mint) : null;
    if (!row || row.decidedAt) return row;
    walletNames.forEach((name, i) => {
      const mine = row.wallets.find((w) => walletIds[i] && w.walletId
        ? w.walletId === walletIds[i] : w.name === name);
      if (!mine || mine.action === 'checking') {
        this._pushWallet(row, name, 'slow', 'Still processing; an order may be pending. Check positions before retrying.', walletIds[i]);
      }
    });
    this._emit(row);
    return row;
  }

  /** An unresolved evaluation is UNKNOWN, not an indefinite "evaluating". */
  stalled({ mint, walletNames = [], walletIds = [] }) {
    const row = mint ? this.rows.get(mint) : null;
    if (!row || row.decidedAt) return row;
    walletNames.forEach((name, i) => {
      const entry = row.wallets.find((w) => walletIds[i] && w.walletId
        ? w.walletId === walletIds[i] : w.name === name);
      if (entry && ['checking', 'slow'].includes(entry.action)) {
        this._pushWallet(row, name, 'unconfirmed',
          'No final result received; buy status unknown. Check wallet holdings before retrying.', walletIds[i]);
        entry.pendingFinal = true; // a late REAL result may still replace this warning
      }
    });
    if (row.wallets.some((w) => w.pendingFinal)) {
      row.decision = DECISION.ERROR;
      row.skipReason = 'evaluation unresolved — check wallet holdings; not a confirmed buy or skip';
      this._emit(row);
    }
    return row;
  }

  /** End EACH wallet's "evaluating" state even if it returned before the
   * on-chain checks, a buy failed, or one wallet threw. Never report an
   * unconfirmed submission as a verified skip or a verified purchase. */
  finalize({ mint, outcomes, walletNames, walletIds }) {
    const row = mint ? this.rows.get(mint) : null;
    if (!row) return null;
    const results = outcomes || [];
    (walletNames || []).forEach((name, i) => {
      const outcome = String(results[i] || 'error:no_verdict');
      const id = walletIds?.[i] || null;
      const mine = row.wallets.find((w) => id && w.walletId ? w.walletId === id : w.name === name);
      let action = 'error', reason = 'Evaluation ended without a confirmed verdict. Check wallet holdings.';
      if (outcome === 'bought') { action = 'bought'; reason = null; }
      else if (outcome.startsWith('skip:')) {
        const code = outcome.slice(5);
        if (/rpc_unavailable/.test(code)) {
          action = 'rpc_error'; reason = 'RPC unavailable; token not verified.';
        } else if (code === 'eval_timeout') {
          action = 'timed_out'; reason = 'Evaluation timed out before a new buy could be submitted.';
        } else {
          action = 'skipped'; reason = code;
        }
      } else if (outcome.startsWith('buy_unconfirmed:')) {
        action = 'unconfirmed';
        reason = 'Buy submitted, confirmation unavailable. Check transaction and wallet; no managed position recorded.';
      } else if (outcome.startsWith('buy_failed')) {
        action = 'unconfirmed';
        reason = 'No confirmed buy recorded. Check wallet holdings before retrying.';
      } else if (outcome.startsWith('buy_error') || outcome.startsWith('error:')) {
        action = 'unconfirmed';
        reason = 'Buy status unknown after an error. Check wallet holdings before retrying.';
      }
      // The on-chain filter event already carried a more precise reason. A
      // terminal decision from token:skipped/position:opened wins over a generic
      // final skip; only unsettled 'checking'/'slow' entries need a new verdict.
      if (!mine || mine.action === 'checking' || mine.action === 'slow' || mine.pendingFinal || action === 'bought') {
        this._pushWallet(row, name, action, reason, id);
        if (mine) delete mine.pendingFinal;
      }
      if (action === 'unconfirmed' && outcome.startsWith('buy_unconfirmed:')) {
        const sig = outcome.slice('buy_unconfirmed:'.length);
        const entry = row.wallets.find((w) => id && w.walletId ? w.walletId === id : w.name === name);
        if (entry && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) entry.txSignature = sig;
      }
    });

    const bought = row.decision === DECISION.BOUGHT || results.includes('bought');
    if (bought) {
      row.decision = DECISION.BOUGHT;
      row.skipReason = null;
    } else {
      const issues = row.wallets.filter((w) => ['rpc_error', 'timed_out', 'unconfirmed', 'error'].includes(w.action));
      row.decision = issues.length ? DECISION.ERROR : DECISION.SKIPPED;
      row.skipReason = issues.length
        ? (issues[0].action === 'rpc_error' ? 'rpc unavailable — infrastructure, not the token' : issues[0].reason)
        : (row.wallets[0]?.reason || String(results[0] || 'no wallet was eligible').replace(/^skip:/, ''));
      if (issues.length) this.stats.errors += 1; else this.stats.skipped += 1;
    }
    row.decidedAt = Date.now();
    this._emit(row);
    return row;
  }

  /* ------------------------------- reading -------------------------------- */

  /** Newest first — the order the user reads it in. */
  snapshot(limit = 60) {
    return [...this.rows.values()].slice(-limit).reverse();
  }

  get size() {
    return this.rows.size;
  }

  clear() {
    this.rows.clear();
  }

  /* ------------------------------- internals ------------------------------ */

  _pushWallet(row, walletName, action, reason, walletId = null) {
    if (!walletName) return;
    const existing = row.wallets.find((w) => walletId && w.walletId
      ? w.walletId === walletId : !w.walletId && w.name === walletName);
    if (existing) {
      // A later, better-informed verdict supersedes an earlier one.
      if (walletId) existing.walletId = walletId;
      if (action !== 'checking') { existing.action = action; existing.reason = reason; }
      return;
    }
    row.wallets.push({ name: walletName, walletId, action, reason });
  }

  _trim() {
    if (this.rows.size <= this.max) return;
    // A launch whose wallet is still processing must remain traceable even in
    // a launch storm. Evict older completed/public-only rows first. Once the
    // 45s watchdog marks it unknown it is eligible for normal eviction; if ALL
    // rows are pending we still enforce the hard memory bound.
    const newestMint = [...this.rows.keys()].at(-1);
    for (const [mint, row] of this.rows) {
      if (this.rows.size <= this.max) break;
      if (mint === newestMint) continue; // a new launch should not be evicted on arrival
      if (row.wallets.some((w) => w.action === 'checking' || w.action === 'slow')) continue;
      this.rows.delete(mint);
      this.stats.dropped += 1;
    }
    for (const mint of this.rows.keys()) {
      if (this.rows.size <= this.max) break;
      this.rows.delete(mint);
      this.stats.dropped += 1;
    }
  }

  _emit(row) {
    bus.safeEmit('scan:update', row);
  }
}

module.exports = { LiveFeed, DECISION, MAX_ROWS, deriveRisk, PUMP_FUN_TOTAL_SUPPLY };
