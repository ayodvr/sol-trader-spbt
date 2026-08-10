// scripts/replay-exits.ts
//
// Replay the recorded price paths of real positions against alternative exit rules.
//
// The 156-trade dry-run sample produced a clear structure: stop losses cost -37.1% each (against
// a -20% setting, because a 2s poll gaps straight through the trigger), while take-profits paid
// +148% each. The question that decides whether this strategy is salvageable is whether some
// other combination of take-profit / stop-loss / trailing-stop / max-hold turns the sample
// positive. exit-manager logs every 2s tick to data/price-ticks.jsonl, so that question can be
// answered from data already on disk — no live run, no API spend.
//
// ── What this can and cannot tell you ────────────────────────────────────────────────────────
// Tick logging STOPS when a position exits. So the recorded path of each position is censored at
// whatever the live rules did. That means:
//
//   * Rules that exit EARLIER than the live run did are fully testable — the ticks exist.
//     (Lower take-profit, tighter stop, tighter trailing stop, shorter max-hold.)
//   * Rules that exit LATER are NOT testable — the data simply does not exist past the live exit.
//     A wider stop loss is unknowable from this sample; the script reports those as censored
//     rather than silently assuming the position closed at the last tick.
//
// Read any row with a high censored count as "unknown", not as "measured".
//
// Usage:
//   npx tsx scripts/replay-exits.ts                  # sweep a default grid
//   npx tsx scripts/replay-exits.ts --tp 35 --sl 20 --trail 10 --hold 10   # single config

import fs from 'fs';

const TICK_FILE = './data/price-ticks.jsonl';
// price-ticks.jsonl is append-only and has been accumulating since before the bonding-curve byte
// offsets were fixed, so it still contains the era when reserves were read out of random pooled
// Buffer memory and produced changePercent values in the quadrillions. A first run of this script
// over the raw file returned 26 trillion SOL: a handful of corrupt paths swamped everything.
// trades.jsonl, by contrast, was created fresh on the verified build, so its mints identify
// exactly the positions whose prices are known to have been computed correctly. Replay only
// those.
const TRADE_FILE = './data/trades.jsonl';
const ENTRY_SOL = 0.05;
// Same ceiling exit-manager uses to reject garbage reserve reads. Any tick beyond it is a bad
// read by definition, not a real price, and must never reach the P&L sum.
const IMPLAUSIBLE_GAIN_PERCENT = 2000;
// Matches the dry-run cost model in exit-manager.executeExit: ~1% pump.fun fee + Sender tip +
// a little price impact on a ~0.05 SOL exit. Kept identical so replayed numbers are directly
// comparable to the live dry-run results rather than optimistic against them.
const EXECUTION_HAIRCUT = 0.95;

interface Tick {
  mint: string;
  entryTimestamp: number;
  elapsedMs: number;
  source?: string;
  changePercent: number;
}

interface Params { tp: number; sl: number; trail: number; holdMin: number; }

interface Outcome {
  pnlSol: number;
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'timeout' | 'censored';
}

if (!fs.existsSync(TICK_FILE)) {
  console.error(`No tick file at ${TICK_FILE} — nothing to replay.`);
  process.exit(1);
}

