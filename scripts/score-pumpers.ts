// scripts/score-pumpers.ts
//
// Are the recurring early buyers SELECTIVE, or do they just buy everything?
//
// ── Where this comes from ────────────────────────────────────────────────────────────────────
// find-pumpers.ts found 27 wallets appearing early in 5+ of the 62 tokens that pumped past
// 100 SOL market cap — the top one in 24 of them, another in 23 at rank 5 (outside the creation
// bundle, so reactable). That is the first positive signal in this project.
//
// But it is not yet evidence of anything. find-pumpers.ts only looked at tokens that PUMPED. A
// bot that indiscriminately buys every new launch would appear in 100% of pumps by construction
// and be completely worthless to follow. Appearing in 39% of winners means nothing until you know
// what fraction of losers it also bought.
//
// koth.jsonl holds ~1,540 tracked tokens that never pumped. This scores each candidate against
// them.
//
// ── The number that decides it ───────────────────────────────────────────────────────────────
// If you blindly copied a wallet's buys, what fraction would have been pumps?
//
//   precision = pumpsBought / (pumpsBought + dudsBought)
//
// Break-even maths for the follow trade: enter beside them near launch (~28-35 SOL mcap), exit at
// the crown (~100-150 SOL), so a winner is roughly +400%. Cut the rest at -25%. Break-even needs:
//
//   p * 400 - (1 - p) * 25 = 0   ->   p ≈ 5.9%
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
//   precision > 12%    comfortably clears break-even with room for fees and slippage. Build it.
//   6% to 12%          above break-even but thin. Real, but fragile. Probably not worth it.
//   <= 6%              the wallet is a spray-and-pray bot. Following it loses money.
//
// Rates are extrapolated from a SAMPLE of duds, not all of them, so the script reports the sample
// size and scales honestly rather than pretending it scanned everything.
//
// Usage:
//   npx tsx scripts/score-pumpers.ts [--threshold 100] [--duds 250] [--top 12]

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { deriveBondingCurve } from '../src/utils.js';

const KOTH_FILE = './data/koth.jsonl';
const PUMPERS_FILE = './data/pumpers.json';

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const THRESHOLD_SOL = parseFloat(argOf('threshold') || '100');
const DUD_SAMPLE = parseInt(argOf('duds') || '250', 10);
const TOP_N = parseInt(argOf('top') || '12', 10);
const EARLY_N = 25; // must match find-pumpers.ts

interface KothSample { mint: string; mcapSol: number; }

main().catch(e => { console.error('failed:', e.message); process.exit(1); });

