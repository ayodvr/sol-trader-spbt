// src/index.ts  — Pump.fun Sniper Bot v3.2
// Full integration: gRPC/WS watcher → anti-rug → Jito buy →
// position tracking → auto sell at profit/stop-loss → Telegram alerts

import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CONFIG } from '../config.js';
import { GrpcWatcher } from './grpc-watcher.js';
import { GrpcWatcherV5 } from './grpc-watcher-triton-v5.js'; // Fix 19: Triton v5 NaaE
import { PumpWatcher } from './watcher.js';
import { RugAnalyzer } from './analyzer.js';
import { nativeSnipe } from './native-sniper.js'; // Fix 12: Rust-backed primary buy
import { ExitManager } from './exit-manager.js';
import { WalletManager } from './multi-wallet.js';
import { TelegramNotifier } from './telegram.js';
import { watchAmmPoolCreations, ammBuy, AmmPoolInfo } from './pumpswap.js';
import { decodePrivateKey } from './utils.js';
import { NewTokenEvent } from './types.js';
import { startApi } from './api.js';
import pino from 'pino';
import fs from 'fs';

// Persist bot running state across pm2 restarts
const BOT_STATE_FILE = './bot-state.json';
function loadPersistedRunning(): boolean {
  try {
    if (fs.existsSync(BOT_STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(BOT_STATE_FILE, 'utf-8'));
      return data.isRunning !== false; // default to true if not explicitly false
    }
  } catch { }
  return true;
}
function savePersistedRunning(value: boolean) {
  try { fs.writeFileSync(BOT_STATE_FILE, JSON.stringify({ isRunning: value })); } catch { }
}

// In-memory log buffer for dashboard
const recentLogs: any[] = [];
const customLogger = {
  write: (msg: string) => {
    try {
      const parsed = JSON.parse(msg);
      recentLogs.unshift(parsed);
      if (recentLogs.length > 50) recentLogs.pop();
    } catch (e) { }
    process.stdout.write(msg);
  }
};

const logger = pino({ name: 'main' }, customLogger);
const MASTER_WALLET_PATH = './wallets.json';
const USE_GRPC = !!(process.env.GRPC_ENDPOINT && process.env.GRPC_TOKEN);
const USE_TRITON_V5 = process.env.GRPC_USE_TRITON_V5 === 'true'; // Fix 19: Triton v5 opt-in

