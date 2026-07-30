# Pump.fun Sniper Bot v3.2

A high-performance Solana sniper bot targeting Pump.fun bonding curves and PumpSwap AMM pools, using Jito bundles for guaranteed transaction priority.

## Architecture

```
Detection (gRPC/WS) → Anti-rug Analysis → Jito Bundle Buy → Exit Monitor → Jito Bundle Sell → Telegram Alert
```

### Modules

| File | Purpose |
|------|---------|
| `config.ts` | Central config (reads `.env`) |
| `src/types.ts` | Shared TypeScript interfaces |
| `src/utils.ts` | PDA derivation, key decoding |
| `src/watcher.ts` | WebSocket token watcher (fallback) |
| `src/grpc-watcher.ts` | Yellowstone gRPC watcher (primary, ~30ms) |
| `src/grpc-watcher-triton-v5.ts` | Triton v5 NaaE gRPC watcher (4x faster) |
| `src/analyzer.ts` | Anti-rug engine |
| `src/sniper.ts` | Bonding curve buy executor (JS fallback) |
| `src/native-sniper.ts` | Rust native bridge for buy instruction |
| `src/sell.ts` | Bonding curve sell with cashback support |
| `src/exit-manager.ts` | Position monitor + auto-exit |
| `src/jito.ts` | Jito bundle submission + confirmation polling |
| `src/telegram.ts` | Telegram notifications |
| `src/multi-wallet.ts` | Wallet rotation + auto-refill |
| `src/pumpswap.ts` | PumpSwap AMM buy/sell + pool watcher |
| `src/benchmark.ts` | Speed benchmark (JS vs Rust) |
| `src/index.ts` | Main entry point |
| `native-builder/` | Rust napi-rs instruction builder (~0.05ms) |

## Setup

### 1. Install Node.js 20+

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
```

### 2. Clone and install

```bash
cd ~/pump-sniper
npm install
```

### 3. Configure

```bash
cp .env.example .env
nano .env   # Fill in your real values
```

```bash
cp wallets.example.json wallets.json
nano wallets.json  # Paste your sniper wallet private keys (base58)
```

### 4. Run

```bash
# Development (with auto-restart)
npm run dev

# Production
npm start
```

### 5. PM2 (keep alive after SSH disconnect)

```bash
npm install -g pm2
pm2 start npm --name "pump-sniper" -- start
pm2 save && pm2 startup
```

## Configuration Reference

| Variable | Default | Description |
|----------|---------|-------------|
| `PRIVATE_KEY` | — | **Required.** Master wallet base58 private key |
| `RPC_URL` | Solana mainnet | Helius/QuickNode RPC endpoint |
| `WS_URL` | Solana mainnet WS | WebSocket endpoint (same provider) |
| `GRPC_ENDPOINT` | — | Yellowstone gRPC endpoint (for 30ms detection) |
| `GRPC_TOKEN` | — | gRPC API token |
| `JITO_BLOCK_ENGINE` | mainnet | Jito block engine URL |
| `JITO_TIP_SOL` | `0.005` | Jito tip per bundle (SOL) |
| `SNIPE_AMOUNT_SOL` | `0.1` | SOL to spend per snipe |
| `MAX_BUY_TAX` | `15` | Max buy tax % to accept |
| `MAX_SELL_TAX` | `15` | Max sell tax % to accept |
| `EXIT_PROFIT_PERCENT` | `300` | Take profit at +300% |
| `EXIT_DRAWDOWN_PERCENT` | `30` | Stop loss at -30% |
| `TELEGRAM_BOT_TOKEN` | — | Telegram bot token (optional) |
| `TELEGRAM_CHAT_ID` | — | Telegram chat/channel ID (optional) |

## Wallet Strategy

```
Wallet 0 (Master): Hold 20-50 SOL — refills all others
Wallet 1-3:        Bonding curve snipes (~2-5 SOL each)
Wallet 4-5:        AMM pool snipes
```

Auto-refill triggers when any wallet drops below 0.3 SOL.

## Optional: Rust Native Builder

Builds Pump.fun instructions in <0.1ms vs ~8ms in JS.

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Build the addon
cd native-builder && npm install && npm run build

# Install in main project
cd .. && npm install ./native-builder
```

## gRPC Providers (London region)

| Provider | Latency | Price |
|----------|---------|-------|
| QuickNode | ~30ms | $99/mo |
| Triton | ~25ms | $149/mo |
| Shyft | ~35ms | $79/mo |
| Subglow | ~30ms | $89/mo |
