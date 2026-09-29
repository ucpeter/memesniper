'use strict';
/**
 * Entry point.
 *
 * Boot order:
 *   1. load .env + config.json
 *   2. build engine (dry-run unless explicitly disabled in config)
 *   3. serve API + UI
 *
 * The bot does NOT auto-start trading. You start it from the UI (or POST
 * /api/engine/start). Nothing spends money until you say so, twice.
 */
require('dotenv').config();

const cfg = require('./config');
const keystore = require('./wallets/keystore');
const Engine = require('./engine/engine');
const { createServer } = require('./server');
const log = require('./util/logger');

const config = cfg.load();
const engine = new Engine({ config, keystore });

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

  log.info('Ready. Start the engine from the dashboard when you are.');
  engine.startMaintenance();
});

/* ------------------------------ shutdown ------------------------------- */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`${signal} received — shutting down. Open positions are NOT auto-closed.`);
  try { engine.stop(); } catch { /* best effort */ }
  try { keystore.lock(); } catch { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  log.error(`Unhandled rejection: ${err?.message || err}`);
});
