/* ============================================================
   MEME SNIPER dashboard
   Talks to the local API over same-origin HTTP + WebSocket.
   Falls back to a self-contained DEMO mode when no backend is
   reachable (e.g. viewing the file standalone), so the UI is
   always inspectable.
   ============================================================ */
'use strict';

/* ------------------------------- state ------------------------------- */
const S = {
  token: null,
  connected: false,
  ws: null,
  demo: false,
  status: null,
  wallets: [],
  positions: [],
  prices: {},
  logs: [],
  config: null,
  presets: {},
  editing: null,
  activeTab: 'strategy',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a, n = 4) => (a ? `${a.slice(0, n)}…${a.slice(-n)}` : '—');

/** A real Solana address is base58 and 32-44 chars. Demo placeholders are not. */
const isRealAddress = (a) => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const fmtSol = (n, dp = 4) => (n === null || n === undefined || Number.isNaN(n) ? '—' : `${Number(n) >= 0 ? '' : '-'}${Math.abs(Number(n)).toFixed(dp)}`);
/**
 * The dollar value of an amount of SOL, at the rate the bot is using.
 *
 * Every card that holds SOL shows this underneath, because "2.41 SOL" is not a
 * number anyone can judge on its own — the same reason the launch table's
 * liquidity is in dollars. Returns '' when there is no rate at all, so a figure is
 * never invented; the rows that do have one are marked with `≈` when it was
 * converted at a fallback rate rather than a live quote.
 */
function usdOf(sol, dp = 2) {
  const rate = S.status && Number(S.status.solUsd);
  if (!Number.isFinite(rate) || rate <= 0) return '';
  const n = Number(sol);
  if (!Number.isFinite(n)) return '';
  // Sources that are NOT a live provider price get the marker: a fallback constant,
  // a stale quote, or the preview's fixed demo rate.
  const src = S.status.solUsdSource;
  const approx = src === 'fallback' || src === 'demo' || src === 'none' || S.status.solUsdStale;
  return `${approx ? '≈' : ''}$${(Math.abs(n) * rate).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

const fmtPct = (n, dp = 1) => (n === null || n === undefined || Number.isNaN(n) ? '—' : `${Number(n) >= 0 ? '+' : ''}${Number(n).toFixed(dp)}%`);
const cls = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : 'dim');
const fmtAge = (ms) => {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

/* ------------------------------- api ------------------------------- */
/**
 * Re-read the session token.
 *
 * The token is minted per boot, and /api/session-token needs no auth of its own,
 * so this is always safe to call — including while a write is failing.
 */
async function refreshSessionToken() {
  try {
    const r = await fetch('/api/session-token', { cache: 'no-store' });
    if (!r.ok) return null;
    const t = await r.json();
    return t && t.token ? t.token : null;
  } catch { return null; }
}

/**
 * Re-read keystore state.
 *
 * Called when we discover the server has restarted, because a restart re-locks
 * the keystore: the page's copy of that state is then wrong in the other
 * direction and every wallet action would fail with a confusing
 * "keystore_locked" instead of asking for the passphrase.
 */
async function syncKeystoreState() {
  try {
    const r = await fetch('/api/keystore/status', { cache: 'no-store' });
    if (!r.ok) return;
    S.keystore = await r.json();
    renderAll();
  } catch { /* offline; the next action will report it */ }
}

async function api(path, opts = {}) {
  // In the preview there is no server, so every call is answered by the local
  // simulator instead of failing with an HTTP error. A button that does nothing
  // when tapped teaches you nothing about what it is for.
  if (S.demo) return demoApi(path, opts);

  const attempt = (token) => {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['x-session-token'] = token;
    return fetch(path, { ...opts, headers });
  };

  let res = await attempt(S.token);

  /*
   * A server that has restarted rejects the previous run's token with a bare
   * 401, and the page cannot tell that apart from a wrong passphrase. Every
   * write — including Unlock itself — then failed forever until the tab was
   * reloaded by hand: the unlock modal simply sat there, and tapping the button
   * again produced exactly the same error. Fetch the current token and retry
   * once before giving up.
   */
  if (res.status === 401) {
    const fresh = await refreshSessionToken();
    if (fresh && fresh !== S.token) {
      S.token = fresh;
      res = await attempt(fresh);
    }
    // Reaching here means the server was restarted under us, which also
    // re-locked the keystore. Correct the page's view before the user tries
    // anything else.
    syncKeystoreState();
  }

  if (!res.ok) {
    let detail = {};
    try { detail = await res.json(); } catch { /* non-json error body */ }
    if (res.status === 401) {
      throw new Error('The bot restarted, so this page\'s session expired. Reload the page to continue.');
    }
    throw new Error(detail.error || detail.hint || `HTTP ${res.status}`);
  }
  return res.json();
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  }, 4200);
}

/* ============================================================
   DEMO MODE — a believable snapshot so the UI renders standalone
   ============================================================ */
function startDemo() {
  S.demo = true;
  S.offline = true;
  S.token = 'demo';
  S.connected = true;

  const mkPos = (o) => ({
    id: o.id, walletId: o.walletId, wallet: o.wallet, mint: o.mint, symbol: o.symbol, name: o.name,
    status: 'OPEN', openedAt: Date.now() - o.age, closedAt: null,
    entryPrice: '0', lastPrice: '0', highWaterPrice: '0',
    originalTokens: '0', tokensHeld: '0', solSpent: String(o.spent * 1e9),
    realisedSol: '0', pnlLamports: String(Math.round(o.pnlSol * 1e9)), pnlSol: o.pnlSol, pnlPct: o.pnlPct,
    priceGainPct: o.pnlPct, peakGainPct: o.peak, remainingFraction: o.remaining,
    stopLevelPct: o.stop, tiers: o.tiers, exits: [], ageMs: o.age,
    entryTxSignature: 'DEMO', closeTxSignature: null, exitReason: null, meta: {},
  });

  /* Closed trades, so the per-wallet history has something in it from the start. */
  const mkClosed = (o) => ({
    id: o.id, walletId: o.walletId, wallet: o.wallet, mint: o.mint, symbol: o.symbol, name: o.name,
    status: 'CLOSED', openedAt: Date.now() - o.age - o.held, closedAt: Date.now() - o.age,
    entryTxSignature: 'DEMO', closeTxSignature: 'DEMO', exitReason: o.reason,
    originalTokens: '0', tokensHeld: '0',
    solSpent: String(o.spent * 1e9), realisedSol: String((o.spent + o.pnl) * 1e9),
    exits: [], tiers: [{ gainPct: 50, sellPct: 100, filled: true }],
    priceGainPct: (o.pnl / o.spent) * 100, peakGainPct: Math.max(0, (o.pnl / o.spent) * 100),
    pnlSol: o.pnl, pnlPct: (o.pnl / o.spent) * 100, remainingFraction: 0, ageMs: o.age,
  });

  /**
   * A plausible live launch feed for the offline preview.
   *
   * The preview has no websocket and no chain, so without this the launch scanner
   * panel is an empty rectangle — and an empty rectangle teaches nothing about what
   * the bot does. These rows show each decision state: bought, filtered on dev
   * holdings, below the liquidity floor, high honeypot risk, and an RPC failure that
   * is NOT the token's fault.
   */
  const now = Date.now();
  S.scanFeed = [
    { mint: 'DEMO1notarealmintaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'WIFHAT', name: 'dog wif hat',
      devWallet: 'DEMO-dev-1-not-real', devHoldPct: 4.2, liquiditySol: 31.4, riskScore: 0, riskNotes: [],
      decision: 'bought', skipReason: null, detectedAt: now - 8_000, decidedAt: now - 6_000,
      wallets: [{ name: 'Alpha', action: 'bought', reason: null }, { name: 'Scalper', action: 'bought', reason: null }, { name: 'Degen', action: 'skipped', reason: 'insufficient_balance' }] },
    { mint: 'DEMO2notarealmintaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'RUGME', name: 'probably fine',
      devWallet: 'DEMO-dev-2-not-real', devHoldPct: 47.0, liquiditySol: 2.1, riskScore: 25, riskNotes: ['mint_authority_live'],
      decision: 'skipped', skipReason: 'dev_hold_high(47.0%>20%)', detectedAt: now - 21_000, decidedAt: now - 19_000,
      wallets: [{ name: 'Alpha', action: 'skipped', reason: 'dev_hold_high' }, { name: 'Scalper', action: 'skipped', reason: 'dev_hold_high' }, { name: 'Degen', action: 'skipped', reason: 'dev_hold_high' }] },
    { mint: 'DEMO3notarealmintaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'TINYPOT', name: 'tiny liquidity',
      devWallet: 'DEMO-dev-3-not-real', devHoldPct: 8.0, liquiditySol: 0.42, riskScore: 0, riskNotes: [],
      decision: 'skipped', skipReason: 'liquidity_below_min(0.42)', detectedAt: now - 34_000, decidedAt: now - 32_000,
      wallets: [{ name: 'Alpha', action: 'skipped', reason: 'liquidity_below_min' }] },
    { mint: 'DEMO4notarealmintaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'FROZEN', name: 'can not sell',
      devWallet: 'DEMO-dev-4-not-real', devHoldPct: 12.5, liquiditySol: 18.9, riskScore: 60, riskNotes: ['freeze_authority_live'],
      decision: 'skipped', skipReason: 'freeze_authority_live', detectedAt: now - 47_000, decidedAt: now - 45_000,
      wallets: [{ name: 'Alpha', action: 'skipped', reason: 'freeze_authority_live' }] },
    { mint: 'DEMO5notarealmintaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'RPCFAIL', name: 'could not be read',
      devWallet: 'DEMO-dev-5-not-real', devHoldPct: null, liquiditySol: null, riskScore: null, riskNotes: [],
      decision: 'error', skipReason: 'rpc unavailable or evaluation timed out — infrastructure, not the token',
      detectedAt: now - 58_000, decidedAt: now - 55_000,
      wallets: [{ name: 'Alpha', action: 'rpc_error', reason: 'rpc_unavailable' }] },
    { mint: 'DEMO6notarealmintaaaaaaaaaaaaaaaaaaaaaaaaaaa', symbol: 'FRESH', name: 'just detected',
      devWallet: 'DEMO-dev-6-not-real', devHoldPct: null, liquiditySol: null, riskScore: null, riskNotes: [],
      decision: 'checking', skipReason: null, detectedAt: now - 400, decidedAt: null, wallets: [] },
  ];

  S.wallets = [
    { id: 'w_a', name: 'Alpha', publicKey: 'DEMO-Alpha-not-a-real-address', enabled: true, armed: true,
      paperTrading: true, paperBalanceSol: 10,
      balanceSol: 4.82, exposureSol: 0.9, lastEntryAt: Date.now() - 45000,
      stats: { day: '2026-09-28', tradesToday: 14, realisedPnlSol: 2.41, consecutiveLosses: 0, wins: 9, losses: 5, paused: false, pauseReason: null },
      openPositions: [mkPos({ id: 'p1', walletId: 'w_a', wallet: 'Alpha', mint: 'A'.repeat(43), symbol: 'MOON', name: 'Mooncoin', spent: 0.4, pnlSol: 0.51, pnlPct: 128.4, peak: 162.0, remaining: 0.34, stop: 96.0, age: 94000,
        tiers: [{ gainPct: 50, sellPct: 33, filled: true }, { gainPct: 120, sellPct: 33, filled: true }, { gainPct: 300, sellPct: 100, filled: false }] })],
      recentPositions: [
        mkClosed({ id: 'c1', walletId: 'w_a', wallet: 'Alpha', mint: 'C'.repeat(43), symbol: 'WOJAK', name: 'Wojak', spent: 0.35, pnl: 0.62, age: 420000, held: 190000, reason: 'tp_120pct' }),
        mkClosed({ id: 'c2', walletId: 'w_a', wallet: 'Alpha', mint: 'D'.repeat(43), symbol: 'TURBO', name: 'Turbo', spent: 0.30, pnl: -0.09, age: 1500000, held: 640000, reason: 'stop_loss' }),
        mkClosed({ id: 'c3', walletId: 'w_a', wallet: 'Alpha', mint: 'E'.repeat(43), symbol: 'GIGA', name: 'Giga', spent: 0.40, pnl: 0.21, age: 2600000, held: 380000, reason: 'trailing_stop' }),
      ],
      config: { preset: 'balanced', buy: { minAmountSol: 0.1, maxAmountSol: 1.0, slippageBps: 1200, maxConcurrentPositions: 4 },
        exits: { takeProfitTiers: [{ gainPct: 50, sellPct: 33 }, { gainPct: 120, sellPct: 33 }, { gainPct: 300, sellPct: 100 }], stopLossPct: 25,
          trailing: { enabled: true, activationPct: 40, trailPct: 18 }, maxHoldMs: 1800000 },
        limits: { dailyLossLimitSol: 2, maxTradesPerDay: 100, maxExposureSol: 3 },
        filters: { maxDevHoldPct: 20, minLiquiditySol: 1, maxLiquiditySol: 0 } } },

    { id: 'w_b', name: 'Scalper', publicKey: 'DEMO-Scalper-not-a-real-address', enabled: true, armed: true,
      paperTrading: true, paperBalanceSol: 10,
      balanceSol: 2.10, exposureSol: 0.22, lastEntryAt: Date.now() - 8000,
      stats: { day: '2026-09-28', tradesToday: 61, realisedPnlSol: 0.88, consecutiveLosses: 0, wins: 38, losses: 23, paused: false, pauseReason: null },
      openPositions: [mkPos({ id: 'p2', walletId: 'w_b', wallet: 'Scalper', mint: 'B'.repeat(43), symbol: 'PEPE2', name: 'Pepe Two', spent: 0.22, pnlSol: 0.036, pnlPct: 16.2, peak: 22.0, remaining: 0.5, stop: 9.0, age: 21000,
        tiers: [{ gainPct: 15, sellPct: 50, filled: true }, { gainPct: 30, sellPct: 30, filled: false }, { gainPct: 60, sellPct: 100, filled: false }] })],
      recentPositions: [
        mkClosed({ id: 'c4', walletId: 'w_b', wallet: 'Scalper', mint: 'F'.repeat(43), symbol: 'MEME', name: 'Meme', spent: 0.20, pnl: 0.031, age: 90000, held: 48000, reason: 'tp_15pct' }),
        mkClosed({ id: 'c5', walletId: 'w_b', wallet: 'Scalper', mint: 'G'.repeat(43), symbol: 'BONK2', name: 'Bonk Two', spent: 0.18, pnl: -0.02, age: 260000, held: 61000, reason: 'stop_loss' }),
        mkClosed({ id: 'c6', walletId: 'w_b', wallet: 'Scalper', mint: 'H'.repeat(43), symbol: 'SNAG', name: 'Snag', spent: 0.22, pnl: 0.044, age: 400000, held: 52000, reason: 'time_stop' }),
      ],
      config: { preset: 'scalper', buy: { minAmountSol: 0.05, maxAmountSol: 0.25, slippageBps: 1500, maxConcurrentPositions: 10 },
        exits: { takeProfitTiers: [{ gainPct: 15, sellPct: 50 }, { gainPct: 30, sellPct: 30 }, { gainPct: 60, sellPct: 100 }], stopLossPct: 10,
          trailing: { enabled: true, activationPct: 12, trailPct: 6 }, maxHoldMs: 600000 },
        limits: { dailyLossLimitSol: 1, maxTradesPerDay: 300, maxExposureSol: 2 },
        filters: { maxDevHoldPct: 20, minLiquiditySol: 1, maxLiquiditySol: 0 } } },

    { id: 'w_c', name: 'Degen', publicKey: 'DEMO-Degen-not-a-real-address', enabled: false, armed: false,
      paperTrading: true, paperBalanceSol: 10,
      balanceSol: 1.02, exposureSol: 0, lastEntryAt: 0,
      stats: { day: '2026-09-28', tradesToday: 3, realisedPnlSol: -0.44, consecutiveLosses: 2, wins: 0, losses: 3, paused: false, pauseReason: null },
      openPositions: [], recentPositions: [],
      config: { preset: 'degen', buy: { minAmountSol: 0.5, maxAmountSol: 3.0, slippageBps: 2500, maxConcurrentPositions: 8 },
        exits: { takeProfitTiers: [{ gainPct: 300, sellPct: 25 }, { gainPct: 900, sellPct: 50 }, { gainPct: 2000, sellPct: 100 }], stopLossPct: 60,
          trailing: { enabled: true, activationPct: 150, trailPct: 35 }, maxHoldMs: 1800000 },
        limits: { dailyLossLimitSol: 5, maxTradesPerDay: 50, maxExposureSol: 8 },
        filters: { maxDevHoldPct: 50, minLiquiditySol: 0.1, maxLiquiditySol: 0 } } },
  ];

  S.positions = S.wallets.flatMap((w) => w.openPositions);
  S.status = {
    running: true, dryRun: true, wallets: 3,
    scanner: { source: 'pumpportal', connected: true, detected: 1_284 },
    stats: { detected: 1284, evaluated: 902, bought: 78, skipped: 824, startedAt: Date.now() - 3600000 },
    // The preview's fixed rate, so every SOL card in the demo can show a dollar
    // value too — and it says where it came from, because it is not a live quote.
    solUsd: DEMO_SOL_USD, solUsdSource: 'demo',
    overall: {
      bought: 5, trades: 11, closed: 11, wins: 5, losses: 6, winRatePct: 45.5,
      open: 2, exposureSol: 0.9, realisedPnlSol: -0.19,
      wallets: [
        { id: 'w_b', name: 'Scalper', bought: 2, trades: 4, wins: 3, losses: 1, realisedPnlSol: 0.92, open: 0, keyArmed: true },
        { id: 'w_c', name: 'Degen', bought: 1, trades: 3, wins: 0, losses: 3, realisedPnlSol: -0.6, open: 0, keyArmed: true },
      ],
    },
    priceFeedSize: 2, evalQueue: 0,
  };
  S.config = { dryRun: true, ai: { enabled: false, provider: 'openai', model: 'gpt-4o-mini', apiKey: '' }, rpc: { endpoints: ['https://api.mainnet-beta.solana.com'] }, jito: { enabled: false } };
  S.presets = DEMO_PRESETS;
  S.logs = [
    { ts: Date.now() - 21000, level: 'info', message: 'Scanner websocket connected', wallet: null },
    { ts: Date.now() - 18200, level: 'debug', message: 'Filtered WOJAK: liquidity_below_min(1.10)', wallet: 'Alpha' },
    { ts: Date.now() - 15400, level: 'trade', message: '🟢 BOUGHT MOON · 0.400 SOL · 41,203,884 tokens [SIM]', wallet: 'Alpha' },
    { ts: Date.now() - 12900, level: 'trade', message: '🔴 SOLD 33.0% MOON @ +54.2% · 0.1872 SOL · tp_50pct [SIM]', wallet: 'Alpha' },
    { ts: Date.now() - 9100, level: 'trade', message: '🔴 SOLD 33.0% MOON @ +124.8% · 0.2180 SOL · tp_120pct [SIM]', wallet: 'Alpha' },
    { ts: Date.now() - 6400, level: 'trade', message: '🟢 BOUGHT PEPE2 · 0.220 SOL · 22,884,120 tokens [SIM]', wallet: 'Scalper' },
    { ts: Date.now() - 3100, level: 'info', message: 'Trailing stop armed for MOON at +96.0% (peak +162.0%)', wallet: 'Alpha' },
    { ts: Date.now() - 1200, level: 'warn', message: 'Degen: 2 consecutive losses — 1 more pauses this wallet', wallet: 'Degen' },
  ];

  renderAll();
  connectDemoTicker();
}

function connectDemoTicker() {
  setInterval(demoTickAll, 1400);
}



const DEMO_PRESETS = {
  safe: { label: 'Safe', description: 'Small size, strict filters, tight loss limit.' },
  balanced: { label: 'Balanced', description: 'The default. Good risk/reward.' },
  aggressive: { label: 'Aggressive', description: 'Bigger size, further targets.' },
  degen: { label: 'Degen', description: 'Moonshots only. Accepts drawdown.' },
  scalper: { label: 'Scalper', description: 'High frequency, tiny targets.' },
};

/* ============================================================
   LIVE CONNECTION
   ============================================================ */
async function boot() {
  discoverWallets();
  try {
    const token = await refreshSessionToken();
    if (!token) throw new Error('no api');
    S.token = token;
    const st = await api('/api/status');
    S.status = st.engine;
    S.config = st.global;
    S.presets = st.presets;
    S.keystore = st.keystore;
    await refreshAll();
    /* Wallets this browser holds but the server does not know about.
     *
     * A hosted deploy hands back an empty disk, so the server can forget every
     * wallet between one visit and the next. The browser cannot: the sealed keys
     * are in ITS storage. Re-registering them here is what turns "the app looks
     * like I never created any wallet" back into its cards — with their names and
     * addresses — ready to be unlocked one passphrase at a time. */
    if (await syncBrowserWallets()) await refreshAll();
    /* The launch-scanner list, once, on load.
     *
     * The WebSocket snapshot carries it too, but a page that opens while the
     * engine is between launches used to render an empty panel next to a
     * non-zero "tokens scanned" card — which reads as a broken scanner. Fetching
     * it here means the panel is right the moment the page paints, socket or no
     * socket. */
    S.scanFeed = await api('/api/scan?limit=200').then((r) => (r && r.rows) || []).catch(() => []);
    connectWs();
    S.connected = true;
    renderAll();
  } catch (err) {
    startDemo();
  }
}

/**
 * Coming back to the tab is the moment to notice the server restarted.
 *
 * The WebSocket reconnects on its own, so live data recovers — but the session
 * token and keystore state do not, and those are exactly what every button
 * needs. One cheap GET each, only when the tab is actually looked at.
 */
function resyncAfterRestart() {
  if (S.demo || !S.token) return;
  syncKeystoreState();
  api('/api/status').then((st) => {
    S.status = st.engine;
    S.keystore = st.keystore;
    S.presets = st.presets;
    renderChips(); renderStats(); renderWallets();
  }).catch(() => { /* the next action will report it */ });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resyncAfterRestart();
});
window.addEventListener('focus', resyncAfterRestart);

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  try {
    S.ws = new WebSocket(`${proto}://${location.host}/ws`);
  } catch { return; }

  S.ws.onopen = () => { S.connected = true; renderChips(); };

  S.ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleWs(msg);
  };

  S.ws.onclose = () => {
    S.connected = false;
    renderChips();
    setTimeout(connectWs, 3000);
  };
  S.ws.onerror = () => { S.connected = false; renderChips(); };
}

/** Insert or update one row of the live scanner feed (newest first). */
function upsertScanRow(row) {
  if (!row || !row.mint) return;
  if (!Array.isArray(S.scanFeed)) S.scanFeed = [];
  const i = S.scanFeed.findIndex((r) => r.mint === row.mint);
  if (i === -1) S.scanFeed.unshift(row);
  else S.scanFeed[i] = row;
  if (S.scanFeed.length > 200) S.scanFeed.length = 200;
  renderScanFeed();
  renderWalletFeeds();
}

function handleWs(msg) {
  switch (msg.type) {
    case 'snapshot':
      S.status = msg.data.status;
      S.wallets = msg.data.wallets;
      S.positions = msg.data.positions.filter((p) => p.status === 'OPEN');
      S.prices = msg.data.prices || {};
      S.logs = msg.data.logs || [];
      /* The snapshot has always CARRIED the launch feed; nothing ever read it.
       * That is half of why the panel sat empty while the counter climbed — a
       * reload would have filled it in and a live page never would. */
      if (Array.isArray(msg.data.scanFeed)) S.scanFeed = msg.data.scanFeed;
      S.scanStats = msg.data.scan || null;
      renderAll();
      break;
    case 'tick':
      S.status = msg.data.status;
      mergeWallets(msg.data.wallets);
      S.prices = msg.data.prices || {};
      renderChips(); renderStats(); renderOverall(); renderWallets(); renderPositions();
      break;
    case 'scan':
      // One launch changed state. Patch that row in place: a full re-render on every
      // launch would fight the user's scrolling, and a launch storm would repaint the
      // whole table hundreds of times a minute.
      upsertScanRow(msg.data);
      break;
    case 'log':
      pushLog(msg.data);
      break;
    case 'position':
      upsertPosition(msg.data);
      break;
    case 'exit':
      pushLog({ ts: Date.now(), level: 'trade', message: `Exit: ${msg.data.position.symbol} — ${msg.data.decision.reason}`, wallet: msg.data.position.walletId });
      mergePositionsFromWallet(msg.data.position);
      break;
    case 'wallet':
      if (msg.data && typeof msg.data === 'object' && msg.data.id) mergeWallet(msg.data);
      else api('/api/wallets').then((rows) => {
        if (Array.isArray(rows)) { S.wallets = rows; renderWallets(); renderOverall(); }
      }).catch(() => {});
      break;
    case 'status':
      S.status = msg.data; renderChips(); renderStats();
      break;
    case 'adopted':
      toast(`♻ Resumed ${msg.data.symbol || 'a position'} from a previous run`, 'warn');
      break;
    case 'panic':
      toast('🚨 PANIC — all positions liquidated', 'err');
      break;
    case 'error':
      toast(msg.data.error || 'trade failed', 'err');
      break;
    default:
      break;
  }
}

function mergeWallets(list) {
  if (!Array.isArray(list)) return;
  S.wallets = list;
  S.positions = list.flatMap((w) => w.openPositions || []);
}

/**
 * The wallet store in this browser: where the trading wallets actually live.
 *
 * Its keys are generated here and sealed here under each wallet's own passphrase
 * (see public/wallets.js), which is what makes a wallet survive the SERVER being
 * redeployed, restarted or wiped. The server holds a wallet's name, address and
 * strategy; the key it needs to sign with is handed over for one session only.
 */
function walletStore() {
  return (typeof WalletStore !== 'undefined' && WalletStore) ? WalletStore : null;
}

/** Is this wallet's key sealed in THIS browser? */
function keyHere(address) {
  const s = walletStore();
  if (!s || !address) return false;
  try { return Boolean(s.record(address)); } catch { return false; }
}

/**
 * Wallets this browser holds that the server does NOT know about.
 *
 * These are rendered as cards no matter what the server says. The reported bug was
 * exactly this: two wallets were created, the hosted server's disk was thrown away,
 * the re-registration did not land, and the wallets section rendered the SERVER's
 * empty list — "No wallets yet" — while the browser was holding both sealed keys.
 * A screen that says you have no wallets while your browser holds two of them is
 * the worst possible answer, and it must be impossible by construction rather than
 * by hoping the POST succeeded.
 */
function browserHeldWallets() {
  const s = walletStore();
  if (!s || !s.supported()) return [];
  let stored = [];
  try { stored = s.list(); } catch { return []; }
  const known = new Set((S.wallets || []).map((w) => w.publicKey).filter(Boolean));
  return stored
    .filter((rec) => rec.address && !known.has(rec.address))
    .map((rec) => ({
      id: `browser:${rec.address}`,
      name: rec.label || 'Wallet',
      publicKey: rec.address,
      localOnly: true,      // in this browser, not on the server
      enabled: false,
      armed: false,
      keyArmed: false,
      keyLocked: true,
      keyHolder: 'browser',
      persistent: false,
      balanceSol: null,     // nothing can read it until the server knows the address
      paperBalanceSol: 0,
      paperTrading: false,
      exposureSol: 0,
      stats: { wins: 0, losses: 0, bought: 0, realisedPnlSol: 0, tradesToday: 0, paused: false },
      openPositions: [],
    }));
}

