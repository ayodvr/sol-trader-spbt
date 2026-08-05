import {
  Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram, TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';

import { CONFIG } from '../config.js';
import { submitJitoBundle, waitForBundleConfirmation } from './jito.js';
import { deriveBondingCurve } from './utils.js';
import { blockhashCache } from './blockhash-cache.js';
import { TipCalculator } from './tip-calculator.js';
import pino from 'pino';

const logger = pino({ name: 'pumpswap' });

const PUMP_SWAP_PROGRAM = new PublicKey('pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA');
const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

const AMM_DISCRIMINATORS = {
  BUY: [102, 6, 61, 18, 1, 218, 235, 234] as number[],
  SELL: [23, 183, 248, 55, 96, 216, 172, 96] as number[],
};

const FEE_RECIPIENTS: PublicKey[] = [
  new PublicKey('2VmjWmMbSfMxeWgQqG4oeDvbBBTt4bEtkcbYMn5XJDzE'),
  new PublicKey('7GJkYmbLQBbSspVN3BGEy9MHGYMNaKJ9LxFu2yLEnGYP'),
  new PublicKey('3gdaQtyz1qPBwWFYEeuQEYrWJFXxqKkBtKjhzRX3YgGb'),
  new PublicKey('EkYByeVvHhQKpfDn9j3xYGVRxv2mdnLVxr6c1TqBGMkf'),
  new PublicKey('6ZbTFJjXbQq1kMExVEAVowHJCMjGs8L6EGWPdzY2tEtD'),
  new PublicKey('H8e9RjyhMqnXdQ6Ki5H36s8bJBYGew3XJLkSBLtVHFwf'),
  new PublicKey('29ZzrGz4sKLYDRtAY1bcYrhN5iS7yMBWKQtoWzRkFYhc'),
  new PublicKey('9qNcwFXEe2bB4vpR7QQaJfAMQXwFK8LZM4Z2QDYBJWhs'),
];

function pickFeeRecipient(index: number): PublicKey {
  return FEE_RECIPIENTS[index % FEE_RECIPIENTS.length];
}

function deriveAmmGlobalConfig(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('global_config')], PUMP_SWAP_PROGRAM);
  return pda;
}

function deriveAmmPool(index: number, creator: PublicKey, baseMint: PublicKey, quoteMint: PublicKey = WSOL_MINT): PublicKey {
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(index, 0);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('pool'), indexBuf, creator.toBytes(), baseMint.toBytes(), quoteMint.toBytes()],
    PUMP_SWAP_PROGRAM
  );
  return pda;
}

function derivePoolV2(baseMint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('pool-v2'), baseMint.toBytes()], PUMP_SWAP_PROGRAM);
  return pda;
}

function deriveAmmEventAuthority(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], PUMP_SWAP_PROGRAM);
  return pda;
}

function deriveAmmUserVolumeAccumulator(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync([Buffer.from('user_volume_accumulator'), user.toBytes()], PUMP_SWAP_PROGRAM);
  return pda;
}

function isAmmPoolCashbackEnabled(poolData: Buffer): boolean {
  return poolData.length > 82 && poolData[82] !== 0;
}

function buildAmmBuyData(baseAmountOut: bigint, maxQuoteAmountIn: bigint, trackVolume: boolean = false): Buffer {
  const buf = Buffer.alloc(25);
  for (let i = 0; i < 8; i++) buf.writeUInt8(AMM_DISCRIMINATORS.BUY[i], i);
  buf.writeBigUInt64LE(baseAmountOut, 8);
  buf.writeBigUInt64LE(maxQuoteAmountIn, 16);
  buf.writeUInt8(trackVolume ? 1 : 0, 24);
  return buf;
}

function buildAmmSellData(baseAmountIn: bigint, minQuoteAmountOut: bigint, trackVolume: boolean = false): Buffer {
  const buf = Buffer.alloc(25);
  for (let i = 0; i < 8; i++) buf.writeUInt8(AMM_DISCRIMINATORS.SELL[i], i);
  buf.writeBigUInt64LE(baseAmountIn, 8);
  buf.writeBigUInt64LE(minQuoteAmountOut, 16);
  buf.writeUInt8(trackVolume ? 1 : 0, 24);
  return buf;
}

