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
 * reference bot's RiskBadge. It is derived from the two facts every launch
 * carries, so the column is filled for every row instead of only for the ones
 * whose RPC read happened to succeed:
 *
 *   · dev concentration vs the configured ceiling
 *   · liquidity (in dollars) vs the configured floor
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
  const hasLiq = Number.isFinite(row.liquidityUsd);
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

  if (hasLiq && liqFloor > 0 && row.liquidityUsd < liqFloor) {
    // Thin liquidity: the most common way a brand-new launch eats a sniper alive.
    const shortfall = (liqFloor - row.liquidityUsd) / liqFloor; // 0..1+
    score += Math.min(40, Math.round(12 + shortfall * 28));
    notes.push(`liquidity $${Math.round(row.liquidityUsd).toLocaleString('en-US')} below floor $${Math.round(liqFloor).toLocaleString('en-US')}`);
  }

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
       * supply; `vSolInBondingCurve` is the curve's real SOL. Both arrive with the
       * create event, so these two cells are filled on EVERY launch — which is
       * what they are for. An on-chain read (see recon()) refines them a moment
       * later when it succeeds, and is ignored when it does not. */
      devHoldPct: Number.isFinite(Number(candidate.initialBuy)) && candidate.initialBuy !== null
        ? (Number(candidate.initialBuy) / PUMP_FUN_TOTAL_SUPPLY) * 100
        : null,
      liquiditySol: Number.isFinite(candidate.vSolInBondingCurve) ? candidate.vSolInBondingCurve : null,
      liquidityUsd: null,
      // Where each of those came from, so the table can be honest about it.
      facts: {
        devHold: Number.isFinite(Number(candidate.initialBuy)) && candidate.initialBuy !== null ? 'event' : null,
        liquidity: Number.isFinite(candidate.vSolInBondingCurve) ? 'event' : null,
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
   * `solUsd` and `liqSource` ride along so the table can mark a figure that was
   * converted at a last-resort constant instead of a real quote. That is the one
   * place this deliberately differs from the reference bot, which prints its
   * fallback price as though it were live.
   */
  _price(row) {
    if (!Number.isFinite(row.liquiditySol)) { row.liquidityUsd = null; return; }
    /* Ask for a price if we do not have a fresh one. Without this the table would
     * convert at the fallback constant forever: `lastKnown()` never fetches, and
     * nothing else did either. The call is not awaited — a row must never wait on
     * a price API — and the module caches, so this is one request per 20 seconds
     * no matter how many launches arrive. */
    const price = solprice.lastKnown();
    if (price.usd === null || price.stale) solprice.get().catch(() => {});
    /* The figure and its provenance must come from the SAME decision, or the table
     * marks the wrong rows. `lastKnown()` reports `source: 'none'` when no provider
     * has ever answered — and that is precisely the case where the conversion uses
     * the fallback constant, so it is labelled 'fallback' rather than 'none'. Caught
     * live: the row was priced at the fallback and said `none`, which would have
     * shown an invented dollar figure with no marker on it. */
    const never = price.usd === null || price.source === 'none';
    row.solUsd = never ? solprice.FALLBACK_USD : price.usd;
    row.solUsdSource = never ? 'fallback' : price.source;
    row.solUsdStale = Boolean(price.stale);
    row.liquidityUsd = Math.round(row.liquiditySol * row.solUsd);
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

    this._pushWallet(row, evt.wallet, evt.ok === false ? 'filtered' : 'checking', (evt.reasons || [])[0] || null);
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
    if (!row.facts) row.facts = { devHold: null, liquidity: null, risk: null };
    if (r.liquiditySol !== undefined && r.liquiditySol !== null) {
      row.liquiditySol = r.liquiditySol;
      row.facts.liquidity = 'onchain';
    }
    // A curve read that worked is a better basis for the dollar figure.
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
      row.riskScore = row.riskScore === null ? r.honeypot.risk : Math.max(row.riskScore, r.honeypot.risk);
      if (row.facts) row.facts.risk = 'onchain';
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
    this._pushWallet(row, evt.wallet, evt.infra ? 'rpc_error' : 'skipped', reason);
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
    this.stats.bought += 1;
    this._pushWallet(row, row.boughtBy, 'bought', null);
    this._emit(row);
    return row;
  }

  /**
   * Every wallet has finished evaluating. Called by the engine once the evaluation
   * promise settles, because only there is it known whether ANY wallet bought.
   */
  finalize({ mint, outcomes, walletNames }) {
    const row = mint ? this.rows.get(mint) : null;
    if (!row) return null;

    const results = outcomes || [];
    const bought = results.filter((o) => o === 'bought').length;
    if (row.decision === DECISION.BOUGHT || bought > 0) {
      row.decision = DECISION.BOUGHT;
    } else {
      const skips = results.filter((o) => String(o).startsWith('skip:'));
      const infra = skips.some((s) => /rpc_unavailable|eval_timeout/.test(s));
      row.decision = infra ? DECISION.ERROR : DECISION.SKIPPED;
      row.skipReason = infra
        ? 'rpc unavailable or evaluation timed out — infrastructure, not the token'
        : (skips[0] ? String(skips[0]).replace(/^skip:/, '') : 'no wallet was eligible');
      if (infra) this.stats.errors += 1; else this.stats.skipped += 1;
    }
    row.decidedAt = Date.now();
    if (walletNames && !row.wallets.length) {
      row.wallets = walletNames.map((name) => ({ name, action: 'skipped', reason: row.skipReason }));
    }
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

  _pushWallet(row, walletName, action, reason) {
    if (!walletName) return;
    const existing = row.wallets.find((w) => w.name === walletName);
    if (existing) {
      // A later, better-informed verdict supersedes an earlier one.
      if (action !== 'checking') { existing.action = action; existing.reason = reason; }
      return;
    }
    row.wallets.push({ name: walletName, action, reason });
  }

  _trim() {
    if (this.rows.size <= this.max) return;
    const excess = this.rows.size - this.max;
    const keys = [...this.rows.keys()].slice(0, excess);
    for (const k of keys) this.rows.delete(k);
    this.stats.dropped += excess;
  }

  _emit(row) {
    bus.safeEmit('scan:update', row);
  }
}

module.exports = { LiveFeed, DECISION, MAX_ROWS, deriveRisk, PUMP_FUN_TOTAL_SUPPLY };
