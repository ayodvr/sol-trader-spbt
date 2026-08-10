// scripts/measure-survivors.ts
//
// THE LAST TEST. Does surviving the first five minutes predict anything about the next five?
//
// ── Why this test exists ─────────────────────────────────────────────────────────────────────
// Three measurements have already established that buying new pump.fun launches has no edge:
//   1. Live DRY_RUN sample: 156 trades, -1.1088 SOL, 11.5% win rate.
//   2. scripts/replay-exits.ts: all 120 cells of a TP/SL/trailing/max-hold grid negative;
//      gross expectancy -2.2% per trade before costs.
//   3. scripts/measure-entry-latency.ts: entering 1000ms late costs +0.00%. The median new token
//      falls 9.4% in 30s and its median peak is +0.25%.
//
// Measurement 3 contained one genuinely useful finding: WAITING IS FREE. Every sniping strategy
// assumes speed is the edge; that assumption was measured to be worth zero. If there is no penalty
// for being a second late, there may be none for being five minutes late — which makes selection
// by revealed demand available at no cost. Rather than guessing which launch will pump, let the
// market kill off the ~65% that simply die, then look only at what is left.
//
// This tests exactly that and nothing else.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Survivors' median forward return over minutes 5-10:
//   > +5%      clears the ~5% round-trip cost (Jito tip + pump.fun fees + slippage). Worth building.
//   0% to +5%  real but too small to trade at 0.05 SOL positions. Not worth it.
//   <= 0%      survival predicts nothing. Close the book.
// The script prints the verdict itself so the number is not read hopefully after the fact.
//
// ── Cost ─────────────────────────────────────────────────────────────────────────────────────
// Sparse sampling (every 30s) across up to 20 concurrent tokens is under 1 RPC call/sec — roughly
// 80k CU for a two-hour run.
//
// Usage:
//   npx tsx scripts/measure-survivors.ts --hours 2      # collect
//   npx tsx scripts/measure-survivors.ts --analyze      # verdict

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { GrpcWatcher } from '../src/grpc-watcher.js';
import { deriveBondingCurve } from '../src/utils.js';

const OUT_FILE = './data/survivors.jsonl';
const MAX_CONCURRENT = 20;
const SAMPLE_EVERY_MS = 30_000;
const TOTAL_WINDOW_MS = 600_000;   // 10 minutes
const SPLIT_MS = 300_000;          // survivor classification happens here

// One line per SAMPLE, not per token. The first version of this script buffered a token's whole
// 10-minute path in memory and wrote it only on completion — so when the process was killed at
// 6.5 minutes, before any token had finished, it had written nothing at all despite having
// collected thousands of samples. price-ticks.jsonl survived every crash in this project for
// exactly the opposite reason: it appends immediately. Do the same here and group at analysis time.
interface Sample {
  mint: string;
  detectedAt: number;
  offsetMs: number;
  price: number;
  vSol: string;      // stringified bigint — reserve identity is how "still trading" is detected
  vToken: string;
  complete: boolean;
}
interface Record { mint: string; detectedAt: number; samples: Sample[]; }

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? '') : null; };

if (argv.includes('--analyze')) analyze();
else collect(parseFloat(argOf('hours') || '2'));