/**
 * Delete a wallet that only exists in this browser.
 *
 * The money warning is the same one the full delete carries, because it is the same
 * fact: the key is only a way to spend what is on the address, and removing the key
 * does not remove the SOL. Without the address and the passphrase, funds on it are
 * unreachable — so the confirmation says so before it does anything.
 */
async function forgetBrowserWallet(address) {
  const s = walletStore();
  if (!s) return;
  const rec = (() => { try { return s.record(address); } catch { return null; } })();
  const name = (rec && rec.label) || 'this wallet';
  if (!confirm(
    `Delete ${name} from this browser?\n\n` +
    `Its sealed key is deleted here. Anything on the address ${address} stays on chain — but ` +
    'without that key or the passphrase, nothing can ever spend it again. If it holds anything, ' +
    'write the passphrase down first.\n\nThis cannot be undone.'
  )) return;
  try {
    s.remove(address);
    renderWallets();
    toast(`${name} deleted from this browser`, 'warn');
  } catch (err) { toast(err.message, 'err'); }
}

/**
 * SEND THIS WALLET TO THE BOT — the reference repo's `persistent-bot/start`.
 *
 * The user's question was exact: "in the repo the wallet is in browser — didn't you
 * see a function to move it to the server?" There is one, and this is it. The repo's
 * `useBurnerWallet.start()` posts `{ walletAddress, secretKeyBase64 }` once over
 * HTTPS so the bot can keep trading with the tab closed; this does the same, with
 * two differences that only help: the key is checked against the wallet's address
 * before it is stored, and it is sealed with AES-256-GCM in the server's keystore so
 * a restart brings the bot back instead of losing every wallet with it.
 *
 * The two passphrases are explained in the dialog rather than assumed: the wallet's
 * own passphrase unseals the key HERE, and the keystore passphrase is what the bot
 * encrypts it with AT REST (asked once, when there is no keystore yet).
 */
