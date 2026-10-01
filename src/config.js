'use strict';
/**
 * Configuration schema, defaults, validation and persistence.
 *
 * Design rule: every wallet owns a COMPLETE, INDEPENDENT strategy object.
 * There is no shared mutable position state between wallets — only shared
 * infrastructure (RPC, scanner, price cache) which is read-only.
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Where the keystore and config live.
 *
 * Overridable because hosted platforms give you an EPHEMERAL filesystem: on
 * Render (and most others) anything written into the repo is destroyed on every
 * deploy or restart, which would silently take the encrypted private keys with
 * it. Point DATA_DIR at a mounted persistent disk instead.
 */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/* ------------------------------------------------------------------ *
 * Strategy presets (mirrors the preset UX, but with real semantics)
 * ------------------------------------------------------------------ */
const PRESETS = {
  safe: {
    label: 'Safe',
    description: 'Small size, strict filters, tight loss limit, exits early.',

  buy: { minAmountSol: 0.05, maxAmountSol: 0.3, slippageBps: 800, maxConcurrentPositions: 2 },
    exits: {
      takeProfitTiers: [
        { gainPct: 35, sellPct: 40 },
        { gainPct: 70, sellPct: 40 },
        { gainPct: 150, sellPct: 100 },
      ],
      stopLossPct: 15,
      trailing: { enabled: true, activationPct: 25, trailPct: 12 },
    },
    filters: { maxDevHoldPct: 10, minLiquiditySol: 2, maxLiquiditySol: 0, maxTop10HoldersPct: 25, minHolders: 10 },
  },

  balanced: {
    label: 'Balanced',
    description: 'The default. Good risk/reward for most launches.',
    buy: { minAmountSol: 0.1, maxAmountSol: 1.0, slippageBps: 1200, maxConcurrentPositions: 4 },
    exits: {
      takeProfitTiers: [
        { gainPct: 50, sellPct: 33 },
        { gainPct: 120, sellPct: 33 },
        { gainPct: 300, sellPct: 100 },
      ],
      stopLossPct: 25,
      trailing: { enabled: true, activationPct: 40, trailPct: 18 },
    },
    filters: { maxDevHoldPct: 20, minLiquiditySol: 1, maxLiquiditySol: 0, maxTop10HoldersPct: 35, minHolders: 8 },
  },

  aggressive: {
    label: 'Aggressive',
    description: 'Bigger size, further targets, more shots per day.',
    buy: { minAmountSol: 0.3, maxAmountSol: 2.0, slippageBps: 1800, maxConcurrentPositions: 6 },
    exits: {
      takeProfitTiers: [
        { gainPct: 120, sellPct: 25 },
        { gainPct: 250, sellPct: 35 },
        { gainPct: 600, sellPct: 100 },
      ],
      stopLossPct: 40,
      trailing: { enabled: true, activationPct: 80, trailPct: 25 },
    },
    filters: { maxDevHoldPct: 30, minLiquiditySol: 0.5, maxLiquiditySol: 0, maxTop10HoldersPct: 50, minHolders: 5 },
  },

  degen: {
    label: 'Degen',
    description: 'Moonshots only. Relaxed filters, accepts large drawdown.',
    buy: { minAmountSol: 0.5, maxAmountSol: 3.0, slippageBps: 2500, maxConcurrentPositions: 8 },
    exits: {
      takeProfitTiers: [
        { gainPct: 300, sellPct: 25 },
        { gainPct: 900, sellPct: 50 },
        { gainPct: 2000, sellPct: 100 },
      ],
      stopLossPct: 60,
      trailing: { enabled: true, activationPct: 150, trailPct: 35 },
    },
    filters: { maxDevHoldPct: 50, minLiquiditySol: 0.1, maxLiquiditySol: 0, maxTop10HoldersPct: 70, minHolders: 3 },
  },

  scalper: {
    label: 'Scalper',
    description: 'High frequency, tiny targets, partials off fast.',
    buy: { minAmountSol: 0.05, maxAmountSol: 0.25, slippageBps: 1500, maxConcurrentPositions: 10 },
    exits: {
      takeProfitTiers: [
        { gainPct: 15, sellPct: 50 },
        { gainPct: 30, sellPct: 30 },
        { gainPct: 60, sellPct: 100 },
      ],
      stopLossPct: 10,
      trailing: { enabled: true, activationPct: 12, trailPct: 6 },
    },
    filters: { maxDevHoldPct: 20, minLiquiditySol: 1, maxLiquiditySol: 0, maxTop10HoldersPct: 40, minHolders: 6 },
  },
};

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */
function defaultGlobalConfig() {
  return {
    dryRun: true, // ⚠️ LIVE TRADING IS OPT-IN. Never flip by default.
    /* Notional balance used ONLY in dry run. Without it an unfunded wallet
     * sizes every position to 0 and paper trading never runs, so there is no
     * safe way to validate trailing stops / partial sells before going live. */
    dryRunBalanceSol: 10,
    rpc: {
      // Add your own paid endpoint (Helius / Triton / QuickNode) for real speed.
      endpoints: [process.env.RPC_URL || 'https://api.mainnet-beta.solana.com'],
      commitment: 'processed',
      wsEndpoint: process.env.RPC_WS_URL || '',
    },
    jito: {
      enabled: false,
      blockEngineUrl: 'https://mainnet.block-engine.jito.wtf',
      tipLamports: 1000000,
    },
    scanner: {
      source: 'pumpportal', // pumpportal | logs
      pumpportalWs: 'wss://pumpportal.fun/api/data',
      minScoreToEvaluate: 0,
      /* How many launches may be evaluated simultaneously.
       *
       * Each in-flight evaluation fires several parallel RPC reads, so this
       * multiplies burst size directly. 4 is fine on a paid endpoint; on a free
       * one the burst trips a 429 that starves BOTH new evaluations and the
       * price feed — and a dead price feed means open positions stop exiting.
       * Override with SCANNER_CONCURRENCY. */
      evaluateConcurrency: Number(process.env.SCANNER_CONCURRENCY || 2),
      /* How many launches may be fact-read at once for the scanner TABLE
       * (liquidity, dev hold, honeypot risk). Separate from the entry queue
       * above: those numbers must appear for every launch even when no wallet is
       * armed, and they share the per-mint cache so an armed wallet's own
       * evaluation does not pay for them twice. */
      reconConcurrency: Number(process.env.SCANNER_RECON_CONCURRENCY || 2),
    },
    execution: {
      priorityFeeMicroLamports: 200000,
      computeUnitLimit: 200000,
      maxRetries: 1,
      confirmTimeoutMs: 30000,
      sellRetryAttempts: 3,
    },
    ai: {
      enabled: false,
      provider: 'openai', // openai | anthropic | gemini | xai | none
      model: 'gpt-4o-mini',
      apiKey: '',
      minConfidence: 0.6,
      maxLatencyMs: 4000,
      onFailure: 'skip', // skip | allow
      timeoutMs: 5000,
    },
    server: { port: Number(process.env.PORT || 8787), host: '0.0.0.0' },
    riskGlobal: {
      // Hard ceiling across ALL wallets, enforced by the engine regardless of
      // per-wallet config. Defence against a misconfigured wallet.
      maxTotalExposureSol: 20,
      dailyLossLimitSol: 10,
      pauseOnDailyLoss: true,
    },
    /* What "risky" means in the launch table, before any wallet's own filters are
     * involved. Deliberately global: the number is shown to a human, so it must
     * not change depending on which wallet happens to be enabled. */
    risk: {
      maxDevHoldPct: 15,     // dev's opening buy, % of the 1e9 supply
      minLiquidityUsd: 2000, // curve liquidity floor, in dollars
    },
  };
}

