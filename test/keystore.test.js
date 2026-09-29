'use strict';
/**
 * Keystore test — the encryption, and the way out of a forgotten passphrase.
 *
 * The reset path is the only action in this project that can make funds
 * unreachable through the bot, so the properties that make it safe are pinned
 * here, on a real filesystem in a temporary directory:
 *
 *   · the old file is ARCHIVED, never deleted — it still decrypts with the old
 *     passphrase, so the keys survive a change of mind;
 *   · the new passphrase works, and the old one no longer opens the live file;
 *   · a wrong passphrase leaves the existing file untouched;
 *   · resetting a fresh install is legal and reports no archive.
 *
 * DATA_DIR is read when the module is required, so it is set before the require.
 *
 * Run: node test/keystore.test.js
 */
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-test-'));
process.env.DATA_DIR = TMP;
const keystore = require('../src/wallets/keystore');

const PASS = 'first-passphrase';
const NEWPASS = 'second-passphrase';
const FILE = path.join(TMP, 'keystore.enc');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  \u001b[31m✗\u001b[0m ${name}`);
    console.log(`      ${err.message}`);
    failed += 1;
  }
}

(async () => {
  console.log('\nThe keystore, and the way out of a forgotten passphrase\n');

  await test('a new keystore is created with a passphrase, and holds no keys yet', () => {
    assert.strictEqual(keystore.isInitialised(), false, 'nothing exists yet');
    keystore.init(PASS);
    assert.strictEqual(keystore.isInitialised(), true, 'the file exists now');
    assert.strictEqual(keystore.isUnlocked(), true, 'creating it leaves it open for this session');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(FILE, 'utf8')).v !== undefined, true, 'the file is encrypted, not plaintext');
    assert.ok(!fs.readFileSync(FILE, 'utf8').includes('secretKey'), 'no key material in the file');
  });

  await test('a key written to it survives a lock and unlock with the same passphrase', () => {
    const id = 'w_one';
    const publicKey = keystore.generateKey(id);
    assert.ok(publicKey, 'a key was generated');
    assert.strictEqual(keystore.has(id), true, 'and is present while unlocked');

    keystore.lock();
    assert.strictEqual(keystore.isUnlocked(), false, 'locked means the keys are gone from memory');
    assert.strictEqual(keystore.has(id), false, 'so the wallet cannot be used');

    keystore.unlock(PASS);
    assert.strictEqual(keystore.has(id), true, 'and unlocking brings it back');
    assert.strictEqual(keystore.getKeypair(id).publicKey.toBase58(), publicKey, 'the same key, verified by its public key');
  });

  await test('a wrong passphrase is refused and does not damage the file', () => {
    const before = fs.readFileSync(FILE);
    keystore.lock();
    assert.throws(() => keystore.unlock('not-the-passphrase'), /passphrase|tamper/i, 'it must throw');
    assert.strictEqual(keystore.isUnlocked(), false, 'and must not leave the keystore open');
    assert.deepStrictEqual(fs.readFileSync(FILE), before, 'and must not rewrite the file');
    keystore.unlock(PASS);
    assert.strictEqual(keystore.has('w_one'), true, 'the correct passphrase still works afterwards');
  });

  await test('reset refuses a short passphrase', () => {
    assert.throws(() => keystore.reset('short'), /at least 8/i, 'the same floor as everywhere else');
    assert.throws(() => keystore.reset(undefined), /at least 8/i, 'and it must be given a string');
  });

  await test('reset archives the old file rather than deleting it', () => {
    const r = keystore.reset(NEWPASS);
    assert.ok(r.archived, 'it reports where the old file went');
    assert.ok(fs.existsSync(r.archived), 'and the old file is still on disk');
    assert.ok(fs.existsSync(FILE), 'and a new keystore exists at the normal path');
    assert.notStrictEqual(fs.readFileSync(FILE).equals(fs.readFileSync(r.archived)), true, 'they are different files');

    // The property that matters: the archived file still decrypts with the OLD
    // passphrase, so a user who remembers it later has not lost anything.
    const archivedBlob = JSON.parse(fs.readFileSync(r.archived, 'utf8'));
    assert.ok(archivedBlob.ct && archivedBlob.salt, 'the archive is a real keystore file');
    assert.strictEqual(archivedBlob.v, JSON.parse(fs.readFileSync(FILE, 'utf8')).v, 'same format version');
  });

  await test('after a reset: the new passphrase opens the keystore, the old one does not', () => {
    keystore.lock();
    assert.throws(() => keystore.unlock(PASS), /passphrase|tamper/i, 'the old passphrase must not open the new file');
    keystore.unlock(NEWPASS);
    assert.strictEqual(keystore.isUnlocked(), true, 'the new one does');
    assert.strictEqual(keystore.has('w_one'), false, 'and the old key is NOT in the new keystore — that is the cost of resetting');
  });

  await test('the archived file still yields the old key', () => {
    // Read the archive directly, proving the keys are recoverable by hand if the
    // forgotten passphrase ever turns up. Nothing else in this app can prove it.
    const crypto = require('node:crypto');
    const archived = fs.readdirSync(TMP).find((f) => f.startsWith('keystore.enc.archived-'));
    assert.ok(archived, 'an archive exists');

    const raw = JSON.parse(fs.readFileSync(path.join(TMP, archived), 'utf8'));
    // maxmem must be raised: N=32768, r=8 needs ~34 MB and Node's default cap is
    // 32 MB. The app's own deriveKey passes it; this test decrypts by hand, so it
    // has to pass it too.
    const key = crypto.scryptSync(PASS, Buffer.from(raw.salt, 'base64'), raw.keylen, {
      N: raw.N, r: raw.r, p: raw.p, maxmem: 256 * 1024 * 1024,
    });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(raw.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(raw.tag, 'base64'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(raw.ct, 'base64')), decipher.final()]);
    const parsed = JSON.parse(plaintext.toString('utf8'));
    assert.ok(parsed.wallets.w_one, 'the old wallet key is inside the archive');
    assert.ok(parsed.wallets.w_one.sk, 'and it is intact');
  });

  await test('reset works on a fresh install too, and reports no archive', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'keystore-fresh-'));
    delete require.cache[require.resolve('../src/wallets/keystore')];
    process.env.DATA_DIR = fresh;
    const ks2 = require('../src/wallets/keystore');
    assert.strictEqual(ks2.isInitialised(), false, 'nothing to reset');
    const r = ks2.reset('a-fresh-start-pass');
    assert.strictEqual(r.archived, null, 'nothing was archived, because there was nothing there');
    assert.strictEqual(ks2.isInitialised(), true, 'and a keystore exists now');
    assert.strictEqual(ks2.isUnlocked(), true, 'open for this session');
  });

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${passed} passed, ${failed} failed\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed === 0 ? 0 : 1);
})();
