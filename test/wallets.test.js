'use strict';
/**
 * The wallet store — where the trading wallets actually live.
 *
 * WHY THIS FILE EXISTS
 *
 * This module is the answer to a bug the user reported in their own words: "the
 * wallet just abruptly deleted itself and the app appeared like I never created
 * any wallet". The wallets used to live on the SERVER, in one encrypted file on a
 * disk a hosted platform rebuilds on every deploy. Now the key is generated here,
 * sealed here under its own passphrase, and stored in the browser — so the tests
 * that matter are the ones that prove:
 *
 *   · the key really is a Solana key (seed and public half agree, address derives
 *     from it, and the address is what a wallet is identified by);
 *   · the stored bytes are ciphertext, never the key;
 *   · ONE wallet's passphrase does not open another's, and a wrong passphrase is
 *     refused rather than silently producing a different key;
 *   · a pasted key is proved against its own address before it becomes a wallet
 *     you can fund — otherwise funds go somewhere nothing can reach;
 *   · several wallets coexist, and one address is one card.
 *
 * Run: node test/wallets.test.js
 */
const assert = require('node:assert');
const WalletStore = require('../public/wallets.js');

/** A localStorage, so the module runs outside a browser. */
function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _raw: (k) => (map.has(k) ? map.get(k) : null),
    _clear: () => map.clear(),
  };
}
global.localStorage = memoryStorage();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message}`);
    if (process.env.SNIPER_TEST_TRACE) console.log(String(err.stack).split('\n').slice(1, 4).join('\n'));
  }
}

(async () => {
  console.log('\nThe wallet store — keys made and sealed in the browser\n');

  await test('a wallet is a real Solana keypair: 64 bytes, and the address comes from its own public half', async () => {
    const { address } = await WalletStore.create({ passphrase: 'correct-horse-battery', label: 'Alpha' });
    const rec = WalletStore.record(address);
    assert.ok(rec, 'the wallet is stored');
    assert.match(address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/, `that is not a base58 Solana address: ${address}`);

    const secret = await WalletStore.unlock(address, 'correct-horse-battery');
    assert.strictEqual(secret.length, 64, 'a Solana secret key is 64 bytes: seed || publicKey');
    assert.strictEqual(WalletStore.b58encode(secret.slice(32)), address, 'the address IS the public half — not a label');

    // The seed and the public half must belong together. If they did not, the
    // wallet would hold funds at an address its key cannot sign for.
    assert.strictEqual(await WalletStore.verifyPair(secret), true, 'the pair proves itself');
    const tampered = Uint8Array.from(secret);
    tampered[40] ^= 0xff;
    assert.strictEqual(await WalletStore.verifyPair(tampered), false, 'and a tampered public half is caught');
  });

  await test('only ciphertext is stored — the private key never touches localStorage', async () => {
    localStorage._clear();
    const { address } = await WalletStore.create({ passphrase: 'correct-horse-battery', label: 'Sealed' });
    const raw = localStorage._raw(WalletStore.STORAGE_KEY);
    assert.ok(raw, 'something is stored');
    const rec = JSON.parse(raw).wallets[0];
    assert.ok(rec.ciphertext && rec.salt && rec.iv, 'ciphertext, salt and iv are all there');
    assert.strictEqual(WalletStore.fromBase64(rec.salt).length, 16, 'a 16-byte salt');
    assert.strictEqual(WalletStore.fromBase64(rec.iv).length, 12, 'a 12-byte GCM iv');

    const secret = await WalletStore.unlock(address, 'correct-horse-battery');
    const b58 = WalletStore.secretToBase58(secret);
    assert.ok(!raw.includes(b58), 'the base58 key is NOT in storage');
    assert.ok(!raw.includes(WalletStore.toBase64(secret)), 'nor is the raw key');
    assert.ok(!raw.includes('correct-horse-battery'), 'and neither is the passphrase');
  });

  await test('a wrong passphrase is refused, not silently accepted', async () => {
    localStorage._clear();
    const { address } = await WalletStore.create({ passphrase: 'right-passphrase', label: 'Alpha' });
    await assert.rejects(
      () => WalletStore.unlock(address, 'wrong-passphrase'),
      /Wrong passphrase/,
      'a failed decrypt must say so',
    );
    // AES-GCM authenticates, so a wrong key cannot produce garbage that looks
    // like a key. Prove the right one still works after the failure.
    const ok = await WalletStore.unlock(address, 'right-passphrase');
    assert.strictEqual(ok.length, 64, 'the real passphrase still opens it');
  });

  await test('each wallet has its OWN passphrase — one does not open another', async () => {
    localStorage._clear();
    const a = await WalletStore.create({ passphrase: 'alpha-passphrase', label: 'Alpha' });
    const b = await WalletStore.create({ passphrase: 'beta-passphrase', label: 'Beta' });

    assert.strictEqual(WalletStore.list().length, 2, 'two wallets, side by side');
    assert.strictEqual((await WalletStore.unlock(a.address, 'alpha-passphrase')).length, 64);
    assert.strictEqual((await WalletStore.unlock(b.address, 'beta-passphrase')).length, 64);
    await assert.rejects(() => WalletStore.unlock(b.address, 'alpha-passphrase'), /Wrong passphrase/);
    await assert.rejects(() => WalletStore.unlock(a.address, 'beta-passphrase'), /Wrong passphrase/);

    // Different salts even for the same passphrase: two wallets sealed with the
    // same words must not produce the same ciphertext.
    const c = await WalletStore.create({ passphrase: 'alpha-passphrase', label: 'Gamma' });
    assert.notStrictEqual(
      WalletStore.record(a.address).ciphertext,
      WalletStore.record(c.address).ciphertext,
      'each wallet is sealed with its own salt',
    );
  });

  await test('a pasted key is proved against its own address before it can become a wallet', async () => {
    localStorage._clear();
    const made = await WalletStore.create({ passphrase: 'exported-pass', label: 'Exported' });
    const b58 = WalletStore.secretToBase58(await WalletStore.unlock(made.address, 'exported-pass'));

    const parsed = await WalletStore.parseSecret(b58);
    assert.strictEqual(parsed.address, made.address, 'the same key is the same wallet');
    assert.strictEqual(parsed.secretKey.length, 64);

    // A key whose public half does not match its seed would create a wallet at an
    // address nothing can sign for. It must be refused, not stored.
    const bad = Uint8Array.from(parsed.secretKey);
    bad[50] ^= 0x01;
    await assert.rejects(() => WalletStore.parseSecret(WalletStore.secretToBase58(bad)), /corrupted/);
    await assert.rejects(() => WalletStore.parseSecret('not a key at all'), /base58|64 bytes/);
    await assert.rejects(
      () => WalletStore.parseSecret(WalletStore.b58encode(parsed.secretKey.slice(0, 32))),
      /32-byte seed/,
      'a bare seed is refused with an explanation, not silently accepted',
    );
  });

  await test('importing a key you already hold updates it — one address is one card', async () => {
    localStorage._clear();
    const made = await WalletStore.create({ passphrase: 'first-passphrase', label: 'Alpha' });
    const secret = await WalletStore.unlock(made.address, 'first-passphrase');

    await WalletStore.seal({ secretKey: secret, address: made.address, passphrase: 'second-passphrase', label: 'Alpha' });
    assert.strictEqual(WalletStore.list().length, 1, 'still one wallet, not two cards for one address');
    assert.strictEqual((await WalletStore.unlock(made.address, 'second-passphrase')).length, 64, 'the new passphrase opens it');
    await assert.rejects(() => WalletStore.unlock(made.address, 'first-passphrase'), /Wrong passphrase/);
  });

  await test('deleting a wallet removes its sealed key, and only that one', async () => {
    localStorage._clear();
    const a = await WalletStore.create({ passphrase: 'alpha-passphrase', label: 'Alpha' });
    const b = await WalletStore.create({ passphrase: 'beta-passphrase', label: 'Beta' });

    assert.strictEqual(WalletStore.remove(a.address), true, 'the delete reports what it did');
    assert.strictEqual(WalletStore.list().length, 1, 'one wallet left');
    assert.strictEqual(WalletStore.record(a.address), null, 'and its key is gone');
    assert.ok(WalletStore.record(b.address), 'the other wallet is untouched');
    assert.strictEqual(WalletStore.remove('ANotAWalletAddress1111111111111111111111111'), false, 'deleting nothing says so');
  });

  await test('the passphrase minimum is enforced where the key is made, not only in the form', async () => {
    localStorage._clear();
    await assert.rejects(() => WalletStore.create({ passphrase: 'short', label: 'X' }), /at least 8/);
    assert.strictEqual(WalletStore.list().length, 0, 'and nothing is stored');
    const made = await WalletStore.create({ passphrase: 'long-enough', label: 'X' });
    await assert.rejects(
      () => WalletStore.seal({ secretKey: new Uint8Array(64), address: made.address, passphrase: 'short' }),
      /at least 8/,
      're-sealing obeys the same rule',
    );
  });

  await test('list() exposes names and addresses — and never a key', async () => {
    localStorage._clear();
    const a = await WalletStore.create({ passphrase: 'alpha-passphrase', label: '  Alpha  ' });
    const [row] = WalletStore.list();
    assert.strictEqual(row.address, a.address, 'the address is there: it is how a wallet is identified');
    assert.strictEqual(row.label, 'Alpha', 'and the name, trimmed');
    assert.deepStrictEqual(Object.keys(row).sort(), ['address', 'createdAt', 'id', 'label'], 'and nothing else — no ciphertext, no key');
  });

  await test('a browser with no storage still works for the session', async () => {
    // A sandboxed iframe (the in-app preview) denies localStorage. Wallets must
    // still be creatable there — they just cannot outlive the page, and the app
    // says so rather than throwing.
    const real = global.localStorage;
    global.localStorage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); }, removeItem() {} };
    try {
      const made = await WalletStore.create({ passphrase: 'sandboxed-pass', label: 'Preview' });
      assert.ok(made.address, 'a wallet can still be made');
      assert.strictEqual(WalletStore.record(made.address) !== null, true, 'and used for this session');
    } finally {
      global.localStorage = real;
    }
  });

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
