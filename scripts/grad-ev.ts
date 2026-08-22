// scripts/grad-ev.ts
//
// Expected value of the graduation trade — the statistic that actually decides it.
//
// ── Why this exists ──────────────────────────────────────────────────────────────────────────
// dissect-graduations.ts reported medians. Every conditional bucket came back at 0.0%, which
// looks like death. But the same output showed 4.5% of graduations doubling, 3.6% tripling, and a
// p90 of +131% inside the "up >25% in the first minute" bucket.
//
// For a power-law payoff the median is the wrong statistic. Nine tokens returning 0% and one
// returning +131% gives a median of 0% and a mean of +13%. The median says dead; the mean says
// tradeable. Reporting medians is the same error that closed the graduation book the first time,
// and it was made twice.
//
// This computes mean and expected value under an actual exit rule.
//
// ── Data quality, handled rather than ignored ────────────────────────────────────────────────
// The dissect run reported a max of 16,437,794%. That is a corrupt read, not a 164,000x — almost
// certainly a pool whose base reserve was near zero when sampled. A single value like that
// destroys any mean. Anything beyond IMPLAUSIBLE_GAIN is dropped, matching the ceiling
// exit-manager already uses against bad reserve reads.
//
// Separately: the lowest third of detected pools showed a median depth of 2.3 SOL. A real
// pump.fun graduation seeds far more than that, so some detected 301-byte accounts are probably
// not pump.fun migrations at all. Results are therefore reported both for everything and for
// pools with credible depth, so that ambiguity is visible instead of buried.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Net EV per trade of the best conditional bucket holding >= 25 tokens, after 2% round-trip cost:
//   > +5%       a real tail edge. Worth confirming out of sample.
//   0% to +5%   positive but inside the noise at this sample size.
//   <= 0%       the tail does not pay either. Graduations are properly closed.
//
// And the caveat that outranks any number below: this is IN-SAMPLE. The buckets were chosen after
// seeing the data. A positive result is a hypothesis needing fresh graduations, exactly like the
// 17.4% pumper figure.
//
// Usage:
//   npx tsx scripts/grad-ev.ts [--tp 50] [--sl 25] [--mindepth 20]

import fs from 'fs';

const FILE = './data/graduations.jsonl';
const IMPLAUSIBLE_GAIN = 2000;   // %, same ceiling exit-manager uses
const COST_PCT = 2;              // round trip: no Jito tip needed, this is not a race

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const TP = parseFloat(argOf('tp') || '50');
const SL = parseFloat(argOf('sl') || '25');
const MIN_DEPTH = parseFloat(argOf('mindepth') || '20');

interface Sample { pool: string; gradAt: number; offsetMs: number; price: number; quoteReserve: string; }

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

const mean = (xs: number[]) => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
const ret = (a: number, b: number) => (b - a) / a * 100;
const at = (g: Sample[], ms: number) => g.find(s => s.offsetMs >= ms) ?? null;
const depthOf = (g: Sample[]) => { try { return Number(BigInt(g[0].quoteReserve)) / 1e9; } catch { return NaN; } };

/** Walk the recorded path applying TP/SL, then exit at whatever is left. Returns net % after cost. */
function simulate(path: Sample[], fromIdx: number): number | null {
  const entry = path[fromIdx]?.price;
  if (!entry || entry <= 0) return null;
  for (let i = fromIdx + 1; i < path.length; i++) {
    const r = ret(entry, path[i].price);
    if (!isFinite(r) || r > IMPLAUSIBLE_GAIN) return null;   // corrupt read — discard the path
    if (r >= TP) return TP - COST_PCT;
    if (r <= -SL) return -SL - COST_PCT;
  }
  const last = ret(entry, path[path.length - 1].price);
  if (!isFinite(last) || last > IMPLAUSIBLE_GAIN) return null;
  return last - COST_PCT;
}

const all = [...paths.values()].filter(a => a.length >= 3);
const credible = all.filter(g => { const d = depthOf(g); return isFinite(d) && d >= MIN_DEPTH; });

