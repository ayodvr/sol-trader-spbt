import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from '@solana/web3.js';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import { decodePrivateKey } from '../src/utils.js';
import { CONFIG } from '../config.js';

const logger = pino({ name: 'sweep-all' });

async function sweepAllToMaster() {
  const connection = new Connection(CONFIG.RPC_URL, 'confirmed');

  // Load Master Keypair
  const masterKeypair = Keypair.fromSecretKey(decodePrivateKey(CONFIG.PRIVATE_KEY));
  const masterPubkey = masterKeypair.publicKey;
  const initialMasterBal = await connection.getBalance(masterPubkey);

  console.log('\n==================================================');
  console.log(`🏦 MASTER VAULT ADDRESS: ${masterPubkey.toBase58()}`);
  console.log(`💰 INITIAL MASTER BALANCE: ${(initialMasterBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log('==================================================\n');

  // Load Sub-Wallets from wallets.json
  const resolvedPath = path.resolve('./wallets.json');
  if (!fs.existsSync(resolvedPath)) {
    console.error('❌ wallets.json not found!');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  const keys: string[] = data.wallets || data.privateKeys || [data];

  let totalSwept = 0;

  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    try {
      const subKeypair = Keypair.fromSecretKey(decodePrivateKey(key));
      const subPubkey = subKeypair.publicKey;
      const balLamports = await connection.getBalance(subPubkey);
      const balSol = balLamports / LAMPORTS_PER_SOL;

      console.log(`Sub-Wallet ${i + 1} (${subPubkey.toBase58().slice(0, 8)}...): ${balSol.toFixed(4)} SOL`);

      // Leave 0.001 SOL for minimum gas fee
      const sweepLamports = balLamports - 100_000;

      if (sweepLamports <= 0) {
        console.log(`  └─ Balance too low to sweep (<= 0.0001 SOL)\n`);
        continue;
      }

      console.log(`  └─ Sweeping ${(sweepLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL to Master Vault...`);

      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: subPubkey,
          toPubkey: masterPubkey,
          lamports: sweepLamports,
        })
      );
      tx.feePayer = subPubkey;
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.sign(subKeypair);

      const sig = await connection.sendRawTransaction(tx.serialize());
      await connection.confirmTransaction(sig, 'confirmed');

      totalSwept += sweepLamports / LAMPORTS_PER_SOL;
      console.log(`  └─ ✅ Swept successfully! Tx Signature: ${sig}\n`);
    } catch (err: any) {
      console.error(`  └─ ❌ Sweep failed for wallet ${i + 1}: ${err.message}\n`);
    }
  }

  const finalMasterBal = await connection.getBalance(masterPubkey);
  console.log('==================================================');
  console.log(`✅ TOTAL SWEPT: ${totalSwept.toFixed(4)} SOL`);
  console.log(`💰 FINAL MASTER VAULT BALANCE: ${(finalMasterBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log('==================================================\n');
}

sweepAllToMaster().catch(err => {
  console.error('Sweep script error:', err);
});
