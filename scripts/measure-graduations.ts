// scripts/measure-graduations.ts
//
// Do pump.fun graduations behave differently from launches?
//
// ── Why this is a different question ─────────────────────────────────────────────────────────
// Four measurements established that buying new launches has no edge at any speed, with any exit
// rule, with or without survival filtering. Every filter tried so far was a heuristic: an anti-rug
// score, a holder-concentration threshold, a five-minute survival check. All of them were guesses
// about which token would do well.
//
// Graduation is not a guess. A token graduates when its bonding curve completes — roughly 85 SOL
// of real money committed by other people — and liquidity migrates to PumpSwap. That is demand
// demonstrated with capital rather than inferred from a metric.
//
// It is also a genuinely different population. ZERO of the 218 tokens in the survivor test
// graduated within their 10-minute window; graduation takes hours. Everything measured so far has
// been about the ~99% that die. This is about the fraction that don't.
//
// And it does not require winning a latency race, so no Jito tip is needed — which drops the
// round-trip cost from ~5% to ~2% and lowers the bar any edge has to clear.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Median forward return from the moment of graduation, at the best horizon tested:
//   > +2%       clears the no-race round-trip cost. Worth building.
//   0% to +2%   real but eaten by fees. Not worth it.
//   <= 0%       graduations are just as dead as launches. Close the book for good.
// The script prints the verdict itself.
//
// ── How graduation is detected ───────────────────────────────────────────────────────────────
// By WATCHING FOR NEW POOL ACCOUNTS, not by decoding a migrate instruction. This project has been
// burned repeatedly by guessed instruction discriminators (the CREATE discriminator silently
// changed; bonding curve reserves were read from the middle of a pubkey for months). The PumpSwap
// Pool account layout, by contrast, was verified byte-for-byte against a live mainnet account with
// scripts/inspect-pool.ts: 301 bytes, baseMint@43, poolBaseTokenAccount@139,
// poolQuoteTokenAccount@171. A pool account appearing where none existed IS a graduation.
//
// Reserves are the SPL balances of those two token accounts — NOT fields on the pool account.
// Reading them off the pool at offsets 107/115 lands inside lpMint and is exactly the bug that
// left the AMM track disabled.
//
// Usage:
//   npx tsx scripts/measure-graduations.ts --hours 6     # collect
//   npx tsx scripts/measure-graduations.ts --analyze     # verdict

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { CONFIG } from '../config.js';

const OUT_FILE = './data/graduations.jsonl';
const MAX_CONCURRENT = 40;
// Graduation is a slow event, so sample coarsely and over a long horizon. Dense early sampling
// bought nothing in the latency test — price barely moves second to second.
const SAMPLE_OFFSETS_MS = [
  0, 30_000, 60_000, 120_000, 180_000, 300_000,
  600_000, 900_000, 1_200_000, 1_800_000, 2_700_000, 3_600_000,
];
const WARMUP_MS = 60_000; // pools seen in this window are pre-existing, not fresh graduations

interface Sample {
  pool: string;
  mint: string;
  gradAt: number;
  offsetMs: number;
  price: number;
  baseReserve: string;
  quoteReserve: string;
}

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? '') : null; };

if (argv.includes('--analyze')) analyze();
else collect(parseFloat(argOf('hours') || '6'));

function toBase58(v: any): string | null {
  try {
    if (!v) return null;
    if (typeof v === 'string') return v;
    if (v.pubkey) return toBase58(v.pubkey);
    return new PublicKey(Buffer.from(v)).toBase58();
  } catch { return null; }
}

