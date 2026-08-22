// scripts/find-pumpers.ts
//
// Who is on the profitable side of the KOTH collapse?
//
// ── Where this comes from ────────────────────────────────────────────────────────────────────
// scripts/measure-koth.ts found that tokens crossing ~150 SOL market cap then fall a median of
// 75% within five minutes. That is not "no edge" — it is adverse selection. Somebody drove those
// tokens 5x off their launch price, and somebody sold into the crowd that chased the crown.
// Whoever that was made money.
//
// The KOTH run identified which specific mints got pumped. That makes the reverse question
// well-defined for the first time in this project: not "find profitable wallets" in the abstract
// (the earlier wallet-finder tried that, checked 40 candidates and qualified none), but "who was
// buying THESE tokens before they were pumped, and do the same wallets recur?"
//
// If a small set of wallets appears early in many independent pumps, that is a cluster, not luck.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// A wallet is a candidate only if it appears as an early buyer in >= 5 distinct pumped tokens.
// Then:
//   >= 3 candidates found   a real cluster exists. Worth testing whether following them is viable.
//   1-2 candidates          too thin to build on; could be coincidence at this sample size.
//   0 candidates            the pumps have no common participants. Either they are unrelated
//                           operators, or the buying happens in launch bundles that never appear
//                           as separate transactions — in which case following is impossible.
//
// ── Honest limits, stated up front ───────────────────────────────────────────────────────────
// 1. Finding a cluster does NOT mean you can profit from it. If they buy inside the creation
//    bundle, their purchase and the token's creation land in the same block and there is nothing
//    to react to. That is the most likely outcome and this script will say so.
// 2. Early-buyer recurrence could also just be generic snipers who buy everything, and therefore
//    appear in pumps by volume rather than by insight. The script reports how many DISTINCT
//    tokens each wallet touched relative to how early it bought, so a spray-and-pray bot looks
//    different from a targeted one.
// 3. Uses Alchemy RPC only. No Helius credits are consumed.
//
// Usage:
//   npx tsx scripts/find-pumpers.ts [--threshold 100] [--early 25]

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { deriveBondingCurve } from '../src/utils.js';

const KOTH_FILE = './data/koth.jsonl';
const OUT_FILE = './data/pumpers.json';

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const THRESHOLD_SOL = parseFloat(argOf('threshold') || '100');
const EARLY_N = parseInt(argOf('early') || '25', 10);   // how many of the first txs count as "early"
const MIN_PUMPS = 5;                                     // committed candidate bar

interface KothSample { mint: string; bornAt: number; offsetMs: number; mcapSol: number; }

main().catch(e => { console.error('failed:', e.message); process.exit(1); });