// ── Load and group ticks into per-position paths ─────────────────────────────────────────────
const ticks: Tick[] = fs.readFileSync(TICK_FILE, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter((t): t is Tick => !!t && typeof t.changePercent === 'number');

// Restrict to the mints in trades.jsonl — the verified-build sample. Everything else in the tick
// file predates the offset fixes and cannot be trusted.
if (!fs.existsSync(TRADE_FILE)) {
  console.error(`No ${TRADE_FILE} — cannot identify which recorded paths are trustworthy.`);
  process.exit(1);
}
const trustedMints = new Set<string>();
for (const line of fs.readFileSync(TRADE_FILE, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const t = JSON.parse(line);
    if (t.source !== 'amm' && t.mint) trustedMints.add(t.mint);
  } catch { /* skip malformed line */ }
}

// A mint can be sniped more than once across restarts, so entryTimestamp is part of the key.
const paths = new Map<string, Tick[]>();
let droppedCorrupt = 0;
for (const t of ticks) {
  if (t.source === 'amm') continue; // bonding-curve track only
  if (!trustedMints.has(t.mint)) continue;
  if (!isFinite(t.changePercent) || t.changePercent > IMPLAUSIBLE_GAIN_PERCENT || t.changePercent < -100) {
    droppedCorrupt++;
    continue;
  }
  const key = `${t.mint}:${t.entryTimestamp}`;
  const arr = paths.get(key);
  if (arr) arr.push(t); else paths.set(key, [t]);
}
for (const arr of paths.values()) arr.sort((a, b) => a.elapsedMs - b.elapsedMs);

console.log(`trades.jsonl mints (bonding curve): ${trustedMints.size}`);
console.log(`ticks in file: ${ticks.length} — of which trusted and plausible: ${
  [...paths.values()].reduce((n, a) => n + a.length, 0)
}${droppedCorrupt ? ` (${droppedCorrupt} dropped as corrupt)` : ''}`);

/** Replay one recorded path against one rule set. */
function replay(path: Tick[], p: Params): Outcome {
  let high = 0; // high-water mark in percent-from-entry terms; entry is 0 by definition
  for (const t of path) {
    const pc = t.changePercent;
    if (pc > high) high = pc;

    if (pc >= p.tp) return settle(pc, 'take_profit');
    if (pc <= -p.sl) return settle(pc, 'stop_loss');
    // Trailing stop only arms once the position has actually been in profit, matching
    // exit-manager's `highWaterMark > entryPrice` guard.
    if (high > 0) {
      const dropFromPeak = ((high - pc) / (100 + high)) * 100;
      if (dropFromPeak >= p.trail) return settle(pc, 'trailing_stop');
    }
    if (t.elapsedMs >= p.holdMin * 60_000) return settle(pc, 'timeout');
  }
  // Ran out of recorded ticks without any rule firing: the live run closed this position before
  // these rules would have. The rest of its path was never recorded, so the outcome is unknown.
  return { pnlSol: 0, reason: 'censored' };
}

function settle(changePercent: number, reason: Outcome['reason']): Outcome {
  const returned = Math.max(0, ENTRY_SOL * (1 + changePercent / 100) * EXECUTION_HAIRCUT);
  return { pnlSol: returned - ENTRY_SOL, reason };
}

function evaluate(p: Params) {
  const byReason: Record<string, { n: number; pnl: number }> = {};
  let net = 0, wins = 0, censored = 0, decided = 0;
  for (const path of paths.values()) {
    const o = replay(path, p);
    if (o.reason === 'censored') { censored++; continue; }
    decided++;
    net += o.pnlSol;
    if (o.pnlSol > 0) wins++;
    byReason[o.reason] = byReason[o.reason] || { n: 0, pnl: 0 };
    byReason[o.reason].n++;
    byReason[o.reason].pnl += o.pnlSol;
  }
  return { p, net, wins, decided, censored, byReason };
}

// ── Single config, or a sweep ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function arg(name: string): number | null {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? parseFloat(argv[i + 1]) : null;
}

const tickCounts = [...paths.values()].map(a => a.length).sort((a, b) => a - b);
console.log(`positions with recorded paths: ${paths.size}`);
console.log(`ticks per position — median ${tickCounts[Math.floor(paths.size / 2)]}, max ${tickCounts[tickCounts.length - 1]}`);
console.log('');
if (tickCounts[Math.floor(paths.size / 2)] <= 2) {
  console.log('⚠️  Half these positions have 2 or fewer recorded ticks, i.e. they were entered and');
  console.log('   exited within ~4 seconds. There is almost no price path to replay, so alternative');
  console.log('   rule sets have very little room to behave differently. Treat the sweep as weak');
  console.log('   evidence and read the censored column carefully.');
  console.log('');
}

const single = arg('tp') !== null || arg('sl') !== null;
if (single) {
  const p: Params = {
    tp: arg('tp') ?? 100,
    sl: arg('sl') ?? 20,
    trail: arg('trail') ?? 10,
    holdMin: arg('hold') ?? 10,
  };
  const r = evaluate(p);
  console.log(`TP +${p.tp}% / SL -${p.sl}% / trail ${p.trail}% / hold ${p.holdMin}m`);
  console.log(`  net ${r.net.toFixed(4)} SOL over ${r.decided} decided (${r.censored} censored)`);
  console.log(`  wins ${r.wins}/${r.decided} (${(r.wins / r.decided * 100).toFixed(1)}%)`);
  console.table(r.byReason);
} else {
  const results = [];
  for (const tp of [20, 35, 50, 75, 100, 150])
    for (const sl of [10, 15, 20, 25, 30])
      for (const trail of [10, 15, 25, 40])
        for (const holdMin of [2, 5, 10])
          results.push(evaluate({ tp, sl, trail, holdMin }));

  results.sort((a, b) => b.net - a.net);
  console.log('top 20 rule sets by net P&L (censored = outcome unknowable from this sample):');
  console.log('');
  console.table(results.slice(0, 20).map(r => ({
    TP: `+${r.p.tp}%`,
    SL: `-${r.p.sl}%`,
    trail: `${r.p.trail}%`,
    hold: `${r.p.holdMin}m`,
    net: r.net.toFixed(4),
    decided: r.decided,
    censored: r.censored,
    winRate: `${(r.wins / Math.max(1, r.decided) * 100).toFixed(1)}%`,
  })));

  const live = results.find(r => r.p.tp === 100 && r.p.sl === 20 && r.p.trail === 10 && r.p.holdMin === 10);
  if (live) {
    console.log('');
    console.log(`for reference, the live configuration (TP+100/SL-20/trail10/hold10m) replays to ${live.net.toFixed(4)} SOL`);
    console.log('— if that does not roughly match the -1.1088 SOL actually observed, the replay is not faithful and');
    console.log('  nothing else in this table should be trusted.');
  }
}