export interface AmmPoolInfo {
  poolAddress: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  poolIndex: number;
  baseReserves: bigint;
  quoteReserves: bigint;
  cashbackEnabled: boolean;
  poolBump: number;
}

export async function fetchAmmPool(
  connection: Connection,
  baseMint: PublicKey,
  poolCreator?: PublicKey,
): Promise<AmmPoolInfo | null> {
  const quoteMint = WSOL_MINT;
  const globalConfig = deriveAmmGlobalConfig();
  const configAcc = await connection.getAccountInfo(globalConfig);
  if (!configAcc) {
    logger.warn('AMM global config not found');
    return null;
  }

  const bondingCurve = deriveBondingCurve(baseMint);
  const creatorsToTry = [poolCreator || bondingCurve, bondingCurve].filter(Boolean) as PublicKey[];

  for (const creator of creatorsToTry) {
    for (let index = 0; index < 3; index++) {
      const poolAddress = deriveAmmPool(index, creator, baseMint, quoteMint);
      const poolAcc = await connection.getAccountInfo(poolAddress);

      if (poolAcc && poolAcc.data.length > 100) {
        const view = new DataView(poolAcc.data.buffer);
        const poolIndex = view.getUint16(9, true);
        const creatorRead = new PublicKey(poolAcc.data.subarray(11, 43));
        const baseMintRead = new PublicKey(poolAcc.data.subarray(43, 75));
        const quoteMintRead = new PublicKey(poolAcc.data.subarray(75, 107));
        const baseReserves = view.getBigUint64(107, true);
        const quoteReserves = view.getBigUint64(115, true);
        const cashback = isAmmPoolCashbackEnabled(poolAcc.data);
        const poolBump = view.getUint8(8);

        logger.info({ pool: poolAddress.toBase58(), index: poolIndex, cashback }, 'Found PumpSwap AMM pool');

        return { poolAddress, baseMint: baseMintRead, quoteMint: quoteMintRead, creator: creatorRead, poolIndex, baseReserves, quoteReserves, cashbackEnabled: cashback, poolBump };
      }
    }
  }

  return null;
}

export async function ammBuy(
  connection: Connection,
  wallet: Keypair,
  poolInfo: AmmPoolInfo,
  baseAmountOut: bigint,
  maxQuoteAmountIn: bigint,
  trackVolume: boolean = false,
  tipLamports: number = CONFIG.JITO_TIP_LAMPORTS,
  score: number = 45,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID, // Token-2022 or standard SPL
): Promise<{ success: boolean; bundleId?: string; error?: string }> {
  try {
    // Use the correct token program for creating token accounts
    const userBaseTokenAccount = await getAssociatedTokenAddress(poolInfo.baseMint, wallet.publicKey, false, tokenProgramId);
    const userQuoteTokenAccount = await getAssociatedTokenAddress(poolInfo.quoteMint, wallet.publicKey, false, TOKEN_PROGRAM_ID); // WSOL is always SPL

    // Idempotent ATA creation instructions (creates ATA if missing, succeeds silently if ATA exists)
    // Eliminates RPC getAccountInfo calls to prevent 429 rate limits and accelerate execution speed
    const ataIxs = [
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userBaseTokenAccount, wallet.publicKey, poolInfo.baseMint, tokenProgramId),
      createAssociatedTokenAccountIdempotentInstruction(wallet.publicKey, userQuoteTokenAccount, wallet.publicKey, poolInfo.quoteMint, TOKEN_PROGRAM_ID),
    ];

    const globalConfig = deriveAmmGlobalConfig();
    const eventAuthority = deriveAmmEventAuthority();
    const feeRecipient = pickFeeRecipient(Math.floor(Math.random() * FEE_RECIPIENTS.length));

    const accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: poolInfo.poolAddress, isSigner: false, isWritable: true },
      { pubkey: poolInfo.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolInfo.quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM, isSigner: false, isWritable: false },
    ];

    if (trackVolume || poolInfo.cashbackEnabled) {
      const userVolAcc = deriveAmmUserVolumeAccumulator(wallet.publicKey);
      const userVolWsolAta = await getAssociatedTokenAddress(poolInfo.quoteMint, userVolAcc, true);
      accounts.push({ pubkey: userVolWsolAta, isSigner: false, isWritable: true });
    }

    const poolV2 = derivePoolV2(poolInfo.baseMint);
    accounts.push({ pubkey: poolV2, isSigner: false, isWritable: false });

    const feeRecipientQuoteAta = await getAssociatedTokenAddress(poolInfo.quoteMint, feeRecipient, true);
    accounts.push(
      { pubkey: feeRecipient, isSigner: false, isWritable: false },
      { pubkey: feeRecipientQuoteAta, isSigner: false, isWritable: true },
    );

    const data = buildAmmBuyData(baseAmountOut, maxQuoteAmountIn, trackVolume);
    const buyIx = new TransactionInstruction({ programId: PUMP_SWAP_PROGRAM, keys: accounts, data });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
    for (const ata of ataIxs) tx.add(ata);
    tx.add(buyIx);
    tx.feePayer = wallet.publicKey;
    const blockhash = await blockhashCache.get(connection);
    tx.recentBlockhash = blockhash;

    const dynamicTipLamports = TipCalculator.calculateTip(score, false);
    const bundleId = await submitJitoBundle([tx], [wallet], dynamicTipLamports, connection);
    if (!bundleId) return { success: false, error: 'Failed to submit AMM buy bundle' };

    const status = await waitForBundleConfirmation(bundleId, 30, 500, connection);
    if (status === 'confirmed') {
      logger.info({ bundleId }, '✅ AMM Buy confirmed');
      return { success: true, bundleId };
    }
    return { success: false, error: `AMM buy status: ${status}` };

  } catch (err: any) {
    logger.error({ err: err.message }, 'AMM buy failed');
    return { success: false, error: err.message };
  }
}

