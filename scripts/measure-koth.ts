// scripts/measure-koth.ts
//
// Does "King of the Hill" work as an entry trigger?
//
// ── Why this is a distinct question ──────────────────────────────────────────────────────────
// Three points exist on a pump.fun token's life curve, and two have already been measured:
//
//   launch      (~28 SOL mcap)  — measured dead. 156 trades, -1.1088 SOL, speed worth +0.00%.
//   KOTH        (~150 SOL mcap) — UNTESTED. This script.
//   graduation  (~430 SOL mcap) — measured dead. 280 migrations, negative at every horizon.
//
// KOTH is pump.fun's crown: the token leading the board, historically around a $30k market cap.
// Like graduation it is selection by demonstrated demand rather than by heuristic, but it fires
// far earlier — while there is still curve left to climb. That is the only reason it is worth a
// look: the graduation test may simply have been too late to the move.
//
// Honest prior: both bracketing points are dead, so a live midpoint would be a surprise.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Median forward return from the moment of KOTH crossing, at the best horizon tested:
//   > +5%      clears cost. This trigger IS contested — other bots watch KOTH — so assume a tip.
//   0% to +5%  real but eaten by fees. Not worth building.
//   <= 0%      KOTH is as dead as launch and graduation. Done.
//
// ── How it works ─────────────────────────────────────────────────────────────────────────────
// Adaptive tracking, to keep RPC cheap. Every new token is polled slowly from birth. The ~95%
// that never approach the crown are dropped after WATCH_WINDOW. Only a token that actually
// crosses gets promoted to dense sampling for a further FOLLOW_WINDOW — so the RPC budget is
// spent almost entirely on the interesting minority.
//
// Market cap comes from the curve, not from a third-party API:
//   marketCapLamports = virtualSolReserves * tokenTotalSupply / virtualTokenReserves
// Offsets verified against a live mainnet account (scripts/inspect-curve.ts): vToken@8, vSol@16,
// totalSupply@40. A fresh curve prices out at ~27.96 SOL, which is the sanity check on the maths.
//
// Market cap is recorded per sample rather than thresholded at collection time, so the analysis
// can be re-run at a different crown level without re-collecting anything.
//
// Usage:
//   npx tsx scripts/measure-koth.ts --hours 6
//   npx tsx scripts/measure-koth.ts --analyze [--threshold 150]

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { GrpcWatcher } from '../src/grpc-watcher.js';
import { deriveBondingCurve } from '../src/utils.js';

const OUT_FILE = './data/koth.jsonl';
const MAX_CONCURRENT = 90;
const WATCH_POLL_MS = 45_000;        // slow poll while waiting for a crown
const FOLLOW_POLL_MS = 30_000;       // dense poll once crowned
const WATCH_WINDOW_MS = 1_800_000;   // 30 min to reach KOTH or be dropped
const FOLLOW_WINDOW_MS = 1_800_000;  // 30 min of forward data after crowning
const DEFAULT_THRESHOLD_SOL = 150;   // ~$30k at SOL ~$200; re-thresholdable at analysis time

interface Sample {
  mint: string;
  bornAt: number;
  offsetMs: number;
  mcapSol: number;
  phase: 'watch' | 'follow';
}

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };

if (argv.includes('--analyze')) analyze();
else collect(parseFloat(argOf('hours') || '6'));

// ── Collection ───────────────────────────────────────────────────────────────────────────────
async function collect(hours: number) {
  const connection = new Connection(CONFIG.RPC_URL, 'processed');
  fs.mkdirSync('./data', { recursive: true });
  const threshold = parseFloat(argOf('threshold') || String(DEFAULT_THRESHOLD_SOL));

  let watching = 0, crowned = 0, dropped = 0;
  const deadline = Date.now() + hours * 3_600_000;

  async function marketCapSol(mint: string): Promise<number | null> {
    try {
      const acc = await connection.getAccountInfo(deriveBondingCurve(new PublicKey(mint)), 'processed');
      if (!acc || acc.data.length < 48) return null;
      // byteOffset/byteLength are mandatory: small Buffers share a pooled ArrayBuffer, and a
      // DataView over buf.buffer alone reads unrelated memory. That bug produced every fake
      // number in this project's history.
      const v = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
      const vToken = v.getBigUint64(8, true);
      const vSol = v.getBigUint64(16, true);
      const supply = v.getBigUint64(40, true);
      if (vToken === 0n) return null;
      return Number(vSol * supply / vToken) / 1e9;
    } catch { return null; }
  }

  function write(s: Sample) { fs.appendFileSync(OUT_FILE, JSON.stringify(s) + '\n'); }

  async function track(mint: string, bornAt: number) {
    watching++;
    let crownedAt: number | null = null;

    // Phase 1: wait for the crown, polling slowly.
    while (Date.now() - bornAt < WATCH_WINDOW_MS && crownedAt === null) {
      await new Promise(r => setTimeout(r, WATCH_POLL_MS));
      const mcap = await marketCapSol(mint);
      if (mcap === null) continue;
      write({ mint, bornAt, offsetMs: Date.now() - bornAt, mcapSol: mcap, phase: 'watch' });
      if (mcap >= threshold) {
        crownedAt = Date.now();
        crowned++;
        console.log(`  👑 crowned #${crowned}: ${mint} at ${mcap.toFixed(0)} SOL mcap`);
      }
    }

    // Phase 2: only crowned tokens earn dense forward sampling.
    if (crownedAt !== null) {
      while (Date.now() - crownedAt < FOLLOW_WINDOW_MS) {
        await new Promise(r => setTimeout(r, FOLLOW_POLL_MS));
        const mcap = await marketCapSol(mint);
        if (mcap !== null) write({ mint, bornAt, offsetMs: Date.now() - bornAt, mcapSol: mcap, phase: 'follow' });
      }
    } else {
      dropped++;
    }
    watching--;
  }

  const watcher = new GrpcWatcher();
  await watcher.start((event: any) => {
    if (Date.now() > deadline || watching >= MAX_CONCURRENT) return;
    track(event.mint.toBase58(), Date.now()).catch(() => { watching--; });
  });

  console.log(`Watching for King of the Hill crossings above ${threshold} SOL market cap`);
  console.log(`(${hours}h, up to ${MAX_CONCURRENT} tokens at once, crowned ones followed ${FOLLOW_WINDOW_MS / 60000}m)\n`);

  const report = setInterval(() => {
    console.log(`  ... ${crowned} crowned, ${dropped} dropped, ${watching} in flight`);
  }, 600_000);

  await new Promise(r => setTimeout(r, hours * 3_600_000 + WATCH_WINDOW_MS + FOLLOW_WINDOW_MS));
  clearInterval(report);
  console.log(`\nDone. ${crowned} crowned out of ${crowned + dropped} tracked.`);
  process.exit(0);
}

