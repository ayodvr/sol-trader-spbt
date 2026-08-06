import {
  Transaction,
  Keypair,
  SystemProgram,
  PublicKey,
  Connection,
} from '@solana/web3.js';
import { CONFIG } from '../config.js';
import pino from 'pino';

const logger = pino({ name: 'jito' });

/**
 * Helius Sender — ultra-low-latency transaction submission, free on all Helius plans
 * (0 API credits consumed, 50 TPS default). Dual-routes every transaction to both Jito
 * and staked validator connections server-side, so it gets Jito's inclusion benefits
 * without being subject to the public Jito block-engine's per-IP rate limit, which this
 * bot's trade volume was hitting constantly (near-permanent 429 cooldowns in practice).
 * https://www.helius.dev/docs/sending-transactions/sender
 */
const SENDER_ENDPOINT = 'https://sender.helius-rpc.com/fast';
const SENDER_MIN_TIP_LAMPORTS = 200_000; // 0.0002 SOL — Sender's documented minimum tip

/** Sender's tip accounts (from the Helius dashboard) — rotate randomly. */
const SENDER_TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

function getRandomSenderTipAccount(): PublicKey {
  const addr = SENDER_TIP_ACCOUNTS[Math.floor(Math.random() * SENDER_TIP_ACCOUNTS.length)];
  return new PublicKey(addr);
}

// Single shared connection to the Sender endpoint, reused across every submission.
const senderConnection = new Connection(SENDER_ENDPOINT, 'confirmed');

async function executeSubmitViaSender(
  transactions: Transaction[],
  signers: Keypair[],
  tipLamports: number,
  connection?: any,
): Promise<string | null> {
  try {
    // Sender (like the old Jito path) only ever receives a single transaction here — every
    // call site in this codebase builds exactly one Transaction per buy/sell, so there's no
    // atomic-bundle requirement to preserve.
    const baseTx = transactions[transactions.length - 1];

    // Sign the untipped version first and snapshot it — this is what gets broadcast on the
    // (rare) plain-RPC fallback path below, so a Sender outage never wastes tip lamports on
    // a transaction that was never actually routed through Sender.
    for (const tx of transactions) tx.sign(...signers);
    const untippedRawTx = baseTx.serialize();

    if (CONFIG.DRY_RUN) {
      logger.info({
        tip: `${(tipLamports / 1_000_000_000).toFixed(4)} SOL`,
      }, 'DRY_RUN: Simulating Sender submission');
      return `dry_run_bundle_${Date.now()}`;
    }

    const safeTipLamports = Math.max(SENDER_MIN_TIP_LAMPORTS, Math.floor(tipLamports || SENDER_MIN_TIP_LAMPORTS));
    const tipAccount = getRandomSenderTipAccount();
    const tipIx = SystemProgram.transfer({
      fromPubkey: signers[0].publicKey,
      toPubkey: tipAccount,
      lamports: safeTipLamports,
    });
    tipIx.keys.forEach(k => {
      if (k.pubkey.equals(tipAccount)) k.isWritable = true;
    });

    baseTx.add(tipIx);
    baseTx.sign(...signers); // re-sign — instructions changed since the untipped snapshot above
    const tippedRawTx = baseTx.serialize();

    try {
      const txid = await senderConnection.sendRawTransaction(tippedRawTx, {
        skipPreflight: true,
        maxRetries: 0,
      });
      logger.info({ txid, tip: `${(safeTipLamports / 1_000_000_000).toFixed(4)} SOL` }, '✅ Submitted via Helius Sender');
      return txid;
    } catch (senderErr: any) {
      logger.warn({ err: senderErr.message }, '⚠️ Helius Sender submission failed — falling back to plain RPC broadcast (untipped)');
    }

    // ─── Last-resort fallback: plain RPC broadcast, no tip (Sender never saw this attempt) ───
    if (connection) {
      try {
        const txid = await connection.sendRawTransaction(untippedRawTx, {
          skipPreflight: true,
          maxRetries: 3,
        });
        logger.info({ txid }, '✅ Broadcasted via plain RPC fallback');
        return txid;
      } catch (rpcErr: any) {
        logger.error({ err: rpcErr.message }, '❌ Plain RPC fallback also failed');
      }
    }

    logger.error('❌ Sender submission and RPC fallback both failed');
    return null;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Transaction submission error');
    return null;
  }
}

/**
 * Submit a buy/sell transaction via Helius Sender (dual-routes to Jito + staked validators),
 * falling back to a plain RPC broadcast only if Sender itself is unreachable.
 *
 * `isSell` is accepted for call-site compatibility but no longer changes routing — the old
 * separate buy/sell promise queues existed purely to protect the public Jito endpoint's rate
 * limit, which Sender isn't subject to at this bot's volume. Every call now fires immediately.
 */
export async function submitJitoBundle(
  transactions: Transaction[],
  signers: Keypair[],
  tipLamports: number = CONFIG.JITO_TIP_LAMPORTS,
  connection?: any,
  isSell: boolean = false
): Promise<string | null> {
  return executeSubmitViaSender(transactions, signers, tipLamports, connection);
}

/**
 * Poll for on-chain confirmation of a transaction signature.
 * Every submission path here (Helius Sender, plain RPC fallback) returns a real base58
 * transaction signature — never a Jito bundle UUID — so this only needs to poll RPC.
 */
export async function waitForBundleConfirmation(
  bundleId: string,
  maxRetries: number = 20,
  delayMs: number = 1000,
  connection?: any
): Promise<'confirmed' | 'failed' | 'pending'> {
  if (CONFIG.DRY_RUN && bundleId.startsWith('dry_run')) {
    logger.info({ bundleId }, 'DRY_RUN: Simulating bundle confirmation (success)');
    return 'confirmed';
  }

  if (!connection) return 'pending';

  for (let i = 0; i < maxRetries; i++) {
    try {
      const sigStatus = await connection.getSignatureStatus(bundleId);
      const confStatus = sigStatus.value?.confirmationStatus;
      if (confStatus === 'confirmed' || confStatus === 'finalized') {
        logger.info({ bundleId, confStatus }, '✅ Transaction confirmed on-chain');
        return 'confirmed';
      }
      if (sigStatus.value?.err) {
        logger.error({ bundleId, err: sigStatus.value.err }, '❌ Transaction failed on-chain');
        return 'failed';
      }
    } catch {
      // Transient RPC error — keep polling
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return 'pending';
}
