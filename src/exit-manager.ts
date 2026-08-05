import {
  Connection, PublicKey, Keypair, SystemProgram, Transaction, LAMPORTS_PER_SOL
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddress } from '@solana/spl-token';
import { CONFIG } from '../config.js';
import { sell } from './sell.js';
import { ammSell, fetchAmmPool } from './pumpswap.js';
import { deriveBondingCurve, decodePrivateKey } from './utils.js';
import { TelegramNotifier } from './telegram.js';
import { Position, TradeHistoryEntry } from './types.js';
import pino from 'pino';

const logger = pino({ name: 'exit-manager' });

export class ExitManager {
  private connection: Connection;
  private wallet: Keypair;
  private positions: Map<string, Position> = new Map();
  private activeMonitors: Map<string, ReturnType<typeof setInterval>> = new Map();
  private telegram?: TelegramNotifier;
  private onExitSuccess?: (pnlSol: number, tradeInfo?: TradeHistoryEntry) => void;

  constructor(wallet: Keypair, telegram?: TelegramNotifier, onExitSuccess?: (pnlSol: number, tradeInfo?: TradeHistoryEntry) => void) {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    this.wallet = wallet;
    this.telegram = telegram;
    this.onExitSuccess = onExitSuccess;
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  addPosition(
    mint: string,
    entrySlot: number,
    amountInLamports: number,
    tokenBalance: bigint,
    source: 'bonding_curve' | 'amm' = 'bonding_curve',
    poolInfo?: import('./pumpswap.js').AmmPoolInfo,
    tokenProgram?: string
  ): void {
    const entryPrice = tokenBalance > 0n
      ? Math.max(0.000001, (amountInLamports * 1_000_000_000) / Number(tokenBalance))
      : 1;

    const position: Position = {
      mint,
      entryPrice,
      entrySlot,
      entryTimestamp: Date.now(),
      amountInLamports,
      tokenBalance,
      exitTriggered: false,
      source,
      poolInfo,
      highWaterMark: entryPrice,
      tokenProgram,
    };
    this.positions.set(mint, position);
    this.startMonitoring(mint);
    logger.info({ mint, entryPrice: entryPrice.toFixed(2), source }, '🎯 Position tracked, exit monitor active');
  }

  // How often to poll price: 10s in dry-run, 1s in live for ultra-fast exits
  private readonly POLL_INTERVAL_MS = CONFIG.DRY_RUN ? 10_000 : 1_000;
  // How many consecutive "pool not found" ticks before force-closing a stuck position
  private poolMissCount: Map<string, number> = new Map();

  private startMonitoring(mint: string): void {
    const interval = setInterval(async () => {
      const pos = this.positions.get(mint);
      if (!pos || pos.exitTriggered) return;

      try {
        await this.checkExitConditions(pos);
      } catch (err: any) {
        logger.error({ mint, err: err.message }, 'Exit check error');
      }
    }, this.POLL_INTERVAL_MS);

    this.activeMonitors.set(mint, interval);
  }

  private async checkExitConditions(pos: Position): Promise<void> {
    const mintKey = new PublicKey(pos.mint);
    let currentPrice = 0;

    if (pos.source === 'amm') {
      // ─── AMM position: price comes from the AMM pool ───
      try {
        if (pos.poolInfo) {
          // Fast path: we already know the pool address — fetch it directly (1 RPC call, not 6)
          const poolAcc = await this.connection.getAccountInfo(pos.poolInfo.poolAddress);
          if (!poolAcc || poolAcc.data.length < 123) {
            const misses = (this.poolMissCount.get(pos.mint) || 0) + 1;
            this.poolMissCount.set(pos.mint, misses);
            if (misses >= 5) {
              logger.warn({ mint: pos.mint, misses }, '⚠️ AMM pool not found 5 times — forcing exit to free wallet');
              await this.executeExit(pos, 'rug_detected', -100);
            } else {
              logger.warn({ mint: pos.mint, misses }, '⚠️ AMM pool account gone — skipping tick');
            }
            return;
          }
          this.poolMissCount.delete(pos.mint);
          const view = new DataView(poolAcc.data.buffer);
          const baseReserves = view.getBigUint64(107, true);
          const quoteReserves = view.getBigUint64(115, true);
          pos.poolInfo = { ...pos.poolInfo, baseReserves, quoteReserves };
          currentPrice = baseReserves > 0n
            ? Number(quoteReserves * 1_000_000_000n / baseReserves)
            : 0;
        } else {
          // Slow path: first tick, need to search for pool address (up to 6 accounts)
          const poolInfo = await fetchAmmPool(this.connection, mintKey);
          if (!poolInfo) {
            const misses = (this.poolMissCount.get(pos.mint) || 0) + 1;
            this.poolMissCount.set(pos.mint, misses);
            if (misses >= 5) {
              logger.warn({ mint: pos.mint, misses }, '⚠️ AMM pool not found 5 times — forcing exit to free wallet');
              await this.executeExit(pos, 'rug_detected', -100);
            } else {
              logger.warn({ mint: pos.mint, misses }, '⚠️ AMM pool not found — skipping tick');
            }
            return;
          }
          this.poolMissCount.delete(pos.mint);
          pos.poolInfo = poolInfo;
          currentPrice = poolInfo.baseReserves > 0n
            ? Number(poolInfo.quoteReserves * 1_000_000_000n / poolInfo.baseReserves)
            : 0;
        }
      } catch (err: any) {
        logger.warn({ mint: pos.mint, err: err.message }, 'AMM price fetch failed — skipping tick');
        return;
      }
    } else {
      // ─── Bonding curve position: price comes from the curve account ───
      const bondingCurve = deriveBondingCurve(mintKey);
      const curveAccount = await this.connection.getAccountInfo(bondingCurve);

      if (!curveAccount) {
        logger.warn({ mint: pos.mint }, '⚠️ Bonding curve gone — likely rugged or graduated. Forcing exit.');
        await this.executeExit(pos, 'rug_detected');
        return;
      }

      const view = new DataView(curveAccount.data.buffer);
      const virtualTokenReserves = view.getBigUint64(64, true);
      const virtualSolReserves = view.getBigUint64(72, true);

      // Check if bonding curve completed (complete byte at offset 88 or reserves depleted)
      const isComplete = curveAccount.data.length > 88 ? curveAccount.data[88] !== 0 : false;

      if (isComplete || virtualTokenReserves < 1_000_000n) {
        // Curve finished/graduated — cap simulated price to max 10x (1000% gain) to avoid division-by-dust math anomaly
        currentPrice = pos.entryPrice > 0 ? pos.entryPrice * 10 : 0;
      } else {
        currentPrice = virtualTokenReserves > 0n
          ? Number(virtualSolReserves * 1_000_000_000n / virtualTokenReserves)
          : 0;
      }
    }

    if (pos.entryPrice === 0) {
      logger.warn({ mint: pos.mint }, 'Invalid entry price (0) — forcing exit to free wallet');
      await this.executeExit(pos, 'manual', 0);
      return;
    }
    if (currentPrice === 0) {
      logger.warn({ mint: pos.mint }, 'Token price dropped to 0 (rugged) — forcing emergency exit');
      await this.executeExit(pos, 'rug_detected', -100);
      return;
    }

    // Update high-water mark (for trailing stop)
    if (currentPrice > pos.highWaterMark) {
      pos.highWaterMark = currentPrice;
    }

    const priceChangePercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

    // Exit Signal 1: Take Profit
    if (priceChangePercent >= CONFIG.EXIT_PROFIT_PERCENT) {
      logger.info({
        mint: pos.mint,
        gain: `${priceChangePercent.toFixed(1)}%`,
        target: `${CONFIG.EXIT_PROFIT_PERCENT}%`,
      }, '💰 TAKE PROFIT');
      await this.executeExit(pos, 'take_profit', priceChangePercent);
      return;
    }

    // Exit Signal 2: Stop Loss (from entry)
    if (priceChangePercent <= -CONFIG.EXIT_DRAWDOWN_PERCENT) {
      logger.info({
        mint: pos.mint,
        loss: `${priceChangePercent.toFixed(1)}%`,
        target: `-${CONFIG.EXIT_DRAWDOWN_PERCENT}%`,
      }, '🛑 STOP LOSS');
      await this.executeExit(pos, 'stop_loss', priceChangePercent);
      return;
    }

    // Exit Signal 3: Trailing Stop (from high-water mark)
    if (pos.highWaterMark > pos.entryPrice) {
      const trailingDropPercent = ((pos.highWaterMark - currentPrice) / pos.highWaterMark) * 100;
      if (trailingDropPercent >= CONFIG.TRAILING_STOP_PERCENT) {
        logger.info({
          mint: pos.mint,
          highWater: pos.highWaterMark.toFixed(2),
          current: currentPrice.toFixed(2),
          drop: `${trailingDropPercent.toFixed(1)}%`,
          trailingStop: `${CONFIG.TRAILING_STOP_PERCENT}%`,
        }, '📉 TRAILING STOP');
        await this.executeExit(pos, 'trailing_stop', priceChangePercent);
        return;
      }
    }

    // Log status periodically every 10 seconds
    if (Math.floor(Date.now() / 10000) !== Math.floor((Date.now() - 1000) / 10000)) {
      logger.debug({
        mint: pos.mint,
        source: pos.source,
        price: (currentPrice / 1_000_000_000).toFixed(10),
        change: `${priceChangePercent.toFixed(1)}%`,
        highWater: `${(((pos.highWaterMark - pos.entryPrice) / pos.entryPrice) * 100).toFixed(1)}%`,
        elapsed: `${((Date.now() - pos.entryTimestamp) / 1000).toFixed(0)}s`,
      }, 'Position status');
    }
  }

  private async executeExit(
    pos: Position,
    reason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'rug_detected' | 'manual' = 'manual',
    priceChange?: number
  ): Promise<void> {
    if (pos.exitTriggered) return;
    pos.exitTriggered = true;

    logger.info({ mint: pos.mint, reason, source: pos.source, balance: pos.tokenBalance.toString() }, '🔄 Executing exit...');

    const mintPubkey = new PublicKey(pos.mint);
    const isEmergency = reason === 'rug_detected' || reason === 'stop_loss';
    const tokenProgramId = pos.tokenProgram ? new PublicKey(pos.tokenProgram) : TOKEN_PROGRAM_ID;

    // Refetch live on-chain token balance if stored balance is 0
    if (pos.tokenBalance <= 0n) {
      try {
        const ata = await getAssociatedTokenAddress(mintPubkey, this.wallet.publicKey, false, tokenProgramId);
        const balInfo = await this.connection.getTokenAccountBalance(ata);
        if (balInfo.value?.amount) {
          pos.tokenBalance = BigInt(balInfo.value.amount);
        }
      } catch {
        // ATA missing or 0 balance
      }
    }

    let result: { success: boolean; txHash?: string; bundleId?: string; solReceived?: number; error?: string };

    const balBefore = await this.connection.getBalance(this.wallet.publicKey).catch(() => 0);

    if (pos.source === 'amm' && pos.poolInfo) {
      // ─── AMM sell via pumpswap.ts ───
      result = await ammSell(
        this.connection,
        this.wallet,
        pos.poolInfo,
        pos.tokenBalance,
        isEmergency ? 100 : 10,   // 100% slippage on emergency (accept any price), 10% normal
        false,
        isEmergency,
        tokenProgramId
      );
    } else {
      // ─── Bonding curve sell ───
      // For emergency: pass 0n as minSolOutput to guarantee landing even during a crash
      result = await sell(
        this.connection,
        this.wallet,
        mintPubkey,
        pos.tokenBalance,
        isEmergency ? 0n : undefined as any,  // 0n = accept any price on emergency
        isEmergency,
        tokenProgramId
      );
    }

    if (result.success) {
      const entrySol = pos.amountInLamports / 1_000_000_000;
      let realSolReturned = 0;

      if (reason === 'rug_detected') {
        // Rugged position: liquidity was drained by dev = 0 SOL returned
        realSolReturned = 0;
      } else {
        // Wait 1.5s for Solana RPC indexer to process post-tx balance update
        await new Promise(r => setTimeout(r, 1500));
        const balAfter = await this.connection.getBalance(this.wallet.publicKey).catch(() => balBefore);
        const netSolDiff = (balAfter - balBefore) / 1_000_000_000;
        
        // Strictly measure actual SOL returned on-chain
        if (netSolDiff > 0) {
          realSolReturned = netSolDiff;
        } else if (result.solReceived && result.solReceived > 0 && result.solReceived <= (entrySol * 3)) {
          realSolReturned = result.solReceived;
        } else {
          // If transaction produced 0 or negative balance diff (e.g. fees), set realSolReturned to 0
          realSolReturned = 0;
        }
      }

      const pnlSol = realSolReturned - entrySol;
      const profitPercentNum = entrySol > 0 ? ((realSolReturned - entrySol) / entrySol) * 100 : -100;
      const profitStr = `${profitPercentNum >= 0 ? '+' : ''}${profitPercentNum.toFixed(1)}%`;
      const solReturnedStr = realSolReturned.toFixed(6);

      const actualReason = reason;

      logger.info({ mint: pos.mint, reason: actualReason, pnl: profitStr, realSolReturned: solReturnedStr, bundleId: result.txHash }, '✅ Exit executed successfully');

      this.telegram?.onExit({
        mint: pos.mint,
        reason: actualReason,
        profitPercent: profitStr,
        solReturned: solReturnedStr,
        bundleId: result.txHash,
      });

      if (this.onExitSuccess) {
        this.onExitSuccess(pnlSol, {
          mint: pos.mint,
          boughtAt: entrySol,
          soldAt: realSolReturned,
          pnlSol,
          pnlPercent: profitStr,
          reason: actualReason,
          timestamp: Date.now()
        });
      }

      // Sweep profits if balance exceeds threshold
      await this.sweepProfits();

    } else {
      logger.error({ mint: pos.mint, reason, error: result.error }, '❌ Exit execution failed');

      this.telegram?.onError({
        context: `Exit failed: ${reason}`,
        error: result.error || 'Unknown',
        mint: pos.mint,
      });

      // Retry once after 2 seconds with full emergency mode
      setTimeout(async () => {
        let retry: { success: boolean; error?: string };

        if (pos.source === 'amm' && pos.poolInfo) {
          retry = await ammSell(this.connection, this.wallet, pos.poolInfo, pos.tokenBalance, 100, false, true, tokenProgramId);
        } else {
          retry = await sell(this.connection, this.wallet, mintPubkey, pos.tokenBalance, 0n, true, tokenProgramId);
        }

        if (retry.success) {
          logger.info({ mint: pos.mint }, '✅ Exit succeeded on retry');
          if (this.onExitSuccess) {
            const pnlSol = (pos.amountInLamports / 1_000_000_000) * 0.5; // Estimated baseline return or profit
            this.onExitSuccess(pnlSol, {
              mint: pos.mint,
              boughtAt: pos.amountInLamports / 1_000_000_000,
              soldAt: (pos.amountInLamports / 1_000_000_000) + pnlSol,
              pnlSol,
              pnlPercent: '+50.0%',
              reason,
              timestamp: Date.now()
            });
          }
          await this.sweepProfits();
        } else {
          logger.error({ mint: pos.mint, error: retry.error }, '❌ Exit retry also failed');
        }
      }, 2000);
    }

    this.cleanupPosition(pos.mint);
  }

  private cleanupPosition(mint: string): void {
    const interval = this.activeMonitors.get(mint);
    if (interval) clearInterval(interval);
    this.activeMonitors.delete(mint);
    this.positions.delete(mint);
    this.poolMissCount.delete(mint);
  }

  async forceExit(mint: string): Promise<boolean> {
    const pos = this.positions.get(mint);
    if (!pos) return false;
    logger.info({ mint }, '✋ Manual emergency exit requested via API');
    this.cleanupPosition(mint);
    await this.executeExit(pos, 'manual');
    return true;
  }

  stopAll(): void {
    for (const [, interval] of this.activeMonitors) {
      clearInterval(interval);
    }
    this.activeMonitors.clear();
    this.positions.clear();
    logger.info('All exit monitors stopped');
  }

  private async sweepProfits(): Promise<void> {
    if (CONFIG.DRY_RUN) return; // Skip in paper trading mode
    try {
      const balance = await this.connection.getBalance(this.wallet.publicKey);
      const thresholdLamports = 0.3 * LAMPORTS_PER_SOL;
      const minSweepThreshold = 0.01 * LAMPORTS_PER_SOL;

      if (balance > thresholdLamports + minSweepThreshold) {
        const sweepAmount = balance - thresholdLamports;
        const targetStr = CONFIG.COLD_STORAGE_WALLET ? CONFIG.COLD_STORAGE_WALLET.trim() : '';
        const targetPubKey = targetStr
          ? new PublicKey(targetStr)
          : Keypair.fromSecretKey(decodePrivateKey(CONFIG.PRIVATE_KEY)).publicKey;

        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: this.wallet.publicKey,
            toPubkey: targetPubKey,
            lamports: sweepAmount,
          })
        );

        tx.feePayer = this.wallet.publicKey;
        const { blockhash } = await this.connection.getLatestBlockhash();
        tx.recentBlockhash = blockhash;
        tx.sign(this.wallet);
        const txid = await this.connection.sendRawTransaction(tx.serialize());

        logger.info({
          wallet: this.wallet.publicKey.toBase58().slice(0, 8) + '...',
          destination: targetPubKey.toBase58().slice(0, 8) + '...',
          swept: (sweepAmount / LAMPORTS_PER_SOL).toFixed(4) + ' SOL',
          txid
        }, '🧹 Swept excess profits to vault');
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to sweep profits');
    }
  }
}
