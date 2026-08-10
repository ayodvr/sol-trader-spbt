// scripts/inspect-pool.ts
// Dump a live PumpSwap AMM pool account and verify where its fields actually live.
//
// pumpswap.ts reads baseReserves@107 and quoteReserves@115 directly out of the Pool account.
// That is the same class of assumption that turned out wrong for the bonding curve, and it
// looks suspect: PumpSwap's Pool struct is a run of pubkeys (creator@11, baseMint@43,
// quoteMint@75, lpMint@107, poolBaseTokenAccount@139, poolQuoteTokenAccount@171), so offset
// 107 would sit inside lpMint rather than on a reserve number. Reserves on a PumpSwap pool are
// normally the SPL balances of the two pool token accounts, not fields on the pool itself.
//
// This prints the raw account, flags any u64 of plausible reserve magnitude, decodes the pubkey
// windows, and then fetches the real token-account balances so the two can be compared.
//
// Usage: npx tsx scripts/inspect-pool.ts <pool-address>

import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config.js';

const poolArg = process.argv[2];
if (!poolArg) {
  console.error('usage: npx tsx scripts/inspect-pool.ts <pool-address>');
  process.exit(1);
}

const conn = new Connection(CONFIG.RPC_URL, 'confirmed');
const pool = new PublicKey(poolArg);

const acc = await conn.getAccountInfo(pool, 'processed');
if (!acc) {
  console.error('Pool account not found:', pool.toBase58());
  process.exit(1);
}

const d = acc.data;
console.log('pool         :', pool.toBase58());
console.log('owner        :', acc.owner.toBase58());
console.log('data length  :', d.length, 'bytes');
console.log('discriminator:', d.subarray(0, 8).toString('hex'));
console.log('');

const view = new DataView(d.buffer, d.byteOffset, d.byteLength);

console.log('u64 reads by offset (plausible magnitudes only):');
for (let off = 0; off + 8 <= d.length; off++) {
  const v = view.getBigUint64(off, true);
  if (v > 1_000_000n && v < 100_000_000_000_000_000n) {
    console.log(`  offset ${String(off).padStart(3)}: ${String(v).padStart(22)}`);
  }
}

console.log('');
console.log('pubkey windows at documented Pool field offsets:');
const fields: Array<[number, string]> = [
  [11, 'creator'],
  [43, 'baseMint'],
  [75, 'quoteMint'],
  [107, 'lpMint (code reads baseReserves here!)'],
  [139, 'poolBaseTokenAccount'],
  [171, 'poolQuoteTokenAccount'],
  [211, 'coinCreator'],
];
for (const [off, name] of fields) {
  if (off + 32 > d.length) continue;
  try {
    console.log(`  ${String(off).padStart(3)} ${name.padEnd(40)}: ${new PublicKey(d.subarray(off, off + 32)).toBase58()}`);
  } catch { /* not a valid pubkey window */ }
}

// The authoritative reserves: actual SPL balances of the pool's two token accounts.
console.log('');
console.log('actual token-account balances (the real reserves):');
for (const [off, name] of [[139, 'base'], [171, 'quote']] as Array<[number, string]>) {
  if (off + 32 > d.length) continue;
  try {
    const ata = new PublicKey(d.subarray(off, off + 32));
    const bal = await conn.getTokenAccountBalance(ata);
    console.log(`  ${name.padEnd(6)} ${ata.toBase58()} = ${bal.value.amount} (decimals ${bal.value.decimals})`);
  } catch (err: any) {
    console.log(`  ${name.padEnd(6)} could not read: ${err.message}`);
  }
}

console.log('');
console.log('what the code currently computes:');
if (d.length >= 123) {
  console.log('  baseReserves @107 =', view.getBigUint64(107, true).toString());
  console.log('  quoteReserves@115 =', view.getBigUint64(115, true).toString());
  console.log('  (compare against the real balances above — if they disagree, pumpswap.ts is wrong)');
}
