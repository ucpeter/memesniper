'use strict';
/** The first open position makes the poller put BigInts into priceCache. Before
 * r25 the WebSocket heartbeat JSON.stringify threw an uncaught exception about
 * BigInt and killed the bot ~2 seconds after a buy. Exercise the real server
 * and a real WebSocket, without launching scanners, RPC calls or trades. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const WebSocket = require('ws');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sniper-r25-ws-'));
const { createServer } = require('../src/server');
const cfg = require('../src/config');
const bus = require('../src/util/events');

(async () => {
  const global = cfg.defaultGlobalConfig();
  const initial = BigInt(Number.MAX_SAFE_INTEGER) + 987654321n;
  const later = initial + 333n;
  const priceCache = new Map([['InitialMint', {
    price: initial, virtualSolReserves: 30000000000n,
    virtualTokenReserves: 1073000000000000n, realSolReserves: 400000000n,
    complete: false, liquidityDropPct: 0, ts: Date.now(),
  }]]);
  const engine = {
    traders: new Map(), priceCache, scanner: { ws: null },
    status: () => ({ dryRun: true, running: true }), lockedWallets: () => [],
  };
  const { server, wss } = createServer(engine, {
    getGlobal: () => global, getFull: () => ({ global, wallets: [] }), save: () => {},
  });
  let ws;
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws`);
    const messages = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    await once(ws, 'open');
    // Wait until the snapshot event has arrived rather than timing a socket read.
    const waitFor = async (type, ms = 3600) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const msg = messages.find((m) => m.type === type);
        if (msg) return msg;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`No ${type} WebSocket message within ${ms}ms`);
    };
    const snapshot = await waitFor('snapshot');
    assert.equal(snapshot.data.prices.InitialMint.price, initial.toString());
    assert.equal(snapshot.data.prices.InitialMint.virtualSolReserves, '30000000000');
    console.log('  ✓ snapshot carries exact decimal reserve strings, not BigInts');

    // This is what happens right after a buy: the price poller starts following
    // its mint, then the existing socket's next two-second heartbeat includes it.
    priceCache.set('NewlyBoughtMint', {
      price: later, virtualSolReserves: 31000000000n,
      virtualTokenReserves: 1060000000000000n, realSolReserves: 1000000000n,
      complete: false, liquidityDropPct: 0, ts: Date.now(),
    });
    const tick = await waitFor('tick');
    assert.equal(tick.data.prices.NewlyBoughtMint.price, later.toString());
    assert.equal(tick.data.prices.NewlyBoughtMint.realSolReserves, '1000000000');
    assert.equal(ws.readyState, WebSocket.OPEN, 'socket and bot must stay alive after the first buy');
    // A single tick could pass by coincidence; make sure the next one also
    // arrives with the position still open, not a silent reconnect or exit.
    const deadline = Date.now() + 2800;
    while (messages.filter((m) => m.type === 'tick').length < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(messages.filter((m) => m.type === 'tick').length >= 2,
      'multiple post-buy heartbeats must keep reaching the client');
    assert.equal(ws.readyState, WebSocket.OPEN);
    console.log('  ✓ multiple post-buy heartbeats leave the server and socket alive');

    bus.safeEmit('position:updated', { mint: 'NewlyBoughtMint', amountRaw: 123456789012345678n });
    const forwarded = await waitFor('position');
    assert.equal(forwarded.data.amountRaw, '123456789012345678');
    console.log('  ✓ trade events with nested BigInt never silently disappear');
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
      await Promise.race([once(ws, 'close'), new Promise((r) => setTimeout(r, 1000))]);
    }
    wss.close();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exitCode = 1; });
