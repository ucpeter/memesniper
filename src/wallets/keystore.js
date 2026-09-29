'use strict';
/**
 * Local encrypted keystore.
 *
 * SECURITY CONTRACT — this file is the security boundary of the whole bot:
 *   1. Private keys are encrypted at rest with AES-256-GCM.
 *   2. The key is derived from your passphrase with scrypt (N=2^15).
 *   3. The passphrase and the plaintext keys exist ONLY in this process's memory.
 *   4. Nothing in this module ever performs network I/O. There is no telemetry,
 *      no remote backup, no "recovery service". If you see network calls added
 *      to this file, you are being robbed.
 *   5. Keys are decrypted lazily and can be wiped from memory on demand.
 *
 * This is the opposite of what the site you analysed does. Compare the two.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

/**
 * MUST resolve to the same directory as config.js's DATA_DIR, or wallets would
 * be written to one place and read from another. A test asserts they match.
 */
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const KEYSTORE_PATH = path.join(DATA_DIR, 'keystore.enc');

const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32 };
const CIPHER = 'aes-256-gcm';

let vault = null; // { wallets: { id: { secretKey: Buffer } } }
let passphrase = null;

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function deriveKey(pass, salt) {
  return crypto.scryptSync(pass, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    maxmem: 256 * 1024 * 1024,
  });
}

function encrypt(plaintext, pass) {
  const salt = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(pass, salt);
  const cipher = crypto.createCipheriv(CIPHER, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  return { v: 1, kdf: 'scrypt', ...SCRYPT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

function decrypt(blob, pass) {
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const key = deriveKey(pass, salt);
  const decipher = crypto.createDecipheriv(CIPHER, key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    key.fill(0);
    return pt;
  } catch (err) {
    key.fill(0);
    // GCM tag failure = wrong passphrase OR tampering. Never guess which.
    throw new Error('Keystore unlock failed: wrong passphrase or the file has been tampered with.');
  }
}

function persist() {
  ensureDir();
  if (!vault) return;
  const payload = Buffer.from(JSON.stringify({
    wallets: Object.fromEntries(
      Object.entries(vault.wallets).map(([id, v]) => [id, { sk: v.secretKey.toString('base64') }])
    ),
  }), 'utf8');

  const blob = encrypt(payload, passphrase);
  payload.fill(0);

  const tmp = `${KEYSTORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(blob), { mode: 0o600 });
  fs.renameSync(tmp, KEYSTORE_PATH);
  try { fs.chmodSync(KEYSTORE_PATH, 0o600); } catch { /* best effort on non-POSIX */ }
}

const isInitialised = () => fs.existsSync(KEYSTORE_PATH);

/** First-run: create the vault with a passphrase. */
function init(pass) {
  if (isInitialised()) throw new Error('Keystore already exists. Use unlock().');
  // 8 is the floor the UI states. It is a deliberate trade: long enough to matter,
  // short enough that people use a passphrase they will still have tomorrow.
  if (!pass || pass.length < 8) throw new Error('Passphrase must be at least 8 characters.');
  passphrase = pass;
  vault = { wallets: {} };
  persist();
  return true;
}

/** Re-open an existing vault. Passphrase stays in memory for the session. */
function unlock(pass) {
  if (!isInitialised()) throw new Error('No keystore found. Use init() first.');
  const blob = JSON.parse(fs.readFileSync(KEYSTORE_PATH, 'utf8'));
  const pt = decrypt(blob, pass); // throws on bad passphrase
  const parsed = JSON.parse(pt.toString('utf8'));
  pt.fill(0);
  vault = {
    wallets: Object.fromEntries(
      Object.entries(parsed.wallets || {}).map(([id, v]) => [id, { secretKey: Buffer.from(v.sk, 'base64') }])
    ),
  };
  passphrase = pass;
  return true;
}

const isUnlocked = () => vault !== null;

/** Import an existing key. Accepts base58 or a JSON byte array (Phantom export). */
function importKey(id, secret) {
  if (!isUnlocked()) throw new Error('Keystore is locked.');
  let bytes;
  const trimmed = String(secret).trim();
  if (trimmed.startsWith('[')) {
    bytes = Uint8Array.from(JSON.parse(trimmed));
  } else {
    bytes = bs58.default ? bs58.default.decode(trimmed) : bs58.decode(trimmed);
  }
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new Error(`Unexpected secret key length: ${bytes.length} (expected 32 or 64 bytes).`);
  }
  const kp = bytes.length === 64 ? Keypair.fromSecretKey(bytes) : Keypair.fromSeed(bytes);
  vault.wallets[id] = { secretKey: Buffer.from(kp.secretKey) };
  persist();
  return kp.publicKey.toBase58();
}

/** Generate a fresh keypair inside the vault (never leaves this machine). */
function generateKey(id) {
  if (!isUnlocked()) throw new Error('Keystore is locked.');
  const kp = Keypair.generate();
  vault.wallets[id] = { secretKey: Buffer.from(kp.secretKey) };
  persist();
  return kp.publicKey.toBase58();
}

function getKeypair(id) {
  if (!isUnlocked()) throw new Error('Keystore is locked.');
  const entry = vault.wallets[id];
  if (!entry) throw new Error(`No key stored for wallet ${id}`);
  return Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
}

const has = (id) => Boolean(vault && vault.wallets[id]);

function remove(id) {
  if (!isUnlocked()) throw new Error('Keystore is locked.');
  if (vault.wallets[id]) {
    vault.wallets[id].secretKey.fill(0); // zero the buffer before dropping
    delete vault.wallets[id];
    persist();
  }
  return true;
}

/** Lock: wipe keys from memory. Trading halts until unlocked again. */
function lock() {
  if (vault) {
    for (const v of Object.values(vault.wallets)) v.secretKey.fill(0);
  }
  vault = null;
  passphrase = null;
}

/**
 * Start over with a NEW passphrase, archiving the old file.
 *
 * This exists because a forgotten passphrase is otherwise a permanent dead end:
 * the file cannot be decrypted by anyone, including this bot, so there is no
 * trading, no new wallets and no withdrawals — the bot is bricked.
 *
 * The old file is ARCHIVED, never deleted. If the passphrase turns up later those
 * keys are still recoverable by hand. Nothing on chain is touched: SOL and tokens
 * stay exactly where they are, at the addresses recorded in config.json.
 *
 * Wallets created before this call keep their records but can no longer be traded
 * by the bot — their keys are in the archived file. The dashboard says so.
 */
function reset(newPass) {
  if (typeof newPass !== 'string' || newPass.length < 8) {
    throw new Error('Passphrase must be at least 8 characters.');
  }
  lock();
  let archived = null;
  if (isInitialised()) {
    archived = `${KEYSTORE_PATH}.archived-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(KEYSTORE_PATH, archived);
    try { fs.chmodSync(archived, 0o600); } catch { /* best effort on non-POSIX */ }
  }
  init(newPass);
  return { archived };
}

module.exports = { init, unlock, lock, reset, isInitialised, isUnlocked, importKey, generateKey, getKeypair, has, remove, KEYSTORE_PATH };