console.log(`graduations:            ${all.length}`);
console.log(`with >=${MIN_DEPTH} SOL depth:    ${credible.length}`);
console.log(`exit rule:              TP +${TP}% / SL -${SL}%, ${COST_PCT}% round-trip cost\n`);

const buckets: Array<{ label: string; test: (r: number) => boolean }> = [
  { label: 'buy at graduation (no filter)', test: () => true },
  { label: 'first 60s down >5%', test: r => r <= -5 },
  { label: 'first 60s flat (-5% to +10%)', test: r => r > -5 && r <= 10 },
  { label: 'first 60s up >10%', test: r => r > 10 },
  { label: 'first 60s up >25%', test: r => r > 25 },
];

function evaluate(set: Sample[][], label: string) {
  console.log(`── ${label} ──`);
  const rows = buckets.map(b => {
    const results: number[] = [];
    for (const g of set) {
      const p0 = g[0];
      if (!p0) continue;
      let fromIdx = 0;
      if (b.label !== 'buy at graduation (no filter)') {
        const i60 = g.findIndex(s => s.offsetMs >= 60_000);
        if (i60 <= 0) continue;
        const first = ret(p0.price, g[i60].price);
        if (!isFinite(first) || first > IMPLAUSIBLE_GAIN) continue;
        if (!b.test(first)) continue;
        fromIdx = i60;   // entry price is the 60s price — what you would actually pay
      }
      const r = simulate(g, fromIdx);
      if (r !== null) results.push(r);
    }
    const m = mean(results);
    return {
      entry: b.label,
      n: results.length,
      'net EV': results.length ? `${m >= 0 ? '+' : ''}${m.toFixed(1)}%` : 'n/a',
      'win rate': results.length ? `${(results.filter(x => x > 0).length / results.length * 100).toFixed(0)}%` : 'n/a',
      'best': results.length ? `+${Math.max(...results).toFixed(0)}%` : 'n/a',
      _ev: results.length >= 25 ? m : -Infinity,
      _n: results.length,
    };
  });
  console.table(rows.map(({ _ev, _n, ...r }) => r));
  return rows;
}

const rowsAll = evaluate(all, 'ALL detected pools');
console.log('');
const rowsCred = credible.length >= 50 ? evaluate(credible, `POOLS WITH >=${MIN_DEPTH} SOL DEPTH`) : [];

// Verdict reads off the credible set when there is enough of it — thin pools may not be real
// pump.fun graduations, and a result that only survives on those is not a result.
const rows = rowsCred.length ? rowsCred : rowsAll;
const best = rows.reduce((a, b) => (b._ev > a._ev ? b : a), { _ev: -Infinity, entry: 'n/a', _n: 0 } as any);

console.log('');
console.log('─'.repeat(74));
if (best._ev === -Infinity) {
  console.log('INCONCLUSIVE — no bucket holds 25+ tokens after filtering. Sample too small to slice.');
} else if (best._ev > 5) {
  console.log(`HYPOTHESIS: "${best.entry}" gives net EV ${best._ev.toFixed(1)}% per trade across ${best._n} tokens,`);
  console.log(`after ${COST_PCT}% costs, with TP +${TP}%/SL -${SL}%.`);
  console.log('IN-SAMPLE — the buckets were chosen after seeing the data. This is a hypothesis, not');
  console.log('a result. It needs fresh graduations to confirm, like the 17.4% pumper figure did.');
} else if (best._ev > 0) {
  console.log(`THIN: best is "${best.entry}" at ${best._ev.toFixed(1)}% net EV — positive but inside the`);
  console.log('noise at this sample size, and that is before out-of-sample decay.');
} else {
  console.log(`CLOSED: best bucket is ${best._ev.toFixed(1)}% net EV. The tail does not pay either.`);
  console.log('Median said dead, mean says dead. Graduations are properly finished this time.');
}
console.log('─'.repeat(74));
