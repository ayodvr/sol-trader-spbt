import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import fs from 'fs';

const numWallets = 3; // You can change this to 5 if you want more
const wallets: string[] = [];

console.log(`Generating ${numWallets} new sub-wallets...\n`);

for (let i = 0; i < numWallets; i++) {
  const keypair = Keypair.generate();
  const privateKey = bs58.encode(keypair.secretKey);
  const publicKey = keypair.publicKey.toBase58();
  
  wallets.push(privateKey);
  console.log(`Sub-Wallet ${i + 1} Address: ${publicKey}`);
}

const data = {
  wallets: wallets
};

fs.writeFileSync('./wallets.json', JSON.stringify(data, null, 2));

console.log('\n✅ Successfully saved private keys to wallets.json');
console.log('WARNING: Never share your wallets.json file with anyone!');
