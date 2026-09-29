'use strict';
/**
 * Executor — sign locally, submit, confirm, retry.
 *
 * Invariants:
 *   1. The ONLY place a private key is used is `signAndSend`. Keys are fetched
 *      from the keystore, used, and never logged, serialised, or transmitted.
 *   2. Every transaction is signed on this machine. Remote services may build
 *      transactions; they can never sign them.
 *   3. DRY RUN short-circuits before any network submission and produces a
 *      synthetic fill so the whole strategy stack can be exercised safely.
 *   4. Exits escalate. A failed sell retries with more slippage and more
 *      priority fee — being unable to exit is the single worst failure mode.
 */
const { Connection, VersionedTransaction, LAMPORTS_PER_SOL, PublicKey, Transaction, SystemProgram } = require('@solana/web3.js');
const log = require('../util/logger');
const bus = require('../util/events');

const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

class Executor {
  constructor(config, keystore) {
    this.config = config;
    this.keystore = keystore;
    this.connections = config.rpc.endpoints.map(
      (url) => new Connection(url, { commitment: config.rpc.commitment || 'confirmed', disableRetryOnRateLimit: false })
    );
    this.rr = 0;
  }

  conn() {
    // Round-robin endpoints; a dead RPC should never stall the whole bot.
    const c = this.connections[this.rr % this.connections.length];
    this.rr += 1;
    return c;
  }

  get dryRun() {
    return this.config.dryRun !== false;
  }

  /* ------------------------------ balances ------------------------------ */
  async getBalanceSol(publicKey) {
    try {
      // Normalise: callers pass base58 strings, web3.js wants PublicKey.
      const pk = publicKey instanceof PublicKey ? publicKey : new PublicKey(publicKey);
      const lamports = await this.conn().getBalance(pk, 'confirmed');
      return lamports / LAMPORTS_PER_SOL;
    } catch (err) {
      // Returning 0 here was dangerous: in live mode a balance of 0 makes the
      // trader report `skip:insufficient_balance`, so a transient RPC failure
      // looked exactly like an empty wallet and the bot silently stopped
      // trading. Transport failures must never be reported as a fact about the
      // world — throw, and let the caller decide what an unknown balance means.
      this._balanceWarnAt = this._balanceWarnAt || 0;
      const now = Date.now();
      if (now - this._balanceWarnAt > 60000) {
        this._balanceWarnAt = now;
        log.warn(
          `Balance read failed for ${publicKey.slice(0, 6)}… (${err.message.slice(0, 60)}) — treating the balance as UNKNOWN, not zero`,
        );
      }
      const e = new Error(`balance_unavailable: ${err.message}`);
      e.code = 'BALANCE_UNAVAILABLE';
      throw e;
    }
  }

