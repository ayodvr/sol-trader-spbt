import {
  Transaction,
  Keypair,
  SystemProgram,
  PublicKey,
} from '@solana/web3.js';
import bs58 from 'bs58';
import axios from 'axios';
import { CONFIG } from '../config.js';
import pino from 'pino';

const logger = pino({ name: 'jito' });

/**
 * Official Jito tip accounts (rotate randomly)
 * Fetch latest from: https://mainnet.block-engine.jito.wtf/api/v1/bundles
 */
const JITO_TIP_ACCOUNTS = [
  'Cw8Fcxv2JxYbBpcC6y9C3T5KkCuKjN3TzGxSqbHYKoAv',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
  'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyfgGtiT8Qqk',
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
  'ADaUMVH5N9gMiPhTYDFiM88TBinsLPksi7AMpHJntKoB',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
];

function getRandomTipAccount(): PublicKey {
  const addr = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
  return new PublicKey(addr);
}

const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.wtf',
  'https://amsterdam.mainnet.block-engine.jito.wtf',
  'https://frankfurt.mainnet.block-engine.jito.wtf',
  'https://ny.mainnet.block-engine.jito.wtf',
  'https://tokyo.mainnet.block-engine.jito.wtf',
];

let lastJitoSubmitTime = 0;
let endpointIndex = 0;
let jitoThrottledUntil = 0; // Timestamp until which Jito calls are paused due to 429 rate limit

function getJitoEndpoint(): string {
  if (CONFIG.JITO_BLOCK_ENGINE && CONFIG.JITO_BLOCK_ENGINE !== 'https://mainnet.block-engine.jito.wtf') {
    return CONFIG.JITO_BLOCK_ENGINE;
  }
  const ep = JITO_ENDPOINTS[endpointIndex % JITO_ENDPOINTS.length];
  endpointIndex++;
  return ep;
}

let jitoQueueChain: Promise<any> = Promise.resolve();
let jitoSellQueueChain: Promise<any> = Promise.resolve(); // ✅ Fix 4: Separate queue so sell exits never block behind buy cooldowns

async function executeSubmitJitoBundle(
  transactions: Transaction[],
  signers: Keypair[],
  tipLamports: number,
  connection?: any
): Promise<string | null> {
  try {
    // Add tip instruction to the last transaction
    const safeTipLamports = Math.max(100_000, Math.floor(tipLamports || 100_000));
    const tipAccount = getRandomTipAccount();
    const tipIx = SystemProgram.transfer({
      fromPubkey: signers[0].publicKey,
      toPubkey: tipAccount,
      lamports: safeTipLamports,
    });
    // Explicitly guarantee write-lock flag for Jito auction engine
    tipIx.keys.forEach(k => {
      if (k.pubkey.equals(tipAccount)) {
        k.isWritable = true;
      }
    });

    const targetTx = transactions[transactions.length - 1];
    targetTx.add(tipIx);

    // Serialize all transactions to base58 (required by Jito JSON-RPC API)
    const serializedTxs = transactions.map((tx) => {
      tx.sign(...signers);
      return bs58.encode(tx.serialize());
    });

    if (CONFIG.DRY_RUN) {
      logger.info({
        bundleSize: serializedTxs.length,
        tip: `${(tipLamports / 1_000_000_000).toFixed(4)} SOL`,
      }, 'DRY_RUN: Simulating Jito bundle submission');
      return `dry_run_bundle_${Date.now()}`;
    }

    // ─── Rate Limit Circuit Breaker Check ───
    const now = Date.now();
    if (now < jitoThrottledUntil) {
      const remainingSec = Math.ceil((jitoThrottledUntil - now) / 1000);
      logger.warn({ remainingSec }, '⚡ Jito in rate-limit cooldown — skipping bundle, routing directly to RPC broadcast');
    } else {
      // Try regional endpoints if not throttled
      for (let attempt = 0; attempt < 3; attempt++) {
        // Enforce min 1.2s spacing between Jito API calls from this client
        const currentNow = Date.now();
        const timeSinceLast = currentNow - lastJitoSubmitTime;
        if (timeSinceLast < 1200) {
          const waitMs = 1200 - timeSinceLast;
          await new Promise(r => setTimeout(r, waitMs));
        }
        lastJitoSubmitTime = Date.now();

        const targetEndpoint = getJitoEndpoint();

        try {
          logger.info({
            bundleSize: serializedTxs.length,
            tip: `${(tipLamports / 1_000_000_000).toFixed(4)} SOL`,
            endpoint: targetEndpoint,
            attempt: attempt + 1,
          }, 'Submitting Jito bundle');

          const response = await axios.post(
            `${targetEndpoint}/api/v1/bundles`,
            {
              jsonrpc: '2.0',
              id: 1,
              method: 'sendBundle',
              params: [serializedTxs],
            },
            {
              headers: { 'Content-Type': 'application/json' },
              timeout: 10_000,
            }
          );

          const bundleId = response.data?.result;
          if (bundleId) {
            logger.info({ bundleId, endpoint: targetEndpoint }, '✅ Bundle submitted');
            return bundleId;
          }

          // Check if response contains rate limit error structure
          const errCode = response.data?.error?.code;
          if (errCode === -32097 || response.status === 429) {
            jitoThrottledUntil = Date.now() + 60_000;
            logger.warn({ endpoint: targetEndpoint, cooldownSec: 60 }, '⚡ Jito 429 Rate limit detected — activating 60s cooldown and falling back to RPC');
            break; // Stop attempting other Jito endpoints (rate limit is per IP)
          }

          logger.warn({ response: response.data, endpoint: targetEndpoint }, 'Jito endpoint returned non-bundle result — retrying next region');
        } catch (err: any) {
          const statusCode = err.response?.status;
          const is429 = statusCode === 429 || err.response?.data?.error?.code === -32097;
          if (is429) {
            jitoThrottledUntil = Date.now() + 60_000;
            logger.warn({ endpoint: targetEndpoint, cooldownSec: 60 }, '⚡ Jito 429 Rate limit detected — activating 60s cooldown and falling back to RPC');
            break; // Stop attempting other Jito endpoints
          }
          logger.warn({ err: err.message, response: err.response?.data, endpoint: targetEndpoint }, 'Jito endpoint error — retrying next region');
        }
      }
    }

    // ─── Direct RPC Fallback ───
    if (connection) {
      try {
        logger.info('⚡ Executing direct RPC transaction broadcast fallback');
        const tx = transactions[0];
        const rawTx = tx.serialize();
        const txid = await connection.sendRawTransaction(rawTx, {
          skipPreflight: true,
          maxRetries: 3,
        });
        logger.info({ txid }, '✅ Buy transaction broadcasted directly via RPC fallback');
        return txid;
      } catch (rpcErr: any) {
        logger.error({ err: rpcErr.message }, '❌ Direct RPC fallback submission failed');
      }
    }

    logger.error('❌ All Jito regional bundle submission attempts failed');
    return null;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Jito bundle serialization error');
    return null;
  }
}