// ── Analysis ─────────────────────────────────────────────────────────────────────────────────
function analyze() {
  if (!fs.existsSync(OUT_FILE)) { console.error(`No ${OUT_FILE} — run collection first.`); process.exit(1); }
  const threshold = parseFloat(argOf('threshold') || String(DEFAULT_THRESHOLD_SOL));

  const paths = new Map<string, Sample[]>();
  for (const line of fs.readFileSync(OUT_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let s: Sample;
    try { s = JSON.parse(line); } catch { continue; }
    if (!s?.mint || !isFinite(s.mcapSol) || s.mcapSol <= 0) continue;
    const key = `${s.mint}:${s.bornAt}`;
    const a = paths.get(key);
    if (a) a.push(s); else paths.set(key, [s]);
  }
  for (const a of paths.values()) a.sort((x, y) => x.offsetMs - y.offsetMs);

  const median = (xs: number[]) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  // A crossing is the FIRST sample at or above the threshold — the moment a bot would have bought.
  const crossings: Array<{ entry: number; after: Sample[] }> = [];
  for (const path of paths.values()) {
    const i = path.findIndex(s => s.mcapSol >= threshold);
    if (i === -1) continue;
    const after = path.slice(i);
    if (after.length >= 2) crossings.push({ entry: path[i].mcapSol, after });
  }

  console.log(`tokens tracked:      ${paths.size}`);
  console.log(`reached ${threshold} SOL:  ${crossings.length}  (${(crossings.length / Math.max(1, paths.size) * 100).toFixed(1)}%)`);
  console.log('');

  const horizons = [300_000, 600_000, 900_000, 1_800_000];
  const rows = horizons.map(h => {
    const rets: number[] = [];
    for (const c of crossings) {
      const t0 = c.after[0].offsetMs;
      const at = c.after.find(s => s.offsetMs - t0 >= h);
      if (at) rets.push((at.mcapSol - c.entry) / c.entry * 100);
    }
    return {
      horizon: `${h / 60_000}m`,
      n: rets.length,
      median: `${median(rets) >= 0 ? '+' : ''}${median(rets).toFixed(2)}%`,
      pctUp: `${(rets.filter(x => x > 0).length / Math.max(1, rets.length) * 100).toFixed(0)}%`,
      _m: median(rets),
    };
  });
  console.log(`Forward return from the moment of crossing ${threshold} SOL market cap:`);
  console.table(rows.map(({ _m, ...r }) => r));

  const best = rows.filter(r => r.n >= 25).reduce((a, b) => (b._m > a._m ? b : a), { _m: -Infinity, horizon: 'n/a', n: 0 } as any);

  console.log('');
  console.log('─'.repeat(72));
  if (crossings.length < 25) {
    console.log(`INCONCLUSIVE — only ${crossings.length} crossings. Needs at least 25.`);
    console.log('Collect for longer, or lower --threshold and re-run (no re-collection needed).');
  } else if (best._m > 5) {
    console.log(`VERDICT: best horizon ${best.horizon} returns ${best._m.toFixed(2)}% — above the ~5% bar.`);
    console.log('KOTH is a real entry trigger. Worth building.');
  } else if (best._m > 0) {
    console.log(`VERDICT: best horizon ${best.horizon} returns ${best._m.toFixed(2)}% — positive but inside`);
    console.log('the ~5% cost. Real, but fees eat it. Not worth building.');
  } else {
    console.log(`VERDICT: best horizon ${best.horizon} returns ${best._m.toFixed(2)}%. KOTH is as dead as`);
    console.log('launch and graduation. All three points on the curve are then measured.');
  }
  console.log('─'.repeat(72));
}
