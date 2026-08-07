// scripts/find-wallets.ts
// PROVEN-WALLET FINDER (offline tool — does not touch the live bot or its state)
//
// Two-step workflow:
//   1. collect  — listen for PumpSwap graduations (bonding-curve tokens that survived long
//                 enough to migrate) and record them to data/graduated-tokens.json. Run this
//                 for a few hours in the background; graduation is a strong survivorship
//                 filter on its own (~1% of pump.fun tokens ever get there).
//   2. analyze  — for each graduated token, find wallets that bought early and repeat across
//                 MULTIPLE graduated tokens (that repetition is the actual "proven" signal —
//                 one lucky buy means nothing, showing up early on 3+ winners isn't luck).
//                 Those candidates then get their own trade history pulled and scored
//                 (closed-trade win rate, average hold time). Results are written to
//                 watchlist-candidates.json for manual review — nothing here is auto-copied
//                 into the live watchlist.json used by the wallet-follower.
//
// Usage:
//   npx tsx scripts/find-wallets.ts collect --minutes=120
//   npx tsx scripts/find-wallets.ts analyze --min-appearances=2 --min-trades=8 --min-winrate=0.55 --max-hold=20
//
// Caveat: win/loss reconstruction here reads Helius Enhanced Transactions (nativeTransfers +
// tokenTransfers). Bonding-curve trades move native SOL and are reconstructed accurately; some
// AMM-routed swaps move value via wrapped-SOL token transfers instead, which this script does
// not follow — so AMM-only wallets can come out under-scored. Treat output as a shortlist to
// vet manually (check a few addresses on a Solana explorer), not a final answer.

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import pino from 'pino';
import { CONFIG } from '../config.js';
import { deriveBondingCurve } from '../src/utils.js';
import { watchAmmPoolCreations, AmmPoolInfo } from '../src/pumpswap.js';

const logger = pino({ name: 'find-wallets' });

const GRADUATED_FILE = path.resolve('./data/graduated-tokens.json');
const SCAN_STATE_FILE = path.resolve('./data/scan-state.json');
const CANDIDATES_FILE = path.resolve('./watchlist-candidates.json');
const HELIUS_BASE = 'https://api.helius.xyz/v0/addresses';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadJson<T>(file: string, fallback: T): T {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { /* corrupt or missing — start fresh */ }
  return fallback;
}

function saveJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function heliusGet(url: string, retries = 3): Promise<any[]> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 8000 });
      return res.data || [];
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries) {
        const delay = 2000 * Math.pow(2, attempt);
        logger.debug({ delay, attempt }, 'Helius rate limited — backing off');
        await sleep(delay);
        continue;
      }
      if (status === 429) {
        logger.warn('Helius still rate limited after all retries — skipping this request');
      } else {
        logger.debug({ err: err.message }, 'Helius request failed');
      }
      return [];
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
//  MODE 1: collect — record PumpSwap graduations as they happen
// ─────────────────────────────────────────────────────────────
async function runCollect(minutes: number): Promise<void> {
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');
  const graduated: Array<{ mint: string; poolAddress: string; detectedAt: number }> = loadJson(GRADUATED_FILE, []);
  const seen = new Set(graduated.map(g => g.mint));

  logger.info({ minutes, existing: graduated.length }, '🎓 Listening for PumpSwap graduations...');

  const subId = await watchAmmPoolCreations(connection, (poolInfo: AmmPoolInfo) => {
    const mint = poolInfo.baseMint.toBase58();
    if (seen.has(mint)) return;
    seen.add(mint);
    graduated.push({ mint, poolAddress: poolInfo.poolAddress.toBase58(), detectedAt: Date.now() });
    saveJson(GRADUATED_FILE, graduated);
    logger.info({ mint: mint.slice(0, 8), total: graduated.length }, '🆕 Graduation recorded');
  });

  await sleep(minutes * 60_000);
  connection.removeProgramAccountChangeListener(subId);
  logger.info({ total: graduated.length, file: GRADUATED_FILE }, '✅ Collection window finished');
}

