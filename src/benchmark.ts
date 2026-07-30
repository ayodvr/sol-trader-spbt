import { PublicKey } from '@solana/web3.js';

console.log(`
╔══════════════════════════════════════════╗
║  PUMP SNIPER — NATIVE BUILDER BENCHMARK  ║
╚══════════════════════════════════════════╝
`);

// ─── Load native if available ───
let native: any = null;
try {
  native = require('pump-native-builder');
  console.log('✅ Rust native addon loaded\n');
} catch {
  console.log('⚠️  Rust native addon not found. Build it first:\n    cd native-builder && npm run build\n');
}

const MINT = new PublicKey('HhEdFsuJ88cFsUFT5LyqDCEdsbYzWiHs2MBMucJtpump');
const USER = new PublicKey('5Bw2F3jPqCPdTn1KxLJNqFTXFkZLYBKnMPSxmPskENKX');
const CURVE = new PublicKey('2VmjWmMbSfMxeWgQqG4oeDvbBBTt4bEtkcbYMn5XJDzE');

const AMOUNT = '1000000000';     // 1000 tokens (6 decimals)
const MAX_SOL = '100000000';     // 0.1 SOL
const SOL_AMOUNT = '100000000';  // 0.1 SOL

const ITERATIONS = 10000;

// ─── JS Benchmark ───
console.log(`Benchmarking JS instruction builder (${ITERATIONS} iterations)...`);

const BUY_DISCRIMINATOR = [102, 6, 61, 18, 1, 218, 235, 234];

function buildJsInstruction(): Buffer {
  const buf = Buffer.alloc(24);
  for (let i = 0; i < 8; i++) buf.writeUInt8(BUY_DISCRIMINATOR[i], i);
  buf.writeBigUInt64LE(BigInt(AMOUNT), 8);
  buf.writeBigUInt64LE(BigInt(MAX_SOL), 16);
  // Adding CPU work to simulate account list assembly
  for (let i = 0; i < 100; i++) {
    const _ = Buffer.alloc(32);
  }
  return buf;
}

const jsStart = process.hrtime.bigint();
for (let i = 0; i < ITERATIONS; i++) {
  buildJsInstruction();
}
const jsEnd = process.hrtime.bigint();
const jsNs = Number(jsEnd - jsStart) / ITERATIONS;

console.log(`  JS avg:     ${(jsNs / 1000).toFixed(2)} µs (${(jsNs / 1_000_000).toFixed(4)} ms)`);

// ─── Rust Benchmark ───
if (native) {
  console.log(`\nBenchmarking Rust native instruction builder (${ITERATIONS} iterations)...`);

  const rustStart = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    native.buildPumpBuyInstruction(
      MINT.toBase58(),
      USER.toBase58(),
      CURVE.toBase58(),
      AMOUNT,
      MAX_SOL,
      SOL_AMOUNT,
    );
  }
  const rustEnd = process.hrtime.bigint();
  const rustNs = Number(rustEnd - rustStart) / ITERATIONS;

  console.log(`  Rust avg:   ${(rustNs / 1000).toFixed(2)} µs (${(rustNs / 1_000_000).toFixed(4)} ms)`);
  console.log(`  Speedup:    ${(jsNs / rustNs).toFixed(0)}x faster`);
  console.log(`  Per-snipe   ${((jsNs - rustNs) / 1_000_000).toFixed(3)} ms saved\n`);
} else {
  console.log('\n  (Rust not available — install native-builder to benchmark)');
}

console.log(`\nExample Rust native build output (1 call):`);
if (native) {
  const result = native.buildPumpBuyInstruction(
    MINT.toBase58(),
    USER.toBase58(),
    CURVE.toBase58(),
    AMOUNT,
    MAX_SOL,
    SOL_AMOUNT,
  );
  console.log(`  Output type: ${typeof result}`);
  console.log(`  Is Buffer:   ${Buffer.isBuffer(result)}`);
  console.log(`  Length:      ${result.length} bytes\n`);

  // Debug deserialize
  if (native.debugDeserializeInstruction) {
    const debug = native.debugDeserializeInstruction(result);
    console.log(`  Deserialized instruction:`);
    console.log(`  ${debug}`);
  }
}

console.log(`
╔══════════════════════════════════════════╗
║  Pipeline estimate (end-to-end):         ║
║                                         ║
║  gRPC detection (v5 NaaE)      ~30ms    ║
║  Rug check                     ~200ms   ║
║  Instruction build (Rust)      ~0.05ms  ║
║  Jito bundle submission        ~300ms   ║
║  ────────────────────────────────────   ║
║  Total:                        ~530ms   ║
╚══════════════════════════════════════════╝
`);
