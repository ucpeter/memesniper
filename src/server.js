'use strict';
/**
 * API + UI server.
 *
 * Security posture:
 *   • Binds to 0.0.0.0 so the sandbox preview works, but every mutating route
 *     requires the local session token printed at startup.
 *   • Private keys are NEVER returned by any endpoint. Key material only ever
 *     moves IN (import) — never out.
 *   • API keys are masked in all read responses.
 */
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const bus = require('./util/events');
const log = require('./util/logger');
const cfg = require('./config');
const keystore = require('./wallets/keystore');
const ai = require('./engine/ai');
const { PRESETS, defaultWalletConfig, normaliseWallet, applyPreset } = cfg;

/** Per-boot session token. Printed to the console; required for writes. */
const SESSION_TOKEN = process.env.SESSION_TOKEN || crypto.randomBytes(16).toString('hex');

function maskSecret(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 8) return '••••';
  return `${str.slice(0, 4)}••••${str.slice(-4)}`;
}

/**
 * @param engine     the Engine instance
 * @param ctx.getGlobal  () => the GLOBAL config block (rpc, jito, ai, …)
 * @param ctx.getFull    () => the FULL config ({ global, wallets })
 * @param ctx.save       () => persist to disk
 */
function createServer(engine, { getGlobal, getFull, save: saveConfig }) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  const PUBLIC_DIR = path.join(__dirname, '..', 'public');
  // Registered BEFORE the static mount so the landing page owns "/" and the
  // trading terminal lives at /terminal, rather than the dashboard being the
  // first thing a visitor sees.
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'landing.html')));
  app.get(['/terminal', '/terminal/'], (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
  app.use(express.static(PUBLIC_DIR, { index: false }));

  /* --------------------------- auth middleware --------------------------- */
  const requireToken = (req, res, next) => {
    const provided = req.get('x-session-token') || req.query.token;
    if (provided !== SESSION_TOKEN) {
      return res.status(401).json({ error: 'unauthorised', hint: 'Set x-session-token header. Token is printed at startup.' });
    }
    return next();
  };

  /** Strip secrets from anything leaving the process. */
  function sanitiseGlobal(g) {
    return { ...g, ai: { ...g.ai, apiKey: g.ai.apiKey ? maskSecret(g.ai.apiKey) : '' }, _token: undefined };
  }

  /* ------------------------------- status -------------------------------- */
  app.get('/api/status', (req, res) => {
    const g = getGlobal();
    res.json({
      engine: engine.status(),
      keystore: { initialised: keystore.isInitialised(), unlocked: keystore.isUnlocked() },
      global: sanitiseGlobal(g),
      presets: PRESETS,
    });
  });

  app.get('/api/session-token', (req, res) => {
    // Local-only convenience for the bundled UI. The token is already visible
    // in the server console; this just avoids copy-pasting it into the page.
    res.json({ token: SESSION_TOKEN });
  });

  /* ------------------------------ keystore ------------------------------- */
  app.get('/api/keystore/status', (req, res) => {
    res.json({ initialised: keystore.isInitialised(), unlocked: keystore.isUnlocked() });
  });

  app.post('/api/keystore/init', requireToken, (req, res) => {
    try {
      keystore.init(req.body.passphrase);
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/keystore/unlock', requireToken, async (req, res) => {
    try {
      keystore.unlock(req.body.passphrase);
      // Populate the wallet list now. Without this the dashboard shows an empty
      // wallets panel until Start is pressed, so there is no way to read a
      // wallet's address in order to fund it.
      const hydrated = engine.hydrate ? engine.hydrate() : 0;
      // Keys exist now, so this is the first moment positions left open by a
      // previous run can be verified on chain and taken back over. Awaited so
      // the dashboard's very first wallet payload already includes them.
      let recovered = 0;
      if (engine.resume) { try { recovered = await engine.resume(); } catch (e) { log.warn(`Resume failed: ${e.message}`); } }
      res.json({ ok: true, walletsLoaded: hydrated, recoveredPositions: recovered });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/keystore/lock', requireToken, (req, res) => {
    keystore.lock();
    res.json({ ok: true });
  });

  /**
   * Start over with a fresh keystore, archiving the old one.
   *
   * The only reason to do this is a forgotten passphrase, which is otherwise an
   * unrecoverable dead end. It is not a one-tap action: it needs an explicit
   * confirm word, because wallets created before it can no longer be traded by
   * the bot (their keys are in the archived file, and anything on chain stays
   * exactly where it is).
   */
  app.post('/api/keystore/reset', requireToken, (req, res) => {
    if (req.body.confirm !== 'RESET') {
      return res.status(400).json({
        error: 'confirmation_required',
        hint: "Send confirm: 'RESET' to start a fresh keystore.",
      });
    }
    try {
      const r = keystore.reset(req.body.passphrase);
      const walletsLoaded = engine.hydrate ? engine.hydrate() : 0;
      res.json({ ok: true, archived: r.archived, walletsLoaded });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  /* ------------------------------- config -------------------------------- */
  app.get('/api/config', (req, res) => res.json(sanitiseGlobal(getGlobal())));

  app.put('/api/config', requireToken, (req, res) => {
    const g = getGlobal();
    const patch = { ...req.body };
    // Never let a masked placeholder overwrite a real key.
    if (patch.ai && typeof patch.ai.apiKey === 'string' && patch.ai.apiKey.includes('••••')) {
      patch.ai.apiKey = g.ai.apiKey;
    }
    Object.assign(g, cfg.deepMerge(g, patch));
    saveConfig();
    bus.safeEmit('config:updated', sanitiseGlobal(g));
    res.json(sanitiseGlobal(g));
  });

  /* ------------------------------- wallets ------------------------------- */
  /* ------------------------------------------------------------------ *
   * Withdrawals — getting your money back OUT
   * ------------------------------------------------------------------ *
   * A quote endpoint so the user sees exact numbers before committing, then an
   * execute endpoint that requires an explicit confirmation string.
   */
  app.get('/api/wallets/:id/withdraw/quote', async (req, res) => {
    const g = getFull();
    const w = g.wallets.find((x) => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: 'wallet_not_found' });
    if (!keystore.isUnlocked()) return res.status(400).json({ error: 'keystore_locked' });

    const trader = engine.traders.get(w.id);
    const mode = req.query.mode === 'all' ? 'all' : 'custom';
    const requested = mode === 'all' ? null : Number(req.query.amountSol);

    let balanceSol = 0;
    const executor = engine.executor;
    try {
      balanceSol = await executor.getBalanceSol(w.publicKey);
    } catch (err) {
      // Do not fall back to 0: that reads as "nothing to withdraw" and hides
      // the fact that the RPC is simply unreachable.
      return res.status(503).json({ error: 'balance_unavailable', detail: err.message });
    }

    const FEE_LAMPORTS = 5000n;
    const RENT = require('./engine/executor').RENT_EXEMPT_MIN_LAMPORTS;
    const balance = BigInt(Math.round(balanceSol * 1e9));

    let lamports;
    if (mode === 'all') {
      // Keep the account alive: a system account below the rent-exempt minimum
      // is purged, which would strand any SPL token accounts it still holds.
      lamports = balance - FEE_LAMPORTS - RENT;
    } else {
      lamports = BigInt(Math.round((requested || 0) * 1e9));
    }
    // An empty wallet makes the arithmetic go negative. Clamp it, or the
    // "balance after" line silently reports a phantom positive remainder.
    if (lamports < 0n) lamports = 0n;

    const open = trader ? trader.openPositions().length : 0;
    const warnings = [];
    if (lamports > 0n && lamports > balance - FEE_LAMPORTS) {
      warnings.push('Requested amount exceeds the spendable balance once the network fee is deducted.');
    }
    if (open > 0) {
      warnings.push(`This wallet has ${open} open position(s). Withdrawing the trading float may leave them unmanaged and unable to exit.`);
    }
    if (mode === 'all' && lamports > 0n) {
      warnings.push(`Keeping ${(Number(RENT) / 1e9).toFixed(6)} SOL behind; the account is purged below the rent-exempt minimum.`);
    }

    res.json({
      wallet: { id: w.id, name: w.name, publicKey: w.publicKey },
      mode,
      balanceSol,
      amountSol: lamports > 0n ? Number(lamports) / 1e9 : 0,
      feeSol: Number(FEE_LAMPORTS) / 1e9,
      rentReserveSol: mode === 'all' ? Number(RENT) / 1e9 : 0,
      maxWithdrawableSol: balance > FEE_LAMPORTS + RENT ? Number(balance - FEE_LAMPORTS - RENT) / 1e9 : 0,
      resultingBalanceSol: Math.max(0, balanceSol - (Number(lamports) / 1e9) - Number(FEE_LAMPORTS) / 1e9),
      openPositions: open,
      warnings,
      // Withdrawals ignore dryRun on purpose: a mode flag must never trap funds.
      dryRun: Boolean(executor.dryRun),
      canExecute: lamports > 0n && lamports <= balance - FEE_LAMPORTS,
    });
  });

  app.post('/api/wallets/:id/withdraw', requireToken, async (req, res) => {
    const g = getFull();
    const w = g.wallets.find((x) => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: 'wallet_not_found' });
    if (!keystore.isUnlocked()) return res.status(400).json({ error: 'keystore_locked' });
    if (req.body.confirm !== 'WITHDRAW') {
      return res.status(400).json({ error: 'confirmation_required', hint: "Send { confirm: 'WITHDRAW' } to proceed." });
    }

    const destination = String(req.body.destination || '').trim();
    if (!destination) return res.status(400).json({ error: 'destination_required' });

    const executor = engine.executor;
    const mode = req.body.mode === 'all' ? 'all' : 'custom';
    let lamports;
    try {
      const balanceSol = await executor.getBalanceSol(w.publicKey);
      const balance = BigInt(Math.round(balanceSol * 1e9));
      const RENT = require('./engine/executor').RENT_EXEMPT_MIN_LAMPORTS;
      lamports = mode === 'all'
        ? balance - 5000n - RENT
        : BigInt(Math.round(Number(req.body.amountSol || 0) * 1e9));
    } catch (err) {
      return res.status(400).json({ error: `balance_read_failed: ${err.message}` });
    }

    if (lamports <= 0n) return res.status(400).json({ error: 'nothing_to_withdraw' });

    const out = await executor.sendSol({ walletId: w.id, destination, lamports, label: 'withdraw' });
    if (!out.ok) return res.status(400).json(out);

    const trader = engine.traders.get(w.id);
    if (trader) trader.refreshBalance().catch(() => {});

    bus.safeEmit('wallet:updated', w.id);
    res.json({ ok: true, signature: out.signature, amountSol: Number(lamports) / 1e9, destination });
  });

  /* ------------------------------------------------------------------ *
   * Funding from the user's OWN connected wallet
   * ------------------------------------------------------------------ *
   * The server builds an UNSIGNED transfer; the browser hands the raw bytes to
   * the user's wallet extension; the user approves it; the signed bytes come
   * back here to be broadcast.
   *
   * We never see the user's key, and we support exactly ONE feature —
   * solana:signTransaction — for ONE instruction we authored. There is
   * deliberately no signAllTransactions and no signMessage anywhere in this
   * codebase: those are the two calls a drainer needs, and this project exists
   * because of a site that used them.
   */
  const fundIntents = new Map(); // id -> intent (short-lived, single use)

  app.post('/api/fund/intent', requireToken, async (req, res) => {
    const g = getFull();
    const w = g.wallets.find((x) => x.id === req.body.walletId);
    if (!w) return res.status(404).json({ error: 'wallet_not_found' });

    const amountSol = Number(req.body.amountSol);
    if (!(amountSol > 0)) return res.status(400).json({ error: 'amount_must_be_positive' });
    if (amountSol > 100000) return res.status(400).json({ error: 'amount_unreasonably_large' });

    const from = String(req.body.from || '').trim();
    let fromPk;
    try {
      fromPk = new (require('@solana/web3.js').PublicKey)(from);
    } catch {
      return res.status(400).json({ error: 'invalid_source_address' });
    }

    const lamports = BigInt(Math.round(amountSol * 1e9));
    let built;
    try {
      built = await engine.executor.buildTransfer({ from: fromPk, to: w.publicKey, lamports });
    } catch (err) {
      return res.status(400).json({ error: `build_failed: ${err.message}` });
    }

    const id = `fi_${crypto.randomBytes(8).toString('hex')}`;
    fundIntents.set(id, { id, walletId: w.id, from, to: w.publicKey, lamports, ts: Date.now() });

    // Opportunistic cleanup of expired intents.
    for (const [k, v] of fundIntents) if (Date.now() - v.ts > 180_000) fundIntents.delete(k);

    res.json({
      intentId: id,
      // Raw bytes for the wallet to sign. Base64 in JSON.
      txBase64: Buffer.from(built.tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
      from,
      to: w.publicKey,
      amountSol,
      lamports: lamports.toString(),
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
    });
  });

  app.post('/api/fund/submit', requireToken, async (req, res) => {
    const intent = fundIntents.get(req.body.intentId);
    if (!intent) return res.status(400).json({ error: 'unknown_or_expired_intent' });
    if (Date.now() - intent.ts > 180_000) {
      fundIntents.delete(intent.id);
      return res.status(400).json({ error: 'intent_expired' });
    }

    // Verify the signed bytes are the transfer we asked for, so a compromised
    // client cannot smuggle a different instruction through our RPC.
    try {
      engine.executor.assertTransferMatches(req.body.txBase64, intent);
    } catch (err) {
      return res.status(400).json({ error: `integrity_check_failed: ${err.message}` });
    }

    fundIntents.delete(intent.id); // single use

    try {
      const out = await engine.executor.broadcastSigned(req.body.txBase64);
      if (!out.confirmed) {
        return res.status(400).json({ error: out.error || 'not_confirmed', signature: out.signature });
      }
      const trader = engine.traders.get(intent.walletId);
      if (trader) trader.refreshBalance().catch(() => {});
      bus.safeEmit('wallet:updated', intent.walletId);
      res.json({ ok: true, signature: out.signature, amountSol: Number(intent.lamports) / 1e9, from: intent.from, to: intent.to });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/wallets/refresh', requireToken, async (req, res) => {
    const added = engine.hydrate ? engine.hydrate() : 0;
    if (engine.resume) { try { await engine.resume(); } catch { /* non-fatal */ } }
    res.json({ ok: true, added, total: engine.traders.size });
  });

  app.get('/api/wallets', (req, res) => {
    const live = [...engine.traders.values()].map((t) => t.toJSON());
    // A wallet whose key is not loaded is still a wallet the user created. Show
    // it, flagged, instead of an empty list — the name and the on-chain address
    // are in config.json and were never secret.
    const locked = engine.lockedWallets ? engine.lockedWallets() : [];
    res.json([...live, ...locked]);
  });

  app.post('/api/wallets', requireToken, (req, res) => {
    const g = getFull();
    const id = `w_${crypto.randomBytes(6).toString('hex')}`;
    const base = defaultWalletConfig(req.body.name || `Wallet ${g.wallets.length + 1}`);
    base.id = id;
    const wallet = req.body.preset ? applyPreset(base, req.body.preset) : normaliseWallet(base);
    wallet.id = id;

    if (!keystore.isUnlocked()) return res.status(400).json({ error: 'keystore_locked', hint: 'Unlock the keystore before adding wallets.' });

    try {
      if (req.body.secretKey) {
        wallet.publicKey = keystore.importKey(id, req.body.secretKey);
        // Provenance matters: an imported key may be the user's MAIN wallet,
        // whereas a generated one is a true burner. The UI flags the difference.
        wallet.imported = true;
      } else {
        wallet.publicKey = keystore.generateKey(id);
        wallet.imported = false;
      }
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    g.wallets.push(wallet);
    saveConfig();
    engine.addWallet(wallet);
    res.status(201).json({ ok: true, wallet: wallet.id, publicKey: wallet.publicKey });
  });

  app.put('/api/wallets/:id', requireToken, (req, res) => {
    const g = getFull();
    const idx = g.wallets.findIndex((w) => w.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'wallet_not_found' });

    const incoming = { ...req.body, id: g.wallets[idx].id, publicKey: g.wallets[idx].publicKey };

    // Applying a preset replaces strategy blocks but keeps identity + stats.
    let next = req.body.preset && req.body.preset !== g.wallets[idx].preset
      ? { ...applyPreset(g.wallets[idx], req.body.preset), ...incoming }
      : cfg.deepMerge(g.wallets[idx], incoming);

    next = normaliseWallet(next);
    next.id = g.wallets[idx].id;
    next.publicKey = g.wallets[idx].publicKey;
    next.stats = g.wallets[idx].stats;

    g.wallets[idx] = next;
    saveConfig();

    const trader = engine.traders.get(next.id);
    if (trader) trader.cfg = next;

    bus.safeEmit('wallet:updated', next.id);
    res.json(next);
  });

  app.delete('/api/wallets/:id', requireToken, (req, res) => {
    const g = getFull();
    g.wallets = g.wallets.filter((w) => w.id !== req.params.id);
    saveConfig();
    engine.removeWallet(req.params.id);
    try { keystore.remove(req.params.id); } catch { /* locked; config already dropped */ }
    res.json({ ok: true });
  });

  app.post('/api/wallets/:id/pause', requireToken, (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });
    t.pause(req.body.reason || 'manual');
    res.json({ ok: true, stats: t.stats });
  });

  app.post('/api/wallets/:id/resume', requireToken, (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });
    t.resume();
    res.json({ ok: true, stats: t.stats });
  });

  app.post('/api/wallets/:id/close-all', requireToken, async (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });
    const results = await t.closeAll(req.body.reason || 'manual_close_all');
    const sold = results.filter((r) => r.ok).length;
    // Report what actually happened. "ok: true" regardless of outcome is how a
    // failed liquidation looks identical to a successful one.
    res.json({ ok: sold === results.length, attempted: results.length, sold, results });
  });

  /**
   * ⛔ Kill all for ONE wallet: sell everything it holds, then stop it trading.
   *
   * Scoped to a wallet on purpose. Getting flat and then immediately re-buying
   * the next launch is rarely what "kill" means, so this also stops the wallet
   * (paused = no new entries) while leaving exit management live, so a position
   * that failed to sell is still retried rather than abandoned.
   */
  app.post('/api/wallets/:id/kill-all', requireToken, async (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });

    const results = await t.closeAll(req.body.reason || 'manual_kill_all');
    t.pause('killed all trades from the dashboard');

    const sold = results.filter((r) => r.ok).length;
    const failed = results.length - sold;
    // Persist the pause so a restart does not quietly re-arm a wallet you stopped.
    const full = getFull();
    const w = full.wallets.find((x) => x.id === req.params.id);
    if (w) { w.stats = t.stats; saveConfig(); }

    bus.safeEmit('wallet:stats', t.toJSON());
    res.json({
      ok: failed === 0, attempted: results.length, sold, failed, stopped: true,
      wallet: t.toJSON(),
      note: results.length === 0 ? 'Nothing was open — the wallet is now stopped.' : undefined,
    });
  });

  /**
   * ▶ Start / ⏸ Stop for ONE wallet.
   *
   * Stop pauses the wallet, which blocks NEW entries while exit management
   * keeps running — stopping must never strand a position without its stop
   * loss. It also starts the shared engine if it is not running, because
   * "start this wallet" is the only thing the user asked for.
   */
  app.post('/api/wallets/:id/start', requireToken, async (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });
    if (!engine.running) engine.start();
    t.resume();
    bus.safeEmit('wallet:stats', t.toJSON());
    res.json({ ok: true, running: true, paused: false, engineRunning: engine.running, wallet: t.toJSON() });
  });

  app.post('/api/wallets/:id/stop', requireToken, async (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });
    t.pause('stopped from the dashboard');
    bus.safeEmit('wallet:stats', t.toJSON());
    res.json({
      ok: true, running: false, paused: true, wallet: t.toJSON(),
      note: 'Stopped. No new entries; open positions are still managed so your stops keep working.',
    });
  });

  /**
   * Kill one position: market-sell everything now, at any price.
   *
   * The position id is only unique within a wallet, and the dashboard does not
   * know which wallet owns a row, so the owner is resolved here rather than
   * making the client pass one.
   */
  app.post('/api/positions/:id/kill', requireToken, async (req, res) => {
    for (const t of engine.traders.values()) {
      if (!t.positions.has(req.params.id)) continue;
      const result = await t.killPosition(req.params.id, req.body.reason || 'manual_kill');
      return res.status(result.ok ? 200 : 409).json(result);
    }
    res.status(404).json({ error: 'position_not_found' });
  });

  app.get('/api/wallets/:id/balance', async (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });
    const bal = await t.refreshBalance();
    res.json({ balanceSol: bal });
  });

  /* ------------------------------ positions ------------------------------ */
  app.get('/api/positions', (req, res) => {
    const all = [];
    for (const t of engine.traders.values()) {
      for (const p of t.positions.values()) {
        // The dashboard shows a friendly wallet name; the Position only knows
        // its id, so decorate at the edge rather than teaching Position about
        // wallet identity.
        all.push({ ...p.toJSON(), wallet: t.cfg.name });
      }
    }
    res.json(all.sort((a, b) => b.openedAt - a.openedAt));
  });

  /* -------------------------------- logs --------------------------------- */
  app.get('/api/logs', (req, res) => {
    res.json(log.history(Number(req.query.limit) || 200));
  });

  /* ------------------------------- engine -------------------------------- */
  const runGuard = (req, res, next) => {
    if (req.body && req.body.live === true && getGlobal().dryRun === false) {
      // Going live is a deliberate, explicit action.
      if (req.body.confirm !== 'I_UNDERSTAND_THE_RISK') {
        return res.status(400).json({ error: 'live_confirmation_required', hint: 'Send confirm:"I_UNDERSTAND_THE_RISK" to arm live trading.' });
      }
    }
    return next();
  };

  app.post('/api/engine/start', requireToken, runGuard, async (req, res) => {
    engine.start();
    // start() -> hydrate() only builds Trader objects; recovery needs a round
    // trip to the chain to confirm what is still held.
    if (engine.resume) { try { await engine.resume(); } catch (e) { log.warn(`Resume failed: ${e.message}`); } }
    res.json(engine.status());
  });

  app.post('/api/engine/stop', requireToken, (req, res) => {
    engine.stop();
    res.json(engine.status());
  });

  app.post('/api/engine/panic', requireToken, async (req, res) => {
    await engine.panic(req.body.reason || 'ui_panic');
    res.json({ ok: true, status: engine.status() });
  });

  app.post('/api/engine/dry-run', requireToken, (req, res) => {
    const g = getGlobal();
    const want = req.body.dryRun === true;
    if (!want && req.body.confirm !== 'I_UNDERSTAND_THE_RISK') {
      return res.status(400).json({ error: 'live_confirmation_required', hint: 'Disabling dry-run means real funds. Send confirm:"I_UNDERSTAND_THE_RISK".' });
    }
    g.dryRun = want;
    saveConfig();
    log.warn(want ? '🧪 Dry-run ENABLED — no real transactions will be sent' : '🔴 LIVE TRADING ENABLED — real funds at risk');
    bus.safeEmit('engine:status', engine.status());
    res.json({ dryRun: g.dryRun });
  });

  /* --------------------------------- AI ---------------------------------- */
  app.post('/api/ai/probe', requireToken, async (req, res) => {
    res.json(await ai.probe(getGlobal().ai));
  });

  /* -------------------------------- meta --------------------------------- */
  app.get('/api/presets', (req, res) => res.json(PRESETS));

  app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

  /* --------------------------- unknown /api ------------------------------ */
  // Every route is registered above, so anything reaching here is a typo or a
  // wrong method. Answering in JSON with the correct verb turns a bare
  // "HTTP 405" into something actionable — and makes it obvious when a request
  // is being answered by something that is NOT this server (a static host, say).
  app.use('/api', (req, res) => {
    const known = { '/api/wallets': ['GET', 'POST'], '/api/keystore/init': ['POST'] };
    const alt = known[req.path];
    res.status(alt && !alt.includes(req.method) ? 405 : 404).json({
      error: alt && !alt.includes(req.method) ? 'method_not_allowed' : 'unknown_endpoint',
      path: `/api${req.path}`,
      method: req.method,
      hint: alt
        ? `${req.path} accepts ${alt.join(' or ')}`
        : 'This is not a MEME SNIPER endpoint. If you expected the bot, check you are not talking to a static file host.',
      endpoints: 'GET /api/health lists this server; if that 404s you are not talking to the bot.',
    });
  });

  /* ---------------------------- error handler ---------------------------- */
  // Registered after all routes so an unexpected throw returns JSON instead of
  // an HTML stack trace (which leaks paths and is useless to the UI).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    log.error(`API error on ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return;
    res.status(500).json({ error: 'internal_error', detail: err.message });
  });

  /* ------------------------------- HTTP ---------------------------------- */
  const server = http.createServer(app);

  /* -------------------------- WebSocket stream --------------------------- */
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // Prime the client with current state so the UI paints instantly.
    ws.send(JSON.stringify({
      type: 'snapshot',
      data: {
        status: engine.status(),
        wallets: [...engine.traders.values()].map((t) => t.toJSON()),
        positions: [...engine.traders.values()].flatMap((t) => [...t.positions.values()].map((p) => p.toJSON())),
        logs: log.history(120),
        prices: Object.fromEntries(engine.priceCache),
      },
    }));

    const forward = (type) => (payload) => {
      if (ws.readyState !== 1) return;
      try { ws.send(JSON.stringify({ type, data: payload })); } catch { /* client gone */ }
    };

    const channels = [
      ['log', 'log'],
      ['position:opened', 'position'],
      ['position:updated', 'position'],
      ['position:exited', 'exit'],
      ['position:closed', 'position'],
      ['position:adopted', 'adopted'],
      ['wallet:stats', 'wallet'],
      ['wallet:paused', 'wallet'],
      ['wallet:resumed', 'wallet'],
      ['wallet:updated', 'wallet'],
      ['engine:status', 'status'],
      ['engine:stats', 'stats'],
      ['engine:panic', 'panic'],
      ['engine:resumed', 'resumed'],
      ['scanner:status', 'scanner'],
      ['token:skipped', 'skipped'],
      ['trade:failed', 'error'],
      ['exec:filed', 'exec'],
      ['exec:stuck', 'error'],
    ];

    const handlers = channels.map(([evt, type]) => {
      const h = forward(type);
      bus.on(evt, h);
      return [evt, h];
    });

    // Periodic heartbeat with live state — cheap and keeps the UI truthful
    // even if an individual event is missed.
    const beat = setInterval(() => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({
        type: 'tick',
        data: {
          status: engine.status(),
          wallets: [...engine.traders.values()].map((t) => t.toJSON()),
          prices: Object.fromEntries(engine.priceCache),
        },
      }));
    }, 2000);

    ws.on('close', () => {
      clearInterval(beat);
      for (const [evt, h] of handlers) bus.off(evt, h);
    });
  });

  return { server, app, SESSION_TOKEN, wss };
}

module.exports = { createServer, SESSION_TOKEN };