  async getTokenBalanceRaw(owner, mint) {
    const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
    const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
    try {
      const { getAssociatedTokenAddress } = require('@solana/spl-token');
      const ataAddr = await getAssociatedTokenAddress(mintPk, ownerPk, true);
      const bal = await this.conn().getTokenAccountBalance(ataAddr, 'confirmed');
      return BigInt(bal.value.amount);
    } catch {
      // Fall back to scanning parsed token accounts — the ATA may not exist yet.
      try {
        const res = await this.conn().getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk }, 'confirmed');
        if (!res.value.length) return 0n;
        return BigInt(res.value[0].account.data.parsed.info.tokenAmount.amount);
      } catch {
        return 0n;
      }
    }
  }

  /**
   * Token balance where "zero" and "the RPC failed" stay different answers.
   *
   * getTokenBalanceRaw() collapses a transport failure into 0n. That is fine
   * for display, but anything that decides CUSTODY must not read a network
   * blip as "the tokens are gone": position adoption after a restart would
   * forget a live position and never fire its exits. Here a *successful* empty
   * result genuinely means zero, and anything that throws propagates as
   * BALANCE_UNAVAILABLE for the caller to treat as unknown.
   */
  async getTokenBalanceRawOrThrow(owner, mint) {
    const ownerPk = owner instanceof PublicKey ? owner : new PublicKey(owner);
    const mintPk = mint instanceof PublicKey ? mint : new PublicKey(mint);
    let res;
    try {
      res = await this.conn().getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk }, 'confirmed');
    } catch (err) {
      const e = new Error('BALANCE_UNAVAILABLE');
      e.code = 'BALANCE_UNAVAILABLE';
      e.cause = err;
      throw e;
    }
    if (!res || !Array.isArray(res.value)) {
      const e = new Error('BALANCE_UNAVAILABLE'); e.code = 'BALANCE_UNAVAILABLE'; throw e;
    }
    if (!res.value.length) return 0n;
    return BigInt(res.value[0].account.data.parsed.info.tokenAmount.amount);
  }

  /* ------------------------------ submission ---------------------------- */
  async confirm(signature, timeoutMs) {
    const conn = this.conn();
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await conn.getSignatureStatuses([signature], { searchTransactionHistory: false });
      const st = res?.value?.[0];
      if (st) {
        if (st.err) return { ok: false, error: JSON.stringify(st.err), signature };
        if (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized') {
          return { ok: true, signature, slot: st.slot };
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { ok: false, error: 'confirmation_timeout', signature };
  }

  /** Submit through a Jito bundle (atomic, MEV-protected, ordered). */
  async sendJito(signedTx) {
    const b64 = Buffer.from(signedTx.serialize()).toString('base64');
    const res = await fetch(`${this.config.jito.blockEngineUrl}/api/v1/bundles`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendBundle',
        params: [[b64], { encoding: 'base64' }],
      }),
      signal: AbortSignal.timeout(8000),
    });
    const j = await res.json();
    if (j.error) throw new Error(`jito_${JSON.stringify(j.error).slice(0, 120)}`);
    return j.result; // bundle id — bundles need separate status polling
  }

  /* ------------------------------------------------------------------ *
   * Moving your own money in and out
   * ------------------------------------------------------------------ *
   * These two flows are deliberately separate from signAndSend(), and they
   * deliberately IGNORE `dryRun`.
   *
   * dryRun governs whether the STRATEGY may spend money. It must never govern
   * whether the OWNER may withdraw, or a single mode flag could trap your funds
   * inside the bot. Withdrawals always sign for real.
   */

  /** Rent-exempt minimum for a system account: below this the account is purged. */
  static get RENT_EXEMPT_MIN_LAMPORTS() {
    return 890880n;
  }

  /** Build an UNSIGNED SOL transfer the wallet can review before signing. */
  async buildTransfer({ from, to, lamports }) {
    const fromPk = from instanceof PublicKey ? from : new PublicKey(from);
    const toPk = to instanceof PublicKey ? to : new PublicKey(to);

    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: fromPk, toPubkey: toPk, lamports: Number(lamports) }),
    );
    tx.feePayer = fromPk;
    const { blockhash, lastValidBlockHeight } = await this.conn().getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.lastValidBlockHeight = lastValidBlockHeight;

    return { tx, blockhash, lastValidBlockHeight };
  }

  /**
   * Send SOL out of a bot wallet. Always real, even in dry run.
   * @returns {{ok, signature, lamports, error?}}
   */
  async sendSol({ walletId, destination, lamports, label = 'withdraw' }) {
    const amount = BigInt(lamports);
    if (amount <= 0n) return { ok: false, error: 'amount_must_be_positive' };

    let toPk;
    try {
      toPk = new PublicKey(destination);
    } catch {
      return { ok: false, error: 'invalid_destination' };
    }

    try {
      const kp = this.keystore.getKeypair(walletId);
      if (kp.publicKey.equals(toPk)) return { ok: false, error: 'destination_is_source' };

      const { tx } = await this.buildTransfer({ from: kp.publicKey, to: toPk, lamports: amount });
      tx.sign([kp]);

      const signature = await this.conn().sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
        maxRetries: 2,
      });
      bus.safeEmit('exec:filed', { walletId, label, signature, simulated: false, ts: Date.now() });

      const confirmed = await this.confirm(signature, this.config.execution.confirmTimeoutMs);
      if (!confirmed.ok) {
        // The transaction may still land; report the signature so the user can
        // check it rather than silently retrying and double-sending.
        log.warn(`Withdrawal not confirmed (${confirmed.error}) — check signature ${signature}`, { wallet: walletId });
        return { ok: false, error: confirmed.error, signature, lamports: amount.toString() };
      }

      log.trade(`💸 WITHDREW ${(Number(amount) / 1e9).toFixed(4)} SOL → ${toPk.toBase58().slice(0, 8)}…`, { wallet: walletId });
      return { ok: true, signature, lamports: amount.toString() };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Verify that a signed transaction is EXACTLY the transfer we asked for.
   *
   * The user's wallet already showed them the transaction, but we re-check here
   * so a compromised or buggy client cannot smuggle a different instruction
   * through our RPC. Throws with a specific reason on any mismatch.
   *
   * Checks: one instruction only, system program, transfer opcode, and that
   * source, destination, amount and fee payer all match the intent.
   */
  assertTransferMatches(txBase64, intent) {
    const SYSTEM_PROGRAM = '11111111111111111111111111111111';
    const tx = Transaction.from(Buffer.from(String(txBase64 || ''), 'base64'));
    const ix = tx.instructions;

    if (ix.length !== 1) throw new Error('expected exactly one instruction');
    if (ix[0].programId.toBase58() !== SYSTEM_PROGRAM) throw new Error('not a system program transfer');

    const data = ix[0].data;
    if (data.length !== 12 || data.readUInt32LE(0) !== 2) throw new Error('not a transfer instruction');

    const lamports = data.readBigUInt64LE(4);
    const src = ix[0].keys[0].pubkey.toBase58();
    const dst = ix[0].keys[1].pubkey.toBase58();

    if (src !== intent.from) throw new Error('source mismatch');
    if (dst !== intent.to) throw new Error('destination mismatch');
    if (lamports !== BigInt(intent.lamports)) throw new Error('amount mismatch');
    if (!tx.feePayer || tx.feePayer.toBase58() !== intent.from) throw new Error('fee payer mismatch');
    return true;
  }

  /**
   * Broadcast a transaction the USER's own wallet signed in the browser.
   * We built it, they signed it, we only relay it — we never hold their key.
   */
  async broadcastSigned(base64) {
    const bytes = Buffer.from(base64, 'base64');
    const signature = await this.conn().sendRawTransaction(bytes, {
      skipPreflight: false,
      maxRetries: 2,
    });
    const confirmed = await this.confirm(signature, this.config.execution.confirmTimeoutMs);
    return { signature, confirmed: confirmed.ok, error: confirmed.ok ? null : confirmed.error };
  }

  /**
   * Sign and send. The single place a key is touched.
   * @returns {{ok, signature, simulated, error?}}
   */
  async signAndSend({ walletId, tx, simulate = null, label = 'tx' }) {
    if (!tx) return { ok: false, error: 'no_transaction' };

    /* ---------------------------- DRY RUN ---------------------------- */
    if (this.dryRun) {
      const fake = `DRY${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
      log.trade(`[dry-run] would submit ${label} → ${fake}`, { wallet: walletId });
      bus.safeEmit('exec:filed', { walletId, label, signature: fake, simulated: true, ts: Date.now() });
      // Small latency so the UI/state machine behaves realistically.
      await new Promise((r) => setTimeout(r, 250));
      return { ok: true, signature: fake, simulated: true, fill: simulate };
    }

    /* ----------------------------- LIVE ------------------------------ */
    try {
      const kp = this.keystore.getKeypair(walletId);
      tx.sign([kp]);

      let signature;
      if (this.config.jito.enabled) {
        try {
          const bundleId = await this.sendJito(tx);
          signature = tx.signatures[0] && Buffer.from(tx.signatures[0]).toString('hex');
          log.info(`Submitted Jito bundle ${bundleId}`, { wallet: walletId });
          // Jito bundles don't expose a tx signature directly; we re-send via RPC
          // as a safety net so the transaction cannot be dropped silently.
          signature = await this.conn().sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: this.config.execution.maxRetries,
          });
        } catch (err) {
          log.warn(`Jito submission failed (${err.message}) — falling back to RPC`, { wallet: walletId });
          signature = await this.conn().sendRawTransaction(tx.serialize(), {
            skipPreflight: true,
            maxRetries: this.config.execution.maxRetries,
          });
        }
      } else {
        signature = await this.conn().sendRawTransaction(tx.serialize(), {
          skipPreflight: true,
          maxRetries: this.config.execution.maxRetries,
        });
      }

      bus.safeEmit('exec:filed', { walletId, label, signature, simulated: false, ts: Date.now() });

      const confirmed = await this.confirm(signature, this.config.execution.confirmTimeoutMs);
      if (!confirmed.ok) {
        log.warn(`${label} not confirmed: ${confirmed.error}`, { wallet: walletId });
        return { ok: false, error: confirmed.error, signature };
      }

      log.trade(`✅ ${label} confirmed in slot ${confirmed.slot}`, { wallet: walletId });
      return { ok: true, signature, slot: confirmed.slot, simulated: false };
    } catch (err) {
      log.error(`${label} failed: ${err.message}`, { wallet: walletId });
      return { ok: false, error: err.message };
    }
  }

  /* ------------------------------ exits --------------------------------- */
  /**
   * Sell with escalating aggression.
   *
   * A failed sell is the worst outcome in this entire system, so each attempt
   * increases slippage tolerance and priority fee, and we accept a worse price
   * to guarantee the exit. Attempt N slippage = base * 1.6^N, capped at 50%.
   */
  async sellWithEscalation({
    walletId, buildSell, tokenAmountRaw, baseSlippageBps, label, simulate = null,
  }) {
    const attempts = Math.max(1, this.config.execution.sellRetryAttempts);
    let lastError = 'not_attempted';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const slippageBps = Math.min(5000, Math.round(baseSlippageBps * 1.6 ** (attempt - 1)));
      try {
        const { tx } = await buildSell({ slippageBps, attempt });
        const res = await this.signAndSend({
          walletId,
          tx,
          label: `${label} (attempt ${attempt}, ${(slippageBps / 100).toFixed(1)}% slip)`,
          simulate,
        });
        if (res.ok) return { ...res, slippageBps, attempt };
        lastError = res.error;
      } catch (err) {
        lastError = err.message;
        log.warn(`Sell attempt ${attempt} threw: ${err.message}`, { wallet: walletId });
      }

      if (attempt < attempts) await new Promise((r) => setTimeout(r, 500 * attempt));
    }

    log.error(`❌ ALL ${attempts} SELL ATTEMPTS FAILED (${lastError}) — manual intervention required`, { wallet: walletId });
    bus.safeEmit('exec:stuck', { walletId, tokenAmountRaw: tokenAmountRaw?.toString(), label, error: lastError });
    return { ok: false, error: lastError, exhausted: true };
  }

  static JITO_TIP_ACCOUNTS = JITO_TIP_ACCOUNTS;
}

module.exports = Executor;