// ─────────────────────────────────────────────────────────────
//  MODE 2: analyze — repeat early buyers → score their history
// ─────────────────────────────────────────────────────────────
async function getEarlyBuyers(mint: string): Promise<string[]> {
  const bondingCurve = deriveBondingCurve(new PublicKey(mint)).toBase58();

  let before: string | undefined;
  let all: any[] = [];
  for (let page = 0; page < 3; page++) {
    const url = `${HELIUS_BASE}/${bondingCurve}/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=100${before ? `&before=${before}` : ''}`;
    const txs = await heliusGet(url);
    if (txs.length === 0) break;
    all = all.concat(txs);
    before = txs[txs.length - 1]?.signature;
    if (txs.length < 100) break; // reached the start of this address's history
    await sleep(1200);
  }
  if (all.length === 0) return [];

  // Helius returns each page newest-first, so the oldest transactions we fetched sit at the
  // end of the accumulated array — that's the early-buyer window we want.
  const earliest = all.slice(-15);
  const buyers = new Set<string>();
  for (const tx of earliest) {
    for (const t of tx.tokenTransfers || []) {
      if (t.mint === mint && t.toUserAccount && t.toUserAccount !== bondingCurve) {
        buyers.add(t.toUserAccount);
      }
    }
  }
  return Array.from(buyers);
}

interface WalletScore {
  closedTrades: number;
  wins: number;
  winRate: number;
  avgHoldMinutes: number;
  oldestActivityDays: number; // lower bound — oldest tx seen within the fetched window, not true wallet age
}

async function scoreWallet(address: string): Promise<WalletScore | null> {
  const url = `${HELIUS_BASE}/${address}/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=100`;
  const txs = await heliusGet(url);
  if (txs.length === 0) return null;

  const byMint = new Map<string, { solIn: number; solOut: number; firstTs: number; lastTs: number }>();
  let oldestSeenTs = Date.now();

  for (const tx of txs) {
    const tokenTransfers: any[] = tx.tokenTransfers || [];
    const nativeTransfers: any[] = tx.nativeTransfers || [];
    const ts = (tx.timestamp || 0) * 1000;
    if (ts > 0) oldestSeenTs = Math.min(oldestSeenTs, ts);

    const solMoved = nativeTransfers
      .filter((n: any) => n.fromUserAccount === address || n.toUserAccount === address)
      .reduce((sum: number, n: any) => sum + (n.fromUserAccount === address ? -n.amount : n.amount), 0) / 1_000_000_000;

    for (const t of tokenTransfers) {
      if (t.mint === WSOL_MINT) continue;
      const isReceive = t.toUserAccount === address;
      const isSend = t.fromUserAccount === address;
      if (!isReceive && !isSend) continue;

      const entry = byMint.get(t.mint) || { solIn: 0, solOut: 0, firstTs: ts, lastTs: ts };
      if (isReceive) entry.solOut += Math.max(0, -solMoved);
      else entry.solIn += Math.max(0, solMoved);
      entry.firstTs = Math.min(entry.firstTs, ts);
      entry.lastTs = Math.max(entry.lastTs, ts);
      byMint.set(t.mint, entry);
    }
  }

  let wins = 0, closedTrades = 0, holdMinutesSum = 0;
  for (const [, v] of byMint) {
    if (v.solOut <= 0 || v.solIn <= 0) continue; // no confirmed buy+sell pair on this mint — skip
    closedTrades++;
    if (v.solIn > v.solOut) wins++;
    holdMinutesSum += Math.max(0, (v.lastTs - v.firstTs) / 60_000);
  }

  if (closedTrades === 0) return null;
  const oldestActivityDays = Math.max(0, (Date.now() - oldestSeenTs) / 86_400_000);
  return { closedTrades, wins, winRate: wins / closedTrades, avgHoldMinutes: holdMinutesSum / closedTrades, oldestActivityDays };
}

