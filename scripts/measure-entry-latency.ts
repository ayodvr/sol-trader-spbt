// scripts/measure-entry-latency.ts
//
// Does entering faster actually help?
//
// The 156-trade sample plus the exit-rule sweep (scripts/replay-exits.ts) established that the
// bonding-curve strategy has a NEGATIVE gross expectancy of about -2.2% per trade before any
// trading cost, and that no combination of take-profit / stop-loss / trailing-stop / max-hold in a
// 120-cell grid turns it positive. So the problem is the entry, not the exit.
//
// The suspected mechanism is latency: detection happens at ~0-8ms via gRPC, but the anti-rug
// analysis takes 600-1600ms, and LATE_ENTRY was firing at 28-43% of the curve already sold by the
// time the bot could act. If most of the launch pop is gone within the first second, the bot is
// systematically buying the top from whoever got there first.
//
// Before anyone rewrites the hot path to chase first-block entry, measure whether the prize is
// actually there. This script watches brand-new tokens and samples the bonding curve price densely
// over the first 30 seconds, then reports what entering at 0ms / 250ms / 1s / 2s would each have
// been worth.
//
// ── Cost ─────────────────────────────────────────────────────────────────────────────────────
// Sampling is front-loaded (250ms apart for the first 5s, where the action is; 2.5s apart after)
// and capped at MAX_CONCURRENT tokens, so it runs around 6 getAccountInfo calls/sec — roughly
// 160k CU for a 30-minute collection. Deliberately modest: this is a decision-making measurement,
// not a data-collection campaign.
//
// ── Caveat ───────────────────────────────────────────────────────────────────────────────────
// This samples ALL new tokens, not only those that pass the anti-rug filter — running the analyzer
// per token would burn Helius credits and is not needed to answer how fast the launch pop decays.
// Read the output as a property of the population the bot draws from.
//
// Usage:
//   npx tsx scripts/measure-entry-latency.ts --minutes 30     # collect
//   npx tsx scripts/measure-entry-latency.ts --analyze        # report

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { GrpcWatcher } from '../src/grpc-watcher.js';
import { deriveBondingCurve } from '../src/utils.js';

const OUT_FILE = './data/entry-latency.jsonl';
const MAX_CONCURRENT = 4;

// Dense early, sparse later. The whole question is what happens in the first second or two.
const SAMPLE_OFFSETS_MS = [
  0, 250, 500, 750, 1000, 1250, 1500, 2000, 2500, 3000, 4000, 5000,
  7500, 10000, 12500, 15000, 20000, 25000, 30000,
];

interface Sample { offsetMs: number; actualMs: number; price: number; }
interface Record { mint: string; detectedAt: number; samples: Sample[]; }

const argv = process.argv.slice(2);
function arg(name: string): string | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] ?? '') : null;
}

if (argv.includes('--analyze')) {
  analyze();
} else {
  collect(parseFloat(arg('minutes') || '30'));
}