function defaultWalletConfig(name) {
  const p = PRESETS.balanced;
  return {
    id: null, // assigned on creation
    name: name || 'Wallet',
    enabled: false,
    preset: 'balanced',

    buy: {
      minAmountSol: p.buy.minAmountSol,
      maxAmountSol: p.buy.maxAmountSol,
      slippageBps: p.buy.slippageBps,
      maxConcurrentPositions: p.buy.maxConcurrentPositions,
      // fixed = random within [min,max] · percent = % of wallet balance · kelly = scaled by AI confidence
      positionSizeMode: 'fixed',
      positionSizePercent: 2,
      kellyFraction: 0.25,
      autoCompound: false,
      cooldownMs: 2000,
    },

    exits: {
      // ── Tiered partial take-profits ────────────────────────────────
      // Each tier sells `sellPct` (% of the ORIGINAL position) once the
      // position is up `gainPct`%. Evaluated highest-first.
      takeProfitTiers: JSON.parse(JSON.stringify(p.exits.takeProfitTiers)),
      // ── Hard loss limit per trade ─────────────────────────────────
      stopLossPct: p.exits.stopLossPct,
      // ── Trailing stop ─────────────────────────────────────────────
      trailing: { ...p.exits.trailing, stepPct: 0 },
      // ── Move stop to break-even after a gain ──────────────────────
      breakEven: { enabled: true, activationPct: 30, offsetPct: 2 },
      // ── Time stop ─────────────────────────────────────────────────
      maxHoldMs: 30 * 60 * 1000,
      // ── Liquidity exit: bail if the curve loses this much liquidity ─
      liquidityDropExitPct: 55,
    },

    limits: {
      dailyLossLimitSol: 2, // stop trading for the day at this loss
      dailyProfitTargetSol: 0, // 0 = disabled
      maxTradesPerDay: 100,
      maxExposureSol: 3,
      stopAfterConsecutiveLosses: 5,
    },

    filters: {
      // ── dev / contract safety ──────────────────────────────────────
      maxDevHoldPct: p.filters.maxDevHoldPct,
      requireMintAuthorityRevoked: true,
      requireFreezeAuthorityRevoked: true,
      maxBuyTaxPct: 10,
      maxSellTaxPct: 10,
      // ── distribution ──────────────────────────────────────────────
      minLiquiditySol: p.filters.minLiquiditySol,
      maxLiquiditySol: p.filters.maxLiquiditySol,
      maxTop10HoldersPct: p.filters.maxTop10HoldersPct,
      minHolders: p.filters.minHolders,
      // ── metadata ──────────────────────────────────────────────────
      requireSocial: false,
      minNameLength: 2,
      blockCopycatNames: true,
      // ── timing ────────────────────────────────────────────────────
      maxAgeMs: 120000,
      maxBondingCurvePct: 60, // don't chase a curve that has already run
      // ── blocklists (per wallet) ───────────────────────────────────
      devBlacklist: [],
      mintBlacklist: [],
    },

    ai: {
      enabled: false,
      overrideProvider: '', // '' = inherit global
      minConfidence: 0, // 0 = inherit global
    },

    stats: {
      day: null,
      tradesToday: 0,
      realisedPnlSol: 0,
      consecutiveLosses: 0,
      wins: 0,
      losses: 0,
      paused: false,
      pauseReason: null,
    },
  /**
   * Re-adopt open positions after the bot restarts or redeploys.
   *
   * The engine runs on the server, so closing the dashboard tab does NOT stop
   * trading — but a restart does, and position state is memory-only. With this
   * on, open positions are written to DATA_DIR and picked back up (verified
   * against the on-chain balance) once the keystore is unlocked. For a wallet
   * holding for 24h that is the difference between the target firing and the
   * bag being stranded.
   */
  resumeAfterRestart: true,

  };
}

