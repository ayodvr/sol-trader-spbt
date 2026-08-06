import { PublicKey } from '@solana/web3.js';
import type { AmmPoolInfo } from './pumpswap.js';

export interface NewTokenEvent {
  mint: PublicKey;
  bondingCurve: PublicKey;
  creator: PublicKey;
  slot: number;
  timestamp: number;
}

export interface RugCheckResult {
  safe: boolean;
  score: number;           // 0-100
  flags: string[];
  buyTax: number;
  sellTax: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  top10HolderPercent: number;
  liquidityLocked: boolean;
  hasSocials?: boolean;
  devScore?: number;
  socialScore?: number;
  tokenProgram?: string;   // 'TokenkegQfe...' = SPL, 'TokenzQdBNb...' = Token-2022
  creator?: string;        // Resolved real creator wallet (bonding-curve-derived for AMM, see analyzer.ts)
}

export interface ExitTriggers {
  takeProfit: number;      // % gain to exit
  stopLoss: number;        // % loss to exit
  taxSpike: number;        // max sell tax % before forced exit
}

export interface Position {
  mint: string;
  entryPrice: number;
  entrySlot: number;
  entryTimestamp: number;
  amountInLamports: number;   // SOL spent in lamports
  tokenBalance: bigint;       // Tokens received
  exitTriggered: boolean;
  source: 'bonding_curve' | 'amm'; // Which track created this position
  poolInfo?: AmmPoolInfo;          // Set if source === 'amm'
  highWaterMark: number;           // Highest price seen (for trailing stop)
  tokenProgram?: string;           // SPL or Token-2022 program ID
  currentPrice?: number;           // Last observed price (updated each monitor tick)
  currentPriceChangePercent?: number; // Unrealised PnL % vs entry (updated each tick)
  exitAttempts?: number;           // Failed sell attempts so far (for bounded retry-until-abandon)
  creator?: string;                 // Token/pool creator wallet — for cross-run rug blacklist
}

export interface TradeHistoryEntry {
  mint: string;
  boughtAt: number;
  soldAt: number;
  pnlSol: number;
  pnlPercent: string;
  reason: 'take_profit' | 'stop_loss' | 'trailing_stop' | 'rug_detected' | 'manual';
  timestamp: number;
  creator?: string;
}
