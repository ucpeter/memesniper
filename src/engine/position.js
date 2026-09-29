'use strict';
/**
 * Position state machine for a single trade owned by a single wallet.
 *
 * Lifecycle: PENDING -> OPEN -> CLOSING -> CLOSED
 *
 * Money units inside this class are BigInt lamports / token base units.
 * `entryPrice` and `highWaterPrice` are lamports-per-whole-token (BigInt).
 */
const bus = require('../util/events');

let seq = 0;

class Position {
  constructor({ walletId, mint, symbol, name, entryPrice, tokensHeld, solSpent, txSignature, meta = {} }) {
    seq += 1;
    this.id = `pos_${Date.now().toString(36)}_${seq}`;
    this.walletId = walletId;
    this.mint = mint;
    this.symbol = symbol || '???';
    this.name = name || '';
    this.meta = meta;

    this.status = 'OPEN';
    this.openedAt = Date.now();
    this.closedAt = null;

    this.entryPrice = BigInt(entryPrice);
    this.entryTxSignature = txSignature || null;

    /** Tokens bought at open — the baseline for "% of original position" sells. */
    this.originalTokens = BigInt(tokensHeld);
    this.tokensHeld = BigInt(tokensHeld);
    this.solSpent = BigInt(solSpent);

    /** Realised proceeds (SOL lamports) returned to the wallet so far. */
    this.realisedSol = 0n;
    this.realisedTokens = 0n;

    /** Peak price — drives the trailing stop. Only ever ratchets up. */
    this.highWaterPrice = this.entryPrice;

    /** Take-profit tier bookkeeping: index -> { filled, sellPct, gainPct } */
    this.tiers = [];
    /** Audit trail of every exit decision taken on this position. */
    this.exits = [];

    this.stopLevelPct = null; // last computed effective stop (for UI)
    this.lastPrice = this.entryPrice;
    this.lastUpdated = Date.now();
    this.closeTxSignature = null;
    this.exitReason = null;
  }

  /**
   * Plain-JSON snapshot of everything needed to keep managing this position.
   *
   * BigInts become strings because JSON.stringify throws on BigInt — and a
   * position that cannot be written down cannot survive a restart, which for a
   * 24h target is the difference between an exit and a stranded bag.
   */
  snapshot() {
    return {
      id: this.id, walletId: this.walletId, mint: this.mint, symbol: this.symbol, name: this.name,
      meta: this.meta,
      openedAt: this.openedAt,
      entryPrice: this.entryPrice.toString(),
      lastPrice: this.lastPrice.toString(),
      highWaterPrice: this.highWaterPrice.toString(),
      originalTokens: this.originalTokens.toString(),
      tokensHeld: this.tokensHeld.toString(),
      solSpent: this.solSpent.toString(),
      realisedSol: this.realisedSol.toString(),
      realisedTokens: this.realisedTokens.toString(),
      entryTxSignature: this.entryTxSignature,
      tiers: this.tiers,
      exits: this.exits,
    };
  }

  /** Rebuild a position from snapshot(). Caller must set tokensHeld from chain. */
  static fromSnapshot(s) {
    const p = new Position({
      walletId: s.walletId, mint: s.mint, symbol: s.symbol, name: s.name,
      entryPrice: BigInt(s.entryPrice), tokensHeld: BigInt(s.tokensHeld || 0),
      solSpent: BigInt(s.solSpent), txSignature: s.entryTxSignature, meta: s.meta || {},
    });
    p.id = s.id || p.id;
    p.openedAt = s.openedAt || p.openedAt;
    p.originalTokens = BigInt(s.originalTokens || s.tokensHeld || 0);
    p.realisedSol = BigInt(s.realisedSol || 0);
    p.realisedTokens = BigInt(s.realisedTokens || 0);
    p.highWaterPrice = BigInt(s.highWaterPrice || s.entryPrice);
    p.lastPrice = BigInt(s.lastPrice || s.entryPrice);
    if (Array.isArray(s.tiers)) p.tiers = s.tiers;
    if (Array.isArray(s.exits)) p.exits = s.exits;
    return p;
  }

