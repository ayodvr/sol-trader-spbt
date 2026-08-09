import {
  Connection, PublicKey, Transaction, Keypair, ComputeBudgetProgram, TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { CONFIG } from '../config.js';
import { submitJitoBundle, waitForBundleConfirmation } from './jito.js';
import { deriveBondingCurve } from './utils.js';
import { blockhashCache } from './blockhash-cache.js';
import { TipCalculator } from './tip-calculator.js';
import pino from 'pino';

const logger = pino({ name: 'sell' });

// Sell discriminator: SHA256("global:sell") first 8 bytes
const SELL_DISCRIMINATOR: number[] = [0x17, 0xb7, 0xf8, 0x37, 0x60, 0xd8, 0xac, 0x60];

function deriveBondingCurveV2(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve-v2'), mint.toBytes()],
    CONFIG.PUMP_PROGRAM_ID
  );
  return pda;
}

function deriveUserVolumeAccumulator(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('user_volume_accumulator'), user.toBytes()],
    CONFIG.PUMP_PROGRAM_ID
  );
  return pda;
}

function deriveCreatorVault(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('creator-vault'), mint.toBytes()],
    CONFIG.PUMP_PROGRAM_ID
  );
  return pda;
}

function deriveEventAuthority(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    CONFIG.PUMP_PROGRAM_ID
  );
  return pda;
}

function deriveFeeRecipient(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee-recipient')],
    CONFIG.PUMP_PROGRAM_ID
  );
  return pda;
}

function buildSellInstructionData(amount: bigint, minSolOutput: bigint): Buffer {
  const buf = Buffer.alloc(24);
  for (let i = 0; i < 8; i++) buf.writeUInt8(SELL_DISCRIMINATOR[i], i);
  buf.writeBigUInt64LE(amount, 8);
  buf.writeBigUInt64LE(minSolOutput, 16);
  return buf;
}

export function isCashbackEnabled(bondingCurveData: Buffer): boolean {
  if (bondingCurveData.length <= 82) return false;
  return bondingCurveData[82] !== 0;
}

function readCreator(bondingCurveData: Buffer): PublicKey {
  return new PublicKey(bondingCurveData.subarray(32, 64));
}

/**
 * Sell token holding back to SOL via Pump.fun bonding curve.
 * Submits as a Jito bundle for priority execution.
 */
export async function sell(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  tokenAmount: bigint,
  minSolOutput: bigint = 0n,
  isEmergency: boolean = false,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<{ success: boolean; txHash?: string; solReceived?: number; error?: string }> {
  logger.info({ mint: mint.toBase58(), tokens: Number(tokenAmount) }, '📉 Attempting sell');
  try {
    const bondingCurve = deriveBondingCurve(mint);
    const bondingCurveV2 = deriveBondingCurveV2(mint);
    const userTokenAccount = await getAssociatedTokenAddress(mint, wallet.publicKey, false, tokenProgramId);
    const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true, tokenProgramId);

    const curveAccount = await connection.getAccountInfo(bondingCurve);
    if (!curveAccount) {
      return { success: false, error: 'Bonding curve account not found' };
    }

    const curveData = curveAccount.data;
    const cashback = isCashbackEnabled(curveData);

    const view = new DataView(curveData.buffer, curveData.byteOffset, curveData.byteLength);
    const virtualTokenReserves = view.getBigUint64(64, true);
    const virtualSolReserves = view.getBigUint64(72, true);

    if (virtualTokenReserves === 0n) {
      return { success: false, error: 'Zero virtual token reserves — cannot sell' };
    }

    const rawSolOut = tokenAmount * virtualSolReserves / (virtualTokenReserves + tokenAmount);
    const solAfterFee = rawSolOut * 99n / 100n;
    // If minSolOutput was provided as 0, we calculate a default
    const effectiveMinSol = minSolOutput > 0n ? minSolOutput : solAfterFee * 90n / 100n;

    logger.debug({
      tokenSelling: tokenAmount.toString(),
      expectedSol: solAfterFee.toString(),
      minSol: effectiveMinSol.toString(),
      cashback,
    }, 'Sell calculation');

    const sellData = buildSellInstructionData(tokenAmount, effectiveMinSol);

    const feeRecipient = deriveFeeRecipient();
    const creatorVault = deriveCreatorVault(mint);
    const eventAuthority = deriveEventAuthority();
    const feeConfig = new PublicKey('ETq2m4g4DNTpqqoxGqVFXFu3AqTfoPgXxzhn7qSbCjH8');
    const feeProgram = new PublicKey('tFEFkijPwQCjMvKDqf4CT1L2fx5iPAYHNct3HStafat');

    const accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }> = [
      { pubkey: CONFIG.GLOBAL_ACCOUNT, isSigner: false, isWritable: false },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: creatorVault, isSigner: false, isWritable: true },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: CONFIG.PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: feeConfig, isSigner: false, isWritable: false },
      { pubkey: feeProgram, isSigner: false, isWritable: false },
    ];

    // Cashback: append user_volume_accumulator
    if (cashback) {
      const userVolumeAccumulator = deriveUserVolumeAccumulator(wallet.publicKey);
      accounts.push({ pubkey: userVolumeAccumulator, isSigner: false, isWritable: true });
    }

    // bonding_curve_v2 is ALWAYS the last account
    accounts.push({ pubkey: bondingCurveV2, isSigner: false, isWritable: false });

    const sellIx = new TransactionInstruction({
      programId: CONFIG.PUMP_PROGRAM_ID,
      keys: accounts,
      data: sellData,
    });

    const tx = new Transaction();
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 150_000 }));
    tx.add(sellIx);
    tx.feePayer = wallet.publicKey;
    const blockhash = await blockhashCache.get(connection);
    tx.recentBlockhash = blockhash;

    // ─── Submit via Jito sell queue (separate from buy queue — Fix 4) ───
    const tipLamports = TipCalculator.calculateTip(0, isEmergency);
    const bundleId = await submitJitoBundle([tx], [wallet], tipLamports, connection, true);
    if (!bundleId) throw new Error('Failed to get bundle ID from Jito');

    const status = await waitForBundleConfirmation(bundleId, 30, 500, connection);

    if (status === 'confirmed') {
      logger.info({ bundleId, mint: mint.toBase58() }, '✅ Sell confirmed');
      return { success: true, txHash: bundleId };
    }

    return { success: false, error: `Bundle status: ${status}` };

  } catch (err: any) {
    logger.error({ err: err.message, mint: mint.toBase58() }, 'Sell execution failed');
    return { success: false, error: err.message };
  }
}
