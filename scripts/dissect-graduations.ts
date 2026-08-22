// scripts/dissect-graduations.ts
//
// Re-open the graduation data, looking at the tail instead of the middle.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────
// measure-graduations.ts captured 280 migrations, reported a median forward return of -0.06%, and
// closed the book. That was a methodological error, and the KOTH work exposed it: in a power-law
// market the median is ALWAYS dead, because almost every token dies. The median tells you what
// you already know. The question that matters is whether the tail is identifiable in advance.
//
// Asking that question of the KOTH data produced the first positive signal in this project. This
// asks it of the graduation data, which is already on disk and costs nothing to re-analyse.
//
// Three things the original run never looked at:
//   1. The DISTRIBUTION, not just the median. If p90 is strongly positive there is a tail worth
//      chasing even when the middle is flat.
//   2. Whether EARLY MOMENTUM predicts later movement — i.e. would entering one minute after
//      graduation, conditional on what happened in that minute, have beaten entering at zero?
//      That is an actionable rule, not a curiosity.
//   3. Whether POOL DEPTH at migration separates the winners from the rest.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Best conditional entry rule's median forward return, on a bucket holding >= 25 tokens:
//   > +2%      a real conditional edge exists (no Jito tip needed here, so ~2% round trip).
//   0% to +2%  eaten by fees.
//   <= 0%      graduations are dead in the tail as well as the middle. Properly closed.
//
// ── The caveat that applies to any positive result here ──────────────────────────────────────
// Any rule discovered by slicing this dataset is IN-SAMPLE. That is exactly the trap that made
// score-pumpers.ts report 17.4% precision off circular selection. A positive finding below is a
// hypothesis, not a result, and would need fresh graduations to confirm. Stated up front so it
// cannot be quietly forgotten if the numbers look good.
//
// Usage:
//   npx tsx scripts/dissect-graduations.ts

import fs from 'fs';

const FILE = './data/graduations.jsonl';

interface Sample { pool: string; mint: string; gradAt: number; offsetMs: number; price: number; quoteReserve: string; }

if (!fs.existsSync(FILE)) { console.error(`No ${FILE}.`); process.exit(1); }

const paths = new Map<string, Sample[]>();
for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const s: Sample = JSON.parse(line);
    if (!s?.pool || !isFinite(s.price) || s.price <= 0) continue;
    const key = `${s.pool}:${s.gradAt}`;
    const a = paths.get(key);
    if (a) a.push(s); else paths.set(key, [s]);
  } catch { /* skip */ }
}
for (const a of paths.values()) a.sort((x, y) => x.offsetMs - y.offsetMs);
const grads = [...paths.values()].filter(a => a.length >= 3);

