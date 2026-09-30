'use strict';
/**
 * Trader — ONE instance per wallet. This is the multi-wallet isolation boundary.
 *
 * Each Trader owns:
 *   • its own config object (cloned, never shared by reference)
 *   • its own positions map
 *   • its own daily stats, loss counters and pause state
 *   • its own cooldown clock
 *
 * Wallets share only read-only infrastructure (RPC connections, the scanner
 * bus, the price cache). A wallet that hits its daily loss limit is paused
 * without touching any other wallet.
 */
const { PublicKey } = require('@solana/web3.js');
const bus = require('../util/events');
const log = require('../util/logger');
const Position = require('./position');
const risk = require('./risk');
const safety = require('./safety');
const ai = require('./ai');
const curve = require('./curve');

const todayKey = () => new Date().toISOString().slice(0, 10);

class Trader {
  constructor({ cfg, keystore, executor, getConfig, priceCache }) {
    this.cfg = cfg;
    this.keystore = keystore;
    this.executor = executor;
    this.getConfig = getConfig;
    this.priceCache = priceCache;

    this.positions = new Map(); // positionId -> Position
    this.byMint = new Map(); // mint -> positionId  (one position per mint per wallet)
    this.stats = cfg.stats || {
      day: todayKey(), tradesToday: 0, realisedPnlSol: 0,
      consecutiveLosses: 0, wins: 0, losses: 0, paused: false, pauseReason: null,
    };
    this.lastEntryAt = 0;
    this.publicKey = null;
    this.balanceSol = 0; // real on-chain balance (always truthful)
    this.paperBalanceSol = 0; // notional, dry-run only
    this.balanceKnown = false; // false = last read failed; do not trust the number
    this._rolloverDay();
  }

  /* ------------------------------ lifecycle ------------------------------ */
  init() {
    const kp = this.keystore.getKeypair(this.cfg.id);
    this.publicKey = kp.publicKey.toBase58();
    return this.publicKey;
  }

  _rolloverDay() {
    const today = todayKey();
    if (this.stats.day !== today) {
      // Only announce a genuine rollover, not first-run initialisation.
      if (this.stats.day !== null && this.stats.day !== undefined) {
        log.info('New trading day — resetting daily counters', { wallet: this.cfg.name });
      }
      this.stats = {
        day: today, tradesToday: 0, realisedPnlSol: 0,
        consecutiveLosses: 0, wins: this.stats.wins, losses: this.stats.losses,
        paused: false, pauseReason: null,
      };
    }
  }

  /** True while the executor is in dry-run / paper mode. */
  get isPaperTrading() {
    return Boolean(this.executor && this.executor.dryRun);
  }

  /**
   * The balance that sizing is allowed to spend.
   *
   * In dry run an unfunded wallet would otherwise size every position to zero
   * and never trade, which makes paper trading useless for validating the exit
   * rules. So dry run falls back to a NOTIONAL balance — surfaced separately as
   * `paperBalanceSol` so the real balance is never misrepresented.
   */
  effectiveBalanceSol() {
    if (!this.isPaperTrading) return this.balanceSol;
    const notional = (this.getConfig().dryRunBalanceSol) ?? 10;
    return Math.max(this.balanceSol, notional);
  }

  refreshBalance() {
    if (!this.publicKey) return Promise.resolve(null);
    return this.executor
      .getBalanceSol(this.publicKey)
      .then((b) => {
        this.balanceSol = b;
        this.balanceKnown = true;
        this.paperBalanceSol = this.isPaperTrading ? this.effectiveBalanceSol() : 0;
        return b;
      })
      .catch(() => {
        // Keep the last known value rather than overwriting it with a fantasy 0.
        // `balanceKnown` lets the entry path refuse to trade on a stale number
        // instead of misreading an RPC failure as an empty wallet.
        this.balanceKnown = false;
        return null;
      });
  }

  openExposureSol() {
    let sum = 0;
    for (const p of this.positions.values()) if (p.isOpen) sum += Number(p.solSpent) / 1e9;
    return sum;
  }

