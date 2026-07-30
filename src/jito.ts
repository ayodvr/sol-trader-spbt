import {
  Transaction,
  Keypair,
  SystemProgram,
  PublicKey,
} from '@solana/web3.js';
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

/**
 * Submit a bundle of transactions to Jito's block engine.
 * All transactions execute atomically and in order.
 * A tip instruction is appended to the last transaction.
 */
export async function submitJitoBundle(
  transactions: Transaction[],
  signers: Keypair[],
  tipLamports: number = CONFIG.JITO_TIP_LAMPORTS
): Promise<string | null> {
  try {
    // Add tip instruction to the last transaction
    const tipIx = SystemProgram.transfer({
      fromPubkey: signers[0].publicKey,
      toPubkey: getRandomTipAccount(),
      lamports: tipLamports,
    });
    transactions[transactions.length - 1].add(tipIx);

    // Serialize all transactions to base64
    const serializedTxs = transactions.map((tx) => {
      tx.sign(...signers);
      return Buffer.from(tx.serialize()).toString('base64');
    });

    if (CONFIG.DRY_RUN) {
      logger.info({
        bundleSize: serializedTxs.length,
        tip: `${(tipLamports / 1_000_000_000).toFixed(4)} SOL`,
      }, 'DRY_RUN: Simulating Jito bundle submission');
      return `dry_run_bundle_${Date.now()}`;
    }

    logger.info({
      bundleSize: serializedTxs.length,
      tip: `${(tipLamports / 1_000_000_000).toFixed(4)} SOL`,
    }, 'Submitting Jito bundle');

    const response = await axios.post(
      `${CONFIG.JITO_BLOCK_ENGINE}/api/v1/bundles`,
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
    logger.error({ err: err.message }, 'Jito bundle error');
    return null;
  }
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

      const status = response.data?.result?.value?.[0]?.status;
      if (status === 'confirmed' || status === 'finalized') return 'confirmed';
      if (status === 'failed') return 'failed';
    } catch {
      // Transient — keep polling
    }
    await new Promise(r => setTimeout(r, delayMs));
  }
  return 'pending';
}
