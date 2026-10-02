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
const { LiveFeed } = require('./livefeed');
const solprice = require('./solprice');
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

    /* The launch-scanner feed the dashboard shows.
     *
     * It lives HERE, on the engine, for one reason: it subscribes to the same
     * process bus the scanner publishes on, so it must be created exactly once,
     * next to the scanner. It used to be created nowhere — the class and its
     * tests were fine, but nothing ever attached it, so `/api/scan` answered
     * from an undefined property and the panel stayed empty while the counters
     * climbed. Attaching it here is what makes the panel and the counters agree:
     * every launch the scanner detects now produces exactly one row.
     */
    /* The thresholds are HANDED TO the feed, not defaulted inside it. Without this
     * the feed scored every launch against an empty config: no liquidity floor, no
     * dev-hold ceiling, so `deriveRisk` returned 0 for every row on the table. The
     * column looked alive and meant nothing — which is a worse failure than the
     * blank cell it replaced, because a blank cell is visibly missing. */
    this.liveFeed = new LiveFeed({ globalConfig: () => this.config.global }).attach();
    this.priceCache = new Map(); // mint -> { price, virtualSolReserves, virtualTokenReserves, ts, liquidityDropPct, initialLiquiditySol }
    this.running = false;
    this.priceTimer = null;
    this.priceHealth = { ok: true, consecutiveFailures: 0, lastOkAt: 0, lastError: null, suppressedSince: 0 };
    this._evalQueue = 0;
    // The scanner table's own read pass — see _recon(). Kept separate from the
    // entry queue so a stopped wallet does not empty the table.
    this._reconQueue = 0;
    this._reconSeen = new Set();
    this.stats = { detected: 0, evaluated: 0, bought: 0, skipped: 0, infraErrors: 0, evalTimeouts: 0, startedAt: null };
    this.stats.recovered = 0; // positions re-adopted after a restart
    this._persistTimer = null;
    this._persistHooked = false;
    this._resumed = false; // guards persistPositions() against wiping the snapshot
    // Balances for wallets whose KEY we do not have. Read-only, public data.
    this._lockedBalances = new Map();
    this._unresolved = {}; // snapshots for wallets whose keys are not loaded yet
    this._persistedAt = 0;
  }

  /* ------------------------------ lifecycle ------------------------------ */
  /** Public launch feed only. Never loads keys, arms a wallet or trades. */
  startScanner() {
    if (!this._onTokenBound) {
      this._onTokenBound = (c) => this._onToken(c);
      bus.on('token:detected', this._onTokenBound);
    }
    this.scanner.start();
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = Date.now();

    const missing = this.config.wallets.filter((c) => !this.keystore.has(c.id));
    if (missing.length) {
      log.warn(`${missing.length} wallet(s) have no key in the keystore — skipping: ${missing.map((c) => c.name).join(', ')}`);
    }
    this.hydrate();

    // Shares the already-running read-only launch feed. Only the explicitly
    // started wallet/engine path below can place orders.
    this.startScanner();
    this._startPricePoller();
    this._refreshBalances();
    this.refreshLockedBalances().catch(() => {});
    /* Keep a SOL/USD rate warm while the engine runs, so the launch table can price
     * its rows in dollars the moment they arrive rather than after its first launch.
     * One request every 60 seconds; failures are the price module's business. */
    this._startSolPriceWarmup();

    log.info(`Engine started · ${this.traders.size} wallet(s) loaded${this.executor.dryRun ? ' · 🧪 DRY RUN' : ' · 🔴 LIVE'}`);
    bus.safeEmit('engine:status', this.status());
  }

  stop() {
    this.running = false;
    // Stop wallet evaluation, not the public launch stream.
    // The live home feed stays connected even after an engine stop.
    if (this.priceTimer) clearInterval(this.priceTimer);
    if (this._priceTimer) { clearInterval(this._priceTimer); this._priceTimer = null; }
    log.info('Wallet evaluation stopped; launch feed still running');
    bus.safeEmit('engine:status', this.status());
  }

  /**
   * Read balances for every configured wallet the engine has no key for.
   *
   * One batched RPC call, and nothing is done with the result but displayed. This
   * is what stops a locked wallet's card from saying "locked" where its SOL should
   * be — the user's own question ("is my money still there?") is answerable from
   * the address alone, so it is answered.
   */
  async refreshLockedBalances() {
    const pending = this.config.wallets.filter((c) => !this.traders.has(c.id) && c.publicKey);
    if (!pending.length) return 0;
    const conn = this.executor.conn();
    if (!conn || typeof conn.getMultipleAccountsInfo !== 'function') return 0;

    // One unusable address must not silence the whole read: a wallet record with a
    // malformed address is skipped, and the others are still measured.
    const { PublicKey } = require('@solana/web3.js');
    const usable = [];
    for (const cfg of pending) {
      try {
        usable.push({ cfg, key: new PublicKey(cfg.publicKey) });
      } catch {
        this._lockedBalances.delete(cfg.id);
      }
    }
    if (!usable.length) return 0;

    let read = 0;
    try {
      const infos = await conn.getMultipleAccountsInfo(usable.map((u) => u.key));
      usable.forEach(({ cfg }, i) => {
        const info = infos[i];
        if (!info) return; // no account: the address really holds nothing
        this._lockedBalances.set(cfg.id, Number(info.lamports) / 1e9);
        read += 1;
      });
    } catch (err) {
      // A failed read is not a zero balance. Leave what was last read, or null.
      log.debug(`Locked-wallet balance read failed: ${err.message}`);
    }
    return read;
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
    // Most pump.fun creates already include BOTH facts needed by the public
    // feed. Sending two RPC requests for every launch saturated public nodes,
    // and duplicated the wallet evaluation's own on-chain reads. Recon only
    // when the event actually omitted a fact; never hide a missing read as 0.
    if (candidate.initialBuy == null || candidate.vSolInBondingCurve == null) this._recon(candidate);
    if (!this.running) return;

    // Fill in what the launch actually IS before anything can decide whether to
    // skip it. Deliberately the first thing here, and deliberately outside the
    // entry queue below: the table has to show dev hold, liquidity and risk for a
    // launch even when every wallet is stopped or the entry queue is saturated —
    // which is exactly the moment a human is staring at the table.
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
        // Close the live-feed row for this launch. This is the only place that
        // knows the verdict of EVERY wallet, which is what separates "every wallet
        // declined" from "one of them took it".
        bus.safeEmit('scan:final', {
          mint: candidate.mint,
          outcomes,
          walletNames: [...this.traders.values()].map((t) => t.cfg.name),
          walletIds: [...this.traders.keys()],
        });
        if (bought) bus.safeEmit('engine:stats', this.stats);
      })
      .catch((err) => log.error(`Evaluation pipeline error: ${err.message}`));
  }

  /**
   * Read the token's own facts — liquidity, dev hold, honeypot risk — for the
   * scanner table.
   *
   * Once per mint only if the create event omitted dev/liquidity facts,
   * best-effort and bounded. It cannot buy or refuse anything. It shares the
   * per-mint report cache with wallet evaluations.
   */
  _recon(candidate) {
    if (!candidate || !candidate.mint) return;
    if (this._reconSeen.has(candidate.mint)) return;

    const max = Math.max(1, this.config.global.scanner.reconConcurrency || 2);
    if (this._reconQueue >= max) return; // shed load rather than pile up

    this._reconSeen.add(candidate.mint);
    // Bounded memory: a long session must not accumulate every mint it has seen.
    if (this._reconSeen.size > 2000) {
      const keep = [...this._reconSeen].slice(-500);
      this._reconSeen = new Set(keep);
    }

    this._reconQueue += 1;
    safety.recon(candidate, { conn: this.executor.conn(), config: this.config.global })
      .then((out) => {
        bus.safeEmit('token:recon', {
          candidate,
          report: out.report || {},
          infra: Boolean(out.infra),
          reason: out.reason || null,
        });
      })
      .catch((err) => log.debug(`Recon failed for ${candidate.mint}: ${err.message}`))
      .finally(() => { this._reconQueue -= 1; });
  }

  /* ---------------------------- price feed ------------------------------- */
  /**
   * Batched poller: one getMultipleAccounts call covers every open position
   * across every wallet, so adding wallets does not multiply RPC load.
   *
   * For maximum speed on a paid endpoint, replace this with accountSubscribe
   * on the bonding-curve PDAs — the priceCache interface stays identical.
   */
  /**
   * A warm SOL/USD rate, refreshed on a timer.
   *
   * Deliberately not awaited and deliberately tolerant: a price API being down must
   * cost the table a marker (`≈`), never a scan. Stops with the engine.
   */
  _startSolPriceWarmup() {
    if (this._priceTimer) return;
    const tick = () => { solprice.get().catch(() => {}); };
    tick();
    this._priceTimer = setInterval(tick, 60_000);
    if (this._priceTimer.unref) this._priceTimer.unref();
  }

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
        // Reported for a keyless wallet too, so the card can word its state
        // consistently the moment its key is armed.
        armed: Boolean(cfg.enabled) && !(cfg.stats && cfg.stats.paused),
        imported: Boolean(cfg.imported),
        keyLocked: true,
        // With browser-held wallets, a wallet with no key loaded is simply NOT
        // ARMED yet — its key is sealed in the browser, waiting for its passphrase.
        // "keyMissing" now means the harder case: no key here and none in the old
        // server keystore either, so nothing can arm it except importing the key.
        keyMissing: !this.keystore.has(cfg.id) && this.keystore.isUnlocked(),
        keyArmed: false,
        /* The BALANCE is readable without the key — the address is public, and the
         * reference bot polls every stored wallet, locked ones included, for
         * exactly this reason. Showing "locked" where the money is loses the one
         * fact the user opens the dashboard to check. `_lockedBalances` is filled
         * by a read; a read that fails leaves null, because unknown is not zero. */
        balanceSol: this._lockedBalances ? (this._lockedBalances.get(cfg.id) ?? null) : null,
        // A wallet the bot holds the key for: its key is in keystore.enc, not in
        // this session, so it survives a restart. The card shows that state.
        persistent: Boolean(cfg.persistent),
        keyHolder: cfg.persistent ? 'server' : 'browser',
        paperBalanceSol: 0,
        paperTrading: false,
        exposureSol: 0,
        config: cfg,
        /* The COUNTS are saved with the wallet in config.json (wins, losses, bought,
         * realised P&L) and they were earned — they belong on the card even while the
         * key is elsewhere. What is NOT known without a key is the live stuff: open
         * positions, exposure, today's balance. Those stay null/empty, because zero
         * would read as "nothing open" rather than "cannot see". */
        stats: cfg.stats ? {
          bought: cfg.stats.bought || 0,
          wins: cfg.stats.wins || 0,
          losses: cfg.stats.losses || 0,
          realisedPnlSol: cfg.stats.realisedPnlSol || 0,
          tradesToday: null,
          consecutiveLosses: cfg.stats.consecutiveLosses || 0,
          paused: Boolean(cfg.stats.paused),
          pauseReason: cfg.stats.pauseReason || null,
        } : null,
        openPositions: [],
        recentPositions: [],
        lastEntryAt: null,
      }));
  }

  /**
   * Forget every loaded trader, so the next hydrate() rebuilds from config.
   *
   * Used when the wallet list is replaced wholesale (restoring a backup). The
   * traders hold keypairs resolved from the keystore, so they must not outlive the
   * keystore they came from.
   */
  resetTraders() {
    this.traders.clear();
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

  /**
   * Trades, wins, losses and realised P&L across EVERY wallet — including the
   * ones whose keys are not loaded right now.
   *
   * A locked wallet still has its counts, because they live in config.json next
   * to its name and address, and they were earned. Deriving the total from live
   * traders alone would make the numbers shrink whenever a wallet re-locked,
   * which reads as "my trades disappeared" — the same class of bug as the wallet
   * list emptying itself.
   */
  overallStats() {
    const live = [...this.traders.values()];
    const liveIds = new Set(live.map((t) => t.cfg.id));

    let wins = 0;
    let losses = 0;
    let bought = 0;
    let open = 0;
    let exposureSol = 0;
    const per = [];

    for (const t of live) {
      const st = t.stats || {};
      const openCount = t.openPositions ? t.openPositions().length : 0;
      wins += st.wins || 0;
      losses += st.losses || 0;
      bought += st.bought || 0;
      open += openCount;
      exposureSol += Number(t.cfg && t.cfg.exposureSol) || 0;
      per.push({
        id: t.cfg.id,
        name: t.cfg.name,
        wins: st.wins || 0,
        losses: st.losses || 0,
        bought: st.bought || 0,
        trades: (st.wins || 0) + (st.losses || 0),
        realisedPnlSol: st.realisedPnlSol || 0,
        open: openCount,
        keyArmed: true,
      });
    }

    for (const cfg of this.config.wallets) {
      if (liveIds.has(cfg.id)) continue;
      const st = cfg.stats || {};
      wins += st.wins || 0;
      losses += st.losses || 0;
      bought += st.bought || 0;
      per.push({
        id: cfg.id,
        name: cfg.name,
        wins: st.wins || 0,
        losses: st.losses || 0,
        bought: st.bought || 0,
        trades: (st.wins || 0) + (st.losses || 0),
        realisedPnlSol: st.realisedPnlSol || 0,
        open: 0, // unknown without a key; the locked card says so rather than showing 0
        openUnknown: true,
        keyArmed: false,
      });
    }

    const closed = wins + losses;
    return {
      trades: closed,
      closed,
      bought,
      wins,
      losses,
      winRatePct: closed ? (wins / closed) * 100 : null,
      open,
      exposureSol,
      wallets: per.sort((a, b) => b.trades - a.trades || String(a.name).localeCompare(String(b.name))),
      realisedPnlSol: per.reduce((a, w) => a + (w.realisedPnlSol || 0), 0),
    };
  }

  status() {
    return {
      running: this.running,
      dryRun: this.executor.dryRun,
      wallets: this.traders.size,
      // One card's worth of answers, computed where the counts actually live.
      overall: this.overallStats(),
      scanner: {
        source: this.config.global.scanner.source,
        connected: Boolean(this.scanner.ws && this.scanner.ws.readyState === 1),
        detected: this.scanner.stats.detected,
      },
      stats: this.stats,
      // The feed's own tally, next to the engine's. They answer different
      // questions: `stats.detected` counts what was evaluated, `scan.seen`
      // counts the rows the panel is showing. If they ever disagree, the panel
      // says so out loud instead of leaving the user to spot it.
      scan: {
        rows: this.liveFeed.size,
        seen: this.liveFeed.stats.seen,
        bought: this.liveFeed.stats.bought,
        skipped: this.liveFeed.stats.skipped,
        errors: this.liveFeed.stats.errors,
        dropped: this.liveFeed.stats.dropped,
      },
      // The SOL/USD rate the table is using, so EVERY card that shows SOL can show
      // what it is worth without each one calling a price API.
      solUsd: solprice.lastKnown().usd,
      solUsdSource: solprice.lastKnown().source,
      solUsdStale: solprice.lastKnown().stale,
      priceFeedSize: this.priceCache.size,
      priceFeed: {
        ok: this.priceHealth ? this.priceHealth.ok : true,
        consecutiveFailures: this.priceHealth ? this.priceHealth.consecutiveFailures : 0,
        lastOkAt: this.priceHealth ? this.priceHealth.lastOkAt : 0,
        lastError: this.priceHealth ? this.priceHealth.lastError : null,
      },
      evalQueue: this._evalQueue,
      reconQueue: this._reconQueue,
      recoveredPositions: this.stats.recovered || 0,
      positionsPersistedAt: this._persistedAt || 0,
    };
  }
}

module.exports = Engine;
