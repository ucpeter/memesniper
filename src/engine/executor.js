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
const {
  ComputeBudgetProgram, Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, TransactionMessage, VersionedTransaction,
} = require('@solana/web3.js');
const log = require('../util/logger');
const bus = require('../util/events');
const rpc = require('./rpc');

/**
 * Jito's tip accounts are FETCHED, never assumed.
 *
 * There is deliberately no hardcoded list. A tip is a plain SOL transfer to whatever
 * address ends up in the transaction, and Jito has rotated this list before: one
 * stale or mistyped address means real SOL sent somewhere nobody can recover it,
 * on every trade. A bundle with no tip at all is simply not competitive and does
 * not land — which is what this code used to do while calling itself MEV-protected.
 *
 * So: ask Jito, cache the answer briefly, and if Jito cannot be reached, send
 * WITHOUT a tip and say so rather than guessing an address.
 */
const JITO_TIP_CACHE_MS = 5 * 60 * 1000;

class Executor {
  constructor(config, keystore) {
    this.config = config;
    this.keystore = keystore;

    // One chain for every endpoint this deployment knows about: RPC_URL from the
    // environment first (it must win — a saved config.json quietly overriding it is
    // what kept the bot on the rate-limited public RPC while .env looked correct),
    // then the configured list, then an optional fallback, then the public RPC.
    const chain = rpc.endpointChain(config.rpc.endpoints || []);
    const fetchImpl = rpc.resilientRpcFetch(chain);
    // The primary is the first endpoint of the chain; failover happens inside the
    // fetch, per call, so a dead endpoint only costs one timeout rather than
    // poisoning every request that happens to round-robin onto it.
    this.connections = [
      new Connection(chain[0], {
        commitment: config.rpc.commitment || 'confirmed',
        disableRetryOnRateLimit: false,
        fetch: fetchImpl,
      }),
    ];
    this.rpcChain = chain;
    this.fastSend = rpc.fastSendEndpoints();
    this._tipCache = null;       // { accounts, at } — Jito's current tip accounts
    this._lastTipAccount = null; // the one this transaction actually paid
    this.rr = 0;
    if (chain.length > 1) log.info(`RPC chain: ${chain.length} endpoint(s) — failing over per call on timeout or 429`);
    if (this.fastSend.length) log.info(`Fast-send lanes enabled: ${this.fastSend.length} extra submission endpoint(s)`);
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

  /**
   * One Jito tip account, from Jito itself.
   *
   * Returns null (never throws) if Jito cannot be reached. The caller must treat
   * null as "no tip" and NOT substitute a guess: a wrong tip address is lost SOL.
   */
  async jitoTipAccount() {
    const now = Date.now();
    if (this._tipCache && now - this._tipCache.at < JITO_TIP_CACHE_MS && this._tipCache.accounts.length) {
      return this._tipCache.accounts[Math.floor(Math.random() * this._tipCache.accounts.length)];
    }
    try {
      const res = await fetch(`${this.config.jito.blockEngineUrl}/api/v1/bundles`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTipAccounts', params: [] }),
        signal: AbortSignal.timeout(3000),
      });
      const j = await res.json();
      if (!Array.isArray(j.result) || !j.result.length) throw new Error('no tip accounts returned');
      this._tipCache = { accounts: j.result, at: now };
      return j.result[Math.floor(Math.random() * j.result.length)];
    } catch (err) {
      log.warn(`Could not fetch Jito tip accounts (${err.message}) — sending without a tip rather than guessing an address`);
      return null;
    }
  }

  /** Does this transaction already set a priority fee? Two such instructions are rejected. */
  _hasPriorityFee(tx) {
    const CB = ComputeBudgetProgram.programId.toBase58();
    const SET_PRICE = 3; // ComputeBudgetInstruction discriminant
    const check = (ix) => ix.programId.toBase58() === CB && ix.data[0] === SET_PRICE;
    if (tx instanceof Transaction) return tx.instructions.some(check);
    try {
      const msg = TransactionMessage.decompile(tx.message);
      return msg.instructions.some(check);
    } catch {
      return false;
    }
  }

