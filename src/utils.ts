import { PublicKey } from '@solana/web3.js';
import { CONFIG } from '../config.js';
import bs58 from 'bs58';

/**
 * Derive the bonding curve PDA for a given mint address.
 * PDA seeds: ["bonding-curve", mint]
 */
export function deriveBondingCurve(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), mint.toBytes()],
    CONFIG.PUMP_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the associated bonding curve token account (ATA of bondingCurve owning the mint).
 */
export function deriveAssociatedBondingCurve(mint: PublicKey, bondingCurve: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [
      bondingCurve.toBytes(),
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes(),
      mint.toBytes(),
    ],
    new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xr25ix9aJ6VSCWNABq')
  );
  return ata;
}

/**
 * Decode a base58 private key into a Uint8Array
 */
export function decodePrivateKey(base58Key: string): Uint8Array {
  return bs58.decode(base58Key);
}

/**
 * Sleep for ms
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Format lamports to SOL
 */
export function lamportsToSol(lamports: number | bigint): number {
  return Number(lamports) / 1_000_000_000;
}