async function main() {
  if (!fs.existsSync(KOTH_FILE) || !fs.existsSync(PUMPERS_FILE)) {
    console.error('Need both koth.jsonl and pumpers.json — run measure-koth.ts then find-pumpers.ts.');
    process.exit(1);
  }

  // ── Split tracked tokens into pumped and duds ──────────────────────────────────────────────
  const peak = new Map<string, number>();
  for (const line of fs.readFileSync(KOTH_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const s: KothSample = JSON.parse(line);
      if (!s?.mint || !isFinite(s.mcapSol)) continue;
      peak.set(s.mint, Math.max(peak.get(s.mint) ?? 0, s.mcapSol));
    } catch { /* skip */ }
  }
  const pumpedCount = [...peak.values()].filter(m => m >= THRESHOLD_SOL).length;
  const duds = [...peak.entries()].filter(([, m]) => m < THRESHOLD_SOL).map(([mint]) => mint);

  // Deterministic spread across the file rather than the first N, so the sample is not all from
  // one hour of the collection run.
  const step = Math.max(1, Math.floor(duds.length / DUD_SAMPLE));
  const dudSample = duds.filter((_, i) => i % step === 0).slice(0, DUD_SAMPLE);

  const pumpers = JSON.parse(fs.readFileSync(PUMPERS_FILE, 'utf8'));
  const candidates: Array<{ wallet: string; pumps: number; bestRank: number }> =
    (pumpers.ranked ?? []).filter((w: any) => w.pumps >= 5).slice(0, TOP_N);

  if (!candidates.length) { console.error('No candidates with 5+ pumps in pumpers.json.'); process.exit(1); }

  console.log(`pumped tokens:  ${pumpedCount}`);
  console.log(`dud tokens:     ${duds.length}  (sampling ${dudSample.length})`);
  console.log(`candidates:     ${candidates.length}`);
  console.log('');

  const watch = new Set(candidates.map(c => c.wallet));
  const dudHits = new Map<string, number>();
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  let scanned = 0, skipped = 0;
  for (const mint of dudSample) {
    try {
      const curve = deriveBondingCurve(new PublicKey(mint));
      let all: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < 10; page++) {
        const sigs = await connection.getSignaturesForAddress(curve, { limit: 1000, before }, 'confirmed');
        if (!sigs.length) break;
        all = all.concat(sigs.map(s => s.signature));
        if (sigs.length < 1000) break;
        before = sigs[sigs.length - 1].signature;
      }
      if (!all.length) { skipped++; continue; }

      const earliest = all.slice(-EARLY_N).reverse();
      const txs = await connection.getParsedTransactions(earliest, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      const seen = new Set<string>();
      for (const tx of txs) {
        if (!tx) continue;
        const payer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58?.();
        if (!payer || seen.has(payer) || !watch.has(payer)) continue;
        seen.add(payer);
        dudHits.set(payer, (dudHits.get(payer) ?? 0) + 1);
      }

      scanned++;
      if (scanned % 25 === 0) console.log(`  ...${scanned}/${dudSample.length} duds scanned`);
      await new Promise(r => setTimeout(r, 150));
    } catch {
      skipped++;
    }
  }

  console.log(`\nscanned ${scanned} duds, skipped ${skipped}\n`);

  // ── Score ──────────────────────────────────────────────────────────────────────────────────
  const scale = duds.length / Math.max(1, scanned); // extrapolate sampled duds to the full set
  const scored = candidates.map(c => {
    const sampled = dudHits.get(c.wallet) ?? 0;
    const estDuds = sampled * scale;
    const precision = c.pumps / Math.max(1e-9, c.pumps + estDuds) * 100;
    // Expected value per followed trade: winner ~+400% (launch to crown), loser cut at -25%.
    const ev = (precision / 100) * 400 - (1 - precision / 100) * 25;
    return { ...c, sampled, estDuds, precision, ev };
  }).sort((a, b) => b.precision - a.precision);

  console.log('Selectivity of each candidate (dud rate extrapolated from the sample):');
  console.table(scored.map(s => ({
    wallet: `${s.wallet.slice(0, 6)}…${s.wallet.slice(-4)}`,
    pumps: s.pumps,
    'duds (est)': Math.round(s.estDuds),
    precision: `${s.precision.toFixed(1)}%`,
    'EV/trade': `${s.ev >= 0 ? '+' : ''}${s.ev.toFixed(0)}%`,
    rank: s.bestRank,
  })));

  const best = scored[0];
  // A wallet buying in the creation bundle cannot be followed no matter how selective it is.
  const followable = scored.filter(s => s.bestRank >= 3);
  const bestFollowable = followable[0];

  console.log('');
  console.log('─'.repeat(74));
  if (!bestFollowable) {
    console.log('DEAD END: every selective wallet buys at rank 0-2, i.e. inside or beside the');
    console.log('creation bundle. Their buy and the token launch land in the same block, so there');
    console.log('is nothing to react to. Confirms the positional thesis.');
  } else if (bestFollowable.precision > 12) {
    console.log(`BUILD IT: ${bestFollowable.wallet.slice(0, 6)}… has ${bestFollowable.precision.toFixed(1)}% precision at rank ${bestFollowable.bestRank}.`);
    console.log(`Clears the ~5.9% break-even comfortably. EV ≈ ${bestFollowable.ev.toFixed(0)}% per followed trade.`);
    console.log('Next step is a live DRY_RUN follower to confirm it out of sample.');
  } else if (bestFollowable.precision > 6) {
    console.log(`THIN: best followable is ${bestFollowable.precision.toFixed(1)}% precision — above the ~5.9%`);
    console.log('break-even but with no margin for fees, slippage or a bad week. Fragile.');
  } else {
    console.log(`SPRAY: best followable precision is ${bestFollowable.precision.toFixed(1)}%, below the ~5.9%`);
    console.log('break-even. These wallets buy nearly everything; showing up in pumps is a volume');
    console.log('artefact, not selection. Following them loses money.');
  }
  if (best && bestFollowable && best.wallet !== bestFollowable.wallet) {
    console.log(`(Most selective overall was ${best.wallet.slice(0, 6)}… at ${best.precision.toFixed(1)}%, but rank ${best.bestRank} = unfollowable.)`);
  }
  console.log('─'.repeat(74));
}
