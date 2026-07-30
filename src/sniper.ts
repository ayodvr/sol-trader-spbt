import {
  Connection, PublicKey, Transaction, Keypair,
  SystemProgram, ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { CONFIG } from '../config.js';
import { submitJitoBundle, waitForBundleConfirmation } from './jito.js';
import { deriveBondingCurve, lamportsToSol } from './utils.js';
import { blockhashCache } from './blockhash-cache.js';
import { TipCalculator } from './tip-calculator.js';
import pino from 'pino';

const logger = pino({ name: 'sniper' });

/**
 * Discriminators for Pump.fun instructions (8 bytes each)
 * SHA256("global:<instruction_name>") first 8 bytes
 */
const DISCRIMINATORS = {
  BUY: [102, 6, 61, 18, 1, 218, 235, 234],   // "global:buy"
  SELL: [23, 183, 248, 55, 96, 216, 172, 96], // "global:sell"
};

/**
 * Pump.fun Buy instruction data layout (24 bytes):
 *   8 bytes: discriminator
 *   8 bytes: amount (u64 LE) — tokens to receive
 *   8 bytes: maxSolCost (u64 LE) — max SOL to spend
 */
function buildBuyInstructionData(amount: bigint, maxSolCost: bigint): Buffer {
  const buf = Buffer.alloc(24);
  for (let i = 0; i < 8; i++) buf.writeUInt8(DISCRIMINATORS.BUY[i], i);
  buf.writeBigUInt64LE(amount, 8);
  buf.writeBigUInt64LE(maxSolCost, 16);
  return buf;
}

function deriveFeeRecipient(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee-recipient')],
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

function buildBuyAccounts(
  mint: PublicKey,
  bondingCurve: PublicKey,
  user: PublicKey,
  userTokenAccount: PublicKey,
  associatedBondingCurve: PublicKey
) {
  return [
    { pubkey: CONFIG.GLOBAL_ACCOUNT, isSigner: false, isWritable: true },
    { pubkey: deriveFeeRecipient(), isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: userTokenAccount, isSigner: false, isWritable: true },
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
    { pubkey: deriveEventAuthority(), isSigner: false, isWritable: false },
    { pubkey: CONFIG.PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
}

export class PumpSniper {
  private connection: Connection;
  private wallet: Keypair;
  private MAX_RETRIES = 3;

  constructor(privateKey: Uint8Array) {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    this.wallet = Keypair.fromSecretKey(privateKey);
  }

  async snipe(
    mint: PublicKey,
    solAmountLamports: number,
    score: number = 45
  ): Promise<{ success: boolean; txHash?: string; tokenBalance?: bigint; error?: string }> {
    logger.info({ mint: mint.toBase58(), sol: solAmountLamports / 1_000_000_000 }, '🚀 Attempting snipe');

    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt++) {
      try {
        const bondingCurve = deriveBondingCurve(mint);
        const userTokenAccount = await getAssociatedTokenAddress(mint, this.wallet.publicKey);

        // Create ATA if needed
        const ataExists = await this.connection.getAccountInfo(userTokenAccount);
        const createAtaIx = ataExists
          ? null
          : createAssociatedTokenAccountInstruction(
              this.wallet.publicKey,
              userTokenAccount,
              this.wallet.publicKey,
              mint
            );

        // Get bonding curve state
        const curveAccount = await this.connection.getAccountInfo(bondingCurve);
        if (!curveAccount) {
          throw new Error('Bonding curve not found — pool may not exist yet');
        }

        const view = new DataView(curveAccount.data.buffer);
        const virtualTokenReserves = view.getBigUint64(64, true);
        const virtualSolReserves = view.getBigUint64(72, true);

        // Calculate estimated tokens with 1% fee
        const solAfterFee = BigInt(Math.floor(solAmountLamports * 0.99));
        const tokenAmount = solAfterFee * virtualTokenReserves / (virtualSolReserves + solAfterFee);
        const maxSolCost = BigInt(solAmountLamports);

        logger.debug({
          virtualTokenReserves: virtualTokenReserves.toString(),
          virtualSolReserves: virtualSolReserves.toString(),
          estimatedTokens: tokenAmount.toString(),
        }, 'Bonding curve state');

        // Associated bonding curve token account
        const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true);

        const buyData = buildBuyInstructionData(tokenAmount, maxSolCost);
        const buyAccounts = buildBuyAccounts(
          mint, bondingCurve, this.wallet.publicKey, userTokenAccount, associatedBondingCurve
        );

        const buyIx = {
          programId: CONFIG.PUMP_PROGRAM_ID,
          keys: buyAccounts,
          data: buyData,
        };

        // Build transaction
        const tx = new Transaction();
        tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));
        if (createAtaIx) tx.add(createAtaIx);
        tx.add(buyIx);
        tx.feePayer = this.wallet.publicKey;
        const blockhash = await blockhashCache.get(this.connection);
        tx.recentBlockhash = blockhash;

        // ─── Submit via Jito ───
        const tipLamports = TipCalculator.calculateTip(score, false);
        const bundleId = await submitJitoBundle(
          [tx],
          [this.wallet],
          tipLamports
        );if (!bundleId) throw new Error('Failed to get bundle ID from Jito');

        const status = await waitForBundleConfirmation(bundleId, 30, 500);

        if (status === 'confirmed') {
          let balance = 0n;
          try {
            const tokenBal = await this.connection.getTokenAccountBalance(userTokenAccount);
            balance = BigInt(tokenBal.value.amount);
          } catch {
            balance = tokenAmount;
          }

          logger.info({ mint: mint.toBase58(), bundleId, tokenBalance: balance.toString() }, '✅ Snipe confirmed');
          return { success: true, txHash: bundleId, tokenBalance: balance };
        }

        throw new Error(`Bundle status: ${status}`);

      } catch (err: any) {
        logger.error({ attempt, err: err.message, mint: mint.toBase58() }, 'Snipe attempt failed');
        if (attempt < this.MAX_RETRIES - 1) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }

    return { success: false, error: 'All snipe attempts exhausted' };
  }
}