async function main() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║        PUMP.FUN SNIPER BOT v3.2 — gRPC              ║
║     [ ${USE_GRPC ? '✅ Yellowstone gRPC' : '⚠️  WebSocket (no gRPC)'} ]                    ║
╚══════════════════════════════════════════════════════╝
  `);

  // ─── Load master wallet ───
  const masterKeypair = Keypair.fromSecretKey(decodePrivateKey(CONFIG.PRIVATE_KEY));
  logger.info(`Master wallet: ${masterKeypair.publicKey.toBase58()}`);

  // ─── Wallet rotation ───
  const walletManager = new WalletManager(MASTER_WALLET_PATH, 0.5);
  logger.info(JSON.stringify(walletManager.getStats(), null, 2));

  // ─── Telegram ───
  const telegram = new TelegramNotifier(
    process.env.TELEGRAM_BOT_TOKEN || '',
    process.env.TELEGRAM_CHAT_ID || ''
  );

  // ─── Shared components ───
  const analyzer = new RugAnalyzer();
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // ─── Stats ───
  const stats = {
    totalBondingCurveSnipes: 0,
    totalAmmSnipes: 0,
    successfulExits: 0,
    rugSkips: 0,
    totalPnl: 0,
    startTime: Date.now(),
    totalLatencyMs: [] as number[],
  };

  // ─── AMM pool dedup set (persisted to disk to survive restarts & prevent replay burn) ───
  const SEEN_POOLS_FILE = './seen-pools.json';
  const SEEN_POOL_TTL_MS = 60 * 60 * 1000; // 1 hour TTL
  const seenAmmPoolsMap = new Map<string, number>(); // poolKey → timestamp first seen
  try {
    if (fs.existsSync(SEEN_POOLS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(SEEN_POOLS_FILE, 'utf-8'));
      const now = Date.now();
      for (const [k, t] of Object.entries(raw)) {
        if (now - (t as number) < SEEN_POOL_TTL_MS) seenAmmPoolsMap.set(k, t as number);
      }
      logger.info({ loaded: seenAmmPoolsMap.size }, 'Loaded seen pools from disk');
    }
  } catch { /* fresh start */ }
  function hasSeenPool(key: string): boolean { return seenAmmPoolsMap.has(key); }
  function markPoolSeen(key: string): void {
    seenAmmPoolsMap.set(key, Date.now());
    // Persist every 50 new pools to avoid excessive disk writes
    if (seenAmmPoolsMap.size % 50 === 0) {
      fs.writeFileSync(SEEN_POOLS_FILE, JSON.stringify(Object.fromEntries(seenAmmPoolsMap)));
    }
  }

  // ─── Concurrency limiter for analysis ─────────────────────────────────────
  // DRY_RUN: conservative limits to stay within Chainstack free-tier (25 RPS)
  // Live:    higher limits — paid RPC plans have the headroom for fast sniping
  let activeAnalyses = 0;
  const MAX_CONCURRENT_ANALYSES = CONFIG.DRY_RUN ? 3 : 8;
  const MAX_QUEUE_DEPTH = CONFIG.DRY_RUN ? 20 : 100;
  // ─── Max open positions cap (DRY_RUN=10, live=unlimited) ───
  const MAX_OPEN_POSITIONS = CONFIG.DRY_RUN ? 10 : 9999;
  const analysisQueue: Array<() => void> = [];
  function runAnalysis(fn: () => Promise<void>) {
    const task = async () => {
      activeAnalyses++;
      try { await fn(); } finally {
        activeAnalyses--;
        if (analysisQueue.length > 0) analysisQueue.shift()!();
      }
    };
    if (activeAnalyses < MAX_CONCURRENT_ANALYSES) task();
    else if (analysisQueue.length < MAX_QUEUE_DEPTH) analysisQueue.push(task);
    else logger.debug({ queueDepth: analysisQueue.length }, 'Analysis queue full — dropping pool');
  }

  // ─── Refill wallets  // Initial refill check (distribute 0.8 SOL to each sub-wallet if they need it)
  await walletManager.refillWallets(masterKeypair, 0.3, 0.8);

  // ─── API Integration ───
  const exitManagers: ExitManager[] = [];
  const tradeHistory: any[] = [];
  const botState = {
    isRunning: loadPersistedRunning(),
    get isTestMode() { return CONFIG.DRY_RUN; },
    stats,
    get activePositions() {
      // Return currently open positions across all managers, ensuring bigint is serialized
      return exitManagers.flatMap(em => em.getPositions()).map(p => ({
        ...p,
        tokenBalance: p.tokenBalance.toString()
      }));
    },
    get tradeHistory() { return tradeHistory; },
    walletStats: () => walletManager.getStats(),
    get recentLogs() { return recentLogs; }
  };

  let activeWatcher: { start: (cb: any) => Promise<void> | void, stop: () => void } | null = null;
  const watcherCallback = handleNewBondingCurveToken;

  const botControls = {
    start: () => {
      botState.isRunning = true;
      savePersistedRunning(true);
      logger.info('Bot started via API');
      if (activeWatcher) {
        activeWatcher.start(watcherCallback);
      }
    },
    stop: () => {
      botState.isRunning = false;
      savePersistedRunning(false);
      logger.info('Bot paused via API');
      if (activeWatcher) {
        activeWatcher.stop();
      }
    },
    updateConfig: (updates: Record<string, string>) => {
      let modeChanged = false;

      if (updates.DRY_RUN !== undefined) {
        const isDryRun = updates.DRY_RUN === 'true';
        if (CONFIG.DRY_RUN !== isDryRun) {
          CONFIG.DRY_RUN = isDryRun;
          modeChanged = true;
          logger.info(`Switched DRY_RUN mode to ${isDryRun}`);
        }
      }

      if (updates.SNIPE_AMOUNT_SOL) {
        CONFIG.SNIPE_AMOUNT_LAMPORTS = Math.floor(parseFloat(updates.SNIPE_AMOUNT_SOL) * 1_000_000_000);
      }
      if (updates.EXIT_PROFIT_PERCENT) {
        CONFIG.EXIT_PROFIT_PERCENT = parseInt(updates.EXIT_PROFIT_PERCENT);
      }
      if (updates.EXIT_DRAWDOWN_PERCENT) {
        CONFIG.EXIT_DRAWDOWN_PERCENT = parseInt(updates.EXIT_DRAWDOWN_PERCENT);
      }

      if (modeChanged) {
        walletManager.resetForMode();
      }
    }
  };

  const { broadcastUpdate } = startApi(botState, botControls);

  // ─────────────────────────────────────────────────────────────
  //  TRACK 1: Bonding Curve (new token) sniping
  // ─────────────────────────────────────────────────────────────
  async function handleNewBondingCurveToken(event: NewTokenEvent) {
    if (!botState.isRunning) return;

    const latency = Date.now() - event.timestamp;
    stats.totalLatencyMs.push(latency);
    if (stats.totalLatencyMs.length > 100) stats.totalLatencyMs.shift();
    const avgLatency = stats.totalLatencyMs.reduce((a, b) => a + b, 0) / stats.totalLatencyMs.length;

    logger.info({
      mint: event.mint.toBase58(),
      creator: event.creator.toBase58().slice(0, 8) + '...',
      latency: `${latency}ms`,
      avgLatency: `${avgLatency.toFixed(0)}ms`,
      source: USE_GRPC ? 'gRPC' : 'WebSocket',
    }, '⚡ New token detected');

    // Queue the rug check — enforces MAX_CONCURRENT_ANALYSES and MAX_QUEUE_DEPTH
    // This is the fix for 429 errors: bonding curve was NOT rate-limited before
    runAnalysis(async () => {
      if (!botState.isRunning) return;

      // Anti-rug check — pass creator for dev history check
      const rugCheck = await analyzer.analyze(event.mint, event.bondingCurve, event.creator);
      if (!rugCheck.safe) {
        stats.rugSkips++;
        logger.warn({ mint: event.mint.toBase58(), score: rugCheck.score, flags: rugCheck.flags }, '⛔ Skipped by anti-rug');
        return;
      }

      // Guard: max open positions cap
      const openCount = exitManagers.flatMap(em => em.getPositions()).length;
      if (openCount >= MAX_OPEN_POSITIONS) {
        logger.debug({ openCount, max: MAX_OPEN_POSITIONS }, 'Max open positions reached — skipping bonding curve snipe');
        return;
      }

      // Guard: don't snipe if wallet balance is too low (DRY_RUN safety net)
      if (CONFIG.DRY_RUN) {
        const wStats = walletManager.getStats();
        const minRequired = (CONFIG.SNIPE_AMOUNT_LAMPORTS / 1_000_000_000);
        if (wStats.totalBalance < minRequired) {
          logger.warn({ balance: wStats.totalBalance, minRequired }, '⚠️ Simulated balance too low — pausing new snipes');
          return;
        }
      }

      // Get next wallet from rotation
      const snipeWallet = walletManager.getNextWallet();
      logger.info({ mint: event.mint.toBase58(), wallet: snipeWallet.publicKey.toBase58().slice(0, 8) + '...' }, '✅ Sniping via native builder');

      // Fix 12: Use nativeSnipe (Rust if compiled, JS fallback otherwise)
      const tpId = rugCheck.tokenProgram ? new PublicKey(rugCheck.tokenProgram) : TOKEN_PROGRAM_ID;
      const result = await nativeSnipe(
        connection,
        snipeWallet,
        event.mint,
        CONFIG.SNIPE_AMOUNT_LAMPORTS,
        rugCheck.score,
        tpId
      );

      if (result.success) {
        stats.totalBondingCurveSnipes++;

        if (CONFIG.DRY_RUN) {
          walletManager.modifyVirtualBalance(snipeWallet.publicKey, -CONFIG.SNIPE_AMOUNT_LAMPORTS);
        }

        const exitManager = new ExitManager(snipeWallet, telegram, (pnlSol, tradeInfo) => {
          stats.successfulExits++;
          stats.totalPnl += pnlSol;
          walletManager.releaseWallet(snipeWallet.publicKey);
          if (CONFIG.DRY_RUN) {
            walletManager.modifyVirtualBalance(snipeWallet.publicKey, CONFIG.SNIPE_AMOUNT_LAMPORTS + (pnlSol * 1_000_000_000));
          }
          if (tradeInfo) {
            tradeHistory.unshift(tradeInfo);
            if (tradeHistory.length > 50) tradeHistory.pop();
          }
        });
        exitManagers.push(exitManager);
        exitManager.addPosition(event.mint.toBase58(), event.slot, CONFIG.SNIPE_AMOUNT_LAMPORTS, result.tokenBalance || 0n, 'bonding_curve', undefined, rugCheck.tokenProgram);

        telegram.onSnipe({
          mint: event.mint.toBase58(),
          solSpent: (CONFIG.SNIPE_AMOUNT_LAMPORTS / 1_000_000_000).toFixed(4),
          tokenAmount: result.tokenBalance ? (Number(result.tokenBalance) / 1_000_000).toFixed(2) : 'unknown',
          bundleId: result.txHash || '',
          score: rugCheck.score,
          flags: rugCheck.flags,
        });
      } else {
        walletManager.releaseWallet(snipeWallet.publicKey);
        telegram.onError({ context: 'Snipe failed', error: result.error || 'Unknown', mint: event.mint.toBase58() });
      }
    }); // end runAnalysis
  }

  // ─── Start primary watcher ───
  if (USE_GRPC) {
    if (USE_TRITON_V5) {
      // Fix 19: Triton v5 NaaE — Rust-native gRPC engine (~400% throughput vs standard)
      logger.info('🚀 Starting Triton v5 NaaE gRPC watcher (Rust-native)');
      const grpcWatcher = new GrpcWatcherV5();
      activeWatcher = grpcWatcher;
    } else {
      const grpcWatcher = new GrpcWatcher();
      activeWatcher = grpcWatcher;
    }
  } else {
    logger.warn('No gRPC configured — using WebSocket (slower, less reliable)');
    logger.warn('Set GRPC_ENDPOINT and GRPC_TOKEN in .env for 3x faster detection');
    const wsWatcher = new PumpWatcher();
    activeWatcher = wsWatcher;
  }

  // Only connect if not paused
  if (botState.isRunning && activeWatcher) {
    activeWatcher.start(watcherCallback);
  }

  process.on('SIGINT', () => { if (activeWatcher) activeWatcher.stop(); shutdown(); });
  process.on('SIGTERM', () => { if (activeWatcher) activeWatcher.stop(); shutdown(); });

  // ─────────────────────────────────────────────────────────────
  //  TRACK 2: PumpSwap AMM (graduated tokens)
  // ─────────────────────────────────────────────────────────────
  watchAmmPoolCreations(connection, (poolInfo: AmmPoolInfo) => {
    if (!botState.isRunning) return;

    // Fix 6: deduplicate AMM pool events
    const poolKey = poolInfo.poolAddress.toBase58();
    if (hasSeenPool(poolKey)) return;
    markPoolSeen(poolKey);

    // ─── Skip non-pump.fun token pools (e.g. wrapped SOL pairs) ───
    // These are useless for sniping and burn RPC rate limit quota.
    const baseMintStr = poolInfo.baseMint.toBase58();
    const WSOL = 'So11111111111111111111111111111111111111112';
    if (baseMintStr === WSOL || !/pump$/i.test(baseMintStr)) return;

    logger.info({ baseMint: baseMintStr, pool: poolKey }, '🆕 New AMM pool');

    // Rate-limit: queue analysis to max 3 concurrent RPC operations
    runAnalysis(async () => {

      const rugCheck = await analyzer.analyze(poolInfo.baseMint, poolInfo.poolAddress);
      if (!rugCheck.safe) {
        stats.rugSkips++;
        logger.warn({ mint: poolInfo.baseMint.toBase58(), score: rugCheck.score, flags: rugCheck.flags }, '⛔ Skipped by anti-rug');
        return;
      }

      // Guard: max open positions cap
      const openCount = exitManagers.flatMap(em => em.getPositions()).length;
      if (openCount >= MAX_OPEN_POSITIONS) {
        logger.debug({ openCount, max: MAX_OPEN_POSITIONS }, 'Max open positions reached — skipping AMM snipe');
        return;
      }

      // Guard: don't snipe if wallet balance is too low (DRY_RUN safety net)
      if (CONFIG.DRY_RUN) {
        const wStats = walletManager.getStats();
        const minRequired = (CONFIG.SNIPE_AMOUNT_LAMPORTS / 1_000_000_000);
        if (wStats.totalBalance < minRequired) {
          logger.warn({ balance: wStats.totalBalance, minRequired }, '⚠️ Simulated balance too low — pausing new AMM snipes');
          return;
        }
      }

      const snipeWallet = walletManager.getNextWallet();
      const snipeLamports = CONFIG.SNIPE_AMOUNT_LAMPORTS;

      const estimatedTokens = BigInt(
        Math.floor(snipeLamports * Number(poolInfo.baseReserves) / (Number(poolInfo.quoteReserves) + snipeLamports) * 0.95)
      );

      if (CONFIG.DRY_RUN && estimatedTokens <= 0n) {
        logger.debug({ mint: poolInfo.baseMint.toBase58() }, 'Dry run calc yielded 0 tokens (pool not fully initialized) — skipping AMM snipe');
        return;
      }

      // ─── DRY RUN: simulate AMM buy without sending a tx ───
      const tpId = rugCheck.tokenProgram ? new PublicKey(rugCheck.tokenProgram) : TOKEN_PROGRAM_ID;
      const result = CONFIG.DRY_RUN
        ? {
          success: true as const,
          bundleId: `DRY_RUN_AMM_${Date.now()}`,
          tokenBalance: estimatedTokens,
        }
        : await ammBuy(connection, snipeWallet, poolInfo, estimatedTokens, BigInt(snipeLamports), false, CONFIG.JITO_TIP_LAMPORTS, rugCheck.score, tpId);

      if (result.success) {
        stats.totalAmmSnipes++;
        telegram.onSnipe({
          mint: poolInfo.baseMint.toBase58(),
          solSpent: (snipeLamports / 1_000_000_000).toFixed(4),
          tokenAmount: 'AMM',
          bundleId: result.bundleId || '',
          score: rugCheck.score,
          flags: [],
        });

        if (CONFIG.DRY_RUN) {
          walletManager.modifyVirtualBalance(snipeWallet.publicKey, -snipeLamports);
        }

        const exitManager = new ExitManager(snipeWallet, telegram, (pnlSol, tradeInfo) => {
          stats.successfulExits++;
          stats.totalPnl += pnlSol;
          walletManager.releaseWallet(snipeWallet.publicKey); // Fix 7: release wallet after exit
          if (CONFIG.DRY_RUN) {
            walletManager.modifyVirtualBalance(snipeWallet.publicKey, snipeLamports + (pnlSol * 1_000_000_000));
          }
          if (tradeInfo) {
            tradeHistory.unshift(tradeInfo);
            if (tradeHistory.length > 50) tradeHistory.pop();
          }
        });
        exitManagers.push(exitManager);
        // Fix 2: pass source='amm' + poolInfo so exit manager routes sell correctly
        exitManager.addPosition(poolInfo.baseMint.toBase58(), 0, snipeLamports, estimatedTokens, 'amm', poolInfo, rugCheck.tokenProgram);
      } else {
        walletManager.releaseWallet(snipeWallet.publicKey);
      }
    }); // end runAnalysis
  });

  // ─── Periodic wallet maintenance (every 5 minutes) ───
  setInterval(async () => {
    await walletManager.sweepWallets(masterKeypair, 3.0, 0.8); // 🧹 Sweep profits > 3 SOL back to master (keep 0.8)
    await walletManager.refillWallets(masterKeypair, 0.3, 0.8); // ⛽ Refill wallets < 0.3 SOL up to 0.8
    walletManager.saveState('./wallet-state.json');

    if (stats.totalLatencyMs.length > 0) {
      const avg = stats.totalLatencyMs.reduce((a, b) => a + b, 0) / stats.totalLatencyMs.length;
      logger.info({ avgLatency: `${avg.toFixed(0)}ms`, samples: stats.totalLatencyMs.length }, '📊 Detection latency');
    }
  }, 300_000);

  // ─── Daily summary ───
  setInterval(() => {
    const totalTrades = stats.totalBondingCurveSnipes + stats.totalAmmSnipes;
    const winRate = totalTrades > 0 ? ((stats.successfulExits / totalTrades) * 100).toFixed(1) : '0.0';

    telegram.onSummary({
      totalSniped: totalTrades,
      successfulExits: stats.successfulExits,
      rugSkips: stats.rugSkips,
      totalPnlSol: stats.totalPnl.toFixed(2),
      winRate: `${winRate}%`,
    });
  }, 86_400_000);

  // ─── Startup notification ───
  telegram.onStart({
    snipeAmount: (CONFIG.SNIPE_AMOUNT_LAMPORTS / 1_000_000_000).toFixed(2),
    profitTarget: `${CONFIG.EXIT_PROFIT_PERCENT}%`,
    stopLoss: `${CONFIG.EXIT_DRAWDOWN_PERCENT}%`,
    jitoTip: (CONFIG.JITO_TIP_LAMPORTS / 1_000_000_000).toFixed(4),
    rpcEndpoint: CONFIG.RPC_URL.slice(0, 40) + '...',
  });

  // ─── Shutdown handler ───
  function shutdown() {
    logger.info('Shutting down...');
    walletManager.saveState('./wallet-state.json');
    telegram.onError({ context: 'Bot shutting down', error: 'SIGINT received' });
    setTimeout(() => process.exit(0), 1000);
  }

  logger.info(`