// ── Collection ───────────────────────────────────────────────────────────────────────────────
async function collect(hours: number) {
  const connection = new Connection(CONFIG.RPC_URL, 'processed');
  fs.mkdirSync('./data', { recursive: true });

  const seen = new Set<string>();
  let observing = 0, graduations = 0;
  const startedAt = Date.now();
  const deadline = startedAt + hours * 3_600_000;

  /** Reserves are the SPL balances of the pool's two token accounts. amount is a u64 at offset 64. */
  async function readReserves(base: PublicKey, quote: PublicKey) {
    const accs = await connection.getMultipleAccountsInfo([base, quote], 'processed');
    if (!accs[0] || !accs[1] || accs[0].data.length < 72 || accs[1].data.length < 72) return null;
    const readAmount = (d: Buffer) =>
      new DataView(d.buffer, d.byteOffset, d.byteLength).getBigUint64(64, true);
    const baseAmt = readAmount(accs[0].data);
    const quoteAmt = readAmount(accs[1].data);
    if (baseAmt === 0n) return null;
    return { baseAmt, quoteAmt, price: Number(quoteAmt * 1_000_000_000n / baseAmt) };
  }

  async function observe(pool: string, mint: string, base: PublicKey, quote: PublicKey, gradAt: number) {
    observing++;
    for (const offsetMs of SAMPLE_OFFSETS_MS) {
      const wait = gradAt + offsetMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      try {
        const r = await readReserves(base, quote);
        if (r) {
          // Append per sample, never buffered. The survivor test was killed before any token
          // finished its window and wrote zero bytes despite thousands of samples collected.
          fs.appendFileSync(OUT_FILE, JSON.stringify({
            pool, mint, gradAt, offsetMs,
            price: r.price,
            baseReserve: r.baseAmt.toString(),
            quoteReserve: r.quoteAmt.toString(),
          } as Sample) + '\n');
        }
      } catch { /* transient RPC failure — skip this sample, keep the schedule */ }
    }
    observing--;
  }

  const grpcMod = await import('@triton-one/yellowstone-grpc');
  const GrpcClient: any = (grpcMod as any).default;
  const client = new GrpcClient(
    process.env.GRPC_ENDPOINT || '',
    CONFIG.GRPC_TOKEN,
    { 'grpc.max_receive_message_length': 128 * 1024 * 1024, 'grpc.keepalive_time_ms': 10_000 },
  );
  await client.connect();
  const stream = await client.subscribe();

  stream.on('data', (data: any) => {
    const upd = data?.account;
    if (!upd) return;
    // Yellowstone flags snapshot rows as isStartup. Skip them AND anything in the warm-up window:
    // both are pre-existing pools, not graduations happening now.
    if (upd.isStartup) return;
    const acc = upd.account;
    const pool = toBase58(acc?.pubkey);
    const raw = acc?.data;
    if (!pool || !raw) return;
    const d = Buffer.from(raw);
    if (d.length !== 301) return; // verified Pool size; anything else is not a pool
    if (seen.has(pool)) return;
    seen.add(pool);
    if (Date.now() - startedAt < WARMUP_MS || Date.now() > deadline) return;
    if (observing >= MAX_CONCURRENT) return;

    const mint = toBase58(d.subarray(43, 75));
    const baseAta = toBase58(d.subarray(139, 171));
    const quoteAta = toBase58(d.subarray(171, 203));
    if (!mint || !baseAta || !quoteAta) return;

    graduations++;
    console.log(`  🎓 graduation #${graduations}: ${mint} (pool ${pool.slice(0, 8)}…)`);
    observe(pool, mint, new PublicKey(baseAta), new PublicKey(quoteAta), Date.now())
      .catch(() => { observing--; });
  });
  stream.on('error', (e: any) => console.error('stream error:', e?.message));

  stream.write({
    slots: {},
    accounts: {
      pumpswap_pools: {
        account: [],
        owner: [CONFIG.PUMP_AMM_PROGRAM_ID.toBase58()],
        // Bandwidth optimisation only — the 301-byte check above is what actually guarantees
        // correctness, in case this filter field is named differently in another server version.
        filters: [{ datasize: '301' }],
      },
    },
    transactions: {},
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: 0,
  });

  console.log(`Collecting graduations for ${hours}h into ${OUT_FILE}`);
  console.log(`(${WARMUP_MS / 1000}s warm-up to skip pre-existing pools, then each new pool followed for 60 minutes)\n`);
  await new Promise(r => setTimeout(r, hours * 3_600_000 + 3_600_000));
  console.log(`\nDone. ${graduations} graduations captured.`);
  process.exit(0);
}

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────
function analyze() {
  if (!fs.existsSync(OUT_FILE)) { console.error(`No ${OUT_FILE} — run collection first.`); process.exit(1); }

  const paths = new Map<string, Sample[]>();
  for (const line of fs.readFileSync(OUT_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let s: Sample;
    try { s = JSON.parse(line); } catch { continue; }
    if (!s?.pool || !isFinite(s.price) || s.price <= 0) continue;
    const key = `${s.pool}:${s.gradAt}`;
    const arr = paths.get(key);
    if (arr) arr.push(s); else paths.set(key, [s]);
  }
  for (const a of paths.values()) a.sort((x, y) => x.offsetMs - y.offsetMs);

  const usable = [...paths.values()].filter(a => a.length >= 2);
  console.log(`graduations captured: ${paths.size}  (usable paths: ${usable.length})`);
  console.log('');

  const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const at = (p: Sample[], ms: number) => p.find(s => s.offsetMs >= ms) || null;

  const horizons = [60_000, 300_000, 900_000, 1_800_000, 3_600_000];
  const rows = horizons.map(h => {
    const rets: number[] = [];
    for (const p of usable) {
      const p0 = p[0], ph = at(p, h);
      if (p0 && ph && ph.offsetMs > 0) rets.push((ph.price - p0.price) / p0.price * 100);
    }
    return {
      horizon: h >= 60_000 ? `${h / 60_000}m` : `${h / 1000}s`,
      n: rets.length,
      median: `${median(rets) >= 0 ? '+' : ''}${median(rets).toFixed(2)}%`,
      pctUp: `${(rets.filter(x => x > 0).length / Math.max(1, rets.length) * 100).toFixed(0)}%`,
      _m: median(rets),
    };
  });
  console.log('Forward return from the moment of graduation:');
  console.table(rows.map(({ _m, ...r }) => r));

  const best = rows.filter(r => r.n >= 25).reduce((a, b) => (b._m > a._m ? b : a), { _m: -Infinity, horizon: 'n/a', n: 0 } as any);

  console.log('');
  console.log('─'.repeat(72));
  if (usable.length < 25) {
    console.log(`INCONCLUSIVE — only ${usable.length} usable graduations. Needs at least 25.`);
    console.log('Collect for longer before drawing any conclusion.');
  } else if (best._m > 2) {
    console.log(`VERDICT: best horizon ${best.horizon} returns ${best._m.toFixed(2)}% — above the ~2%`);
    console.log('no-race round-trip cost. Graduations look genuinely different. Worth building.');
  } else if (best._m > 0) {
    console.log(`VERDICT: best horizon ${best.horizon} returns ${best._m.toFixed(2)}% — positive but`);
    console.log('inside the ~2% round-trip cost. Real, but fees eat it. Not worth building.');
  } else {
    console.log(`VERDICT: best horizon ${best.horizon} returns ${best._m.toFixed(2)}%. Graduations are`);
    console.log('as dead as launches. That was the last idea worth testing — close the book.');
  }
  console.log('─'.repeat(72));
}
