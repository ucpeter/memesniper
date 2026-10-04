'use strict';
/** Offline route tests. No keys, real provider requests or real trades. */
const assert = require('node:assert/strict');
const { Keypair, PublicKey, SystemProgram, SystemInstruction, ComputeBudgetProgram, Transaction, TransactionMessage, VersionedTransaction } = require('@solana/web3.js');
const rpc = require('../src/engine/rpc');
const cfg = require('../src/config');
const Executor = require('../src/engine/executor');
const sender = require('../src/engine/heliusSender');
let passed = 0;
async function test(name, fn) { await fn(); console.log(`  ✓ ${name}`); passed++; }
async function withEnv(vars, run) {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === null) delete process.env[key]; else process.env[key] = value;
  }
  try { return await run(); }
  finally { for (const [key, value] of Object.entries(before)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } }
}
function trade(kp) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1000,
  }));
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = '11111111111111111111111111111111';
  return tx;
}
function instructions(tx) {
  return tx instanceof Transaction ? tx.instructions : TransactionMessage.decompile(tx.message).instructions;
}
(async () => {
  console.log('\nAlchemy reads -> Helius RPC reads -> Helius Sender Max trade sends\n');
  await test('exactly two configured read URLs; no public or stale saved URLs', () => withEnv({
    RPC_URL: 'https://alchemy.test/?key=SECRET',
    RPC_URL_FALLBACK: 'https://helius.test/?api-key=SECRET',
  }, () => assert.deepEqual(rpc.endpointChain(['https://api.mainnet-beta.solana.com', 'https://stale.test']),
    ['https://alchemy.test/?key=SECRET', 'https://helius.test/?api-key=SECRET'])));
  await test('no configured private reads: public is only a local/default fallback', () => withEnv({
    RPC_URL: null, RPC_URL_FALLBACK: null,
  }, () => assert.deepEqual(rpc.endpointChain([]), [rpc.PUBLIC_RPC_FALLBACK])));
  await test('a failed Alchemy account read retries the identical request at Helius', async () => {
    const realFetch = global.fetch, urls = [], bodies = [];
    global.fetch = async (url, init) => {
      urls.push(url); bodies.push(init.body);
      return url === 'https://alchemy.test' ? new Response('', { status: 503 })
        : Response.json({ jsonrpc: '2.0', result: { value: 1 } });
    };
    try {
      const result = await rpc.resilientRpcFetch(['https://alchemy.test','https://helius.test'])('ignored',
        { method: 'POST', body: '{"method":"getAccountInfo"}' });
      assert.equal((await result.json()).result.value, 1);
      assert.deepEqual(urls, ['https://alchemy.test','https://helius.test']);
      assert.equal(bodies[0], bodies[1]);
    } finally { global.fetch = realFetch; }
  });
  await test('Sender Max tip destinations are official, valid pubkeys; minimum exactly 0.001 SOL', () => {
    assert.equal(sender.TIP_LAMPORTS, 1_000_000);
    assert.equal(sender.TIP_ACCOUNTS.length, 10);
    for (const account of sender.TIP_ACCOUNTS) assert.equal(new PublicKey(account).toBase58(), account);
  });
  await test('dry run never signs, tips, broadcasts or confirms', async () => withEnv({
    RPC_URL: 'https://alchemy.test', RPC_URL_FALLBACK: 'https://helius.test', HELIUS_SENDER_ENABLED: 'true',
  }, async () => {
    const kp = Keypair.generate(), c = cfg.defaultGlobalConfig();
    const ex = new Executor(c, { getKeypair: () => { throw Error('dry-run key accessed'); } });
    ex.broadcast = () => { throw Error('dry-run broadcast'); };
    const result = await ex.signAndSend({ walletId: 'dry', tx: trade(kp), label: 'dry buy' });
    assert.equal(result.simulated, true);
  }));
  await test('Sender Max: locally tip before signing, send only to Sender, confirm via read RPC', async () => withEnv({
    RPC_URL: 'https://alchemy.test', RPC_URL_FALLBACK: 'https://helius.test',
    HELIUS_SENDER_ENABLED: 'true', FAST_SEND_URLS: 'https://quicknode.test',
  }, async () => {
    const kp = Keypair.generate(), c = cfg.defaultGlobalConfig(); c.dryRun = false;
    c.jito.enabled = true; // ignored when Sender is selected
    const ex = new Executor(c, { getKeypair: () => kp });
    let normalSends = 0, confirmed = 0, sends = 0;
    ex.connections = [{ sendRawTransaction: () => { normalSends++; throw Error('should not send via read RPC'); },
      getSignatureStatuses: async () => { confirmed++; return { value: [{ confirmationStatus: 'confirmed', err: null, slot: 12 }] }; } }];
    const realFetch = global.fetch;
    global.fetch = async (url, init) => {
      assert.equal(url, sender.URL);
      const body = JSON.parse(init.body);
      assert.equal(body.method, 'sendTransaction');
      const sent = Transaction.from(Buffer.from(body.params[0], 'base64'));
      const ix = instructions(sent);
      const tips = ix.filter((i) => i.programId.equals(SystemProgram.programId) &&
        sender.TIP_ACCOUNTS.includes(i.keys[1].pubkey.toBase58()));
      assert.equal(tips.length, 1);
      assert.equal(SystemInstruction.decodeTransfer(tips[0]).lamports, BigInt(sender.TIP_LAMPORTS));
      assert.equal(tips[0].keys[0].pubkey.toBase58(), kp.publicKey.toBase58());
      assert.equal(ix.filter((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3).length, 1);
      sends++;
      return Response.json({ result: sender.localSignature(sent) });
    };
    try {
      const result = await ex.signAndSend({ walletId: 'w', tx: trade(kp), label: 'buy' });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.simulated, false);
      assert.equal(sends, 1); assert.equal(normalSends, 0); assert.equal(confirmed, 1);
    } finally { global.fetch = realFetch; }
  }));
  await test('versioned transaction: one tip and one fee included before signing', async () => withEnv({
    RPC_URL: 'https://alchemy.test', RPC_URL_FALLBACK: 'https://helius.test', HELIUS_SENDER_ENABLED: 'true',
  }, async () => {
    const kp = Keypair.generate(), ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => kp });
    const msg = new TransactionMessage({ payerKey: kp.publicKey,
      recentBlockhash: '11111111111111111111111111111111',
      instructions: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
        SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1000 })],
    }).compileToV0Message();
    const prepared = await ex.prepareForFastLane(new VersionedTransaction(msg), kp.publicKey);
    const ix = instructions(prepared);
    assert.equal(ix.filter((i) => i.programId.equals(ComputeBudgetProgram.programId) && i.data[0] === 3).length, 1);
    assert.equal(ix.filter((i) => i.programId.equals(SystemProgram.programId) &&
      sender.TIP_ACCOUNTS.includes(i.keys[1].pubkey.toBase58())).length, 1);
    prepared.sign([kp]);
    assert.equal(sender.localSignature(prepared).length > 60, true);
  }));
  await test('Sender disabled: no Helius tip is charged; enabled but missing read fallback refuses live trade', async () => {
    const kp = Keypair.generate();
    await withEnv({ HELIUS_SENDER_ENABLED: null }, async () => {
      const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => kp });
      const prepared = await ex.prepareForFastLane(trade(kp), kp.publicKey);
      assert.equal(instructions(prepared).filter((i) => i.programId.equals(SystemProgram.programId)).length, 1);
    });
    await withEnv({ RPC_URL: 'https://alchemy.test', RPC_URL_FALLBACK: null,
      HELIUS_SENDER_ENABLED: 'true' }, async () => {
      const c = cfg.defaultGlobalConfig(); c.dryRun = false;
      const ex = new Executor(c, { getKeypair: () => kp });
      const out = await ex.signAndSend({ walletId: 'w', tx: trade(kp) });
      assert.equal(out.ok, false); assert.match(out.error, /Set two distinct Alchemy and Helius READ RPC URLs/);
    });
  });
  await test('identical reads or a Sender URL in the read chain fail closed', async () => {
    const kp = Keypair.generate();
    for (const fallback of ['https://alchemy.test', sender.URL]) {
      await withEnv({ RPC_URL: 'https://alchemy.test', RPC_URL_FALLBACK: fallback,
        HELIUS_SENDER_ENABLED: 'true' }, async () => {
        const c = cfg.defaultGlobalConfig(); c.dryRun = false;
        const ex = new Executor(c, { getKeypair: () => kp });
        const out = await ex.signAndSend({ walletId: 'w', tx: trade(kp) });
        assert.equal(out.ok, false);
        assert.match(out.error, /READ RPC URLs/);
      });
    }
  });
  await test('Sender enabled does not modify or charge browser-signed withdrawals', async () => withEnv({
    RPC_URL: 'https://alchemy.test', RPC_URL_FALLBACK: 'https://helius.test',
    HELIUS_SENDER_ENABLED: 'true',
  }, async () => {
    const kp = Keypair.generate(), tx = trade(kp);
    tx.sign(kp);
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => { throw Error('browser wallet key accessed'); } });
    let rpcSends = 0;
    ex.connections = [{ sendRawTransaction: async (raw) => {
      rpcSends++;
      const sent = Transaction.from(raw);
      assert.equal(instructions(sent).length, 1, 'no hidden Sender tip in browser-signed withdrawal');
      return sender.localSignature(sent);
    }, getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null, slot: 12 }] }) }];
    const oldFetch = global.fetch;
    global.fetch = async () => { throw Error('withdrawal must not call Sender'); };
    try {
      const result = await ex.sendSignedTransfer({
        expectFrom: kp.publicKey.toBase58(),
        destination: tx.instructions[0].keys[1].pubkey.toBase58(),
        lamports: '1000', txBase64: Buffer.from(tx.serialize()).toString('base64'),
      });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.signedBy, 'browser');
      assert.equal(rpcSends, 1);
    } finally { global.fetch = oldFetch; }
  }));
  await test('Sender refuses unsigned, invalid and unprepared submissions; no fake confirmation', async () => withEnv({
    RPC_URL: 'https://alchemy.test', RPC_URL_FALLBACK: 'https://helius.test', HELIUS_SENDER_ENABLED: 'true',
  }, async () => {
    const kp = Keypair.generate(), ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => kp });
    const raw = trade(kp);
    await assert.rejects(() => ex.broadcast(raw, 'w'), /tip_not_prepared/);
    await assert.rejects(() => sender.send(raw, () => { throw Error('network should not be reached'); }), /unsigned/);
    const prepared = await ex.prepareForFastLane(trade(kp), kp.publicKey);
    prepared.sign(kp);
    await assert.rejects(() => sender.send(prepared, async () => Response.json({ result: 'wrong-signature' })), /signature_mismatch/);
    await assert.rejects(() => sender.send(prepared, async () => Response.json({ error: { code: -32000, message: 'SECRET' } })), /rpc_-32000/);
    await assert.rejects(() => sender.send(prepared, async () => new Response('SECRET', { status: 503 })), /http_503/);
  }));
  console.log(`\n${passed} passed\n`);
})().catch((err) => { console.error(err); process.exitCode = 1; });