┌──────────────────────────────────────────────────────────┐
│  Pump.fun Sniper Bot v3.2 — LONDON 🇬🇧                    │
│                                                           │
│  Detection:    ${USE_GRPC ? '✅ Yellowstone gRPC (~30ms)' : '⚠️  WebSocket (~100ms)'}        │
│  Master:       ${masterKeypair.publicKey.toBase58().slice(0, 8)}...${masterKeypair.publicKey.toBase58().slice(-4)}                    │
│  Wallets:      ${walletManager.getStats().totalWallets} in rotation                     │
│  Snipe:        ${(CONFIG.SNIPE_AMOUNT_LAMPORTS / 1_000_000_000).toFixed(2)} SOL per token              │
│  Jito tip:     ${(CONFIG.JITO_TIP_LAMPORTS / 1_000_000_000).toFixed(4)} SOL                      │
│  Take profit:  ${CONFIG.EXIT_PROFIT_PERCENT}% / Stop loss: ${CONFIG.EXIT_DRAWDOWN_PERCENT}%               │
│  Targets:      Bonding Curve + PumpSwap AMM               │
│  Telegram:     ${process.env.TELEGRAM_BOT_TOKEN ? '✅ Enabled' : '❌ Not configured'}                    │
└──────────────────────────────────────────────────────────┘
  `);
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error');
  process.exit(1);
});