interface ScanState {
  scannedMints: string[];
  appearances: Record<string, string[]>;
}

function loadScanState(): { scannedMints: Set<string>; appearances: Map<string, Set<string>> } {
  const raw = loadJson<ScanState>(SCAN_STATE_FILE, { scannedMints: [], appearances: {} });
  const appearances = new Map<string, Set<string>>();
  for (const [wallet, mints] of Object.entries(raw.appearances)) appearances.set(wallet, new Set(mints));
  return { scannedMints: new Set(raw.scannedMints), appearances };
}

function saveScanState(scannedMints: Set<string>, appearances: Map<string, Set<string>>): void {
  const appearancesObj: Record<string, string[]> = {};
  for (const [wallet, mints] of appearances) appearancesObj[wallet] = Array.from(mints);
  saveJson(SCAN_STATE_FILE, { scannedMints: Array.from(scannedMints), appearances: appearancesObj });
}

async function runAnalyze(opts: {
  minAppearances: number; minTrades: number; minWinRate: number; maxHoldMinutes: number; maxCandidates: number; minAgeDays: number; batchSize: number;
}): Promise<void> {
  const graduated: Array<{ mint: string }> = loadJson(GRADUATED_FILE, []);
  if (graduated.length === 0) {
    logger.error('No graduated tokens recorded yet — run `collect` first and let it run for a while.');
    return;
  }
  if (!CONFIG.HELIUS_API_KEY) {
    logger.error('HELIUS_API_KEY not set in .env — required for this step.');
    return;
  }

  // Early-buyer scanning is resumable and incremental: mints already scanned in a previous
  // `analyze` run are skipped, and the accumulated wallet-appearance data persists across runs.
  // pump.fun's graduation rate turned out far higher than expected (4,300+ in a single 3-hour
  // window) — scanning that in one uninterrupted pass would take hours and hammer Helius, so
  // each run only processes up to <batchSize> new mints. Re-run `analyze` repeatedly to chew
  // through the backlog; progress is saved after every mint, so Ctrl+C loses nothing.
  const { scannedMints, appearances } = loadScanState();
  const unscanned = graduated.filter(g => !scannedMints.has(g.mint));
  const batch = unscanned.slice(0, opts.batchSize);

  logger.info(
    { totalGraduated: graduated.length, alreadyScanned: scannedMints.size, thisBatch: batch.length, remainingAfter: unscanned.length - batch.length },
    '🔍 Scanning early buyers of graduated tokens...'
  );

  for (const g of batch) {
    const buyers = await getEarlyBuyers(g.mint);
    for (const b of buyers) {
      if (!appearances.has(b)) appearances.set(b, new Set());
      appearances.get(b)!.add(g.mint);
    }
    scannedMints.add(g.mint);
    saveScanState(scannedMints, appearances);
    await sleep(1200);
  }

  if (unscanned.length - batch.length > 0) {
    logger.warn(
      { remaining: unscanned.length - batch.length },
      '⏳ Batch limit reached — re-run `analyze` again to continue scanning the rest (progress is saved)'
    );
  }

  const repeatWallets = Array.from(appearances.entries())
    .filter(([, mints]) => mints.size >= opts.minAppearances)
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, opts.maxCandidates);

  logger.info({ candidates: repeatWallets.length }, '📊 Scoring candidate wallets against their own trade history...');

  const results: Array<{ address: string; appearances: number; mints: Set<string> } & WalletScore> = [];
  for (const [address, mints] of repeatWallets) {
    const stat = await scoreWallet(address);
    await sleep(1200);
    if (!stat) continue;
    if (stat.closedTrades < opts.minTrades) continue;
    if (stat.winRate < opts.minWinRate) continue;
    if (stat.avgHoldMinutes > opts.maxHoldMinutes) continue;
    results.push({ address, appearances: mints.size, mints, ...stat });
    logger.info({ address: address.slice(0, 8), ...stat }, '✅ Candidate qualifies');
  }

  // ─── Red-flag pass ───
  // A raw win-rate number can't tell you WHY a wallet looks good. Two patterns that inflate
  // scores without meaning "proven trader":
  //   NEW_WALLET  — high win rate but every trade we can see happened in the last <minAgeDays>
  //                 days. Could be a freshly spun-up wallet built to look good, not a track record.
  //   CLUSTERED   — this wallet keeps buying the exact same graduated tokens, early, alongside
  //                 another candidate. That's not two independent smart-money wallets agreeing —
  //                 it's much more likely the same person/bot running multiple wallets, or an
  //                 insider ring sniping its own launches. Following either one means following
  //                 the same source of risk twice.
  for (const r of results) {
    const flags: string[] = [];
    if (r.oldestActivityDays < opts.minAgeDays) {
      flags.push('NEW_WALLET');
    }
    const clusterPartners: string[] = [];
    for (const other of results) {
      if (other.address === r.address) continue;
      const overlap = [...r.mints].filter(m => other.mints.has(m)).length;
      if (overlap >= 2) clusterPartners.push(other.address.slice(0, 6));
    }
    if (clusterPartners.length > 0) flags.push('CLUSTERED');
    (r as any).flags = flags;
    (r as any).clusterPartners = clusterPartners;
  }

  results.sort((a, b) => b.winRate - a.winRate);

  saveJson(CANDIDATES_FILE, {
    generatedAt: new Date().toISOString(),
    criteria: opts,
    wallets: results.map(r => ({
      address: r.address,
      label: r.address.slice(0, 6),
      appearances: r.appearances,
      closedTrades: r.closedTrades,
      winRate: `${(r.winRate * 100).toFixed(0)}%`,
      avgHoldMinutes: Number(r.avgHoldMinutes.toFixed(1)),
      oldestActivityDays: Number(r.oldestActivityDays.toFixed(1)),
      flags: (r as any).flags,
      clusteredWith: (r as any).clusterPartners,
    })),
  });

  const flagged = results.filter(r => (r as any).flags.length > 0).length;
  logger.info(
    { file: CANDIDATES_FILE, qualified: results.length, flagged },
    '✅ Done — review watchlist-candidates.json. Treat any entry with flags as extra scrutiny, not automatic rejection — then copy the ones you trust into watchlist.json'
  );
}

