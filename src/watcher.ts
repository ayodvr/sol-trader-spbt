import { Connection, PublicKey, AccountInfo } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import { NewTokenEvent } from './types.js';
import { deriveBondingCurve } from './utils.js';
import { blockhashCache } from './blockhash-cache.js';
import pino from 'pino';

const logger = pino({ name: 'watcher' });

/**
 * Pump.fun creates a BondingCurve account when a new token is created.
 * We detect this by subscribing to new account creations under the Pump program.
 * Each BondingCurve account is a PDA with seeds ["bonding-curve", mint].
 */
export class PumpWatcher {
  private connection: Connection;
  private seenTokens: Set<string> = new Set();
  private readonly SEEN_TOKENS_MAX = 10_000;
  private readonly SEEN_TOKENS_EVICT = 1_000;
  private subscriptionId: number | null = null;

  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, {
      wsEndpoint: CONFIG.WS_URL,
      commitment: 'confirmed',
    });
  }

  async start(onNewToken: (event: NewTokenEvent) => void): Promise<void> {
    logger.info('Starting Pump.fun token watcher (WebSocket)...');
    
    // Start blockhash cache fallback since we don't have gRPC
    blockhashCache.startFallback(this.connection, 2000);

    this.subscriptionId = this.connection.onProgramAccountChange(
      CONFIG.PUMP_PROGRAM_ID,
      async (accountInfo, context) => {
        try {
          const event = this.parseBondingCurveAccount(accountInfo, context.slot);
          if (!event) return;

          const key = event.mint.toBase58();
          if (this.seenTokens.has(key)) return;
          this.seenTokens.add(key);
          // Evict oldest entries if set grows too large
          if (this.seenTokens.size > this.SEEN_TOKENS_MAX) {
            const toDelete = Array.from(this.seenTokens).slice(0, this.SEEN_TOKENS_EVICT);
            for (const k of toDelete) this.seenTokens.delete(k);
          }

          logger.info({
            mint: key,
            bondingCurve: event.bondingCurve.toBase58(),
            slot: event.slot,
          }, '⚡ NEW TOKEN DETECTED');

          onNewToken(event);
        } catch (err) {
          logger.error({ err }, 'Error processing program account change');
        }
      },
      'confirmed'
    );

    // Polling fallback placeholder
    this.startPollingFallback(onNewToken);

    logger.info(`Watcher subscribed with ID: ${this.subscriptionId}`);
  }

  private parseBondingCurveAccount(
    keyedAccountInfo: any,
    slot: number
  ): NewTokenEvent | null {
    const data = keyedAccountInfo.accountInfo.data;
    const pubkey = new PublicKey(keyedAccountInfo.accountId);

    if (data.length < 64) return null;

    const mintBytes = data.subarray(0, 32);
    const mint = new PublicKey(mintBytes);

    const creatorBytes = data.subarray(49, 81);
    const creator = new PublicKey(creatorBytes);

    const expectedCurve = deriveBondingCurve(mint);
    if (pubkey.toBase58() !== expectedCurve.toBase58()) return null;

    return {
      mint,
      bondingCurve: pubkey,
      creator,
      slot,
      timestamp: Date.now(),
    };
  }

  private startPollingFallback(onNewToken: (event: NewTokenEvent) => void): void {
    setInterval(async () => {
      try {
        // In production: use Helius DAS webhooks or BitQuery as fallback
      } catch {
        // Silent
      }
    }, 1000);
  }

  stop(): void {
    blockhashCache.stopFallback();
    if (this.subscriptionId !== null) {
      this.connection.removeProgramAccountChangeListener(this.subscriptionId);
      logger.info('Watcher stopped');
    }
  }
}