async function persistWallet(id) {
  const s = walletStore();
  const w = (S.wallets || []).find((x) => x.id === id);
  if (!w) { toast('That wallet is not loaded', 'err'); return; }
  if (!s || !s.supported()) { toast('This browser cannot hold keys — the store did not load', 'err'); return; }

  const needsKeystore = !(S.keystore && S.keystore.unlocked);
  openModal(`
    <div class="modal-head"><span class="modal-title">🖥 Send ${esc(w.name)} to the bot</span></div>
    <div class="modal-body">
      <div class="notice info"><span class="ico">ℹ</span><div>
        The bot will hold this wallet's key — <b>encrypted</b> — so it keeps trading when this tab is
        closed and comes back after a restart. Until now the key only existed in this browser, which
        is why the bot could not touch this wallet while you were away.
        <br/><br/>You can take it back at any time with <b>Remove from bot</b>; the sealed copy in this
        browser is never touched either way.
      </div></div>
      <div class="field">
        <label>${esc(w.name)}'s passphrase</label>
        <input type="password" id="pwPass" autocomplete="current-password" placeholder="Unseals the key in this browser — it is never sent"/>
        <div class="field-hint">Used here, in the tab, only to open the sealed key.</div>
      </div>
      ${needsKeystore ? `
      <div class="field">
        <label>Keystore passphrase</label>
        <input type="password" id="pwKsPass" autocomplete="new-password" placeholder="At least 8 characters"/>
        <div class="field-hint">What the bot encrypts stored keys with. You will be asked for it once
          after a restart — choose something you will still have then.</div>
      </div>` : ''}
    </div>
    <div class="modal-foot">
      <button class="btn" data-close-modal="1">Cancel</button>
      <button class="btn btn-primary" id="pwGo">🖥 Send to bot</button>
    </div>`, (root) => {
    root.querySelector('#pwGo').onclick = async () => {
      const pass = root.querySelector('#pwPass').value;
      const ksPass = root.querySelector('#pwKsPass') ? root.querySelector('#pwKsPass').value : '';
      if (!pass) { toast("Type this wallet's passphrase", 'warn'); return; }
      if (needsKeystore && ksPass.length < 8) { toast('The keystore passphrase needs at least 8 characters', 'warn'); return; }
      try {
        const secret = await s.unlock(w.publicKey, pass);
        const body = { secretKey: s.secretToBase58(secret) };
        if (ksPass) body.keystorePassphrase = ksPass;
        await api(`/api/wallets/${id}/persist`, { method: 'POST', body: JSON.stringify(body) });
        secret.fill(0); // the sealed copy in this browser is untouched
        closeModal();
        await refreshAll(); renderAll();
        toast(`🖥 ${w.name} is on the bot — it trades with the tab closed now`, '');
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

/** Take a wallet's key back out of the bot. The browser keeps its sealed copy. */
async function unpersistWallet(id) {
  const w = (S.wallets || []).find((x) => x.id === id);
  if (!confirm(
    `Remove ${w ? w.name : 'this wallet'} from the bot?\n\n` +
    'The server will delete its copy of the key, so the bot can no longer trade this wallet while ' +
    'this tab is closed. The sealed copy in this browser stays exactly where it is.'
  )) return;

  // Deleting the key from the encrypted file needs the keystore open. Ask for the
  // passphrase when it is not — a button that silently leaves the key behind is
  // worse than one more field.
  const needsKeystore = !(S.keystore && S.keystore.unlocked) && !(S.keystore && S.keystore.initialised === false);
  const go = async (ksPass) => {
    try {
      await api(`/api/wallets/${id}/unpersist`, { method: 'POST', body: JSON.stringify(ksPass ? { keystorePassphrase: ksPass } : {}) });
      await refreshAll(); renderAll();
      toast(`${w ? w.name : 'Wallet'} removed from the bot — key deleted from the server`, 'warn');
    } catch (err) {
      if (/keystore_passphrase_required/.test(err.message) && !ksPass) return askPass();
      toast(err.message, 'err');
    }
  };
  const askPass = () => openModal(`
    <div class="modal-head"><span class="modal-title">🔐 Open the keystore to remove this key</span></div>
    <div class="modal-body">
      <div class="notice info"><span class="ico">ℹ</span><div>
        ${esc(w ? w.name : 'This wallet')}'s key is inside your encrypted keystore file. Deleting it has to
        rewrite that file, which takes the keystore passphrase — the same one you gave when the bot
        first stored a key.
      </div></div>
      <div class="field">
        <label>Keystore passphrase</label>
        <input type="password" id="upPass" autocomplete="current-password"/>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close-modal="1">Cancel</button>
      <button class="btn btn-primary" id="upGo">Remove from bot</button>
    </div>`, (root) => {
    root.querySelector('#upGo').onclick = () => {
      const pass = root.querySelector('#upPass').value;
      if (pass.length < 8) { toast('The keystore passphrase is at least 8 characters', 'warn'); return; }
      closeModal();
      go(pass);
    };
  });

  if (needsKeystore) askPass();
  else go('');
}

/** Put one browser-held wallet back on the server, then re-render it properly. */
async function registerBrowserWallet(address) {
  const s = walletStore();
  const rec = s && (() => { try { return s.record(address); } catch { return null; } })();
  try {
    await api('/api/wallets', {
      method: 'POST',
      body: JSON.stringify({ name: (rec && rec.label) || 'Wallet', address, imported: false }),
    });
    await refreshAll();
    renderAll();
    toast('Wallet registered — its key stays sealed in this browser', '');
  } catch (err) {
    toast(`Could not register it: ${err.message}`, 'err');
  }
}

/**
 * Re-register wallets this browser holds that the server has never heard of.
 *
 * This is the fix for the reported bug — "the wallet just abruptly deleted itself
 * and the app appeared like I never created any wallet". The wallets were only
 * ever on the server's disk, which a hosted deploy throws away. Now the browser
 * is the source of truth: whatever it holds is re-registered here, with its name
 * and address, so a card comes back even on a brand-new container. The key stays
 * sealed; it is only read when the user unlocks that wallet.
 */
async function syncBrowserWallets() {
  const s = walletStore();
  if (!s || !s.supported()) return 0;
  let stored = [];
  try { stored = s.list(); } catch { stored = []; }
  if (!stored.length) return 0;

  const known = new Set((S.wallets || []).map((w) => w.publicKey).filter(Boolean));
  let added = 0;
  for (const rec of stored) {
    if (!rec.address || known.has(rec.address)) continue;
    try {
      await api('/api/wallets', {
        method: 'POST',
        body: JSON.stringify({ name: rec.label || 'Wallet', address: rec.address, imported: false }),
      });
      added += 1;
    } catch { /* the server will be re-tried on the next load */ }
  }
  if (added) {
    toast(`♻ Restored ${added} wallet${added === 1 ? '' : 's'} from this browser — the server had lost them`, 'warn');
  }
  return added;
}

/** Lock one wallet: the server forgets the key; the sealed copy here is untouched. */
async function lockWallet(id) {
  const w = (S.wallets || []).find((x) => x.id === id);
  try {
    await api(`/api/wallets/${id}/lock`, { method: 'POST', body: '{}' });
    await refreshAll(); renderAll();
    toast(`🔒 ${w ? w.name : 'Wallet'} locked — its key is out of the bot's memory`, 'warn');
  } catch (err) { toast(err.message, 'err'); }
}

/**
 * Unlock one wallet: unseal its key HERE, with its own passphrase, and hand it to
 * the bot for this session. The passphrase is never sent anywhere — only the
 * decrypted key, over the session-token-authenticated channel, and the server
 * keeps it in memory.
 */
async function unlockWallet(id, passphrase) {
  const s = walletStore();
  const w = (S.wallets || []).find((x) => x.id === id);
  if (!w) { toast('That wallet is not loaded', 'err'); return; }
  if (!s) { toast('The wallet store did not load — reload the page', 'err'); return; }
  if (!keyHere(w.publicKey)) {
    toast('That wallet\'s key is not in this browser — import it to arm it', 'warn');
    return;
  }
  try {
    const secret = await s.unlock(w.publicKey, passphrase);
    await api(`/api/wallets/${id}/arm`, {
      method: 'POST',
      body: JSON.stringify({ secretKey: s.secretToBase58(secret) }),
    });
    await refreshAll(); renderAll();
    toast(`🔓 ${w.name} unlocked — the bot can trade it this session`, '');
  } catch (err) {
    toast(err.message, 'err');
    throw err;
  }
}

function mergeWallet(w) {
  const i = S.wallets.findIndex((x) => x.id === (w.id || w.walletId));
  if (i >= 0) S.wallets[i] = w; else S.wallets.push(w);
  renderWallets(); renderStats(); renderPositions();
}

function mergePositionsFromWallet(pos) {
  const i = S.positions.findIndex((p) => p.id === pos.id);
  if (pos.status === 'OPEN') {
    if (i >= 0) S.positions[i] = pos; else S.positions.push(pos);
  } else if (i >= 0) S.positions.splice(i, 1);
  renderPositions(); renderStats();
}

function upsertPosition(pos) {
  mergePositionsFromWallet(pos);
  renderWallets();
}

async function refreshAll() {
  const [wallets, positions, logs] = await Promise.all([
    api('/api/wallets').catch(() => S.wallets || []),
    api('/api/positions').catch(() => []),
    api('/api/logs?limit=200').catch(() => []),
  ]);
  S.wallets = wallets;
  S.positions = positions.filter((p) => p.status === 'OPEN');
  S.history = positions.filter((p) => p.status !== 'OPEN');
  S.logs = logs;
}

function pushLog(rec) {
  S.logs.push(rec);
  if (S.logs.length > 400) S.logs.splice(0, S.logs.length - 400);
  const box = $('log');
  if (!box) return;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.insertAdjacentHTML('beforeend', logLine(rec));
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

const logLine = (r) => {
  const t = new Date(r.ts).toISOString().slice(11, 19);
  const w = r.wallet ? `<span class="w">[${esc(typeof r.wallet === 'string' && r.wallet.length > 12 ? r.wallet.slice(0, 10) : r.wallet)}]</span>` : '';
  return `<div class="logline ${r.level}"><span class="t">${t}</span>${w}<span class="m">${esc(r.message)}</span></div>`;
};

/* ============================================================
   RENDER
   ============================================================ */
function renderAll() { renderNotices(); renderChips(); renderStats(); renderOverall(); renderWallets(); renderPositions(); renderHistory(); renderScanFeed(); renderScanner(); renderLog(); }

function renderChips() {
  const running = S.status?.running;
  $('runChip').className = `run-chip${S.status?.scanner?.connected ? ' on' : ''}`;
  $('runText').textContent = S.status?.scanner?.connected ? 'SCANNER LIVE' : 'SCANNER CONNECTING';
  // The old label ("Engine on/off") named the implementation, not the job. Two
  // levels of control exist — this one feeds candidates to the wallets, and each
  // wallet decides whether to trade — so the button says the first half out loud.
  $('runChip').title = 'Launch stream is independent of each wallet. Start a wallet on its card to trade.';

  // Two facts, one line each. Everything else about dry run lives in the mode bar
  // and in the switch itself, which the user can see without hovering anything.
  const dry = S.status?.dryRun !== false;
  $('modeChip').className = `mode-chip ${dry ? 'dry' : 'live'}`;
  $('modeText').textContent = dry ? 'DRY RUN — no real trades' : 'LIVE — real funds';
  $('modeChip').title = dry
    ? 'DRY RUN: trades are simulated. Funding and withdrawing are real.'
    : 'LIVE: every trade spends real SOL.';
  paintModeSwitch(dry);

  const c = $('connChip');
  c.className = `run-chip${S.connected ? ' on' : ''}`;
  $('connText').textContent = S.demo ? 'OFFLINE PREVIEW' : (S.connected ? 'connected' : 'disconnected');
  if (S.demo) c.classList.add('offline');
  else c.classList.remove('offline');
}

/**
 * Paint the DRY RUN ⇄ LIVE switch (the bar under the header).
 *
 * The switch lives in the page, not in a settings dialog, because "which mode
 * am I in, and how do I change it" has to be answerable without opening
 * anything. It is painted from the same state the header chip is painted from,
 * so the two can never disagree.
 */
function paintModeSwitch(dry) {
  const bar = $('modeBar');
  if (!bar) return;
  bar.classList.toggle('live', !dry);

  const title = $('modeBarTitle');
  const sub = $('modeBarSub');
  if (title) title.textContent = dry ? '🧪 DRY RUN — paper trading' : '🔴 LIVE — real funds';
  if (sub) {
    sub.textContent = dry
      ? 'Start a wallet for simulated trades.'
      : 'Real funds. Every trade is a real transaction from your wallets.';
  }

  const dryBtn = $('modeDry');
  const liveBtn = $('modeLive');
  if (dryBtn) {
    dryBtn.classList.toggle('on', dry);
    dryBtn.setAttribute('aria-pressed', dry ? 'true' : 'false');
  }
  if (liveBtn) {
    liveBtn.classList.toggle('on', !dry);
    liveBtn.setAttribute('aria-pressed', dry ? 'false' : 'true');
  }
}

/**
 * Change the trading mode. The ONLY path that does — the switch, the settings
 * dialog and the dry-run banner all call this.
 *
 * Going LIVE asks for confirmation in the page, not in a window.prompt(). That
 * mattered for a real user on a phone: the browser prompt was dismissed (or its
 * answer never came back), the app correctly refused to arm, and what the person
 * saw was "I pressed LIVE and nothing happened". A dialog drawn by the page
 * cannot be swallowed by the browser, and it can put the input and the button in
 * the same view.
 *
 * Returning to dry run is free and immediate: making someone type a phrase to
 * STOP risking money would be perverse.
 */
async function setTradingMode(goLive) {
  const dry = !goLive;
  const already = S.status ? S.status.dryRun !== false : true;
  if (already === dry) {
    toast(dry ? 'Already in dry run — nothing here spends real SOL.' : 'Already live.', '');
    return;
  }
  if (goLive) return openLiveConfirm();
  return applyTradingMode(true);
}

/** The one place the mode is actually changed. */
async function applyTradingMode(dry) {
  try {
    await api('/api/engine/dry-run', {
      method: 'POST',
      body: JSON.stringify({ dryRun: dry, confirm: dry ? undefined : 'I_UNDERSTAND_THE_RISK' }),
    });
    // Repaint the chip from the state the server just confirmed, not from the
    // renderAll() above: renderAll does not repaint the header chips, so the chip
    // could still read "DRY RUN" while the app was already live. Found while
    // probing the new confirmation dialog.
    renderChips();
    toast(
      dry ? '🧪 DRY RUN — trades are simulated again' : '🔴 LIVE — real funds from here',
      dry ? '' : 'err',
    );
  } catch (err) { toast(err.message, 'err'); }
}

/**
 * Confirm going live, in the page.
 *
 * The word to type is short because it has to be typed on a phone keyboard; the
 * consequence is stated once, plainly, above it. The old full phrase is still
 * accepted.
 */
function openLiveConfirm() {
  openModal(`
    <div class="modal" style="max-width:460px">
      <div class="modal-head"><span class="modal-title">🔴 Turn on LIVE trading?</span></div>
      <div class="modal-body">
        <div class="notice danger" style="margin:0 0 14px">
          <span class="ico">⚠</span>
          <div><b>Real funds from here.</b> Every buy and sell is a real transaction from your wallets.</div>
        </div>
        <div class="field">
          <label>Type LIVE to confirm</label>
          <input type="text" id="lvWord" class="inp" placeholder="LIVE" autocapitalize="characters" autocomplete="off"/>
          <div class="hint">Stops, kill buttons and the loss limit still apply.</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-modal="1">Stay in dry run</button>
        <button class="btn btn-danger" id="lvGo" disabled>Arm LIVE</button>
      </div>
    </div>`, (root) => {
    const q = (sel) => root.querySelector(sel);
    const input = q('#lvWord');
    const go = q('#lvGo');
    const ok = () => {
      const v = String(input.value || '').trim();
      return v.toUpperCase() === 'LIVE' || v === 'I_UNDERSTAND_THE_RISK';
    };
    input.oninput = () => { go.disabled = !ok(); };
    input.onkeydown = (e) => { if (e.key === 'Enter' && ok()) go.click(); };
    go.onclick = async () => {
      if (!ok()) return;
      go.disabled = true;
      go.textContent = 'Arming…';
      closeModal();
      await applyTradingMode(false);
    };
    input.focus();
  });
}

/* ------------------------------------------------------------------ *
 * The user's own wallet (used only for funding in and out)
 * ------------------------------------------------------------------ *
 * We speak the Solana Wallet Standard, which every current wallet exposes
 * (Phantom, Solflare, Backpack, Glow, Magic Eden, Coinbase…).
 *
 * We request exactly ONE feature: solana:signTransaction. We hand the wallet
 * raw bytes, the user approves in their own extension, and the signed bytes
 * come back to us to broadcast. We never see their key.
 *
 * There is deliberately no use of signAllTransactions and no use of
 * signMessage anywhere in this file. Those two calls are precisely what a
 * drainer needs, and this project exists because of a site that used them.
 */
const WSOL = {
  wallets: [],
  connected: null, // { wallet, account }
  listeners: [],
};

const b64ToBytes = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const bytesToB64 = (bytes) => btoa(String.fromCharCode(...bytes));

function onWalletsChanged(fn) { WSOL.listeners.push(fn); }
function emitWalletsChanged() { WSOL.listeners.forEach((f) => { try { f(); } catch { /* ignore */ } }); }
WSOL.listeners.push(() => renderConnect());

/** Standard discovery handshake — wallets register themselves with us. */
function discoverWallets() {
  const found = [];
  const register = (...ws) => {
    let changed = false;
    for (const w of ws || []) {
      if (!w || !w.features) continue;
      // Only wallets that can sign a transaction are useful here.
      if (!w.features['solana:signTransaction']) continue;
      if (found.some((x) => x.name === w.name)) continue;
      found.push(w);
      changed = true;
    }
    if (changed) { WSOL.wallets = found; emitWalletsChanged(); }
  };

  window.addEventListener('wallet-standard:register-wallet', (e) => {
    try { e.detail({ register }); } catch { /* ignore */ }
  });
  const poke = () => window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: { register } }));
  poke();
  setTimeout(poke, 900); // some extensions register a beat late
  // After discovery settles, try to restore the last connection silently.
  setTimeout(reconnectWallet, 1100);
}

/** The wallet the user last connected, so a page reload does not forget it. */
const WALLET_KEY = 'meme-sniper.wallet';

async function connectWallet(w, { silent = false } = {}) {
  const feat = w.features['standard:connect'];
  if (!feat) throw new Error(`${w.name} does not support connecting`);
  const out = await feat.connect();
  const account = (out && out.accounts && out.accounts[0]) || (w.accounts && w.accounts[0]);
  if (!account) throw new Error(`${w.name} connected but exposed no account`);
  WSOL.connected = { wallet: w, account };
  try { localStorage.setItem(WALLET_KEY, w.name); } catch { /* private mode */ }
  emitWalletsChanged();
  if (!silent) toast(`Connected ${w.name}`, '');
  return account;
}

/**
 * Reconnect the wallet the user chose last time, without a prompt.
 *
 * A page reload used to drop the connection, so the user had to reconnect before
 * they could fund anything. standard:connect returns the accounts already
 * authorised for THIS origin, so a silent call succeeds for a wallet that is still
 * installed and still authorised — and quietly does nothing otherwise, leaving the
 * Connect button exactly as it was. No prompt, no error surface.
 */
let reconnectTried = false;
async function reconnectWallet() {
  if (reconnectTried || WSOL.connected) return;
  let name = null;
  try { name = localStorage.getItem(WALLET_KEY); } catch { /* private mode */ }
  if (!name) return;
  const w = (WSOL.wallets || []).find((x) => x.name === name);
  if (!w) return; // extension not installed here
  reconnectTried = true;
  try {
    const account = await connectWallet(w, { silent: true });
    // If the funding dialog is already open, refresh the block that names the
    // wallet the user is funding from.
    const mount = $('fundSource');
    if (mount && S.fundingWalletId) {
      try { renderFundSource(mount, S.wallets.find((x) => x.id === S.fundingWalletId)); } catch { /* dialog closed */ }
    }
    void account;
  } catch {
    // Not authorised any more, or the wallet wants a fresh user gesture. Forget it
    // and leave the normal Connect flow to the user.
    try { localStorage.removeItem(WALLET_KEY); } catch { /* ignore */ }
  }
}

function forgetWallet() {
  try { localStorage.removeItem(WALLET_KEY); } catch { /* ignore */ }
}

function disconnectWallet() {
  const c = WSOL.connected;
  forgetWallet(); // an explicit disconnect must survive a reload too
  WSOL.connected = null;
  emitWalletsChanged();
  try { c?.wallet?.features['standard:disconnect']?.disconnect?.(); } catch { /* ignore */ }
}

/**
 * Build → sign in the user's wallet → broadcast.
 * The only thing we ever ask their wallet to sign is a transfer we authored.
 */
async function fundFromConnectedWallet(walletId, amountSol) {
  if (S.demo) {
    // The same two-step handshake the real flow uses — intent, then submit — so
    // the UI exercises an identical code path against the simulator.
    const intent = await api('/api/fund/intent', {
      method: 'POST',
      body: JSON.stringify({ walletId, amountSol, from: 'demo' }),
    });
    await new Promise((r) => setTimeout(r, 450));
    return api('/api/fund/submit', {
      method: 'POST',
      body: JSON.stringify({ walletId, intentId: intent.intentId, amountSol }),
    });
  }

  const conn = WSOL.connected;
  if (!conn) throw new Error('Connect your wallet first');

  const intent = await api('/api/fund/intent', {
    method: 'POST',
    body: JSON.stringify({ walletId, amountSol, from: conn.account.address }),
  });

  const signer = conn.wallet.features['solana:signTransaction'];
  const outputs = await signer.signTransaction({
    transaction: b64ToBytes(intent.txBase64),
    account: conn.account,
    chain: 'solana:mainnet',
  });
  const signed = outputs && outputs[0] && outputs[0].signedTransaction;
  if (!signed) throw new Error('Your wallet returned no signed transaction');

  const res = await api('/api/fund/submit', {
    method: 'POST',
    body: JSON.stringify({ intentId: intent.intentId, txBase64: bytesToB64(signed) }),
  });
  return res;
}

/* --------------------------- Keystore gating --------------------------- */

/** Single source of truth. `undefined` means not loaded yet — treat as locked. */
function isKeystoreUnlocked() {
  return Boolean(S.keystore && S.keystore.unlocked);
}

/**
 * The ONE place that answers "is there a keystore, and is it open?".
 *
 * Anything that words a passphrase field differently ("choose one" vs. "type the
 * one you set") asks this. Do not re-derive it locally: a local `const` exists
 * only in the function that declares it, so re-deriving it in two places and
 * using one from the other throws `x is not defined` at runtime — which parses
 * fine, greps fine, and passes every test that talks to the API instead of the
 * DOM.
 *
 *   exists  a keystore file has been created at some point
 *   open    unlocked for this session (keys are readable)
 *   locked  exists && !open — the bot restarts into exactly this state
 *   isNew   nothing exists yet, so the passphrase entered now CREATES it
 */
function keystoreState() {
  const exists = Boolean(S.keystore && S.keystore.initialised);
  const open = isKeystoreUnlocked();
  return { exists, open, locked: exists && !open, isNew: !exists };
}

/**
 * Run `action` once the keystore is unlocked, prompting for the passphrase first
 * if needed. Stops wallet actions from dead-ending in the state the bot boots in.
 */
/**
 * Explain the offline preview rather than offering a form that can only fail.
 *
 * The dashboard is served from a static file in preview mode, so a POST here
 * hits a file host and comes back as a bare HTTP 405 — which looks like a bug in
 * the bot and is not. Saying so plainly is the honest answer, and it also tells
 * the user where the real thing lives.
 */
function openPreviewNotice() { openOfflineNotice('use this dashboard for real'); }

function openOfflineNotice(what) {
  openModal(`
    <div class="modal" style="max-width:560px">
      <div class="modal-head"><span class="modal-title">🔌 Offline preview</span>
        <button class="btn btn-ghost btn-sm" data-close-modal="1" title="Close this dialog (Esc also works)">Close</button></div>
      <div class="modal-body">
        <div class="notice warn"><span class="ico">⚠</span><div>
          <b>There is no bot behind this page.</b> It is a static file — nothing here reaches a wallet.
        </div></div>
        <div class="section-label">To actually ${esc(what)}</div>
        <div class="hint" style="line-height:1.9">
          1 · Start the bot on your machine:<br/>
          <code class="mono">npm start</code><br/><br/>
          2 · Open the terminal it prints:<br/>
          <code class="mono">http://localhost:8787/terminal</code><br/><br/>
          3 · Open the keystore in that tab, then ${esc(what)}.
        </div>
        <div class="notice info" style="margin-top:14px"><span class="ico">ℹ</span><div>
          Every figure on this page is <b>sample data</b>.
        </div></div>
      </div>
      <div class="modal-foot"><button class="btn btn-block" data-close-modal="1">Close</button></div>
    </div>`);
}

/**
 * Run `action` once the keystore is open, offering the passphrase first when it
 * is not.
 *
 * Wording rule, because it caused real confusion: this prompts about the KEYSTORE
 * (the file holding your keys), never about "unlocking a wallet". A wallet is
 * created, funded, started and killed; a keystore is opened.
 */
function promptUnlockThen(action, why = 'continue') {
  if (isKeystoreUnlocked()) { action(); return; }

  const init = !(S.keystore && S.keystore.initialised);
  openModal(`
    <div class="modal" style="max-width:520px">
      <div class="modal-head"><span class="modal-title">🔐 ${init ? 'Choose a passphrase for your wallet keys' : 'Keystore passphrase'}</span>
        <button class="btn btn-ghost btn-sm" id="ulCancel">Cancel</button></div>
      <div class="modal-body">
        <div class="notice info"><span class="ico">ℹ</span><div>
          <b>This is your keystore, not a wallet.</b><br/>
          One encrypted file holds the keys to every wallet you make. It re-locks itself whenever
          the bot restarts, so this is asked for once each session. ${esc(why)} continues
          automatically straight after.
        </div></div>
        <label class="fl-label">${init ? 'Choose a passphrase' : 'Passphrase'}</label>
        <input type="password" id="ulPass" class="inp"
               placeholder="${init ? 'New passphrase (at least 8 characters)' : 'Your passphrase'}"
               autocomplete="current-password"/>
        ${init ? '<div class="hint">At least 8 characters. There is no recovery if you lose this — put it in a password manager before continuing.</div>' : ''}
        <button class="btn btn-primary" id="ulGo" style="margin-top:14px;width:100%">
          ${init ? 'Create keystore' : 'Continue'}
        </button>
      </div>
    </div>`);

  const submit = async () => {
    const pass = $('ulPass').value;
    if (!pass) return toast('Enter a passphrase', 'warn');
    const btn = $('ulGo');
    btn.disabled = true;
    try {
      const res = await api(init ? '/api/keystore/init' : '/api/keystore/unlock', {
        method: 'POST', body: JSON.stringify({ passphrase: pass }),
      });
      const st = await api('/api/status');
      S.keystore = st.keystore;
      closeModal();
      await refreshAll();
      renderAll();
      toast(res.walletsLoaded ? `Keystore open — ${res.walletsLoaded} wallet(s) loaded` : 'Keystore ready', '');
      action();
    } catch (err) {
      toast(err.message, 'err');
      btn.disabled = false;
    }
  };

  $('ulGo').textContent = init ? 'Create keystore & continue' : 'Continue';
  $('ulGo').addEventListener('click', submit);
  $('ulCancel').addEventListener('click', closeModal);
  $('ulPass').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') submit(); });
  setTimeout(() => { const el = $('ulPass'); if (el) el.focus(); }, 50);
}

/* ------------------------------ Funding UI ------------------------------ */

function renderFundSource(mount, wallet) {
  const conn = WSOL.connected;
  const detected = WSOL.wallets;

  if (conn) {
    mount.innerHTML = `
      <div class="wsol-connected">
        <div>
          <div class="fg-k">Connected wallet</div>
          <div class="wsol-name">${esc(conn.wallet.name)}</div>
          <div class="wsol-addr mono">${esc(conn.account.address)}</div>
        </div>
        <button class="btn btn-sm btn-ghost" id="wsolDisc">Disconnect</button>
      </div>`;
    $('wsolDisc').addEventListener('click', () => { disconnectWallet(); renderFundSource(mount, wallet); });
    return;
  }

  mount.innerHTML = detected.length
    ? `<div class="wsol-pick">
         <div class="hint" style="margin-bottom:8px">Connect your own wallet to fund this trading wallet in one approval.</div>
         ${detected.map((w, i) => `<button class="btn btn-sm" data-wi="${i}">${esc(w.name)}</button>`).join(' ')}
       </div>`
    : `<div class="notice warn"><span class="ico">⚠</span><div>
         <b>No Solana wallet detected in this browser.</b>
         Funding works by connecting a wallet you already own and approving one transfer —
         there is no address to copy.
         <br/><br/>
         Install <b>Phantom</b>, <b>Solflare</b>, <b>Backpack</b> or <b>Magic Eden</b>, then reload
         this page. If the extension is already installed, make sure it is set up and open, then reload.
       </div></div>`;

  mount.querySelectorAll('[data-wi]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await connectWallet(detected[Number(btn.dataset.wi)]);
        renderFundSource(mount, wallet);
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  });
}

/** Which wallet the funding dialog is currently open for (used to refresh it). */
let fundingWalletId = null;

function openFund(walletId) {
  const w = S.wallets.find((x) => x.id === walletId);
  if (!w) return;
  // The reconnect handler refreshes the dialog by reading S.fundingWalletId, so
  // this has to be set here as well — it was a module-level copy that nothing
  // ever read, and the "funded from" block silently stopped updating.
  fundingWalletId = w.id;
  S.fundingWalletId = w.id;

  const real = isRealAddress(w.publicKey);
  const demo = Boolean(S.demo); // no extension and no chain in the preview
  const cfg = w.config || {};
  const maxSize = cfg.buy?.maxAmountSol ?? 0;
  const maxOpen = cfg.buy?.maxConcurrentPositions ?? 1;
  const worstExposure = maxSize * maxOpen;
  const fees = 0.05;
  const suggested = Math.ceil((worstExposure + fees) * 100) / 100;

  let body = !real
    ? `<p class="muted">This is a demo placeholder — not a real address, and not connected to any chain. Start the bot with <code class="mono">npm start</code> and open <code class="mono">http://localhost:8787</code>.</p>`
    : `
      <p class="muted">Swap SOL into this trading wallet from a wallet you already own, or send it
      from anywhere. The bot's private key never leaves this machine.</p>

      <label class="fl-label">1 · Connect the wallet you are funding from</label>
      <div id="fundSource"></div>

      <label class="fl-label">2 · How much to send</label>
      <div class="row-flex">
        <input type="number" id="fundAmt" class="inp" step="0.05" min="0.01" value="${suggested}" />
        <span class="unit">SOL</span>
        <button class="btn btn-sm" id="fundSuggest">Use ${suggested}</button>
      </div>

      <button class="btn btn-primary" id="fundGo" style="margin-top:10px;width:100%">
        💸 Fund ${suggested} SOL
      </button>
      <div class="hint" id="fundGoHint" style="margin-top:8px">
        Your wallet will open and ask you to approve the transfer. Nothing is sent until you confirm it.
      </div>

      <div class="fund-grid">
        <div><div class="fg-k">Current balance</div><div class="fg-v">${fmtSol(w.balanceSol, 4)} SOL</div><div class="fg-k">${usdOf(w.balanceSol)}</div></div>
        <div><div class="fg-k">Max position</div><div class="fg-v">${maxSize} SOL</div></div>
        <div><div class="fg-k">Max concurrent</div><div class="fg-v">${maxOpen}</div></div>
      </div>

      <div class="fund-suggest">
        <b>~${suggested} SOL</b>
        <span class="muted">= ${maxOpen} × ${maxSize} SOL worst-case exposure (${worstExposure} SOL)
        plus ~${fees} SOL for priority fees and account rent.</span>
      </div>

      <div class="notice warn" style="margin:14px 0 0">
        <span class="ico">⚠</span>
        <div><b>This balance IS your risk.</b> Fund a dedicated hot wallet with only what you can
        afford to lose — never your main wallet. There is no reversal on Solana.</div>
      </div>

      <div class="notice info" style="margin:10px 0 0">
        <span class="ico">ℹ</span>
        <div><b>You do not have to fund it yet.</b> Dry run trades a pretend balance, tagged
        <span class="paper-tag">SIMULATED</span> on the wallet card, so you can validate the strategy
          for free. Funding is only needed when you arm live trading.</div>
      </div>
    `;

  // In the preview there is no wallet extension to connect and nothing to sign,
  // so the same flow runs against the simulator. It stays fully labelled: a
  // simulated transfer is never dressed up as a real one.
  if (demo) {
    body = `
      <div class="notice warn" style="margin:0 0 16px"><span class="ico">⚠</span><div>
        <b>Preview — nothing is real here.</b> There is no wallet extension and no chain in this
        view, so pressing Fund changes a sample balance and nothing else. Remove all doubt by
        running the bot for real: <code class="mono">npm start</code> then
        <code class="mono">/terminal</code>.
      </div></div>

      <label class="fl-label">1 · Connect the wallet you are funding from</label>
      <div class="notice info" style="margin:0 0 14px"><span class="ico">👛</span><div>
        In the real bot this is where Phantom / Solflare / Backpack / Magic Eden is detected and
        offered. A browser preview cannot reach an extension.
      </div></div>

      <label class="fl-label">2 · How much to send</label>
      <div class="row-flex">
        <input type="number" id="fundAmt" class="inp" step="0.05" min="0.01" value="${suggested}" />
        <span class="unit">SOL</span>
        <button class="btn btn-sm" id="fundSuggest">Use ${suggested}</button>
      </div>

      <button class="btn btn-primary" id="fundGo" style="margin-top:10px;width:100%">
        💸 Fund ${suggested} SOL (simulated)
      </button>
      <div class="hint" id="fundGoHint" style="margin-top:8px">
        Simulated transfer — the balance below will change so you can see the flow work.
      </div>

      <div class="fund-grid">
        <div><div class="fg-k">Current balance</div><div class="fg-v">${fmtSol(w.balanceSol, 4)} SOL</div><div class="fg-k">${usdOf(w.balanceSol)}</div></div>
        <div><div class="fg-k">Max position</div><div class="fg-v">${maxSize} SOL</div></div>
        <div><div class="fg-k">Max concurrent</div><div class="fg-v">${maxOpen}</div></div>
      </div>

      <div class="fund-suggest">
        <b>~${suggested} SOL</b>
        <span class="muted">= ${maxOpen} × ${maxSize} SOL worst-case exposure (${worstExposure} SOL)
        plus ~${fees} SOL for priority fees and account rent.</span>
      </div>

      <div class="notice warn" style="margin:14px 0 0">
        <span class="ico">⚠</span>
        <div><b>This balance IS your risk.</b> When you run it for real, fund a dedicated hot
        wallet with only what you can afford to lose — never your main wallet.</div>
      </div>
    `;
  }

  openModal(`
    <div class="modal" style="max-width:620px">
      <div class="modal-head"><span class="modal-title">💸 Fund ${esc(w.name)}</span>
        <button class="btn btn-ghost btn-sm" data-close-modal="1" title="Close this dialog (Esc also works)">Close</button></div>
      <div class="modal-body">${body}</div>
    </div>`);

  const source = $('fundSource');
  if (source) {
    renderFundSource(source, w);
    onWalletsChanged(() => { renderFundSource(source, w); });
  }

  const amtEl = $('fundAmt');
  const go = $('fundGo');

  const syncButton = () => {
    const a = Number(amtEl.value) || 0;
    if (!go.disabled) go.textContent = a > 0 ? `💸 Fund ${a} SOL` : '💸 Fund';
  };
  amtEl.addEventListener('input', syncButton);

  const sug = $('fundSuggest');
  if (sug) sug.addEventListener('click', () => { amtEl.value = suggested; syncButton(); });
  syncButton();

  if (go) {
    go.addEventListener('click', async () => {
      const amount = Number(amtEl.value);
      if (!(amount > 0)) return toast('Enter an amount', 'warn');
      if (!demo && !WSOL.connected) return toast('Connect your wallet above first', 'warn');
      if (amount > 100) {
        if (!confirm(`You are about to send ${amount} SOL. That is a large amount — are you sure?`)) return;
      }

      go.disabled = true;
      go.textContent = 'Waiting for your wallet…';
      ($('fundGoHint') || {}).textContent = 'Approve the transfer in your wallet extension.';
      try {
        const res = await fundFromConnectedWallet(w.id, amount);
        toast(demo ? `Funded ${amount} SOL (simulated)` : `Funded ${amount} SOL`, '');
        showTx(res.signature, 'Funding transaction');
        closeModal();
        await refreshAll(); renderAll();
      } catch (err) {
        // Rejecting in the wallet is a normal choice, not a failure state.
        const m = String(err.message || err);
        const rejected = /reject|denied|cancel/i.test(m);
        toast(rejected ? 'Cancelled in wallet' : m, rejected ? 'warn' : 'err');
        const hint = $('fundGoHint');
        if (hint) hint.textContent = rejected
          ? 'You cancelled the transfer in your wallet. Nothing was sent.'
          : 'Your wallet will open and ask you to approve the transfer.';
      } finally {
        go.disabled = false;
        syncButton();
      }
    });
  }
}

/* ------------------------------ Withdraw UI ------------------------------ */

function openWithdraw(walletId) {
  const w = S.wallets.find((x) => x.id === walletId);
  if (!w) return;

  const demo = Boolean(S.demo);
  const conn = WSOL.connected;
  const destDefault = conn ? conn.account.address : (demo ? 'DEMO-YourWallet-not-a-real-address' : '');
  /* Can THIS tab sign? When it holds the sealed key for this address — the same
   * test the wallet card uses to decide between "Unlock" and "Import".
   *
   * Deliberately not gated on demo mode: the preview is where this flow gets
   * looked at, and a dialog that behaves differently there from the real one is
   * how "the preview lied to me" stories start. In demo the passphrase is still
   * asked for and still checked against the sealed key; only the broadcast is
   * simulated, and the dialog says so. */
  const browserCanSign = keyHere(w.publicKey);

  openModal(`
    <div class="modal" style="max-width:620px">
      <div class="modal-head"><span class="modal-title">🏧 Withdraw from ${esc(w.name)}</span>
        <button class="btn btn-ghost btn-sm" data-close-modal="1" title="Close this dialog (Esc also works)">Close</button></div>
      <div class="modal-body">
        <p class="muted">${demo
          ? 'Preview — simulated. Real withdrawals are never simulated by dry run.'
          : 'Move SOL out of this wallet. Real, and <b>not</b> simulated by dry run.'}</p>

        <label class="fl-label">Send to</label>
        <div class="row-flex">
          <input type="text" id="wdDest" class="inp mono" placeholder="Your wallet address" value="${esc(destDefault)}" />
          ${conn ? '<button class="btn btn-sm" id="wdUseConn">Use connected</button>' : ''}
        </div>
        ${conn || demo ? '' : '<div class="hint">Connect your wallet in the Fund panel to fill this automatically, or paste any Solana address.</div>'}

        <label class="fl-label">Amount</label>
        <div class="row-flex">
          <input type="number" id="wdAmt" class="inp" step="0.05" min="0.001" value="0.5" />
          <span class="unit">SOL</span>
          <button class="btn btn-sm" id="wdMax">Withdraw all</button>
        </div>

        <div id="wdQuote" class="wd-quote"></div>

        <!--
          Who signs this transfer. The reference bot signs withdrawals with the
          keypair it holds in the tab; this does the same whenever this browser is
          holding the wallet's sealed key, which is the normal case. The key is
          unsealed HERE, used HERE, and never sent anywhere — only the signed bytes
          travel. When the browser cannot sign (a wallet made under the old build,
          or a fresh device), the bot's session key does it instead, and the dialog
          says so rather than leaving the user guessing which one happened.
        -->
        ${browserCanSign ? `
          <label class="fl-label" style="margin-top:10px">Passphrase for ${esc(w.name)}</label>
          <input type="password" id="wdPass" class="inp" placeholder="Opens this wallet's key in your browser, to sign the transfer"
                 autocomplete="current-password" />
          <div class="hint" id="wdSignNote">
            🔐 Signed <b>in this browser</b>. Your passphrase and your key never leave this device —
            only the signed transfer is sent to the bot to broadcast.
          </div>`
          : `<div class="hint" id="wdSignNote">
              ${w.keyArmed === false
                ? "🔐 This wallet's key is not in this browser, so the bot needs it unlocked to sign: unlock the wallet first, or import its key."
                : "🔏 Signed by the bot's session key — this wallet's key is loaded in the bot, not in this browser."}
            </div>`}

        <button class="btn btn-danger" id="wdGo" style="margin-top:12px;width:100%">Withdraw</button>
      </div>
    </div>`);

  let mode = 'custom';

  const refreshQuote = async () => {
    const el = $('wdQuote');
    el.innerHTML = '<div class="muted" style="padding:10px 0">Reading balance…</div>';
    try {
      const qs = mode === 'all'
        ? 'mode=all'
        : `amountSol=${encodeURIComponent($('wdAmt').value || 0)}`;
      const q = await api(`/api/wallets/${w.id}/withdraw/quote?${qs}`);
      const warn = q.warnings.length
        ? `<div class="wd-warn">${q.warnings.map((x) => `<div>⚠ ${esc(x)}</div>`).join('')}</div>` : '';
      el.innerHTML = `
        <div class="wd-rows">
          <div><span>Wallet balance</span><b>${fmtSol(q.balanceSol, 4)} SOL</b></div>
          <div><span>You receive</span><b>${fmtSol(q.amountSol, 4)} SOL</b></div>
          <div><span>Network fee</span><b>${fmtSol(q.feeSol, 6)} SOL</b></div>
          ${q.rentReserveSol ? `<div><span>Kept for rent-exempt</span><b>${fmtSol(q.rentReserveSol, 6)} SOL</b></div>` : ''}
          <div><span>Balance after</span><b>${fmtSol(q.resultingBalanceSol, 4)} SOL</b></div>
          <div><span>Max withdrawable</span><b>${fmtSol(q.maxWithdrawableSol, 4)} SOL</b></div>
        </div>
        ${warn}`;
    } catch (err) {
      el.innerHTML = `<div class="wd-warn">⚠ ${esc(err.message)}</div>`;
    }
  };

  if ($('wdUseConn')) $('wdUseConn').addEventListener('click', () => { $('wdDest').value = conn.account.address; });
  $('wdAmt').addEventListener('input', () => { mode = 'custom'; });
  $('wdMax').addEventListener('click', () => {
    mode = 'all';
    $('wdAmt').value = '';
    refreshQuote();
  });
  $('wdAmt').addEventListener('change', refreshQuote);
  refreshQuote();

  $('wdGo').addEventListener('click', async () => {
    const dest = $('wdDest').value.trim();
    if (!dest) return toast('Enter a destination address', 'warn');

    const label = mode === 'all' ? 'ALL remaining SOL' : `${$('wdAmt').value} SOL`;
    if (!confirm(`Send ${label} out of ${w.name} to:\n\n${dest}\n\nThis is a real on-chain transfer and cannot be reversed.`)) return;

    const btn = $('wdGo');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      let res;
      const passEl = $('wdPass');
      const store = walletStore();
      if (passEl && store) {
        // ── signed HERE, in the browser — the reference bot's path ──
        const pass = passEl.value;
        if (!pass) throw new Error('Type the passphrase for this wallet to sign the transfer');

        let secretKey;
        try {
          secretKey = await store.unlock(w.publicKey, pass);
        } catch (err) {
          throw new Error(/wrong passphrase/i.test(err.message)
            ? 'That passphrase does not open this wallet'
            : err.message);
        }
        if (!secretKey) throw new Error('This browser has no sealed key for this wallet');

        if (demo) {
          // The preview cannot broadcast, but the passphrase is still checked
          // against the sealed key, so the flow behaves as it does for real.
          secretKey.fill(0);
          res = await api(`/api/wallets/${w.id}/withdraw`, {
            method: 'POST',
            body: JSON.stringify({ destination: dest, mode, amountSol: Number($('wdAmt').value || 0), confirm: 'WITHDRAW' }),
          });
          toast(`Withdrew ${res.amountSol} SOL — preview, nothing was broadcast`, 'warn');
        } else {
          const intent = await api(`/api/wallets/${w.id}/withdraw/intent`, {
            method: 'POST',
            body: JSON.stringify({ destination: dest, mode, amountSol: Number($('wdAmt').value || 0) }),
          });
          const signed = await store.signTransaction(b64ToBytes(intent.txBase64), secretKey);
          secretKey.fill(0); // done with it; the sealed copy is untouched

          res = await api(`/api/wallets/${w.id}/withdraw/submit`, {
            method: 'POST',
            body: JSON.stringify({ intentId: intent.intentId, txBase64: bytesToB64(signed) }),
          });
          toast(`Withdrew ${res.amountSol} SOL — signed in your browser`, '');
        }
      } else {
        // ── signed by the bot, with the session key it holds ──
        res = await api(`/api/wallets/${w.id}/withdraw`, {
          method: 'POST',
          body: JSON.stringify({
            destination: dest,
            mode,
            amountSol: Number($('wdAmt').value || 0),
            confirm: 'WITHDRAW',
          }),
        });
        toast(`Withdrew ${res.amountSol} SOL`, '');
      }
      showTx(res.signature, 'Withdrawal');
      closeModal();
      await refreshAll(); renderAll();
    } catch (err) {
      toast(err.message, 'err');
      const note = $('wdSignNote');
      if (note && /passphrase/i.test(err.message)) note.innerHTML = `⚠ ${esc(err.message)}`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Withdraw';
    }
  });
}

/** Link a confirmed signature to a block explorer so the user can verify it. */
function showTx(signature, label) {
  if (!signature) return;
  const url = `https://solscan.io/tx/${signature}`;
  const root = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `${esc(label || 'Transaction')} confirmed ·
    <a href="${url}" target="_blank" rel="noopener"><span class="mono">${esc(short(signature, 6))}</span></a>`;
  root.appendChild(el);
  setTimeout(() => el.remove(), 15000);
}

function renderNotices() {
  const out = [];
  if (S.demo) {
    out.push(`<div class="notice warn"><span class="ico">⚠</span><div>
      <b>Demo mode.</b> Sample data, placeholder addresses — never send funds to them.
      Run <code class="mono">npm start</code> for the real bot.
    </div></div>`);
  }
  if (S.status && S.status.dryRun === false) {
    out.push(`<div class="notice danger"><span class="ico">⚠</span><div><b>LIVE — real funds.</b> Every buy and sell is a real transaction.</div></div>`);
  }
  const imported = (S.wallets || []).filter((w) => w.imported);
  if (imported.length) {
    out.push(`<div class="notice warn"><span class="ico">⚠</span><div>
      <b>${imported.length} wallet(s) use a key you imported:</b>
      ${imported.map((w) => esc(w.name)).join(', ')}. Keep only what you can lose on them.
    </div></div>`);
  }
  const recovered = S.status?.recoveredPositions || 0;
  if (recovered) {
    out.push(`<div class="notice info"><span class="ico">♻</span><div>
      <b>${recovered} position${recovered === 1 ? '' : 's'} resumed after a restart.</b> Your normal exits manage them again.
    </div></div>`);
  }

  const stuck = (S.wallets || []).filter((w) => w.stats?.paused);
  if (stuck.length) {
    out.push(`<div class="notice warn"><span class="ico">⏸</span><div><b>${stuck.length} wallet(s) paused:</b> ${stuck.map((w) => `${esc(w.name)} — ${esc(w.stats.pauseReason || 'manual')}`).join(' · ')}</div></div>`);
  }
  // A host that rebuilds its disk must say so BEFORE the wallets disappear, not
  // after. Render's free plan does exactly this when the service sleeps.
  const st = S.status && S.status.storage;
  if (st && st.ephemeral) {
    out.push(`<div class="notice warn"><span class="ico">⚠</span><div>
      <b>This host rebuilds its disk when it sleeps.</b> Your <b>wallets are safe</b> — their keys are
      sealed in this browser. What it forgets is each wallet's strategy and position history, and every
      wallet has to be unlocked again after it wakes.
      <div class="row-flex" style="margin-top:10px;gap:8px;flex-wrap:wrap">
        <button class="btn btn-sm" data-backup="1">⬇ Download a backup now</button>
        <button class="btn btn-sm" data-restore="1">⬆ Restore from a backup</button>
      </div>
    </div></div>`);
  }

  // The facts, in two sentences. The mode bar above already names the mode and
  // carries the switch; this line exists for the one thing that surprises people —
  // that funding and withdrawing are real even here.
  if (S.status && S.status.dryRun !== false) {
    out.push(`<div class="notice info"><span class="ico">i</span><div>
      <b>Dry run: trades are simulated.</b> Funding and withdrawing <b>are real</b>.
    </div></div>`);
  }

  const lockedNow = (S.wallets || []).filter((w) => w.keyLocked);
  if (lockedNow.length) {
    const here = lockedNow.filter((w) => keyHere(w.publicKey)).length;
    out.push(`<div class="notice warn"><span class="ico">🔒</span><div>
      <b>${lockedNow.length} wallet${lockedNow.length === 1 ? ' is' : 's are'} locked.</b>
      ${here ? 'Open one from its card below — its passphrase is the only thing it needs.' : 'Import their keys to trade them again.'}
    </div></div>`);
  }

  $('notices').innerHTML = out.join('');
  // The banner is the first thing on the page, so its button is the first useful
  // action available — wire it rather than making the user hunt in the header.
  const nb = $('notices').querySelector('[data-keystore]');
  if (nb) nb.onclick = openKeystore;
  const bb = $('notices').querySelector('[data-backup]');
  if (bb) bb.onclick = downloadBackup;
  const rb = $('notices').querySelector('[data-restore]');
  if (rb) rb.onclick = openRestore;
  const cfgLink = $('notices').querySelector('[data-open-settings]');
  if (cfgLink) cfgLink.onclick = (e) => { e.preventDefault(); openSettings(); };
}

/**
 * Per-wallet and overall trade counts, in one card.
 *
 * "How many trades were done, how many were wins, how many were losses" was
 * answerable only by opening each wallet in turn, and the combined strip at the
 * top showed a win rate with no counts behind it. This is that answer, for every
 * wallet at once, with the totals underneath — the same shape as the reference
 * bot's stats bar, extended to break the numbers down by wallet because this bot
 * trades several.
 */
function renderOverall() {
  const mount = $('overall');
  if (!mount) return;

  const ws = (S.wallets || []).slice().sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const row = (name, bought, wins, losses, realised, open, closed, muted) => {
    const total = closed !== null ? closed : wins + losses;
    const rate = wins + losses > 0 ? `${((wins / (wins + losses)) * 100).toFixed(0)}%` : '—';
    return `<tr class="${muted ? 'mute' : ''}">
      <td class="sym">${esc(name)}</td>
      <td class="num">${bought === null ? '—' : bought}</td>
      <td class="num">${total === null ? '—' : total}</td>
      <td class="num pos">${wins || '—'}</td>
      <td class="num neg">${losses || '—'}</td>
      <td class="num">${rate}</td>
      <td class="num ${cls(realised)}">${fmtSol(realised || 0, 3)}<div class="mute" style="font-size:10px">${usdOf(realised || 0)}</div></td>
      <td class="num">${open === null ? '—' : open}</td>
    </tr>`;
  };

  const totals = ws.reduce((a, w) => {
    const st = w.stats || {};
    a.bought += st.bought || 0;
    a.wins += st.wins || 0;
    a.losses += st.losses || 0;
    a.realised += st.realisedPnlSol || 0;
    a.open += (w.openPositions || []).length;
    a.locked = a.locked || Boolean(w.keyLocked);
    return a;
  }, { bought: 0, wins: 0, losses: 0, realised: 0, open: 0, locked: false });
  // The server's own figures win when they are present: a locked wallet keeps its
  // counts in config.json, and those are the numbers this card is asked to show.
  const regAll = (S.status && S.status.overall) || null;
  if (regAll && Number.isFinite(regAll.bought)) totals.bought = regAll.bought;

  const registered = (S.status && S.status.overall) || null;
  const closedTotal = registered && Number.isFinite(registered.closed) ? registered.closed : totals.wins + totals.losses;
  const rate = totals.wins + totals.losses > 0 ? `${((totals.wins / (totals.wins + totals.losses)) * 100).toFixed(1)}%` : '—';
  const dry = S.status ? S.status.dryRun !== false : true;

  mount.innerHTML = `
    <div class="panel-head">
      <span class="panel-title">Trades per wallet <span class="count" id="overallCount">${ws.length}</span></span>
      <span class="panel-sub">${dry ? 'simulated trades (DRY RUN)' : 'real trades'} · ${closedTotal} closed in total${totals.locked ? ' · locked wallets show their last saved figures' : ''}</span>
    </div>
    <div class="panel-body">
      <div class="tbl-wrap">
        <table class="overall-tbl">
          <thead><tr>
            <th>Wallet</th>
            <th class="num" title="Tokens this wallet BOUGHT and took a position in.">Bought</th>
            <th class="num" title="Positions that have CLOSED — won or lost. Open ones are counted in the last column, not here.">Closed</th>
            <th class="num">Won</th><th class="num">Lost</th>
            <th class="num" title="Wins as a share of closed trades — every wallet combined in the totals row.">Win rate</th>
            <th class="num">Realised</th><th class="num">Open</th>
          </tr></thead>
          <tbody>
            ${ws.map((w) => {
              const st = w.stats || {};
              const open = (w.openPositions || []).length;
              return row(w.name + (w.keyLocked ? ' 🔒' : '') + (w.persistent ? ' 🖥' : ''), st.bought || 0, st.wins || 0, st.losses || 0, st.realisedPnlSol || 0, open, null, Boolean(w.keyLocked));
            }).join('')}
            <tr class="overall-total">
              <td class="sym"><b>All wallets</b></td>
              <td class="num"><b>${totals.bought}</b></td>
              <td class="num"><b>${closedTotal}</b></td>
              <td class="num pos"><b>${totals.wins}</b></td>
              <td class="num neg"><b>${totals.losses}</b></td>
              <td class="num"><b>${rate}</b></td>
              <td class="num ${cls(totals.realised)}"><b>${fmtSol(totals.realised, 3)}</b></td>
              <td class="num"><b>${totals.open}</b></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="notice info" style="margin-top:10px"><span class="ico">ℹ</span><div>
        A token is BOUGHT when the wallet opens a position in it, and a TRADE when that position
        CLOSES — a winning exit or a losing one. The board above adds up every wallet; each wallet's
        own card and 📄 Trades dialog show only its own.
      </div></div>
    </div>`;
}

function renderStats() {
  const ws = S.wallets || [];
  const open = S.positions || [];
  const totalPnl = ws.reduce((a, w) => a + (w.stats?.realisedPnlSol || 0), 0);
  const unrealised = open.reduce((a, p) => a + (p.pnlSol || 0), 0);
  const exposure = ws.reduce((a, w) => a + (w.exposureSol || 0), 0);
  // In dry run the wallet has no real funds; show the notional balance and tag it
  // so a paper number is never mistaken for a real one.
  const paper = ws.some((w) => w.paperTrading);
  const balance = ws.reduce((a, w) => a + (w.paperTrading ? (w.paperBalanceSol || 0) : (w.balanceSol || 0)), 0);
  const wins = ws.reduce((a, w) => a + (w.stats?.wins || 0), 0);
  const losses = ws.reduce((a, w) => a + (w.stats?.losses || 0), 0);
  const winRate = wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0;
  const detected = S.status?.stats?.detected || 0;
  const bought = S.status?.stats?.bought || 0;
  // Say "paper" on every money figure that dry run invented. The user's exact
  // complaint was not being able to tell which numbers were pretend.
  const dry = S.status ? S.status.dryRun !== false : true;
  const armedCount = ws.filter((w) => (w.armed !== undefined ? w.armed : (w.enabled && !w.stats?.paused))).length;
  const feedRows = (S.scanFeed || []).length;

  const cards = [
    [dry ? 'Realised P&L (day) · paper' : 'Realised P&L (day)', `${fmtSol(totalPnl)} SOL`,
      [usdOf(totalPnl), `${armedCount} wallet${armedCount === 1 ? '' : 's'} armed${dry ? ' · simulated' : ''}`].filter(Boolean).join(' · '),
      cls(totalPnl), cls(totalPnl) === 'pos' ? 'accent' : cls(totalPnl) === 'neg' ? 'red' : ''],
    [dry ? 'Unrealised · paper' : 'Unrealised', `${fmtSol(unrealised)} SOL`,
      [usdOf(unrealised), `${open.length} open${dry ? ' · simulated' : ''}`].filter(Boolean).join(' · '), cls(unrealised), 'blue'],
    ['Win rate', wins + losses ? `${winRate.toFixed(1)}%` : '—', `${wins}W / ${losses}L${dry ? ' · paper' : ''}`, winRate >= 50 ? 'pos' : 'dim', ''],
    ['Exposure', `${fmtSol(exposure, 2)} SOL`,
      [usdOf(exposure), dry ? 'of ' + fmtSol(balance, 2) + ' paper balance' : 'of ' + fmtSol(balance, 2) + ' balance'].filter(Boolean).join(' · '), 'dim', 'amber'],
    ['Tokens scanned', detected.toLocaleString(),
      `${bought} bought · ${detected ? ((bought / detected) * 100).toFixed(1) : '0'}% hit · ${feedRows} in the feed below`, 'dim', ''],
  ];

  $('stats').innerHTML = cards.map(([label, value, sub, vcls, accent]) => `
    <div class="stat ${accent}">
      <div class="stat-label">${esc(label)}</div>
      <div class="stat-value ${vcls}">${esc(value)}</div>
      <div class="stat-sub">${esc(sub)}</div>
    </div>`).join('');
}

function renderWallets() {
  // A WS tick arrives every 2s. Replacing innerHTML while the owner types
  // destroys the input/keyboard and discards the passphrase on Android.
  // Do not repaint until the field blurs. The next tick will catch up.
  if ($('wallets')?.querySelector('input:focus')) return;
  /* The SERVER's list, plus whatever this browser is holding that the server does
   * not have. See browserHeldWallets() — this is the line that makes "No wallets
   * yet" impossible while a sealed key is sitting in localStorage. */
  const held = browserHeldWallets();
  const ws = [...(S.wallets || []), ...held];
  $('walletCount').textContent = ws.length;
  if (held.length) S.heldWallets = held.map((w) => w.publicKey);

  if (!ws.length) {
    // One empty state now, because there is one truth: a wallet is created in
    // this browser. (The old version branched on the server keystore's state —
    // a file that no longer holds the wallets, so its branches had stopped
    // meaning anything.)
    const empty = {
      icon: '◈',
      title: 'No wallets yet',
      sub: `A wallet is a keypair this bot trades with. It is created in this browser and sealed here under its own passphrase — so it cannot be lost when the server restarts.`,
    };
    $('wallets').innerHTML = `<div class="empty" style="grid-column:1/-1">
        <div class="empty-icon">${empty.icon}</div>
        <div class="empty-title">${empty.title}</div>
        <div class="empty-sub">${empty.sub}<br/><br/>
          <button class="btn btn-primary btn-sm" id="emptyCreate">Create your first wallet</button>
        </div>
      </div>`;
    // Straight to the create form, which carries its own passphrase field. The
    // keystore modal belongs to the 🔐 Keystore button in the header, for opening
    // a keystore you already have — never in front of "create".
    const cb = $('emptyCreate');
    if (cb) cb.addEventListener('click', () => openWallet(null));
    return;
  }

  $('wallets').innerHTML = ws.map((w) => {
    // A wallet the bot cannot sign for yet. Its key is not in this process.
    //
    // Two situations, worded differently because the fix is different:
    //   · the key is SEALED IN THIS BROWSER (the normal case) — type that wallet's
    //     passphrase and it is armed for this session;
    //   · the key is nowhere on this device — it must be imported, and saying
    //     "unlock" would be a lie.
    // This card is where that used to be a dead end: it told you the wallet was
    // locked and offered no way to unlock it.
    if (w.localOnly) {
      // Held in this browser, unknown to the server. It cannot trade yet — but it
      // exists, it has an address, and the two things the user can do about it are
      // both one tap.
      return `<div class="wallet-card" data-wallet="${esc(w.id)}">
        <div class="wallet-head">
          <div>
            <div class="wallet-name">${esc(w.name)}</div>
            <div class="wallet-addr mono dim">${esc(w.publicKey)}</div>
          </div>
          <span class="chip warn" title="This key is sealed in this browser and the server has no record of the wallet — for example after a redeploy threw its disk away. Registering it again takes one tap and does not touch the key.">⚠ not on the server</span>
        </div>
        <div class="wallet-note">The key is sealed here. Register the address to use this wallet; your passphrase stays here.</div>
        <div class="wallet-actions">
          <button class="btn btn-primary btn-sm" data-register="${esc(w.publicKey)}">♻ Register again</button>
          <button class="btn btn-sm btn-danger" data-forget="${esc(w.publicKey)}" title="Remove this wallet from THIS browser. Any funds on its address stay on chain — keep the passphrase and the address if it holds SOL.">Delete here</button>
        </div>
      </div>`;
    }

    if (w.keyLocked) {
      const here = keyHere(w.publicKey);
      /* THREE ways to be without a key, and they are not the same situation.
       *   · sealed in THIS browser      → type that wallet's passphrase;
       *   · in the SERVER's keystore    → open the keystore and it loads;
       *   · nowhere this app can see    → it has to be imported.
       * The middle one is every wallet made before the browser keystore existed,
       * and it is where this card used to lie: it said "no key here, import it"
       * about a key sitting one 🔐 away — and for a wallet holding funds, that is
       * advice to type a private key that the user may not have. */
      // …but only if a keystore file actually exists; without one, "open the
      // keystore" would be the same dead end this card exists to remove.
      const inKeystore = !here && w.keyMissing === false && !(S.keystore && S.keystore.initialised === false);
      return `<div class="wallet locked">
        <div class="wallet-top">
          <div style="flex:1;min-width:0">
            <div class="wallet-name">
              ${esc(w.name)}
              <span class="locked-badge" title="${here ? 'The key is sealed in this browser. Type its passphrase to arm it for this session.' : inKeystore ? 'The key is encrypted in the keystore file on the server. Opening the keystore arms it.' : 'No key for this wallet is stored in this browser.'}">${here ? '🔒 locked' : inKeystore ? '🔐 keystore' : '⚠ no key here'}</span>
            </div>
            <div class="wallet-addr mono" title="${esc(w.publicKey || '')}">${esc((w.publicKey || '').slice(0, 14))}…${esc((w.publicKey || '').slice(-6))}</div>
          </div>
          <span class="wallet-preset">${esc((w.config || {}).preset || 'custom')}</span>
        </div>

        <div class="wallet-locked-note">
          ${here
            ? `Key sealed in this browser. Type its passphrase to trade or withdraw.`
            : inKeystore
              ? `Its key is in your server keystore. Open the keystore to arm this wallet — if the keystore cannot open it, import the key instead.`
              : `No key for this wallet is stored here. Import it to trade this wallet again — <b>anything at the address above stays on chain.</b>`}
        </div>

        ${here ? `
          <div class="arm-row">
            <input type="password" id="armpass-${esc(w.id)}" placeholder="Passphrase for ${esc(w.name)}" autocomplete="current-password"/>
            <button class="btn btn-primary btn-sm" data-arm="${esc(w.id)}" title="Unseal this wallet's key in the browser and load it into the bot for this session">🔓 Unlock</button>
          </div>
          <div class="arm-row" style="margin-top:6px">
            <button class="btn btn-sm" data-persist="${esc(w.id)}" title="Send this wallet's key to the bot once, encrypted, so it can trade while this tab is closed and after a restart. You can take it back at any time.">🖥 Send to bot (trades with the tab closed)</button>
          </div>` : ''}

        <div class="wallet-actions">
          <span class="badge sim" style="align-self:center">${w.persistent ? '🖥 on bot' : here ? '🔒 locked' : inKeystore ? '🔐 keystore' : 'no key'}</span>
          <div style="flex:1"></div>
          ${w.persistent ? `<button class="btn btn-sm" data-unpersist="${esc(w.id)}" title="Remove this wallet's key from the server. The sealed copy in this browser is untouched.">⏏ Remove from bot</button>` : ''}
          ${here
            ? `<button class="btn btn-sm" data-edit="${esc(w.id)}" title="Strategy, limits, exits and filters for this wallet">⚙ Config</button>
               <button class="btn btn-sm btn-danger" data-delrecord="${esc(w.id)}" title="Remove this wallet from the bot and this browser. Its funds stay on chain.">🗑 Delete</button>`
            : inKeystore
              ? `<button class="btn btn-sm btn-primary" data-keystore="1" title="Open your keystore — the key for this wallet is encrypted in it">🔐 Open keystore</button>
                 <button class="btn btn-sm btn-danger" data-delrecord="${esc(w.id)}" title="Remove this wallet record. Its funds stay on chain.">🗑 Delete record</button>`
              : `<button class="btn btn-sm btn-primary" data-importhere="${esc(w.id)}" title="Paste this wallet's private key and seal it in this browser">📥 Import its key</button>
                 <button class="btn btn-sm btn-danger" data-delrecord="${esc(w.id)}" title="Remove this wallet record. Its funds stay on chain.">🗑 Delete record</button>`}
        </div>
        <div class="wallet-feed" data-wallet-feed="${esc(w.id)}"></div>
      </div>`;
    }

    const st = w.stats || {};
    const cfg = w.config || {};
    const pnl = st.realisedPnlSol || 0;
    const tiers = cfg.exits?.takeProfitTiers || [];
    const open = w.openPositions || [];
    const filledTiers = open.length ? (open[0].tiers || []).filter((t) => t.filled).length : 0;

    /* ARMED is the only state the control below keys off.
     *
     * It used to key off `paused` alone. Every wallet you create has
     * enabled:false, so a brand-new wallet — which has never traded and can't —
     * showed "⏸ Stop", which reads exactly like "this wallet is already
     * trading". Reported from the live app as "the start button is already
     * turned on". Armed answers the question actually being asked. */
    const armed = w.armed !== undefined ? Boolean(w.armed) : (Boolean(w.enabled) && !st.paused);
    const paperMode = w.paperTrading || (S.status ? S.status.dryRun !== false : false);
    const state = armed ? 'enabled' : st.paused ? 'paused' : 'off';
    const stateLabel = armed
      ? (paperMode ? 'paper trading' : 'trading')
      : st.paused
        ? `stopped · ${esc(st.pauseReason || 'stopped')}`
        : 'not started — press ▶ Start';

    return `<div class="wallet ${state}">
      <div class="wallet-top">
        <div style="flex:1;min-width:0">
          <div class="wallet-name">
            ${esc(w.name)}
            ${w.imported
              ? '<span class="imported-badge" title="You supplied this key. If it is your main wallet, move your savings off it.">⚠ IMPORTED</span>'
              : '<span class="burner-badge" title="Generated by this bot and funded by you — a true throwaway hot wallet.">🔥 BURNER</span>'}
          </div>
          <button class="btn btn-sm btn-fund" style="margin-top:7px" data-fund="${esc(w.id)}">💸 Fund</button>
        </div>
        <span class="wallet-preset">${esc(cfg.preset || 'custom')}</span>
      </div>

      <!--
        This card used to show the PAPER balance alone, so a wallet holding
        0 SOL on chain displayed "PAPER BAL. 10.000" and there was no way to tell
        whether the bot was looking at real money. The real balance is now the
        headline, always; the simulated balance is named as a simulation and is
        visibly secondary.
      -->
      <div class="wallet-stats">
        <div class="wstat">
          <div class="wstat-k">Real bal.</div>
          <div class="wstat-v ${w.balanceSol === null || w.balanceSol === undefined ? 'mute' : ''}" title="The SOL this wallet actually holds on Solana. Funding adds to it, withdrawing takes from it. In dry run it stays untouched by trades. Read from the address, so it is shown even while the wallet is locked.">${w.balanceSol === null || w.balanceSol === undefined ? (w.keyLocked ? 'unknown' : '—') : fmtSol(w.balanceSol, 3)}</div>
          <div class="wstat-sub">${w.balanceSol === null || w.balanceSol === undefined ? 'on chain' : `${usdOf(w.balanceSol)} on chain`}</div>
        </div>
        <div class="wstat">
          <div class="wstat-k">Sim. balance</div>
          <div class="wstat-v mute" title="A pretend balance, used only because the bot is in dry run. Simulated trades add and subtract here and nowhere else.">${fmtSol(w.paperBalanceSol || 0, 2)}</div>
          <div class="wstat-sub">${usdOf(w.paperBalanceSol || 0)}</div>
          <div class="wstat-sub"><span class="paper-tag">SIMULATED</span></div>
        </div>
        <div class="wstat"><div class="wstat-k" title="Tokens this wallet BOUGHT. Won and lost are the ones that have CLOSED — a position still open counts as bought and nothing else yet.">Bought</div><div class="wstat-v">${st.bought || 0}</div><div class="wstat-sub">${(st.wins || 0)}W / ${(st.losses || 0)}L</div></div>
        <div class="wstat"><div class="wstat-k">Realised</div><div class="wstat-v ${cls(pnl)}" title="Profit and loss booked from CLOSED trades on this wallet.">${fmtSol(pnl, 3)}</div><div class="wstat-sub">${usdOf(pnl)} · ${(st.wins || 0)}W / ${(st.losses || 0)}L</div></div>
        <div class="wstat"><div class="wstat-k">Win rate</div><div class="wstat-v">${(st.wins || 0) + (st.losses || 0) ? `${winRateOf(st).toFixed(0)}%` : '—'}</div><div class="wstat-sub">closed trades</div></div>
        <div class="wstat"><div class="wstat-k">Open</div><div class="wstat-v">${open.length}/${cfg.buy?.maxConcurrentPositions ?? '—'}</div></div>
      </div>

      <div class="tier-track">
        ${tiers.map((t, i) => `<div class="tier-pip ${i < filledTiers ? 'filled' : ''}" title="+${t.gainPct}% → sell ${t.sellPct}%"></div>`).join('') || '<div class="tier-pip"></div>'}
      </div>
      <div class="tier-legend">
        <span>SL ${cfg.exits?.stopLossPct ?? '—'}%</span>
        <span>trail ${cfg.exits?.trailing?.enabled ? `${cfg.exits.trailing.trailPct}%@+${cfg.exits.trailing.activationPct}%` : 'off'}</span>
        <span>limit ${fmtSol(cfg.limits?.dailyLossLimitSol, 2)}</span>
      </div>

      <div class="wallet-actions">
        <span class="badge ${armed ? 'won' : st.paused ? 'lost' : 'sim'}" style="align-self:center">${stateLabel}</span>
        ${w.persistent ? '<span class="badge sim" style="align-self:center" title="The bot holds this wallet\'s key, encrypted, so it trades while this tab is closed.">🖥 on bot</span>' : ''}
        <div style="flex:1"></div>
        ${armed
          ? `<button class="btn btn-sm btn-warn" data-stop="${esc(w.id)}" title="Stop new entries for this wallet. Open positions are still managed, so your stops keep working.">⏸ Stop</button>`
          : `<button class="btn btn-sm btn-primary" data-start="${esc(w.id)}" title="Start this wallet${paperMode ? ' — it is in DRY RUN, so its trades will be simulated (paper trades on a paper balance)' : ''}. This also starts the engine if it is stopped.">▶ Start</button>`}
        <button class="btn btn-sm" data-detail="${esc(w.id)}" title="This wallet's open positions, its own trade history, and the launches it saw">📄 Trades</button>

        <button class="btn btn-sm" data-edit="${esc(w.id)}" title="Strategy, limits, exits and filters for this wallet">⚙ Config</button>
        <button class="btn btn-sm" data-withdraw="${esc(w.id)}" title="Move SOL out of this wallet">Withdraw</button>
        ${w.persistent ? `<button class="btn btn-sm" data-unpersist="${esc(w.id)}" title="Remove this wallet's key from the server. The sealed copy in this browser is untouched.">⏏ Remove from bot</button>` : ''}
        <button class="btn btn-sm btn-danger" data-close="${esc(w.id)}" title="Sell everything in this wallet and stop it trading">⛔ Kill all</button>
            ${w.keyArmed === false ? '' : `<button class="btn btn-sm" data-lock="${esc(w.id)}" title="Forget this wallet's key for now. The sealed copy in your browser is untouched.">🔒 Lock</button>`}
      </div>
      <div class="wallet-feed" data-wallet-feed="${esc(w.id)}"></div>
    </div>`;
  }).join('');
  renderWalletFeeds();
}

/**
 * The launches ONE wallet has seen, in the order the table shows them.
 *
 * The terminal-wide list is the engine's view: every launch, and what every
 * wallet did with it. This is the same rows narrowed to a single wallet, so
 * "which token did THIS wallet buy" has a plain answer without reading a
 * comma-separated list of three wallets' verdicts.
 *
 * A row belongs to a wallet when the wallet has a verdict on it — every
 * evaluation writes one, including the `filtered` and `skipped` cases — or when
 * that wallet is the one that bought it.
 */
function renderWalletFeeds() {
  for (const w of S.wallets || []) {
    const mount = [...$('wallets').querySelectorAll('[data-wallet-feed]')]
      .find((el) => el.getAttribute('data-wallet-feed') === w.id);
    if (!mount) continue;
    const rows = walletFeed(w);
    const recent = rows.slice(0, 8);
    const body = `<div class="wallet-feed-title">📡 ${esc(w.name)} · pump.fun launches
      <span class="count">${rows.length}</span></div>
      ${recent.length ? `<div class="tbl-wrap">${walletFeedTable(w, 8)}</div>`
        : `<div class="wallet-feed-empty">${w.keyLocked
          ? 'Key locked · open this wallet to evaluate launches.'
          : w.armed ? 'Watching launches · no evaluation yet.' : 'Start this wallet to evaluate launches.'}</div>`}`;
    if (mount.innerHTML !== body) mount.innerHTML = body;
  }
}

function walletFeed(w) {
  if (!w) return [];
  return (S.scanFeed || []).filter((r) => {
    if (r.boughtById && r.boughtById === w.id) return true;
    if (!r.boughtById && r.boughtBy === w.name) return true; // old/demo rows
    return Array.isArray(r.wallets) && r.wallets.some((x) => x.walletId
      ? x.walletId === w.id : x.name === w.name);
  });
}

/** What this wallet did about one launch, in its own words. */
function walletVerdict(row, w) {
  const mine = Array.isArray(row.wallets) ? row.wallets.find((x) => x.walletId
    ? x.walletId === w.id : x.name === w.name) : null;
  const bought = row.boughtById ? row.boughtById === w.id : row.boughtBy === w.name;
  if (bought || (mine && mine.action === 'bought')) return { label: 'BOUGHT', cls: 'won', reason: null };
  if (!mine) return { label: 'not evaluated', cls: 'sim', reason: 'the engine had not reached this launch for this wallet' };
  if (mine.action === 'filtered') return { label: 'filtered', cls: 'sim', reason: mine.reason || 'its filters ruled the token out' };
  if (mine.action === 'rpc_error') return { label: 'rpc error', cls: 'lost', reason: mine.reason || 'the RPC did not answer — infrastructure, not the token' };
  if (mine.action === 'checking') return { label: 'evaluating…', cls: 'paper', reason: null };
  return { label: 'skipped', cls: 'sim', reason: mine.reason || row.skipReason || 'declined' };
}

/** The per-wallet launch table, shared by the 📄 Trades dialog and 📡 Feed. */
function walletFeedTable(w, limit = 40) {
  const rows = walletFeed(w).slice(0, limit);
  if (!rows.length) {
    return `<div class="empty" style="padding:18px"><div class="empty-sub">No launch has reached ${esc(w.name)} yet. Press ▶ Start on its card and they will appear here as they are scanned.</div></div>`;
  }
  return `<table class="scan-tbl">
    <thead><tr>
      <th>Token</th><th class="num">Dev hold</th><th class="num">Liquidity</th><th class="num">Risk</th>
      <th>What ${esc(w.name)} did</th>
    </tr></thead>
    <tbody>${rows.map((r) => {
      const v = walletVerdict(r, w);
      const liqUsd = r.liquidityUsd === null || r.liquidityUsd === undefined ? null : Number(r.liquidityUsd);
      const risk = r.riskScore === null || r.riskScore === undefined ? null : Number(r.riskScore);
      return `<tr>
        <td>
          <div class="scan-sym">${esc(r.symbol || 'unknown')}</div>
          <a class="scan-mint mono" href="https://pump.fun/coin/${esc(r.mint)}" target="_blank" rel="noopener noreferrer">${esc(short(r.mint, 4))}</a>
        </td>
        <td class="num ${r.devHoldPct === null || r.devHoldPct === undefined ? 'mute' : ''}">
          ${r.devHoldPct === null || r.devHoldPct === undefined ? 'unread' : `${Number(r.devHoldPct).toFixed(1)}%`}
        </td>
        <td class="num ${liqUsd === null ? 'mute' : ''}">
          ${liqUsd === null ? 'unread' : `$${liqUsd.toLocaleString('en-US')}`}
        </td>
        <td class="num ${risk === null ? 'mute' : risk >= 50 ? 'neg' : risk > 0 ? 'warn' : 'pos'}">
          ${risk === null ? 'unread' : risk}
        </td>
        <td>
          <span class="badge ${v.cls}" style="padding:1px 7px;font-size:9.5px">${esc(v.label)}</span>
          ${v.reason ? `<div class="scan-reason" title="${esc(v.reason)}">${esc(shortReason(v.reason))}</div>` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

/** One wallet's launches on their own, from the card. */
function openWalletFeed(walletId) {
  const w = (S.wallets || []).find((x) => x.id === walletId);
  if (!w) return;
  const rows = walletFeed(w);
  const bought = rows.filter((r) => r.boughtBy === w.name || (r.wallets || []).some((x) => x.name === w.name && x.action === 'bought')).length;
  openModal(`
    <div class="modal" style="max-width:900px">
      <div class="modal-head">
        <span class="modal-title">📡 ${esc(w.name)} — launches</span>
        <span class="wallet-preset">${rows.length} seen · ${bought} bought</span>
        <button class="btn btn-ghost btn-sm" data-close-modal="1" title="Close this dialog (Esc also works)">Close</button>
      </div>
      <div class="modal-body">
        <div class="notice info"><span class="ico">ℹ</span><div>
          Every launch this wallet evaluated, and what it did about it. A launch it never reached
          (the engine was stopped, or the queue was full) is not in this list.
        </div></div>
        <div class="tbl-wrap" style="margin-top:12px">${walletFeedTable(w)}</div>
      </div>
    </div>`);
}

/** Win rate for one wallet, as a percentage. 0 when it has not traded yet. */
function winRateOf(st) {
  const w = (st && st.wins) || 0;
  const l = (st && st.losses) || 0;
  return w + l > 0 ? (w / (w + l)) * 100 : 0;
}

/**
 * Everything one wallet has done: its own open positions and its own closed
 * trades. The board at the top of the page stays the aggregate across all
 * wallets; this is the per-wallet view, so "which wallet bought and sold what"
 * always has an answer.
 */
function openWalletDetail(walletId) {
  const w = (S.wallets || []).find((x) => x.id === walletId);
  if (!w) return;
  const st = w.stats || {};
  const open = w.openPositions || [];
  const closed = (w.recentPositions || []).filter((p) => p.status === 'CLOSED').slice(0, 40);

  const stat = (k, v, c) => `<div class="wstat"><div class="wstat-k">${k}</div><div class="wstat-v ${c || ''}">${v}</div></div>`;

  const openRows = open.length
    ? `<table><thead><tr><th>Token</th><th class="num">Spent</th><th class="num">Value</th><th class="num">P&amp;L</th><th></th></tr></thead>
        <tbody>${open.map((p) => {
          const val = (Number(p.solSpent) / 1e9) + (p.pnlSol || 0);
          return `<tr>
            <td class="sym">${esc(p.symbol)}<div class="mute" style="font-size:10px;font-weight:400">${esc(short(p.mint, 5))}</div></td>
            <td class="num">${esc((Number(p.solSpent) / 1e9).toFixed(3))}</td>
            <td class="num">${esc(val.toFixed(3))}</td>
            <td class="num ${cls(p.pnlPct ?? 0)}"><b>${fmtPct(p.pnlPct ?? 0)}</b><div class="mute" style="font-size:10px">${fmtSol(p.pnlSol, 4)}</div></td>
            <td><button class="btn btn-sm btn-danger" data-exit="${esc(p.id)}">⛔ Kill</button></td>
          </tr>`;
        }).join('')}</tbody></table>`
    : `<div class="empty" style="padding:22px"><div class="empty-sub">${esc(w.name)} holds nothing right now.</div></div>`;

  const closedRows = closed.length
    ? `<table><thead><tr><th>Token</th><th class="num">Spent</th><th class="num">Returned</th><th class="num">P&amp;L</th><th>Exit</th><th class="num">Held</th></tr></thead>
        <tbody>${closed.map((p) => {
          const spent = Number(p.solSpent) / 1e9;
          const returned = Number(p.realisedSol || 0) / 1e9;
          const pnl = returned - spent;
          return `<tr>
            <td class="sym">${esc(p.symbol || short(p.mint, 4))}</td>
            <td class="num">${esc(spent.toFixed(3))}</td>
            <td class="num">${esc(returned.toFixed(3))}</td>
            <td class="num ${cls(pnl)}"><b>${fmtSol(pnl, 4)}</b></td>
            <td><span class="badge sim">${esc(p.exitReason || '—')}</span></td>
            <td class="num">${esc(fmtAge(p.closedAt && p.openedAt ? p.closedAt - p.openedAt : 0))}</td>
          </tr>`;
        }).join('')}</tbody></table>`
    : `<div class="empty" style="padding:22px"><div class="empty-sub">No closed trades for ${esc(w.name)} yet.</div></div>`;

  openModal(`
    <div class="modal" style="max-width:820px">
      <div class="modal-head">
        <span class="modal-title">📄 ${esc(w.name)}</span>
        <span class="wallet-preset">${esc(w.config?.preset || 'custom')}</span>
        <button class="btn btn-ghost btn-sm" data-close-modal="1" title="Close this dialog (Esc also works)">Close</button>
      </div>
      <div class="modal-body">
        <div class="wallet-stats" style="grid-template-columns:repeat(6,1fr)">
          ${stat('Trades', String((st.wins || 0) + (st.losses || 0)))}
          ${stat('Won', String(st.wins || 0), 'pos')}
          ${stat('Lost', String(st.losses || 0), 'neg')}
          ${stat('Win rate', (st.wins || 0) + (st.losses || 0) ? `${winRateOf(st).toFixed(0)}%` : '—')}
          ${stat('Realised', `${fmtSol(st.realisedPnlSol || 0, 3)}${usdOf(st.realisedPnlSol || 0) ? ` · ${usdOf(st.realisedPnlSol || 0)}` : ''}`, cls(st.realisedPnlSol || 0))}
          ${stat('Real balance', `${fmtSol(w.balanceSol, 3)} SOL${usdOf(w.balanceSol) ? ` · ${usdOf(w.balanceSol)}` : ''}`)}
        </div>

        <div class="section-label">What ${esc(w.name)} did with the launches it saw (${walletFeed(w).length})</div>
        <div class="tbl-wrap">${walletFeedTable(w)}</div>

        <div class="section-label">Open positions (${open.length})</div>
        <div class="tbl-wrap">${openRows}</div>

        <div class="section-label">Trade history (${closed.length})</div>
        <div class="tbl-wrap">${closedRows}</div>

        <div class="notice info" style="margin-top:14px"><span class="ico">ℹ</span><div>
          Only <b>${esc(w.name)}</b>'s trades are shown here. The board at the top of the page is the
          total across every wallet.
        </div></div>
      </div>
      <div class="modal-foot">
        <button class="btn btn-danger" id="wdDelete">Delete</button>
        <div style="flex:1"></div>
        <button class="btn btn-fund" id="wdFund">💸 Fund</button>
        <button class="btn" id="wdWithdraw">Withdraw</button>
        <button class="btn" id="wdConfig">⚙ Config</button>
        <button class="btn btn-danger" id="wdKill">⛔ Kill all</button>
      </div>
    </div>`, (root) => {
    S.detailWallet = w.id; // so a kill from inside here re-renders this view
    root.querySelector('#wdFund').onclick = () => openFund(w.id);
    root.querySelector('#wdWithdraw').onclick = () => openWithdraw(w.id);
    root.querySelector('#wdConfig').onclick = () => openWallet(w.id);
    root.querySelector('#wdKill').onclick = () => {
      closeModal();
      document.querySelector(`[data-close="${w.id}"]`)?.click();
    };
    root.querySelector('#wdDelete').onclick = async () => {
      if (!confirm(
        `Delete "${w.name}"?\n\n` +
        'Its key is removed from the keystore, so the wallet can no longer be traded or recovered ' +
        'by this bot. Any SOL or tokens still in it stay on chain — withdraw them first if you want them.\n\n' +
        'This cannot be undone.'
      )) return;
      try {
        await api(`/api/wallets/${w.id}`, { method: 'DELETE' });
        closeModal();
        await refreshAll(); renderAll();
        toast(`Deleted ${w.name}`, 'warn');
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

function renderPositions() {
  const ps = S.positions || [];
  $('posCount').textContent = ps.length;

  const dry = S.status ? S.status.dryRun !== false : true;
  if (!ps.length) {
    $('positions').innerHTML = `<div class="empty"><div class="empty-icon">◎</div>
      <div class="empty-title">No open positions</div>
      <div class="empty-sub">Positions appear here the moment a wallet fills${
        dry ? ' — paper positions in dry run' : ''}.</div></div>`;
    return;
  }

  $('positions').innerHTML = `<table>
    <thead><tr>
      <th>Token</th><th>Wallet</th><th class="num">Entry</th><th class="num">Value</th>
      <th class="num">P&L</th><th>Stop vs price</th><th>Tiers</th><th class="num">Age</th><th></th>
    </tr></thead>
    <tbody>${ps.map(positionRow).join('')}</tbody>
  </table>`;
}

function positionRow(p) {
  const pnl = p.pnlPct ?? 0;
  const gain = p.priceGainPct ?? 0;
  const stop = p.stopLevelPct ?? -25;
  const peak = p.peakGainPct ?? 0;

  // Visualise where price sits relative to its stop, on a −100%…+peak+40% axis.
  const lo = Math.min(-40, stop - 10);
  const hi = Math.max(100, peak + 40);
  const span = hi - lo || 1;
  const posPct = Math.max(0, Math.min(100, ((gain - lo) / span) * 100));
  const stopPct = Math.max(0, Math.min(100, ((stop - lo) / span) * 100));

  const tiers = p.tiers || [];
  const filled = tiers.filter((t) => t.filled).length;

  return `<tr>
    <td class="sym">${esc(p.symbol || short(p.mint, 4))}${p.adopted ? '<span class="badge adopted" title="Recovered after a restart — size verified against the on-chain balance">♻ resumed</span>' : ''}${
      (p.simulated || (S.status && S.status.dryRun !== false))
        ? '<span class="badge sim" title="Paper trade: simulated in dry run. No transaction was signed, sent or paid for.">SIM</span>'
        : ''}<div class="mute" style="font-size:10px;font-weight:400">${esc(short(p.mint, 5))}</div></td>
    <td><span class="mute">${esc(p.wallet || p.walletId)}</span></td>
    <td class="num">${esc((Number(p.solSpent) / 1e9).toFixed(3))}</td>
    <td class="num">${esc(((Number(p.solSpent) / 1e9) + (p.pnlSol || 0)).toFixed(3))}</td>
    <td class="num ${cls(pnl)}"><b>${fmtPct(pnl)}</b><div class="mute" style="font-size:10px">${fmtSol(p.pnlSol, 4)}</div></td>
    <td>
      <div class="gauge" title="stop ${fmtPct(stop)} · peak ${fmtPct(peak)}">
        <div class="gauge-fill ${gain < 0 ? 'neg' : ''}" style="width:${posPct}%"></div>
        <div class="gauge-mark" style="left:${stopPct}%"></div>
      </div>
      <div class="mute" style="font-size:10px;margin-top:2px">stop ${fmtPct(stop)} · peak ${fmtPct(peak)}</div>
    </td>
    <td><span class="mono" style="font-size:11px">${filled}/${tiers.length}</span></td>
    <td class="num">${esc(fmtAge(p.ageMs ?? (Date.now() - p.openedAt)))}</td>
    <td><button class="btn btn-sm btn-danger" data-exit="${esc(p.id)}" title="Market-sell this position now, at any price">⛔ Kill</button></td>
  </tr>`;
}

function renderHistory() {
  const h = (S.history || []).slice(0, 40);
  $('histCount').textContent = (S.history || []).length;
  if (!h.length) {
    const dry = S.status ? S.status.dryRun !== false : true;
    $('history').innerHTML = `<div class="empty" style="padding:26px"><div class="empty-sub">Nothing closed yet.
      Exits land here with their reason.${dry ? ' In dry run these are paper trades.' : ''}</div></div>`;
    return;
  }
  $('history').innerHTML = `<table>
    <thead><tr><th>Token</th><th>Wallet</th><th class="num">Spent</th><th class="num">Returned</th><th class="num">P&L</th><th>Exit reason</th><th class="num">Held</th></tr></thead>
    <tbody>${h.map((p) => `<tr>
      <td class="sym">${esc(p.symbol || short(p.mint, 4))}${
        (p.simulated || (S.status && S.status.dryRun !== false)) ? '<span class="badge sim" title="Paper trade: simulated in dry run — no transaction was sent.">SIM</span>' : ''}</td>
      <td class="mute">${esc(p.wallet || p.walletId)}</td>
      <td class="num">${esc((Number(p.solSpent) / 1e9).toFixed(3))}</td>
      <td class="num">${esc((Number(p.realisedSol) / 1e9).toFixed(3))}</td>
      <td class="num ${cls(p.pnlSol)}">${fmtPct(p.pnlPct)}</td>
      <td><span class="badge ${p.pnlSol >= 0 ? 'won' : 'lost'}">${esc(p.exitReason || '—')}</span></td>
      <td class="num mute">${esc(fmtAge((p.closedAt || Date.now()) - p.openedAt))}</td>
    </tr>`).join('')}</tbody></table>`;
}

/**
 * The live pump.fun launch scanner.
 *
 * Each row is one launch: what it is, who deployed it, how much the dev holds,
 * what liquidity it has, its honeypot risk, and what the bot decided — with the
 * reason, so a wall of "skipped" is explainable instead of mysterious.
 */
function renderScanFeed() {
  const mount = $('scanFeed');
  if (!mount) return;
  const rows = S.scanFeed || [];
  const count = $('scanCount');
  // The number in this panel is the number of launches IN THIS LIST. It used to
  // be able to disagree with the "tokens scanned" card by 100 rows with nothing
  // on screen to explain it, which is what the user reported.
  if (count) count.textContent = String(rows.length);

  const meta = $('scanMeta');
  if (meta) {
    const evaluated = (S.status && S.status.stats && S.status.stats.detected) || 0;
    const feed = S.scanStats || (S.status && S.status.scan) || null;
    const bits = [`<b>${rows.length}</b> launch${rows.length === 1 ? '' : 'es'} in this list`];
    if (evaluated) bits.push(`wallets evaluated <b>${evaluated.toLocaleString()}</b> this session`);
    if (feed && feed.dropped) bits.push(`${feed.dropped} older row(s) rolled off (the list keeps the newest 200)`);
    if (S.status && !S.status.running) bits.push('wallet trading is idle');
    meta.innerHTML = bits.join(' · ');
  }

  // The dot reports the FEED, not the engine: a connected socket with the scanner
  // stopped is a different state from a dead socket, and they look the same if you
  // only render a boolean.
  const sc = (S.status && S.status.scanner) || {};
  const dot = $('scanDot');
  const dotText = $('scanDotText');
  if (dot && dotText) {
    const live = Boolean(sc.connected);
    dot.classList.toggle('on', live);
    dot.classList.toggle('off', !live);
    dotText.textContent = sc.connected ? 'live' : 'connecting';
    dot.title = sc.connected
      ? `Connected to ${sc.source || 'the launch feed'}. New launches appear here as they are created.`
      : 'Connecting to the pump.fun launch feed.';
  }

  if (!rows.length) {
    const connected = Boolean(sc.connected);
    const body = connected
      ? { title: 'Watching pump.fun — no launch yet.', sub: 'New tokens appear automatically.' }
      : { title: 'Connecting to pump.fun…', sub: 'No wallet needs to be started to see launches.' };
    mount.innerHTML = `
      <div class="scan-empty">
        <p><b>${body.title}</b></p>
        <p class="muted">${body.sub}</p>
      </div>`;
    return;
  }

  const decisionClass = {
    bought: 'won', skipped: 'sim', checking: 'paper', error: 'lost',
  };
  const decisionLabel = {
    bought: 'BOUGHT', skipped: 'skipped', checking: 'checking…', error: 'infra error',
  };

  mount.innerHTML = `
    <div class="scan-scroll">
      <table class="scan-tbl">
        <thead>
          <tr>
            <th>Token</th><th>Dev</th>
            <th class="num" title="The dev's own opening buy as a share of the 1,000,000,000 supply. Comes from the launch itself, so it is filled on every row; an on-chain holder read refines it when one succeeds.">Dev hold</th>
            <th class="num" title="SOL in the bonding curve, priced in dollars. A figure marked ≈ was converted at a fallback rate because no price provider answered.">Liquidity</th>
            <th class="num" title="0–100, higher is more dangerous. Scored from the dev hold and the liquidity above; a row marked * has not been checked on chain yet.">Risk</th>
            <th>Decision</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => {
            const risk = r.riskScore === null || r.riskScore === undefined ? null : Number(r.riskScore);
            const riskCls = risk === null ? 'mute' : risk >= 50 ? 'neg' : risk > 0 ? 'warn' : 'pos';
            const liqSol = r.liquiditySol === null || r.liquiditySol === undefined ? null : Number(r.liquiditySol);
            const liqUsd = r.liquidityUsd === null || r.liquidityUsd === undefined ? null : Number(r.liquidityUsd);
            /* LIQUIDITY is shown in dollars, because a SOL figure cannot be judged:
             * "0.98 SOL" means nothing to a person deciding whether to buy. The
             * reference bot shows USD here for the same reason.
             *
             * When the dollar figure had to be converted at a last-resort price
             * (every price API unreachable), it is marked — a guessed number
             * presented as a quote is exactly the kind of dishonesty this project
             * exists to not do. */
            const liqApprox = liqUsd !== null && (r.solUsdSource === 'fallback' || r.solUsdStale);
            const liqTitle = liqSol === null ? 'No curve reading for this launch.' :
              `${liqSol.toFixed(3)} SOL in the curve` +
              (liqUsd === null ? '' : ` · $${liqUsd.toLocaleString('en-US')} at ${r.solUsd ? `$${r.solUsd.toFixed(0)}/SOL` : 'the last known SOL price'}`) +
              (liqApprox ? ' · SOL price unavailable, converted at a fallback rate' : '');
            return `<tr>
              <td>
                <div class="scan-sym">${esc(r.symbol || 'unknown')}</div>
                <a class="scan-mint mono" href="https://pump.fun/coin/${esc(r.mint)}" target="_blank" rel="noopener noreferrer"
                   title="Open ${esc(r.mint)} on pump.fun">${esc(short(r.mint, 4))}</a>
                ${r.name && r.name !== r.symbol ? `<div class="scan-name">${esc(r.name)}</div>` : ''}
              </td>
              <td class="mono mute">${r.devWallet ? esc(short(r.devWallet, 4)) : '—'}</td>
              <td class="num ${r.devHoldPct === null || r.devHoldPct === undefined ? 'mute' : r.devHoldPct > 20 ? 'neg' : ''}"
                  title="${esc(r.devHoldPct === null || r.devHoldPct === undefined
                    ? 'The launch event carried no opening buy for this token, and the on-chain holder read did not finish.'
                    : `Dev's opening buy: ${Number(r.devHoldPct).toFixed(2)}% of the 1,000,000,000 supply (${(r.facts || {}).devHold === 'event' ? 'from the launch event' : 'read on chain'})`)}">
                ${r.devHoldPct === null || r.devHoldPct === undefined ? 'unread' : `${Number(r.devHoldPct).toFixed(1)}%`}
              </td>
              <td class="num" title="${esc(liqTitle)}">
                ${liqUsd === null
                  ? (liqSol === null ? '<span class="mute">unread</span>' : `<span class="mute">${liqSol.toFixed(2)} SOL</span>`)
                  : `$${liqUsd.toLocaleString('en-US')}${liqApprox ? '<span class="approx" title="SOL price unavailable — converted at a fallback rate">≈</span>' : ''}
                     <div class="mute" style="font-size:10px">${liqSol.toFixed(2)} SOL</div>`}
              </td>
              <td class="num ${riskCls}">
                ${risk === null
                  ? '<span class="mute" title="Neither the launch event nor the on-chain read produced anything to score this token on.">unread</span>'
                  : `${risk}${(r.facts || {}).risk === 'derived' ? '<span class="approx" title="Scored from the dev hold and liquidity in the launch event; no on-chain read yet.">*</span>' : ''}`}
                ${r.riskNotes && r.riskNotes.length ? `<span class="scan-risk-note" title="${esc(r.riskNotes.join(' · '))}">ⓘ</span>` : ''}
              </td>
              <td>
                <span class="badge ${decisionClass[r.decision] || 'sim'}" style="padding:1px 7px;font-size:9.5px">${esc(decisionLabel[r.decision] || r.decision)}</span>
                ${r.skipReason ? `<div class="scan-reason" title="${esc(r.skipReason)}">${esc(shortReason(r.skipReason))}</div>` : ''}
                ${r.boughtBy ? `<div class="scan-buyer">🔥 bought by <b>${esc(r.boughtBy)}</b></div>` : ''}
                ${r.wallets && r.wallets.length ? `<div class="scan-wallets">${esc(r.wallets.map((w) => `${w.name}: ${w.action === 'bought' ? 'bought' : (w.reason || w.action)}`).join(' · '))}</div>` : ''}
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

/** Filter reasons are machine-shaped ("liquidity_below_min(0.42)"); make them readable. */
function shortReason(reason) {
  const s = String(reason || '');
  const m = s.match(/^([a-z0-9_]+)\((.*)\)$/i);
  if (!m) return s.replace(/_/g, ' ');
  const words = m[1].replace(/_/g, ' ');
  return `${words} (${m[2]})`;
}

function renderScanner() {
  const s = S.status?.scanner || {};
  const st = S.status?.stats || {};
  const rows = [
    ['Source', s.source || '—', s.connected ? 'pos' : 'neg', s.connected ? 'connected' : 'offline'],
    ['Detected', (st.detected || 0).toLocaleString(), '', 'tokens this session'],
    ['Evaluated', (st.evaluated || 0).toLocaleString(), '', 'passed concurrency gate'],
    ['Bought', (st.bought || 0).toLocaleString(), (st.bought ? 'pos' : 'dim'), 'fills'],
    ['Filtered', (st.skipped || 0).toLocaleString(), '', 'rejected by rules'],
    ['Price feed', (S.status?.priceFeedSize || 0).toString(), '', 'tracked mints'],
  ];
  $('scanner').innerHTML = rows.map(([k, v, c, sub]) => `
    <div class="between" style="padding:6px 0;border-bottom:1px solid rgba(30,36,45,.5)">
      <span class="dim" style="font-size:11.5px">${esc(k)}</span>
      <span class="mono ${c}" style="font-size:12.5px;font-weight:600">${esc(v)}</span>
    </div>
    <div class="mute" style="font-size:10px;padding-bottom:5px">${esc(sub)}</div>`).join('');
}

function renderLog() {
  const box = $('log');
  box.innerHTML = (S.logs || []).map(logLine).join('');
  box.scrollTop = box.scrollHeight;
}

/* ============================================================
   MODALS
   ============================================================ */
function openModal(html, onMount) {
  S.detailWallet = null; // any other modal replaces the per-wallet view
  const root = $('modalRoot');
  root.innerHTML = `<div class="modal-bg" id="modalBg">${html}</div>`;
  $('modalBg').addEventListener('mousedown', (e) => { if (e.target.id === 'modalBg') closeModal(); });
  document.addEventListener('keydown', escClose);
  if (onMount) onMount(root);
}
function closeModal() {
  $('modalRoot').innerHTML = '';
  document.removeEventListener('keydown', escClose);
}
function escClose(e) { if (e.key === 'Escape') closeModal(); }

/* -------------------------- keystore modal -------------------------- */
function openKeystore() {
  const ks = S.keystore || {};
  openModal(`
    <div class="modal" style="max-width:520px">
      <div class="modal-head"><span class="modal-title">🔐 Your keystore — where your wallets' keys are kept</span></div>
      <div class="modal-body">
        <div class="notice info"><span class="ico">ℹ</span><div>
          One encrypted file at <code class="mono">data/keystore.enc</code> holds the keys to all your wallets —
          a password manager for this bot's wallets. It never leaves this machine, and the keys are readable
          only while it is open.
        </div></div>
        <div class="field">
          <label>${ks.initialised ? 'Keystore passphrase' : 'Choose a passphrase'}</label>
          <input type="password" id="ksPass" placeholder="${ks.initialised ? 'The passphrase you set before' : 'At least 8 characters'}" autocomplete="current-password"/>
          <div class="hint">${ks.initialised
            ? 'The bot closes the keystore every time it restarts, so this is asked for once per session.'
            : 'Setting this creates the keystore.'}</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-modal="1">Cancel</button>
        <button class="btn" id="ksBackup" title="Download one file holding your encrypted keystore and your wallet list. Useless without your passphrase — which is what makes it safe to keep.">⬇ Backup</button>
        <button class="btn" id="ksRestore" title="Put a backup file back — for example after your host wiped its disk">⬆ Restore</button>
        ${ks.initialised ? `<button class="btn" id="ksForgot" title="The passphrase cannot be recovered from the file — this starts a new, empty keystore instead">Forgot your passphrase?</button>` : ''}
        ${ks.initialised ? `<button class="btn btn-warn" id="ksLock">Lock</button>` : ''}
        <button class="btn btn-primary" id="ksGo">${ks.initialised ? 'Continue' : 'Create keystore'}</button>
      </div>
    </div>`, (root) => {
    root.querySelector('#ksGo').onclick = async () => {
      const pass = root.querySelector('#ksPass').value;
      try {
        const res = await api(ks.initialised ? '/api/keystore/unlock' : '/api/keystore/init', { method: 'POST', body: JSON.stringify({ passphrase: pass }) });
        // Unlocking is what loads the wallets (their keys are encrypted at rest),
        // so pull them in now — otherwise the panel stays empty until a reload.
        toast(res.walletsLoaded ? `Keystore open — ${res.walletsLoaded} wallet(s) loaded` : 'Keystore ready', '');
        closeModal();
        const st = await api('/api/status');
        S.keystore = st.keystore;
        await refreshAll();
        renderAll();
      } catch (err) { toast(err.message, 'err'); }
    };
    const bk = root.querySelector('#ksBackup');
    if (bk) bk.onclick = downloadBackup;
    const rs = root.querySelector('#ksRestore');
    if (rs) rs.onclick = () => { closeModal(); openRestore(); };
    const forgot = root.querySelector('#ksForgot');
    if (forgot) forgot.onclick = () => { closeModal(); openKeystoreForgot(); };
    const lock = root.querySelector('#ksLock');
    if (lock) lock.onclick = async () => {
      await api('/api/keystore/lock', { method: 'POST' });
      toast('Keystore closed — passphrase required again next session', 'warn'); closeModal();
    };
  });
}

/* --------------------------- wallet editor --------------------------- */
function openWallet(walletId, opts = {}) {
  const isNew = !walletId;
  const justCreated = Boolean(opts.justCreated);
  // How many wallets the user already has that are waiting on this keystore.
  // Quoting the real number is what turns "unlock god knows what" into
  // "oh — these three".
  const lockedCount = (S.wallets || []).filter((w) => w.keyLocked).length;
  const existing = (S.wallets || []).find((w) => w.id === walletId);
  // Merge over the defaults rather than trusting the stored config to be
  // complete. renderEditorPanes reads cfg.buy / cfg.exits / cfg.limits /
  // cfg.filters unconditionally, so a config missing any of them (an older
  // snapshot, a partial record, a wallet built from an empty template) throws
  // INSIDE the dialog's mount handler — and the user sees a Config button that
  // does nothing at all. One merge makes that impossible.
  const cfg = withDefaultCfg(existing?.config);
  S.editing = { id: walletId || null, cfg: JSON.parse(JSON.stringify(cfg)), isNew, name: existing?.name || '', pk: existing?.publicKey };
  S.activeTab = 'strategy';

  openModal(`
    <div class="modal" style="max-width:820px">
      <div class="modal-head">
        <span class="modal-title">${isNew ? 'Add wallet' : esc(existing.name)}</span>
        <div class="panel-actions"><span class="wallet-preset" id="edPreset">${esc(S.editing.cfg.preset || 'custom')}</span></div>
      </div>
      <div class="modal-body">
        ${justCreated ? `
          <div class="notice info" style="margin-bottom:16px"><span class="ico">✓</span><div>
            <b>Wallet created — stopped.</b> Set its <b>Exits</b>, <b>Limits</b> and <b>Filters</b> here,
            fund it when you like, then press <b>▶ Start</b> on its card to trade it.
          </div></div>` : ''}
        ${isNew ? `
          <div class="burner-intro">
            <div class="burner-ico">🔥</div>
            <div>
              <div class="burner-title">This creates a burner wallet</div>
              <div class="burner-sub">
                A throwaway hot wallet. You never put your real wallet's key in here: you
                <b>fund this burner from your own wallet</b> and withdraw back to it.
              </div>
            </div>
          </div>

          <div class="section-label">Passphrase for this wallet</div>
          <div class="field">
            <label>Choose a passphrase for <b>this wallet</b></label>
            <input type="password" id="edPass" placeholder="At least 8 characters" autocomplete="new-password"/>
            <div class="hint">
              The key is created <b>in this browser</b> and sealed here with this passphrase — not a
              password for an account, and not sent anywhere. Each wallet has its own.
              <br/><b>There is no recovery</b> — keep it in a password manager.
            </div>
            <div id="edPassErr" class="pass-err"></div>
          </div>

          <div class="section-label">The wallet</div>
          <div class="field">
            <label>Name this burner</label>
            <input type="text" id="edName" placeholder="e.g. Alpha" value=""/>
          </div>

          <div class="section-label">Strategy preset</div>
          <div class="field">
            <select id="edPresetSel" aria-label="Strategy preset">${Object.entries(S.presets || DEMO_PRESETS).map(([k, p]) => `<option value="${esc(k)}" ${k === 'balanced' ? 'selected' : ''}>${esc(p.label)} — ${esc(p.description)}</option>`).join('')}</select>
          </div>

          <details class="import-key">
            <summary>Advanced: import an existing key instead</summary>
            <div class="notice danger" style="margin:10px 0">
              <span class="ico">⚠</span>
              <div>
                <b>Do not paste your main wallet's key.</b> It is held here as a hot key and traded from.
                Fine for a burner you control; dangerous for your savings.
              </div>
            </div>
            <label class="fl-label">Private key — base58 or Phantom JSON array</label>
            <textarea id="edKey" rows="2" placeholder="Leave empty to generate a fresh burner"></textarea>
            <div class="hint" style="margin-top:6px">The key is sealed in this browser with the passphrase above.</div>
          </details>
        ` : ''}

        <div class="tabs" id="edTabs">
          ${['strategy', 'exits', 'limits', 'filters', 'ai'].map((t) => `<button class="tab ${t === 'strategy' ? 'active' : ''}" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
        </div>

        <div class="tabpane active" data-pane="strategy" id="paneStrategy"></div>
        <div class="tabpane" data-pane="exits" id="paneExits"></div>
        <div class="tabpane" data-pane="limits" id="paneLimits"></div>
        <div class="tabpane" data-pane="filters" id="paneFilters"></div>
        <div class="tabpane" data-pane="ai" id="paneAi"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-modal="1">Cancel</button>
        ${!isNew ? `<button class="btn btn-danger" id="edDelete">Delete wallet</button>` : ''}
        ${justCreated || !isNew ? `<button class="btn btn-fund" id="edFund">💸 Fund</button>` : ''}
        <button class="btn btn-primary" id="edSave">${isNew ? 'Create wallet' : 'Save changes'}</button>
      </div>
    </div>`, (root) => {
    const fundBtn = root.querySelector('#edFund');
    if (fundBtn) fundBtn.onclick = () => openFund(S.editing.id);
    root.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
      root.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      root.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
      root.querySelector(`[data-pane="${b.dataset.tab}"]`).classList.add('active');
    });

    renderEditorPanes(root);
    wireEditor(root);

    const del = root.querySelector('#edDelete');
    if (del) del.onclick = async () => {
      if (!confirm(
        `Delete "${existing.name}"?\n\n` +
        'Its sealed key is deleted from this browser and the bot forgets it, so nobody can trade or ' +
        'recover this wallet here again. Any SOL or tokens still in it stay on chain — withdraw them ' +
        'first if you want them, and keep the private key somewhere else if it holds anything.\n\n' +
        'This cannot be undone.'
      )) return;
      try {
        await api(`/api/wallets/${walletId}`, { method: 'DELETE' });
        const store = walletStore();
        if (store && existing.publicKey) store.remove(existing.publicKey);
        await refreshAll(); renderAll(); closeModal(); toast('Wallet deleted from the bot and this browser', 'warn');
      }
      catch (err) { toast(err.message, 'err'); }
    };
  });
}

/**
 * Deep-merge a (possibly partial) stored config over the defaults.
 *
 * Every renderer that touches config reads buy/exits/limits/filters directly.
 * A partial config therefore does not degrade gracefully — it throws while the
 * dialog is being mounted, which looks exactly like a dead button.
 */
function withDefaultCfg(partial) {
  const d = defaultCfg();
  const p = partial || {};
  return {
    ...d,
    ...p,
    buy: { ...d.buy, ...(p.buy || {}) },
    exits: { ...d.exits, ...(p.exits || {}), trailing: { ...d.exits.trailing, ...((p.exits || {}).trailing || {}) } },
    limits: { ...d.limits, ...(p.limits || {}) },
    filters: { ...d.filters, ...(p.filters || {}) },
    ai: { ...d.ai, ...(p.ai || {}) },
  };
}

function defaultCfg() {
  return {
    preset: 'balanced',
    buy: { minAmountSol: 0.1, maxAmountSol: 1.0, slippageBps: 1200, maxConcurrentPositions: 4, positionSizeMode: 'fixed', positionSizePercent: 2, kellyFraction: 0.25, autoCompound: false, cooldownMs: 2000 },
    exits: {
      takeProfitTiers: [{ gainPct: 50, sellPct: 33 }, { gainPct: 120, sellPct: 33 }, { gainPct: 300, sellPct: 100 }],
      stopLossPct: 25, trailing: { enabled: true, activationPct: 40, trailPct: 18, stepPct: 0 },
      breakEven: { enabled: true, activationPct: 30, offsetPct: 2 }, maxHoldMs: 1800000, liquidityDropExitPct: 55,
    },
    limits: { dailyLossLimitSol: 2, dailyProfitTargetSol: 0, maxTradesPerDay: 100, maxExposureSol: 3, stopAfterConsecutiveLosses: 5 },
    filters: {
      maxDevHoldPct: 20, requireMintAuthorityRevoked: true, requireFreezeAuthorityRevoked: true, maxBuyTaxPct: 10, maxSellTaxPct: 10,
      minLiquiditySol: 1, maxLiquiditySol: 0, maxTop10HoldersPct: 35, minHolders: 8, requireSocial: false, minNameLength: 2, blockCopycatNames: true,
      maxAgeMs: 120000, maxBondingCurvePct: 60, devBlacklist: [], mintBlacklist: [],
    },
    ai: { enabled: false, overrideProvider: '', minConfidence: 0 },
  };
}

function renderEditorPanes(root) {
  const c = S.editing.cfg;

  /* ---------------------------- STRATEGY ---------------------------- */
  root.querySelector('#paneStrategy').innerHTML = `
    <div class="field">
      <label>Preset</label>
      <select id="f_preset">${['safe', 'balanced', 'aggressive', 'degen', 'scalper'].map((k) => `<option value="${k}" ${c.preset === k ? 'selected' : ''}>${esc((S.presets?.[k]?.label) || k)} — ${esc((S.presets?.[k]?.description) || '')}</option>`).join('')}</select>
      <div class="hint">Changing the preset replaces the buy, exit and filter blocks below. You can then tweak any field.</div>
    </div>
    <div class="section-label">Keeping it running</div>
    <label class="switch"><input type="checkbox" id="f_resume" ${c.resumeAfterRestart !== false ? 'checked' : ''}/><span>Continue this wallet after a restart</span></label>
    <div class="hint" style="margin-top:8px">
      The bot trades on the <b>server</b>, so <b>closing this tab does not stop it</b> — a 24h
      target keeps being watched whether the dashboard is open or not.
      What <em>does</em> stop it is a restart or redeploy: with this on, open positions are written
      down and re-adopted (verified against the wallet's real balance) as soon as the keystore is
      open again. Turn it off for a wallet you always want to start flat.
    </div>

    <div class="section-label">Position sizing</div>
    <div class="grid3">
      <div class="field"><label>Min amount (SOL)</label><input type="number" step="0.01" id="f_min" value="${c.buy.minAmountSol}"/></div>
      <div class="field"><label>Max amount (SOL)</label><input type="number" step="0.01" id="f_max" value="${c.buy.maxAmountSol}"/></div>
      <div class="field"><label>Slippage (bps)</label><input type="number" step="10" id="f_slip" value="${c.buy.slippageBps}"/><div class="hint">${(c.buy.slippageBps / 100).toFixed(1)}%</div></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Size mode</label>
        <select id="f_sizemode">
          <option value="fixed" ${c.buy.positionSizeMode === 'fixed' ? 'selected' : ''}>Fixed random in range</option>
          <option value="percent" ${c.buy.positionSizeMode === 'percent' ? 'selected' : ''}>% of wallet balance</option>
          <option value="kelly" ${c.buy.positionSizeMode === 'kelly' ? 'selected' : ''}>Kelly (AI-adjusted)</option>
        </select></div>
      <div class="field"><label>Size % of balance</label><input type="number" step="0.1" id="f_sizepct" value="${c.buy.positionSizePercent}"/></div>
      <div class="field"><label>Kelly fraction</label><input type="number" step="0.05" id="f_kelly" value="${c.buy.kellyFraction}"/></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Max concurrent positions</label><input type="number" id="f_concurrent" value="${c.buy.maxConcurrentPositions}"/></div>
      <div class="field"><label>Cooldown between entries (ms)</label><input type="number" step="250" id="f_cooldown" value="${c.buy.cooldownMs}"/></div>
      <div class="field"><label>Auto-compound</label>
        <label class="switch"><input type="checkbox" id="f_compound" ${c.buy.autoCompound ? 'checked' : ''}/><span>Sweep profits into next snipe</span></label></div>
    </div>`;

  /* ------------------------------ EXITS ------------------------------ */
  root.querySelector('#paneExits').innerHTML = `
    <div class="notice warn"><span class="ico">◎</span><div>
      <b>Partial take-profits.</b> Each tier sells a share of the <b>original</b> position at that gain.
    </div></div>
    <div class="section-label">Take-profit tiers</div>
    <div id="tierList"></div>
    <button class="btn btn-sm" id="addTier">＋ Add tier</button>

    <div class="section-label">Loss limit (per trade)</div>
    <div class="grid2">
      <div class="field"><label>Stop loss (%)</label><input type="number" step="1" id="f_sl" value="${c.exits.stopLossPct}"/>
        <div class="hint">Hard exit when the position is down this much.</div></div>
      <div class="field"><label>Max hold time</label>
        <select id="f_maxhold">
          ${[[300000, '5 min'], [900000, '15 min'], [1800000, '30 min'], [3600000, '1 hour'], [7200000, '2 hours']].map(([v, l]) => `<option value="${v}" ${c.exits.maxHoldMs == v ? 'selected' : ''}>${l}</option>`).join('')}
          <option value="0" ${c.exits.maxHoldMs > 7200000 ? 'selected' : ''}>No limit</option>
        </select>
        <div class="hint">Time stop — exit regardless once elapsed.</div></div>
    </div>

    <div class="section-label">Trailing stop</div>
    <div class="grid3">
      <div class="field"><label>Enabled</label>
        <label class="switch"><input type="checkbox" id="f_trail_on" ${c.exits.trailing.enabled ? 'checked' : ''}/><span>Ride the pump</span></label></div>
      <div class="field"><label>Activation (%)</label><input type="number" step="5" id="f_trail_act" value="${c.exits.trailing.activationPct}"/>
        <div class="hint">Only starts trailing after this gain.</div></div>
      <div class="field"><label>Trail distance (%)</label><input type="number" step="1" id="f_trail_dist" value="${c.exits.trailing.trailPct}"/>
        <div class="hint">Exit when price falls this far from the peak.</div></div>
    </div>
    <div class="field"><label>Step quantisation (%)</label><input type="number" step="1" id="f_trail_step" value="${c.exits.trailing.stepPct}"/>
      <div class="hint">0 = off. Rounds the trailing floor down to this increment, so noisy micro-pumps don't tighten it prematurely.</div></div>

    <div class="section-label">Break-even</div>
    <div class="grid3">
      <div class="field"><label>Enabled</label>
        <label class="switch"><input type="checkbox" id="f_be_on" ${c.exits.breakEven.enabled ? 'checked' : ''}/><span>Protect profit</span></label></div>
      <div class="field"><label>Activation (%)</label><input type="number" step="5" id="f_be_act" value="${c.exits.breakEven.activationPct}"/></div>
      <div class="field"><label>Floor above entry (%)</label><input type="number" step="1" id="f_be_off" value="${c.exits.breakEven.offsetPct}"/></div>
    </div>

    <div class="section-label">Liquidity exit</div>
    <div class="field"><label>Exit if curve liquidity drops (%)</label><input type="number" step="5" id="f_liqdrop" value="${c.exits.liquidityDropExitPct}"/>
      <div class="hint">Bails when the bonding curve loses this share of its peak real-SOL reserves — a common precursor to a rug.</div></div>`;

  renderTiers(root);

  /* ------------------------------ LIMITS ------------------------------ */
  root.querySelector('#paneLimits').innerHTML = `
    <div class="notice info"><span class="ico">ℹ</span><div>These are <b>wallet-level circuit breakers</b>. When one trips, only this wallet pauses — your other wallets keep trading with their own limits.</div></div>
    <div class="grid2">
      <div class="field"><label>Daily loss limit (SOL)</label><input type="number" step="0.1" id="f_dloss" value="${c.limits.dailyLossLimitSol}"/>
        <div class="hint">Stop trading for the day at this realised loss.</div></div>
      <div class="field"><label>Daily profit target (SOL)</label><input type="number" step="0.1" id="f_dprofit" value="${c.limits.dailyProfitTargetSol}"/>
        <div class="hint">0 = disabled. Stop trading once this is banked.</div></div>
    </div>
    <div class="grid3">
      <div class="field"><label>Max trades per day</label><input type="number" id="f_dtrades" value="${c.limits.maxTradesPerDay}"/></div>
      <div class="field"><label>Max exposure (SOL)</label><input type="number" step="0.1" id="f_exposure" value="${c.limits.maxExposureSol}"/>
        <div class="hint">Cap on SOL tied up in open positions.</div></div>
      <div class="field"><label>Stop after N consecutive losses</label><input type="number" id="f_consec" value="${c.limits.stopAfterConsecutiveLosses}"/></div>
    </div>`;

  /* ----------------------------- FILTERS ----------------------------- */
  root.querySelector('#paneFilters').innerHTML = `
    <div class="section-label">Contract safety (hard gates)</div>
    <div class="grid3">
      <div class="field"><label>Mint authority revoked</label>
        <label class="switch"><input type="checkbox" id="f_mintrev" ${c.filters.requireMintAuthorityRevoked ? 'checked' : ''}/><span>Required</span></label></div>
      <div class="field"><label>Freeze authority revoked</label>
        <label class="switch"><input type="checkbox" id="f_freezerev" ${c.filters.requireFreezeAuthorityRevoked ? 'checked' : ''}/><span>Required</span></label></div>
      <div class="field"><label>Max buy tax (%)</label><input type="number" id="f_buytax" value="${c.filters.maxBuyTaxPct}"/></div>
    </div>
    <div class="section-label">Distribution</div>
    <div class="grid3">
      <div class="field"><label>Max dev hold (%)</label><input type="number" id="f_devhold" value="${c.filters.maxDevHoldPct}"/></div>
      <div class="field"><label>Max top-10 holders (%)</label><input type="number" id="f_top10" value="${c.filters.maxTop10HoldersPct}"/>
        <div class="hint">Measured excluding the bonding curve itself.</div></div>
      <div class="field"><label>Liquidity range (SOL in curve)</label>
        <div class="range-row">
          <input type="number" step="0.1" min="0" id="f_minliq" value="${c.filters.minLiquiditySol}" placeholder="min" aria-label="Minimum liquidity"/>
          <span class="range-sep">to</span>
          <input type="number" step="0.1" min="0" id="f_maxliq" value="${(c.filters.maxLiquiditySol ?? 0) || ''}" placeholder="no max" aria-label="Maximum liquidity"/>
        </div>
        <div class="hint">
          Only snipe tokens whose curve holds between these amounts of <strong>real SOL</strong>.
          Leave the max empty for no ceiling.
          <br/><br/>
          Real SOL is <strong>~0 at launch</strong> and grows as other people buy — so this range is
          also a <em>timing</em> control. A low max keeps you to genuinely fresh launches; a high min
          means you are waiting for proven demand.
        </div>
      </div>
    </div>
    <div class="section-label">Metadata</div>
    <div class="grid3">
      <div class="field"><label>Require socials</label>
        <label class="switch"><input type="checkbox" id="f_social" ${c.filters.requireSocial ? 'checked' : ''}/><span>Twitter/TG/site</span></label></div>
      <div class="field"><label>Block copycat tickers</label>
        <label class="switch"><input type="checkbox" id="f_copycat" ${c.filters.blockCopycatNames ? 'checked' : ''}/><span>Known-name collisions</span></label></div>
      <div class="field"><label>Max token age (s)</label><input type="number" step="10" id="f_age" value="${Math.round(c.filters.maxAgeMs / 1000)}"/></div>
    </div>
    <div class="section-label">Timing</div>
    <div class="field"><label>Max bonding-curve progress (%)</label><input type="number" id="f_curve" value="${c.filters.maxBondingCurvePct}"/>
      <div class="hint">Skip launches whose curve has already run past this — you'd be buying late.</div></div>
    <div class="field"><label>Dev wallet blacklist (one per line)</label>
      <textarea id="f_devbl" rows="2">${esc((c.filters.devBlacklist || []).join('\n'))}</textarea></div>`;

  /* -------------------------------- AI -------------------------------- */
  root.querySelector('#paneAi').innerHTML = `
    <div class="notice info"><span class="ico">✦</span><div>
      The agent reviews the structured on-chain facts for every candidate and can only <b>veto</b> — it can never
      increase position size or trigger a buy on its own. If it times out, the configured on-failure policy applies.
    </div></div>
    <div class="field"><label>Enabled for this wallet</label>
      <label class="switch"><input type="checkbox" id="f_ai_on" ${c.ai.enabled ? 'checked' : ''}/><span>Run AI review before buying</span></label></div>
    <div class="grid2">
      <div class="field"><label>Override provider (blank = global)</label>
        <select id="f_ai_prov">
          <option value="">Inherit global</option>
          ${['openai', 'anthropic', 'gemini', 'xai'].map((p) => `<option value="${p}" ${c.ai.overrideProvider === p ? 'selected' : ''}>${p}</option>`).join('')}
        </select></div>
      <div class="field"><label>Min confidence override (0 = global)</label><input type="number" step="0.05" id="f_ai_conf" value="${c.ai.minConfidence}"/></div>
    </div>
    <div class="hint" style="margin-top:8px">Provider API keys are configured globally in Settings. The engine's AI layer is disabled until a key is present.</div>`;
}

function renderTiers(root) {
  const list = root.querySelector('#tierList');
  const tiers = S.editing.cfg.exits.takeProfitTiers;
  list.innerHTML = tiers.map((t, i) => `
    <div class="tier-row">
      <div><label class="hint" style="display:block;margin-bottom:4px">Gain %</label>
        <input type="number" step="5" data-tier-gain="${i}" value="${t.gainPct}"/></div>
      <div><label class="hint" style="display:block;margin-bottom:4px">Sell % of original</label>
        <input type="number" step="5" data-tier-sell="${i}" value="${t.sellPct}"/></div>
      <button class="btn btn-sm btn-danger rm" data-tier-rm="${i}">✕</button>
    </div>`).join('');

  const total = tiers.reduce((a, t) => a + Number(t.sellPct || 0), 0);
  list.insertAdjacentHTML('beforeend',
    `<div class="hint" style="margin-bottom:12px">Total sold across tiers: <b class="${total >= 100 ? 'pos' : 'dim'}">${total}%</b>${total < 100 ? ` — the remaining <b>${100 - total}%</b> rides on the trailing stop / time stop.` : ''}</div>`);

  list.querySelectorAll('[data-tier-rm]').forEach((b) => b.onclick = () => {
    S.editing.cfg.exits.takeProfitTiers.splice(Number(b.dataset.tierRm), 1);
    renderTiers(root);
  });
  list.querySelectorAll('[data-tier-gain]').forEach((inp) => inp.onchange = () => {
    S.editing.cfg.exits.takeProfitTiers[Number(inp.dataset.tierGain)].gainPct = Number(inp.value);
    renderTiers(root);
  });
  list.querySelectorAll('[data-tier-sell]').forEach((inp) => inp.onchange = () => {
    S.editing.cfg.exits.takeProfitTiers[Number(inp.dataset.tierSell)].sellPct = Number(inp.value);
    renderTiers(root);
  });
}

function wireEditor(root) {
  const q = (id) => root.querySelector(id);
  const num = (id, fn) => { const el = q(id); if (el) el.onchange = () => fn(Number(el.value)); };
  const chk = (id, fn) => { const el = q(id); if (el) el.onchange = () => fn(el.checked); };
  const txt = (id, fn) => { const el = q(id); if (el) el.onchange = () => fn(el.value); };
  const c = () => S.editing.cfg;

  q('#addTier')?.addEventListener('click', () => {
    const t = c().exits.takeProfitTiers;
    const last = t[t.length - 1];
    t.push({ gainPct: last ? Math.round(last.gainPct * 2) : 50, sellPct: 25 });
    renderTiers(root);
  });

  // strategy
  txt('#f_preset', (v) => { c().preset = v; toast(`Preset "${v}" applied on save — reload the editor to see every field`, ''); });
  num('#f_min', (v) => { c().buy.minAmountSol = v; });
  num('#f_max', (v) => { c().buy.maxAmountSol = v; });
  num('#f_slip', (v) => { c().buy.slippageBps = v; });
  txt('#f_sizemode', (v) => { c().buy.positionSizeMode = v; });
  num('#f_sizepct', (v) => { c().buy.positionSizePercent = v; });
  num('#f_kelly', (v) => { c().buy.kellyFraction = v; });
  num('#f_concurrent', (v) => { c().buy.maxConcurrentPositions = v; });
  num('#f_cooldown', (v) => { c().buy.cooldownMs = v; });
  chk('#f_compound', (v) => { c().buy.autoCompound = v; });

  // exits
  num('#f_sl', (v) => { c().exits.stopLossPct = v; });
  num('#f_maxhold', (v) => { c().exits.maxHoldMs = v; });
  chk('#f_trail_on', (v) => { c().exits.trailing.enabled = v; });
  num('#f_trail_act', (v) => { c().exits.trailing.activationPct = v; });
  num('#f_trail_dist', (v) => { c().exits.trailing.trailPct = v; });
  num('#f_trail_step', (v) => { c().exits.trailing.stepPct = v; });
  chk('#f_be_on', (v) => { c().exits.breakEven.enabled = v; });
  num('#f_be_act', (v) => { c().exits.breakEven.activationPct = v; });
  num('#f_be_off', (v) => { c().exits.breakEven.offsetPct = v; });
  num('#f_liqdrop', (v) => { c().exits.liquidityDropExitPct = v; });

  // limits
  num('#f_dloss', (v) => { c().limits.dailyLossLimitSol = v; });
  num('#f_dprofit', (v) => { c().limits.dailyProfitTargetSol = v; });
  num('#f_dtrades', (v) => { c().limits.maxTradesPerDay = v; });
  num('#f_exposure', (v) => { c().limits.maxExposureSol = v; });
  num('#f_consec', (v) => { c().limits.stopAfterConsecutiveLosses = v; });

  // filters
  chk('#f_mintrev', (v) => { c().filters.requireMintAuthorityRevoked = v; });
  chk('#f_freezerev', (v) => { c().filters.requireFreezeAuthorityRevoked = v; });
  num('#f_buytax', (v) => { c().filters.maxBuyTaxPct = v; });
  num('#f_devhold', (v) => { c().filters.maxDevHoldPct = v; });
  num('#f_top10', (v) => { c().filters.maxTop10HoldersPct = v; });
  num('#f_minliq', (v) => { c().filters.minLiquiditySol = v; });
  // An empty max means "no ceiling", stored as 0 so the engine has one
  // unambiguous representation rather than null-vs-0 ambiguity.
  num('#f_maxliq', (v) => { c().filters.maxLiquiditySol = v || 0; });
  chk('#f_resume', (v) => { c().resumeAfterRestart = v; });
  chk('#f_social', (v) => { c().filters.requireSocial = v; });
  chk('#f_copycat', (v) => { c().filters.blockCopycatNames = v; });
  num('#f_age', (v) => { c().filters.maxAgeMs = v * 1000; });
  num('#f_curve', (v) => { c().filters.maxBondingCurvePct = v; });
  txt('#f_devbl', (v) => { c().filters.devBlacklist = v.split('\n').map((s) => s.trim()).filter(Boolean); });

  // ai
  chk('#f_ai_on', (v) => { c().ai.enabled = v; });
  txt('#f_ai_prov', (v) => { c().ai.overrideProvider = v; });
  num('#f_ai_conf', (v) => { c().ai.minConfidence = v; });

  // save
  q('#edSave').onclick = async () => {
    try {
      if (S.editing.isNew) {
        const name = q('#edName').value.trim();
        if (!name) { toast('Give this wallet a name so you can tell them apart', 'warn'); q('#edName').focus(); return; }

        const store = walletStore();
        if (!store) { toast('The wallet store did not load — reload the page', 'err'); return; }
        if (!store.supported()) {
          toast('This browser cannot create wallet keys (it needs WebCrypto). Use a current Chrome, Safari or Firefox.', 'err');
          return;
        }

        /* THIS wallet's passphrase. It seals the key in this browser — there is no
         * shared file to open, and no server passphrase any more, because the
         * server never holds the key except while the wallet is unlocked. */
        const passEl = q('#edPass');
        const pass = passEl ? passEl.value : '';
        if (pass.length < store.PASS_MIN) {
          const pe = q('#edPassErr');
          if (pe) pe.innerHTML = `<b>At least ${store.PASS_MIN} characters.</b><br/>This passphrase is the only way back into this wallet.`;
          toast(`Choose a passphrase of at least ${store.PASS_MIN} characters`, 'warn');
          if (passEl) passEl.focus();
          return;
        }

        const keyEl = q('#edKey');
        const pasted = keyEl ? keyEl.value.trim() : '';
        const btn = q('#edSave');
        const label2 = btn.textContent;
        btn.disabled = true;
        btn.textContent = pasted ? 'Sealing your key…' : 'Creating this wallet…';

        let address = null;
        let secretB58 = null;
        try {
          if (pasted) {
            // Import: prove the key really owns the address it claims, seal it
            // here, and never let a wrong key become a wallet you fund.
            const parsed = await store.parseSecret(pasted);
            await store.seal({ secretKey: parsed.secretKey, address: parsed.address, passphrase: pass, label: name });
            address = parsed.address;
            secretB58 = store.secretToBase58(parsed.secretKey);
          } else {
            const made = await store.create({ passphrase: pass, label: name });
            address = made.address;
            secretB58 = store.secretToBase58(await store.unlock(address, pass));
          }
        } catch (err) {
          btn.disabled = false;
          btn.textContent = label2;
          const pe = q('#edPassErr');
          if (pe) pe.innerHTML = `<b>${esc(err.message)}</b>`;
          toast(err.message, 'err');
          return;
        }

        if (!confirm(`${pasted ? 'Import this key as' : 'Create a fresh burner wallet named'} "${name}"?\n\nThe key is sealed in this browser under the passphrase you just chose.`)) {
          btn.disabled = false; btn.textContent = label2; return;
        }

        // Register the name and the ADDRESS with the server (it never sees the
        // key), then hand it the key for this session so it can trade.
        const created = await api('/api/wallets', {
          method: 'POST',
          body: JSON.stringify({ name, preset: q('#edPresetSel').value, address, imported: Boolean(pasted) }),
        });
        try {
          await api(`/api/wallets/${created.wallet}/arm`, {
            method: 'POST', body: JSON.stringify({ secretKey: secretB58 }),
          });
        } catch (err) {
          // The wallet exists and its key is sealed here; it just is not armed
          // yet. Say so plainly instead of pretending the creation failed.
          toast(`Wallet saved, but the bot could not arm it: ${err.message}`, 'warn');
        }
        btn.disabled = false;
        btn.textContent = label2;
        toast(`Burner "${name}" created — unlocked for this session`, '');
        closeModal();
        await refreshAll(); renderAll();
        // Land in the wallet's own config, NOT straight in the funding modal.
        // Jumping to funding hid the strategy/limits/exits/filters tabs behind a
        // payment step, which made it look like per-wallet config did not exist.
        if (created && created.wallet) openWallet(created.wallet, { justCreated: true });
        return;
      } else {
        const body = { ...S.editing.cfg, buy: S.editing.cfg.buy, exits: S.editing.cfg.exits, limits: S.editing.cfg.limits, filters: S.editing.cfg.filters, ai: S.editing.cfg.ai, preset: S.editing.cfg.preset };
        await api(`/api/wallets/${S.editing.id}`, { method: 'PUT', body: JSON.stringify(body) });
        toast('Wallet updated', '');
      }
      await refreshAll(); renderAll(); closeModal();
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ---------------------------- settings ---------------------------- */
function openSettings() {
  const g = S.config || {};
  openModal(`
    <div class="modal" style="max-width:700px">
      <div class="modal-head"><span class="modal-title">⚙ Global settings</span></div>
      <div class="modal-body">
        <div class="section-label">Execution</div>
        <div class="field"><label>Mode</label>
          <div class="notice ${g.dryRun ? 'warn' : 'danger'}" style="margin:0">
            <span class="ico">${g.dryRun ? '🧪' : '🔴'}</span>
            <div><b>${g.dryRun ? 'Dry run — trades are simulated' : 'LIVE — real funds'}</b>. The switch is under the header.</div>
          </div>
          <button class="btn ${g.dryRun ? 'btn-danger' : 'btn-primary'}" id="g_toggle" style="margin-top:10px">
            ${g.dryRun ? '⚠ Arm live trading' : '← Return to dry run'}
          </button>
        </div>

        <div class="section-label">RPC</div>
        <div class="field"><label>Endpoint(s), one per line</label>
          <textarea id="g_rpc" rows="3">${esc((g.rpc?.endpoints || []).join('\n'))}</textarea>
          <div class="hint">The public endpoint is heavily rate-limited. A paid endpoint (Helius / Triton / QuickNode) is effectively required for real sniping.</div></div>
        <div class="field"><label>WebSocket endpoint (for log-based scanning)</label>
          <input type="text" id="g_rpcws" value="${esc(g.rpc?.wsEndpoint || '')}"/></div>

        <div class="section-label">Jito</div>
        <div class="field"><label>Use Jito bundles</label>
          <label class="switch"><input type="checkbox" id="g_jito" ${g.jito?.enabled ? 'checked' : ''}/><span>Private, ordered, MEV-protected submission</span></label></div>
        <div class="grid2">
          <div class="field"><label>Tip (lamports)</label><input type="number" id="g_tip" value="${g.jito?.tipLamports ?? 1000000}"/></div>
          <div class="field"><label>Compute unit price (µlamports)</label><input type="number" id="g_cu" value="${g.execution?.priorityFeeMicroLamports ?? 200000}"/></div>
        </div>

        <div class="section-label">AI agent</div>
        <div class="grid2">
          <div class="field"><label>Provider</label>
            <select id="g_aiprov">${['openai', 'anthropic', 'gemini', 'xai', 'none'].map((p) => `<option value="${p}" ${g.ai?.provider === p ? 'selected' : ''}>${p}</option>`).join('')}</select></div>
          <div class="field"><label>Model</label><input type="text" id="g_aimodel" value="${esc(g.ai?.model || '')}"/></div>
        </div>
        <div class="field"><label>API key</label><input type="password" id="g_aikey" placeholder="${g.ai?.apiKey ? esc(g.ai.apiKey) : 'sk-…'}"/>
          <div class="hint">Stored in <code class="mono">data/config.json</code> on this machine only. Masked in every API response.</div></div>
        <div class="grid2">
          <div class="field"><label>Min confidence</label><input type="number" step="0.05" id="g_aiconf" value="${g.ai?.minConfidence ?? 0.6}"/></div>
          <div class="field"><label>On failure</label>
            <select id="g_aifail"><option value="skip" ${g.ai?.onFailure === 'skip' ? 'selected' : ''}>skip (fail closed)</option><option value="allow" ${g.ai?.onFailure === 'allow' ? 'selected' : ''}>allow</option></select></div>
        </div>
        <button class="btn btn-sm" id="g_probe">Test AI connection</button>

        <div class="section-label">Global risk ceiling</div>
        <div class="grid2">
          <div class="field"><label>Max total exposure (SOL)</label><input type="number" id="g_gexp" value="${g.riskGlobal?.maxTotalExposureSol ?? 20}"/></div>
          <div class="field"><label>Global daily loss limit (SOL)</label><input type="number" id="g_gloss" value="${g.riskGlobal?.dailyLossLimitSol ?? 10}"/></div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-modal="1">Cancel</button>
        <button class="btn btn-primary" id="g_save">Save settings</button>
      </div>
    </div>`, (root) => {
    const q = (s) => root.querySelector(s);

    // One code path for the mode change: this button, the header switch and the
    // dry-run banner all call setTradingMode(), so they cannot drift apart.
    q('#g_toggle').onclick = async () => {
      const goingLive = (S.config?.dryRun !== false);
      await setTradingMode(goingLive);
      closeModal();
    };

    q('#g_probe').onclick = async () => {
      toast('Probing AI provider…', '');
      try {
        const r = await api('/api/ai/probe', { method: 'POST' });
        toast(r.ok ? `AI reachable — ${String(r.sample || '').slice(0, 60)}` : `AI unreachable: ${r.error}`, r.ok ? '' : 'err');
      } catch (err) { toast(err.message, 'err'); }
    };

    q('#g_save').onclick = async () => {
      const key = q('#g_aikey').value.trim();
      const body = {
        dryRun: S.config?.dryRun,
        rpc: { endpoints: q('#g_rpc').value.split('\n').map((s) => s.trim()).filter(Boolean), wsEndpoint: q('#g_rpcws').value.trim() },
        jito: { enabled: q('#g_jito').checked, tipLamports: Number(q('#g_tip').value) },
        execution: { priorityFeeMicroLamports: Number(q('#g_cu').value) },
        ai: { provider: q('#g_aiprov').value, model: q('#g_aimodel').value.trim(), minConfidence: Number(q('#g_aiconf').value), onFailure: q('#g_aifail').value, ...(key ? { apiKey: key } : {}) },
        riskGlobal: { maxTotalExposureSol: Number(q('#g_gexp').value), dailyLossLimitSol: Number(q('#g_gloss').value) },
      };
      try {
        S.config = await api('/api/config', { method: 'PUT', body: JSON.stringify(body) });
        toast('Settings saved', ''); closeModal();
      } catch (err) { toast(err.message, 'err'); }
    };
  });
}

/* ============================================================
   CONNECTED WALLET (header)
   ============================================================ */

/**
 * The header used to offer no way to connect a wallet at all — the only entry
 * point was buried inside the Fund modal, so "connect" looked missing. This is
 * the same Standard-Wallet connect, promoted to a first-class control.
 */
function renderConnect() {
  const btn = $('btnConnect');
  if (!btn) return;
  const c = WSOL.connected;
  if (c && c.account) {
    btn.textContent = `🔗 ${short(c.account.address, 4)}`;
    btn.title = `${c.wallet.name} · ${c.account.address}\nClick to disconnect. This wallet is only ever asked to sign a transfer you approved, and the app remembers it across reloads.`;
    btn.classList.add('connected');
  } else {
    btn.textContent = '🔗 Connect wallet';
    btn.title = 'Connect the wallet you fund from. It is only ever asked to sign a transfer you approved.';
    btn.classList.remove('connected');
  }
}

function openConnectModal() {
  if (WSOL.connected && WSOL.connected.account) {
    const { wallet, account } = WSOL.connected;
    if (confirm(`Disconnect ${wallet.name}\n${account.address}`)) {
      disconnectWallet();
      toast('Wallet disconnected', '');
    }
    return;
  }

  const ws = WSOL.wallets || [];
  openModal(`
    <div class="modal">
      <div class="modal-head">
        <div class="modal-title">Connect a wallet</div>
        <button class="btn btn-sm" onclick="closeModal()">✕</button>
      </div>
      <div class="modal-body">
        <div class="hint" style="margin-bottom:14px">
          This is the wallet you <b>fund from</b> — your own, not a bot wallet.
          The bot never receives your keys, and the only thing it will ever ask this
          wallet to sign is a transfer <b>you</b> approved.
        </div>
        ${ws.length ? ws.map((w, i) => `
          <button class="btn btn-block" data-wi="${i}" style="justify-content:flex-start;margin-bottom:8px">
            ${w.icon ? `<img src="${esc(w.icon)}" width="18" height="18" style="border-radius:4px" alt=""/>` : '👛'}&nbsp; ${esc(w.name)}
          </button>`).join('')
        : `<div class="empty">
             <div class="empty-icon">👛</div>
             <div class="empty-title">No Solana wallet detected</div>
             <div class="empty-sub">
               Install one of these browser extensions, then reload this page:<br/><br/>
               <b>Phantom · Solflare · Backpack · Magic Eden</b>
             </div>
           </div>`}
      </div>
      <div class="modal-foot"><button class="btn btn-block" data-close-modal="1">Close</button></div>
    </div>`);

  document.querySelectorAll('[data-wi]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        const account = await connectWallet(ws[Number(b.dataset.wi)]);
        renderConnect();
        toast(`Connected ${short(account.address, 4)}`, '');
        closeModal();
      } catch (err) { toast(err.message, 'err'); }
    });
  });
}

/* ============================================================
   DEMO / OFFLINE SIMULATOR
   ------------------------------------------------------------
   Every button in this file talks to the API through api(). When the dashboard
   is opened as a plain file there is no API, so api() routes here instead.

   This exists so the preview is USABLE: each control performs a real state
   change you can see, on sample wallets. That is the only way to check that a
   button does what its label says. Nothing here touches a chain, and every
   wallet it creates is an obvious placeholder — never a spendable address.
   ============================================================ */

const DEMO_MS = 110; // a little latency, so disabled/spinner states behave
const demoWait = () => new Promise((r) => setTimeout(r, DEMO_MS));

function demoWallet(id) { return (S.wallets || []).find((w) => w.id === id); }
function demoWalletOfPosition(posId) {
  return (S.wallets || []).find((w) => (w.openPositions || []).some((p) => p.id === posId));
}
function demoPushLog(message, level = 'info', wallet = null) {
  S.logs.unshift({ ts: Date.now(), level, message: `${message} [SIM]`, wallet });
  S.logs = S.logs.slice(0, 300);
}

/**
 * One heartbeat of the preview: drift the marks, run the exits, and let new
 * launches arrive.
 *
 * Split out of the interval so a test can call it directly. Behaviour under test
 * that only exists inside a setInterval is behaviour nobody can assert on.
 */
function demoTickAll() {
  if (!S.demo) return;
  // Gently drift prices so the UI visibly lives.
  for (const p of S.positions) {
    const drift = (Math.random() - 0.48) * 3.2;
    p.pnlPct = Math.max(-70, p.pnlPct + drift);
    p.priceGainPct = p.pnlPct;
    p.peakGainPct = Math.max(p.peakGainPct, p.pnlPct);
    p.pnlSol = (p.pnlPct / 100) * (Number(p.solSpent) / 1e9);
    p.ageMs += 1200;
    const stop = p.stopLevelPct ?? 0;
    const w = S.wallets.find((x) => x.id === p.walletId);
    if (p.pnlPct <= stop) {
      // Book it like a real exit: history, realised P&L, win/loss counters.
      if (w) demoSellPosition(w, p, 'stop_loss');
    } else if (p.demoTargetPct && p.pnlPct >= p.demoTargetPct) {
      // Take profit, booked the same way — a paper trade that only ever lost
      // would teach the wrong thing about what dry run is for.
      if (w) demoSellPosition(w, p, `tp_${Math.round(p.demoTargetPct)}pct`);
    }
  }
  S.status.stats.detected += Math.floor(Math.random() * 3);
  if (S.status.running) demoTickLaunches();
  $('scanner') && renderScanner();
  renderStats(); renderWallets(); renderPositions(); renderScanFeed();
}
/** Book a simulated full exit: move the position into that wallet's history. */
function demoSellPosition(w, p, reason) {
  const spent = Number(p.solSpent) / 1e9;
  const pnl = Number(p.pnlSol || 0);
  const returned = spent + pnl;

  p.status = 'CLOSED';
  p.closedAt = Date.now();
  p.exitReason = reason;
  p.realisedSol = String(Math.round(returned * 1e9));
  p.pnlPct = spent ? (pnl / spent) * 100 : 0;

  w.openPositions = (w.openPositions || []).filter((x) => x.id !== p.id);
  w.recentPositions = [p, ...(w.recentPositions || [])].slice(0, 50);
  S.positions = (S.positions || []).filter((x) => x.id !== p.id);

  const st = w.stats || (w.stats = {});
  st.realisedPnlSol = Number(((st.realisedPnlSol || 0) + pnl).toFixed(6));
  st.tradesToday = (st.tradesToday || 0) + 1;
  if (pnl >= 0) { st.wins = (st.wins || 0) + 1; st.consecutiveLosses = 0; } else {
    st.losses = (st.losses || 0) + 1;
    st.consecutiveLosses = (st.consecutiveLosses || 0) + 1;
  }
  w.exposureSol = Math.max(0, (w.exposureSol || 0) - (Number(p.solSpent) / 1e9));
  w.balanceSol = Number((w.balanceSol + returned).toFixed(6));

  demoPushLog(`🔴 SOLD 100% ${p.symbol} @ ${pnl >= 0 ? '+' : ''}${p.pnlPct.toFixed(1)}% · ${returned.toFixed(4)} SOL · ${reason}`, 'trade', w.name);
  return { ok: true, signature: `SIM${Date.now().toString(36).toUpperCase()}` };
}

/* ══════════════ dry-run paper trading, in the offline preview ══════════════ */

/* The preview cannot fetch a SOL price (no network in the sandboxed frame), so it
 * converts at a fixed, clearly-labelled rate instead of pretending to quote one. */
const DEMO_SOL_USD = 200;

const DEMO_TICKER = ['WOJAK2', 'MOONCAT', 'BANANA', 'TURBO', 'CHAD', 'PONZI', 'DOGWIF', 'SNIPE', 'GIGA', 'PEPE3'];
const DEMO_SKIP_REASONS = [
  'dev_hold_high(34.0%>20%)', 'liquidity_below_min(0.42)', 'freeze_authority_live',
  'mint_authority_live', 'top10_concentrated(52%)', 'name_copycat(WOJAK)', 'bonding_curve_too_far(71%)',
];
let demoLaunchSeq = 0;

/**
 * One launch arrives, and the armed wallets do what they do in dry run: paper
 * trades that open, get managed and close into history.
 *
 * This is the preview's answer to "in the dry run am not seeing any dry run
 * trade happening". The real engine does this against the real pump.fun feed;
 * this does it against a ticker, with the same shape of data, so the preview
 * shows the lifecycle rather than describing it.
 */
function demoTickLaunches() {
  demoLaunchSeq += 1;
  if (demoLaunchSeq % 3 !== 0) return; // roughly one launch every 4 seconds

  const now = Date.now();
  const symbol = DEMO_TICKER[demoLaunchSeq % DEMO_TICKER.length] + (demoLaunchSeq % 7);
  const mint = `DEMO${demoLaunchSeq}notarealmint${'a'.repeat(20)}`;
  const armedWallets = (S.wallets || []).filter((w) => w.enabled && !w.stats?.paused);

  const skipped = Math.random() < 0.45 || !armedWallets.length;
  const reason = DEMO_SKIP_REASONS[demoLaunchSeq % DEMO_SKIP_REASONS.length];
  const verdicts = [];

  if (skipped) {
    for (const w of armedWallets) verdicts.push({ name: w.name, action: 'skipped', reason });
    upsertScanRow({
      mint, symbol, name: symbol.toLowerCase(), devWallet: `DEMO-dev-${demoLaunchSeq}-not-real`,
      devHoldPct: skipped ? 34.0 : 3.4,
      liquiditySol: skipped ? 0.42 : 12.5,
      // Priced in dollars, like the real table. The preview uses a fixed rate and
      // says so, rather than implying a live quote it cannot fetch offline.
      liquidityUsd: Math.round((skipped ? 0.42 : 12.5) * DEMO_SOL_USD),
      solUsd: DEMO_SOL_USD, solUsdSource: 'demo',
      riskScore: skipped ? 61 : 12,
      riskNotes: skipped ? ['dev holds 34.0% (limit 15%)', 'liquidity $68 below floor $2,000'] : ['dev holds 3.4%'],
      facts: { devHold: 'event', liquidity: 'event', risk: 'derived' },
      decision: skipped ? 'skipped' : 'checking', skipReason: skipped ? reason : null,
      detectedAt: now, decidedAt: skipped ? now : null, wallets: verdicts,
    });
    return;
  }

  // Buy: each armed wallet with room opens a paper position at its own size.
  let opened = 0;
  for (const w of armedWallets) {
    const maxOpen = w.config?.buy?.maxConcurrentPositions ?? 4;
    if ((w.openPositions || []).length >= maxOpen) {
      verdicts.push({ name: w.name, action: 'skipped', reason: 'max_concurrent_positions' });
      continue;
    }
    const min = w.config?.buy?.minAmountSol ?? 0.1;
    const max = w.config?.buy?.maxAmountSol ?? 1;
    const spend = Number((min + Math.random() * Math.max(0, max - min)).toFixed(3));
    const stop = -Math.abs(w.config?.exits?.stopLossPct ?? 25);
    const p = {
      id: `p_demo_${demoLaunchSeq}_${w.id}`,
      walletId: w.id, wallet: w.name, mint, symbol, name: symbol,
      status: 'OPEN', openedAt: now, closedAt: null,
      entryPrice: '0', lastPrice: '0', highWaterPrice: '0',
      originalTokens: '0', tokensHeld: '0',
      solSpent: String(Math.round(spend * 1e9)), realisedSol: '0', pnlLamports: '0',
      pnlSol: 0, pnlPct: 0, priceGainPct: 0, peakGainPct: 0,
      remainingFraction: 1, stopLevelPct: stop,
      // The first take-profit tier is what a paper trade is booked against, so a
      // preview run shows both outcomes — winners and stop-outs — within a
      // minute, instead of only ever grinding down to the stop.
      demoTargetPct: Math.min(Number(w.config?.exits?.takeProfitTiers?.[0]?.gainPct ?? 50) || 50, 60),
      tiers: (w.config?.exits?.takeProfitTiers || [{ gainPct: 50, sellPct: 100 }]).map((t) => ({ ...t, filled: false })),
      exits: [], ageMs: 0, entryTxSignature: `SIM${now.toString(36)}`, closeTxSignature: null,
      exitReason: null, meta: { simulated: true, source: 'demo' }, simulated: true,
    };
    // A wallet row can arrive without the array — the demo list carries none, and
    // the preview's paper trades died on this line with a TypeError that reached the
    // console and nowhere else. Guarded rather than assumed.
    if (!Array.isArray(w.openPositions)) w.openPositions = [];
    w.openPositions.push(p);
    if (!Array.isArray(S.positions)) S.positions = [];
    S.positions.push(p);
    w.exposureSol = Number(((w.exposureSol || 0) + spend).toFixed(6));
    verdicts.push({ name: w.name, action: 'bought', reason: null });
    opened += 1;
    demoPushLog(`🟢 BOUGHT ${symbol} · ${spend.toFixed(3)} SOL · ${(Math.random() * 40 + 8).toFixed(1)}M tokens`, 'trade', w.name);
  }

  upsertScanRow({
    mint, symbol, name: symbol.toLowerCase(), devWallet: `DEMO-dev-${demoLaunchSeq}-not-real`,
    devHoldPct: 3.4, liquiditySol: 12.5,
    liquidityUsd: Math.round(12.5 * DEMO_SOL_USD),
    solUsd: DEMO_SOL_USD, solUsdSource: 'demo',
    riskScore: 12, riskNotes: ['dev holds 3.4%'],
    facts: { devHold: 'event', liquidity: 'event', risk: 'derived' },
    decision: opened ? 'bought' : 'skipped',
    skipReason: opened ? null : 'no wallet had room for another position',
    // Which wallet took it — the question the per-wallet view is built around.
    boughtBy: opened ? (verdicts.find((v) => v.action === 'bought') || {}).name || null : null,
    detectedAt: now, decidedAt: now, wallets: verdicts,
  });
  void opened;
}

/** A fresh demo wallet. The address is deliberately not valid base58. */
function demoNewWallet(name, preset) {
  const slug = name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12) || 'Wallet';
  const base = DEMO_PRESETS[preset] ? preset : 'balanced';
  const tmpl = (S.wallets.find((w) => w.config && w.config.preset === base) || S.wallets[0] || {}).config || {};
  const id = `w_demo_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name,
    publicKey: `DEMO-${slug}-not-a-real-address`, // never base58: cannot be funded by accident
    // Creating a wallet is not a decision to trade. Mirrors the server, where a
    // fresh wallet is created stopped and shows ▶ Start, not ⏸ Stop.
    enabled: false,
    armed: false,
    imported: false,
    balanceSol: 0,
    paperBalanceSol: 10,
    paperTrading: true,
    exposureSol: 0,
    lastEntryAt: 0,
    stats: { day: new Date().toISOString().slice(0, 10), tradesToday: 0, realisedPnlSol: 0, consecutiveLosses: 0, wins: 0, losses: 0, paused: false, pauseReason: null },
    openPositions: [],
    recentPositions: [],
    config: JSON.parse(JSON.stringify(Object.assign({}, tmpl, { preset: base }))),
  };
}

/**
 * Resolve a path the way the server would, including its errors.
 *
 * Errors are THROWN, not returned, because api() throws on a failing response —
 * so each caller's catch block and every toast is exercised exactly as it would
 * be against the real bot.
 */
async function demoApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? JSON.parse(opts.body) : {};
  await demoWait();

  const parts = String(path).split('?');
  const q = new URLSearchParams(parts[1] || '');
  const seg = parts[0].replace(/^\/api\/?/, '').replace(/\/$/, '').split('/').filter(Boolean);

  /* ------------------------------- reads ------------------------------- */
  if (seg[0] === 'status' && method === 'GET') {
    // `overall` mirrors src/engine/engine.js's overallStats(): the same totals,
    // computed the same way, so the card in the preview is the card in production.
    const overall = (S.wallets || []).reduce((a, w) => {
      const st = w.stats || {};
      a.bought += st.bought || 0;
      a.wins += st.wins || 0;
      a.losses += st.losses || 0;
      a.realisedPnlSol += st.realisedPnlSol || 0;
      a.open += (w.openPositions || []).length;
      return a;
    }, { bought: 0, wins: 0, losses: 0, realisedPnlSol: 0, open: 0 });
    const closed = overall.wins + overall.losses;
    return {
      engine: {
        ...S.status,
        // The preview's own rate and the wallets it is pricing — so the demo's
        // cards show dollars the same way the real ones do, with the source named.
        solUsd: DEMO_SOL_USD, solUsdSource: 'demo', solUsdStale: false,
        overall: {
          trades: closed, closed, bought: overall.bought, wins: overall.wins, losses: overall.losses,
          winRatePct: closed ? (overall.wins / closed) * 100 : null,
          open: overall.open,
          realisedPnlSol: overall.realisedPnlSol,
          wallets: (S.wallets || []).map((w) => {
            const st = w.stats || {};
            return {
              id: w.id, name: w.name, wins: st.wins || 0, losses: st.losses || 0,
              bought: st.bought || 0, persistent: Boolean(w.persistent),
              trades: (st.wins || 0) + (st.losses || 0), realisedPnlSol: st.realisedPnlSol || 0,
              open: (w.openPositions || []).length, keyArmed: w.keyArmed !== false,
            };
          }),
        },
      },
      keystore: S.keystore, global: S.config, presets: S.presets,
    };
  }
  if (seg[0] === 'wallets' && seg.length === 1 && method === 'GET') {
    // Mirror the server: a wallet whose key this session does not hold is still
    // reported, flagged, rather than vanishing from the list. `keyArmed` is the
    // browser-held equivalent of the old server keystore being open — a restart
    // clears it, and one passphrase on the card brings it back.
    return S.wallets.map((w) => (w.keyArmed === false
      ? { ...w, keyLocked: true, keyArmed: false, balanceSol: null, openPositions: [], recentPositions: [] }
      : w));
  }
  if (seg[0] === 'positions' && seg.length === 1 && method === 'GET') return S.positions;
  if (seg[0] === 'scan' && method === 'GET') {
    return { rows: S.scanFeed || [], stats: null, scanner: (S.status && S.status.scanner) || null };
  }
  if (seg[0] === 'logs' && method === 'GET') return S.logs.slice(0, Number(q.get('limit')) || 200);
  if (seg[0] === 'config' && method === 'GET') return S.config;
  if (seg[0] === 'presets' && method === 'GET') return S.presets;
  if (seg[0] === 'keystore' && seg[1] === 'status' && method === 'GET') return S.keystore;
  // Backup and restore, mirrored so the preview's buttons do something real rather
  // than hitting a network that is not there. There is no keystore in the preview —
  // the addresses are placeholders — so the backup carries the wallet list alone.
  if (seg[0] === 'backup' && method === 'GET') {
    return {
      kind: 'meme-sniper-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      keystore: null,
      demo: true,
      config: { global: S.config, wallets: JSON.parse(JSON.stringify(S.wallets)) },
      note: 'Preview backup: the wallet list only. A real backup also carries your encrypted keystore.',
    };
  }
  if (seg[0] === 'restore' && method === 'POST') {
    const b = body.backup;
    if (!b || b.kind !== 'meme-sniper-backup') throw new Error('not a backup file');
    const incoming = (b.config && b.config.wallets) || [];
    if (!incoming.length) throw new Error('the backup contains no wallets');
    S.wallets.length = 0;
    incoming.forEach((w) => S.wallets.push(w));
    S.positions = S.wallets.flatMap((w) => w.openPositions || []);
    renderAll();
    return { ok: true, wallets: incoming.length, walletsLoaded: incoming.length, hint: 'Preview restore — placeholder addresses only.' };
  }
  if (seg[0] === 'session-token') return { token: 'demo' };

  /* ------------------------------ keystore ------------------------------ */
  if (seg[0] === 'keystore' && method === 'POST') {
    const pass = String(body.passphrase || '');
    if (seg[1] === 'lock') {
      S.keystore = { initialised: true, unlocked: false };
      // A restart forgets every session key. The wallets themselves — and their
      // sealed keys in the browser — are untouched, which is the whole point.
      S.wallets.forEach((w) => { w.keyArmed = false; });
      return { ok: true };
    }
    if (seg[1] === 'reset') {
      if (body.confirm !== 'RESET') throw new Error('confirmation_required');
      if (pass.length < 8) throw new Error('Passphrase must be at least 8 characters.');
      S.keystore = { initialised: true, unlocked: true };
      demoPushLog('Started a fresh keystore (simulated) — the old file would be archived, not deleted', 'warn');
      return { ok: true, archived: 'data/keystore.enc.archived-demo', walletsLoaded: 0 };
    }
    if (pass.length < 8) throw new Error('Passphrase must be at least 8 characters.');
    S.keystore = { initialised: true, unlocked: true };
    return { ok: true, walletsLoaded: (S.wallets || []).length, recoveredPositions: 0 };
  }

  /* ------------------------------- engine ------------------------------- */
  if (seg[0] === 'engine' && method === 'POST') {
    if (seg[1] === 'start') { S.status.running = true; demoPushLog('Engine started — scanning for launches'); }
    if (seg[1] === 'stop') { S.status.running = false; demoPushLog('Engine stopped', 'warn'); }
    if (seg[1] === 'dry-run') {
      if (body.dryRun === false && body.confirm !== 'I_UNDERSTAND_THE_RISK') {
        throw new Error('arming live mode requires confirm: "I_UNDERSTAND_THE_RISK"');
      }
      S.status.dryRun = body.dryRun !== false;
      S.config.dryRun = S.status.dryRun;
      demoPushLog(S.status.dryRun ? 'Switched to dry run' : '🔴 LIVE mode armed', 'warn');
    }
    return S.status;
  }

  /* ------------------------------- wallets ------------------------------ */
  if (seg[0] === 'wallets' && seg.length === 1 && method === 'POST') {
    const name = String(body.name || '').trim();
    if (!name) throw new Error('name_required');

    /* The normal path now: the key was made in the browser and only the address
     * is registered here. Mirrors the real route, including being idempotent on
     * the address so a re-registered wallet comes back as itself. */
    if (body.address) {
      const existing = S.wallets.find((w) => w.publicKey === body.address);
      if (existing) return { ok: true, existing: true, wallet: existing.id, publicKey: body.address };
      const w = demoNewWallet(name, body.preset);
      w.publicKey = String(body.address);
      w.imported = Boolean(body.imported);
      w.keyArmed = false;
      S.wallets.push(w);
      demoPushLog(`Registered ${w.name} — its key stays sealed in this browser`);
      return { ok: true, wallet: w.id, publicKey: w.publicKey, keyHolder: 'browser' };
    }

    // The legacy path, kept for a key generated server-side.
    if (!S.keystore || !S.keystore.unlocked) {
      throw new Error('keystore_locked: open the keystore before adding wallets.');
    }
    const w = demoNewWallet(name, body.preset);
    S.wallets.push(w);
    demoPushLog(`Created ${w.name} — a fresh burner with its own strategy`);
    return { ok: true, wallet: w.id, publicKey: w.publicKey };
  }

  if (seg[0] === 'wallets' && seg[1] === 'refresh' && method === 'POST') return { ok: true, added: 0 };

  if (seg[0] === 'wallets' && seg.length >= 2) {
    const w = demoWallet(seg[1]);
    if (!w) throw new Error('wallet_not_found');
    const action = seg[2];

    if (method === 'DELETE') {
      S.wallets = S.wallets.filter((x) => x.id !== w.id);
      S.positions = S.positions.filter((x) => x.walletId !== w.id);
      demoPushLog(`Deleted ${w.name}`, 'warn');
      return { ok: true };
    }

    if (method === 'PUT') {
      if (body.resumeAfterRestart !== undefined) w.config.resumeAfterRestart = body.resumeAfterRestart !== false;
      if (body.buy) Object.assign(w.config.buy = w.config.buy || {}, body.buy);
      if (body.exits) Object.assign(w.config.exits = w.config.exits || {}, body.exits);
      if (body.limits) Object.assign(w.config.limits = w.config.limits || {}, body.limits);
      if (body.filters) Object.assign(w.config.filters = w.config.filters || {}, body.filters);
      if (body.ai) Object.assign(w.config.ai = w.config.ai || {}, body.ai);
      if (body.preset) w.config.preset = body.preset;
      if (body.name) w.name = body.name;
      if (body.enabled !== undefined) w.enabled = Boolean(body.enabled);
      demoPushLog(`Updated ${w.name}'s configuration`);
      return w;
    }

    if (action === 'arm' && method === 'POST') {
      if (!body.secretKey) throw new Error('secret_key_required');
      w.keyArmed = true;
      demoPushLog(`🔓 ${w.name} unlocked for this session — key in memory only`, 'info', w.name);
      return { ok: true, armed: true, walletId: w.id, publicKey: w.publicKey, wallet: w };
    }

    if (action === 'lock' && method === 'POST') {
      w.keyArmed = false;
      w.enabled = false; w.armed = false;
      demoPushLog(`🔒 ${w.name} locked — its key is out of the bot's memory`, 'warn', w.name);
      return { ok: true, armed: false, walletId: w.id };
    }

    /* The preview mirrors the repo's `persistent-bot/start`: the key goes to the
     * bot, encrypted there, so it can trade with the tab closed. Nothing leaves the
     * page here, and the wording says so — a preview must never imply that a real
     * key left the browser. */
    if (action === 'persist' && method === 'POST') {
      if (!body.secretKey) throw new Error('secret_key_required');
      const needsKeystore = !S.keystore || !S.keystore.unlocked;
      if (needsKeystore && String(body.keystorePassphrase || '').length < 8) {
        throw new Error('keystore_passphrase_required');
      }
      if (needsKeystore) S.keystore = { initialised: true, unlocked: true };
      w.persistent = true;
      w.keyHolder = 'server';
      w.keyArmed = true;
      demoPushLog(`🖥 ${w.name} sent to the bot — preview only, nothing left this page`, 'info', w.name);
      return { ok: true, persistent: true, keyHolder: 'server', walletId: w.id, publicKey: w.publicKey, wallet: w };
    }

    if (action === 'unpersist' && method === 'POST') {
      w.persistent = false;
      w.keyHolder = 'browser';
      w.keyArmed = false;
      w.enabled = false; w.armed = false;
      demoPushLog(`🖥 ${w.name} removed from the bot — key deleted from the (preview) server`, 'warn', w.name);
      return { ok: true, persistent: false, keyHolder: 'browser', walletId: w.id };
    }

    if (action === 'start' || action === 'resume') {
      w.enabled = true; w.armed = true;
      w.stats.paused = false; w.stats.pauseReason = null;
      S.status.running = true;
      const dry = S.status.dryRun !== false;
      demoPushLog(
        `▶ ${w.name} armed — ${dry ? 'DRY RUN: paper trades only, nothing is sent' : 'LIVE: real funds'}`,
        dry ? 'info' : 'warn', w.name,
      );
      return { ok: true, running: true, enabled: true, armed: true, paused: false, dryRun: dry, engineRunning: S.status.running, wallet: w };
    }
    if (action === 'stop' || action === 'pause') {
      w.enabled = false; w.armed = false;
      w.stats.paused = true; w.stats.pauseReason = 'stopped from the dashboard';
      demoPushLog(`⏸ ${w.name} stopped — no new entries; positions it holds are still managed`, 'warn', w.name);
      return { ok: true, running: false, enabled: false, armed: false, paused: true, wallet: w };
    }
    if (action === 'kill-all' || action === 'close-all') {
      const open = (w.openPositions || []).slice();
      open.forEach((pos) => demoSellPosition(w, pos, 'manual_kill_all'));
      w.stats.paused = true; w.stats.pauseReason = 'killed all trades from the dashboard';
      w.enabled = false; w.armed = false;
      demoPushLog(`⛔ ${w.name}: killed ${open.length} position(s) and stopped`, 'warn', w.name);
      return { ok: true, attempted: open.length, sold: open.length, failed: 0, stopped: true, wallet: w };
    }

    if (action === 'withdraw' && seg[3] === 'intent' && method === 'POST') {
      // Preview mirror of the two-step, browser-signed withdrawal. It cannot sign
      // anything offline, but the SHAPE must match the server's or the button would
      // behave differently in the preview than in the real app.
      return {
        ok: true,
        intentId: `demo_wi_${Date.now()}`,
        wallet: w.id,
        from: w.publicKey || 'DEMO',
        to: body.destination,
        amountSol: Number(body.amountSol || 0.5),
        txBase64: '',
        note: 'preview — nothing is signed or sent',
      };
    }
    if (action === 'withdraw' && seg[3] === 'submit' && method === 'POST') {
      const amount = Number(w.balanceSol || 0) > 0 ? Math.min(Number(w.balanceSol), 0.5) : 0;
      w.balanceSol = Math.max(0, Number(((w.balanceSol || 0) - amount).toFixed(6)));
      demoPushLog(`Withdrew ${amount} SOL from ${w.name} — signed in the browser (preview)`, 'warn', w.name);
      return { ok: true, signature: `DEMOS${Date.now().toString(36).toUpperCase()}`, amountSol: amount, destination: 'preview destination', signedBy: 'browser' };
    }
    if (action === 'withdraw' && seg[3] === 'quote') {
      const mode = q.get('mode') || 'all';
      const bal = Number(w.balanceSol || 0);
      const reserve = 0.00089088 + 0.000005;
      const max = Math.max(0, Number((bal - reserve).toFixed(6)));
      const amount = mode === 'all' ? max : Math.min(Number(q.get('amountSol')) || 0, max);
      return {
        ok: true, balanceSol: bal, maxWithdrawableSol: max, amountSol: amount, mode,
        rentReserveSol: 0.00089088, feeSol: 0.000005, canExecute: amount > 0,
        resultingBalanceSol: Number((bal - amount - 0.000005).toFixed(6)),
        warnings: mode === 'all' ? ['A little SOL is kept back so the account stays rent-exempt.'] : [],
      };
    }
    if (action === 'withdraw' && method === 'POST') {
      if (body.confirm !== 'WITHDRAW') throw new Error('confirm_required');
      const amount = Number(body.amountSol) || 0;
      if (!body.destination) throw new Error('destination_required');
      if (amount <= 0) throw new Error('nothing_to_withdraw');
      w.balanceSol = Math.max(0, Number((w.balanceSol - amount).toFixed(6)));
      demoPushLog(`Withdrew ${amount} SOL from ${w.name}`, 'warn', w.name);
      return { ok: true, signature: `SIMW${Date.now().toString(36).toUpperCase()}`, amountSol: amount };
    }

    if (action === 'balance') return { balanceSol: w.balanceSol };
  }

  /* ------------------------------- funding ------------------------------ */
  if (seg[0] === 'fund' && method === 'POST') {
    const w = demoWallet(body.walletId);
    if (!w) throw new Error('wallet_not_found');
    if (seg[1] === 'intent') {
      if (!(Number(body.amountSol) > 0)) throw new Error('amount_required');
      return { ok: true, intentId: `demo_${Date.now()}`, txBase64: '', from: body.from };
    }
    if (seg[1] === 'submit') {
      const amount = Number(body.amountSol) || 0;
      w.balanceSol = Number((w.balanceSol + amount).toFixed(6));
      w.paperTrading = false;
      demoPushLog(`💸 Funded ${w.name} with ${amount} SOL`, 'trade', w.name);
      return { ok: true, signature: `SIMF${Date.now().toString(36).toUpperCase()}` };
    }
  }

  /* ------------------------------ positions ----------------------------- */
  if (seg[0] === 'positions' && seg.length >= 2 && method === 'POST') {
    const w = demoWalletOfPosition(seg[1]);
    if (!w) throw new Error('position_not_found');
    const pos = w.openPositions.find((x) => x.id === seg[1]);
    if (seg[2] === 'kill') return demoSellPosition(w, pos, body.reason || 'ui_kill');
  }

  /* --------------------- global settings + AI probe --------------------- */
  if (seg[0] === 'config' && method === 'PUT') {
    Object.assign(S.config, body);
    if (body.dryRun !== undefined) S.status.dryRun = body.dryRun !== false;
    demoPushLog('Global settings saved');
    return S.config;
  }
  if (seg[0] === 'ai' && seg[1] === 'probe' && method === 'POST') {
    await new Promise((r) => setTimeout(r, 700));
    return { ok: true, verdict: 'allow', confidence: 0.82, source: 'simulated', ms: 700 };
  }

  throw new Error(`Unknown endpoint: ${method} ${parts[0]}`);
}

/**
 * Download the encrypted keystore and the wallet list as one file.
 *
 * The keystore is exported exactly as it sits on disk — still AES-256-GCM under the
 * user's passphrase — so this file cannot leak a key even if it is emailed around.
 * That is what makes it safe to keep, and it is the answer to a host that rebuilds
 * its disk every time it sleeps.
 */
async function downloadBackup() {
  try {
    let blob;
    if (S.demo) {
      // The preview has no server. Build the file locally so the button still does
      // what it says — a control that only works sometimes is a control that lies.
      const data = await demoApi('/api/backup');
      blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    } else {
      const token = S.token || (await refreshSessionToken());
      const r = await fetch('/api/backup', { headers: { 'x-session-token': token } });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || `HTTP ${r.status}`);
      }
      blob = await r.blob();
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `meme-sniper-backup-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    toast(
      S.demo
        ? 'Preview backup downloaded — the wallet list only. A real backup also carries your encrypted keystore.'
        : 'Backup downloaded. Keep it somewhere safe — and keep the passphrase somewhere else.',
      '',
    );
  } catch (err) {
    toast(`Could not build the backup: ${err.message}`, 'err');
  }
}

/** Put a backup back: the keystore, the wallet list, then open it. */
function openRestore() {
  openModal(`
    <div class="modal" style="max-width:620px">
      <div class="modal-head"><span class="modal-title">⬆ Restore from a backup</span>
        <button class="btn btn-ghost btn-sm" data-close-modal="1">Close</button></div>
      <div class="modal-body">
        <p style="margin-top:0">Replace this bot's keystore and wallet list with a backup file. This is
        the way back after a host wiped its disk — <b>Render's free plan does that every time the
        service sleeps</b> — and also how you move your wallets to another machine.</p>

        <div class="notice info"><span class="ico">i</span><div>
          Whatever is here now is <b>archived, not deleted</b>, so restoring by mistake is recoverable.
          The restored keystore arrives <b>locked</b>: your passphrase was never inside the backup, so
          you will type it afterwards.
        </div></div>

        <div class="field">
          <label>Backup file</label>
          <input type="file" id="rsFile" accept="application/json,.json"/>
        </div>
        <div id="rsErr" class="pass-err"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close-modal="1">Cancel</button>
        <button class="btn btn-primary" id="rsGo">Restore</button>
      </div>
    </div>`, (root) => {
    root.querySelector('#rsGo').onclick = async () => {
      const err = root.querySelector('#rsErr');
      const file = root.querySelector('#rsFile').files[0];
      if (!file) { err.textContent = 'Choose the backup file first.'; return; }
      try {
        const backup = JSON.parse(await file.text());
        const res = await api('/api/restore', { method: 'POST', body: JSON.stringify({ confirm: 'RESTORE', backup }) });
        closeModal();
        toast(`Restored ${res.wallets} wallet(s). Now open the keystore with your passphrase.`, 'warn');
        await syncKeystoreState();
        await refreshAll();
        renderAll();
        openKeystore();
      } catch (e) {
        err.textContent = e.message;
      }
    };
  });
}

/**
 * "I have forgotten the passphrase."
 *
 * This is the only way out of a forgotten passphrase, and it is worth being exact
 * about what it does, because it is the one action in this app that can make funds
 * unreachable by the bot:
 *
 *   · the current keystore file is ARCHIVED, never deleted — if the passphrase ever
 *     turns up, the keys are still there;
 *   · a NEW, empty keystore is created with the new passphrase;
 *   · wallets you created before keep their names and addresses, but their keys are
 *     no longer available to the bot: it cannot trade or withdraw them;
 *   · nothing on chain moves. Any SOL or tokens stay exactly where they are.
 */
function openKeystoreForgot() {
  openModal(`
    <div class="modal" style="max-width:620px">
      <div class="modal-head"><span class="modal-title">🔐 Forgotten passphrase</span></div>
      <div class="modal-body">
        <div class="notice warn" style="margin-top:0"><span class="ico">⚠</span><div>
          <b>Your passphrase cannot be recovered from the file.</b>
          That is the point of encrypting it: nobody, including this bot, can decrypt the keystore
          without it. There is no hint, no reset email, no backdoor.
        </div></div>

        <p class="muted" style="margin:12px 0 4px">What starting again does:</p>
        <ul class="muted" style="margin:0 0 12px 18px;line-height:1.7">
          <li>Your current keystore file is <b>archived, not deleted</b>, so the keys are still
              on this machine if the passphrase ever turns up.</li>
          <li>A new, empty keystore is created with the passphrase below.</li>
          <li>Wallets you already created <b>keep their names and addresses</b>, but the bot can no
              longer trade or withdraw them — their keys are in the archived file.</li>
          <li><b>Nothing on chain moves.</b> Any SOL or tokens stay exactly where they are.</li>
        </ul>

        <div class="notice danger"><span class="ico">⚠</span><div>
          <b>If any of those wallets hold real funds, stop here.</b>
          Their SOL and tokens would stay on chain but become unreachable through this bot, because
          the only copy of those keys is inside the file you cannot decrypt. Keep trying the
          passphrase, or check your password manager first.
        </div></div>

        <div class="field">
          <label>New passphrase for the new keystore</label>
          <input type="password" id="frPass" placeholder="At least 8 characters" autocomplete="new-password"/>
        </div>
        <div class="field">
          <label>Type RESET to confirm</label>
          <input type="text" id="frConfirm" placeholder="RESET" autocomplete="off"/>
        </div>
        <div id="frErr" class="pass-err"></div>
      </div>
      <div class="modal-foot">
        <button class="btn" id="frCancel">Cancel</button>
        <button class="btn btn-danger" id="frGo">Start a fresh keystore</button>
      </div>
    </div>`, (root) => {
    root.querySelector('#frCancel').onclick = closeModal;
    root.querySelector('#frGo').onclick = async () => {
      const pass = root.querySelector('#frPass').value;
      const confirmWord = root.querySelector('#frConfirm').value.trim();
      const err = root.querySelector('#frErr');
      if (confirmWord !== 'RESET') { err.textContent = 'Type RESET in the box to confirm.'; return; }
      try {
        const r = await api('/api/keystore/reset', {
          method: 'POST',
          body: JSON.stringify({ confirm: 'RESET', passphrase: pass }),
        });
        closeModal();
        toast(`Fresh keystore created${r.archived ? ' — your old file was archived, not deleted' : ''}`, 'warn');
        await syncKeystoreState();
        await refreshAll();
        renderAll();
      } catch (e) { err.textContent = e.message; }
    };
  });
}

/* ============================================================
   EVENTS
   ============================================================ */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;

  const { edit, toggle, close: closeId, exit, resume, start, stop, detail } = t.dataset;

  if (t.id === 'modeDry' || t.dataset.modeDry) await setTradingMode(false);
  if (t.id === 'modeLive' || t.dataset.modeLive) await setTradingMode(true);
  if (t.id === 'btnConnect' || t.id === 'btnConnect2') openConnectModal();
  if (t.id === 'connChip' && S.demo) openPreviewNotice();
  if (t.id === 'btnPanic') {
    if (!confirm('Liquidate every open position across every wallet and stop new entries?')) return;
    try { await api('/api/engine/panic', { method: 'POST', body: '{}' }); toast('🚨 Panic executed', 'err'); }
    catch (err) { toast(err.message, 'err'); }
  }
  if (t.id === 'btnAdd' || t.id === 'btnAdd2') {
    // Straight to the form. The form contains the keystore passphrase field and
    // unlocks in the same step, so there is never a separate "unlock" screen in
    // front of "create" — asking someone to open a keystore they have not made
    // yet, while they were trying to create a wallet, is nonsense.
    openWallet(null);
    return;
  }
  if (t.id === 'btnSettings') openSettings();
  if (t.id === 'btnKeystore') openKeystore();
  if (t.id === 'btnCloseAll') {
    if (!confirm('Flatten all positions in all wallets?')) return;
    for (const w of S.wallets) {
      try { await api(`/api/wallets/${w.id}/close-all`, { method: 'POST', body: '{}' }); } catch { /* continue */ }
    }
    toast('Flatten requested', 'warn');
  }
  if (t.id === 'btnClearLog') { S.logs = []; renderLog(); }

  // One close path for every dialog. Previously each modal carried its own
  // inline handler, and two of them carried none at all — the Close buttons in
  // the Fund and Withdraw dialogs did nothing when tapped.
  if (t.dataset.closeModal) { closeModal(); return; }
  if (t.dataset.keystore) openKeystore();
  // The wallet card renders these two, and for a long time nothing listened:
  // tapping Fund or Withdraw on a wallet did NOTHING, while the same features
  // reached from the Config or Trades modal worked. Reported from the live
  // deployment, twice, as "the buttons don't respond".
  if (t.dataset.arm) {
    const id = t.dataset.arm;
    const field = document.querySelector(`#armpass-${id}`);
    const pass = field ? field.value : '';
    if (!pass) { toast('Type that wallet’s passphrase', 'warn'); if (field) field.focus(); return; }
    const label = t.textContent;
    t.disabled = true; t.textContent = 'Unlocking…';
    try {
      await unlockWallet(id, pass);
    } catch {
      // unlockWallet already said what went wrong, next to nothing else.
    } finally {
      t.disabled = false; t.textContent = label;
    }
    return;
  }
  if (t.dataset.lock) { await lockWallet(t.dataset.lock); return; }
  if (t.dataset.importhere) {
    // The key is not on this device, so the only way back is to paste it. Seal it
    // here — after this, the wallet is this browser's, and the server never needs
    // to hold it again.
    const w = (S.wallets || []).find((x) => x.id === t.dataset.importhere);
    const s = walletStore();
    if (!s) { toast('The wallet store did not load — reload the page', 'err'); return; }
    const key = window.prompt(`Paste the private key for ${w ? w.name : 'this wallet'}\n\nIt is sealed in this browser under a passphrase you choose next.`);
    if (!key) return;
    try {
      const parsed = await s.parseSecret(key);
      if (w && w.publicKey && parsed.address !== w.publicKey) {
        toast(`That key belongs to ${parsed.address.slice(0, 6)}…, not to ${w.name}`, 'err');
        return;
      }
      const pass = window.prompt(`Choose a passphrase to seal ${w ? w.name : 'this wallet'} with (at least ${s.PASS_MIN} characters).\n\nThere is no recovery — keep it somewhere safe.`);
      if (!pass) return;
      await s.seal({ secretKey: parsed.secretKey, address: parsed.address, passphrase: pass, label: w ? w.name : 'Wallet' });
      await unlockWallet(w.id, pass);
      renderWallets();
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (t.dataset.fund) openFund(t.dataset.fund);
  if (t.dataset.withdraw) openWithdraw(t.dataset.withdraw);
  if (detail) openWalletDetail(detail);
  if (t.dataset.persist) persistWallet(t.dataset.persist);
  if (t.dataset.unpersist) unpersistWallet(t.dataset.unpersist);
  if (t.dataset.register) registerBrowserWallet(t.dataset.register);
  if (t.dataset.forget) forgetBrowserWallet(t.dataset.forget);
  if (t.dataset.feed) openWalletFeed(t.dataset.feed);
  if (edit) openWallet(edit);

  if (t.dataset.delrecord) {
    const w = (S.wallets || []).find((x) => x.id === t.dataset.delrecord);
    const addr = (w?.publicKey || '').trim();
    if (!confirm(
      `Delete the wallet record "${w ? w.name : ''}"?\n\n` +
      (addr ? `The record is only the name and the address ${addr}. Any SOL or tokens\n` +
              'still at that address STAY ON CHAIN — this does not move them, and the bot\n' +
              'cannot reach them because their key is not in your keystore.\n\n'
            : '') +
      'This cannot be undone.'
    )) return;
    try {
      await api(`/api/wallets/${t.dataset.delrecord}`, { method: 'DELETE' });
      const store = walletStore();
      if (store && addr) store.remove(addr);
      await refreshAll(); renderAll();
      toast('Wallet deleted', 'warn');
    } catch (err) { toast(err.message, 'err'); }
  }

  if (toggle) {
    const w = S.wallets.find((x) => x.id === toggle);
    try {
      await api(`/api/wallets/${toggle}`, { method: 'PUT', body: JSON.stringify({ ...w.config, enabled: !w.enabled }) });
      await refreshAll(); renderAll();
      toast(`${w.name} ${w.enabled ? 'disabled' : 'enabled'}`, '');
    } catch (err) { toast(err.message, 'err'); }
  }

  if (start) {
    try {
      const r = await api(`/api/wallets/${start}/start`, { method: 'POST', body: '{}' });
      await refreshAll(); renderAll();
      const nm = (S.wallets || []).find((x) => x.id === start);
      const label = nm ? nm.name : 'Wallet';
      toast(
        r.dryRun === false
          ? `▶ ${label} armed — LIVE: real funds`
          : `▶ ${label} armed — DRY RUN: it will take paper trades (no real funds). Watch them on its card.`,
        r.dryRun === false ? 'err' : '',
      );
    } catch (err) { toast(err.message, 'err'); }
  }

  if (stop) {
    try {
      await api(`/api/wallets/${stop}/stop`, { method: 'POST', body: '{}' });
      await refreshAll(); renderAll();
      toast('⏸ Stopped. No new entries for this wallet; positions it still holds are sold by its own exits.', 'warn');
    } catch (err) { toast(err.message, 'err'); }
  }

  if (closeId) {
    const w = (S.wallets || []).find((x) => x.id === closeId);
    const open = (w?.openPositions || []).length;
    if (!confirm(
      `KILL ALL — ${w ? w.name : 'this wallet'}?\n\n` +
      (open
        ? `Sell all ${open} open position(s) at whatever price is available right now.\n` +
          'This is a kill, not a target — you will not get the best price.\n\n'
        : 'Nothing is open right now.\n\n') +
      'This wallet is then STOPPED — it will not open anything new until you press Start.'
    )) return;
    try {
      const r = await api(`/api/wallets/${closeId}/kill-all`, { method: 'POST', body: '{}' });
      await refreshAll(); renderAll();
      if (r.failed) toast(`Killed ${r.sold} of ${r.attempted} — ${r.failed} failed, see the log. Wallet stopped.`, 'err');
      else toast(`⛔ ${r.attempted ? `Killed ${r.sold} position(s). ` : ''}Wallet stopped.`, 'warn');
    } catch (err) { toast(err.message, 'err'); }
  }

  if (exit) {
    // This button used to say "Exit requested" and do nothing at all — there
    // was no route behind it. It now really sells.
    const p = S.positions.find((x) => x.id === exit);
    if (!p) return;
    if (!confirm(
      `KILL ${p.symbol}?\n\n` +
      'The whole position is market-sold right now at whatever price is available.\n' +
      'You will not get the best price — that is the point of a kill.'
    )) return;
    try {
      await api(`/api/positions/${exit}/kill`, { method: 'POST', body: JSON.stringify({ reason: 'ui_kill' }) });
      toast(`⛔ Killed ${p.symbol}`, 'warn');
      await refreshAll();
      renderAll();
      // Killing from the per-wallet view should leave it showing the result,
      // not a row for a position that no longer exists.
      if (S.detailWallet) openWalletDetail(S.detailWallet);
    } catch (err) {
      toast(`Could not sell ${p.symbol}: ${err.message}`, 'err');
    }
    return;
  }

  if (resume) {
    try {
      await api(`/api/wallets/${resume}/resume`, { method: 'POST', body: '{}' });
      await refreshAll(); renderAll();
      toast('Wallet resumed — new entries allowed again', '');
    } catch (err) { toast(err.message, 'err'); }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if (e.key === 'p' && e.metaKey) { e.preventDefault(); $('btnPanic').click(); }
});

window.closeModal = closeModal;
boot();
renderConnect();
