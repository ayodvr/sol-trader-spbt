import dotenv from 'dotenv';
import { PublicKey } from '@solana/web3.js';
dotenv.config();

export const CONFIG = {
  // Wallet
  PRIVATE_KEY: process.env.PRIVATE_KEY!,
  COLD_STORAGE_WALLET: process.env.COLD_STORAGE_WALLET ? process.env.COLD_STORAGE_WALLET.trim() : '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // Dry run mode (simulate trades without spending SOL)
  DRY_RUN: process.env.DRY_RUN === 'true',

  // RPC
  RPC_URL: process.env.RPC_URL || 'https://api.mainnet-beta.solana.com',
  WS_URL: process.env.WS_URL || 'wss://api.mainnet-beta.solana.com',
  GRPC_TOKEN: process.env.GRPC_TOKEN || '',

  // Jito settings
  JITO_BLOCK_ENGINE: process.env.JITO_BLOCK_ENGINE || 'https://mainnet.block-engine.jito.wtf',
  DYNAMIC_TIPPING_ENABLED: process.env.DYNAMIC_TIPPING_ENABLED !== 'false',
  JITO_MIN_TIP_SOL: parseFloat(process.env.JITO_MIN_TIP_SOL || '0.001'),
  JITO_MAX_TIP_SOL: parseFloat(process.env.JITO_MAX_TIP_SOL || '0.05'),
  // Fallback static tip if dynamic is disabled
  JITO_TIP_LAMPORTS: Math.floor(parseFloat(process.env.JITO_TIP_SOL || '0.005') * 1_000_000_000),

  // Trading parameters
  SNIPE_AMOUNT_LAMPORTS: Math.floor(parseFloat(process.env.SNIPE_AMOUNT_SOL || '0.1') * 1_000_000_000),

  // Rug thresholds
  MAX_BUY_TAX: parseInt(process.env.MAX_BUY_TAX || '15'),
  MAX_SELL_TAX: parseInt(process.env.MAX_SELL_TAX || '15'),
  // Minimum SOL liquidity an AMM pool must already hold (from the creator/other buyers) before
  // sniping it. Deeper pools take less price impact from a given dump — this doesn't affect
  // your own SNIPE_AMOUNT_SOL, it's a filter on the target pool's existing depth.
  MIN_POOL_LIQUIDITY_SOL: parseFloat(process.env.MIN_POOL_LIQUIDITY_SOL || '40'),

  // Pre-buy observation window (AMM track): after a pool passes the anti-rug checks, watch its
  // price for this long before actually buying — abort if it drops more than the threshold
  // during the window. Catches pools that get dumped within the first couple seconds, which a
  // static pre-trade snapshot check can never see coming.
  PRE_BUY_WATCH_MS: parseInt(process.env.PRE_BUY_WATCH_MS || '2000'),
  PRE_BUY_MAX_DROP_PERCENT: parseFloat(process.env.PRE_BUY_MAX_DROP_PERCENT || '15'),

  // Social & Developer Filtering
  REQUIRE_SOCIALS: process.env.REQUIRE_SOCIALS !== 'false', // Default to true for high quality
  MIN_RUG_SCORE: parseInt(process.env.MIN_RUG_SCORE || '75'),
  MIN_DEV_HISTORY_SCORE: parseInt(process.env.MIN_DEV_HISTORY_SCORE || '50'),
  HELIUS_API_KEY: process.env.HELIUS_API_KEY || '',  // Used for dev history check
  // scripts/find-wallets.ts (offline research tool) is a heavy Enhanced-API consumer that once
  // exhausted this same key's shared credit pool and silently degraded the live bot's dev-history/
  // coordinated-pump checks. Give it its own key so the two never compete again — falls back to
  // HELIUS_API_KEY only if a dedicated key hasn't been set.
  WALLET_FINDER_HELIUS_API_KEY: process.env.WALLET_FINDER_HELIUS_API_KEY || process.env.HELIUS_API_KEY || '',
  BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '', // Legacy — kept for compatibility

  // Exit triggers
  EXIT_PROFIT_PERCENT: parseInt(process.env.EXIT_PROFIT_PERCENT || '35'), // Quick take-profit at +35% for fast capital recycling on initial pumps
  EXIT_DRAWDOWN_PERCENT: parseInt(process.env.EXIT_DRAWDOWN_PERCENT || '25'), // Cut losses at -25%
  TRAILING_STOP_PERCENT: parseInt(process.env.TRAILING_STOP_PERCENT || '10'), // 10% drop from peak locks in profit immediately

  // Dashboard API security
  API_SECRET_KEY: process.env.API_SECRET_KEY || '',
  DASHBOARD_URL: process.env.DASHBOARD_URL || 'http://localhost:5173',

  // On-chain constants
  PUMP_PROGRAM_ID: new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
  PUMP_AMM_PROGRAM_ID: new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
  GLOBAL_ACCOUNT: new PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
  SOL_MINT: new PublicKey('So11111111111111111111111111111111111111112'),
};

// Validate config
if (!CONFIG.PRIVATE_KEY) throw new Error('PRIVATE_KEY not set in .env');
if (!CONFIG.API_SECRET_KEY) {
  console.warn('[WARN] API_SECRET_KEY not set — dashboard API will be disabled. Set it in .env to enable the dashboard.');
}
