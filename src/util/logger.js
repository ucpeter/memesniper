'use strict';
/**
 * Logger + in-memory ring buffer.
 *
 * The ring buffer is what feeds the UI's live log console, so it is bounded
 * (never grows) and stores structured records rather than formatted strings.
 */
const bus = require('./events');

const LEVELS = { debug: 10, info: 20, trade: 30, warn: 40, error: 50 };
const RING_SIZE = Number(process.env.LOG_RING_SIZE || 500);

const ring = [];
let seq = 0;

function push(level, message, meta = {}) {
  seq += 1;
  const record = {
    id: seq,
    ts: Date.now(),
    level,
    message: String(message),
    wallet: meta.wallet ?? null,
    meta: meta.data ?? null,
  };

  ring.push(record);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  if (LEVELS[level] >= (LEVELS[process.env.LOG_LEVEL] || LEVELS.info)) {
    const colour = { debug: '\x1b[90m', info: '\x1b[36m', trade: '\x1b[32m', warn: '\x1b[33m', error: '\x1b[31m' }[level] || '';
    const tag = record.wallet ? ` [${record.wallet}]` : '';
    // eslint-disable-next-line no-console
    console.log(`${colour}${new Date(record.ts).toISOString().slice(11, 23)} ${level.toUpperCase().padEnd(5)}${tag}\x1b[0m ${record.message}`);
  }

  bus.safeEmit('log', record);
  return record;
}

function history(limit = 200) {
  return ring.slice(-limit);
}

module.exports = {
  debug: (m, meta) => push('debug', m, meta),
  info: (m, meta) => push('info', m, meta),
  trade: (m, meta) => push('trade', m, meta),
  warn: (m, meta) => push('warn', m, meta),
  error: (m, meta) => push('error', m, meta),
  history,
};
