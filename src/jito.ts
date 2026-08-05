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

function getJitoEndpoint(): string {
  if (CONFIG.JITO_BLOCK_ENGINE && CONFIG.JITO_BLOCK_ENGINE !== 'https://mainnet.block-engine.jito.wtf') {
    return CONFIG.JITO_BLOCK_ENGINE;
  }
  const ep = JITO_ENDPOINTS[endpointIndex % JITO_ENDPOINTS.length];
  endpointIndex++;
  return ep;
}

let jitoQueueChain: Promise<any> = Promise.resolve();

async function executeSubmitJitoBundle(
  transactions: Transaction[],
  signers: Keypair[],
  tipLamports: number
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
    transactions[transactions.length - 1].add(tipIx);

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

    // ─── Rate Limit Guard: Jito public API allows max 1 bundle request per second ───
    const now = Date.now();
    const timeSinceLast = now - lastJitoSubmitTime;
    if (timeSinceLast < 1100) {
      const waitMs = 1100 - timeSinceLast;
      await new Promise(r => setTimeout(r, waitMs));
    }
    lastJitoSubmitTime = Date.now();

    const targetEndpoint = getJitoEndpoint();

    logger.info({
      bundleSize: serializedTxs.length,
      tip: `${(tipLamports / 1_000_000_000).toFixed(4)} SOL`,
      endpoint: targetEndpoint,
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
        timeout: 15_000,
      }
    );

    const bundleId = response.data?.result;
    if (bundleId) {
      logger.info({ bundleId }, '✅ Bundle submitted');
      return bundleId;
    }

    logger.error({ response: response.data }, '❌ Bundle submission failed');
    return null;
  } catch (err: any) {
    logger.error({ err: err.message, response: err.response?.data }, 'Jito bundle error');
    return null;
  }
}

/**
 * Submit a bundle of transactions to Jito's block engine.
 * All transactions execute atomically and in order.
 * Uses a serial promise queue to strictly enforce 1.1s spacing between requests.
 */
export async function submitJitoBundle(
  transactions: Transaction[],
  signers: Keypair[],
  tipLamports: number = CONFIG.JITO_TIP_LAMPORTS
): Promise<string | null> {
  const task = jitoQueueChain.then(() => executeSubmitJitoBundle(transactions, signers, tipLamports));
  jitoQueueChain = task.catch(() => {});
  return task;
}

/**
 * Poll for bundle confirmation status
 */
export async function waitForBundleConfirmation(
  bundleId: string,
  maxRetries: number = 20,
  delayMs: number = 1000
): Promise<'confirmed' | 'failed' | 'pending'> {
  if (CONFIG.DRY_RUN && bundleId.startsWith('dry_run')) {
    logger.info({ bundleId }, 'DRY_RUN: Simulating bundle confirmation (success)');
    return 'confirmed';
  }

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.post(
        `${CONFIG.JITO_BLOCK_ENGINE}/api/v1/bundles`,
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'getBundleStatuses',
          params: [[bundleId]],
        },
        { timeout: 5_000 }
      );

      const val = response.data?.result?.value?.[0];
      const statusStr = (val?.status || '').toLowerCase();
      const confStatus = (val?.confirmation_status || '').toLowerCase();

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
    } catch {
      // Transient — keep polling
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return 'pending';
}
