// scripts/follow-ev.ts
//
// What copying these wallets would actually have paid — measured, not assumed.
//
// ── Why this exists ──────────────────────────────────────────────────────────────────────────
// follow-wallets.ts printed CONFIRMED at 19.5% precision on fresh tokens, above both the 12% bar
// and the 17.4% measured in sample. The out-of-sample precision genuinely held, which is the first
// clean positive in this project.
//
// But precision alone decides nothing. The EV that made 17.4% look like +49%/trade assumed a
// winner returns +400% — entry near launch, exit at the crown. That figure was invented, never
// measured, and the same run reported a median peak multiple of 0.99x: the median followed token
// never traded above what the wallet paid for it. A 19.5% hit rate on winners worth nothing is
// still a losing strategy.
//
// This replaces the assumption with the recorded paths.
//
// ── Two failure modes this project has already been caught by ────────────────────────────────
// 1. One outlier carrying the mean. --dropbest N removes the top N trades: three tokens out of 759
//    turned every positive graduation cell negative. Built in here from the start.
// 2. Per-wallet sample size. BUBBLE has 17 buys at 5.9% precision, below break-even, while the
//    100% and 40% wallets have n=2 and n=5. A per-wallet table with a minimum-n gate keeps a
//    two-trade fluke from being read as an edge.
//
// ── The delay problem, which no amount of analysis fixes ─────────────────────────────────────
// These wallets buy a median 0.9s after launch. To copy one you must see their transaction, decide
// and land your own — realistically 1.5-2.5s after launch, well behind them. Samples here are 30s
// apart, so that penalty CANNOT be modelled from this data. Everything below therefore assumes you
// pay exactly their price, which is the best case and not achievable. If the best case does not
// clear the bar, the real case certainly does not.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Net EV per copied trade, after 5% round-trip cost (copying IS a race, so a tip is needed):
//   > +10%      survives even a generous allowance for the entry delay. Build it.
//   0% to +10%  positive at their price, but the delay eats an unknown share. Not enough.
//   <= 0%       copying loses money even at the impossible best-case entry.
//
// Usage:
//   npx tsx scripts/follow-ev.ts [--tp 100] [--sl 25] [--dropbest 0] [--minbuys 5]

import fs from 'fs';

const FILE = './data/follows.jsonl';
const COST_PCT = 5;             // copying is a race: priority fee/tip needed
const IMPLAUSIBLE_GAIN = 2000;  // same ceiling exit-manager uses against bad reserve reads

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const TP = parseFloat(argOf('tp') || '100');
const SL = parseFloat(argOf('sl') || '25');
const DROP_BEST = parseInt(argOf('dropbest') || '0', 10);
const MIN_BUYS = parseInt(argOf('minbuys') || '5', 10);
// Cap how much of each recorded path is used. With 4h of path collected, running this at 0.5, 1, 2
// and 4 answers whether the winners keep growing or the losers just bleed longer - on identical
// tokens, so the comparison is clean.
const MAX_HOURS = parseFloat(argOf('maxhours') || '99');

interface Follow { wallet: string; mint: string; seenAt: number; offsetMs: number; mcapAtBuy: number; mcapNow: number; sampleOffsetMs: number; }

if (!fs.existsSync(FILE)) { console.error(`No ${FILE} — run follow-wallets.ts first.`); process.exit(1); }

const byBuy = new Map<string, Follow[]>();
for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const f: Follow = JSON.parse(line);
    if (!f?.mint || !isFinite(f.mcapNow) || !isFinite(f.mcapAtBuy) || f.mcapAtBuy <= 0) continue;
    if (f.sampleOffsetMs > MAX_HOURS * 3_600_000) continue;
    const key = `${f.wallet}:${f.mint}:${f.seenAt}`;
    const a = byBuy.get(key);
    if (a) a.push(f); else byBuy.set(key, [f]);
  } catch { /* skip */ }
}
for (const a of byBuy.values()) a.sort((x, y) => x.sampleOffsetMs - y.sampleOffsetMs);

const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;

/** Walk the recorded path applying TP/SL from the wallet's own entry price. Net % after cost. */
function simulate(path: Follow[]): number | null {
  const entry = path[0].mcapAtBuy;
  if (!entry || entry <= 0) return null;
  for (const s of path) {
    const r = (s.mcapNow - entry) / entry * 100;
    if (!isFinite(r) || r > IMPLAUSIBLE_GAIN) return null;
    if (r >= TP) return TP - COST_PCT;
    if (r <= -SL) return -SL - COST_PCT;
  }
  const last = (path[path.length - 1].mcapNow - entry) / entry * 100;
  if (!isFinite(last) || last > IMPLAUSIBLE_GAIN) return null;
  return last - COST_PCT;
}