// ── Collection ───────────────────────────────────────────────────────────────────────────────
async function collect(hours: number) {
  const connection = new Connection(CONFIG.RPC_URL, 'processed');
  fs.mkdirSync('./data', { recursive: true });

  let observing = 0, completed = 0;
  const deadline = Date.now() + hours * 3_600_000;

  async function readCurve(mint: string, detectedAt: number, offsetMs: number): Promise<Sample | null> {
    try {
      const acc = await connection.getAccountInfo(deriveBondingCurve(new PublicKey(mint)), 'processed');
      if (!acc || acc.data.length < 49) return null;
      // Verified offsets (scripts/inspect-curve.ts): virtualTokenReserves@8, virtualSolReserves@16,
      // complete@48. byteOffset/byteLength are mandatory — small Buffers share a pooled
      // ArrayBuffer, and a DataView over buf.buffer alone reads unrelated memory.
      const view = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
      const vToken = view.getBigUint64(8, true);
      const vSol = view.getBigUint64(16, true);
      if (vToken === 0n) return null;
      return {
        mint, detectedAt, offsetMs,
        price: Number(vSol * 1_000_000_000n / vToken),
        vSol: vSol.toString(),
        vToken: vToken.toString(),
        complete: acc.data[48] !== 0,
      };
    } catch { return null; }
  }

  async function observe(mint: string, detectedAt: number) {
    observing++;
    for (let offset = 0; offset <= TOTAL_WINDOW_MS; offset += SAMPLE_EVERY_MS) {
      const wait = detectedAt + offset - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      const s = await readCurve(mint, detectedAt, offset);
      if (s) fs.appendFileSync(OUT_FILE, JSON.stringify(s) + '\n');
      // A graduated token has left the curve — its price can no longer be read there, and it is a
      // *good* outcome, not a dead one. Stop sampling but keep what was collected.
      if (s?.complete) break;
    }
    observing--;
    if (++completed % 20 === 0) console.log(`  ${completed} tokens followed to completion (${observing} in flight)...`);
  }

  const watcher = new GrpcWatcher();
  await watcher.start((event: any) => {
    if (Date.now() > deadline || observing >= MAX_CONCURRENT) return;
    observe(event.mint.toBase58(), Date.now()).catch(() => { observing--; });
  });

  console.log(`Collecting for ${hours}h into ${OUT_FILE}`);
  console.log(`(each token followed for 10 minutes, up to ${MAX_CONCURRENT} at a time)\n`);
  await new Promise(r => setTimeout(r, hours * 3_600_000 + TOTAL_WINDOW_MS));
  console.log(`\nDone. ${completed} tokens recorded. Now run:`);
  console.log('  npx tsx scripts/measure-survivors.ts --analyze');
  process.exit(0);
}

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────
function analyze() {
  if (!fs.existsSync(OUT_FILE)) { console.error(`No ${OUT_FILE} — run collection first.`); process.exit(1); }

  // The file is one line per sample. Group them back into per-token paths. A trailing partial line
  // from a killed process is simply dropped by the JSON.parse guard.
  const grouped = new Map<string, Record>();
  for (const line of fs.readFileSync(OUT_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let s: Sample;
    try { s = JSON.parse(line); } catch { continue; }
    if (!s?.mint || typeof s.offsetMs !== 'number' || !isFinite(s.price)) continue;
    const key = `${s.mint}:${s.detectedAt}`;
    let rec = grouped.get(key);
    if (!rec) { rec = { mint: s.mint, detectedAt: s.detectedAt, samples: [] }; grouped.set(key, rec); }
    rec.samples.push(s);
  }
  const records: Record[] = [...grouped.values()].filter(r => r.samples.length >= 2);
  for (const r of records) r.samples.sort((a, b) => a.offsetMs - b.offsetMs);

  const at = (r: Record, ms: number) => r.samples.find(s => s.offsetMs >= ms) || null;
  const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const survivors: number[] = [], others: number[] = [];
  let graduated = 0, tooShort = 0, aliveCount = 0;

  for (const r of records) {
    if (r.samples.some(s => s.complete)) { graduated++; continue; }

    const s0 = at(r, 0), sMid = at(r, SPLIT_MS), sEnd = at(r, TOTAL_WINDOW_MS);
    if (!s0 || !sMid || !sEnd) { tooShort++; continue; }

    // "Still trading" = reserves actually changed over the run-up to the 5-minute mark. A token
    // nobody is trading has literally frozen reserves — the same property that made dead positions
    // immortal in exit-manager.
    const before = r.samples.filter(s => s.offsetMs <= SPLIT_MS);
    const active = new Set(before.map(s => s.vSol)).size > 1;
    const notDown = sMid.price >= s0.price;

    const forward = (sEnd.price - sMid.price) / sMid.price * 100;
    if (active && notDown) { survivors.push(forward); aliveCount++; } else { others.push(forward); }
  }

  console.log(`tokens followed:        ${records.length}`);
  console.log(`  graduated (excluded): ${graduated}`);
  console.log(`  incomplete (excluded):${tooShort}`);
  console.log(`  survivors at 5min:    ${aliveCount}  (${(aliveCount / Math.max(1, survivors.length + others.length) * 100).toFixed(1)}% of classified)`);
  console.log(`  everything else:      ${others.length}`);
  console.log('');

  const sMed = median(survivors), oMed = median(others);
  console.log('Forward return, minutes 5 to 10:');
  console.table([
    { group: 'survivors', n: survivors.length, median: `${sMed >= 0 ? '+' : ''}${sMed.toFixed(2)}%`, pctUp: `${(survivors.filter(x => x > 0).length / Math.max(1, survivors.length) * 100).toFixed(0)}%` },
    { group: 'everything else', n: others.length, median: `${oMed >= 0 ? '+' : ''}${oMed.toFixed(2)}%`, pctUp: `${(others.filter(x => x > 0).length / Math.max(1, others.length) * 100).toFixed(0)}%` },
  ]);

  console.log('');
  console.log('─'.repeat(72));
  if (survivors.length < 25) {
    console.log(`INCONCLUSIVE — only ${survivors.length} survivors. Needs at least 25 to mean anything.`);
    console.log('Collect for longer before drawing any conclusion.');
  } else if (sMed > 5) {
    console.log(`VERDICT: survivors return ${sMed.toFixed(2)}% — above the ~5% round-trip cost.`);
    console.log('Selection by survival looks real. Worth building a strategy around.');
  } else if (sMed > 0) {
    console.log(`VERDICT: survivors return ${sMed.toFixed(2)}% — positive but below the ~5% round-trip`);
    console.log('cost. Real, but not tradeable at 0.05 SOL positions. Not worth building.');
  } else {
    console.log(`VERDICT: survivors return ${sMed.toFixed(2)}%. Surviving five minutes predicts nothing.`);
    console.log('This was the last untested route. Close the book.');
  }
  console.log('─'.repeat(72));
}