export async function ammSell(
  connection: Connection,
  wallet: Keypair,
  poolInfo: AmmPoolInfo,
  baseAmountIn: bigint,
  slippagePercent: number = 10,
  trackVolume: boolean = false,
  isEmergency: boolean = false,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID, // Token-2022 or standard SPL
): Promise<{ success: boolean; bundleId?: string; solReceived?: number; error?: string }> {
  try {
    if (baseAmountIn <= 0n) {
      return { success: false, error: 'Token balance is 0 — nothing to sell' };
    }
    const denom = (poolInfo.baseReserves || 1073000189n) + baseAmountIn;
    const rawQuoteOut = denom > 0n ? (baseAmountIn * (poolInfo.quoteReserves || 30_000_000_000n) / denom) : 0n;
    const minQuoteOut = isEmergency ? 0n : (rawQuoteOut * BigInt(Math.max(0, 100 - slippagePercent)) / 100n);

    const userBaseTokenAccount = await getAssociatedTokenAddress(poolInfo.baseMint, wallet.publicKey, false, tokenProgramId);
    const userQuoteTokenAccount = await getAssociatedTokenAddress(poolInfo.quoteMint, wallet.publicKey, false, TOKEN_PROGRAM_ID); // WSOL is always SPL

    const globalConfig = deriveAmmGlobalConfig();
    const eventAuthority = deriveAmmEventAuthority();
    const feeRecipient = pickFeeRecipient(Math.floor(Math.random() * FEE_RECIPIENTS.length));

    const accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
      { pubkey: globalConfig, isSigner: false, isWritable: false },
      { pubkey: poolInfo.poolAddress, isSigner: false, isWritable: true },
      { pubkey: poolInfo.baseMint, isSigner: false, isWritable: false },
      { pubkey: poolInfo.quoteMint, isSigner: false, isWritable: false },
      { pubkey: userBaseTokenAccount, isSigner: false, isWritable: true },
      { pubkey: userQuoteTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: PUMP_SWAP_PROGRAM, isSigner: false, isWritable: false },
    ];

    if (trackVolume || poolInfo.cashbackEnabled) {
      const userVolAcc = deriveAmmUserVolumeAccumulator(wallet.publicKey);
      const userVolWsolAta = await getAssociatedTokenAddress(poolInfo.quoteMint, userVolAcc, true);
      accounts.push({ pubkey: userVolWsolAta, isSigner: false, isWritable: true });
    }

    const poolV2 = derivePoolV2(poolInfo.baseMint);
    accounts.push({ pubkey: poolV2, isSigner: false, isWritable: false });

    const feeRecipientQuoteAta = await getAssociatedTokenAddress(poolInfo.quoteMint, feeRecipient, true);
    accounts.push(
      { pubkey: feeRecipient, isSigner: false, isWritable: false },
      { pubkey: feeRecipientQuoteAta, isSigner: false, isWritable: true },
    );

    const data = buildAmmSellData(baseAmountIn, minQuoteOut, trackVolume);
    const sellIx = new TransactionInstruction({ programId: PUMP_SWAP_PROGRAM, keys: accounts, data });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }));
    tx.add(sellIx);
    // Un-wrap WSOL back to native SOL atomically
    tx.add(createCloseAccountInstruction(userQuoteTokenAccount, wallet.publicKey, wallet.publicKey, [], TOKEN_PROGRAM_ID));
    tx.feePayer = wallet.publicKey;
    const blockhash = await blockhashCache.get(connection);
    tx.recentBlockhash = blockhash;

    const dynamicTipLamports = TipCalculator.calculateTip(0, isEmergency);
    const bundleId = await submitJitoBundle([tx], [wallet], dynamicTipLamports, connection);
    if (!bundleId) return { success: false, error: 'Failed to submit AMM sell bundle' };

    const status = await waitForBundleConfirmation(bundleId, 30, 500, connection);
    if (status === 'confirmed') {
      logger.info({ bundleId }, '✅ AMM Sell confirmed');
      return { success: true, bundleId };
    }
    return { success: false, error: `AMM sell status: ${status}` };

  } catch (err: any) {
    logger.error({ err: err.message }, 'AMM sell failed');
    return { success: false, error: err.message };
  }
}