const buys = [...byBuy.values()].filter(a => a.length >= 2);
const trimmed = (xs: number[]) => DROP_BEST > 0 ? [...xs].sort((a, b) => b - a).slice(DROP_BEST) : xs;

console.log(`copied trades:  ${buys.length}`);
console.log(`exit rule:      TP +${TP}% / SL -${SL}%, ${COST_PCT}% round-trip cost`);
if (DROP_BEST > 0) console.log(`dropping best:  ${DROP_BEST} trade(s)`);
if (MAX_HOURS < 99) console.log(`window capped:  ${MAX_HOURS}h after entry`);
console.log(`entry price:    the wallet's own — best case, NOT achievable (they buy 0.9s after launch)\n`);

// ── Aggregate ──────────────────────────────────────────────────────────────────────────────
const allResults: number[] = [];
const perWallet = new Map<string, number[]>();
for (const path of buys) {
  const r = simulate(path);
  if (r === null) continue;
  allResults.push(r);
  const w = path[0].wallet;
  const a = perWallet.get(w) ?? [];
  a.push(r);
  perWallet.set(w, a);
}

const kept = trimmed(allResults);
const ev = mean(kept);
const peaks = buys.map(p => Math.max(...p.map(s => s.mcapNow)) / p[0].mcapAtBuy).filter(x => isFinite(x) && x < 21);
peaks.sort((a, b) => a - b);

console.log(`net EV per copied trade: ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}%  (n=${kept.length})`);
console.log(`win rate:                ${(kept.filter(x => x > 0).length / Math.max(1, kept.length) * 100).toFixed(0)}%`);
console.log(`peak multiple p50/p90:   ${peaks.length ? peaks[Math.floor(peaks.length * 0.5)].toFixed(2) : 'n/a'}x / ${peaks.length ? peaks[Math.floor(peaks.length * 0.9)].toFixed(2) : 'n/a'}x`);
console.log('');

// ── Per wallet, gated on sample size ───────────────────────────────────────────────────────
const walletRows = [...perWallet.entries()]
  .map(([w, rs]) => {
    const k = trimmed(rs);
    return {
      wallet: `${w.slice(0, 6)}…${w.slice(-4)}`,
      buys: k.length,
      'net EV': k.length ? `${mean(k) >= 0 ? '+' : ''}${mean(k).toFixed(1)}%` : 'n/a',
      'win rate': k.length ? `${(k.filter(x => x > 0).length / k.length * 100).toFixed(0)}%` : 'n/a',
      verdict: k.length < MIN_BUYS ? `too few (<${MIN_BUYS})` : (mean(k) > 10 ? 'clears bar' : 'below bar'),
      _ev: k.length >= MIN_BUYS ? mean(k) : -Infinity,
      _n: k.length,
    };
  })
  .sort((a, b) => b._ev - a._ev);

console.table(walletRows.map(({ _ev, _n, ...r }) => r));

const bestWallet = walletRows[0];

console.log('');
console.log('─'.repeat(74));
if (kept.length < 30) {
  console.log(`INCONCLUSIVE — only ${kept.length} copied trades. Needs at least 30.`);
} else if (ev > 10) {
  console.log(`PASSES: ${ev.toFixed(1)}% net EV per copied trade at their entry price.`);
  console.log('Now re-run with --dropbest 1 and --dropbest 3. If it survives that, the remaining');
  console.log('question is the 0.9s entry delay, which this data cannot answer — it would need a');
  console.log('live DRY_RUN follower actually racing them.');
} else if (ev > 0) {
  console.log(`NOT ENOUGH: ${ev.toFixed(1)}% net EV at their exact entry price — and you cannot get`);
  console.log('their price. They buy 0.9s after launch; you would land 1.5-2.5s in, paying more.');
  console.log('A margin this thin does not survive that.');
} else {
  console.log(`FAILS: ${ev.toFixed(1)}% net EV even at the impossible best-case entry. The 19.5%`);
  console.log('precision was real, but the winners are too small to pay for the losers. Copying loses.');
}
if (bestWallet && bestWallet._ev > -Infinity && bestWallet._ev > ev + 10) {
  console.log(`(Best individual wallet ${bestWallet.wallet} at ${bestWallet['net EV']} over ${bestWallet.buys} trades —`);
  console.log(' worth watching, but that is one wallet at a small sample and could be noise.)');
}
console.log('─'.repeat(74));
