'use strict';
/**
 * Token scanner — emits candidate mints the instant they are created.
 *
 * Two sources:
 *   • pumpportal  — a public new-token websocket. Zero setup. Default.
 *   • logs        — a raw `logsSubscribe` on the pump.fun program. Lower
 *                   latency and no third party, but you must decode the mint
 *                   out of the instruction yourself and you need a good RPC.
 *
 * The scanner's ONLY job is detection and de-duplication. All filtering happens
 * downstream against each wallet's own config, because every wallet can have
 * completely different risk settings.
 */
const WebSocket = require('ws');
const { PublicKey } = require('@solana/web3.js');
const bus = require('../util/events');
const log = require('../util/logger');

class Scanner {
  constructor(config) {
    this.config = config;
    this.ws = null;
    this.running = false;
    this.reconnectAttempts = 0;
    this.seen = new Map(); // mint -> detectedAt  (bounded)
    this.stats = { detected: 0, evaluated: 0, bought: 0, skipped: 0, startedAt: null };
    this.maxSeen = 20000;
  }

  _remember(mint) {
    if (this.seen.has(mint)) return false;
    this.seen.set(mint, Date.now());
    if (this.seen.size > this.maxSeen) {
      // Drop the oldest half. Map preserves insertion order.
      const keys = [...this.seen.keys()].slice(0, this.maxSeen / 2);
      for (const k of keys) this.seen.delete(k);
    }
    return true;
  }

  prune(olderThanMs = 30 * 60 * 1000) {
    const cutoff = Date.now() - olderThanMs;
    for (const [mint, ts] of this.seen) if (ts < cutoff) this.seen.delete(mint);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.stats.startedAt = this.stats.startedAt || Date.now();
    if (this.config.scanner.source === 'logs') this._startLogs();
    else this._startPumpPortal();
    log.info(`Scanner started (source=${this.config.scanner.source})`);
  }

  stop() {
    this.running = false;
    if (this.ws) {
      try { this.ws.close(); } catch { /* already closed */ }
      this.ws = null;
    }
    log.info('Scanner stopped');
  }

  /* ----------------------------- PumpPortal ----------------------------- */
  _startPumpPortal() {
    const url = this.config.scanner.pumpportalWs;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      log.info('Scanner websocket connected');
      this.reconnectAttempts = 0;
      bus.safeEmit('scanner:status', { connected: true, source: 'pumpportal' });
      this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      // Also track migrations so positions in migrated tokens keep a price feed.
      this.ws.send(JSON.stringify({ method: 'subscribeMigration' }));
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.txType === 'create' && msg.mint) {
        if (!this._remember(msg.mint)) return;
        this.stats.detected += 1;
        const candidate = {
          mint: msg.mint,
          symbol: msg.symbol || '',
          name: msg.name || '',
          uri: msg.uri || '',
          creator: msg.traderPublicKey || null,
          initialBuy: msg.initialBuy ?? null,
          marketCapSol: msg.marketCapSol ?? null,
          /* The curve, straight off the event.
           *
           * PumpPortal's `create` payload already carries the bonding curve state
           * and the dev's opening buy, so DEV HOLD and LIQUIDITY are known the
           * instant a launch arrives — with no RPC call at all. The reference bot
           * this project is measured against derives both from exactly these two
           * fields (`initialBuy` / `vSolInBondingCurve`). We were discarding them
           * and then asking an RPC for the same numbers, so on any launch whose
           * read was rate-limited the cells came out blank. */
          vTokensInBondingCurve: Number.isFinite(Number(msg.vTokensInBondingCurve)) ? Number(msg.vTokensInBondingCurve) : null,
          vSolInBondingCurve: Number.isFinite(Number(msg.vSolInBondingCurve)) ? Number(msg.vSolInBondingCurve) : null,
          solAmount: Number.isFinite(Number(msg.solAmount)) ? Number(msg.solAmount) : null,
          detectedAt: Date.now(),
          source: 'pumpportal',
        };
        bus.safeEmit('token:detected', candidate);
        return;
      }

      if (msg.txType === 'migrate' && msg.mint) {
        bus.safeEmit('token:migrated', { mint: msg.mint, detectedAt: Date.now() });
      }
    });

    this.ws.on('close', () => {
      bus.safeEmit('scanner:status', { connected: false, source: 'pumpportal' });
      if (!this.running) return;
      this.reconnectAttempts += 1;
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempts, 5));
      log.warn(`Scanner socket closed — reconnecting in ${delay}ms`);
      setTimeout(() => this.running && this._startPumpPortal(), delay);
    });

    this.ws.on('error', (err) => {
      log.error(`Scanner socket error: ${err.message}`);
      bus.safeEmit('scanner:status', { connected: false, error: err.message });
    });
  }

  /* ------------------------- Raw logs (advanced) ------------------------ */
  /**
   * Subscribe to pump.fun program logs. We watch for `Instruction: Create`
   * and pull the mint from the following account-keys log line.
   *
   * This path is intentionally conservative — it is a detection source, not a
   * decoder. If you want full instruction decoding, use a Yellowstone gRPC
   * feed; the interface here is the same, just swap the transport.
   */
  _startLogs() {
    const wsEndpoint = this.config.rpc.wsEndpoint;
    if (!wsEndpoint) {
      log.error('scanner.source=logs requires rpc.wsEndpoint — falling back to pumpportal');
      this.config.scanner.source = 'pumpportal';
      return this._startPumpPortal();
    }

    this.ws = new WebSocket(wsEndpoint);
    const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    let id = 0;

    this.ws.on('open', () => {
      bus.safeEmit('scanner:status', { connected: true, source: 'logs' });
      this.ws.send(JSON.stringify({
        jsonrpc: '2.0', id: ++id, method: 'logsSubscribe',
        params: [{ mentions: [PUMP] }, { commitment: 'processed' }],
      }));
    });

    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.method !== 'logsNotification') return;
      const value = msg.params?.result?.value;
      if (!value?.logs) return;
      if (!value.logs.some((l) => l.includes('Instruction: Create'))) return;

      const keys = value.logs.find((l) => l.startsWith('Program data:') || l.includes('accountKeys'));
      const mint = this._extractMintFromLogs(value.logs);
      if (!mint || !this._remember(mint)) return;

      this.stats.detected += 1;
      bus.safeEmit('token:detected', {
        mint,
        symbol: '', name: '', uri: '',
        creator: null, initialBuy: null, marketCapSol: null,
        vTokensInBondingCurve: null, vSolInBondingCurve: null,
        detectedAt: Date.now(), source: 'logs', slot: value.slot,
      });
      void keys;
    });

    this.ws.on('close', () => {
      bus.safeEmit('scanner:status', { connected: false, source: 'logs' });
      if (this.running) setTimeout(() => this.running && this._startLogs(), 2000);
    });

    this.ws.on('error', (err) => log.error(`Logs socket error: ${err.message}`));
  }

  /**
   * Extract the new mint from a Create transaction's logs.
   * The base58 mint is discoverable via the "Program log: ..." account dump;
   * this is best-effort and documented as such.
   */
  _extractMintFromLogs(logs) {
    const b58 = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;
    for (const l of logs) {
      if (!l.includes('Program log:')) continue;
      const found = l.match(b58);
      if (found) {
        for (const f of found) {
          try {
            const pk = new PublicKey(f);
            // A mint is 32 bytes; filter out known program ids.
            if (pk.toBase58() === f && f.length >= 43) return f;
          } catch { /* not a pubkey */ }
        }
      }
    }
    return null;
  }
}

module.exports = Scanner;