// ─── CLI entry ───
const [, , mode, ...rest] = process.argv;
const argMap: Record<string, string> = {};
for (const a of rest) {
  const [k, v] = a.replace(/^--/, '').split('=');
  if (k && v !== undefined) argMap[k] = v;
}

if (mode === 'collect') {
  runCollect(parseInt(argMap.minutes || '120', 10));
} else if (mode === 'analyze') {
  runAnalyze({
    minAppearances: parseInt(argMap['min-appearances'] || '2', 10),
    minTrades: parseInt(argMap['min-trades'] || '8', 10),
    minWinRate: parseFloat(argMap['min-winrate'] || '0.55'),
    maxHoldMinutes: parseFloat(argMap['max-hold'] || '20'),
    maxCandidates: parseInt(argMap['max-candidates'] || '40', 10),
    minAgeDays: parseFloat(argMap['min-age-days'] || '14'),
    batchSize: parseInt(argMap['batch-size'] || '300', 10),
  });
} else {
  console.log(`Usage:
  npx tsx scripts/find-wallets.ts collect [--minutes=120]
      Listen for PumpSwap graduations and record them to data/graduated-tokens.json

  npx tsx scripts/find-wallets.ts analyze [--min-appearances=2] [--min-trades=8] [--min-winrate=0.55] [--max-hold=20] [--max-candidates=40] [--min-age-days=14] [--batch-size=300]
      Find wallets that bought early on multiple graduated tokens, score their trade
      history, and write qualifying candidates to watchlist-candidates.json.
      Scans up to <batch-size> new graduated tokens per run and saves progress —
      re-run repeatedly to work through a large backlog.
`);
  process.exit(1);
}
