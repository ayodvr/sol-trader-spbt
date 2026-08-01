import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

import { CONFIG } from '../config.js';
import { RugCheckResult } from './types.js';
import pino from 'pino';
import axios from 'axios';

const logger = pino({ name: 'analyzer' });

// Cache analysis results for 5 minutes to avoid re-analyzing the same mint
const analysisCache = new Map<string, { result: RugCheckResult; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Cache developer history results for 1 hour to prevent redundant Helius API calls (saves massive RPC credits)
const devHistoryCache = new Map<string, { devScore: number; expiresAt: number }>();
const DEV_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export class RugAnalyzer {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
  }

  async analyze(mint: PublicKey, bondingCurveOrPool: PublicKey, creator?: PublicKey): Promise<RugCheckResult> {
    const mintStr = mint.toBase58();

    // Return cached result if still valid
    const cached = analysisCache.get(mintStr);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug({ mint: mintStr }, 'Using cached rug check result');
      return cached.result;
    }
    const result: RugCheckResult = {
      safe: false,
      score: 100,
      flags: [],
      buyTax: 0,
      sellTax: 0,
      mintAuthorityRevoked: false,
      freezeAuthorityRevoked: false,
      top10HolderPercent: 0,
      liquidityLocked: false,
      hasSocials: false,
      devScore: 100,
      socialScore: 0,
    };

    try {
      // ─── Check 1: Mint & Freeze Authority ───────────
      // Try standard SPL Token first, then Token-2022 (pump.fun now uses Token-2022)
      let mintInfo;
      let tokenProgram = TOKEN_PROGRAM_ID;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          mintInfo = await getMint(this.connection, mint, 'confirmed', tokenProgram);
          break;
        } catch (mintErr: any) {
          const isOwnerError = mintErr?.name === 'TokenInvalidAccountOwnerError' ||
            mintErr?.constructor?.name === 'TokenInvalidAccountOwnerError';
          if (isOwnerError && tokenProgram === TOKEN_PROGRAM_ID) {
            // Retry with Token-2022 program — pump.fun migrated to Token-2022
            tokenProgram = TOKEN_2022_PROGRAM_ID;
            logger.debug({ mint: mintStr }, 'Retrying as Token-2022 mint');
            continue; // retry immediately with Token-2022
          }
          if (isOwnerError) {
            // Not a recognised token program — skip
            logger.debug({ mint: mintStr }, 'Unknown token program — skipping');
            return { safe: false, score: 0, flags: ['UNKNOWN_TOKEN_PROGRAM'], mintAuthorityRevoked: false, freezeAuthorityRevoked: false, buyTax: 0, sellTax: 0, top10HolderPercent: 0, liquidityLocked: false };
          }
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 400 * attempt));
          } else {
            throw mintErr;
          }
        }
      }
      if (!mintInfo) throw new Error('getMint returned undefined after retries');

      // Store the detected token program so pumpswap can use the correct ATA program
      result.tokenProgram = tokenProgram.toBase58();
      logger.debug({ mint: mintStr, tokenProgram: result.tokenProgram }, '🔍 Token program detected');



      if (mintInfo.mintAuthority === null) {
        result.mintAuthorityRevoked = true;
        logger.debug({ mint: mintStr }, '✅ Mint authority revoked');
      } else {
        // Mint authority active = developer can print unlimited tokens = INSTANT FAIL
        result.flags.push('MINT_AUTHORITY_ACTIVE');
        result.score = 0;
        result.safe = false;
        logger.warn({ mint: mintStr }, '❌ Mint authority still active — instant fail (saved RPC calls)');
        analysisCache.set(mintStr, { result, expiresAt: Date.now() + CACHE_TTL_MS });
        return result; // SHORT-CIRCUIT EARLY: Stop here! No top holders check, no Helius API calls.
      }

      if (mintInfo.freezeAuthority === null) {
        result.freezeAuthorityRevoked = true;
      } else {
        result.flags.push('FREEZE_AUTHORITY_ACTIVE');
        result.score -= 15;
      }

      // ─── Check 2: Tax estimation via bonding curve ───────────
      const curveAccount = await this.connection.getAccountInfo(bondingCurveOrPool);
      if (curveAccount) {
        const view = new DataView(curveAccount.data.buffer);

        const virtualTokenReserves = view.getBigUint64(64, true);
        const realTokenReserves = view.getBigUint64(80, true);

        if (virtualTokenReserves > 0n) {
          const tokenDeviation = Number(
            (virtualTokenReserves - realTokenReserves) * 10000n / virtualTokenReserves
          ) / 100;

          if (tokenDeviation > 5) {
            result.flags.push(`HIGH_TOKEN_DEVIATION: ${tokenDeviation}%`);
            result.score -= 25;
          }
        }
      }

      // ─── Check 3: Supply distribution ───────────
      const topHolders = await this.getTopHolders(mint, 10);
      const totalSupply = mintInfo.supply;

      if (totalSupply > 0n) {
        let top10Sum = 0n;
        for (const [, balance] of topHolders) {
          top10Sum += balance;
        }
        result.top10HolderPercent = Number((top10Sum * 10000n) / totalSupply) / 100;

        if (result.top10HolderPercent > 80) {
          result.flags.push(`TOP_10_HOLDERS: ${result.top10HolderPercent}%`);
          result.score -= 20;
          logger.warn({ pct: result.top10HolderPercent }, '⚠️ High holder concentration');
        }
      }

      // ─── Check 4: Volume Spike / Coordinated Pump Detection ───────────
      const volumeCheck = await this.checkVolumeSpike(mintStr);
      if (volumeCheck.isCoordinated) {
        // Coordinated pump = wash trading by dev and insiders = INSTANT FAIL
        result.flags.push(`COORDINATED_PUMP: ${volumeCheck.buyPct}% buys`);
        result.score = 0;
        result.safe = false;
        logger.warn({ mint: mintStr, buyPct: volumeCheck.buyPct }, '⚠️ Coordinated pump — instant fail');
        analysisCache.set(mintStr, { result, expiresAt: Date.now() + CACHE_TTL_MS });
        return result;
      }

      // ─── Check 5: Developer History via Helius (Cached) ───────────
      if (creator) {
        const devScore = await this.checkDevHistory(creator.toBase58());
        result.devScore = devScore;
        if (devScore < 50) {
          const penalty = Math.floor((50 - devScore) / 5) * 10; // Up to -100 points for serial ruggers
          result.score -= penalty;
          result.flags.push(`BAD_DEV_HISTORY: ${devScore}`);
          logger.warn({ creator: creator.toBase58().slice(0, 8), devScore, penalty }, '⚠️ Suspicious dev history');
        }
      }

      // ─── Check 5: Social Presence (on-chain metadata first, DexScreener boost) ───────────
      if (CONFIG.REQUIRE_SOCIALS) {
        const socialData = await this.checkSocials(mint.toBase58());
        result.hasSocials = socialData.hasSocials;
        result.socialScore = socialData.score;

        if (!result.hasSocials) {
          result.flags.push('NO_SOCIALS');
          result.score -= 30; // Penalise but don't hard-block (new tokens may not be on DexScreener yet)
          logger.warn({ mint: mint.toBase58() }, '⚠️ No social links found');
        } else {
          logger.info({ mint: mint.toBase58(), socials: socialData.score }, '✅ Socials found');
          result.score += 10;
        }
      }

      // ─── Final verdict ───────────
      result.safe = result.score >= 45;
      logger.info({
        mint: mintStr,
        safe: result.safe,
        score: result.score,
        flags: result.flags,
        top10Pct: result.top10HolderPercent,
      }, 'Rug check complete');

      // Cache the result
      analysisCache.set(mintStr, { result, expiresAt: Date.now() + CACHE_TTL_MS });

    } catch (err) {
      logger.error({ err, mint: mint.toBase58() }, 'Error analyzing token');
      result.flags.push('ANALYSIS_ERROR');
      result.score = 0;
      result.safe = false;
    }

    return result;
  }

  private async getTopHolders(
    mint: PublicKey,
    count: number
  ): Promise<Array<[PublicKey, bigint]>> {
    try {
      const accounts = await this.connection.getTokenLargestAccounts(mint);
      return accounts.value
        .slice(0, count)
        .map(acc => [acc.address, BigInt(acc.amount)] as [PublicKey, bigint]);
    } catch {
      return [];
    }
  }

  /**
   * Check on-chain token metadata for social links (works at launch, unlike DexScreener).
   * Falls back to DexScreener as a secondary score booster.
   */
  private async checkSocials(mintStr: string): Promise<{ hasSocials: boolean; score: number }> {
    let hasSocials = false;
    let score = 0;

    // ─── Primary: Pump.fun on-chain metadata URI ───
    try {
      // Pump.fun tokens store metadata in a JSON file at a URI on IPFS/Arweave
      // The metadata account address can be derived via Metaplex PDA
      const mintPubkey = new PublicKey(mintStr);
      const METAPLEX_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
      const [metadataAddress] = PublicKey.findProgramAddressSync(
        [
          Buffer.from('metadata'),
          METAPLEX_PROGRAM.toBytes(),
          mintPubkey.toBytes(),
        ],
        METAPLEX_PROGRAM
      );

      const metadataAccount = await this.connection.getAccountInfo(metadataAddress);
      if (metadataAccount && metadataAccount.data.length > 100) {
        // Metaplex metadata layout: uri starts at offset 115, padded to 200 bytes
        const data = metadataAccount.data;
        // Skip discriminator (1) + key (1) + update_authority (32) + mint (32) + name_len (4) + name (32) + symbol_len (4) + symbol (10)
        // URI starts at ~116 after lengths
        let offset = 1 + 32 + 32;
        const nameLen = data.readUInt32LE(offset); offset += 4;
        offset += nameLen;
        const symbolLen = data.readUInt32LE(offset); offset += 4;
        offset += symbolLen;
        const uriLen = data.readUInt32LE(offset); offset += 4;
        const uri = data.slice(offset, offset + uriLen).toString('utf8').replace(/\0/g, '').trim();

        if (uri && (uri.startsWith('http') || uri.startsWith('ipfs'))) {
          logger.debug({ mint: mintStr, uri: uri.slice(0, 60) }, 'Found metadata URI');
          
          // Fetch the JSON metadata (with short timeout — don't block the snipe)
          const metaRes = await axios.get(uri, { timeout: 1500 });
          const meta = metaRes.data;

          if (meta?.twitter || meta?.telegram || meta?.website) {
            hasSocials = true;
            if (meta.twitter) score += 20;
            if (meta.telegram) score += 20;
            if (meta.website) score += 10;
            logger.info({ mint: mintStr, score }, '✅ On-chain socials found');
          }
        }
      }
    } catch (err: any) {
      logger.debug({ mint: mintStr, err: err.message }, 'On-chain metadata check failed — trying DexScreener');
    }

    // ─── Secondary: DexScreener (boosts score if token is already indexed) ───
    if (!hasSocials) {
      try {
        const res = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintStr}`, { timeout: 1500 });
        const pairs = res.data?.pairs || [];

        if (pairs.length > 0) {
          const pair = pairs[0];
          const socials = pair.info?.socials || [];
          const websites = pair.info?.websites || [];

          if (socials.length > 0 || websites.length > 0) {
            hasSocials = true;
            score += socials.length * 10;
            score += websites.length * 20;
          }
        }
        // If DexScreener doesn't have it yet (normal for brand-new tokens), that's OK — don't penalise
      } catch (err: any) {
        logger.debug({ mint: mintStr, err: err.message }, 'DexScreener check failed');
      }
    }

    return { hasSocials, score };
  }

  /**
   * Check creator wallet history via Helius Enhanced Transactions API.
   * Detects serial ruggers by looking for previous token creations that died.
   * Returns a score 0-100 (100 = clean, lower = suspicious).
   */
  private async checkDevHistory(creatorStr: string): Promise<number> {
    if (!CONFIG.HELIUS_API_KEY) return 100; // Skip if no API key

    // Return cached dev history score if available (saves Helius credits)
    const cachedDev = devHistoryCache.get(creatorStr);
    if (cachedDev && Date.now() < cachedDev.expiresAt) {
      logger.debug({ creator: creatorStr.slice(0, 8) }, 'Using cached dev history score');
      return cachedDev.devScore;
    }

    try {
      const url = `https://api.helius.xyz/v0/addresses/${creatorStr}/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=20&type=CREATE_TOKEN`;
      const res = await axios.get(url, { timeout: 3000 });
      const transactions: any[] = res.data || [];

      if (transactions.length === 0) {
        devHistoryCache.set(creatorStr, { devScore: 100, expiresAt: Date.now() + DEV_CACHE_TTL_MS });
        return 100; // New wallet, no history — neutral
      }

      let rugCount = 0;
      const now = Date.now();
      let checkedMints = 0;

      for (const tx of transactions) {
        if (checkedMints >= 3) break; // Limit RPC lookups to max 3 historic tokens to prevent credit drain

        const tokenTransfers = tx.tokenTransfers || [];
        for (const transfer of tokenTransfers) {
          if (transfer.fromUserAccount === creatorStr && transfer.mint) {
            checkedMints++;
            // Check if this token is still alive via token supply
            try {
              const mintPubkey = new PublicKey(transfer.mint);
              const mintInfo = await getMint(this.connection, mintPubkey);
              const ageHours = (now - (tx.timestamp * 1000)) / (1000 * 60 * 60);
              
              // If token is < 24h old and supply is 0, it rugged fast
              if (ageHours < 24 && mintInfo.supply === 0n) {
                rugCount++;
              }
            } catch {
              // Token account not found = likely rugged/abandoned
              rugCount++;
            }
          }
        }
      }

      // Score: -15 per rug found, floored at 0
      const score = Math.max(0, 100 - (rugCount * 15));
      logger.info({
        creator: creatorStr.slice(0, 8) + '...',
        totalTxs: transactions.length,
        rugCount,
        score,
      }, '🔍 Dev history check complete');

      // Cache the result for 1 hour
      devHistoryCache.set(creatorStr, { devScore: score, expiresAt: Date.now() + DEV_CACHE_TTL_MS });
      return score;

    } catch (err: any) {
      logger.debug({ creator: creatorStr.slice(0, 8), err: err.message }, 'Helius dev history check failed');
      return 100; // Fail open — don't block if Helius is down
    }
  }

  /**
   * Detect coordinated pump launches by checking if early transactions are
   * overwhelmingly buy-side (>92% buys in the first 20 txs = pre-coordinated).
   * Uses Helius token transaction history.
   */
  private async checkVolumeSpike(mintStr: string): Promise<{
    isCoordinated: boolean;
    buyPct: number;
    txCount: number;
  }> {
    if (!CONFIG.HELIUS_API_KEY) return { isCoordinated: false, buyPct: 0, txCount: 0 };

    try {
      const url = `https://api.helius.xyz/v0/addresses/${mintStr}/transactions?api-key=${CONFIG.HELIUS_API_KEY}&limit=20`;
      const res = await axios.get(url, { timeout: 2000 });
      const transactions: any[] = res.data || [];

      if (transactions.length < 5) {
        // Too few transactions to judge — new token, give benefit of the doubt
        return { isCoordinated: false, buyPct: 0, txCount: transactions.length };
      }

      let buyCount = 0;
      let sellCount = 0;

      for (const tx of transactions) {
        // Helius Enhanced Tx: look at token balance changes
        // A buy = SOL goes out, tokens come in
        // A sell = tokens go out, SOL comes in
        const tokenTransfers: any[] = tx.tokenTransfers || [];
        const nativeTransfers: any[] = tx.nativeTransfers || [];

        const tokensReceived = tokenTransfers.some(
          (t: any) => t.mint === mintStr && parseFloat(t.tokenAmount) > 0 && t.toUserAccount !== mintStr
        );
        const solSent = nativeTransfers.some(
          (t: any) => parseFloat(t.amount) > 0 && t.fromUserAccount !== mintStr
        );

        if (tokensReceived && solSent) {
          buyCount++;
        } else if (!tokensReceived && tokenTransfers.some((t: any) => t.mint === mintStr)) {
          sellCount++;
        }
      }

      const totalSided = buyCount + sellCount;
      if (totalSided === 0) return { isCoordinated: false, buyPct: 0, txCount: transactions.length };

      const buyPct = Math.round((buyCount / totalSided) * 100);
      // >92% buys in first 20 transactions = suspicious coordinated launch
      const COORDINATED_THRESHOLD = parseInt(process.env.COORDINATED_BUY_THRESHOLD || '92');
      const isCoordinated = buyPct >= COORDINATED_THRESHOLD && totalSided >= 10;

      logger.debug({
        mint: mintStr,
        buyCount,
        sellCount,
        buyPct,
        isCoordinated,
      }, 'Volume spike check complete');

      return { isCoordinated, buyPct, txCount: transactions.length };

    } catch (err: any) {
      logger.debug({ mint: mintStr, err: err.message }, 'Volume spike check failed — skipping');
      return { isCoordinated: false, buyPct: 0, txCount: 0 }; // Fail open
    }
  }
}
