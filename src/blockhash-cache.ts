import { Connection } from '@solana/web3.js';
import pino from 'pino';

const logger = pino({ name: 'blockhash-cache' });

export class BlockhashCache {
  private static instance: BlockhashCache;
  private currentBlockhash: string | null = null;
  private lastUpdateTime: number = 0;
  private connection: Connection | null = null;
  private fallbackInterval: ReturnType<typeof setInterval> | null = null;

  private constructor() {}

  public static getInstance(): BlockhashCache {
    if (!BlockhashCache.instance) {
      BlockhashCache.instance = new BlockhashCache();
    }
    return BlockhashCache.instance;
  }

  /**
   * Set the latest blockhash from a gRPC stream or other fast source.
   */
  public set(blockhash: string): void {
    if (this.currentBlockhash !== blockhash) {
      this.currentBlockhash = blockhash;
      this.lastUpdateTime = Date.now();
      // Uncomment to debug blockhash updates:
      // logger.debug({ blockhash }, 'Blockhash cache updated');
    }
  }

  /**
   * Start a fallback polling interval (useful for WebSocket mode or startup).
   */
  public startFallback(connection: Connection, intervalMs: number = 3000): void {
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
    }
    this.connection = connection;
    
    // Initial fetch
    this.fetchFromRpc();

    this.fallbackInterval = setInterval(() => {
      // Only fetch if the cache is stale (> 3 seconds old)
      if (Date.now() - this.lastUpdateTime > 3000) {
        this.fetchFromRpc();
      }
    }, intervalMs);
  }

  private async fetchFromRpc(): Promise<void> {
    if (!this.connection) return;
    try {
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      this.set(blockhash);
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to fetch fallback blockhash');
    }
  }

  /**
   * Stop the fallback interval.
   */
  public stopFallback(): void {
    if (this.fallbackInterval) {
      clearInterval(this.fallbackInterval);
      this.fallbackInterval = null;
    }
  }

  /**
   * Get the current blockhash. 
   * Instantly returns the cached blockhash if available and fresh.
   * If empty or stale, it fetches synchronously from the RPC as a last resort.
   */
  public async get(connection: Connection): Promise<string> {
    // If we have a cached blockhash updated in the last 75 slots (~30s), use it.
    if (this.currentBlockhash && (Date.now() - this.lastUpdateTime < 30_000)) {
      return this.currentBlockhash;
    }

    // Cache miss or stale — fallback to RPC (should only happen on immediate startup)
    logger.warn('Blockhash cache miss — fetching from RPC');
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    this.set(blockhash);
    return blockhash;
  }
}

// Export a singleton instance
export const blockhashCache = BlockhashCache.getInstance();
