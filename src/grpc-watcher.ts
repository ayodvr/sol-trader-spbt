// src/grpc-watcher.ts
//
// Yellowstone gRPC Watcher — ~30ms latency vs ~100ms WebSocket.
// Primary watcher; falls back to PumpWatcher if no endpoint configured.
//
// Recommended provider: Alchemy (https://alchemy.com)
//   - Free account, ~$0.30/month billed at $75/TB
//   - Endpoint: https://solana-mainnet.g.alchemy.com
//   - Token: your Alchemy API key (set as GRPC_TOKEN in .env)
//
// NOTE: @triton-one/yellowstone-grpc ships Linux/macOS binaries only.
// On Windows, gRPC import is skipped and the bot uses WebSocket mode instead.

import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import pino from 'pino';
import { CONFIG } from '../config.js';
import { NewTokenEvent } from './types.js';
import { deriveBondingCurve } from './utils.js';
import { blockhashCache } from './blockhash-cache.js';

// Types only — no runtime import of yellowstone at module level
type Client = any;
type SubscribeRequest = any;

const logger = pino({ name: 'grpc-watcher' });

const CREATE_DISCRIMINATOR = Buffer.from([24, 30, 200, 40, 5, 28, 7, 119]);
const SOLANA_SLOT_TIME_MS = 400;

/**
 * Yellowstone gRPC watcher with:
 * - 30ms token detection latency
 * - Automatic reconnection with 3000-slot replay
 * - Single stream for both Pump.fun + PumpSwap AMM
 * - Health check pings every 30s
 */
export class GrpcWatcher {
  // @ts-ignore — yellowstone-grpc types mismatch installed package version
  private client: Client | null = null;
  private stream: any = null;
  private seenTokens: Set<string> = new Set();
  private createDiagnosticCount: number = 0;
  private discriminatorCounts: Map<string, number> = new Map();
  private lastDiscriminatorLog: number = 0;
  private readonly SEEN_TOKENS_MAX = 10_000;
  private readonly SEEN_TOKENS_EVICT = 1_000;
  private lastSlot: number = 0;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 50;
  private isRunning: boolean = false;
  private isConnecting: boolean = false;
  private onNewToken: ((event: NewTokenEvent) => void) | null = null;
  private onAmmPool: ((pool: any) => void) | null = null;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;

  private grpcEndpoint: string;
  private grpcToken: string;

  /** Pool addresses to monitor for exit conditions (account change = any trade) */
  private trackedPools: Set<string> = new Set();
  /** Called on every gRPC account notification for tracked pools */
  private onPoolUpdate: ((address: string, base: bigint, quote: bigint) => void) | null = null;

  constructor(endpoint?: string, token?: string) {
    this.grpcEndpoint = endpoint || process.env.GRPC_ENDPOINT || '';
    this.grpcToken = token || process.env.GRPC_TOKEN || '';

    if (!this.grpcEndpoint) {
      logger.warn(
        'No GRPC_ENDPOINT set. Falling back to WebSocket watcher.\n' +
        'Get one from: QuickNode, Triton, Shyft, Subglow, or Chainstack'
      );
    }
  }