// ── Collection ───────────────────────────────────────────────────────────────────────────────
async function collect(minutes: number) {
  const connection = new Connection(CONFIG.RPC_URL, 'processed');
  fs.mkdirSync('./data', { recursive: true });

  let observing = 0;
  let completed = 0;
  const deadline = Date.now() + minutes * 60_000;

  async function readPrice(mint: string): Promise<number | null> {
    try {
      const curve = deriveBondingCurve(new PublicKey(mint));
      const acc = await connection.getAccountInfo(curve, 'processed');
      if (!acc || acc.data.length < 48) return null;
      // Verified offsets (scripts/inspect-curve.ts): virtualTokenReserves@8, virtualSolReserves@16.
      // byteOffset/byteLength are mandatory — small Buffers share a pooled ArrayBuffer, and a
      // DataView over buf.buffer alone reads unrelated memory. That bug produced every fake
      // number in this project's history.
      const view = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
      const vToken = view.getBigUint64(8, true);
      const vSol = view.getBigUint64(16, true);
      if (vToken === 0n) return null;
      return Number(vSol * 1_000_000_000n / vToken);
    } catch {
      return null;
    }
  }

  async function observe(mint: string, detectedAt: number) {
    observing++;
    const samples: Sample[] = [];
    for (const offset of SAMPLE_OFFSETS_MS) {
      const wait = detectedAt + offset - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      const price = await readPrice(mint);
      if (price !== null && price > 0) {
        samples.push({ offsetMs: offset, actualMs: Date.now() - detectedAt, price });
      }
    }
    observing--;
    // Two samples is the minimum that can show a price change at all.
    if (samples.length >= 2) {
      fs.appendFileSync(OUT_FILE, JSON.stringify({ mint, detectedAt, samples } as Record) + '\n');
      completed++;
      if (completed % 10 === 0) console.log(`  ${completed} tokens recorded...`);
    }
  }

  const watcher = new GrpcWatcher();
  await watcher.start((event: any) => {
    if (Date.now() > deadline) return;
    if (observing >= MAX_CONCURRENT) return; // sampling budget, not a filter on token quality
    observe(event.mint.toBase58(), Date.now()).catch(() => { observing--; });
  });

  console.log(`Collecting for ${minutes} minutes into ${OUT_FILE} (max ${MAX_CONCURRENT} tokens at a time)...`);
  await new Promise(r => setTimeout(r, minutes * 60_000));
  console.log(`\nDone. ${completed} tokens recorded. Now run: npx tsx scripts/measure-entry-latency.ts --analyze`);
  process.exit(0);
}

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────
function analyze() {
  if (!fs.existsSync(OUT_FILE)) {
    console.error(`No ${OUT_FILE} — run the collection mode first.`);
    process.exit(1);
  }
  const records: Record[] = fs.readFileSync(OUT_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter((r): r is Record => !!r && Array.isArray(r.samples) && r.samples.length >= 2);

  if (!records.length) { console.error('No usable records.'); process.exit(1); }

  console.log(`tokens observed: ${records.length}`);
  console.log('');

  const priceAt = (r: Record, ms: number) => {
    const s = r.samples.find(x => x.offsetMs >= ms);
    return s ? s.price : null;
  };
  const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // ── 1. How much does entry price move while you are deciding? ──
  console.log('Entry price at latency L, relative to the price at detection (t=0):');
  console.log('(positive = you pay MORE by being slower — the launch pop has already happened)');
  console.log('');
  const latencies = [250, 500, 1000, 1500, 2000, 3000, 5000];
  const rows = latencies.map(L => {
    const deltas: number[] = [];
    for (const r of records) {
      const p0 = priceAt(r, 0), pL = priceAt(r, L);
      if (p0 && pL) deltas.push((pL - p0) / p0 * 100);
    }
    return {
      latency: `${L}ms`,
      medianPriceVsT0: `${median(deltas) >= 0 ? '+' : ''}${median(deltas).toFixed(2)}%`,
      worse: `${(deltas.filter(d => d > 0).length / deltas.length * 100).toFixed(0)}%`,
      n: deltas.length,
    };
  });
  console.table(rows);

  // ── 2. What is a position worth 30s later, entered at each latency? ──
  // This is the number that decides whether latency work is worth doing: if the forward return
  // from entering at 0ms is not materially better than from 1000ms, speed is not the problem and
  // rewriting the hot path would buy nothing.
  console.log('');
  console.log('Forward outcome from entering at latency L (measured to the end of the 30s window):');
  console.log('');
  const fwd = [0, 250, 500, 1000, 2000].map(L => {
    const finals: number[] = [];
    const peaks: number[] = [];
    for (const r of records) {
      const pL = priceAt(r, L);
      if (!pL) continue;
      const after = r.samples.filter(s => s.offsetMs >= L);
      if (after.length < 2) continue;
      const last = after[after.length - 1].price;
      const peak = Math.max(...after.map(s => s.price));
      finals.push((last - pL) / pL * 100);
      peaks.push((peak - pL) / pL * 100);
    }
    return {
      entryAt: `${L}ms`,
      medianAt30s: `${median(finals) >= 0 ? '+' : ''}${median(finals).toFixed(2)}%`,
      medianPeak: `+${median(peaks).toFixed(2)}%`,
      pctEverUp10: `${(peaks.filter(p => p >= 10).length / peaks.length * 100).toFixed(0)}%`,
      n: finals.length,
    };
  });
  console.table(fwd);

  console.log('');
  console.log('How to read this:');
  console.log('  If "medianPriceVsT0" at 1000ms is large (say +15% or more), the launch pop is');
  console.log('  genuinely being missed and cutting analysis latency is worth engineering.');
  console.log('  If it is small (a few percent), then the bot is not losing because it is slow —');
  console.log('  the tokens themselves simply go down, and no amount of speed fixes that.');
  console.log('  "medianPeak" is the ceiling any exit rule could ever have captured.');
}
