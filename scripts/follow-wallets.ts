// scripts/follow-wallets.ts
//
// Out-of-sample test: do the candidate wallets actually pick winners?
//
// ── Why this is necessary ────────────────────────────────────────────────────────────────────
// score-pumpers.ts reported 17.4% precision for the best followable wallet, well past the ~5.9%
// break-even, and printed BUILD IT. That number cannot be trusted as it stands, because the
// selection is circular: find-pumpers.ts chose these wallets BECAUSE they appeared in those 62
// pumps, and then precision was computed using those same pumps as the numerator. Selecting on an
// outcome and then scoring that outcome always flatters the result.
//
// The only honest test is fresh data. This watches the candidates live and records what they buy
// on tokens that had nothing to do with picking them.
//
// It also settles two things the in-sample work could not:
//
//   1. IS THERE A WINDOW? score-pumpers reported "rank 3" — third transaction on the curve. That
//      is ordering, not time. Rank 3 could be 200ms after creation, which cannot be reacted to.
//      This records the actual milliseconds between token creation and the wallet's buy.
//      Note the latency measurement (+0.00% for being 1s late) was taken across ALL tokens, most
//      of which never trade. It does not necessarily hold on a token being actively pumped.
//
//   2. IS +400% REAL? The EV assumed entry near launch and exit at the crown. This records the
//      market cap at the moment they buy and the peak reached afterwards, so the actual
//      launch-to-crown multiple can be measured instead of assumed.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Fraction of followed buys whose token later pumps past the threshold, on fresh tokens:
//   > 12%        the in-sample signal survived. Build the follower for real.
//   6% to 12%    above break-even but thin, and the in-sample number was inflated. Fragile.
//   <= 6%        the 17.4% was selection bias. Following them loses money.
//
// Needs >= 30 followed buys before any verdict is printed.
//
// ── Mint extraction ──────────────────────────────────────────────────────────────────────────
// Does NOT trust a fixed account index — this project has been burned twice by that. For each
// account key in the transaction it derives the bonding-curve PDA and checks whether that PDA is
// also present in the same transaction. Only a real pump.fun mint satisfies that, so the match is
// self-validating.
//
// Usage:
//   npx tsx scripts/follow-wallets.ts --hours 12 [--threshold 100]
//   npx tsx scripts/follow-wallets.ts --analyze [--threshold 100]

import { Connection, PublicKey } from '@solana/web3.js';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { deriveBondingCurve } from '../src/utils.js';

const PUMPERS_FILE = './data/pumpers.json';
const OUT_FILE = './data/follows.jsonl';
const POLL_MS = 30_000;

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const THRESHOLD_SOL = parseFloat(argOf('threshold') || '100');
// Originally a fixed 30 minutes. follow-ev.ts then measured a p90 peak multiple of only 1.78x,
// which is what made copying lose (-9.9% EV) despite genuinely good selection - 19.5% precision
// against a ~3.9% base rate. But 30 minutes may simply be too short a window to see the winners
// finish running. Collect a longer path and let follow-ev.ts --maxhours slice it, so the horizon
// question is answered from one dataset instead of a second collection run.
const TRACK_MS = parseFloat(argOf('trackhours') || '4') * 3_600_000;

interface Follow {
  wallet: string;
  mint: string;
  seenAt: number;
  offsetMs: number;      // ms since we first saw the token created (-1 if we never saw creation)
  mcapAtBuy: number;
  mcapNow: number;
  sampleOffsetMs: number;
}

if (argv.includes('--analyze')) analyze();
else collect(parseFloat(argOf('hours') || '12'));