  async start(
    onNewToken: (event: NewTokenEvent) => void,
    onAmmPool?: (pool: any) => void
  ): Promise<void> {
    this.onNewToken = onNewToken;
    this.onAmmPool = onAmmPool || null;

    if (!this.grpcEndpoint) {
      logger.error('Cannot start gRPC watcher: no endpoint configured');
      return;
    }

    this.isRunning = true;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  /**
   * Register a callback for pool account change notifications.
   * Called on every gRPC account notification with fresh reserves (~30ms latency).
   */
  setPoolUpdateCallback(cb: (address: string, base: bigint, quote: bigint) => void): void {
    this.onPoolUpdate = cb;
  }

  /**
   * Subscribe to a pool account via gRPC — ~30ms notification on any trade/rug.
   * Dynamically updates the live stream without reconnecting.
   */
  addPoolMonitor(poolAddress: string): void {
    if (this.trackedPools.has(poolAddress)) return;
    this.trackedPools.add(poolAddress);
    this.updatePoolSubscription();
    logger.debug({ pool: poolAddress.slice(0, 8) + '...' }, '⚡ gRPC pool monitor added');
  }

  /**
   * Unsubscribe from a pool account when its position closes.
   */
  removePoolMonitor(poolAddress: string): void {
    if (!this.trackedPools.delete(poolAddress)) return;
    this.updatePoolSubscription();
    logger.debug({ pool: poolAddress.slice(0, 8) + '...' }, '⚡ gRPC pool monitor removed');
  }

  /**
   * Push updated pool list to the live gRPC stream.
   * Yellowstone merges subscription updates — existing tx subscriptions are preserved.
   */
  private updatePoolSubscription(): void {
    if (!this.stream || !this.isRunning) return;
    const pools = Array.from(this.trackedPools);
    try {
      this.stream.write({
        slots: {},
        accounts: pools.length > 0 ? {
          pool_exit_monitor: {
            account: pools,
            owner: [],
            filters: [],
          }
        } : {},
        transactions: {},
        transactionsStatus: {},
        blocks: {},
        blocksMeta: {},
        entry: {},
        accountsDataSlice: [],
        commitment: 0,
      });
    } catch (err: any) {
      logger.debug({ err: err.message }, 'updatePoolSubscription write failed (stream closed)');
    }
  }

  private async connect(): Promise<void> {
    try {
      logger.info({
        endpoint: this.grpcEndpoint.slice(0, 30) + '...',
      }, 'Connecting to Yellowstone gRPC...');

      // Lazy import — only loads native binary when actually connecting
      // (binary doesn't exist on Windows; use WS mode there)
      let GrpcClient: any;
      let CommitmentLevel: any;
      try {
        const grpcMod = await import('@triton-one/yellowstone-grpc');
        GrpcClient = grpcMod.default;
        CommitmentLevel = grpcMod.CommitmentLevel;
      } catch (importErr: any) {
        logger.error(
          { err: importErr.message },
          '❌ yellowstone-grpc native binary not found (Windows?). ' +
          'Deploy to Linux VPS for gRPC. Falling back to WebSocket.'
        );
        await this.scheduleReconnect();
        return;
      }

      // @ts-ignore — yellowstone-grpc Client namespace quirk
      this.client = new GrpcClient(
        this.grpcEndpoint,
        this.grpcToken,
        {
          'grpc.max_receive_message_length': 128 * 1024 * 1024,
          'grpc.keepalive_time_ms': 10_000,
          'grpc.keepalive_timeout_ms': 5_000,
          'grpc.keepalive_permit_without_calls': 1,
        }
      );

      // Connect before subscribing
      await this.client.connect();
      this.stream = await this.client.subscribe();
      this.stream.on('data', (data: any) => this.handleData(data));
      this.stream.on('error', (err: any) => this.handleError(err));
      this.stream.on('end', () => this.handleDisconnect());
      this.stream.on('close', () => this.handleDisconnect());

      const request = this.buildSubscribeRequest();
      this.stream.write(request);

      logger.info('✅ Yellowstone gRPC connected and subscribed');
      this.reconnectAttempts = 0;
      this.startHealthCheck();

      // Re-subscribe to any pools we were monitoring before the reconnect
      if (this.trackedPools.size > 0) {
        this.updatePoolSubscription();
        logger.info({ pools: this.trackedPools.size }, '⚡ Re-subscribed to pool exit monitors after reconnect');
      }

    } catch (err: any) {
      logger.error({ 
        err: err.message, 
        code: err.code, 
        details: err.details,
        full: err
      }, '❌ gRPC connection failed');
      await this.scheduleReconnect();
    }
  }

  private buildSubscribeRequest(): SubscribeRequest {
    // BILLING SAFETY: filters are scoped to pump.fun + pumpswap program IDs only.
    // This limits Alchemy bandwidth to ~4 GB/month (~$0.30) instead of 100+ GB/hr unfiltered.
    // @ts-ignore — yellowstone-grpc SubscribeRequest type is stricter than actual runtime API
    const request: SubscribeRequest = {
      slots: { slot_sub: {} },
      accounts: {},
      transactions: {
        pump_bonding_curve: {
          accountInclude: [CONFIG.PUMP_PROGRAM_ID.toBase58()],
          accountExclude: [],
          accountRequired: [],
          vote: false,
          failed: false,
        },
        pump_amm: {
          accountInclude: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
          accountExclude: [],
          accountRequired: [],
          vote: false,
          failed: false,
        },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {
        blockhash: {}
      },
      entry: {},
      accountsDataSlice: [],
      commitment: 0, // CommitmentLevel.PROCESSED = 0
    };

    if (this.lastSlot > 0) {
      (request as any).fromSlot = this.lastSlot;
      logger.info({ fromSlot: this.lastSlot }, 'Replaying from previous slot');
    }

    return request;
  }

  private handleData(data: any): void {
    try {
      if (data.slot) {
        this.lastSlot = data.slot.slot;
        return;
      }
      if (data.blockMeta) {
        const hash = data.blockMeta.blockhash;
        if (hash) {
          blockhashCache.set(hash);
        }
        return;
      }
      // ─── Pool account change notification (for exit monitoring) ───
      if (data.account && this.onPoolUpdate) {
        const acc = data.account.account;
        if (!acc || !acc.data) return;

        // Resolve pool address from pubkey bytes
        let poolAddress: string;
        try {
          poolAddress = bs58.encode(Buffer.from(acc.pubkey));
        } catch { return; }

        if (!this.trackedPools.has(poolAddress)) return;

        // Parse PumpSwap pool reserves: baseReserves@107, quoteReserves@115
        const raw = Buffer.from(acc.data);
        if (raw.length < 123) return;
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        const baseReserves = view.getBigUint64(107, true);
        const quoteReserves = view.getBigUint64(115, true);
        this.onPoolUpdate(poolAddress, baseReserves, quoteReserves);
        return;
      }
      if (data.transaction) {
        this.processTransaction(data.transaction);
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Error handling gRPC data');
    }
  }

  private processTransaction(txData: any): void {
    // Yellowstone envelope nesting (confirmed against the live stream):
    //   SubscribeUpdateTransaction { transaction: TransactionInfo, slot }
    //   TransactionInfo           { signature, isVote, transaction: Transaction, meta, index }
    //   Transaction               { signatures, message }
    // The previous code read txData.transaction.message — but that level is TransactionInfo,
    // which has no .message field, so the guard below rejected EVERY transaction and no token
    // was ever detected. The message lives one level deeper; meta stays on TransactionInfo.
    const txInfo = txData?.transaction;
    const slot = txData?.slot;
    const message = txInfo?.transaction?.message;
    const meta = txInfo?.meta;

    if (!message) return;

    const instructions: any[] = message.instructions || [];
    const innerInstructions: any[] = [];

    if (meta?.innerInstructions) {
      for (const inner of meta.innerInstructions) {
        if (inner.instructions) innerInstructions.push(...inner.instructions);
      }
    }

    const allInstructions = [...instructions, ...innerInstructions];

    for (const ix of allInstructions) {
      const programId = this.resolveProgramId(ix, message);
      if (!programId) continue;

      if (programId === CONFIG.PUMP_PROGRAM_ID.toBase58()) {
        this.processPumpInstruction(ix, message, slot);
      } else if (programId === 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA') {
        if (this.onAmmPool) this.onAmmPool({ ix, message, slot });
      }
    }
  }

  /**
   * Account keys arrive over gRPC as raw 32-byte protobuf `bytes`, not base58 strings — the
   * old `key.pubkey` fallback was undefined for every one of them, so program IDs never
   * resolved and no instruction was ever dispatched. Handle all three shapes defensively:
   * already-a-string (JSON-RPC style), {pubkey} wrapper, or raw bytes needing encoding.
   */
  private toBase58(key: any): string | null {
    if (!key) return null;
    if (typeof key === 'string') return key;
    if (key.pubkey) {
      return typeof key.pubkey === 'string' ? key.pubkey : bs58.encode(Buffer.from(key.pubkey));
    }
    try {
      return bs58.encode(Buffer.from(key));
    } catch {
      return null;
    }
  }

  private resolveProgramId(ix: any, message: any): string | null {
    if (ix.programId) return this.toBase58(ix.programId);
    if (ix.programIdIndex !== undefined && message?.accountKeys) {
      return this.toBase58(message.accountKeys[ix.programIdIndex]);
    }
    return null;
  }

  private processPumpInstruction(ix: any, message: any, slot: number): void {
    const data = this.getInstructionData(ix);
    if (!data || data.length < 8) return;

    const discriminator = data.subarray(0, 8);

    // TEMP DIAGNOSTIC — a fixed-count sample is useless for observing a rare instruction: the
    // previous 20-line cap was exhausted in 68ms of buy/sell traffic and never witnessed a
    // CREATE. Count discriminators continuously and emit a histogram every 30s instead, so we
    // can tell "CREATE never arrives in the stream" apart from "CREATE arrives but is rejected
    // downstream". Remove once bonding-curve detection is confirmed working.
    const hex = discriminator.toString('hex');
    this.discriminatorCounts.set(hex, (this.discriminatorCounts.get(hex) || 0) + 1);
    const now = Date.now();
    if (now - this.lastDiscriminatorLog > 30_000) {
      this.lastDiscriminatorLog = now;
      logger.warn({
        counts: Object.fromEntries(this.discriminatorCounts),
        createExpected: CREATE_DISCRIMINATOR.toString('hex'),
      }, '🔬 DIAGNOSTIC: pump discriminator histogram (30s)');
    }

    if (!discriminator.equals(CREATE_DISCRIMINATOR)) return;

    const accounts = this.resolveAccounts(ix, message);
    // Log rejections too — otherwise a CREATE that arrives but has an unexpected account count
    // would be dropped here as silently as the envelope bug dropped everything upstream.
    if (accounts.length < 7) {
      logger.warn({ accountsLength: accounts.length, accounts }, '🔬 DIAGNOSTIC: CREATE seen but too few accounts — rejected');
      return;
    }

    const mintAddress = accounts[0];
    const creatorAddress = accounts[6];
    const bondingCurveAddress = accounts[1];

    // TEMP DIAGNOSTIC — trade-history.json shows most recorded creators sharing an identical,
    // clearly-corrupted prefix ("1111111113fGWZbwwxFB..."), meaning accounts[6] is very likely
    // the wrong index for this instruction shape (or resolveAccounts is mis-resolving it). Log
    // the full resolved account list for the first several CREATEs after each restart so we can
    // see real data instead of guessing. Remove once the real index/bug is confirmed and fixed.
    if (this.createDiagnosticCount < 10) {
      this.createDiagnosticCount++;
      logger.warn({
        mint: mintAddress,
        accountsLength: accounts.length,
        accounts,
        creatorAtIndex6: creatorAddress,
      }, '🔬 DIAGNOSTIC: CREATE instruction accounts dump');
    }

    if (this.seenTokens.has(mintAddress)) return;
    this.seenTokens.add(mintAddress);
    // Evict oldest entries if set grows too large
    if (this.seenTokens.size > this.SEEN_TOKENS_MAX) {
      const toDelete = Array.from(this.seenTokens).slice(0, this.SEEN_TOKENS_EVICT);
      for (const key of toDelete) this.seenTokens.delete(key);
      logger.debug({ remaining: this.seenTokens.size }, 'seenTokens evicted');
    }

    const event: NewTokenEvent = {
      mint: new PublicKey(mintAddress),
      bondingCurve: new PublicKey(bondingCurveAddress),
      creator: new PublicKey(creatorAddress),
      slot,
      timestamp: Date.now(),
    };

    logger.info({
      mint: mintAddress,
      creator: creatorAddress?.slice(0, 8) + '...',
      slot,
    }, '⚡ [gRPC] NEW TOKEN DETECTED');

    if (this.onNewToken) this.onNewToken(event);
  }

  private getInstructionData(ix: any): Buffer | null {
    if (!ix.data) return null;
    if (typeof ix.data === 'string') {
      try {
        return Buffer.from(bs58.decode(ix.data));
      } catch {
        try { return Buffer.from(ix.data, 'base64'); } catch { return null; }
      }
    }
    if (ix.data instanceof Uint8Array || Array.isArray(ix.data)) return Buffer.from(ix.data);
    return null;
  }

  private resolveAccounts(ix: any, message: any): string[] {
    const accountKeys: string[] = [];
    if (message?.accountKeys) {
      for (const key of message.accountKeys) {
        accountKeys.push(this.toBase58(key) || 'unknown');
      }
    }

    const accounts: string[] = [];
    // ix.accounts is protobuf `bytes` — iterating a Uint8Array yields the account indices
    // as numbers, which the first branch handles.
    if (ix.accounts) {
      for (const acc of ix.accounts) {
        if (typeof acc === 'number' || typeof acc === 'bigint') {
          accounts.push(accountKeys[Number(acc)] || 'unknown');
        } else {
          accounts.push(this.toBase58(acc) || 'unknown');
        }
      }
    }
    return accounts;
  }

  private handleError(err: any): void {
    logger.error({ 
      err: err.message || err,
      code: err.code,
      details: err.details
    }, 'gRPC stream error');
    this.cleanup();
    this.scheduleReconnect();
  }

  private handleDisconnect(): void {
    logger.warn('gRPC stream disconnected');
    this.cleanup();
    this.scheduleReconnect();
  }

  private async scheduleReconnect(): Promise<void> {
    if (!this.isRunning) return;
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        logger.error('Max reconnection attempts reached');
        return;
      }

      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60_000);
      logger.info({ attempt: this.reconnectAttempts, delay: `${(delay / 1000).toFixed(0)}s` }, 'Scheduling gRPC reconnection');

      await new Promise(resolve => setTimeout(resolve, delay));
      if (this.isRunning) await this.connect();
    } finally {
      this.isConnecting = false;
    }
  }

