'use strict';
/**
 * Executor test — the two bugs that made real money movements impossible.
 *
 * 1. `tx.sign([keypair])` instead of `tx.sign(keypair)`.
 *    web3.js declares `sign(...signers)`, so wrapping the keypair in an Array made
 *    it read `.publicKey` off the Array and throw
 *    "Cannot read properties of undefined (reading 'toString')" — on WITHDRAW, and
 *    on every live trade, because sendSol() and signAndSend() shared the mistake.
 *    Nothing caught it: dry run never signs, and no test ever signed anything.
 *
 * 2. The funding integrity check demanded exactly one instruction, so a wallet that
 *    appends a ComputeBudget instruction (Phantom does) was rejected with
 *    "integrity_check_failed: expected exactly one instruction".
 *
 * Both are offline-testable: build a transaction, sign it, verify it. No network.
 *
 * Run: node test/executor.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  Keypair, PublicKey, Transaction, SystemProgram, ComputeBudgetProgram,
  VersionedTransaction,
} = require('@solana/web3.js');

const ROOT = path.join(__dirname, '..');
const Executor = require(path.join(ROOT, 'src/engine/executor'));
const cfg = require(path.join(ROOT, 'src/config'));

const BLOCKHASH = '11111111111111111111111111111111';
const SOURCE = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS';
const DEST = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OTHER = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u{1B}[32m✓\u{1B}[0m ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  \u{1B}[31m✗\u{1B}[0m ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

/** A bare executor: no network, no keystore — only the pure helpers under test. */
function makeExecutor() {
  return new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
}

function transferTx({ from, to, lamports, extra = [], feePayer = from }) {
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports }));
  extra.forEach((ix) => tx.add(ix));
  tx.feePayer = feePayer;
  tx.recentBlockhash = BLOCKHASH;
  return tx;
}

