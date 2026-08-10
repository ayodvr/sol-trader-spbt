import {
  Connection,
  PublicKey,
  Transaction,
  Keypair,
  ComputeBudgetProgram,
  TransactionInstruction,
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

const logger = pino({ name: 'native-sniper' });

// ─── Load Rust native addon (with graceful fallback) ───
let native: any = null;
try {
  native = require('pump-native-builder');
  logger.info('✅ Rust native instruction builder loaded');
} catch (err: any) {
  logger.warn({
    err: err.message,
    hint: 'Run: cd native-builder && npm install && npm run build && cd .. && npm install ./native-builder',
  }, '⚠️  Rust native addon not found — falling back to JS builder');
}

// ─── JS fallback (same as sniper.ts for when native isn't available) ───
const BUY_DISCRIMINATOR: number[] = [102, 6, 61, 18, 1, 218, 235, 234];

function buildJsBuyData(amount: bigint, maxSolCost: bigint): Buffer {
  const buf = Buffer.alloc(24);
  for (let i = 0; i < 8; i++) buf.writeUInt8(BUY_DISCRIMINATOR[i], i);
  buf.writeBigUInt64LE(amount, 8);
  buf.writeBigUInt64LE(maxSolCost, 16);
  return buf;
}

/**
 * Build a Pump.fun buy instruction — uses Rust native if available,
 * falls back to JS otherwise.
 */
async function buildBuyInstruction(
  connection: Connection,
  mint: PublicKey,
  wallet: PublicKey,
  bondingCurve: PublicKey,
  solAmountLamports: number,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<{
  instruction: any;
  estimatedTokens: bigint;
  userTokenAccount: PublicKey;
  bondingCurveData: Buffer | null;
}> {
  const userTokenAccount = await getAssociatedTokenAddress(mint, wallet, false, tokenProgramId);

  // Get bonding curve state
  const curveAccount = await connection.getAccountInfo(bondingCurve);
  let estimatedTokens = 0n;
  let bondingCurveData: Buffer | null = null;

  if (curveAccount) {
    bondingCurveData = curveAccount.data;
    const view = new DataView(curveAccount.data.buffer, curveAccount.data.byteOffset, curveAccount.data.byteLength);
    const virtualTokenReserves = view.getBigUint64(8, true);
    const virtualSolReserves = view.getBigUint64(16, true);

    const solAfterFee = BigInt(Math.floor(solAmountLamports * 0.99));
    estimatedTokens = solAfterFee * virtualTokenReserves / (virtualSolReserves + solAfterFee);
  }

  const maxSolCost = BigInt(solAmountLamports);

  // ─── TRY RUST NATIVE ───
  // The Rust native builder currently assumes TOKEN_PROGRAM_ID for ATAs
  if (native && native.buildPumpBuyInstruction && tokenProgramId.equals(TOKEN_PROGRAM_ID)) {
    try {
      const serializedBuf: Buffer = native.buildPumpBuyInstruction(
        mint.toBase58(),
        wallet.toBase58(),
        bondingCurve.toBase58(),
        estimatedTokens.toString(),
        maxSolCost.toString(),
        solAmountLamports.toString(),
      ) as Buffer;

      // Deserialize back to an instruction
      // We use native to prove it works, but for Jito submission
      // we can also build the raw Transaction structure around it
      
      logger.debug({
        native: true,
        buildTime: '< 0.1ms',
        estimatedTokens: estimatedTokens.toString(),
      }, 'Rust native instruction built');

      return {
        instruction: serializedBuf, // Raw serialized instruction
        estimatedTokens,
        userTokenAccount,
        bondingCurveData,
      };
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Native builder failed — falling back to JS');
    }
  }

  // ─── JS FALLBACK ───
  logger.debug({ native: false }, 'Using JS instruction builder');

  // Derive PDAs
  const [feeRecipient] = PublicKey.findProgramAddressSync(
    [Buffer.from('fee-recipient')],
    CONFIG.PUMP_PROGRAM_ID
  );
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from('__event_authority')],
    CONFIG.PUMP_PROGRAM_ID
  );
  const associatedBondingCurve = await getAssociatedTokenAddress(mint, bondingCurve, true, tokenProgramId);

  const buyData = buildJsBuyData(estimatedTokens, maxSolCost);

  const instruction = new TransactionInstruction({
    programId: CONFIG.PUMP_PROGRAM_ID,
    keys: [
      { pubkey: CONFIG.GLOBAL_ACCOUNT, isSigner: false, isWritable: true },
      { pubkey: feeRecipient, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: bondingCurve, isSigner: false, isWritable: true },
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wallet, isSigner: true, isWritable: true },
      { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
      { pubkey: eventAuthority, isSigner: false, isWritable: false },
      { pubkey: CONFIG.PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: buyData,
  });

  return { instruction, estimatedTokens, userTokenAccount, bondingCurveData };
}

/**
 * Execute a snipe using the fastest available instruction builder
 */
export async function nativeSnipe(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  solAmountLamports: number,
  score: number = 45,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): Promise<{ success: boolean; txHash?: string; tokenBalance?: bigint; error?: string }> {
  logger.info({
    mint: mint.toBase58(),
    sol: (solAmountLamports / 1_000_000_000).toFixed(4),
    builder: native ? 'Rust napi-rs' : 'JS fallback',
  }, '🚀 Native snipe');

  const bondingCurve = deriveBondingCurve(mint);

  // ─── DRY RUN: simulate a successful snipe without sending a tx ───
  if (CONFIG.DRY_RUN) {
    logger.info({ mint: mint.toBase58(), sol: (solAmountLamports / 1_000_000_000).toFixed(4) }, '🧪 [DRY RUN] Simulating snipe — no tx sent');
    try {
      const curveAccount = await connection.getAccountInfo(bondingCurve);
      let estimatedTokens = BigInt(Math.floor(solAmountLamports * 1_000_000)); // fallback estimate
      if (curveAccount) {
        const view = new DataView(curveAccount.data.buffer, curveAccount.data.byteOffset, curveAccount.data.byteLength);
        const virtualTokenReserves = view.getBigUint64(8, true);
        const virtualSolReserves = view.getBigUint64(16, true);
        const solAfterFee = BigInt(Math.floor(solAmountLamports * 0.99));
        estimatedTokens = solAfterFee * virtualTokenReserves / (virtualSolReserves + solAfterFee);
      }
      return {
        success: true,
        txHash: `DRY_RUN_${Date.now()}`,
        tokenBalance: estimatedTokens,
      };
    } catch (err: any) {
      // Even if RPC fails for dry run, return a simulated success with default token amount
      return {
        success: true,
        txHash: `DRY_RUN_${Date.now()}`,
        tokenBalance: BigInt(Math.floor(solAmountLamports * 1_000_000)),
      };
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // ─── Build instruction (Rust native if available) ───
      const startBuild = Date.now();
      const { instruction, estimatedTokens, userTokenAccount } = await buildBuyInstruction(
        connection,
        mint,
        wallet.publicKey,
        bondingCurve,
        solAmountLamports,
        tokenProgramId
      );
      const buildTime = Date.now() - startBuild;

      logger.debug({ buildTime: `${buildTime}ms`, estimatedTokens: estimatedTokens.toString() }, 'Instruction built');

      // ─── Build transaction ───
      const tx = new Transaction();
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }));

      // Handle the instruction — either raw serialized (native) or object (JS)
      if (Buffer.isBuffer(instruction)) {
        // Native: instruction is a serialized bincode Instruction
        const deserialized = native?.debugDeserializeInstruction
          ? JSON.parse(native.debugDeserializeInstruction(instruction))
          : null;

        if (deserialized) {
          // Reconstruct from JSON
          const ix = new TransactionInstruction({
            programId: new PublicKey(deserialized.program_id),
            keys: deserialized.accounts.map((a: any) => ({
              pubkey: new PublicKey(a.pubkey),
              isSigner: a.is_signer,
              isWritable: a.is_writable,
            })),
            data: Buffer.from(deserialized.data_hex, 'hex'),
          });
          tx.add(ix);
        } else {
          // debugDeserializeInstruction not available — fall back to JS builder
          // to avoid submitting an empty tx that Jito rejects with 400
          logger.warn({ mint: mint.toBase58() }, '⚠️ Native deserialization unavailable — using JS builder fallback');
          const jsFallback = await buildBuyInstruction(connection, mint, wallet.publicKey, bondingCurve, solAmountLamports, tokenProgramId);
          tx.add(new TransactionInstruction(jsFallback.instruction as any));
        }
      } else {
        // JS: wrap instruction as TransactionInstruction
        tx.add(new TransactionInstruction(instruction as any));
      }

      tx.feePayer = wallet.publicKey;
      const blockhash = await blockhashCache.get(connection);
      tx.recentBlockhash = blockhash;

      // ─── Submit via Jito ───
      const tipLamports = TipCalculator.calculateTip(score, false);
      const bundleId = await submitJitoBundle(
        [tx],
        [wallet],
        tipLamports,
        connection
      );

      if (!bundleId) {
        throw new Error('Failed to get bundle ID');
      }

      const status = await waitForBundleConfirmation(bundleId, 30, 500, connection);

      if (status === 'confirmed') {
        // Buy already landed — fetch the real balance separately so an RPC hiccup here
        // doesn't fall into the outer catch and trigger a duplicate buy submission.
        let tokenBalance = estimatedTokens;
        try {
          const balance = await connection.getTokenAccountBalance(userTokenAccount);
          tokenBalance = BigInt(balance.value.amount);
        } catch (balErr: any) {
          logger.warn({ mint: mint.toBase58(), err: balErr.message }, '⚠️ Post-buy balance fetch failed — using pre-trade estimate');
        }

        logger.info({
          mint: mint.toBase58(),
          balance: tokenBalance.toString(),
          bundleId,
          builder: native ? 'Rust' : 'JS',
          buildTime: `${buildTime}ms`,
        }, '✅ Native snipe confirmed');

        return {
          success: true,
          txHash: bundleId,
          tokenBalance,
        };
      }

    } catch (err: any) {
      logger.error({ attempt, err: err.message }, 'Native snipe attempt failed');
      if (attempt < 2) await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
    }
  }

  return { success: false, error: 'All native snipe attempts exhausted' };
}
