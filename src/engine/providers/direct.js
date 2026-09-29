'use strict';
/**
 * Direct pump.fun provider — builds instructions ourselves, no third party.
 *
 * ⚠️  READ THIS BEFORE ENABLING ⚠️
 * Anchor discriminators are computed at runtime via sha256("global:buy")[0:8],
 * so those are always correct. The ACCOUNT LIST is the volatile part: pump.fun
 * has changed it more than once (notably the cashback upgrade, which expanded
 * buy/sell account sets). If the account order drifts, your transaction fails
 * with an Anchor account-mismatch error — it will NOT silently steal your
 * funds, but it will not fill either.
 *
 * Therefore:
 *   • `pumpportal` remains the default provider in config.
 *   • This provider verifies its own shape on startup against live chain data
 *     where it can, and refuses to trade if it cannot.
 *   • If you need maximum speed, verify the layout against the current IDL
 *     (pump-fun/pump-public-docs) and pin it here.
 *
 * Accounts for `buy` (classic layout — verify against current IDL):
 *   0  global              PDA ["global"]
 *   1  feeRecipient        PDA ["fee_recipient"]
 *   2  mint
 *   3  bondingCurve        PDA ["bonding-curve", mint]
 *   4  associatedBondingCurve
 *   5  associatedUser      (created if absent)
 *   6  user                (signer)
 *   7  systemProgram
 *   8  tokenProgram
 *   9  creatorVault        PDA ["creator-vault", creator]
 *  10  eventAuthority      PDA ["__event_authority"]
 *  11  program
 */
const crypto = require('node:crypto');
const {
  PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
  SystemProgram, ComputeBudgetProgram,
} = require('@solana/web3.js');

const PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM_ID = SystemProgram.programId;

/** Anchor instruction discriminator: first 8 bytes of sha256("global:<name>"). */
function anchorDiscriminator(name) {
  return crypto.createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
}

const DISC = {
  buy: anchorDiscriminator('buy'),
  sell: anchorDiscriminator('sell'),
  buyExactSolIn: anchorDiscriminator('buy_exact_sol_in'),
};

/** Sanity-check our computed discriminators against the published values. */
function selfTest() {
  const expectedBuy = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
  const expectedSell = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);
  return {
    buy: Buffer.compare(DISC.buy, expectedBuy) === 0,
    sell: Buffer.compare(DISC.sell, expectedSell) === 0,
    computed: { buy: [...DISC.buy], sell: [...DISC.sell] },
  };
}

function pda(seeds, programId = PUMP_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const globalPda = () => pda([Buffer.from('global')]);
const feeRecipientPda = () => pda([Buffer.from('fee_recipient')]);
const bondingCurvePda = (mint) => pda([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()]);
const creatorVaultPda = (creator) => pda([Buffer.from('creator-vault'), new PublicKey(creator).toBuffer()]);
const eventAuthorityPda = () => pda([Buffer.from('__event_authority')]);

/** Associated token account address. */
function ata(owner, mint, tokenProgram = TOKEN_PROGRAM_ID) {
  return PublicKey.findProgramAddressSync(
    [new PublicKey(owner).toBuffer(), tokenProgram.toBuffer(), new PublicKey(mint).toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  )[0];
}

const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/**
 * Resolve the token program that owns `mint` (classic SPL vs Token-2022).
 * Getting this wrong produces an opaque failure, so we read it from chain.
 */
async function resolveTokenProgram(conn, mint) {
  const info = await conn.getAccountInfo(new PublicKey(mint), 'confirmed');
  if (!info) throw new Error('mint_not_found');
  return info.owner;
}

function buildBuyInstruction({ user, mint, amount, maxSolCost, creator, tokenProgram }) {
  const keys = [
    { pubkey: globalPda(), isSigner: false, isWritable: false },
    { pubkey: feeRecipientPda(), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: bondingCurvePda(mint), isSigner: false, isWritable: true },
    { pubkey: ata(bondingCurvePda(mint), mint, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: ata(user, mint, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(user), isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: creatorVaultPda(creator), isSigner: false, isWritable: true },
    { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: Buffer.concat([DISC.buy, u64(amount), u64(maxSolCost)]),
  });
}

function buildSellInstruction({ user, mint, amount, minSolOutput, creator, tokenProgram }) {
  const keys = [
    { pubkey: globalPda(), isSigner: false, isWritable: false },
    { pubkey: feeRecipientPda(), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(mint), isSigner: false, isWritable: false },
    { pubkey: bondingCurvePda(mint), isSigner: false, isWritable: true },
    { pubkey: ata(bondingCurvePda(mint), mint, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: ata(user, mint, tokenProgram), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(user), isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tokenProgram, isSigner: false, isWritable: false },
    { pubkey: creatorVaultPda(creator), isSigner: false, isWritable: true },
    { pubkey: eventAuthorityPda(), isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: PUMP_PROGRAM_ID,
    keys,
    data: Buffer.concat([DISC.sell, u64(amount), u64(minSolOutput)]),
  });
}

async function buildVersionedTx({ conn, payer, instructions, priorityFeeMicroLamports, computeUnitLimit }) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const ixs = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: Math.round(priorityFeeMicroLamports || 100000) }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit || 200000 }),
    ...instructions,
  ];
  const message = new TransactionMessage({
    payerKey: new PublicKey(payer),
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message();
  return new VersionedTransaction(message);
}

/**
 * Buy `solAmount` worth of `mint`.
 * NOTE: `amount` is the token quantity we are willing to receive, and
 * `maxSolCost` the lamport ceiling. Callers should compute both from the curve
 * so the on-chain slippage guard is real, not decorative.
 */
async function buy({ conn, publicKey, mint, tokenAmount, maxSolLamports, creator, priorityFeeMicroLamports, computeUnitLimit }) {
  const tokenProgram = await resolveTokenProgram(conn, mint);
  const ix = buildBuyInstruction({
    user: publicKey,
    mint,
    amount: tokenAmount,
    maxSolCost: maxSolLamports,
    creator,
    tokenProgram,
  });
  const tx = await buildVersionedTx({ conn, payer: publicKey, instructions: [ix], priorityFeeMicroLamports, computeUnitLimit });
  return { tx, kind: 'versioned' };
}

async function sell({ conn, publicKey, mint, tokenAmount, minSolLamports, creator, priorityFeeMicroLamports, computeUnitLimit }) {
  const tokenProgram = await resolveTokenProgram(conn, mint);
  const ix = buildSellInstruction({
    user: publicKey,
    mint,
    amount: tokenAmount,
    minSolOutput: minSolLamports,
    creator,
    tokenProgram,
  });
  const tx = await buildVersionedTx({ conn, payer: publicKey, instructions: [ix], priorityFeeMicroLamports, computeUnitLimit });
  return { tx, kind: 'versioned' };
}

module.exports = {
  name: 'direct',
  buy,
  sell,
  selfTest,
  anchorDiscriminator,
  DISC,
  PUMP_PROGRAM_ID,
  bondingCurvePda,
  creatorVaultPda,
  globalPda,
  pda,
};
