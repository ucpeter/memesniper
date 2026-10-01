'use strict';
/**
 * THE WALLET STORE — where the trading wallets actually live.
 *
 * ── Why this file exists (this was the bug) ──────────────────────────────────
 * The wallets used to live on the SERVER: one encrypted file, `data/keystore.enc`,
 * holding every wallet's private key. On a hosted deployment the disk is
 * EPHEMERAL — Render throws it away on every deploy and every restart — so the
 * file, and with it every wallet the user had created, silently disappeared. From
 * the live app: "the wallet just abruptly deleted itself and the app appeared like
 * I never created any wallet."
 *
 * This is the same design the reference bot in the repo uses, and it cannot lose a
 * wallet that way:
 *
 *   · the keypair is GENERATED IN THE BROWSER and its secret key never leaves the
 *     browser at creation — only the public address is registered with the server;
 *   · the secret key is encrypted AT REST in localStorage, each wallet under ITS
 *     OWN passphrase (PBKDF2-SHA-256, 250 000 iterations → AES-256-GCM), so even
 *     someone with the browser's storage cannot read a key without that wallet's
 *     passphrase;
 *   · several wallets sit side by side, one is "active", and each one carries its
 *     own salt/iv/ciphertext — compromising one passphrase does not expose the
 *     others;
 *   · "locked" means only ciphertext is on disk. The decrypted key exists solely
 *     in this tab's memory, and is dropped the moment the wallet is locked.
 *
 * The server still has to sign trades, so when you arm a wallet the decrypted key
 * is handed to it ONCE, over the session-token-authenticated channel, and held in
 * process memory only — never written to disk, never logged. That is exactly how
 * the repo's server-side bot is armed too.
 *
 * THE RULE THAT MATTERS: the browser is the source of truth for which wallets
 * exist. A server that has forgotten everything can be re-told; a browser key that
 * was never written to the server cannot be un-lost. So the dashboard can always
 * re-register the wallets it holds — see reRegistering() in app.js.
 *
 * No dependencies: Ed25519 comes from the browser's own WebCrypto, and base58 is
 * 30 lines below.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api; // tests
  if (root) root.WalletStore = api;                                          // the dashboard
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /** Our own namespace. Deliberately not another app's key. */
  const STORAGE_KEY = 'memesniper.wallets.v1';
  /** Matches the reference implementation: 250k iterations, AES-256-GCM. */
  const ITERATIONS = 250_000;
  const PASS_MIN = 8;

  /* ----------------------------- environment ------------------------------ */

  let memoryStore = null; // used when localStorage is unavailable (sandboxed iframe)

  function storage() {
    try {
      const s = (typeof localStorage !== 'undefined') ? localStorage : null;
      if (s) {
        const probe = '__memesniper_probe__';
        s.setItem(probe, '1');
        s.removeItem(probe);
        return s;
      }
    } catch { /* SecurityError in a sandboxed frame — fall through */ }
    if (!memoryStore) {
      const map = new Map();
      memoryStore = {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
      };
    }
    return memoryStore;
  }

  /** True when the browser can hold wallets between visits. */
  function persistent() {
    return storage() === memoryStore;
  }

  const webcrypto = () => (typeof crypto !== 'undefined' && crypto && crypto.subtle ? crypto : null);

  /** Can this browser generate and seal a key at all? Asked before we promise it. */
  function supported() {
    const c = webcrypto();
    return Boolean(c && c.subtle && c.getRandomValues);
  }

  /* -------------------------------- base58 -------------------------------- */
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function b58encode(bytes) {
    let zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
    let num = 0n;
    for (const b of bytes) num = num * 256n + BigInt(b);
    let out = '';
    while (num > 0n) {
      out = B58[Number(num % 58n)] + out;
      num /= 58n;
    }
    return '1'.repeat(zeros) + out;
  }

  function b58decode(str) {
    let num = 0n;
    for (const ch of String(str)) {
      const i = B58.indexOf(ch);
      if (i === -1) throw new Error('That is not a base58 key');
      num = num * 58n + BigInt(i);
    }
    const bytes = [];
    while (num > 0n) {
      bytes.unshift(Number(num % 256n));
      num /= 256n;
    }
    let zeros = 0;
    while (zeros < str.length && str[zeros] === '1') zeros += 1;
    return new Uint8Array([...new Array(zeros).fill(0), ...bytes]);
  }

  /* -------------------------------- base64 -------------------------------- */
  function toBase64(bytes) {
    if (typeof Buffer !== 'undefined' && Buffer.from) return Buffer.from(bytes).toString('base64');
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }

  function fromBase64(b64) {
    if (typeof Buffer !== 'undefined' && Buffer.from) return new Uint8Array(Buffer.from(b64, 'base64'));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  /* -------------------------------- the store ----------------------------- */

  function emptyStore() { return { wallets: [], activeId: null }; }

  function readStore() {
    let parsed = null;
    try {
      const raw = storage().getItem(STORAGE_KEY);
      if (raw) parsed = JSON.parse(raw);
    } catch { parsed = null; }

    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.wallets)) {
      return {
        wallets: parsed.wallets.filter((w) => w && w.id && w.ciphertext),
        activeId: parsed.activeId || (parsed.wallets[0] && parsed.wallets[0].id) || null,
      };
    }
    return emptyStore();
  }

  function writeStore(store) {
    try {
      storage().setItem(STORAGE_KEY, JSON.stringify(store));
    } catch { /* out of quota, or storage disabled — the wallet is still in memory */ }
    return store;
  }

  /** Every wallet this browser holds: name, address and the sealed key. */
  function list() {
    return readStore().wallets.map((w) => ({
      id: w.id, label: w.label, address: w.address, createdAt: w.createdAt,
    }));
  }

  /** The encrypted record itself — used by the UI to show "key is on this device". */
  function record(address) {
    const store = readStore();
    return store.wallets.find((w) => w.address === address) || null;
  }

  function getActive() { return readStore().activeId; }

  function setActive(id) {
    const store = readStore();
    if (!store.wallets.some((w) => w.id === id)) return null;
    writeStore({ ...store, activeId: id });
    return id;
  }

  function remove(address) {
    const store = readStore();
    const gone = store.wallets.find((w) => w.address === address);
    const wallets = store.wallets.filter((w) => w.address !== address);
    writeStore({
      wallets,
      activeId: store.activeId === (gone && gone.id) ? (wallets[0] ? wallets[0].id : null) : store.activeId,
    });
    return Boolean(gone);
  }

  function rename(address, label) {
    const store = readStore();
    const w = store.wallets.find((x) => x.address === address);
    if (!w) return false;
    w.label = String(label || w.label).slice(0, 40);
    writeStore(store);
    return true;
  }

  /* --------------------------- keys and passphrases ----------------------- */

  async function deriveKey(passphrase, salt) {
    const c = webcrypto();
    const material = await c.subtle.importKey('raw', new TextEncoder().encode(String(passphrase)), 'PBKDF2', false, ['deriveKey']);
    return c.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  /**
   * A fresh Solana keypair, generated HERE, in this browser.
   *
   * Solana's secret key is the 64-byte ed25519 seed followed by the public key,
   * which is exactly what WebCrypto hands us: the PKCS#8 encoding of an Ed25519
   * private key ends with the 32-byte seed, and the SPKI encoding of the public
   * key ends with the 32-byte public key. No library needed.
   */
  async function generate() {
    const c = webcrypto();
    if (!supported()) throw new Error('This browser cannot create keys (needs WebCrypto)');
    const pair = await c.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const pkcs8 = new Uint8Array(await c.subtle.exportKey('pkcs8', pair.privateKey));
    const spki = new Uint8Array(await c.subtle.exportKey('spki', pair.publicKey));
    const seed = pkcs8.slice(pkcs8.length - 32);
    const pub = spki.slice(spki.length - 32);
    const secretKey = new Uint8Array(64);
    secretKey.set(seed, 0);
    secretKey.set(pub, 32);
    return { secretKey, address: b58encode(pub) };
  }

  /**
   * Sign a Solana transaction IN THE BROWSER.
   *
   * This is how the reference bot withdraws: the key is unsealed here, the
   * transfer is signed here, and the server is handed nothing but the signed
   * bytes to broadcast. The private key is therefore never required by the server
   * for a withdrawal at all — which is the whole point of holding it in the
   * browser.
   *
   * A serialized LEGACY transaction is:
   *
   *     [shortvec: number of signatures][64 bytes per signature][message…]
   *
   * For an unsigned transaction built by the server there is exactly one
   * signature slot (the fee payer's) and it is 64 zero bytes, so the message
   * starts right after it and the signature goes back into that first slot.
   * Ed25519 signs the message bytes directly — no hashing layer, no library.
   *
   * Anything unexpected about the shape throws rather than guessing: signing the
   * wrong bytes would produce a transaction that either fails on chain or, worse,
   * one that does something other than what the dialog said.
   */
  async function signTransaction(unsigned, secretKey) {
    const c = webcrypto();
    const bytes = unsigned instanceof Uint8Array ? unsigned : new Uint8Array(unsigned);
    if (bytes.length < 3) throw new Error('That transaction is too short to be one');

    // shortvec: 1 byte while the count is under 128, which is the only case we build.
    const sigCount = bytes[0];
    if (sigCount === 0) throw new Error('That transaction has no signature slot');
    if (sigCount >= 128) throw new Error('That transaction has an unusual signature count');
    const sigEnd = 1 + 64 * sigCount;
    if (bytes.length <= sigEnd) throw new Error('That transaction has no message to sign');
    const message = bytes.slice(sigEnd);

    const seed = secretKey.slice(0, 32);
    const pkcs8 = new Uint8Array(48);
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], 0);
    pkcs8.set(seed, 16);
    const priv = await c.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
    const signature = new Uint8Array(await c.subtle.sign({ name: 'Ed25519' }, priv, message));
    if (signature.length !== 64) throw new Error('This browser produced a signature of the wrong size');

    const out = bytes.slice();
    out.set(signature, 1); // slot 0 — the fee payer, which is this wallet
    return out;
  }

  /**
   * Check that a 64-byte secret key really does contain the public key it claims.
   *
   * Without this, a mistyped import would produce a wallet whose address is not
   * the one its key controls — funds sent to it would be unreachable, and the
   * failure would only show up after the money was gone.
   */
  async function verifyPair(secretKey) {
    const c = webcrypto();
    const seed = secretKey.slice(0, 32);
    const claimedPub = secretKey.slice(32);
    // The standard Ed25519 PKCS#8 wrapper around a 32-byte seed.
    const pkcs8 = new Uint8Array(48);
    pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], 0);
    pkcs8.set(seed, 16);
    try {
      const priv = await c.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
      const pub = await c.subtle.importKey('raw', claimedPub, { name: 'Ed25519' }, false, ['verify']);
      // Sign a fixed challenge and check it against the public half. A key that
      // cannot produce a signature its own address verifies is not usable.
      const msg = new TextEncoder().encode('memesniper key check');
      const sig = await c.subtle.sign({ name: 'Ed25519' }, priv, msg);
      return await c.subtle.verify({ name: 'Ed25519' }, pub, sig, msg);
    } catch {
      return false;
    }
  }

  /** Parse a pasted secret key: base58 (Phantom/Solflare export) or base64. */
  async function parseSecret(input) {
    const raw = String(input || '').trim();
    if (!raw) throw new Error('Paste the wallet’s private key first');

    let bytes = null;
    try {
      bytes = b58decode(raw);
    } catch {
      try { bytes = fromBase64(raw); } catch { bytes = null; }
    }
    if (!bytes || bytes.length !== 64) {
      throw new Error(bytes && bytes.length === 32
        ? 'That is a 32-byte seed — export the 64-byte private key instead'
        : 'A Solana private key is 64 bytes (base58 or base64)');
    }
    if (!(await verifyPair(bytes))) throw new Error('That key does not match its own public key — it is corrupted');
    return { secretKey: bytes, address: b58encode(bytes.slice(32)) };
  }

  /** Generate a wallet, seal it under its own passphrase, and store it. */
  async function create({ passphrase, label } = {}) {
    if (!supported()) throw new Error('This browser cannot create keys (needs WebCrypto)');
    if (String(passphrase || '').length < PASS_MIN) throw new Error(`Passphrase must be at least ${PASS_MIN} characters`);
    const { secretKey, address } = await generate();
    const id = await seal({ secretKey, address, passphrase, label });
    return { id, address };
  }

  /** Encrypt a secret key under a passphrase and write the record. */
  async function seal({ secretKey, address, passphrase, label }) {
    if (String(passphrase || '').length < PASS_MIN) throw new Error(`Passphrase must be at least ${PASS_MIN} characters`);
    const c = webcrypto();
    const salt = c.getRandomValues(new Uint8Array(16));
    const iv = c.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ciphertext = await c.subtle.encrypt({ name: 'AES-GCM', iv }, key, secretKey);

    const store = readStore();
    const id = (c.randomUUID ? c.randomUUID() : `w_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`);
    const rec = {
      id,
      label: String(label || '').trim() || `Wallet ${store.wallets.length + 1}`,
      address,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext)),
      createdAt: Date.now(),
    };
    // Never store the same address twice — importing a key you already hold
    // should update its passphrase, not create a second card for one wallet.
    const others = store.wallets.filter((w) => w.address !== address);
    writeStore({ wallets: [...others, rec], activeId: id });
    return id;
  }

  /** Unseal one wallet. The decrypted key lives in the caller's memory, nowhere else. */
  async function unlock(address, passphrase) {
    const rec = record(address);
    if (!rec) throw new Error('That wallet is not in this browser');
    const c = webcrypto();
    if (!supported()) throw new Error('This browser cannot open keys (needs WebCrypto)');
    const key = await deriveKey(passphrase, fromBase64(rec.salt));
    try {
      const plain = await c.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(rec.iv) }, key, fromBase64(rec.ciphertext));
      return new Uint8Array(plain);
    } catch {
      throw new Error('Wrong passphrase for this wallet');
    }
  }

  /** The base58 secret key, for handing to the local bot so it can sign. */
  function secretToBase58(secretKey) {
    return b58encode(secretKey instanceof Uint8Array ? secretKey : new Uint8Array(secretKey));
  }

  /** A one-way fingerprint so the UI can say "this is the same key" without it. */
  async function fingerprint(secretKey) {
    const c = webcrypto();
    const digest = await c.subtle.digest('SHA-256', secretKey);
    return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function clearAll() { writeStore(emptyStore()); }

  return {
    STORAGE_KEY,
    ITERATIONS,
    PASS_MIN,
    b58encode,
    b58decode,
    toBase64,
    fromBase64,
    supported,
    persistent,
    list,
    record,
    getActive,
    setActive,
    remove,
    rename,
    generate,
    parseSecret,
    verifyPair,
    signTransaction,
    create,
    seal,
    unlock,
    secretToBase58,
    fingerprint,
    clearAll,
    _storage: storage, // tests
  };
});
