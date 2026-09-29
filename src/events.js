'use strict';
/**
 * Event bus — the spine of the bot.
 * Every module emits here; the API server + UI subscribe here.
 * Deliberately synchronous + tiny so it never becomes a latency source.
 */
const { EventEmitter } = require('node:events');

class Bus extends EventEmitter {
  /** Emit without letting a bad listener kill the trading loop. */
  safeEmit(channel, payload) {
    try {
      this.emit(channel, payload);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[bus] listener threw on "${channel}":`, err.message);
    }
  }
}

const bus = new Bus();
bus.setMaxListeners(200);

module.exports = bus;
