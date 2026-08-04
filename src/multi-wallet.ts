import { Keypair, PublicKey, Connection, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { decodePrivateKey } from './utils.js';
import { CONFIG } from '../config.js';

const logger = pino({ name: 'wallet-manager' });

export interface ManagedWallet {
  keypair: Keypair;
  address: string;
  balance: number;
  inUse: boolean;
  lastUsed: number;
  totalSnipes: number;
}

/**
 * Multi-wallet manager for round-robin rotation.
 * Bypasses Jito per-wallet rate limits (~1 bundle/2 blocks).
 * Distributes MEV impact and prevents all funds being frozen at once.
 */
export class WalletManager {
  private wallets: ManagedWallet[] = [];
  private currentIndex: number = 0;
  private connection: Connection;
  private minWalletBalance: number;
  public masterBalance: number = 0;

  constructor(walletPath: string, minBalanceSol: number = 0.5) {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    this.minWalletBalance = minBalanceSol;
    this.loadWallets(walletPath);
  }

  private loadWallets(walletPath: string): void {
    const resolvedPath = path.resolve(walletPath);

    if (!fs.existsSync(resolvedPath)) {
      logger.warn(`Wallet file not found at ${resolvedPath}, using single wallet from .env`);
      const keypair = Keypair.fromSecretKey(decodePrivateKey(CONFIG.PRIVATE_KEY));
      this.wallets.push({
        keypair,
        address: keypair.publicKey.toBase58(),
        balance: CONFIG.DRY_RUN ? 10.0 : 0,
        inUse: false,
        lastUsed: 0,
        totalSnipes: 0,
      });
      return;
    }

    const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
    const keys: string[] = data.wallets || data.privateKeys || [data];

    for (const key of keys) {
      try {
        const keypair = Keypair.fromSecretKey(decodePrivateKey(key));
        this.wallets.push({
          keypair,
          address: keypair.publicKey.toBase58(),
          balance: CONFIG.DRY_RUN ? 0.3333 : 0,
          inUse: false,
          lastUsed: 0,
          totalSnipes: 0,
        });
      } catch (err) {
        logger.error({ err }, `Failed to load wallet key`);
      }
    }

    logger.info({
      count: this.wallets.length,
      wallets: this.wallets.map(w => w.address.slice(0, 8) + '...'),
    }, 'Wallet manager initialized');

    if (this.wallets.length === 0) {
      throw new Error('No valid wallets loaded!');
    }
  }

  getNextWallet(): Keypair {
    const startIndex = this.currentIndex;

    for (let i = 0; i < this.wallets.length; i++) {
      const idx = (startIndex + i) % this.wallets.length;
      const wallet = this.wallets[idx];

      if (wallet.inUse) continue;
      if (Date.now() - wallet.lastUsed < 5000) continue; // 5s Jito cooldown

      this.currentIndex = (idx + 1) % this.wallets.length;
      wallet.lastUsed = Date.now();
      wallet.totalSnipes++;
      wallet.inUse = true;

      logger.debug({
        wallet: wallet.address.slice(0, 8) + '...',
        totalSnipes: wallet.totalSnipes,
      }, 'Assigned wallet for snipe');

      return wallet.keypair;
    }

    // All wallets in use — force the one with the oldest lastUsed
    const oldest = this.wallets.reduce((a, b) => a.lastUsed < b.lastUsed ? a : b);
    oldest.lastUsed = Date.now();
    oldest.totalSnipes++;
    oldest.inUse = true;

    logger.warn({ wallet: oldest.address.slice(0, 8) + '...', force: true }, 'All wallets busy — forcing oldest wallet');
    return oldest.keypair;
  }

  releaseWallet(publicKey: PublicKey): void {
    const wallet = this.wallets.find(w => w.address === publicKey.toBase58());
    if (wallet) {
      wallet.inUse = false;
      logger.debug({ wallet: wallet.address.slice(0, 8) + '...' }, 'Wallet released');
    }
  }

  async refillWallets(masterKeypair: Keypair, refillThreshold: number = 0.5, refillAmount: number = 2.0): Promise<void> {
    if (CONFIG.DRY_RUN) return; // Skip refill in dry run
    
    const masterBalance = await this.connection.getBalance(masterKeypair.publicKey);
    this.masterBalance = masterBalance / LAMPORTS_PER_SOL;
    
    logger.info({
      master: masterKeypair.publicKey.toBase58().slice(0, 8) + '...',
      balance: `${this.masterBalance.toFixed(2)} SOL`,
    }, 'Checking wallet balances for refill');

    for (const wallet of this.wallets) {
      try {
        const balance = await this.connection.getBalance(wallet.keypair.publicKey);
        wallet.balance = balance / LAMPORTS_PER_SOL;

        if (wallet.balance < refillThreshold && masterBalance > refillAmount * LAMPORTS_PER_SOL) {
          logger.info({
            wallet: wallet.address.slice(0, 8) + '...',
            balance: `${wallet.balance.toFixed(4)} SOL`,
            refilling: `${refillAmount} SOL`,
          }, 'Refilling wallet');

          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: masterKeypair.publicKey,
              toPubkey: wallet.keypair.publicKey,
              lamports: refillAmount * LAMPORTS_PER_SOL,
            })
          );
          tx.feePayer = masterKeypair.publicKey;
          const { blockhash } = await this.connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.sign(masterKeypair);

          const sig = await this.connection.sendRawTransaction(tx.serialize());
          await this.connection.confirmTransaction(sig, 'confirmed');
          wallet.balance += refillAmount;
          logger.info({ wallet: wallet.address.slice(0, 8) + '...', sig }, 'Refill complete');
        }
      } catch (err: any) {
        logger.error({ wallet: wallet.address.slice(0, 8) + '...', err: err.message }, 'Refill failed');
      }
    }
  }

  async sweepWallets(masterKeypair: Keypair, sweepThreshold: number = 3.0, keepAmount: number = 0.8): Promise<void> {
    if (CONFIG.DRY_RUN) return; // Skip sweep in dry run
    
    for (const wallet of this.wallets) {
      if (wallet.inUse) continue; // Don't sweep if the wallet is actively in a trade

      try {
        const balance = await this.connection.getBalance(wallet.keypair.publicKey);
        wallet.balance = balance / LAMPORTS_PER_SOL;

        if (wallet.balance > sweepThreshold) {
          const amountToSweep = wallet.balance - keepAmount;
          const targetPubkey = CONFIG.COLD_STORAGE_WALLET
            ? new PublicKey(CONFIG.COLD_STORAGE_WALLET)
            : masterKeypair.publicKey;

          logger.info({
            wallet: wallet.address.slice(0, 8) + '...',
            destination: targetPubkey.toBase58().slice(0, 8) + '...',
            balance: `${wallet.balance.toFixed(4)} SOL`,
            sweeping: `${amountToSweep.toFixed(4)} SOL`,
          }, 'Sweeping profits');

          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: wallet.keypair.publicKey,
              toPubkey: targetPubkey,
              lamports: Math.floor(amountToSweep * LAMPORTS_PER_SOL),
            })
          );
          tx.feePayer = wallet.keypair.publicKey;
          const { blockhash } = await this.connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.sign(wallet.keypair);

          const sig = await this.connection.sendRawTransaction(tx.serialize());
          await this.connection.confirmTransaction(sig, 'confirmed');
          wallet.balance -= amountToSweep;
          logger.info({ wallet: wallet.address.slice(0, 8) + '...', sig }, 'Sweep complete');
        }
      } catch (err: any) {
        logger.error({ wallet: wallet.address.slice(0, 8) + '...', err: err.message }, 'Sweep failed');
      }
    }
  }

  async refreshBalances(masterKeypair?: Keypair): Promise<void> {
    if (CONFIG.DRY_RUN) {
      this.masterBalance = 1000.0;
      return; // Balances are mocked in dry run
    }
    
    if (masterKeypair) {
      const mb = await this.connection.getBalance(masterKeypair.publicKey);
      this.masterBalance = mb / LAMPORTS_PER_SOL;
    }
    
    for (const wallet of this.wallets) {
      try {
        const balance = await this.connection.getBalance(wallet.keypair.publicKey);
        wallet.balance = balance / LAMPORTS_PER_SOL;
      } catch {
        // Skip on transient errors
      }
    }
  }

  getStats() {
    return {
      masterBalance: `${this.masterBalance.toFixed(4)} SOL`,
      totalWallets: this.wallets.length,
      availableWallets: this.wallets.filter(w => !w.inUse).length,
      totalBalance: this.wallets.reduce((s, w) => s + w.balance, 0),
      totalSnipes: this.wallets.reduce((s, w) => s + w.totalSnipes, 0),
      wallets: this.wallets.map(w => ({
        address: w.address.slice(0, 8) + '...',
        balance: `${w.balance.toFixed(4)} SOL`,
        inUse: w.inUse,
        totalSnipes: w.totalSnipes,
      })),
    };
  }

  saveState(filePath: string): void {
    const state = this.wallets.map(w => ({
      address: w.address,
      totalSnipes: w.totalSnipes,
    }));
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  }

  modifyVirtualBalance(publicKey: PublicKey, lamports: number) {
    if (!CONFIG.DRY_RUN) return;
    const wallet = this.wallets.find(w => w.address === publicKey.toBase58());
    if (wallet) {
      wallet.balance += lamports / LAMPORTS_PER_SOL;
      logger.info({ wallet: wallet.address.slice(0, 8) + '...', amount: (lamports / LAMPORTS_PER_SOL).toFixed(4) }, 'Updated virtual balance');
    }
  }

  async resetForMode(): Promise<void> {
    if (CONFIG.DRY_RUN) {
      // Switch to virtual balances (0.3333 SOL per sub-wallet = 1.0 SOL total)
      for (const w of this.wallets) {
        w.balance = 0.3333;
      }
      logger.info('Switched to Test Mode (1.0 SOL Total Simulated Balance)');
    } else {
      // Switch to real balances
      // Need to pass masterKeypair, but we don't have it here. It will refresh on next maintenance tick.
      await this.refreshBalances();
      logger.info('Switched to Live Mode (Real Balances)');
    }
  }
}