/**
 * Watch for new PumpSwap AMM pool creations in real-time via WebSocket
 */
export async function watchAmmPoolCreations(
  connection: Connection,
  onNewPool: (poolInfo: AmmPoolInfo) => void,
): Promise<number> {
  const POOL_DISCRIMINATOR = Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]);

  // Track seen pools to avoid processing the same pool on every swap event.
  // onProgramAccountChange fires on EVERY account mutation (each buy/sell),
  // not just creation — without this, the analysis queue gets flooded.
  const seenPools = new Set<string>();

  const subId = connection.onProgramAccountChange(
    PUMP_SWAP_PROGRAM,
    async (keyedAccountInfo) => {
      try {
        const data = keyedAccountInfo.accountInfo.data;
        if (data.length < 100) return;

        const discriminator = data.subarray(0, 8);
        if (!discriminator.equals(POOL_DISCRIMINATOR)) return;

        // ─── Deduplicate: only process each pool address once ───
        const poolKey = keyedAccountInfo.accountId.toBase58();
        if (seenPools.has(poolKey)) return;
        seenPools.add(poolKey);

        const view = new DataView(data.buffer);
        const poolIndex = view.getUint16(9, true);
        const creator = new PublicKey(data.subarray(11, 43));
        const baseMint = new PublicKey(data.subarray(43, 75));
        const quoteMint = new PublicKey(data.subarray(75, 107));
        const baseReserves = view.getBigUint64(107, true);
        const quoteReserves = view.getBigUint64(115, true);
        const cashback = isAmmPoolCashbackEnabled(data);

        const poolInfo: AmmPoolInfo = {
          poolAddress: new PublicKey(keyedAccountInfo.accountId),
          baseMint,
          quoteMint,
          creator,
          poolIndex,
          baseReserves,
          quoteReserves,
          cashbackEnabled: cashback,
          poolBump: view.getUint8(8),
        };

        // Skip wrapped SOL pairs and non-pump.fun tokens — not snipeable
        const baseMintStr = baseMint.toBase58();
        const WSOL = 'So11111111111111111111111111111111111111112';
        if (baseMintStr === WSOL || !/pump$/i.test(baseMintStr)) return;

        logger.info({
          pool: poolInfo.poolAddress.toBase58(),
          baseMint: baseMintStr,
          index: poolIndex,
        }, '🆕 New PumpSwap AMM pool created');

        onNewPool(poolInfo);
      } catch (err: any) {
        logger.error({ err: err.message }, 'Error processing new AMM pool');
      }
    },
    'confirmed'
  );

  logger.info(`Watching for new AMM pools (subscription: ${subId})`);
  return subId;
}

