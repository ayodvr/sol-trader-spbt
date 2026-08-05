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
  private masterKeypair?: Keypair;

  constructor(walletPath: string, minBalanceSol: number = 0.5, masterKeypair?: Keypair) {
    this.connection = new Connection(CONFIG.RPC_URL, 'confirmed');
    this.minWalletBalance = minBalanceSol;
    try {
      this.masterKeypair = masterKeypair || Keypair.fromSecretKey(decodePrivateKey(CONFIG.PRIVATE_KEY));
    } catch { }
    this.loadWallets(walletPath);
    this.refreshBalances();
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

  getNextWallet(minBalanceSol: number = 0.02): Keypair {
    const startIndex = this.currentIndex;

    for (let i = 0; i < this.wallets.length; i++) {
      const idx = (startIndex + i) % this.wallets.length;
      const wallet = this.wallets[idx];

      // Auto-release stale inUse flag if lastUsed > 30 seconds ago
      if (wallet.inUse && Date.now() - wallet.lastUsed > 30_000) {
        wallet.inUse = false;
      }

      if (wallet.inUse) continue;
      if (Date.now() - wallet.lastUsed < 5000) continue; // 5s Jito cooldown

      // Skip wallets with insufficient SOL in Live Mainnet mode
      if (!CONFIG.DRY_RUN && wallet.balance < minBalanceSol) continue;

      this.currentIndex = (idx + 1) % this.wallets.length;
      wallet.lastUsed = Date.now();
      wallet.inUse = true;

      logger.debug({
        wallet: wallet.address.slice(0, 8) + '...',
        totalSnipes: wallet.totalSnipes,
      }, 'Assigned wallet for snipe');

      return wallet.keypair;
    }

    // Fallback: Pick funded wallet with oldest lastUsed
    const fundedWallets = CONFIG.DRY_RUN ? this.wallets : this.wallets.filter(w => w.balance >= minBalanceSol);
    const pool = fundedWallets.length > 0 ? fundedWallets : this.wallets;
    const oldest = pool.reduce((a, b) => a.lastUsed < b.lastUsed ? a : b);
    oldest.lastUsed = Date.now();
    oldest.inUse = true;

    logger.warn({ wallet: oldest.address.slice(0, 8) + '...', force: true }, 'Assigned funded wallet');
    return oldest.keypair;
  }

  recordSuccessfulSnipe(publicKey: PublicKey): void {
    const wallet = this.wallets.find(w => w.address === publicKey.toBase58());
    if (wallet) {
      wallet.totalSnipes++;
    }
  }

  resetSnipeCounters(): void {
    for (const w of this.wallets) {
      w.totalSnipes = 0;
    }
  }

  releaseWallet(publicKey: PublicKey): void {
    const wallet = this.wallets.find(w => w.address === publicKey.toBase58());
    if (wallet) {
      wallet.inUse = false;
      logger.debug({ wallet: wallet.address.slice(0, 8) + '...' }, 'Wallet released');
    }
  }

  async refillWallets(masterKeypair: Keypair, refillThreshold: number = 0.1, refillAmount: number = 0.05): Promise<void> {
    if (CONFIG.DRY_RUN) return; // Skip refill in dry run
    
    const masterBalance = await this.connection.getBalance(masterKeypair.publicKey);
    this.masterBalance = masterBalance / LAMPORTS_PER_SOL;

    // Refresh sub-wallet balances
    for (const wallet of this.wallets) {
      try {
        const b = await this.connection.getBalance(wallet.keypair.publicKey);
        wallet.balance = b / LAMPORTS_PER_SOL;
      } catch { }
    }

    const totalSubSol = this.wallets.reduce((s, w) => s + w.balance, 0);
    const totalSystemSol = this.masterBalance + totalSubSol;

    logger.info({
      master: `${this.masterBalance.toFixed(4)} SOL`,
      subTotal: `${totalSubSol.toFixed(4)} SOL`,
      totalSystem: `${totalSystemSol.toFixed(4)} SOL`,
    }, 'Rebalancing sub-wallet funds equally');

    // Case 1: Refill unfunded wallets from Master Vault if master has > 0.05 SOL
    for (const wallet of this.wallets) {
      if (wallet.balance < 0.15 && this.masterBalance > 0.08) {
        const transferSol = Math.min(0.25, this.masterBalance - 0.05);
        if (transferSol <= 0.02) continue;

        try {
          logger.info({
            wallet: wallet.address.slice(0, 8) + '...',
            amount: `${transferSol.toFixed(4)} SOL`,
          }, 'Funding sub-wallet from Master Vault');

          const tx = new Transaction().add(
            SystemProgram.transfer({
              fromPubkey: masterKeypair.publicKey,
              toPubkey: wallet.keypair.publicKey,
              lamports: Math.floor(transferSol * LAMPORTS_PER_SOL),
            })
          );
          tx.feePayer = masterKeypair.publicKey;
          const { blockhash } = await this.connection.getLatestBlockhash();
          tx.recentBlockhash = blockhash;
          tx.sign(masterKeypair);

          const sig = await this.connection.sendRawTransaction(tx.serialize());
          await this.connection.confirmTransaction(sig, 'confirmed');
          wallet.balance += transferSol;
          this.masterBalance -= transferSol;
          logger.info({ wallet: wallet.address.slice(0, 8) + '...', sig }, 'Refill from Master Vault complete');
        } catch (err: any) {
          logger.error({ wallet: wallet.address.slice(0, 8) + '...', err: err.message }, 'Refill from Master Vault failed');
        }
      }
    }

    // Case 2: If Sub-wallet 1 has high balance (> 0.4 SOL) while other sub-wallets are < 0.1 SOL, transfer directly from Sub-wallet 1 to unfunded sub-wallets
    const flushSource = this.wallets.find(w => w.balance > 0.40 && !w.inUse);
    if (flushSource) {
      for (const targetWallet of this.wallets) {
        if (targetWallet.address === flushSource.address) continue;
        if (targetWallet.balance < 0.15 && flushSource.balance > 0.35) {
          const share = 0.25;
          try {
            logger.info({
              from: flushSource.address.slice(0, 8) + '...',
              to: targetWallet.address.slice(0, 8) + '...',
              amount: `${share} SOL`,
            }, 'Equalizing funds between sub-wallets');

            const tx = new Transaction().add(
              SystemProgram.transfer({
                fromPubkey: flushSource.keypair.publicKey,
                toPubkey: targetWallet.keypair.publicKey,
                lamports: Math.floor(share * LAMPORTS_PER_SOL),
              })
            );
            tx.feePayer = flushSource.keypair.publicKey;
            const { blockhash } = await this.connection.getLatestBlockhash();
            tx.recentBlockhash = blockhash;
            tx.sign(flushSource.keypair);

            const sig = await this.connection.sendRawTransaction(tx.serialize());
            await this.connection.confirmTransaction(sig, 'confirmed');
            flushSource.balance -= share;
            targetWallet.balance += share;
            logger.info({ to: targetWallet.address.slice(0, 8) + '...', sig }, 'Fund equalization complete');
          } catch (err: any) {
            logger.error({ err: err.message }, 'Fund equalization failed');
          }
        }
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
          const targetStr = CONFIG.COLD_STORAGE_WALLET ? CONFIG.COLD_STORAGE_WALLET.trim() : '';
          const targetPubkey = targetStr
            ? new PublicKey(targetStr)
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
    const keyToUse = masterKeypair || this.masterKeypair;

    // Always fetch the real on-chain master balance (even in dry-run),
    // so the dashboard shows actual SOL — not a fake 1000 SOL placeholder.
    if (keyToUse) {
      try {
        const mb = await this.connection.getBalance(keyToUse.publicKey);
        this.masterBalance = mb / LAMPORTS_PER_SOL;
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to fetch master wallet balance');
        // Fallback: keep existing value rather than resetting to 0
      }
    }

    if (CONFIG.DRY_RUN) {
      // Sub-wallet balances stay virtual in dry-run — don't overwrite them with on-chain values
      return;
    }

    if (this.masterKeypair) {
      try {
        const mBal = await this.connection.getBalance(this.masterKeypair.publicKey);
        this.masterBalance = mBal / LAMPORTS_PER_SOL;
      } catch {}
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
    const now = Date.now();
    for (const w of this.wallets) {
      if (w.inUse && now - w.lastUsed > 30_000) {
        w.inUse = false;
      }
    }

    return {
      masterBalance: `${this.masterBalance.toFixed(4)} SOL`,
      totalWallets: this.wallets.length,
      availableWallets: this.wallets.filter(w => !w.inUse).length,
      totalBalance: this.masterBalance + this.wallets.reduce((s, w) => s + w.balance, 0),
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
      // Floor at 0 — paper balances can't go negative
      if (wallet.balance < 0) {
        logger.warn({ wallet: wallet.address.slice(0, 8) + '...' }, '⚠️ Virtual balance went negative — resetting to paper starting amount');
        wallet.balance = 0.3333; // Refill to starting paper amount so testing continues
      }
      logger.info({ wallet: wallet.address.slice(0, 8) + '...', balance: wallet.balance.toFixed(4), amount: (lamports / LAMPORTS_PER_SOL).toFixed(4) }, 'Updated virtual balance');
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