(async () => {
  console.log('\nSigning and the funding integrity check\n');

  await test('a transaction can be SIGNED — this is the bug that broke every withdrawal', () => {
    // Reproduces the shipped mistake first, so the test documents the failure mode
    // as well as the fix.
    const kp = Keypair.generate();
    const tx = transferTx({ from: kp.publicKey, to: new PublicKey(DEST), lamports: 1000 });

    assert.throws(
      () => transferTx({ from: kp.publicKey, to: new PublicKey(DEST), lamports: 1000 }).sign([kp]),
      /toString|publicKey/,
      'signing with an ARRAY of one keypair must be shown to be the broken form',
    );

    tx.sign(kp);
    assert.strictEqual(tx.signatures.length, 1, 'exactly one signature');
    assert.ok(tx.signatures[0].signature, 'and it is a real signature');
  });

  await test('the two signing APIs are used correctly, because mixing them up broke withdrawals', async () => {
    // The mistake that broke every withdrawal: web3.js's legacy Transaction declares
    // sign(...signers), so sign([kp]) reads .publicKey off an Array and throws. A
    // VersionedTransaction, by contrast, REQUIRES an array. Both forms are therefore
    // legitimate — but only in the right place, and this test pins which is which.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'engine', 'executor.js'), 'utf8');

    assert.match(
      src,
      /if \(prepared instanceof Transaction\) prepared\.sign\(kp\);/,
      'a legacy transaction must be signed with the keypair passed directly',
    );
    assert.match(src, /else prepared\.sign\(\[kp\]\);/, 'a versioned transaction needs an array');
    assert.match(src, /tx\.sign\(kp\);/, 'the withdrawal path must also sign directly');

    // Nothing may sign a LEGACY transaction with an array. Match bare `tx.sign([`
    // and any form that is not the versioned one above.
    const arraySigns = [...src.matchAll(/\b(\w+)\.sign\(\[/g)].map((m) => m[1]);
    assert.deepStrictEqual(
      arraySigns.filter((name) => name !== 'prepared'),
      [],
      'only a VersionedTransaction may be signed with an array',
    );
  });

  await test('the tip is a real transfer to a tip account JITO named, never a guess', async () => {
    const kp = Keypair.generate();
    const ex = new Executor(
      { ...cfg.defaultGlobalConfig(), jito: { enabled: true, blockEngineUrl: 'https://jito.invalid', tipLamports: 1_000_000 } },
      { getKeypair: () => kp, has: () => true },
    );
    const TIP_ACCOUNT = '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5';
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('jito')) {
        return { ok: true, json: async () => ({ jsonrpc: '2.0', result: [TIP_ACCOUNT], id: 1 }) };
      }
      throw new Error(`unexpected fetch: ${url}`);
    };
    try {
      const tx = transferTx({ from: kp.publicKey, to: new PublicKey(DEST), lamports: 1000 });
      const prepared = await ex.prepareForFastLane(tx, kp.publicKey);

      const transfers = prepared.instructions.filter(
        (ix) => ix.programId.toBase58() === SystemProgram.programId.toBase58(),
      );
      assert.strictEqual(transfers.length, 2, 'the transfer plus exactly one tip');
      const tip = transfers[1];
      const decoded = SystemProgram.transfer({
        fromPubkey: prepared.instructions[0].keys[0].pubkey,
        toPubkey: new PublicKey(TIP_ACCOUNT),
        lamports: 1_000_000,
      });
      assert.strictEqual(tip.keys[1].pubkey.toBase58(), TIP_ACCOUNT, 'the tip must go to Jito’s own tip account');
      assert.strictEqual(tip.data.length, decoded.data.length, 'with a real lamport amount attached');

      const fee = prepared.instructions.find(
        (ix) => ix.programId.toBase58() === ComputeBudgetProgram.programId.toBase58(),
      );
      assert.ok(fee, 'a priority fee must be set: an underpriced transaction does not land');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('if Jito cannot be reached, NO tip is added — an address is never guessed', async () => {
    // A tip is a plain SOL transfer. A guessed address means real, unrecoverable
    // losses on every trade, so the only safe answer is to send without a tip.
    const kp = Keypair.generate();
    const ex = new Executor(
      { ...cfg.defaultGlobalConfig(), jito: { enabled: true, blockEngineUrl: 'https://jito.invalid', tipLamports: 1_000_000 } },
      { getKeypair: () => kp, has: () => true },
    );
    const realFetch = global.fetch;
    global.fetch = async () => { throw new Error('network down'); };
    try {
      const tx = transferTx({ from: kp.publicKey, to: new PublicKey(DEST), lamports: 1000 });
      await ex.prepareForFastLane(tx, kp.publicKey);
      assert.strictEqual(ex._lastTipAccount, null, 'no tip account may be invented');
      const transfers = tx.instructions.filter((ix) => ix.programId.toBase58() === SystemProgram.programId.toBase58());
      assert.strictEqual(transfers.length, 1, 'the transaction must carry no tip transfer');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('a transaction that already sets a priority fee is not given a second one', async () => {
    // Two SetComputeUnitPrice instructions are rejected by the runtime, and
    // PumpPortal already includes one in the transaction it builds.
    const kp = Keypair.generate();
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => kp, has: () => true });
    const tx = transferTx({
      from: kp.publicKey, to: new PublicKey(DEST), lamports: 1000,
      extra: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 12345 })],
    });
    await ex.prepareForFastLane(tx, kp.publicKey);
    const fees = tx.instructions.filter((ix) => ix.programId.toBase58() === ComputeBudgetProgram.programId.toBase58());
    assert.strictEqual(fees.length, 1, 'exactly one priority-fee instruction may survive');
  });

  await test('broadcast races every channel and survives one of them failing', async () => {
    const kp = Keypair.generate();
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => kp, has: () => true });
    const tx = transferTx({ from: kp.publicKey, to: new PublicKey(DEST), lamports: 1000 });
    tx.sign(kp);

    ex.connections = [{
      sendRawTransaction: async () => { throw new Error('429 rate limited'); },
    }];
    process.env.FAST_SEND_URLS = 'https://lane.example.tx';
    const realFetch = global.fetch;
    global.fetch = async () => ({ ok: true, json: async () => ({ result: 'LaneSig' + '2'.repeat(60) }) });
    try {
      const sig = await ex.broadcast(tx, 'w_test');
      assert.ok(String(sig).startsWith('LaneSig'), 'the lane must carry the trade when the RPC refuses it');
    } finally {
      global.fetch = realFetch;
      delete process.env.FAST_SEND_URLS;
    }
  });

  await test('broadcast reports honestly when every channel fails', async () => {
    const kp = Keypair.generate();
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => kp, has: () => true });
    const tx = transferTx({ from: kp.publicKey, to: new PublicKey(DEST), lamports: 1000 });
    tx.sign(kp);
    ex.connections = [{ sendRawTransaction: async () => { throw new Error('rpc down'); } }];

    await assert.rejects(() => ex.broadcast(tx, 'w_test'), /every submission channel failed.*rpc down/s);
  });

  await test('a REAL withdrawal runs the whole path and produces a signed transaction', async () => {
    // The bug the user hit was on the network path, not just in a helper: sendSol
    // built the transfer, signed it, and threw before sending. sendSol catches and
    // returns the raw message, which is how "Cannot read properties of undefined
    // (reading 'toString')" reached a toast. This runs sendSol end to end against a
    // fake RPC and verifies the bytes it hands to the network are genuinely signed.
    const kp = Keypair.generate();
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => kp, has: () => true });

    let sent = null;
    ex.connections = [{
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 999 }),
      sendRawTransaction: async (bytes) => { sent = bytes; return 'Sig' + '1'.repeat(60); },
      getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
    }];
    ex.rr = 0;

    const res = await ex.sendSol({ walletId: 'w_test', destination: DEST, lamports: 1_000_000 });

    assert.strictEqual(res.ok, true, `withdrawal failed: ${res.error}`);
    assert.ok(res.signature.startsWith('Sig'), 'a signature must come back');
    assert.ok(sent && sent.length > 0, 'bytes must actually reach the network call');

    // The fee payer signature must verify over the serialized message: proof that
    // the keypair signed rather than an Array being passed and silently dropped.
    const back = Transaction.from(sent);
    assert.strictEqual(back.feePayer.toBase58(), kp.publicKey.toBase58());
    assert.strictEqual(back.signatures.length, 1);
    assert.strictEqual(
      back.verifySignatures(),
      true,
      'the transaction must carry a VALID signature from the wallet being withdrawn from',
    );
  });

  await test('the exact transfer we asked for PASSES the integrity check', () => {
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const tx = transferTx({ from: signer.publicKey, to: new PublicKey(DEST), lamports: 5_000_000 });
    tx.sign(signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.strictEqual(makeExecutor().assertTransferMatches(b64, intent), true);
  });

  await test('a wallet that APPENDS a compute-budget instruction is accepted', () => {
    // This is what Phantom does, and what produced the user's
    // "integrity_check_failed: expected exactly one instruction" on a legitimate
    // transfer. Fee instructions cannot move funds, so they are tolerated.
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const tx = transferTx({
      from: signer.publicKey,
      to: new PublicKey(DEST),
      lamports: 5_000_000,
      extra: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }), ComputeBudgetProgram.setComputeUnitLimit({ units: 200000 })],
    });
    tx.sign(signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.strictEqual(makeExecutor().assertTransferMatches(b64, intent), true, 'extra fee instructions must not fail the check');
  });

  await test('a VERSIONED transaction is accepted too', () => {
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '1000000' };
    const tx = transferTx({ from: signer.publicKey, to: new PublicKey(DEST), lamports: 1_000_000 });
    tx.sign(signer);
    const vtx = new VersionedTransaction(Transaction.from(tx.serialize()).compileMessage());
    vtx.sign([signer]);
    const b64 = Buffer.from(vtx.serialize()).toString('base64');

    assert.strictEqual(makeExecutor().assertTransferMatches(b64, intent), true, 'a wallet may return a versioned transaction');
  });

  // ── and the checks that must still REFUSE ──────────────────────────────────
  await test('a SECOND transfer is refused', () => {
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const tx = transferTx({
      from: signer.publicKey,
      to: new PublicKey(DEST),
      lamports: 5_000_000,
      extra: [SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(OTHER), lamports: 999_999_999 })],
    });
    tx.sign(signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.throws(() => makeExecutor().assertTransferMatches(b64, intent), /expected exactly one transfer/, 'a smuggled second transfer must be refused');
  });

  await test('a different DESTINATION is refused', () => {
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const tx = transferTx({ from: signer.publicKey, to: new PublicKey(OTHER), lamports: 5_000_000 });
    tx.sign(signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.throws(() => makeExecutor().assertTransferMatches(b64, intent), /destination mismatch/);
  });

  await test('a different AMOUNT is refused, and the error says both numbers', () => {
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const tx = transferTx({ from: signer.publicKey, to: new PublicKey(DEST), lamports: 5_000_001 });
    tx.sign(signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.throws(
      () => makeExecutor().assertTransferMatches(b64, intent),
      /amount mismatch \(asked 5000000 lamports, signed 5000001\)/,
      'the message must show what was asked and what was signed',
    );
  });

  await test('a NON-TRANSFER system instruction is refused', () => {
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const tx = transferTx({
      from: signer.publicKey,
      to: new PublicKey(DEST),
      lamports: 5_000_000,
      extra: [SystemProgram.assign({ accountPubkey: signer.publicKey, programId: new PublicKey(OTHER) })],
    });
    tx.sign(signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.throws(() => makeExecutor().assertTransferMatches(b64, intent), /not a plain transfer/);
  });

  await test('an unexpected PROGRAM is refused, and NAMED', () => {
    // The point of naming it: a future failure should be diagnosable in one
    // round-trip rather than "integrity_check_failed" and a shrug.
    const signer = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const ix = new (require('@solana/web3.js').TransactionInstruction)({
      programId: new PublicKey(OTHER), keys: [], data: Buffer.alloc(0),
    });
    const tx = transferTx({ from: signer.publicKey, to: new PublicKey(DEST), lamports: 5_000_000, extra: [ix] });
    tx.sign(signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.throws(
      () => makeExecutor().assertTransferMatches(b64, intent),
      new RegExp(`unexpected program.*${OTHER}`),
      'the offending program must appear in the error',
    );
  });

  await test('a mismatched FEE PAYER is refused', () => {
    const signer = Keypair.generate();
    const other = Keypair.generate();
    const intent = { from: signer.publicKey.toBase58(), to: DEST, lamports: '5000000' };
    const tx = transferTx({ from: signer.publicKey, to: new PublicKey(DEST), lamports: 5_000_000, feePayer: other.publicKey });
    tx.sign(other, signer);
    const b64 = Buffer.from(tx.serialize()).toString('base64');

    assert.throws(() => makeExecutor().assertTransferMatches(b64, intent), /fee payer mismatch/);
  });

  await test('empty bytes are refused rather than crashing', () => {
    const intent = { from: SOURCE, to: DEST, lamports: '1' };
    assert.throws(() => makeExecutor().assertTransferMatches('', intent), /no transaction bytes/);
    assert.throws(() => makeExecutor().assertTransferMatches('not base64 at all', intent), /unreadable transaction bytes|no transaction bytes/);
  });

  /* ─────────────────── the BROWSER-signed withdrawal ─────────────────── */

  console.log('\nA withdrawal signed in the browser, and broadcast here\n');

  /** A connection that records what it was asked to broadcast. */
  function recordingConn({ fail = false } = {}) {
    const sent = [];
    return {
      sent,
      sendRawTransaction: async (raw) => {
        if (fail) throw new Error('429 rate limited');
        sent.push(Buffer.from(raw));
        return `${'Sig'.padEnd(64, '1')}${sent.length}`.slice(0, 88);
      },
      getSignatureStatuses: async () => ({
        value: [{ confirmationStatus: 'confirmed', err: null }],
      }),
      getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 999999 }),
      getBalance: async () => 2_000_000_000,
    };
  }

  /** Exactly what the server hands the browser: an unsigned transfer. */
  function unsignedFor(from, to, lamports) {
    const tx = transferTx({ from, to, lamports });
    return {
      tx,
      b64: Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64'),
    };
  }

  await test('a browser-signed transfer is broadcast, and the bot never sees the key', async () => {
    const kp = Keypair.generate();
    const { tx, b64 } = unsignedFor(kp.publicKey, new PublicKey(DEST), 5_000_000);
    tx.sign(kp); // this is what walletStore.signTransaction does in the tab

    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    const conn = recordingConn();
    ex.conn = () => conn;

    const out = await ex.sendSignedTransfer({
      expectFrom: kp.publicKey.toBase58(),
      destination: DEST,
      lamports: 5_000_000,
      txBase64: Buffer.from(tx.serialize()).toString('base64'),
    });

    assert.strictEqual(out.ok, true, `must broadcast: ${JSON.stringify(out)}`);
    assert.strictEqual(out.signedBy, 'browser', 'and say who signed it');
    assert.strictEqual(conn.sent.length, 1, 'exactly one broadcast');
    // The keystore in this test answers has() => false for everything: the wallet
    // was never armed, and the withdrawal still worked. That is the property.
    assert.strictEqual(out.lamports, '5000000');
    void b64;
  });

  await test('a transfer to the WRONG destination is refused, not broadcast', async () => {
    const kp = Keypair.generate();
    const { tx } = unsignedFor(kp.publicKey, new PublicKey(OTHER), 5_000_000);
    tx.sign(kp);

    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    const conn = recordingConn();
    ex.conn = () => conn;

    const out = await ex.sendSignedTransfer({
      expectFrom: kp.publicKey.toBase58(),
      destination: DEST, // what the user asked for
      lamports: 5_000_000,
      txBase64: Buffer.from(tx.serialize()).toString('base64'), // what was signed
    });

    assert.strictEqual(out.ok, false, 'a different destination must not go out');
    assert.match(out.error, /destination mismatch|refused/);
    assert.strictEqual(conn.sent.length, 0, 'and nothing may reach the network');
  });

  await test('a transfer for a LARGER amount than asked is refused', async () => {
    const kp = Keypair.generate();
    const { tx } = unsignedFor(kp.publicKey, new PublicKey(DEST), 999_000_000);
    tx.sign(kp);

    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    const conn = recordingConn();
    ex.conn = () => conn;

    const out = await ex.sendSignedTransfer({
      expectFrom: kp.publicKey.toBase58(),
      destination: DEST,
      lamports: 1_000_000,
      txBase64: Buffer.from(tx.serialize()).toString('base64'),
    });
    assert.strictEqual(out.ok, false, 'the amount shown must be the amount signed');
    assert.match(out.error, /amount mismatch|refused/);
    assert.strictEqual(conn.sent.length, 0);
  });

  await test('a withdrawal that smuggles in a second instruction is refused', async () => {
    // The drainer pattern: a "withdrawal" that also transfers something else.
    const kp = Keypair.generate();
    const { tx } = unsignedFor(kp.publicKey, new PublicKey(DEST), 5_000_000);
    tx.add(SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(OTHER), lamports: 1 }));
    tx.sign(kp);

    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    const conn = recordingConn();
    ex.conn = () => conn;

    const out = await ex.sendSignedTransfer({
      expectFrom: kp.publicKey.toBase58(),
      destination: DEST,
      lamports: 5_000_000,
      txBase64: Buffer.from(tx.serialize()).toString('base64'),
    });
    assert.strictEqual(out.ok, false, 'two transfers must never pass as one withdrawal');
    assert.match(out.error, /refused/);
    assert.strictEqual(conn.sent.length, 0);
  });

  await test('an UNSIGNED transaction is refused — there is nothing to broadcast', async () => {
    const kp = Keypair.generate();
    const { b64 } = unsignedFor(kp.publicKey, new PublicKey(DEST), 5_000_000);
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    const conn = recordingConn();
    ex.conn = () => conn;

    const out = await ex.sendSignedTransfer({
      expectFrom: kp.publicKey.toBase58(),
      destination: DEST,
      lamports: 5_000_000,
      txBase64: b64,
    });
    assert.strictEqual(out.ok, false, 'a blank signature slot must be caught here, not on chain');
    assert.strictEqual(conn.sent.length, 0);
  });

  await test('a signed transaction whose bytes were TAMPERED with is refused', async () => {
    const kp = Keypair.generate();
    const { tx } = unsignedFor(kp.publicKey, new PublicKey(DEST), 5_000_000);
    tx.sign(kp);
    const bytes = tx.serialize();
    bytes[20] ^= 0xff; // flip one bit of the signature

    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    const conn = recordingConn();
    ex.conn = () => conn;

    const out = await ex.sendSignedTransfer({
      expectFrom: kp.publicKey.toBase58(),
      destination: DEST,
      lamports: 5_000_000,
      txBase64: Buffer.from(bytes).toString('base64'),
    });
    assert.strictEqual(out.ok, false, 'the signature must be checked, not assumed');
    assert.match(out.error, /signature_invalid|refused/);
    assert.strictEqual(conn.sent.length, 0);
  });

  /* ───────── a failure the user can act on, and a signature spent once ───────── */

  console.log('\nWhen the network says no\n');

  /** A signed transfer, ready to hand to sendSignedTransfer. */
  function signedFor(fromKp, to, lamports) {
    const { tx } = unsignedFor(fromKp.publicKey, to, lamports);
    tx.sign(fromKp);
    return Buffer.from(tx.serialize()).toString('base64');
  }

  await test('a wallet with no SOL gets a sentence, not a web3.js dump', async () => {
    // The raw text of this failure is a simulation dump about a prior credit. It
    // reached the screen from the live server, and it is the kind of message that
    // makes a person think the bot is broken rather than the wallet empty.
    const kp = Keypair.generate();
    const b64 = signedFor(kp, new PublicKey(DEST), 10_000_000);
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    ex.conn = () => ({
      sendRawTransaction: async () => {
        throw new Error('Simulation failed. \nMessage: Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.. \n\nCatch the `SendTransactionError` and call `getLogs()` on it for full details.');
      },
    });

    const out = await ex.sendSignedTransfer({ expectFrom: kp.publicKey.toBase58(), destination: DEST, lamports: 10_000_000, txBase64: b64 });
    assert.strictEqual(out.ok, false, 'the send failed');
    assert.strictEqual(out.code, 'not_enough_sol', 'and it is identified as the wallet being empty');
    assert.match(out.error, /does not hold enough SOL/i, 'the message names the cause');
    assert.ok(!/Simulation failed|getLogs|prior credit/.test(out.error), 'and no raw RPC text leaks into it');
    assert.strictEqual(out.accepted, true, 'but the signed transaction WAS accepted — the signature is spent');
  });

  await test('a network failure is reported without claiming anything about the chain', async () => {
    const kp = Keypair.generate();
    const b64 = signedFor(kp, new PublicKey(DEST), 10_000_000);
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    ex.conn = () => ({ sendRawTransaction: async () => { throw new Error('fetch failed'); } });

    const out = await ex.sendSignedTransfer({ expectFrom: kp.publicKey.toBase58(), destination: DEST, lamports: 10_000_000, txBase64: b64 });
    assert.strictEqual(out.code, 'rpc_unreachable');
    assert.match(out.error, /could not be reached/i);
    assert.ok(!/fetch failed/.test(out.error), 'the raw text stays in the log');
    assert.strictEqual(out.accepted, true, 'and the signature is spent, because it was accepted');
  });

  await test('a REFUSED transaction is not marked accepted', async () => {
    const kp = Keypair.generate();
    const b64 = signedFor(kp, new PublicKey(OTHER), 10_000_000);
    let sends = 0;
    const ex = new Executor(cfg.defaultGlobalConfig(), { getKeypair: () => null, has: () => false });
    ex.conn = () => ({ sendRawTransaction: async () => { sends += 1; return 'sig'; } });

    const out = await ex.sendSignedTransfer({ expectFrom: kp.publicKey.toBase58(), destination: DEST, lamports: 10_000_000, txBase64: b64 });
    assert.strictEqual(out.ok, false, 'a transfer to the wrong address is refused');
    assert.notStrictEqual(out.accepted, true, 'and nothing is spent, because nothing was accepted');
    assert.strictEqual(sends, 0, 'and nothing was broadcast');
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