  get isOpen() {
    return this.status === 'OPEN' || this.status === 'CLOSING';
  }

  /** Fraction of the original position still held (0..1 float, display only). */
  get remainingFraction() {
    if (this.originalTokens === 0n) return 0;
    return Number(this.tokensHeld) / Number(this.originalTokens);
  }

  /**
   * Current unrealised + realised P&L in lamports, marked to `lastPrice`.
   *
   * Unit note: tokensHeld is in 6-decimal BASE UNITS while lastPrice is in
   * lamports per WHOLE token, so we divide by 10^6 (token decimals) — not by
   * 10^9. Using the wrong divisor understates position value by 1000x.
   */
  pnlLamports() {
    const unrealised = (this.tokensHeld * this.lastPrice) / 1_000_000n;
    return this.realisedSol + unrealised - this.solSpent;
  }

  pnlPct() {
    if (this.solSpent === 0n) return 0;
    return (Number(this.pnlLamports()) / Number(this.solSpent)) * 100;
  }

  /** P&L from entry price alone — the number exit rules are evaluated against. */
  priceGainPct() {
    if (this.entryPrice === 0n) return 0;
    return (Number(this.lastPrice - this.entryPrice) / Number(this.entryPrice)) * 100;
  }

  /** Peak gain reached — the number the trailing stop is measured from. */
  peakGainPct() {
    if (this.entryPrice === 0n) return 0;
    return (Number(this.highWaterPrice - this.entryPrice) / Number(this.entryPrice)) * 100;
  }

  mark(price, ts = Date.now()) {
    const p = BigInt(price);
    this.lastPrice = p;
    if (p > this.highWaterPrice) this.highWaterPrice = p;
    this.lastUpdated = ts;
  }

  recordExit({ pctSold, tokensSold, solReceived, reason, tier = null, signature = null }) {
    this.realisedSol += BigInt(solReceived);
    this.realisedTokens += BigInt(tokensSold);
    this.tokensHeld -= BigInt(tokensSold);
    if (this.tokensHeld < 0n) this.tokensHeld = 0n;

    this.exits.push({ ts: Date.now(), pctSold, reason, tier, solReceived: solReceived.toString(), signature });

    if (this.tokensHeld === 0n) {
      this.status = 'CLOSED';
      this.closedAt = Date.now();
      this.exitReason = reason;
      this.closeTxSignature = signature;
      bus.safeEmit('position:closed', this);
    }
    bus.safeEmit('position:updated', this);
    return this;
  }

  toJSON() {
    return {
      id: this.id,
      walletId: this.walletId,
      mint: this.mint,
      symbol: this.symbol,
      name: this.name,
      status: this.status,
      adopted: Boolean(this.adopted),
      openedAt: this.openedAt,
      closedAt: this.closedAt,
      entryPrice: this.entryPrice.toString(),
      lastPrice: this.lastPrice.toString(),
      highWaterPrice: this.highWaterPrice.toString(),
      originalTokens: this.originalTokens.toString(),
      tokensHeld: this.tokensHeld.toString(),
      solSpent: this.solSpent.toString(),
      realisedSol: this.realisedSol.toString(),
      pnlLamports: this.pnlLamports().toString(),
      pnlSol: Number(this.pnlLamports()) / 1e9,
      pnlPct: this.pnlPct(),
      priceGainPct: this.priceGainPct(),
      peakGainPct: this.peakGainPct(),
      remainingFraction: this.remainingFraction,
      stopLevelPct: this.stopLevelPct,
      tiers: this.tiers,
      exits: this.exits,
      entryTxSignature: this.entryTxSignature,
      closeTxSignature: this.closeTxSignature,
      exitReason: this.exitReason,
      ageMs: Date.now() - this.openedAt,
      meta: this.meta,
    };
  }
}

module.exports = Position;
