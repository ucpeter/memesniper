'use strict';
/**
 * Entry point.
 *
 * Boot order:
 *   1. load .env + config.json
 *   2. build engine (dry-run unless explicitly disabled in config)
 *   3. serve API + UI
 *
 * The read-only launch feed starts on boot. Trading does NOT start: each
 * wallet must be armed and started by its owner (live still needs confirmation).
 */
require('dotenv').config();

const cfg = require('./config');
const keystore = require('./wallets/keystore');
const Engine = require('./engine/engine');
const { createServer } = require('./server');
const log = require('./util/logger');

const config = cfg.load();
const engine = new Engine({ config, keystore });
/* Start the SOL/USD rate NOW, not when the engine is started: the dashboard shows
 * dollar values on every wallet card, and a person opening the page before pressing
 * ▶ Start should not see blank ones. One request, then one every 60 seconds. */
engine._startSolPriceWarmup();

// Recover open positions from a previous run. At boot the keystore is locked,
// so this usually cannot verify anything yet — it is called again after unlock
// and after Start. Calling it here matters because a locked boot must not look
// like "nothing to recover": resume() keeps the snapshot intact for later.
engine.resume().catch((err) => log.warn(`Position recovery failed: ${err.message}`));

const { server, SESSION_TOKEN } = createServer(engine, {
  getGlobal: () => config.global,
  getFull: () => config,
  save: () => cfg.save(),
});

const PORT = config.global.server.port;
const HOST = config.global.server.host;

server.listen(PORT, HOST, () => {
  const banner = [
    '',
    '  ███████╗███╗   ██╗██╗██████╗ ███████╗██████╗ ███████╗ ██████╗ ██╗     ',
    '  ██╔════╝████╗  ██║██║██╔══██╗██╔════╝██╔══██╗██╔════╝██╔═══██╗██║     ',
    '  ███████╗██╔██╗ ██║██║██████╔╝█████╗  ██████╔╝███████╗██║   ██║██║     ',
    '  ╚════██║██║╚██╗██║██║██╔═══╝ ██╔══╝  ██╔══██╗╚════██║██║   ██║██║     ',
    '  ███████║██║ ╚████║██║██║     ███████╗██║  ██║███████║╚██████╔╝███████╗',
    '  ╚══════╝╚═╝  ╚═══╝╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝╚══════╝ ╚═════╝ ╚══════╝',
    '',
    `  UI            http://localhost:${PORT}`,
    process.env.SESSION_TOKEN
      // If the operator set it, do not echo it into the log stream — on a hosted
      // platform those logs may be readable by others.
      ? '  Session token (set via SESSION_TOKEN — not echoed)'
      : `  Session token ${SESSION_TOKEN}  ← required for any change; keep it private`,
    `  Mode          ${config.global.dryRun ? '🧪 DRY RUN — no real funds at risk' : '🔴 LIVE — REAL FUNDS AT RISK'}`,
    `  Keystore      ${keystore.isInitialised() ? (keystore.isUnlocked() ? 'unlocked' : 'locked') : 'not initialised'}`,
    `  Wallets       ${config.wallets.length}`,
    '',
  ].join('\n');

  // eslint-disable-next-line no-console
  console.log(banner);

  if (!config.global.dryRun) {
    log.warn('════════════════════════════════════════════════════════════');
    log.warn(' LIVE TRADING IS ENABLED. Transactions will use real funds.');
    log.warn('════════════════════════════════════════════════════════════');
  }

  engine.startScanner(); // read-only launch stream; no wallet is armed or started
  log.info('Launch scanner running; wallet trading requires a per-wallet Start.');
  engine.startMaintenance();
});

/* ------------------------------ shutdown ------------------------------- */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`${signal} received — shutting down. Open positions are NOT auto-closed.`);
  try { engine.stop(); engine.scanner.stop(); } catch { /* best effort */ }
  try { keystore.lock(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  log.error(`Unhandled rejection: ${err?.message || err}`);
});
