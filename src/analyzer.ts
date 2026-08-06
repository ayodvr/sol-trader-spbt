import { Connection, PublicKey } from '@solana/web3.js';
import { getMint, getAssociatedTokenAddress, getTransferFeeConfig, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import fs from 'fs';

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

// ─── Cross-run creator blacklist ───────────────────────────────────────────
// Persists to disk so a wallet that rugged you once stays blocked across restarts, not just
// within the current process's memory. Only "confirmed bad" outcomes add a strike — rug_detected
// (price literally hit zero) or a severely-realized loss (worse than -60%) — not ordinary
// stop-losses/trailing-stops, which happen on the majority of trades in this environment and
// would otherwise blacklist most creators regardless of whether they actually did anything wrong.
const RUG_DB_FILE = './rug-db.json';
const RUG_BLACKLIST_STRIKES = 1; // one confirmed rug = permanently blocked

/**
 * Helper to wrap RPC calls with automatic exponential backoff for Helius free tier (10 RPS limit).
 */
async function withRpcRetry<T>(fn: () => Promise<T>, maxRetries: number = 3, initialDelayMs: number = 350): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const msg = err?.message || err?.toString() || '';
      const is429 = msg.includes('429') || err?.status === 429 || err?.response?.status === 429;
      if (is429 && attempt <= maxRetries) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 150);
        logger.debug({ attempt, delay }, '⚡ Helius RPC 429 rate limit hit — retrying with backoff');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

export class RugAnalyzer {
  private connection: Connection;
  private rugDb: Map<string, number> = new Map(); // creator base58 → confirmed-rug strike count

  constructor() {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    try {
      const data = JSON.parse(fs.readFileSync(RUG_DB_FILE, 'utf-8'));
      this.rugDb = new Map(Object.entries(data));
      logger.info({ count: this.rugDb.size }, '🗄️ Loaded creator rug blacklist from disk');
    } catch { /* fresh start — no rug-db.json yet */ }
  }

  private saveRugDb(): void {
    try {
      fs.writeFileSync(RUG_DB_FILE, JSON.stringify(Object.fromEntries(this.rugDb), null, 2));
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to persist rug blacklist');
    }
  }

  /**
   * Record a confirmed-bad outcome against a creator wallet. Persists immediately so the
   * blacklist survives a restart. Call this from the exit-success path — see analyze()'s
   * hard-block check below for where this gets enforced on future candidates.
   */
  recordRug(creatorStr: string): void {
    const count = (this.rugDb.get(creatorStr) || 0) + 1;
    this.rugDb.set(creatorStr, count);
    this.saveRugDb();
    logger.warn({ creator: creatorStr.slice(0, 8) + '...', strikes: count }, '🚫 Creator recorded on rug blacklist');
  }

