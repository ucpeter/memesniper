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
const fs = require('node:fs');
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
  const rpcPlaceholder = (i) => `[saved endpoint ${i + 1}]`;
  const wsPlaceholder = '[saved WebSocket endpoint]';
  function sanitiseGlobal(g) {
    // Many RPC providers embed the API key in the URL path or query string.
    // /api/status and /api/config can be read without a login, so never include
    // a full endpoint URL (or even a fragment of its credential) in either.
    return { ...g,
      rpc: { ...g.rpc,
        endpoints: (g.rpc?.endpoints || []).map((_, i) => rpcPlaceholder(i)),
        wsEndpoint: g.rpc?.wsEndpoint ? wsPlaceholder : '',
      },
      ai: { ...g.ai, apiKey: g.ai.apiKey ? maskSecret(g.ai.apiKey) : '' },
      _token: undefined,
    };
  }

  /* ------------------------------- status -------------------------------- */
  app.get('/api/status', (req, res) => {
    const g = getGlobal();
    res.json({
      engine: engine.status(),
      keystore: { initialised: keystore.isInitialised(), unlocked: keystore.isUnlocked() },
      storage: storageStatus(),
      global: sanitiseGlobal(g),
      presets: PRESETS,
    });
  });

  app.get('/api/session-token', (req, res) => {
    // Local-only convenience for the bundled UI. The token is already visible
    // in the server console; this just avoids copy-pasting it into the page.
    res.json({ token: SESSION_TOKEN });
  });

  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = () => { try { fs.mkdirSync(path.dirname(keystore.KEYSTORE_PATH), { recursive: true }); } catch { /* exists */ } };

  /**
   * Where the data actually lives, and whether this host keeps it.
   *
   * Render (and most container hosts) hand out an EPHEMERAL filesystem on their
   * free tiers: the service sleeps when idle and the disk is rebuilt on wake. A
   * bot that silently loses the user's wallets every time it idles is not usable,
   * so the dashboard says so before it happens, and offers the backup button.
   */
  function storageStatus() {
    const dir = path.dirname(keystore.KEYSTORE_PATH);
    const onRender = Boolean(process.env.RENDER);
    // Render sets RENDER=true for every service. A persistent disk is the answer,
    // and the documented path for it is /var/data, which arrives as DATA_DIR.
    const usingVolume = Boolean(process.env.DATA_DIR);
    const ephemeral = onRender && !usingVolume;
    return {
      dataDir: dir,
      ephemeral,
      reason: ephemeral
        ? 'This host rebuilds its disk when the service sleeps or redeploys, so the keystore and wallet list are destroyed each time. Attach a persistent disk and set DATA_DIR to its mount path, or restore from a backup after each wake.'
        : (usingVolume
          ? 'DATA_DIR is set, so this host is expected to keep its disk across restarts.'
          : 'Storing data next to the app. It survives a restart only if the directory does.'),
    };
  }

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
    if ([...engine.traders.values()].some((t) => t.openPositions().length || t.cfg.enabled)) {
      return res.status(409).json({ error: 'wallet_active',
        hint: 'Stop wallets and close positions before closing the server keystore. Lock the browser view to keep ongoing trades managed.' });
    }
    keystore.lock();
    res.json({ ok: true });
  });

  /**
   * The live scanner feed: every launch this session, what the checks found, and
   * what each wallet decided. Newest first.
   *
   * Also pushed on the WebSocket as `scan:update`; this route is for a page load, a
   * curl, or anything that wants the current state without holding a socket open.
   */
  // Public landing-page stream: facts only, with a FIXED informational risk
  // baseline. No wallet names, addresses, verdicts, private config, or keys.
  // It does not evaluate, filter, or trigger any trades.
  app.get('/api/launches', (req, res) => {
    const { deriveRisk } = require('./engine/livefeed');
    const rows = engine.liveFeed ? engine.liveFeed.snapshot(50) : [];
    res.json({ connected: Boolean(engine.scanner.ws && engine.scanner.ws.readyState === 1),
      rows: rows.map((r) => ({
        mint: r.mint, symbol: r.symbol, devWallet: r.devWallet,
        devHoldPct: r.devHoldPct, liquidityUsd: r.liquidityUsd,
        virtualLiquiditySol: r.virtualLiquiditySol, virtualLiquidityUsd: r.virtualLiquidityUsd,
        realLiquiditySol: r.realLiquiditySol, realLiquidityUsd: r.realLiquidityUsd,
        liquidityApprox: r.solUsdSource === 'fallback' || Boolean(r.solUsdStale),
        riskScore: deriveRisk(r, { maxDevHoldPct: 15, minLiquidityUsd: 2000 }).score,
        detectedAt: r.detectedAt,
      })) });
  });

  app.get('/api/scan', requireToken, (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 60));
    const st = engine.status();
    res.json({
      rows: engine.liveFeed ? engine.liveFeed.snapshot(limit) : [],
      stats: engine.liveFeed ? engine.liveFeed.stats : null,
      scanner: { source: st.scanner.source, connected: st.scanner.connected },
      hint: 'Newest first. decision is checking | bought | skipped | error; skipReason says why.',
    });
  });

  /* ------------------------------- backup -------------------------------- */

  /**
   * One file the user can keep: the encrypted keystore plus the wallet config.
   *
   * The keystore is exported exactly as it sits on disk — still encrypted under
   * the user's passphrase. This endpoint cannot leak a key even if the download
   * is intercepted, which is what makes it safe to store a backup anywhere.
   */
  app.get('/api/backup', requireToken, (req, res) => {
    const ksPath = keystore.KEYSTORE_PATH;
    if (!fs.existsSync(ksPath)) {
      return res.status(400).json({ error: 'nothing_to_back_up', hint: 'No keystore has been created yet.' });
    }
    const backup = {
      kind: 'meme-sniper-backup',
      version: 1,
      exportedAt: new Date().toISOString(),
      // Still encrypted. Useless without the passphrase, by design.
      keystore: JSON.parse(fs.readFileSync(ksPath, 'utf8')),
      config: getFull(),
      note: 'The keystore inside this file is encrypted with your passphrase. Keep the passphrase safe separately: without it this backup cannot be read, by anyone.',
    };
    const name = `meme-sniper-backup-${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.json(backup);
  });

  /**
   * Put a backup back.
   *
   * This exists because a host with an ephemeral disk (Render's free plan, most
   * container hosts) destroys the keystore every time the service sleeps or
   * redeploys. Without this the answer would be "your wallets are gone, again",
   * every time it idled overnight.
   *
   * The restored keystore arrives locked: the passphrase was never in the backup,
   * so it has to be typed again. That is the point.
   */
  app.post('/api/restore', requireToken, (req, res) => {
    if (req.body.confirm !== 'RESTORE') {
      return res.status(400).json({ error: 'confirmation_required', hint: "Send confirm: 'RESTORE' to replace the current keystore." });
    }
    const b = req.body.backup;
    if (!b || b.kind !== 'meme-sniper-backup') {
      return res.status(400).json({ error: 'not_a_backup', hint: 'Expected a file downloaded from the Backup button.' });
    }
    if (!b.keystore || !b.config || !Array.isArray(b.config.wallets)) {
      return res.status(400).json({ error: 'backup_incomplete', hint: 'The backup is missing its keystore or wallet list.' });
    }

    // Archive whatever is there now, so a wrong restore is undoable.
    let archived = null;
    try {
      backupDir();
      if (fs.existsSync(keystore.KEYSTORE_PATH)) {
        archived = `${keystore.KEYSTORE_PATH}.replaced-${stamp()}`;
        fs.renameSync(keystore.KEYSTORE_PATH, archived);
      }
      fs.writeFileSync(keystore.KEYSTORE_PATH, JSON.stringify(b.keystore), { mode: 0o600 });
      // Mutate the live config in place: the engine and every route hold a
      // reference to this object, so replacing it wholesale would leave them
      // pointing at the old one.
      const live = getFull();
      if (b.config.global) Object.assign(live.global, b.config.global);
      live.wallets.length = 0;
      live.wallets.push(...b.config.wallets);
      saveConfig();
    } catch (err) {
      return res.status(500).json({ error: `restore_failed: ${err.message}` });
    }

    keystore.lock(); // the passphrase was not in the backup, so it starts locked
    if (engine.resetTraders) engine.resetTraders();
    const loaded = engine.hydrate ? engine.hydrate() : 0;
    res.json({
      ok: true,
      archived,
      wallets: b.config.wallets.length,
      walletsLoaded: loaded,
      hint: 'Open the keystore with the passphrase that was in use when this backup was taken.',
    });
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
    if ([...engine.traders.values()].some((t) => t.openPositions().length || t.cfg.enabled)) {
      return res.status(409).json({ error: 'wallet_active', hint: 'Stop wallets and close open positions before resetting the keystore.' });
    }
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
    if (patch.rpc && Array.isArray(patch.rpc.endpoints)) {
      patch.rpc.endpoints = patch.rpc.endpoints.map((url, i) =>
        url === rpcPlaceholder(i) ? g.rpc.endpoints[i] : url);
      if (patch.rpc.endpoints.some((url) => !/^https?:\/\/\S+$/i.test(String(url || '')))) {
        return res.status(400).json({ error: 'invalid_rpc_endpoint', hint: 'Use full http(s) RPC URLs, one per line.' });
      }
    }
    if (patch.rpc && patch.rpc.wsEndpoint === wsPlaceholder) patch.rpc.wsEndpoint = g.rpc.wsEndpoint;
    Object.assign(g, cfg.deepMerge(g, patch));
    // Configuration is live: refresh the Connection's URL/fetch closure NOW.
    // Existing traders keep their executor reference, so their next read uses
    // the new chain. Env RPC_URL still takes precedence over dashboard values.
    if (engine.executor.configureRpc) engine.executor.configureRpc();
    saveConfig();
    bus.safeEmit('config:updated', sanitiseGlobal(g));
    res.json(sanitiseGlobal(g));
  });

  /** On-demand, authenticated RPC test using getAccountInfo, the exact
   * method that fails in the screenshot. No endpoint URL/key or response body
   * leaves this route. Never count a failed probe as token safety clearance. */
  app.post('/api/rpc/diagnostics', requireToken, async (req, res) => {
    try { res.json(await engine.executor.probeRpc()); }
    catch { res.status(503).json({ error: 'rpc_diagnostic_failed', hint: 'Read Render logs for the underlying network failure.' }); }
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
    if (!keystore.has(w.id)) {
      return res.status(400).json({
        error: 'wallet_not_armed',
        hint: `${w.name} is locked. Unlock it with its passphrase to withdraw from it.`,
      });
    }

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

  /**
   * Step 1 of a browser-signed withdrawal: build the UNSIGNED transfer.
   *
   * Deliberately does NOT need the wallet's key — reading a balance and building a
   * transfer both work from the public address alone, which is what makes a
   * withdrawal possible with the wallet locked. This is the reference bot's
   * `withdraw()` split in two: it signs with the keypair it holds in the tab; we
   * hand the unsigned bytes to the tab and take the signed ones back.
   */
  app.post('/api/wallets/:id/withdraw/intent', requireToken, async (req, res) => {
    const g = getFull();
    const w = g.wallets.find((x) => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: 'wallet_not_found' });
    if (!w.publicKey) return res.status(400).json({ error: 'wallet_has_no_address' });

    const destination = String(req.body.destination || '').trim();
    if (!destination) return res.status(400).json({ error: 'destination_required' });
    let toPk;
    try {
      toPk = new (require('@solana/web3.js').PublicKey)(destination);
    } catch {
      return res.status(400).json({ error: 'invalid_destination' });
    }

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

    let built;
    try {
      built = await executor.buildTransfer({ from: w.publicKey, to: toPk, lamports });
    } catch (err) {
      return res.status(400).json({ error: `build_failed: ${err.message}` });
    }

    const id = `wi_${crypto.randomBytes(8).toString('hex')}`;
    withdrawIntents.set(id, { id, walletId: w.id, from: w.publicKey, to: destination, lamports, ts: Date.now() });
    for (const [k, v] of withdrawIntents) if (Date.now() - v.ts > 180_000) withdrawIntents.delete(k);

    res.json({
      ok: true,
      intentId: id,
      wallet: w.id,
      from: w.publicKey,
      to: destination,
      amountSol: Number(lamports) / 1e9,
      lamports: lamports.toString(),
      txBase64: Buffer.from(built.tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
      blockhash: built.blockhash,
      lastValidBlockHeight: built.lastValidBlockHeight,
      note: 'Sign this in your browser with the wallet key, then send the signed bytes back to /submit.',
    });
  });

  /** Step 2: broadcast the transfer the BROWSER signed. No key needed here. */
  app.post('/api/wallets/:id/withdraw/submit', requireToken, async (req, res) => {
    const intent = withdrawIntents.get(req.body.intentId);
    if (!intent) return res.status(400).json({ error: 'unknown_or_expired_intent' });
    if (Date.now() - intent.ts > 180_000) {
      withdrawIntents.delete(intent.id);
      return res.status(400).json({ error: 'intent_expired' });
    }
    if (intent.walletId !== req.params.id) {
      return res.status(400).json({ error: 'intent_wallet_mismatch' });
    }
    if (!req.body.txBase64) return res.status(400).json({ error: 'signed_transaction_required' });

    // The intent's own numbers are what the signed bytes are checked against, NOT
    // whatever the caller says now.
    const out = await engine.executor.sendSignedTransfer({
      expectFrom: intent.from,
      destination: intent.to,
      lamports: intent.lamports,
      txBase64: req.body.txBase64,
    });
    /* A signed transaction is consumed the moment it is ACCEPTED — the intent is
     * spent whether the network takes it or not, so the same signed bytes can never
     * be relayed twice through this server. If the send failed, the dialog re-signs
     * a fresh one on the next press. */
    if (out.accepted) withdrawIntents.delete(intent.id);
    if (!out.ok) return res.status(400).json(out);

    const trader = engine.traders.get(intent.walletId);
    if (trader) trader.refreshBalance().catch(() => {});
    bus.safeEmit('wallet:updated', intent.walletId);
    res.json({ ok: true, signature: out.signature, amountSol: Number(intent.lamports) / 1e9, destination: intent.to, signedBy: 'browser' });
  });

  app.post('/api/wallets/:id/withdraw', requireToken, async (req, res) => {
    const g = getFull();
    const w = g.wallets.find((x) => x.id === req.params.id);
    if (!w) return res.status(404).json({ error: 'wallet_not_found' });
    if (!keystore.has(w.id)) {
      return res.status(400).json({
        error: 'wallet_not_armed',
        hint: `${w.name} is locked. Unlock it with its passphrase to withdraw from it.`,
      });
    }
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
  const fundIntents = new Map();
  /* Withdrawals the browser is about to sign. Same shape and lifetime as the
   * funding intents: an intent is a promise about WHAT will be broadcast, and the
   * signed bytes are checked against it rather than against the request body. */
  const withdrawIntents = new Map(); // id -> intent (short-lived, single use)

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

  function walletRows() {
    /* `persistent` travels with every wallet: it is how a card knows the BOT holds
     * the key (so it survives a restart) rather than this session alone. The key
     * itself is in the vault, never here. */
    const persisted = new Set(getFull().wallets.filter((w) => w.persistent).map((w) => w.id));
    const live = [...engine.traders.values()].map((t) => ({
      ...t.toJSON(),
      // Armed = this process holds the key for the session. Distinct from
      // `armed`, which the engine uses for "enabled and not paused".
      keyArmed: keystore.armed(t.cfg.id),
      keyHolder: persisted.has(t.cfg.id) ? 'server' : 'session',
      persistent: persisted.has(t.cfg.id),
    }));
    // A wallet whose key is not loaded is still a wallet the user created. Show
    // it, flagged, instead of an empty list — the name and the on-chain address
    // are in config.json and were never secret.
    const locked = engine.lockedWallets ? engine.lockedWallets() : [];
    return [...live, ...locked];
  }

  app.get('/api/wallets', (req, res) => res.json(walletRows()));

  app.post('/api/wallets', requireToken, (req, res) => {
    const g = getFull();
    const id = `w_${crypto.randomBytes(6).toString('hex')}`;
    const base = defaultWalletConfig(req.body.name || `Wallet ${g.wallets.length + 1}`);
    base.id = id;
    const wallet = req.body.preset ? applyPreset(base, req.body.preset) : normaliseWallet(base);
    wallet.id = id;

    /* ── The normal path: the key was generated IN THE BROWSER ──────────────
     * The dashboard generates the keypair, seals it in localStorage under its own
     * passphrase, and tells this server the name and the ADDRESS — nothing else.
     * The private key is never transmitted here to create a wallet, which is why
     * a wallet survives this server being redeployed, restarted or wiped.
     *
     * Idempotent on the address: re-registering a wallet the server has forgotten
     * (a fresh container with an empty disk) must give it back its card, not
     * create a duplicate.
     */
    if (req.body.address) {
      const address = String(req.body.address).trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        return res.status(400).json({ error: 'bad_address', hint: 'That is not a Solana address.' });
      }
      const existing = g.wallets.find((w) => w.publicKey === address);
      if (existing) {
        return res.json({ ok: true, existing: true, wallet: existing.id, publicKey: address });
      }
      wallet.publicKey = address;
      wallet.imported = Boolean(req.body.imported);
      wallet.keyHolder = 'browser'; // sealed in the browser, not in a file here
      delete wallet.config;
      g.wallets.push(wallet);
      saveConfig();
      // Deliberately NOT engine.addWallet(): a trader needs a keypair, and this
      // wallet has none here yet. It shows up through engine.lockedWallets() as a
      // locked card until it is armed — which is the truth, and what the card says.
      bus.safeEmit('wallet:updated', wallet.id);
      log.info(`Wallet registered: ${wallet.name} (${address}) — key is sealed in the browser; STOPPED until you arm it.`, { wallet: wallet.name });
      return res.status(201).json({ ok: true, wallet: wallet.id, publicKey: wallet.publicKey, keyHolder: 'browser' });
    }

    /* ── Legacy path: generated or imported INTO the server keystore ───────── */
    /* ── The normal path: the key was generated IN THE BROWSER ──────────────
     * The dashboard generates the keypair, seals it in localStorage under its own
     * passphrase, and tells this server the name and the ADDRESS — nothing else.
     * The private key is never transmitted here to create a wallet, which is why
     * a wallet survives this server being redeployed, restarted or wiped.
     *
     * Idempotent on the address: re-registering a wallet the server has forgotten
     * (a fresh container with an empty disk) must give it back its card, not
     * create a duplicate.
     */
    if (req.body.address) {
      const address = String(req.body.address).trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        return res.status(400).json({ error: 'bad_address', hint: 'That is not a Solana address.' });
      }
      const existing = g.wallets.find((w) => w.publicKey === address);
      if (existing) {
        return res.json({ ok: true, existing: true, wallet: existing.id, publicKey: address });
      }
      wallet.publicKey = address;
      wallet.imported = Boolean(req.body.imported);
      wallet.keyHolder = 'browser'; // sealed in the browser, not in a file here
      delete wallet.config;
      g.wallets.push(wallet);
      saveConfig();
      engine.addWallet(wallet);
      log.info(`Wallet registered: ${wallet.name} (${address}) — key is sealed in the browser; STOPPED until you arm it.`, { wallet: wallet.name });
      return res.status(201).json({ ok: true, wallet: wallet.id, publicKey: wallet.publicKey, keyHolder: 'browser' });
    }

    /* ── Legacy path: generated or imported INTO the server keystore ───────── */
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

    /* A brand-new wallet is STOPPED. Creating one is not a decision to trade —
     * it is a decision to have somewhere to trade FROM. The config default is
     * already enabled:false, and it is restated here so no preset, no client
     * echo and no future edit can make "create" mean "start trading".
     */
    wallet.enabled = false;
    wallet.stats = { ...(wallet.stats || {}), paused: false, pauseReason: null, day: null };

    g.wallets.push(wallet);
    saveConfig();
    engine.addWallet(wallet);
    log.info(`Wallet created: ${wallet.name} — STOPPED. Press ▶ Start on its card when you want it to trade.`, { wallet: wallet.name });
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
    const trader = engine.traders.get(req.params.id);
    if (trader && (trader.openPositions().length || trader.cfg.enabled)) {
      return res.status(409).json({ error: 'wallet_active', hint: 'Stop new entries and close open positions before deleting this wallet.' });
    }
    const g = getFull();
    g.wallets = g.wallets.filter((w) => w.id !== req.params.id);
    saveConfig();
    engine.removeWallet(req.params.id);
    keystore.lockOne(req.params.id); // forget the session key, if any
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
  /**
   * Arm one wallet: take its decrypted key for this session so the bot can sign.
   *
   * The browser unsealed it locally; this is the only moment the key crosses the
   * wire, it is checked against the wallet's own address, and it is held in
   * memory only (see the session keyring in wallets/keystore.js). Arming loads a
   * KEY — it does not start trading. ▶ Start still governs entries.
   */
  app.post('/api/wallets/:id/arm', requireToken, async (req, res) => {
    const g = getFull();
    const stored = g.wallets.find((w) => w.id === req.params.id);
    if (!stored) return res.status(404).json({ error: 'wallet_not_found' });
    if (!req.body.secretKey) return res.status(400).json({ error: 'secret_key_required' });

    let address;
    try {
      address = keystore.arm(stored.id, stored.publicKey, req.body.secretKey);
    } catch (err) {
      // Anything the keyring refuses is the user's to fix, in their words.
      return res.status(400).json({ error: 'cannot_arm', hint: err.message });
    }
    if (!stored.publicKey) stored.publicKey = address;
    if (!stored.keyHolder) stored.keyHolder = 'browser';

    // The key is available now, so this wallet can have a trader again without a
    // restart — including re-adopting any position it was holding.
    engine.hydrate();
    try { await engine.resume(); } catch { /* non-fatal: a wallet with no history */ }
    try { engine.refreshBalances ? engine.refreshBalances() : null; } catch { /* best effort */ }
    saveConfig();

    const t = engine.traders.get(stored.id);
    if (t) bus.safeEmit('wallet:stats', t.toJSON());
    bus.safeEmit('wallet:updated', stored.id);
    log.info(`🔓 ${stored.name} armed for this session — key kept in memory only, never written to disk.`, { wallet: stored.name });
    res.json({
      ok: true, armed: true, keyArmed: true, walletId: stored.id, publicKey: address,
      note: 'Key loaded for this session. It is held in memory only and is gone when the bot restarts — the sealed copy in your browser is untouched.',
      wallet: t ? t.toJSON() : null,
    });
  });

  /**
   * SEND THE KEY TO THE BOT — the reference repo's `persistent-bot/start`.
   *
   * The repo's browser wallet is sealed in localStorage, and its `start()` posts
   * `{ walletAddress, secretKeyBase64 }` over HTTPS so the server can trade with the
   * tab CLOSED and keep going across a reload. That is the function being asked for
   * here, and this is it.
   *
   * Where it deliberately differs from the repo: the repo keeps the key in process
   * memory, so a restart or a redeploy loses every wallet and every position it was
   * managing. This seals it into `keystore.enc` — AES-256-GCM under the keystore
   * passphrase — so the bot comes back after a restart, and so the key sitting on
   * the server's disk is not readable by anyone who gets a copy of that disk.
   *
   * It is OPT-IN, PER WALLET. A wallet the user never sends stays exactly where it
   * was: sealed in the browser, unusable by the server.
   */
  app.post('/api/wallets/:id/persist', requireToken, async (req, res) => {
    const g = getFull();
    const stored = g.wallets.find((w) => w.id === req.params.id);
    if (!stored) return res.status(404).json({ error: 'wallet_not_found' });
    if (!req.body.secretKey) return res.status(400).json({ error: 'secret_key_required' });

    /* The vault has to be open to write into it. Already open, closed and needs its
     * passphrase, or not created yet — and in the last two the SAME field opens it,
     * which is why this stays a single dialog. */
    if (!keystore.isUnlocked()) {
      const pass = String(req.body.keystorePassphrase || '');
      if (pass.length < 8) {
        return res.status(400).json({
          error: 'keystore_passphrase_required',
          hint: keystore.isInitialised()
            ? 'Send the keystore passphrase (at least 8 characters) so the bot can store this key safely.'
            : 'Choose a keystore passphrase (at least 8 characters) — the bot needs it to encrypt every key it holds, and you will be asked for it when the bot restarts.',
        });
      }
      try {
        if (keystore.isInitialised()) keystore.unlock(pass);
        else keystore.init(pass);
      } catch (err) {
        return res.status(400).json({ error: 'keystore_open_failed', hint: err.message });
      }
    }

    let address;
    try {
      address = keystore.importKey(stored.id, req.body.secretKey);
    } catch (err) {
      return res.status(400).json({ error: 'key_refused', hint: err.message });
    }
    // The key must control the address this wallet claims, or SOL sent to that
    // address would be unreachable with it.
    if (stored.publicKey && stored.publicKey !== address) {
      keystore.remove(stored.id);
      return res.status(400).json({
        error: 'key_address_mismatch',
        hint: 'That key does not control this wallet address. Nothing was stored.',
      });
    }
    if (!stored.publicKey) stored.publicKey = address;

    stored.keyHolder = 'server';
    stored.persistent = true;

    /* Arm it for THIS session too, so the button does what it says immediately:
     * the bot can trade with this wallet before the tab is even closed. */
    try { keystore.arm(stored.id, stored.publicKey, req.body.secretKey); } catch { /* it is in the vault either way */ }
    engine.hydrate();
    try { await engine.resume(); } catch { /* a wallet with no history */ }
    try { engine.refreshLockedBalances(); } catch { /* best effort */ }
    saveConfig();

    const t = engine.traders.get(stored.id);
    if (t) bus.safeEmit('wallet:stats', t.toJSON());
    bus.safeEmit('wallet:updated', stored.id);
    log.warn(`🖥 ${stored.name} sent to the bot — key sealed in keystore.enc; the bot can trade with the tab closed.`, { wallet: stored.name });
    res.json({
      ok: true,
      persistent: true,
      keyHolder: 'server',
      walletId: stored.id,
      publicKey: address,
      note: 'Optional encrypted key copy stored on this server. Reopen the keystore after a restart to resume trading and exit management. Removal requires stopping the wallet and closing open positions.',
      wallet: t ? t.toJSON() : null,
    });
  });

  /** Take the key back out of the bot. The browser keeps its sealed copy. */
  app.post('/api/wallets/:id/unpersist', requireToken, (req, res) => {
    const trader = engine.traders.get(req.params.id);
    if (trader && (trader.openPositions().length || trader.cfg.enabled)) {
      return res.status(409).json({ error: 'wallet_active', hint: 'Stop new entries and close open positions before removing the server key.' });
    }
    const g = getFull();
    const stored = g.wallets.find((w) => w.id === req.params.id);
    if (!stored) return res.status(404).json({ error: 'wallet_not_found' });

    /* Deleting the key from the ENCRYPTED FILE needs the vault open — a locked
     * vault cannot rewrite its own contents. Without this the route threw a 500 and,
     * worse, the key stayed on disk: a button labelled "Remove from bot" that leaves
     * the key there is exactly the kind of quiet lie this project cannot afford. So
     * the passphrase is asked for, and nothing is claimed until it is done. */
    if (!keystore.isUnlocked()) {
      const pass = String(req.body.keystorePassphrase || '');
      if (keystore.isInitialised() && pass.length < 8) {
        return res.status(400).json({
          error: 'keystore_passphrase_required',
          hint: 'Open the keystore to delete this key from it — send the keystore passphrase (at least 8 characters).',
        });
      }
      if (keystore.isInitialised()) {
        try {
          keystore.unlock(pass);
        } catch (err) {
          return res.status(400).json({ error: 'keystore_open_failed', hint: err.message });
        }
      }
    }

    try {
      keystore.lockOne(stored.id);
      keystore.remove(stored.id);
    } catch (err) {
      // Nothing stored under this id is not a failure — the goal is a key that is
      // not here, and that is already true.
      log.debug(`unpersist: no key to remove for ${stored.name} (${err.message})`);
    }
    stored.persistent = false;
    stored.keyHolder = 'browser';
    stored.enabled = false;
    if (stored.stats) stored.stats.paused = false;
    engine.removeWallet(stored.id);
    saveConfig();
    bus.safeEmit('wallet:updated', stored.id);
    log.warn(`🖥 ${stored.name} removed from the bot — the key is gone from this server.`, { wallet: stored.name });
    res.json({ ok: true, persistent: false, keyHolder: 'browser', note: 'The server no longer holds this key. The sealed copy in your browser is untouched.' });
  });

  /** Lock one wallet: forget its key now. The browser's sealed copy is untouched. */
  app.post('/api/wallets/:id/lock', requireToken, (req, res) => {
    const g = getFull();
    const stored = g.wallets.find((w) => w.id === req.params.id);
    if (!stored) return res.status(404).json({ error: 'wallet_not_found' });

    const trader = engine.traders.get(stored.id);
    if (trader && (trader.openPositions().length || stored.enabled)) {
      return res.status(409).json({ error: 'wallet_active',
        hint: 'Stop new entries and close open positions before removing the bot signing key. Lock the browser view instead to keep trades managed.' });
    }
    keystore.lockOne(stored.id);
    engine.removeWallet(stored.id); // no key and no open positions
    stored.enabled = false;
    if (stored.stats) stored.stats.paused = false;
    saveConfig();
    bus.safeEmit('wallet:updated', stored.id);
    log.warn(`🔒 ${stored.name} locked — its key is out of this process's memory.`, { wallet: stored.name });
    res.json({ ok: true, armed: false, keyArmed: false, walletId: stored.id, note: 'Locked. The sealed copy in your browser is untouched — unlock it again with its passphrase.' });
  });

  /**
   * Arm one wallet: take its decrypted key for this session so the bot can sign.
   *
   * The browser unsealed it locally; this is the only moment the key crosses the
   * wire, it is checked against the wallet's own address, and it is held in
   * memory only (see the session keyring in wallets/keystore.js). Arming loads a
   * KEY — it does not start trading. ▶ Start still governs entries.
   */
  app.post('/api/wallets/:id/arm', requireToken, async (req, res) => {
    const g = getFull();
    const stored = g.wallets.find((w) => w.id === req.params.id);
    if (!stored) return res.status(404).json({ error: 'wallet_not_found' });
    if (!req.body.secretKey) return res.status(400).json({ error: 'secret_key_required' });

    let address;
    try {
      address = keystore.arm(stored.id, stored.publicKey, req.body.secretKey);
    } catch (err) {
      // Anything the keyring refuses is the user's to fix, in their words.
      return res.status(400).json({ error: 'cannot_arm', hint: err.message });
    }
    if (!stored.publicKey) stored.publicKey = address;
    if (!stored.keyHolder) stored.keyHolder = 'browser';

    // The key is available now, so this wallet can have a trader again without a
    // restart — including re-adopting any position it was holding.
    engine.hydrate();
    try { await engine.resume(); } catch { /* non-fatal: a wallet with no history */ }
    try { engine.refreshBalances ? engine.refreshBalances() : null; } catch { /* best effort */ }
    saveConfig();

    const t = engine.traders.get(stored.id);
    if (t) bus.safeEmit('wallet:stats', t.toJSON());
    bus.safeEmit('wallet:updated', stored.id);
    log.info(`🔓 ${stored.name} armed for this session — key kept in memory only, never written to disk.`, { wallet: stored.name });
    res.json({
      ok: true, armed: true, keyArmed: true, walletId: stored.id, publicKey: address,
      note: 'Key loaded for this session. It is held in memory only and is gone when the bot restarts — the sealed copy in your browser is untouched.',
      wallet: t ? t.toJSON() : null,
    });
  });

  app.post('/api/wallets/:id/start', requireToken, async (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) {
      /* A wallet with no key loaded is not missing — it is not armed yet. Say
       * which one it is instead of a bare 404, so the dashboard can offer the
       * unlock button rather than making the user guess. */
      const g0 = getFull();
      const known = g0.wallets.find((w) => w.id === req.params.id);
      if (known) {
        return res.status(400).json({
          error: 'wallet_not_armed',
          hint: `${known.name} is locked. Unlock it with its passphrase to trade it.`,
        });
      }
      return res.status(404).json({ error: 'wallet_not_found' });
    }

    if (!engine.running) engine.start();

    /* Arming a wallet means TWO things, and only doing the first was the bug the
     * user hit: `resume()` cleared the pause flag, but the entry gate reads
     * cfg.enabled, which is false on every wallet you create. So Start un-paused
     * a wallet that was still disabled — nothing could ever trade, and no amount
     * of pressing it produced a single (paper) trade. Arm both, persist, and say
     * which mode you are arming into.
     */
    t.cfg.enabled = true;
    t.resume();
    const g = getFull();
    const stored = g.wallets.find((x) => x.id === t.cfg.id);
    if (stored) stored.enabled = true;
    saveConfig();

    log.info(
      `▶ ${t.cfg.name} armed — ${engine.executor.dryRun ? '🧪 DRY RUN: trades are simulated (no funds spent)' : '🔴 LIVE: real funds'}`,
      { wallet: t.cfg.name },
    );
    bus.safeEmit('wallet:stats', t.toJSON());
    bus.safeEmit('wallet:updated', t.cfg.id);
    res.json({
      ok: true,
      running: true,
      enabled: true,
      paused: false,
      armed: true,
      dryRun: engine.executor.dryRun,
      engineRunning: engine.running,
      note: engine.executor.dryRun
        ? 'Armed in DRY RUN: this wallet will take simulated (paper) trades — nothing is broadcast.'
        : 'Armed LIVE: this wallet will spend real SOL.',
      wallet: t.toJSON(),
    });
  });

  app.post('/api/wallets/:id/stop', requireToken, async (req, res) => {
    const t = engine.traders.get(req.params.id);
    if (!t) return res.status(404).json({ error: 'wallet_not_found' });

    t.cfg.enabled = false;
    t.pause('stopped from the dashboard');
    const g = getFull();
    const stored = g.wallets.find((x) => x.id === t.cfg.id);
    if (stored) stored.enabled = false;
    saveConfig();

    log.warn(`⏸ ${t.cfg.name} stopped — no new entries. Open positions are still managed.`, { wallet: t.cfg.name });
    bus.safeEmit('wallet:stats', t.toJSON());
    bus.safeEmit('wallet:updated', t.cfg.id);
    res.json({
      ok: true, running: false, enabled: false, paused: true, armed: false, wallet: t.toJSON(),
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
        wallets: walletRows(),
        positions: [...engine.traders.values()].flatMap((t) => [...t.positions.values()].map((p) => p.toJSON())),
        // Every launch already scanned this session, newest first, so the live
        // scanner table is populated when the page loads rather than only after the
        // next launch happens to arrive.
        scanFeed: engine.liveFeed ? engine.liveFeed.snapshot(200) : [],
        scan: engine.liveFeed ? { ...engine.liveFeed.stats, rows: engine.liveFeed.size } : null,
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
      ['scan:update', 'scan'],
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
          wallets: walletRows(),
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
