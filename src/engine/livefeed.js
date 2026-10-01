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

/** How long a row stays in the ring before it is considered stale. */
const MAX_ROWS = 200;

/** Decisions, in the order they happen for one token. */
const DECISION = {
  CHECKING: 'checking', // detected, evaluation in flight
  BOUGHT: 'bought',     // at least one wallet took it
  SKIPPED: 'skipped',   // every wallet declined
  ERROR: 'error',       // infrastructure failure, not a token verdict
};

class LiveFeed {
  constructor({ max = MAX_ROWS } = {}) {
    this.max = max;
    this.rows = new Map(); // mint -> row (Map keeps insertion order)
    this._bound = false;
    this.stats = { seen: 0, bought: 0, skipped: 0, errors: 0, dropped: 0 };
  }

  /** Start listening to engine events. Safe to call twice. */
  attach() {
    if (this._bound) return this;
    this._bound = true;

    bus.on('token:detected', (c) => this.note(c));
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
      devHoldPct: null,
      liquiditySol: null,
      liquidityUsd: null,
      riskScore: null,
      riskNotes: [],
      decision: DECISION.CHECKING,
      skipReason: null,
      wallets: [],           // per-wallet verdicts: { name, action, reason }
      detectedAt: candidate.detectedAt || Date.now(),
      decidedAt: null,
      marketCapSol: candidate.marketCapSol ?? null,
    };

    this.rows.set(candidate.mint, row);
    this.stats.seen += 1;
    this._trim();
    this._emit(row);
    return row;
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

    const r = evt.report || {};
    // The report is only filled where the check got far enough to produce it — a
    // token rejected on mint authorities never reaches the curve. Never overwrite a
    // real number with null from a later, shallower report.
    if (r.liquiditySol !== undefined && r.liquiditySol !== null) row.liquiditySol = r.liquiditySol;
    if (r.devHoldPct !== undefined && r.devHoldPct !== null) row.devHoldPct = r.devHoldPct;
    if (r.honeypot && typeof r.honeypot.risk === 'number') {
      // Highest risk seen wins: one wallet's stricter view must not be masked by
      // another's more permissive one.
      row.riskScore = row.riskScore === null ? r.honeypot.risk : Math.max(row.riskScore, r.honeypot.risk);
      for (const n of r.honeypot.notes || []) if (!row.riskNotes.includes(n)) row.riskNotes.push(n);
    }
    if (r.top10Pct !== undefined && r.top10Pct !== null) row.top10Pct = r.top10Pct;
    void evt;

    this._pushWallet(row, evt.wallet, evt.ok === false ? 'filtered' : 'checking', (evt.reasons || [])[0] || null);
    this._emit(row);
    return row;
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

module.exports = { LiveFeed, DECISION, MAX_ROWS };