  async analyze(mint: PublicKey, bondingCurveOrPool: PublicKey, creator?: PublicKey, isAmm: boolean = false): Promise<RugCheckResult> {
    const mintStr = mint.toBase58();

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

    // ─── Hard block: creator previously confirmed to have rugged us ───────────
    // Checked before anything else — no point spending RPC/Helius calls analyzing a token from
    // a wallet we already have first-hand evidence on. No cache TTL on this one; it's permanent
    // until manually cleared (delete the entry from rug-db.json).
    const creatorStr = creator?.toBase58();
    if (creatorStr && (this.rugDb.get(creatorStr) || 0) >= RUG_BLACKLIST_STRIKES) {
      result.safe = false;
      result.score = 0;
      result.flags.push('SERIAL_RUGGER');
      logger.warn({ creator: creatorStr.slice(0, 8) + '...' }, '⛔ Creator previously rugged us — hard skip');
      return result;
    }

    // Return cached result if still valid
    const cached = analysisCache.get(mintStr);
    if (cached && Date.now() < cached.expiresAt) {
      logger.debug({ mint: mintStr }, 'Using cached rug check result');
      return cached.result;
    }

    try {
      // ─── Check 1: Mint & Freeze Authority ───────────
      // Try standard SPL Token first, then Token-2022 (pump.fun now uses Token-2022)
      let mintInfo;
      let tokenProgram = TOKEN_PROGRAM_ID;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          mintInfo = await withRpcRetry(() => getMint(this.connection, mint, 'confirmed', tokenProgram));
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

      // ─── Check 1b: Token-2022 transfer-fee tax (the only real buy/sell tax mechanism
      // a pump.fun-style Token-2022 mint can carry) ───────────
      // getMint() already populated mintInfo.tlvData for Token-2022 mints — no extra RPC call needed.
      if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
        try {
          const feeConfig = getTransferFeeConfig(mintInfo);
          if (feeConfig) {
            // newerTransferFee is the fee scheduled to take effect at its recorded epoch — check
            // it too, not just the currently-active one, since devs can pre-schedule a fee hike
            // that only becomes visible on-chain in advance via this field.
            const feeBps = Math.max(
              feeConfig.olderTransferFee.transferFeeBasisPoints,
              feeConfig.newerTransferFee.transferFeeBasisPoints
            );
            const feePercent = feeBps / 100;
            result.buyTax = feePercent;
            result.sellTax = feePercent; // Token-2022 transfer fee applies uniformly to every transfer

            if (feePercent > CONFIG.MAX_BUY_TAX || feePercent > CONFIG.MAX_SELL_TAX) {
              result.flags.push(`TRANSFER_FEE_TOO_HIGH: ${feePercent}%`);
              result.score = 0;
              result.safe = false;
              logger.warn({ mint: mintStr, feePercent }, '❌ Token-2022 transfer fee exceeds max — instant fail');
              analysisCache.set(mintStr, { result, expiresAt: Date.now() + CACHE_TTL_MS });
              return result;
            } else if (feePercent > 0) {
              result.flags.push(`TRANSFER_FEE: ${feePercent}%`);
              result.score -= 10;
            }
          }
        } catch (feeErr: any) {
          logger.debug({ mint: mintStr, err: feeErr.message }, 'Transfer-fee extension read failed — treating as untaxed');
        }
      }

      // ─── Check 2: Tax estimation via bonding curve ───────────
      // BUG FIX: this check only makes sense for the bonding-curve account layout
      // (virtualTokenReserves@64, realTokenReserves@80). For the AMM path, `bondingCurveOrPool`
      // is a PumpSwap POOL account instead, whose layout is completely different (creator@11,
      // baseMint@43, quoteMint@75, baseReserves@107, quoteReserves@115 — see pumpswap.ts). Bytes
      // 64-72/80-88 of a pool account fall inside the creator/baseMint public keys, so this was
      // reinterpreting arbitrary pubkey bytes as a "reserve deviation" and handing out essentially
      // random -25/-45 score penalties to AMM tokens with zero relationship to real risk.
      let curveRealTokenReserves: bigint | null = null;
      if (!isAmm) {
        const curveAccount = await withRpcRetry(() => this.connection.getAccountInfo(bondingCurveOrPool));
        if (curveAccount) {
          const view = new DataView(curveAccount.data.buffer);

          const virtualTokenReserves = view.getBigUint64(64, true);
          const realTokenReserves = view.getBigUint64(80, true);
          curveRealTokenReserves = realTokenReserves;

          if (virtualTokenReserves > 0n) {
            const tokenDeviation = Number(
              (virtualTokenReserves - realTokenReserves) * 10000n / virtualTokenReserves
            ) / 100;

            if (tokenDeviation > 30) {
              result.flags.push(`HIGH_TOKEN_DEVIATION: ${tokenDeviation}%`);
              result.score -= 45;
            } else if (tokenDeviation > 5) {
              result.flags.push(`HIGH_TOKEN_DEVIATION: ${tokenDeviation}%`);
              result.score -= 25;
            }
          }
        }
      }

      // ─── Check 3: Supply distribution ───────────
      // The bonding curve custodies the entire unsold supply in its own ATA until people buy —
      // right at launch that's ~100% of supply, which would otherwise make getTokenLargestAccounts
      // report the curve itself as the #1 "holder" and false-positive almost every fresh token as
      // over-concentrated. Exclude it, and compare against CIRCULATING supply (total minus what's
      // still parked in the curve) rather than raw total supply — otherwise removing the curve's
      // balance from the numerator while leaving it in the denominator would make concentration
      // among real buyers look artificially low instead.
      let custodialTokenAccount: PublicKey | null = null;
      if (!isAmm) {
        try {
          custodialTokenAccount = await getAssociatedTokenAddress(mint, bondingCurveOrPool, true, tokenProgram);
        } catch { /* fall back to uncorrected calculation below */ }
      }

      const topHolders = await this.getTopHolders(mint, 11);
      const totalSupply = mintInfo.supply;

      if (totalSupply > 0n) {
        let top10Sum = 0n;
        let top10Count = 0;
        for (const [addr, balance] of topHolders) {
          if (custodialTokenAccount && addr.equals(custodialTokenAccount)) continue;
          if (top10Count >= 10) continue;
          top10Sum += balance;
          top10Count++;
        }

        const circulatingSupply = curveRealTokenReserves !== null
          ? totalSupply - curveRealTokenReserves
          : totalSupply;
        const denom = circulatingSupply > 0n ? circulatingSupply : totalSupply;

        result.top10HolderPercent = Number((top10Sum * 10000n) / denom) / 100;

        if (result.top10HolderPercent > 65) {
          // Insiders/bundlers hold > 65% of supply = guaranteed fast-rug dump = INSTANT FAIL
          result.flags.push(`EXCESSIVE_HOLDER_CONCENTRATION: ${result.top10HolderPercent}%`);
          result.score = 0;
          result.safe = false;
          logger.warn({ mint: mintStr, pct: result.top10HolderPercent }, '⛔ Excessive top 10 holder concentration (>65%) — instant fail');
          analysisCache.set(mintStr, { result, expiresAt: Date.now() + CACHE_TTL_MS });
          return result;
        } else if (result.top10HolderPercent > 35) {
          result.flags.push(`TOP_10_HOLDERS: ${result.top10HolderPercent}%`);
          result.score -= 30;
          logger.warn({ pct: result.top10HolderPercent }, '⚠️ High holder concentration');
        }
      }

      // ─── Check 4: Volume Spike / Coordinated Pump Detection ───────────
      // Runs on both tracks now. checkVolumeSpike requires real sell pressure to exist before
      // it fires (see sellCount gate there), which handles the false-positive risk on BOTH
      // sides: a brand-new bonding-curve token has no sellers yet by construction, and a
      // freshly-graduated AMM pool sees a real simultaneous buy rush — neither should trip
      // "coordinated pump" just for being all-buys with nothing to compare against yet.
      {
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
      }

      // ─── Check 5: Developer History via Helius (Cached) ───────────
      if (creator) {
        const devScore = await this.checkDevHistory(creator.toBase58());
        result.devScore = devScore;
        if (devScore < CONFIG.MIN_DEV_HISTORY_SCORE) {
          const penalty = Math.floor((CONFIG.MIN_DEV_HISTORY_SCORE - devScore) / 5) * 10; // Up to -100 points for serial ruggers
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
      if (CONFIG.REQUIRE_SOCIALS && !result.hasSocials) {
        result.safe = false;
        logger.info({ mint: mintStr }, '⛔ Hard-skipped: Social links required by CONFIG.REQUIRE_SOCIALS');
      } else {
        result.safe = result.score >= CONFIG.MIN_RUG_SCORE;
      }
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
      const accounts = await withRpcRetry(() => this.connection.getTokenLargestAccounts(mint));
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
            // BUG FIX: the old check required mintInfo.supply === 0n — the entire token supply
            // burned — to count as a rug. That essentially never happens in a real pump.fun
            // dump: the mint and its full supply stay intact forever; what actually changes is
            // the creator's OWN balance (they sell out) and the pool's liquidity (drained). A
            // serial rugger who dumped every prior token and walked away would show supply
            // untouched every time, scoring as perfectly clean. Check what actually happens
            // instead: does the creator currently hold zero of a token we know they sold from?
            try {
              const mintPubkey = new PublicKey(transfer.mint);
              const ageHours = (now - (tx.timestamp * 1000)) / (1000 * 60 * 60);

              if (ageHours < 24) {
                const creatorBalance = await this.getOwnerTokenBalance(mintPubkey, new PublicKey(creatorStr));
                if (creatorBalance === 0n) {
                  rugCount++;
                }
              }
            } catch {
              // Mint/account not found — likely rugged/abandoned
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
   * Get an owner's current balance of a mint, trying standard SPL Token first then Token-2022
   * (historic mints from a creator's past launches could be either). Returns 0n if neither ATA
   * exists or has a balance — i.e. the owner currently holds none of it.
   */
  private async getOwnerTokenBalance(mint: PublicKey, owner: PublicKey): Promise<bigint> {
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const ata = await getAssociatedTokenAddress(mint, owner, false, programId);
        const bal = await this.connection.getTokenAccountBalance(ata);
        return BigInt(bal.value.amount);
      } catch { /* ATA doesn't exist under this program — try the other, or fall through to 0 */ }
    }
    return 0n;
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
      // >92% buys in first 20 transactions = suspicious coordinated launch — but only once
      // there's actually been real selling to compare against (sellCount >= 3). A brand-new
      // bonding-curve token or a just-graduated AMM pool can legitimately show ~100% buys for
      // a while simply because nobody who just bought seconds ago is selling yet — that's not
      // coordination, it's just early. Wash-trading/coordinated-pump patterns show up as
      // buy-skewed ratios despite genuine two-sided flow already existing, not as "no sells yet".
      const COORDINATED_THRESHOLD = parseInt(process.env.COORDINATED_BUY_THRESHOLD || '92');
      const isCoordinated = sellCount >= 3 && buyPct >= COORDINATED_THRESHOLD && totalSided >= 10;

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