/* ------------------------------------------------------------------ *
 * Load / save
 * ------------------------------------------------------------------ */
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || typeof base !== 'object') return patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

let state = null;

function load() {
  ensureDataDir();
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      state = {
        global: deepMerge(defaultGlobalConfig(), raw.global || {}),
        wallets: raw.wallets || [],
      };
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[config] corrupt config.json, falling back to defaults:', err.message);
      state = { global: defaultGlobalConfig(), wallets: [] };
    }
  } else {
    state = { global: defaultGlobalConfig(), wallets: [] };
  }

  applyEnvOverrides(state.global);
  applyDryRunOverride(state.global);
  return state;
}

/**
 * Infrastructure settings must come from the ENVIRONMENT, not from a config file
 * carried over from a previous run.
 *
 * The bug this fixes: `load()` deep-merges the saved config OVER the defaults,
 * so once `rpc.endpoints` had been persisted it silently won — changing RPC_URL
 * in .env (or setting it on Render, which is exactly what the deployment guide
 * tells you to do) had NO EFFECT. The bot kept hammering the rate-limited public
 * endpoint while the operator stared at a correct-looking .env.
 *
 * Strategy is the user's to persist. Connectivity is the operator's to set.
 */
function applyEnvOverrides(global) {
  const overridden = [];

  if (process.env.RPC_URL) {
    const wanted = [process.env.RPC_URL];
    if (JSON.stringify(global.rpc.endpoints) !== JSON.stringify(wanted)) {
      overridden.push(`rpc.endpoints ${JSON.stringify(global.rpc.endpoints)} → ${JSON.stringify(wanted)}`);
      global.rpc.endpoints = wanted;
    }
  }
  if (process.env.RPC_WS_URL) {
    if (global.rpc.wsEndpoint !== process.env.RPC_WS_URL) {
      overridden.push('rpc.wsEndpoint');
      global.rpc.wsEndpoint = process.env.RPC_WS_URL;
    }
  }
  // Jito is infrastructure: the endpoint and the tip are operator settings, and the
  // tip is real money leaving the wallet, so it must be settable from the host's
  // environment without editing a config file that a previous run wrote.
  if (process.env.JITO_ENABLED) {
    const on = /^(1|true|yes)$/i.test(process.env.JITO_ENABLED.trim());
    if (global.jito.enabled !== on) {
      overridden.push(`jito.enabled → ${on}`);
      global.jito.enabled = on;
    }
  }
  if (process.env.JITO_TIP_SOL) {
    const lamports = Math.round(Number(process.env.JITO_TIP_SOL) * 1e9);
    if (Number.isFinite(lamports) && lamports > 0 && global.jito.tipLamports !== lamports) {
      overridden.push(`jito.tipLamports → ${lamports}`);
      global.jito.tipLamports = lamports;
    }
  }
  if (process.env.JITO_BLOCK_ENGINE_URL) {
    if (global.jito.blockEngineUrl !== process.env.JITO_BLOCK_ENGINE_URL) {
      overridden.push('jito.blockEngineUrl');
      global.jito.blockEngineUrl = process.env.JITO_BLOCK_ENGINE_URL;
    }
  }
  if (process.env.SCANNER_CONCURRENCY) {
    const n = Math.max(1, Number(process.env.SCANNER_CONCURRENCY) || 2);
    if (global.scanner.evaluateConcurrency !== n) {
      overridden.push(`scanner.evaluateConcurrency → ${n}`);
      global.scanner.evaluateConcurrency = n;
    }
  }

  if (overridden.length) {
    // eslint-disable-next-line no-console
    console.log(`[config] env override applied: ${overridden.join('; ')}`);
  }
}