async function main() {
  if (!fs.existsSync(KOTH_FILE)) {
    console.error(`No ${KOTH_FILE} — run measure-koth.ts first.`);
    process.exit(1);
  }

  // ── Which mints actually got pumped ────────────────────────────────────────────────────────
  const byToken = new Map<string, KothSample[]>();
  for (const line of fs.readFileSync(KOTH_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const s: KothSample = JSON.parse(line);
      if (!s?.mint || !isFinite(s.mcapSol)) continue;
      const a = byToken.get(s.mint);
      if (a) a.push(s); else byToken.set(s.mint, [s]);
    } catch { /* skip malformed */ }
  }

  const pumped = [...byToken.entries()]
    .filter(([, samples]) => samples.some(s => s.mcapSol >= THRESHOLD_SOL))
    .map(([mint]) => mint);

  console.log(`tokens in koth.jsonl: ${byToken.size}`);
  console.log(`pumped past ${THRESHOLD_SOL} SOL: ${pumped.length}`);
  if (pumped.length < 10) {
    console.error(`\nToo few pumped tokens (${pumped.length}) to find recurring wallets.`);
    console.error('Let measure-koth.ts collect longer, or lower --threshold.');
    process.exit(1);
  }
  console.log('');

  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // wallet -> set of pumped mints it bought early
  const walletHits = new Map<string, Set<string>>();
  // wallet -> best (lowest) rank achieved across tokens, to separate targeted from spray-and-pray
  const walletBestRank = new Map<string, number>();

  let processed = 0, skipped = 0;

  for (const mint of pumped) {
    try {
      const curve = deriveBondingCurve(new PublicKey(mint));

      // getSignaturesForAddress returns NEWEST first, so page to the end to reach the earliest
      // activity. Young tokens have few pages; the cap stops a runaway on an unusually busy one.
      let all: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < 10; page++) {
        const sigs = await connection.getSignaturesForAddress(curve, { limit: 1000, before }, 'confirmed');
        if (!sigs.length) break;
        all = all.concat(sigs.map(s => s.signature));
        if (sigs.length < 1000) break;
        before = sigs[sigs.length - 1].signature;
      }
      if (all.length === 0) { skipped++; continue; }

      // Oldest last -> the creation tx and the first buyers are at the tail.
      const earliest = all.slice(-EARLY_N).reverse(); // oldest first

      const txs = await connection.getParsedTransactions(earliest, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });

      const seenThisToken = new Set<string>();
      txs.forEach((tx, rank) => {
        if (!tx) return;
        // The fee payer is the wallet acting. Index 0 of accountKeys is always the payer.
        const payer = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58?.();
        if (!payer) return;
        if (seenThisToken.has(payer)) return;
        seenThisToken.add(payer);

        const hits = walletHits.get(payer) ?? new Set<string>();
        hits.add(mint);
        walletHits.set(payer, hits);

        const prev = walletBestRank.get(payer);
        if (prev === undefined || rank < prev) walletBestRank.set(payer, rank);
      });

      processed++;
      if (processed % 10 === 0) console.log(`  ...${processed}/${pumped.length} tokens scanned`);
      await new Promise(r => setTimeout(r, 150)); // gentle on the RPC
    } catch (err: any) {
      skipped++;
      if (skipped <= 3) console.log(`  skipped ${mint.slice(0, 8)}…: ${err.message}`);
    }
  }

  console.log(`\nscanned ${processed} tokens, skipped ${skipped}\n`);

  // ── Who recurs ─────────────────────────────────────────────────────────────────────────────
  const ranked = [...walletHits.entries()]
    .map(([wallet, mints]) => ({
      wallet,
      pumps: mints.size,
      bestRank: walletBestRank.get(wallet) ?? 999,
      share: mints.size / processed * 100,
    }))
    .filter(w => w.pumps >= 2)
    .sort((a, b) => b.pumps - a.pumps);

  console.log(`wallets appearing early in 2+ pumps: ${ranked.length}`);
  console.log('');
  console.log('Top 20 recurring early buyers:');
  console.table(ranked.slice(0, 20).map(w => ({
    wallet: `${w.wallet.slice(0, 6)}…${w.wallet.slice(-4)}`,
    pumps: w.pumps,
    'of scanned': `${w.share.toFixed(0)}%`,
    'earliest rank': w.bestRank,
  })));

  const candidates = ranked.filter(w => w.pumps >= MIN_PUMPS);
  fs.writeFileSync(OUT_FILE, JSON.stringify({ threshold: THRESHOLD_SOL, scanned: processed, ranked }, null, 2));
  console.log(`\nfull list written to ${OUT_FILE}`);

  console.log('');
  console.log('─'.repeat(74));
  if (candidates.length >= 3) {
    console.log(`FOUND: ${candidates.length} wallets appear early in ${MIN_PUMPS}+ separate pumps.`);
    console.log('That is a cluster, not coincidence. Next question is whether they can be followed —');
    console.log('check "earliest rank": a rank of 0-2 means they buy in or beside the creation');
    console.log('bundle, which cannot be reacted to. A rank of 5+ means there is a window.');
  } else if (candidates.length > 0) {
    console.log(`THIN: only ${candidates.length} wallet(s) hit ${MIN_PUMPS}+ pumps. At this sample size`);
    console.log('that can be coincidence. Collect more KOTH data before trusting it.');
  } else {
    console.log(`NONE: no wallet appears early in ${MIN_PUMPS}+ pumps.`);
    console.log('The pumps share no common participants. Most likely the buying happens inside the');
    console.log('creation bundle, where the purchase and the token launch land in the same block and');
    console.log('there is nothing to follow. That would confirm the positional thesis directly.');
  }
  console.log('─'.repeat(74));
}