const pct = (xs: number[], p: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const at = (g: Sample[], ms: number) => g.find(s => s.offsetMs >= ms) ?? null;
const ret = (a: number, b: number) => (b - a) / a * 100;

console.log(`graduations with usable paths: ${grads.length}\n`);

// ── 1. The full distribution, not just the median ──────────────────────────────────────────
console.log('Forward return from graduation — full distribution:');
console.table([300_000, 900_000, 1_800_000, 3_600_000].map(h => {
  const rs: number[] = [];
  for (const g of grads) {
    const p0 = g[0], ph = at(g, h);
    if (p0 && ph && ph.offsetMs > 0) rs.push(ret(p0.price, ph.price));
  }
  return {
    horizon: `${h / 60_000}m`,
    n: rs.length,
    p10: `${pct(rs, 0.10).toFixed(1)}%`,
    p50: `${pct(rs, 0.50).toFixed(1)}%`,
    p75: `${pct(rs, 0.75).toFixed(1)}%`,
    p90: `${pct(rs, 0.90).toFixed(1)}%`,
    p95: `${pct(rs, 0.95).toFixed(1)}%`,
    max: `${Math.max(...rs).toFixed(0)}%`,
  };
}));

// ── 2. How big is the tail at all? ─────────────────────────────────────────────────────────
const peaks = grads.map(g => Math.max(...g.map(s => s.price)) / g[0].price * 100 - 100);
console.log('\nPeak reached at any point after graduation (the ceiling any exit could capture):');
console.table([10, 25, 50, 100, 200].map(t => ({
  'peak >=': `${t}%`,
  count: peaks.filter(p => p >= t).length,
  share: `${(peaks.filter(p => p >= t).length / grads.length * 100).toFixed(1)}%`,
})));

// ── 3. Does the first minute predict the next thirty? ──────────────────────────────────────
// This is the actionable question: rather than buying at graduation, wait 60s and buy only what
// is already moving. Entry price becomes the 60s price, so returns are measured from there.
console.log('\nConditional entry: wait 60s, buy only if the first minute did X.');
console.log('(returns measured from the 60s price — what you would actually pay)\n');

const buckets: Array<{ label: string; test: (r: number) => boolean }> = [
  { label: 'down >5%', test: r => r <= -5 },
  { label: '-5% to 0%', test: r => r > -5 && r <= 0 },
  { label: '0% to +10%', test: r => r > 0 && r <= 10 },
  { label: '+10% to +25%', test: r => r > 10 && r <= 25 },
  { label: 'up >25%', test: r => r > 25 },
];

const rows = buckets.map(b => {
  const fwd30: number[] = [], fwd60: number[] = [];
  let n = 0;
  for (const g of grads) {
    const p0 = g[0], p60 = at(g, 60_000);
    if (!p0 || !p60 || p60.offsetMs === 0) continue;
    const first = ret(p0.price, p60.price);
    if (!b.test(first)) continue;
    n++;
    const h30 = at(g, 1_800_000), h60 = at(g, 3_600_000);
    if (h30 && h30.offsetMs > p60.offsetMs) fwd30.push(ret(p60.price, h30.price));
    if (h60 && h60.offsetMs > p60.offsetMs) fwd60.push(ret(p60.price, h60.price));
  }
  return {
    'first 60s': b.label,
    n,
    'median +30m': fwd30.length ? `${pct(fwd30, 0.5).toFixed(1)}%` : 'n/a',
    'median +60m': fwd60.length ? `${pct(fwd60, 0.5).toFixed(1)}%` : 'n/a',
    'p90 +30m': fwd30.length ? `${pct(fwd30, 0.9).toFixed(1)}%` : 'n/a',
    _best: fwd30.length >= 25 ? pct(fwd30, 0.5) : -Infinity,
  };
});
console.table(rows.map(({ _best, ...r }) => r));

// ── 4. Does pool depth at migration separate winners? ──────────────────────────────────────
const withDepth = grads.map(g => ({
  depth: Number(BigInt(g[0].quoteReserve)) / 1e9,
  peak: Math.max(...g.map(s => s.price)) / g[0].price * 100 - 100,
})).filter(x => isFinite(x.depth) && x.depth > 0);

if (withDepth.length >= 20) {
  const sorted = [...withDepth].sort((a, b) => a.depth - b.depth);
  const third = Math.floor(sorted.length / 3);
  console.log('\nDoes SOL depth in the pool at migration predict the peak?');
  console.table([
    { depth: 'lowest third', n: third, 'median SOL': sorted[Math.floor(third / 2)].depth.toFixed(1), 'median peak': `${pct(sorted.slice(0, third).map(x => x.peak), 0.5).toFixed(1)}%` },
    { depth: 'middle third', n: third, 'median SOL': sorted[Math.floor(third * 1.5)].depth.toFixed(1), 'median peak': `${pct(sorted.slice(third, third * 2).map(x => x.peak), 0.5).toFixed(1)}%` },
    { depth: 'highest third', n: sorted.length - third * 2, 'median SOL': sorted[Math.floor(third * 2.5)].depth.toFixed(1), 'median peak': `${pct(sorted.slice(third * 2).map(x => x.peak), 0.5).toFixed(1)}%` },
  ]);
}

// ── Verdict ────────────────────────────────────────────────────────────────────────────────
const best = rows.reduce((a, b) => (b._best > a._best ? b : a), { _best: -Infinity } as any);
console.log('');
console.log('─'.repeat(74));
if (best._best === -Infinity) {
  console.log('INCONCLUSIVE — no conditional bucket holds 25+ tokens. Sample too small to slice.');
} else if (best._best > 2) {
  console.log(`HYPOTHESIS: entering 60s after graduation when the first minute was "${best['first 60s']}"`);
  console.log(`gives a median +30m return of ${best._best.toFixed(1)}% across ${best.n} tokens — above the ~2% cost.`);
  console.log('This is IN-SAMPLE. It is a hypothesis, not a result. It needs fresh graduations to');
  console.log('confirm, exactly like the 17.4% pumper number did.');
} else {
  console.log(`CLOSED: best conditional bucket returns ${best._best.toFixed(1)}% — at or below the ~2% cost.`);
  console.log('The graduation tail is no more tradeable than its middle. This one really is dead.');
}
console.log('─'.repeat(74));
