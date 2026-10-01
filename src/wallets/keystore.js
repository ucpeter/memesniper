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

/* ==================================================================
 * SESSION KEYS — wallets armed from the browser
 * ==================================================================
 *
 * The wallets themselves live in the BROWSER now (see public/wallets.js): the key
 * is generated there, sealed there under its own passphrase, and stored in
 * localStorage. That is what makes a wallet survive a server redeploy — the one
 * thing the old server-side keystore.enc could not do, and the reason the user
 * watched a wallet "abruptly delete itself" on a hosted instance whose disk is
 * thrown away on every deploy.
 *
 * The bot still has to sign transactions while the tab is closed, so arming a
 * wallet hands its decrypted key to this process ONCE. It is held here, in
 * memory, for the life of the process:
 *
 *   · never written to disk — there is no file, no backup, nothing to leak;
 *   · dropped the moment the wallet is locked, and on shutdown;
 *   · matched against the wallet's address before it is accepted, so a key that
 *     does not belong to that address is refused rather than silently used.
 */
const session = new Map(); // walletId -> { keypair, address, armedAt }

/**
 * Take a wallet's decrypted key for this session.
 *
 * @param {string} id        wallet id, as recorded in config.json
 * @param {string} address   the address the dashboard holds for that wallet
 * @param {string} secret    base58 secret key (64 bytes), straight from the browser
 */
function arm(id, address, secret) {
  if (!id || !secret) throw new Error('A wallet id and a key are both required.');
  let bytes;
  try {
    bytes = bs58.default ? bs58.default.decode(String(secret).trim()) : bs58.decode(String(secret).trim());
  } catch {
    throw new Error('That key is not valid base58.');
  }
  if (bytes.length !== 64) throw new Error(`A Solana key is 64 bytes — that one is ${bytes.length}.`);

  const kp = Keypair.fromSecretKey(bytes);
  const real = kp.publicKey.toBase58();
  if (address && real !== address) {
    throw new Error('That key belongs to a different address than this wallet.');
  }
  session.set(id, { keypair: kp, address: real, armedAt: Date.now() });
  return real;
}

/** Is this wallet's key loaded for the session? */
const armed = (id) => session.has(id);
const armedIds = () => [...session.keys()];

/** Forget ONE wallet's key. The browser still has the sealed copy. */
function lockOne(id) {
  const entry = session.get(id);
  if (entry && entry.keypair && entry.keypair.secretKey) entry.keypair.secretKey.fill(0);
  return session.delete(id);
}

function lockAllSession() {
  for (const entry of session.values()) {
    if (entry.keypair && entry.keypair.secretKey) entry.keypair.secretKey.fill(0);
  }
  session.clear();
}

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
  // A wallet armed from the browser is a first-class wallet: the engine, the
  // executor and the withdrawal path all ask for a keypair by wallet id and must
  // not care which of the two stores answered.
  const s = session.get(id);
  if (s) return s.keypair;
  if (!isUnlocked()) throw new Error('Keystore is locked.');
  const entry = vault.wallets[id];
  if (!entry) throw new Error(`No key stored for wallet ${id}`);
  return Keypair.fromSecretKey(Uint8Array.from(entry.secretKey));
}

/** True when this wallet can sign — from an armed session key or the old vault. */
const has = (id) => session.has(id) || Boolean(vault && vault.wallets[id]);

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
  lockAllSession(); // nothing stays in memory either
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

module.exports = {
  init, unlock, lock, reset, isInitialised, isUnlocked,
  importKey, generateKey, getKeypair, has, remove,
  arm, armed, armedIds, lockOne, lockAllSession,
  KEYSTORE_PATH,
};
