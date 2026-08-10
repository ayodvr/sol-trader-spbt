// scripts/inspect-curve.ts
// Dump a live pump.fun bonding curve account and locate its real field offsets empirically.
//
// The codebase reads virtualTokenReserves@64 / virtualSolReserves@72 / complete@88 and the
// creator at 32-64. Those offsets have never been verified against a real account — the
// bonding-curve track never ran until now, and before the DataView byteOffset fix every read
// was garbage anyway, so nothing ever contradicted them. Symptoms now point at them being
// wrong: prices that never move (so no exit ever triggers) and creator addresses that decode
// with long runs of leading zeros ("1111111113fGWZbwwxFB..."), which is what you get from
// reading numeric fields as a pubkey.
//
// Usage: npx tsx scripts/inspect-curve.ts <mint-address>

import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { deriveBondingCurve } from '../src/utils.js';

const mintArg = process.argv[2];
if (!mintArg) {
  console.error('usage: npx tsx scripts/inspect-curve.ts <mint-address>');
  process.exit(1);
}

const conn = new Connection(CONFIG.RPC_URL, 'confirmed');
const mint = new PublicKey(mintArg);
const curve = deriveBondingCurve(mint);

const acc = await conn.getAccountInfo(curve, 'processed');
if (!acc) {
  console.error('Bonding curve account not found for', mint.toBase58());
  console.error('(token may have graduated and had its curve closed)');
  process.exit(1);
}

const d = acc.data;
console.log('mint          :', mint.toBase58());
console.log('bonding curve :', curve.toBase58());
console.log('owner         :', acc.owner.toBase58());
console.log('data length   :', d.length, 'bytes');
console.log('discriminator :', d.subarray(0, 8).toString('hex'));
console.log('');
console.log('raw hex:');
console.log(d.toString('hex'));
console.log('');

const view = new DataView(d.buffer, d.byteOffset, d.byteLength);

// A fresh pump.fun curve holds ~1.073e15 token units and ~3.0e10 lamports of virtual SOL.
// Scan every byte offset and surface u64s in a plausible range so the true field positions
// stand out instead of being assumed.
console.log('u64 reads by offset (plausible magnitudes only):');
for (let off = 0; off + 8 <= d.length; off++) {
  const v = view.getBigUint64(off, true);
  if (v > 1_000_000n && v < 100_000_000_000_000_000n) {
    let hint = '';
    if (v > 100_000_000_000_000n) hint = '  <-- token-reserve magnitude (~1e15)';
    else if (v > 1_000_000_000n && v < 1_000_000_000_000n) hint = '  <-- SOL-reserve magnitude (~3e10 lamports)';
    console.log(`  offset ${String(off).padStart(3)}: ${String(v).padStart(20)}${hint}`);
  }
}

console.log('');
console.log('candidate creator pubkeys (32-byte windows, base58):');
for (const off of [32, 48, 49, 81, d.length - 32]) {
  if (off < 0 || off + 32 > d.length) continue;
  try {
    console.log(`  offset ${String(off).padStart(3)}: ${new PublicKey(d.subarray(off, off + 32)).toBase58()}`);
  } catch { /* not a valid pubkey window */ }
}

console.log('');
console.log('byte values at candidate `complete` flags:');
for (const off of [48, 88, 108]) {
  if (off < d.length) console.log(`  offset ${String(off).padStart(3)}: ${d[off]}`);
}