async function collect(hours: number) {
  if (!fs.existsSync(PUMPERS_FILE)) { console.error(`No ${PUMPERS_FILE} — run find-pumpers.ts first.`); process.exit(1); }
  const ranked: Array<{ wallet: string; pumps: number; bestRank: number }> = JSON.parse(fs.readFileSync(PUMPERS_FILE, 'utf8')).ranked ?? [];
  // Only wallets that are both selective enough to matter and late enough to be reactable.
  const watchList = ranked.filter(w => w.pumps >= 5 && w.bestRank >= 3).slice(0, 12).map(w => w.wallet);
  if (!watchList.length) { console.error('No followable candidates (pumps>=5 and rank>=3).'); process.exit(1); }

  fs.mkdirSync('./data', { recursive: true });
  const connection = new Connection(CONFIG.RPC_URL, 'processed');

  // Token creation times, so the time-window question can be answered.
  const bornAt = new Map<string, number>();
  const following = new Set<string>();
  let follows = 0;

  async function readMcap(mint: string): Promise<number | null> {
    try {
      const acc = await connection.getAccountInfo(deriveBondingCurve(new PublicKey(mint)), 'processed');
      if (!acc || acc.data.length < 48) return null;
      const v = new DataView(acc.data.buffer, acc.data.byteOffset, acc.data.byteLength);
      const vToken = v.getBigUint64(8, true);
      const vSol = v.getBigUint64(16, true);
      const supply = v.getBigUint64(40, true);
      if (vToken === 0n) return null;
      return Number(vSol * supply / vToken) / 1e9;
    } catch { return null; }
  }

  async function track(wallet: string, mint: string) {
    if (following.has(mint)) return;
    following.add(mint);
    const seenAt = Date.now();
    const mcapAtBuy = await readMcap(mint);
    if (mcapAtBuy === null) { following.delete(mint); return; }

    const born = bornAt.get(mint);
    const offsetMs = born ? seenAt - born : -1;
    follows++;
    console.log(`  📌 ${wallet.slice(0, 6)}… bought ${mint.slice(0, 8)}… at ${mcapAtBuy.toFixed(0)} SOL mcap` +
      (offsetMs >= 0 ? ` (${(offsetMs / 1000).toFixed(1)}s after launch)` : ' (launch time unknown)'));

    while (Date.now() - seenAt < TRACK_MS) {
      await new Promise(r => setTimeout(r, POLL_MS));
      const mcapNow = await readMcap(mint);
      if (mcapNow === null) continue;
      fs.appendFileSync(OUT_FILE, JSON.stringify({
        wallet, mint, seenAt, offsetMs, mcapAtBuy, mcapNow,
        sampleOffsetMs: Date.now() - seenAt,
      } as Follow) + '\n');
    }
    following.delete(mint);
  }

  const grpcMod = await import('@triton-one/yellowstone-grpc');
  const GrpcClient: any = (grpcMod as any).default;
  const client = new GrpcClient(process.env.GRPC_ENDPOINT || '', CONFIG.GRPC_TOKEN, {
    'grpc.max_receive_message_length': 128 * 1024 * 1024,
    'grpc.keepalive_time_ms': 10_000,
  });
  await client.connect();
  const stream = await client.subscribe();

  const toB58 = (v: any): string | null => {
    try {
      if (!v) return null;
      if (typeof v === 'string') return v;
      if (v.pubkey) return toB58(v.pubkey);
      return new PublicKey(Buffer.from(v)).toBase58();
    } catch { return null; }
  };

  stream.on('data', (data: any) => {
    const info = data?.transaction?.transaction;
    const msg = info?.transaction?.message;
    if (!msg?.accountKeys) return;

    const keys: string[] = [];
    for (const k of msg.accountKeys) { const s = toB58(k); if (s) keys.push(s); }
    if (!keys.length) return;

    const keySet = new Set(keys);

    // Which watched wallet signed this? The fee payer is always index 0.
    const payer = keys[0];

    // Self-validating mint detection: a key is the mint if its derived bonding-curve PDA is
    // also present in this transaction. No fixed index is trusted.
    let mint: string | null = null;
    for (const k of keys) {
      try {
        if (keySet.has(deriveBondingCurve(new PublicKey(k)).toBase58())) { mint = k; break; }
      } catch { /* not a valid pubkey */ }
    }
    if (!mint) return;

    // Record creation time the first time this mint is ever seen, whoever the payer is.
    if (!bornAt.has(mint)) bornAt.set(mint, Date.now());

    if (watchList.includes(payer)) {
      track(payer, mint).catch(() => { following.delete(mint!); });
    }
  });
  stream.on('error', (e: any) => console.error('stream error:', e?.message));

  // Two filters: everything pump.fun (to timestamp launches) and the watched wallets specifically.
  stream.write({
    slots: {},
    accounts: {},
    transactions: {
      pumpfun: { accountInclude: [CONFIG.PUMP_PROGRAM_ID.toBase58()], accountExclude: [], accountRequired: [], vote: false, failed: false },
      watched: { accountInclude: watchList, accountExclude: [], accountRequired: [], vote: false, failed: false },
    },
    transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {},
    accountsDataSlice: [], commitment: 0,
  });

  console.log(`Following ${watchList.length} wallets for ${hours}h, tracking each buy for ${(TRACK_MS / 3_600_000).toFixed(1)}h:`);
  for (const w of watchList) console.log(`  ${w}`);
  console.log('');

  await new Promise(r => setTimeout(r, hours * 3_600_000 + TRACK_MS));
  console.log(`\nDone. ${follows} buys followed.`);
  process.exit(0);
}

