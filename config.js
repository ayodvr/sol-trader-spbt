"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CONFIG = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const web3_js_1 = require("@solana/web3.js");
dotenv_1.default.config();
exports.CONFIG = {
    // Wallet
    PRIVATE_KEY: process.env.PRIVATE_KEY,
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
    // Social & Developer Filtering
    REQUIRE_SOCIALS: process.env.REQUIRE_SOCIALS === 'true',
    MIN_DEV_HISTORY_SCORE: parseInt(process.env.MIN_DEV_HISTORY_SCORE || '0'),
    BIRDEYE_API_KEY: process.env.BIRDEYE_API_KEY || '',
    // Exit triggers
    EXIT_PROFIT_PERCENT: parseInt(process.env.EXIT_PROFIT_PERCENT || '300'),
    EXIT_DRAWDOWN_PERCENT: parseInt(process.env.EXIT_DRAWDOWN_PERCENT || '30'),
    // On-chain constants
    PUMP_PROGRAM_ID: new web3_js_1.PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    PUMP_AMM_PROGRAM_ID: new web3_js_1.PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'),
    GLOBAL_ACCOUNT: new web3_js_1.PublicKey('4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf'),
    SOL_MINT: new web3_js_1.PublicKey('So11111111111111111111111111111111111111112'),
};
// Validate config
if (!exports.CONFIG.PRIVATE_KEY)
    throw new Error('PRIVATE_KEY not set in .env');