/**
 * Submit a bundle of transactions to Jito's block engine.
 * All transactions execute atomically and in order.
 * Uses a serial promise queue to strictly enforce 1.1s spacing between requests.
 * Sell transactions use a SEPARATE queue so they are never blocked behind buy cooldowns.
 */
export async function submitJitoBundle(
  transactions: Transaction[],
  signers: Keypair[],
  tipLamports: number = CONFIG.JITO_TIP_LAMPORTS,
  connection?: any,
  isSell: boolean = false // ✅ Fix 4: route sells through separate queue
): Promise<string | null> {
  if (isSell) {
    const task = jitoSellQueueChain.then(() => executeSubmitJitoBundle(transactions, signers, tipLamports, connection));
    jitoSellQueueChain = task.catch(() => { });
    return task;
  }
  const task = jitoQueueChain.then(() => executeSubmitJitoBundle(transactions, signers, tipLamports, connection));
  jitoQueueChain = task.catch(() => { });
  return task;
}

/**
 * Poll for bundle/transaction confirmation status across both Solana RPC and Jito block engines.
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

  // A real Jito bundle ID is a UUID (contains dashes); connection.getSignatureStatus() only
  // makes sense for an actual base58 transaction signature, which is what the direct-RPC
  // fallback path in executeSubmitJitoBundle returns instead. Skip the doomed lookup otherwise
  // rather than burning an RPC call every poll tick for a value that can never match.
  const looksLikeTxSignature = !bundleId.includes('-');

  for (let i = 0; i < maxRetries; i++) {
    // 1. Primary check: Check Solana RPC signature status if connection is provided
    if (connection && looksLikeTxSignature) {
      try {
        const sigStatus = await connection.getSignatureStatus(bundleId);
        const confStatus = sigStatus.value?.confirmationStatus;
        if (confStatus === 'confirmed' || confStatus === 'finalized') {
          logger.info({ bundleId, confStatus }, '✅ Transaction confirmed on-chain via RPC');
          return 'confirmed';
        }
        if (sigStatus.value?.err) {
          logger.error({ bundleId, err: sigStatus.value.err }, '❌ Transaction failed on-chain');
          return 'failed';
        }
      } catch {
        // Transient RPC error — proceed to Jito check if enabled
      }
    }

    // 2. Secondary check: Query SINGLE Jito endpoint only if not throttled
    if (Date.now() >= jitoThrottledUntil) {
      try {
        const primaryEndpoint = JITO_ENDPOINTS[0];
        const response = await axios.post(
          `${primaryEndpoint}/api/v1/bundles`,
          {
            jsonrpc: '2.0',
            id: 1,
            method: 'getBundleStatuses',
            params: [[bundleId]],
          },
          { timeout: 3_000 }
        );

        const val = response.data?.result?.value?.[0];
        if (val) {
          const statusStr = (val.status || '').toLowerCase();
          const confStatus = (val.confirmation_status || '').toLowerCase();

          if (
            statusStr === 'landed' ||
            statusStr === 'confirmed' ||
            statusStr === 'finalized' ||
            confStatus === 'confirmed' ||
            confStatus === 'finalized'
          ) {
            return 'confirmed';
          }
          if (statusStr === 'failed') return 'failed';
        }
      } catch (err: any) {
        if (err.response?.status === 429 || err.response?.data?.error?.code === -32097) {
          jitoThrottledUntil = Date.now() + 60_000;
          logger.warn('⚡ Jito rate-limited during status check — pausing Jito status queries for 60s');
        }
      }
    }

    await new Promise(r => setTimeout(r, delayMs));
  }
  return 'pending';
}