function analyze() {
  if (!fs.existsSync(OUT_FILE)) { console.error(`No ${OUT_FILE} — run collection first.`); process.exit(1); }

  const byBuy = new Map<string, Follow[]>();
  for (const line of fs.readFileSync(OUT_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const f: Follow = JSON.parse(line);
      if (!f?.mint || !isFinite(f.mcapNow)) continue;
      const key = `${f.wallet}:${f.mint}:${f.seenAt}`;
      const a = byBuy.get(key);
      if (a) a.push(f); else byBuy.set(key, [f]);
    } catch { /* skip */ }
  }

  const buys = [...byBuy.values()].filter(a => a.length >= 2);
  const pumped = buys.filter(a => a.some(s => s.mcapNow >= THRESHOLD_SOL));

  // Actual multiple achieved from their entry to the peak — replaces the assumed +400%.
  const multiples = buys.map(a => Math.max(...a.map(s => s.mcapNow)) / a[0].mcapAtBuy);
  multiples.sort((x, y) => x - y);
  const medMultiple = multiples.length ? multiples[Math.floor(multiples.length / 2)] : NaN;

  const delays = buys.map(a => a[0].offsetMs).filter(x => x >= 0).sort((x, y) => x - y);
  const medDelay = delays.length ? delays[Math.floor(delays.length / 2)] : NaN;

  const precision = buys.length ? pumped.length / buys.length * 100 : 0;

  console.log(`followed buys:        ${buys.length}`);
  console.log(`later pumped >${THRESHOLD_SOL} SOL: ${pumped.length}`);
  console.log(`precision:            ${precision.toFixed(1)}%`);
  console.log(`median peak multiple: ${isFinite(medMultiple) ? medMultiple.toFixed(2) + 'x' : 'n/a'}`);
  console.log(`median buy delay:     ${isFinite(medDelay) ? (medDelay / 1000).toFixed(1) + 's after launch' : 'unknown'}`);

  // Per-wallet, so one good wallet is not hidden by eleven bad ones.
  const perWallet = new Map<string, { n: number; hits: number }>();
  for (const a of buys) {
    const w = a[0].wallet;
    const rec = perWallet.get(w) ?? { n: 0, hits: 0 };
    rec.n++;
    if (a.some(s => s.mcapNow >= THRESHOLD_SOL)) rec.hits++;
    perWallet.set(w, rec);
  }
  console.log('');
  console.table([...perWallet.entries()]
    .map(([w, r]) => ({ wallet: `${w.slice(0, 6)}…${w.slice(-4)}`, buys: r.n, pumps: r.hits, precision: `${(r.hits / r.n * 100).toFixed(1)}%` }))
    .sort((a, b) => parseFloat(b.precision) - parseFloat(a.precision)));

  console.log('');
  console.log('─'.repeat(74));
  if (buys.length < 30) {
    console.log(`INCONCLUSIVE — only ${buys.length} followed buys. Needs at least 30.`);
  } else if (precision > 12) {
    console.log(`CONFIRMED: ${precision.toFixed(1)}% precision on fresh tokens. The in-sample signal held.`);
    console.log(`Median peak multiple ${medMultiple.toFixed(2)}x from their entry. Build the follower.`);
  } else if (precision > 6) {
    console.log(`THIN: ${precision.toFixed(1)}% on fresh tokens — above break-even but well under the 17.4%`);
    console.log('measured in sample, which means most of that number was selection bias.');
  } else {
    console.log(`FAILED: ${precision.toFixed(1)}% on fresh tokens vs 17.4% in sample. The in-sample result`);
    console.log('was selection bias, exactly as suspected. These wallets do not pick winners.');
  }
  if (isFinite(medDelay) && medDelay < 1500) {
    console.log(`Also note: they buy a median ${(medDelay / 1000).toFixed(1)}s after launch — inside your ~1s`);
    console.log('analysis time, so following them in real time would be marginal even if the edge is real.');
  }
  console.log('─'.repeat(74));
}