  openPositions() {
    return [...this.positions.values()].filter((p) => p.isOpen);
  }

  /* -------------------------------- entry -------------------------------- */
  /**
   * Called for every detected token. Runs the full gate stack for THIS wallet.
   * Returns a short string describing the outcome, for logging/telemetry.
   */
  async consider(candidate, ctx) {
    const g = this.getConfig();

    /* 1 — never double-enter the same mint from this wallet. Checked first
     *     because it is the most specific reason and should not be masked by
     *     the generic cooldown throttle below. */
    if (this.byMint.has(candidate.mint)) return 'skip:already_held';

    /* 2 — wallet-level guardrails (cooldown, exposure, loss limits, …) */
    const gate = risk.canOpenNewPosition(this);
    if (!gate.ok) {
      this.stats.skipped = (this.stats.skipped || 0) + 1;
      return `skip:${gate.reason}`;
    }
    const globalGate = risk.globalGuardrails(ctx.engine, g);
    if (!globalGate.ok) return `skip:${globalGate.reason}`;

    /* 3 — deterministic safety filters */
    const verdict = await safety.evaluate(candidate, this.cfg, { conn: this.executor.conn(), config: g });
    // Publish what the checks actually found, pass or fail. The live scanner view
    // shows dev holdings, liquidity and honeypot risk per launch; without this a row
    // could only ever say "skipped", which is the least useful half of the story.
    {
      const rep = verdict.report || {};
      const curveRep = rep.curveReport || {};
      const dist = rep.distribution || {};
      bus.safeEmit('token:analyzed', {
        walletId: this.cfg.id,
        wallet: this.cfg.name,
        candidate,
        ok: verdict.ok,
        hard: Boolean(verdict.hard),
        score: verdict.score,
        reasons: verdict.reasons || [],
        report: {
          liquiditySol: curveRep.liquiditySol ?? null,
          devHoldPct: rep.devHoldPct ?? null,
          top10Pct: dist.top10Pct ?? null,
          holderSample: dist.holderSample ?? null,
          honeypot: rep.honeypot || null,
        },
      });
    }
    if (!verdict.ok) {
      // An unreachable RPC is our problem, not the token's — say so, count it
      // separately, and do not disguise it as a normal filter rejection.
      if (verdict.infra) {
        // Count it on the engine (via ctx — the Trader has no engine ref) and on
        // this wallet, so "0 buys" is attributable to the RPC at a glance.
        const eng = ctx && ctx.engine;
        if (eng && eng.stats) eng.stats.infraErrors = (eng.stats.infraErrors || 0) + 1;
        this.stats.infraErrors = (this.stats.infraErrors || 0) + 1;
        log.warn(`RPC unavailable while evaluating ${candidate.symbol || candidate.mint.slice(0, 6)}: ${verdict.reasons.join(', ')} — check your RPC endpoint and rate limits`, { wallet: this.cfg.name });
        bus.safeEmit('token:skipped', { walletId: this.cfg.id, wallet: this.cfg.name, candidate, reasons: verdict.reasons, infra: true });
        return 'skip:rpc_unavailable';
      }
      log.debug(`Filtered ${candidate.symbol || candidate.mint.slice(0, 6)}: ${verdict.reasons.join(', ')}`, { wallet: this.cfg.name });
      this.stats.skipped = (this.stats.skipped || 0) + 1;
      bus.safeEmit('token:skipped', { walletId: this.cfg.id, wallet: this.cfg.name, candidate, reasons: verdict.reasons, hard: verdict.hard });
      return `skip:${verdict.reasons[0] || 'filters'}`;
    }

    /* 4 — AI veto layer (can only veto, never size up) */
    const aiResult = await ai.review(candidate, verdict.report, g.ai, this.cfg.ai);
    if (aiResult.verdict !== 'allow') {
      log.debug(`AI vetoed ${candidate.symbol || candidate.mint.slice(0, 6)}: ${aiResult.primaryRisk || aiResult.detail}`, { wallet: this.cfg.name });
      bus.safeEmit('token:skipped', { walletId: this.cfg.id, wallet: this.cfg.name, candidate, reasons: [`ai:${aiResult.primaryRisk || aiResult.detail}`], hard: false });
      return `skip:ai_${aiResult.primaryRisk || aiResult.detail}`;
    }

    /* 5 — size it */
    await this.refreshBalance();
    // In live mode an unreadable balance must not be treated as spendable, nor
    // as empty. Refuse the trade, but say why, so it is never misreported as
    // "insufficient balance".
    if (!this.isPaperTrading && this.balanceKnown === false) {
      return 'skip:balance_unknown';
    }
    const spendable = this.effectiveBalanceSol();
    if (spendable <= 0.002) return 'skip:insufficient_balance';

    const sizeSol = risk.computePositionSize(this.cfg, {
      balanceSol: spendable,
      aiConfidence: aiResult.confidence,
    });
    if (sizeSol <= 0.001) return 'skip:size_too_small';

    /* 6 — execute */
    return this._executeBuy(candidate, sizeSol, verdict.report, aiResult);
  }