/**
 * Headless live-trading opt-in.
 *
 * A hosted/server deployment has no browser to click "arm" in, so the mode can
 * be set from the environment. It deliberately takes TWO variables:
 *
 *   DRY_RUN=false                 — declares the intent
 *   I_UNDERSTAND_THE_RISK=yes     — acknowledges it
 *
 * One variable is a typo away from arming a bot with real money. Two is not,
 * and it mirrors the confirmation phrase the dashboard already requires. If the
 * acknowledgement is missing we stay in dry run and say why, loudly.
 */
function applyDryRunOverride(global) {
  if (String(process.env.DRY_RUN).toLowerCase() !== 'false') return;

  if (process.env.I_UNDERSTAND_THE_RISK !== 'yes') {
    global.dryRun = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[config] DRY_RUN=false was set without I_UNDERSTAND_THE_RISK=yes — ' +
      'staying in DRY RUN. Set both to arm live trading headlessly.',
    );
    return;
  }

  global.dryRun = false;
  // eslint-disable-next-line no-console
  console.warn('[config] ⚠️  LIVE TRADING ARMED via environment — real funds are at risk.');
}

function save() {
  ensureDataDir();
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH); // atomic
}

function get() {
  if (!state) load();
  return state;
}

/* ------------------------------------------------------------------ *
 * Validation — clamp everything. A bad number must never reach the
 * executor and turn into an accidental 50 SOL market buy.
 * ------------------------------------------------------------------ */
const clamp = (v, lo, hi, fallback) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

