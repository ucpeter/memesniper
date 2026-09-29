'use strict';
/**
 * Offline keypair generator.
 *
 * Generates a Solana keypair WITHOUT touching the network or the bot's
 * keystore — useful for creating hot wallets you fund separately.
 *
 * By default it prints only the PUBLIC key. Pass --show-secret to print the
 * secret key too, and treat that output like cash.
 */
const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58');

const showSecret = process.argv.includes('--show-secret');
const kp = Keypair.generate();

console.log('');
console.log('  Public key :', kp.publicKey.toBase58());
if (showSecret) {
  const enc = bs58.default ? bs58.default.encode(kp.secretKey) : bs58.encode(kp.secretKey);
  console.log('  Secret key :', enc);
  console.log('  JSON array :', JSON.stringify(Array.from(kp.secretKey)));
  console.log('');
  console.log('  ⚠  Anyone with the above can take every asset in this wallet.');
  console.log('     Import it into the bot, then clear your terminal history.');
} else {
  console.log('  Secret key : hidden — re-run with --show-secret to print it');
}
console.log('');