  private cleanup(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
    if (this.stream) {
      try { this.stream.end(); } catch {}
      try { this.stream.destroy(); } catch {}
      this.stream = null;
    }
    this.client = null as any;
  }

  private startHealthCheck(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    this.healthCheckInterval = setInterval(() => {
      if (this.stream && this.isRunning) {
        try {
          // @ts-ignore — yellowstone-grpc SubscribeRequest type mismatch
          const pingRequest: SubscribeRequest = {
            slots: {},
            accounts: {},
            transactions: {},
            transactionsStatus: {},
            blocks: {},
            blocksMeta: {},
            entry: {},
            accountsDataSlice: [],
            commitment: 0, // CommitmentLevel.PROCESSED = 0
          };
          (pingRequest as any).ping = { id: 1 };
          this.stream.write(pingRequest);
        } catch (err) {
          logger.warn({ err }, 'Health check ping failed');
          this.handleDisconnect();
        }
      }
    }, 30_000);
  }

  stop(): void {
    logger.info('Stopping gRPC watcher...');
    this.isRunning = false;
    this.cleanup();
  }

  getStats(): { connected: boolean; lastSlot: number; seenTokens: number } {
    return {
      connected: this.client !== null && this.stream !== null,
      lastSlot: this.lastSlot,
      seenTokens: this.seenTokens.size,
    };
  }
}