  /**
   * Add the priority fee and the Jito tip to an UNSIGNED transaction.
   *
   * Must run before signing: adding an instruction afterwards invalidates the
   * signature. Handles both shapes — a legacy Transaction from our own builder, and
   * the versioned transaction PumpPortal returns — since the tip is worthless in a
   * transaction we cannot put it into.
   */
  async prepareForFastLane(tx, payer) {
    const extra = [];
    if (!this._hasPriorityFee(tx)) {
      extra.push(ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Number(process.env.PRIORITY_FEE_MICROLAMPORTS || 5_000_000),
      }));
    }

    let tipAccount = null;
    if (this.config.jito.enabled) {
      tipAccount = await this.jitoTipAccount();
      if (tipAccount) {
        extra.push(SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: new PublicKey(tipAccount),
          lamports: Number(this.config.jito.tipLamports || 1_000_000),
        }));
      } else {
        // No tip means no bundle worth sending: fall back to a plain broadcast,
        // which is what the caller does when tipAccount is null.
        log.warn('Jito is enabled but no tip account is known — this trade will be broadcast without Jito');
      }
    }
    this._lastTipAccount = tipAccount;

    if (!extra.length) return tx;
    if (tx instanceof Transaction) {
      tx.add(...extra);
      return tx;
    }

    // Versioned: decompile (resolving any lookup tables), add, recompile.
    const tables = [];
    for (const lookup of tx.message.addressTableLookups) {
      const res = await this.conn().getAddressLookupTable(lookup.accountKey);
      if (res.value) tables.push(res.value);
    }
    const msg = TransactionMessage.decompile(tx.message, { addressLookupTableAccounts: tables });
    msg.instructions.push(...extra);
    return new VersionedTransaction(msg.compileToV0Message(tables));
  }

  /** Submit a signed transaction through one Jito bundle. Returns the bundle id. */
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

  /**
   * Broadcast a SIGNED transaction through every available channel at once.
   *
   * They race. A sniped entry competes for the same slot as everyone else's, so
   * whichever lands first wins and the rest are simply wasted effort — trying them
   * one after another would add the latency of the failures to every trade. The RPC
   * is always one of the channels; a Jito bundle and any FAST_SEND_URLS lanes are
   * added when configured.
   */
  async broadcast(signedTx, walletId) {
    const raw = signedTx.serialize();
    const b64 = Buffer.from(raw).toString('base64');
    const channels = [['rpc', () => this.conn().sendRawTransaction(raw, {
      skipPreflight: true,
      maxRetries: this.config.execution.maxRetries,
    })]];

    if (this.config.jito.enabled && this._lastTipAccount) {
      channels.push(['jito', () => this.sendJito(signedTx)]);
    }
    rpc.fastSendEndpoints().forEach((url, i) => {
      channels.push([`lane${i + 1}`, () => rpc.sendViaJsonRpc(url, b64, `lane ${i + 1}`)]);
    });

    const results = await Promise.allSettled(channels.map(([, run]) => run()));
    const failures = [];
    let winner = null;
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && !winner) winner = { channel: channels[i][0], value: r.value };
      else if (r.status === 'rejected') failures.push(`${channels[i][0]}: ${r.reason && r.reason.message}`);
    });

    if (!winner) throw new Error(`every submission channel failed — ${failures.join(' | ')}`);

    // A Jito bundle id is not a transaction signature, so if Jito won the race we
    // still need the RPC's signature to confirm the fill. The RPC channel therefore
    // has to be reported when it succeeded, whatever else came back first.
    if (winner.channel !== 'rpc') {
      const rpcIdx = channels.findIndex(([n]) => n === 'rpc');
      const rpcResult = results[rpcIdx];
      if (rpcResult.status === 'fulfilled') {
        log.info(`${winner.channel} accepted first (${String(winner.value).slice(0, 12)}…) — confirming via the RPC signature`, { wallet: walletId });
        return rpcResult.value;
      }
      // Only Jito answered: its bundle id goes back and confirmation will fall
      // through to the normal timeout path, which reports honestly rather than
      // pretending the fill is confirmed.
      log.warn(`Only ${winner.channel} accepted the transaction; no RPC signature to confirm against`, { wallet: walletId });
      return winner.value;
    }
    return winner.value;
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
      // web3.js declares sign(...signers). Passing an Array makes signers[0] an
      // Array, and it reads .publicKey off it — hence "Cannot read properties of
      // undefined (reading 'toString')" on EVERY signed transfer, withdrawals
      // included. The keypair goes in directly.
      tx.sign(kp);

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
  /**
   * Verify that a wallet-signed funding transaction does exactly what we asked.
   *
   * The rule is NOT "exactly one instruction" — real wallets append ComputeBudget
   * instructions, and demanding an exact byte-for-byte echo of what we built
   * rejects honest transfers. The rule that actually matters is "no instruction
   * can move the user's funds anywhere except the destination we named", so:
   *
   *   · exactly one System transfer, with from, to and lamports matching exactly
   *   · the fee payer is the funding wallet
   *   · ComputeBudget and Memo are tolerated — neither can move funds
   *   · every other program is refused BY NAME, so the failure is diagnosable
   *
   * Accepts legacy and versioned transactions.
   */
  assertTransferMatches(txBase64, intent) {
    const SYSTEM = '11111111111111111111111111111111';
    const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
    const MEMO_V1 = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
    const MEMO_V2 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
    const TOLERATED = new Set([COMPUTE_BUDGET, MEMO_V1, MEMO_V2]);

    const bytes = Buffer.from(String(txBase64 || ''), 'base64');
    if (!bytes.length) throw new Error('no transaction bytes');

    // Normalise legacy and versioned transactions to one shape, so the checks
    // below read the same either way. A wallet is free to return whichever it
    // prefers; both are legitimate.
    let feePayer = null;
    let instructions = [];
    try {
      const tx = Transaction.from(bytes);
      feePayer = tx.feePayer ? tx.feePayer.toBase58() : null;
      instructions = tx.instructions.map((ix) => ({
        programId: ix.programId.toBase58(),
        keys: ix.keys.map((k) => k.pubkey.toBase58()),
        data: Buffer.from(ix.data),
      }));
    } catch (legacyErr) {
      let vtx;
      try {
        vtx = VersionedTransaction.deserialize(bytes);
      } catch {
        throw new Error(`unreadable transaction bytes (${legacyErr.message})`);
      }
      const msg = vtx.message;
      if (msg.addressTableLookups && msg.addressTableLookups.length) {
        throw new Error('transaction uses address lookup tables, which this endpoint will not relay');
      }
      const keys = msg.staticAccountKeys.map((k) => k.toBase58());
      feePayer = keys[0] || null;
      instructions = msg.compiledInstructions.map((ci) => ({
        programId: keys[ci.programIdIndex],
        keys: ci.accountKeyIndexes.map((idx) => keys[idx]),
        data: Buffer.from(ci.data),
      }));
    }

    if (!instructions.length) throw new Error('the signed transaction has no instructions');
    if (feePayer !== intent.from) throw new Error(`fee payer mismatch (${feePayer || 'none'})`);

    const transfers = [];
    const foreign = [];
    for (const ix of instructions) {
      if (ix.programId === SYSTEM) {
        // System instruction 2 is Transfer: u32 tag + u64 lamports.
        if (ix.data.length === 12 && ix.data.readUInt32LE(0) === 2) transfers.push(ix);
        else throw new Error(`system instruction ${ix.data.length ? ix.data.readUInt32LE(0) : '?'} is not a plain transfer`);
        continue;
      }
      if (!TOLERATED.has(ix.programId)) foreign.push(ix.programId);
    }

    if (foreign.length) {
      const named = [...new Set(foreign)].join(', ');
      throw new Error(`unexpected program(s) in the transaction: ${named}`);
    }
    if (transfers.length !== 1) {
      throw new Error(`expected exactly one transfer, found ${transfers.length}`);
    }

    const t = transfers[0];
    const lamports = t.data.readBigUInt64LE(4);
    if (t.keys[0] !== intent.from) throw new Error('source mismatch');
    if (t.keys[1] !== intent.to) throw new Error('destination mismatch');
    if (lamports !== BigInt(intent.lamports)) {
      throw new Error(`amount mismatch (asked ${intent.lamports} lamports, signed ${lamports})`);
    }
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

        // The priority fee and (if Jito is on) the tip go in BEFORE signing — an
        // instruction added afterwards would invalidate the signature. This is also
        // what made "Jito enabled" a lie before: the bundle carried no tip, so it
        // was never competitive enough to land.
        const prepared = await this.prepareForFastLane(tx, kp.publicKey);

        // web3.js declares sign(...signers). Passing an Array makes signers[0] an
        // Array, and it reads .publicKey off it — hence "Cannot read properties of
        // undefined (reading 'toString')" on EVERY signed transfer, withdrawals
        // included. The keypair goes in directly.
        if (prepared instanceof Transaction) prepared.sign(kp);
        else prepared.sign([kp]);

        // Race every submission channel and take the first signature back. A dead
        // RPC then costs one failed attempt in parallel rather than the whole trade.
        const signature = await this.broadcast(prepared, walletId);

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

}

module.exports = Executor;