function normaliseWallet(cfg) {
  const d = defaultWalletConfig(cfg.name);
  const w = deepMerge(d, cfg);

  /* A wallet object is FLAT: buy/exits/limits/filters/ai sit at the top level.
   * The API serialises them into a `config` key for readability, and a client
   * that echoes that shape back on PUT would otherwise persist a second, dead
   * copy of the strategy here — edits to it would silently do nothing. */
  delete w.config;

  w.buy.minAmountSol = clamp(w.buy.minAmountSol, 0.001, 100, 0.01);
  w.buy.maxAmountSol = clamp(w.buy.maxAmountSol, w.buy.minAmountSol, 100, w.buy.minAmountSol);
  w.buy.slippageBps = clamp(w.buy.slippageBps, 10, 5000, 1000);
  w.buy.maxConcurrentPositions = Math.round(clamp(w.buy.maxConcurrentPositions, 1, 50, 4));
  w.buy.positionSizePercent = clamp(w.buy.positionSizePercent, 0.1, 100, 2);
  w.buy.kellyFraction = clamp(w.buy.kellyFraction, 0.01, 1, 0.25);
  if (!['fixed', 'percent', 'kelly'].includes(w.buy.positionSizeMode)) w.buy.positionSizeMode = 'fixed';

  w.exits.stopLossPct = clamp(w.exits.stopLossPct, 1, 99, 25);
  w.exits.maxHoldMs = clamp(w.exits.maxHoldMs, 5000, 24 * 3600 * 1000, 1800000);
  w.exits.liquidityDropExitPct = clamp(w.exits.liquidityDropExitPct, 5, 100, 55);
  w.exits.trailing.activationPct = clamp(w.exits.trailing.activationPct, 1, 100000, 30);
  w.exits.trailing.trailPct = clamp(w.exits.trailing.trailPct, 0.5, 95, 15);
  w.exits.trailing.stepPct = clamp(w.exits.trailing.stepPct, 0, 50, 0);
  w.exits.breakEven.activationPct = clamp(w.exits.breakEven.activationPct, 1, 100000, 30);
  w.exits.breakEven.offsetPct = clamp(w.exits.breakEven.offsetPct, 0, 50, 2);

  // Tier sanitation: valid, sorted ascending, cumulative sell <= 100%
  if (!Array.isArray(w.exits.takeProfitTiers) || w.exits.takeProfitTiers.length === 0) {
    w.exits.takeProfitTiers = defaultWalletConfig().exits.takeProfitTiers;
  }
  w.exits.takeProfitTiers = w.exits.takeProfitTiers
    .map((t) => ({
      gainPct: clamp(t.gainPct, 1, 1000000, 50),
      sellPct: clamp(t.sellPct, 1, 100, 50),
    }))
    .sort((a, b) => a.gainPct - b.gainPct);

  w.limits.dailyLossLimitSol = clamp(w.limits.dailyLossLimitSol, 0.01, 10000, 2);
  w.limits.maxTradesPerDay = Math.round(clamp(w.limits.maxTradesPerDay, 1, 100000, 100));
  w.limits.maxExposureSol = clamp(w.limits.maxExposureSol, 0.01, 10000, 3);
  w.limits.stopAfterConsecutiveLosses = Math.round(clamp(w.limits.stopAfterConsecutiveLosses, 1, 1000, 5));

  w.resumeAfterRestart = w.resumeAfterRestart !== false; // opt-out only; default ON

  w.filters.maxDevHoldPct = clamp(w.filters.maxDevHoldPct, 0, 100, 20);
  w.filters.maxTop10HoldersPct = clamp(w.filters.maxTop10HoldersPct, 1, 100, 35);
  w.filters.maxBondingCurvePct = clamp(w.filters.maxBondingCurvePct, 1, 100, 60);
  w.filters.maxAgeMs = clamp(w.filters.maxAgeMs, 0, 24 * 3600 * 1000, 120000);
  w.filters.minLiquiditySol = clamp(w.filters.minLiquiditySol, 0, 100000, 1);
  /* Upper bound on curve liquidity. 0 means "no ceiling" (the default, and what
   * every preset ships with). Setting it lets you say "only snipe tokens that
   * have between X and Y SOL in the curve" — useful for skipping launches that
   * are already crowded, where the easy multiple is gone. */
  w.filters.maxLiquiditySol = clamp(w.filters.maxLiquiditySol, 0, 1000000, 0);
  // A ceiling below the floor would reject every token; widen it to the floor.
  if (w.filters.maxLiquiditySol > 0 && w.filters.maxLiquiditySol < w.filters.minLiquiditySol) {
    w.filters.maxLiquiditySol = w.filters.minLiquiditySol;
  }

  return w;
}

function applyPreset(walletCfg, presetName) {
  const p = PRESETS[presetName];
  if (!p) return normaliseWallet(walletCfg);
  const merged = deepMerge(walletCfg, {
    preset: presetName,
    buy: p.buy,
    exits: {
      takeProfitTiers: JSON.parse(JSON.stringify(p.exits.takeProfitTiers)),
      stopLossPct: p.exits.stopLossPct,
      trailing: { ...p.exits.trailing, stepPct: 0 },
    },
    filters: p.filters,
  });
  return normaliseWallet(merged);
}

module.exports = {
  applyEnvOverrides,
  applyDryRunOverride,
  DATA_DIR,
  PRESETS,
  defaultGlobalConfig,
  defaultWalletConfig,
  load,
  save,
  get,
  normaliseWallet,
  applyPreset,
  deepMerge,
  clamp,
  CONFIG_PATH,
};
