'use strict';
/**
 * Engine — orchestration layer.
 *
 * Owns the shared, read-only infrastructure and fans work out to per-wallet
 * Trader instances:
 *
 *   Scanner ──token:detected──▶ Engine ──▶ [TraderA, TraderB, TraderC …]
 *                                            each applies its OWN filters,
 *                                            OWN sizing, OWN risk rules
 *
 *   PricePoller ──▶ priceCache ──▶ Trader.manage() ──▶ exits
 *
 * Nothing here holds per-wallet mutable strategy state — that lives exclusively
 * inside each Trader, which is what makes per-wallet configs actually isolate.
 */
const { PublicKey } = require('@solana/web3.js');
const bus = require('../util/events');
const log = require('../util/logger');
const Scanner = require('./scanner');
const Trader = require('./trader');
const Executor = require('./executor');
const safety = require('./safety');
const curve = require('./curve');
const fs = require('node:fs');
const path = require('node:path');
const configStore = require('../config');

/**
 * Where open positions are written down so a restart can re-adopt them.
 *
 * Lives beside config.json in DATA_DIR, so pointing DATA_DIR at a persistent
 * disk (Render's /var/data) makes recovery survive a redeploy too. Unlike the
 * keystore this file holds no secrets — only mints, sizes and cost basis.
 */
const POSITIONS_PATH = path.join(configStore.DATA_DIR, 'positions.json');

const providers = {
  pumpportal: require('./providers/pumpportal'),
  jupiter: require('./providers/jupiter'),
  direct: require('./providers/direct'),
};

const PRICE_POLL_INTERVAL = Number(process.env.PRICE_POLL_MS || 1200);

class Engine {
  constructor({ config, keystore }) {
    this.config = config;
    this.keystore = keystore;
    this.traders = new Map(); // walletId -> Trader
    this.scanner = new Scanner(config.global);
    this.executor = new Executor(config.global, keystore);
    this.priceCache = new Map(); // mint -> { price, virtualSolReserves, virtualTokenReserves, ts, liquidityDropPct, initialLiquiditySol }
    this.running = false;
    this.priceTimer = null;
    this.priceHealth = { ok: true, consecutiveFailures: 0, lastOkAt: 0, lastError: null, suppressedSince: 0 };
    this._evalQueue = 0;
    this.stats = { detected: 0, evaluated: 0, bought: 0, skipped: 0, infraErrors: 0, evalTimeouts: 0, startedAt: null };
    this.stats.recovered = 0; // positions re-adopted after a restart
    this._persistTimer = null;
    this._persistHooked = false;
    this._resumed = false; // guards persistPositions() against wiping the snapshot
    this._unresolved = {}; // snapshots for wallets whose keys are not loaded yet
    this._persistedAt = 0;
  }

  /* ------------------------------ lifecycle ------------------------------ */
  start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = Date.now();

    const missing = this.config.wallets.filter((c) => !this.keystore.has(c.id));
    if (missing.length) {
      log.warn(`${missing.length} wallet(s) have no key in the keystore — skipping: ${missing.map((c) => c.name).join(', ')}`);
    }
    this.hydrate();

    // The scanner publishes every candidate on the bus; register exactly once.
    bus.on('token:detected', this._onTokenBound = (c) => this._onToken(c));

    this.scanner.start();
    this._startPricePoller();
    this._refreshBalances();