  async _executeBuy(candidate, sizeSol, report, aiResult) {
    const g = this.getConfig();
    const mint = candidate.mint;

    try {
      const curveReserves = report.curveReport?.curve;
      if (!curveReserves) return 'skip:no_curve_data';

      const solLamports = curve.solToLamports(sizeSol);
      const expectedTokens = curve.tokensOutForSolIn(
        solLamports, curveReserves.virtualSolReserves, curveReserves.virtualTokenReserves
      );
      if (expectedTokens <= 0n) return 'skip:zero_expected_tokens';

      // Apply slippage tolerance to get the on-chain minimum we will accept.
      const minTokens = (expectedTokens * BigInt(10000 - this.cfg.buy.slippageBps)) / 10000n;

      const provider = this._providerFor(g);
      let result;

      if (this.executor.dryRun) {
        result = await this.executor.signAndSend({
          walletId: this.cfg.id,
          tx: { dry: true },
          label: `BUY ${sizeSol.toFixed(3)} SOL → ${candidate.symbol || mint.slice(0, 6)}`,
          simulate: { tokensOut: expectedTokens, solIn: solLamports },
        });
      } else {
        const built = await provider.buy({
          conn: this.executor.conn(),
          publicKey: this.publicKey,
          mint,
          solAmount: sizeSol,
          solLamports: solLamports.toString(),
          tokenAmount: minTokens,
          maxSolLamports: solLamports,
          slippageBps: this.cfg.buy.slippageBps,
          priorityFeeSol: Number(g.execution.priorityFeeMicroLamports) / 1e6,
          priorityFeeMicroLamports: g.execution.priorityFeeMicroLamports,
          computeUnitLimit: g.execution.computeUnitLimit,
          creator: candidate.creator,
        });
        result = await this.executor.signAndSend({
          walletId: this.cfg.id,
          tx: built.tx,
          label: `BUY ${sizeSol.toFixed(3)} SOL → ${candidate.symbol || mint.slice(0, 6)}`,
        });
      }

      if (!result.ok) {
        bus.safeEmit('trade:failed', { walletId: this.cfg.id, side: 'buy', mint, error: result.error });
        return `buy_failed:${result.error}`;
      }

      // Actual fill: in live mode read it from chain, otherwise use the curve estimate.
      let tokensHeld = expectedTokens;
      let solSpent = solLamports;
      if (!this.executor.dryRun && result.signature) {
        const fill = await this._readFill(result.signature, mint, this.publicKey);
        if (fill) { tokensHeld = fill.tokensOut; solSpent = fill.solIn; }
      }

      const entryPrice = (solSpent * 1_000_000n) / (tokensHeld === 0n ? 1n : tokensHeld);

      const position = new Position({
        walletId: this.cfg.id,
        mint,
        symbol: candidate.symbol,
        name: candidate.name,
        entryPrice,
        tokensHeld,
        solSpent,
        txSignature: result.signature,
        meta: {
          creator: candidate.creator,
          aiConfidence: aiResult?.confidence ?? null,
          aiReasoning: aiResult?.reasoning ?? null,
          safetyScore: report ? (report.score ?? null) : null,
          devHoldPct: report?.devHoldPct ?? null,
          detectedAt: candidate.detectedAt,
          source: candidate.source,
        },
      });

      // Seed the tier state machine so partials are tracked per position.
      position.tiers = this.cfg.exits.takeProfitTiers.map((t) => ({ ...t, filled: false }));

      this.positions.set(position.id, position);
      this.byMint.set(mint, position.id);
      this.lastEntryAt = Date.now();
      this.stats.tradesToday += 1;

      log.trade(
        `🟢 BOUGHT ${candidate.symbol || mint.slice(0, 6)} · ${sizeSol.toFixed(3)} SOL · ` +
        `${curve.baseUnitsToTokens(tokensHeld).toLocaleString()} tokens${this.executor.dryRun ? ' [SIM]' : ''}`,
        { wallet: this.cfg.name }
      );
      bus.safeEmit('position:opened', position.toJSON());
      return 'bought';
    } catch (err) {
      log.error(`Buy threw for ${mint.slice(0, 8)}: ${err.message}`, { wallet: this.cfg.name });
      return `buy_error:${err.message}`;
    }
  }

  /** Read realised fill amounts out of a confirmed transaction. */
  async _readFill(signature, mint, owner) {
    try {
      const tx = await this.executor.conn().getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx?.meta) return null;
      const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
      const idx = keys.indexOf(owner);
      if (idx === -1) return null;
      const solIn = BigInt(tx.meta.preBalances[idx] - tx.meta.postBalances[idx]);
      const tokensOut = await this.executor.getTokenBalanceRaw(new PublicKey(owner), new PublicKey(mint));
      return { solIn: solIn > 0n ? solIn : 0n, tokensOut };
    } catch {
      return null;
    }
  }

  /* -------------------------------- exits -------------------------------- */
  /**
   * Evaluate risk rules for every open position and act.
   * Called on each price tick from the engine's poller.
   */
  async manage(ctx) {
    if (!this.cfg.enabled) return;
    const g = this.getConfig();

    for (const position of this.openPositions()) {
      const price = this.priceCache.get(position.mint);
      if (!price) {
        // No mark available: still let price-independent rules (the time stop)
        // run, so a dead feed does not silently disable every exit.
        const fallback = risk.evaluate(position, this.cfg, { priceStale: true });
        if (fallback.length) await this._act(position, fallback, ctx);
        continue;
      }

      position.mark(price.price, price.ts);

      if (price.liquidityDropPct !== undefined) {
        const decisions = risk.evaluate(position, this.cfg, { liquidityDropPct: price.liquidityDropPct });
        if (decisions.length) await this._act(position, decisions, ctx);
      } else {
        const decisions = risk.evaluate(position, this.cfg, {});
        if (decisions.length) await this._act(position, decisions, ctx);
      }
    }
  }

  async _act(position, decisions, ctx) {
    const g = this.getConfig();

    for (const d of decisions) {
      if (d.action === 'HOLD') continue;

      if (d.action === 'SELL') {
        // Risk returns ABSOLUTE token amounts so sequential tier fills in the
        // same tick each get their full intended size.
        const sellTokens = d.tokens ?? (d.pct >= 100
          ? position.tokensHeld
          : (position.tokensHeld * BigInt(Math.round(d.pct * 100))) / 10000n);

        if (sellTokens <= 0n) continue;
        if (sellTokens > position.tokensHeld) continue;

        const price = this.priceCache.get(position.mint);
        const expectedSol = price
          ? curve.solOutForTokensIn(sellTokens, price.virtualSolReserves, price.virtualTokenReserves)
          : 0n;

        const label = `SELL ${d.pct >= 100 ? '100' : d.pct.toFixed(0)}% ${position.symbol} (${d.reason})`;
        const provider = this._providerFor(g);

        let res;
        if (this.executor.dryRun) {
          res = await this.executor.signAndSend({
            walletId: this.cfg.id, tx: { dry: true }, label,
            simulate: { solOut: expectedSol, tokensIn: sellTokens },
          });
        } else {
          res = await this.executor.sellWithEscalation({
            walletId: this.cfg.id,
            tokenAmountRaw: sellTokens,
            baseSlippageBps: this.cfg.buy.slippageBps,
            label,
            buildSell: ({ slippageBps }) => provider.sell({
              conn: this.executor.conn(),
              publicKey: this.publicKey,
              mint: position.mint,
              tokenAmount: sellTokens.toString(),
              tokenAmountRaw: sellTokens.toString(),
              minSolLamports: (expectedSol * BigInt(10000 - slippageBps)) / 10000n,
              slippageBps,
              priorityFeeSol: Number(g.execution.priorityFeeMicroLamports) / 1e6,
              priorityFeeMicroLamports: g.execution.priorityFeeMicroLamports,
              computeUnitLimit: g.execution.computeUnitLimit,
              creator: position.meta?.creator,
            }),
          });
        }

        if (!res.ok) {
          // Leave the tier unfilled so the rule re-fires on the next tick.
          log.error(`Exit failed for ${position.symbol} (${d.reason}) — will retry next tick`, { wallet: this.cfg.name });
          bus.safeEmit('trade:failed', { walletId: this.cfg.id, side: 'sell', mint: position.mint, error: res.error, reason: d.reason });
          continue;
        }

        const pctSold = Number(sellTokens) / Number(position.originalTokens) * 100;
        const wasFullExit = sellTokens >= position.tokensHeld;

        position.recordExit({
          pctSold,
          tokensSold: sellTokens,
          solReceived: expectedSol,
          reason: d.reason,
          tier: d.tier ?? null,
          signature: res.signature,
        });

        if (d.tier !== undefined && d.tier !== null && position.tiers[d.tier]) {
          position.tiers[d.tier].filled = true;
        }

        const gain = position.priceGainPct();
        log.trade(
          `🔴 SOLD ${pctSold.toFixed(1)}% ${position.symbol} @ ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% ` +
          `· ${(Number(expectedSol) / 1e9).toFixed(4)} SOL · ${d.reason}${this.executor.dryRun ? ' [SIM]' : ''}`,
          { wallet: this.cfg.name }
        );

        if (wasFullExit) {
          // Resolve every remaining tier: the position is gone, so any tier
          // that did not fire was superseded by a better exit.
          for (const t of position.tiers) {
            if (!t.filled) { t.filled = true; t.superseded = true; }
          }
          this._onPositionClosed(position);
        }
        bus.safeEmit('position:exited', { position: position.toJSON(), decision: d, signature: res.signature });
      }
    }
    void ctx;
  }

  /** Update daily P&L, streaks and circuit breakers when a position fully closes. */
  _onPositionClosed(position) {
    const pnlSol = Number(position.pnlLamports()) / 1e9;
    this.stats.realisedPnlSol += pnlSol;

    if (pnlSol >= 0) {
      this.stats.wins += 1;
      this.stats.consecutiveLosses = 0;
    } else {
      this.stats.losses += 1;
      this.stats.consecutiveLosses += 1;
    }

    this.byMint.delete(position.mint);

    // Circuit breakers — pause the wallet, never the whole engine.
    const lim = this.cfg.limits;
    if (this.stats.realisedPnlSol <= -Math.abs(lim.dailyLossLimitSol)) {
      this.pause(`daily_loss_limit (${this.stats.realisedPnlSol.toFixed(3)} SOL)`);
    } else if (lim.dailyProfitTargetSol > 0 && this.stats.realisedPnlSol >= lim.dailyProfitTargetSol) {
      this.pause(`daily_profit_target (+${this.stats.realisedPnlSol.toFixed(3)} SOL)`);
    } else if (this.stats.consecutiveLosses >= lim.stopAfterConsecutiveLosses) {
      this.pause(`${this.stats.consecutiveLosses} consecutive losses`);
    }

    log.info(
      `Closed ${position.symbol}: ${pnlSol >= 0 ? '+' : ''}${pnlSol.toFixed(4)} SOL ` +
      `(${position.exitReason}) · day ${this.stats.realisedPnlSol >= 0 ? '+' : ''}${this.stats.realisedPnlSol.toFixed(4)} SOL`,
      { wallet: this.cfg.name }
    );
    bus.safeEmit('wallet:stats', this.toJSON());
  }

  pause(reason) {
    this.stats.paused = true;
    this.stats.pauseReason = reason;
    log.warn(`⏸  Wallet paused: ${reason}`, { wallet: this.cfg.name });
    bus.safeEmit('wallet:paused', { walletId: this.cfg.id, wallet: this.cfg.name, reason });
  }

  resume() {
    this.stats.paused = false;
    this.stats.pauseReason = null;
    log.info('▶️  Wallet resumed', { wallet: this.cfg.name });
    bus.safeEmit('wallet:resumed', { walletId: this.cfg.id });
  }

  /**
   * Force-close everything this wallet holds — Flatten, Panic or Kill all.
   *
   * This MUST go through the same provider sell path as a normal exit. An
   * earlier version called signAndSend({ tx: { dry: … } }), which was wrong in
   * both modes: in dry-run it booked a 100% fill for tokens that were never
   * sold (the board showed a closed trade while the bag was still on chain),
   * and live it tried to sign a plain object, so the throw was swallowed by the
   * caller's .catch() and every panic silently did nothing at all.
   */
  async closeAll(reason = 'manual') {
    const out = [];
    for (const p of this.openPositions()) out.push(await this.killPosition(p.id, reason));
    return out;
  }

  /**
   * Market-sell one position immediately, at whatever price is on offer.
   *
   * This is the Kill button. It is deliberately not routed through the risk
   * rules: no tier, no trailing stop, no "wait for a better fill" — you asked
   * for it flat, so it tries hard to get flat and reports honestly if it
   * could not.
   */
  async killPosition(positionId, reason = 'manual_kill') {
    const position = this.positions.get(positionId);
    if (!position) return { ok: false, error: 'position_not_found' };
    if (position.status === 'CLOSED' || position.tokensHeld <= 0n) {
      return { ok: false, error: 'already_closed' };
    }

    const g = this.getConfig();
    const tokens = position.tokensHeld;
    const price = this.priceCache.get(position.mint);
    const expectedSol = price
      ? curve.solOutForTokensIn(tokens, price.virtualSolReserves, price.virtualTokenReserves)
      : 0n;
    const label = `KILL ${position.symbol} (${reason})`;

    let res;
    if (this.executor.dryRun) {
      res = await this.executor.signAndSend({
        walletId: this.cfg.id, tx: { dry: true }, label,
        simulate: { solOut: expectedSol, tokensIn: tokens },
      });
    } else {
      // Start above the wallet's normal slippage: a kill is an exit at any
      // price, so a tight min-out is exactly the wrong instinct here.
      const baseSlippageBps = Math.max(this.cfg.buy.slippageBps, 1500);
      res = await this.executor.sellWithEscalation({
        walletId: this.cfg.id,
        tokenAmountRaw: tokens,
        baseSlippageBps,
        label,
        buildSell: ({ slippageBps }) => this._providerFor(g).sell({
          conn: this.executor.conn(),
          publicKey: this.publicKey,
          mint: position.mint,
          tokenAmount: tokens.toString(),
          tokenAmountRaw: tokens.toString(),
          minSolLamports: (expectedSol * BigInt(10000 - Math.min(slippageBps, 9999))) / 10000n,
          slippageBps,
          priorityFeeSol: Number(g.execution.priorityFeeMicroLamports) / 1e6,
          priorityFeeMicroLamports: g.execution.priorityFeeMicroLamports,
          computeUnitLimit: g.execution.computeUnitLimit,
          creator: position.meta?.creator,
        }),
      });
    }

    if (!res.ok) {
      // Say so, loudly. A kill that quietly did nothing is worse than no button.
      log.error(`❌ KILL FAILED for ${position.symbol}: ${res.error}`, { wallet: this.cfg.name });
      bus.safeEmit('trade:failed', { walletId: this.cfg.id, side: 'sell', mint: position.mint, error: res.error, reason });
      return res;
    }

    const solReceived = res.fill?.solOut ?? expectedSol;
    position.recordExit({
      pctSold: (Number(tokens) / Number(position.originalTokens)) * 100,
      tokensSold: tokens,
      solReceived,
      reason,
      tier: null,
      signature: res.signature,
    });
    for (const t of position.tiers) if (!t.filled) { t.filled = true; t.superseded = true; }
    this._onPositionClosed(position);

    log.trade(
      `⛔ KILLED ${position.symbol} · ${(Number(solReceived) / 1e9).toFixed(4)} SOL · ${reason}` +
      `${this.executor.dryRun ? ' [SIM]' : ''}`,
      { wallet: this.cfg.name }
    );
    bus.safeEmit('position:exited', {
      position: position.toJSON(), decision: { action: 'SELL', pct: 100, reason }, signature: res.signature,
    });
    return res;
  }

  /**
   * Re-adopt a position this wallet still holds, from a snapshot left by a
   * previous run (see config.resumeAfterRestart).
   *
   * The on-chain balance is the source of truth, never the file: we adopt what
   * is actually in the wallet, and if the read fails we adopt NOTHING rather
   * than assume the bag is gone — a transport blip must not erase a live
   * position that a 24h target is waiting on.
   */
  async adoptPosition(snap) {
    if (!snap || !snap.mint) return null;
    if (this.cfg.resumeAfterRestart === false) return null;
    if (this.byMint.has(snap.mint)) return null;

    let held;
    try {
      held = await this.executor.getTokenBalanceRawOrThrow(this.publicKey, snap.mint);
    } catch (err) {
      log.warn(
        `Could not verify ${snap.symbol || snap.mint} on chain (${err.message}) — keeping the snapshot for the next attempt`,
        { wallet: this.cfg.name }
      );
      throw err;
    }
    if (held <= 0n) return null; // genuinely empty: already sold, nothing to manage

    const p = Position.fromSnapshot(snap);
    p.tokensHeld = held; // chain wins
    if (p.tokensHeld > p.originalTokens) p.originalTokens = p.tokensHeld;
    p.status = 'OPEN';
    if (!p.lastPrice || p.lastPrice === 0n) p.lastPrice = p.entryPrice;
    p.adopted = true;

    this.positions.set(p.id, p);
    this.byMint.set(p.mint, p.id);

    log.warn(
      `♻ RESUMED ${p.symbol} from a previous run — ${(Number(held) / 1e6).toFixed(2)} tokens held, ` +
      `entry ${(Number(p.entryPrice) / 1e6).toFixed(8)} SOL/token`,
      { wallet: this.cfg.name }
    );
    bus.safeEmit('position:adopted', p.toJSON());
    return p;
  }

  _providerFor(g) {
    return g._providers?.[this.cfg.id] || g._defaultProvider;
  }

  toJSON() {
    return {
      id: this.cfg.id,
      name: this.cfg.name,
      publicKey: this.publicKey,
      enabled: this.cfg.enabled,
      imported: Boolean(this.cfg.imported), // true = user-supplied key, not a generated burner
      balanceSol: this.balanceSol,
      paperBalanceSol: this.isPaperTrading ? this.effectiveBalanceSol() : 0,
      paperTrading: this.isPaperTrading,
      exposureSol: this.openExposureSol(),
      config: this.cfg,
      stats: this.stats,
      openPositions: this.openPositions().map((p) => p.toJSON()),
      recentPositions: [...this.positions.values()].slice(-25).reverse().map((p) => p.toJSON()),
      lastEntryAt: this.lastEntryAt,
    };
  }
}

module.exports = Trader;