    log.info(`Engine started · ${this.traders.size} wallet(s) loaded${this.executor.dryRun ? ' · 🧪 DRY RUN' : ' · 🔴 LIVE'}`);
    bus.safeEmit('engine:status', this.status());
  }

  stop() {
    this.running = false;
    this.scanner.stop();
    if (this.priceTimer) clearInterval(this.priceTimer);
    if (this._onTokenBound) bus.off('token:detected', this._onTokenBound);
    log.info('Engine stopped');
    bus.safeEmit('engine:status', this.status());
  }

  _provider(globalCfg) {
    const name = process.env.SWAP_PROVIDER || 'pumpportal';
    const p = providers[name];
    if (!p) {
      log.warn(`Unknown provider "${name}" — using pumpportal`);
      return providers.pumpportal;
    }
    return p;
  }

  /* ------------------------------- entry --------------------------------- */
  _onToken(candidate) {
    if (!this.running) return;

    // Bound concurrency — a launch storm must not spawn thousands of in-flight
    // RPC evaluations and rate-limit us into oblivion.
    const max = Math.max(1, this.config.global.scanner.evaluateConcurrency || 2);
    if (this._evalQueue >= max) {
      this.stats.skipped += 1;
      return;
    }

    this._evalQueue += 1;
    this.stats.detected += 1;

    // Hard ceiling on how long one token may hold a slot. Without this, a
    // stalled RPC call leaks the slot forever and the engine quietly stops
    // evaluating new launches — it looks alive while doing nothing at all.
    const EVAL_TIMEOUT_MS = this.config.global.scanner.evalTimeoutMs || 8000;
    const timeout = new Promise((resolve) => {
      const t = setTimeout(() => resolve(['skip:eval_timeout']), EVAL_TIMEOUT_MS);
      if (t.unref) t.unref();
    });

    const evaluation = Promise.all([...this.traders.values()].map((t) => t.consider(candidate, { engine: this })));

    // The timeout exists ONLY to free the queue slot. The underlying evaluation
    // keeps running — and may still buy — so it must own the accounting, or a
    // late fill would go uncounted while the slot reported a "timeout".
    Promise.race([evaluation, timeout]).then((outcome) => {
      if (Array.isArray(outcome) && outcome.includes('skip:eval_timeout')) {
        this.stats.evalTimeouts = (this.stats.evalTimeouts || 0) + 1;
      }
    }).finally(() => { this._evalQueue -= 1; });

    evaluation
      .then((outcomes) => {
        const bought = outcomes.filter((o) => o === 'bought').length;
        this.stats.evaluated += 1;
        this.stats.bought += bought;
        this.stats.skipped += outcomes.filter((o) => o.startsWith('skip:')).length;
        if (bought) bus.safeEmit('engine:stats', this.stats);
      })
      .catch((err) => log.error(`Evaluation pipeline error: ${err.message}`));
  }

  /* ---------------------------- price feed ------------------------------- */
  /**
   * Batched poller: one getMultipleAccounts call covers every open position
   * across every wallet, so adding wallets does not multiply RPC load.
   *
   * For maximum speed on a paid endpoint, replace this with accountSubscribe
   * on the bonding-curve PDAs — the priceCache interface stays identical.
   */
  _startPricePoller() {
    const tick = async () => {
      if (!this.running) return;
      const mints = new Set();
      for (const t of this.traders.values()) {
        for (const p of t.openPositions()) mints.add(p.mint);
      }
      if (mints.size === 0) return;

      try {
        const mintList = [...mints];
        const pdas = mintList.map((m) => safety.bondingCurvePda(m));
        const conn = this.executor.conn();
        const infos = await conn.getMultipleAccountsInfo(pdas, 'confirmed');

        infos.forEach((info, i) => {
          const mint = mintList[i];
          if (!info) return;
          const parsed = safety.parseBondingCurve(info.data);
          if (!parsed) return;

          const price = curve.spotPriceScaled(parsed.virtualSolReserves, parsed.virtualTokenReserves);
          const liquiditySol = Number(parsed.realSolReserves) / 1e9;

          const prev = this.priceCache.get(mint);
          const peakLiquidity = prev ? Math.max(prev.peakLiquiditySol ?? 0, liquiditySol) : liquiditySol;
          const liquidityDropPct = peakLiquidity > 0
            ? Math.max(0, ((peakLiquidity - liquiditySol) / peakLiquidity) * 100)
            : 0;

          this.priceCache.set(mint, {
            price,
            virtualSolReserves: parsed.virtualSolReserves,
            virtualTokenReserves: parsed.virtualTokenReserves,
            realSolReserves: parsed.realSolReserves,
            complete: parsed.complete,
            liquidityDropPct,
            peakLiquiditySol: peakLiquidity,
            ts: Date.now(),
          });
        });

        // Fan out to each wallet's independent risk engine.
        await Promise.all([...this.traders.values()].map((t) => t.manage({ engine: this })));
        bus.safeEmit('prices:updated', mintList.length);
      } catch (err) {
        const h = this.priceHealth;
        h.consecutiveFailures += 1;
        h.ok = false;
        h.lastError = err.message;

        // The price feed is the ONLY thing that can trigger an exit. If it dies,
        // every open position becomes unmanaged — so this must never be a silent
        // debug line the operator never sees. Warn on the way down, then at most
        // once every 30s so a broken RPC cannot flood the console.
        const now = Date.now();
        if (h.consecutiveFailures === 3 || now - h.suppressedSince > 30000) {
          h.suppressedSince = now;
          log.warn(
            `⚠ PRICE FEED DOWN (${h.consecutiveFailures} consecutive failures) — open positions are NOT being marked to market and exits are SUSPENDED. Last error: ${err.message.slice(0, 80)}`,
          );
        }
        // Back off instead of hammering an endpoint that is rate-limiting us.
        await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * h.consecutiveFailures)));
        return;
      }

      if (this.priceHealth.consecutiveFailures > 0) {
        log.info(`Price feed recovered after ${this.priceHealth.consecutiveFailures} failure(s)`);
      }
      this.priceHealth.consecutiveFailures = 0;
      this.priceHealth.ok = true;
      this.priceHealth.lastOkAt = Date.now();
    };

    this.priceTimer = setInterval(tick, PRICE_POLL_INTERVAL);
    if (this.priceTimer.unref) this.priceTimer.unref();
  }

  async _refreshBalances() {
    await Promise.all([...this.traders.values()].map((t) => t.refreshBalance().catch(() => {})));
  }

  /** Periodic housekeeping: prune caches, roll the trading day, refresh balances. */
  startMaintenance() {
    const t = setInterval(async () => {
      this.scanner.prune();
      const recent = Date.now() - 60 * 60 * 1000;
      for (const [mint, entry] of this.priceCache) {
        const held = [...this.traders.values()].some((tr) => tr.byMint.has(mint));
        if (!held && entry.ts < recent) this.priceCache.delete(mint);
      }
      for (const trader of this.traders.values()) {
        trader._rolloverDay();
        await trader.refreshBalance().catch(() => {});
      }
      bus.safeEmit('engine:tick', this.status());
    }, 60_000);
    if (t.unref) t.unref();
    return t;
  }

  /* ------------------------------- control ------------------------------- */
  /**
   * Liquidate everything and hold the door shut.
   *
   * New entries are blocked by PAUSING each wallet — risk.canOpenNewPosition is
   * the single authority on that — while management keeps running so a failed
   * sell can still be retried. This deliberately no longer sets
   * config.global.dryRun = true: it did, and never put it back, so one panic
   * silently converted a live bot into a paper one for the rest of the
   * process's life. Restarting is not a recovery plan for a money bug.
   */
  async panic(reason = 'manual_panic') {
    log.warn(`🚨 PANIC — liquidating all positions (${reason})`);
    const out = await this.killAll(reason);
    for (const t of this.traders.values()) t.pause(`panic: ${reason}`);
    bus.safeEmit('engine:panic', { reason, ts: Date.now(), ...out });
    this.persistPositions();
    return out;
  }

  /**
   * Sell every open position across every wallet, leaving the engine running.
   *
   * This is the "Kill all trades" button: distinct from panic in that nothing
   * is paused afterwards, so the bot keeps sniping the moment you are flat.
   */
  async killAll(reason = 'manual_kill_all') {
    const perWallet = [...this.traders.values()].map(
      (t) => t.closeAll(reason).catch((err) => [{ ok: false, error: err.message }])
    );
    const results = (await Promise.all(perWallet)).flat().filter(Boolean);
    const sold = results.filter((r) => r.ok).length;
    const failed = results.length - sold;
    if (results.length) {
      log.trade(`⛔ KILL ALL (${reason}): ${sold} sold, ${failed} failed${this.executor.dryRun ? ' [SIM]' : ''}`);
    }
    return { attempted: results.length, sold, failed };
  }

  /* ----------------------- restart recovery ----------------------- */

  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.persistPositions();
    }, 750);
    if (this._persistTimer.unref) this._persistTimer.unref();
  }

  /**
   * Write currently-open positions to DATA_DIR.
   *
   * Refuses to write until resume() has run once: hydrate() starts with an
   * empty book, and persisting that would overwrite the very file we need — a
   * restart would then look like "nothing to recover". Snapshots for wallets
   * whose keys are not loaded yet (locked keystore) are carried through
   * untouched for the same reason.
   */
  persistPositions() {
    if (!this._resumed) return 0;
    const wallets = {};
    let n = 0;

    for (const [walletId, snaps] of Object.entries(this._unresolved || {})) {
      if (!this.traders.has(walletId)) { wallets[walletId] = snaps; n += snaps.length; }
    }
    for (const t of this.traders.values()) {
      if (t.cfg.resumeAfterRestart === false) continue;
      const snaps = t.openPositions().map((p) => p.snapshot());
      if (snaps.length) { wallets[t.cfg.id] = snaps; n += snaps.length; }
    }

    try {
      if (!fs.existsSync(configStore.DATA_DIR)) {
        fs.mkdirSync(configStore.DATA_DIR, { recursive: true, mode: 0o700 });
      }
      const tmp = `${POSITIONS_PATH}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), wallets }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, POSITIONS_PATH);
      this._persistedAt = Date.now();
    } catch (err) {
      log.warn(`Could not persist positions to ${POSITIONS_PATH}: ${err.message}`);
    }
    return n;
  }

  /**
   * Re-adopt positions left open by a previous run.
   *
   * Safe to call repeatedly: runs at boot, after the keystore is unlocked, and
   * whenever wallets are added. Wallets whose keys are not loaded are skipped
   * and retried later, never dropped.
   */
  async resume() {
    let file = null;
    try {
      if (fs.existsSync(POSITIONS_PATH)) file = JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
    } catch (err) {
      log.warn(`Could not read ${POSITIONS_PATH} (${err.message}) — starting flat`);
    }

    const wallets = (file && file.wallets) || {};
    this._unresolved = this._unresolved || {};
    const unresolved = {};
    let adopted = 0;

    for (const [walletId, snaps] of Object.entries(wallets)) {
      if (!Array.isArray(snaps)) continue;
      const trader = this.traders.get(walletId);
      if (!trader) { unresolved[walletId] = snaps; continue; } // keys not loaded yet

      let pending = [];
      for (const snap of snaps) {
        try {
          const p = await trader.adoptPosition(snap);
          if (p) adopted += 1;
          else pending.push(snap); // gone from chain, or opted out
        } catch {
          pending.push(snap); // could not verify — do NOT forget it
        }
      }
      if (pending.length) unresolved[walletId] = pending;
    }

    this._unresolved = unresolved;
    this._resumed = true;
    this.stats.recovered = adopted;

    if (adopted) {
      log.warn(`♻ Resumed ${adopted} open position(s) from a previous run — normal exits now manage them`);
      bus.safeEmit('engine:resumed', { adopted });
      // Best-effort: recovering positions is the important part, and a wallet
      // balance we cannot read yet must not abort the recovery itself.
      try { this._refreshBalances(); } catch (err) { log.warn(`Balance refresh after recovery failed: ${err.message}`); }
    } else if (Object.keys(wallets).length) {
      log.info('Position snapshot found, but nothing needed recovering');
    }
    this.persistPositions();
    return adopted;
  }

  /**
   * Build a Trader for every configured wallet whose key is available.
   *
   * Idempotent, and deliberately separate from start(): the engine being
   * "running" governs whether we SCAN and TRADE, but you need to see your
   * wallets — and their addresses, in order to fund them — before that.
   *
   * Trader.init() needs the keypair to derive the public key, so this can only
   * do anything once the keystore is unlocked; call it again after unlocking.
   */
  hydrate() {
    let added = 0;
    for (const cfg of this.config.wallets) {
      if (this.traders.has(cfg.id)) continue;
      if (!this.keystore.has(cfg.id)) continue;

      const trader = new Trader({
        cfg,
        keystore: this.keystore,
        executor: this.executor,
        getConfig: () => ({ ...this.config.global, _defaultProvider: this._provider(this.config.global) }),
        priceCache: this.priceCache,
      });
      trader.init();
      this.traders.set(cfg.id, trader);
      added += 1;
    }
    if (!this._persistHooked) {
      // Any state change on any wallet rewrites the snapshot (debounced). Three
      // events cover open, partial exit and full close.
      this._persistHooked = true;
      const hook = () => this._schedulePersist();
      bus.on('position:opened', hook);
      bus.on('position:updated', hook);
      bus.on('position:closed', hook);
    }

    if (added) {
      // Show real balances/addresses immediately rather than after a Start.
      this._refreshBalances();
      bus.safeEmit('engine:status', this.status());
      bus.safeEmit('wallet:updated', null);
    }
    return added;
  }

  /**
   * Every configured wallet that hydrate() could not build because its key is not
   * loaded, described well enough for the dashboard to show it.
   *
   * A wallet is two things in two places: a RECORD in config.json (name, on-chain
   * address, strategy — not secret) and a KEY in the keystore. Only the key needs
   * the passphrase. Returning nothing for the rest made wallets the user had
   * created look deleted, and made the keystore prompt seem to come from nowhere.
   *
   * `keyLocked` is the flag the dashboard renders on; `balanceSol` is null rather
   * than 0 because unknown and zero are different facts.
   */
  lockedWallets() {
    return this.config.wallets
      .filter((cfg) => !this.traders.has(cfg.id))
      .map((cfg) => ({
        id: cfg.id,
        name: cfg.name,
        publicKey: cfg.publicKey || null,
        enabled: cfg.enabled,
        imported: Boolean(cfg.imported),
        keyLocked: true,
        // "locked" and "gone" are different, and the dashboard words them
        // differently. If the keystore is OPEN and hydrate() still could not build
        // this wallet, then its key is not in the keystore at all — a reset
        // archived it, or it was never generated. Saying "open your keystore to
        // trade again" would then be a lie.
        keyMissing: this.keystore.isUnlocked(),
        balanceSol: null,
        paperBalanceSol: 0,
        paperTrading: false,
        exposureSol: 0,
        config: cfg,
        stats: null, // not persisted anywhere; null is honest, zeroes are not
        openPositions: [],
        recentPositions: [],
        lastEntryAt: null,
      }));
  }

  addWallet(cfg) {
    const trader = new Trader({
      cfg,
      keystore: this.keystore,
      executor: this.executor,
      getConfig: () => ({ ...this.config.global, _defaultProvider: this._provider(this.config.global) }),
      priceCache: this.priceCache,
    });
    trader.init();
    this.traders.set(cfg.id, trader);
    if (this.running) trader.refreshBalance().catch(() => {});
    return trader;
  }

  removeWallet(id) {
    const t = this.traders.get(id);
    if (t) t.closeAll('wallet_removed').catch(() => {});
    this.traders.delete(id);
  }

  status() {
    return {
      running: this.running,
      dryRun: this.executor.dryRun,
      wallets: this.traders.size,
      scanner: {
        source: this.config.global.scanner.source,
        connected: Boolean(this.scanner.ws && this.scanner.ws.readyState === 1),
        detected: this.scanner.stats.detected,
      },
      stats: this.stats,
      priceFeedSize: this.priceCache.size,
      priceFeed: {
        ok: this.priceHealth ? this.priceHealth.ok : true,
        consecutiveFailures: this.priceHealth ? this.priceHealth.consecutiveFailures : 0,
        lastOkAt: this.priceHealth ? this.priceHealth.lastOkAt : 0,
        lastError: this.priceHealth ? this.priceHealth.lastError : null,
      },
      evalQueue: this._evalQueue,
      recoveredPositions: this.stats.recovered || 0,
      positionsPersistedAt: this._persistedAt || 0,
    };
  }
}

module.exports = Engine;
