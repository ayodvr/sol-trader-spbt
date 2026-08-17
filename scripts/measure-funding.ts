// scripts/measure-funding.ts
//
// Would a market-neutral funding-capture position actually have made money?
//
// ── The strategy being tested ────────────────────────────────────────────────────────────────
// Hold the coin (spot) AND short the same size in a perpetual future. Price moves cancel out, so
// there is no directional bet — the coin can double or halve and the position ends up flat. What
// you collect is the funding rate: the payment the crowded side of the perp market makes to the
// other side. In crypto the crowd usually leans long, so shorts get paid.
//
// This matters because every strategy measured in this project so far required predicting which
// token would go up, and five separate measurements showed that has no edge. This one has no
// opinion to be wrong about. It also needs no Jito tip and no latency race, and it is held for
// weeks rather than seconds — which is the real point, because the ~5% per-trade cost that killed
// sniping was mostly a FIXED per-transaction charge. Held for 30 seconds it is fatal; held for a
// month it is noise.
//
// ── Decision rule, committed BEFORE running ──────────────────────────────────────────────────
// Net annualised return after fees, on the always-in position:
//   > +10%      worth building. Beats idle cash by enough to pay for liquidation risk and babysitting.
//   0% to +10%  real but too thin to justify the operational risk. Don't build.
//   <= 0%       the crowd was not leaning long. Strategy does not work. Stop.
// The script prints the verdict itself.
//
// ── Data sources ─────────────────────────────────────────────────────────────────────────────
// Binance /fapi/v1/fundingRate is public, needs no API key, pages back years, and is the
// best-documented funding history available. It carries the directional analysis.
//
// Drift's /fundingRates only returns the LAST 30 DAYS, so it cannot answer the historical
// question. It is fetched purely as a scale check on the venue actually being considered — and
// only its MAGNITUDE is reported, because Drift's sign convention appears to be inverted relative
// to Binance's (Binance: positive = longs pay shorts; Drift community code treats negative as
// longs getting paid). That sign must be verified on-venue before any real trade. Getting it
// backwards would mean paying the funding instead of collecting it.
//
// Usage:
//   npx tsx scripts/measure-funding.ts                       # SOL/BTC/ETH, 12 months
//   npx tsx scripts/measure-funding.ts --symbol SOLUSDT --months 6

const BINANCE = 'https://fapi.binance.com/fapi/v1/fundingRate';
const DRIFT = 'https://data.api.drift.trade/fundingRates';

// Round-trip cost of establishing AND unwinding both legs: spot buy + perp short, then both closed.
// Roughly 0.25% per spot side and 0.1% per perp side on Solana venues including slippage. This is
// paid ONCE for the whole holding period, not per funding payment — which is the entire thesis.
const ROUND_TRIP_FEE_PCT = 0.7;
const FUNDINGS_PER_DAY = 3; // Binance pays every 8 hours

interface Funding { fundingTime: number; fundingRate: number; }

const argv = process.argv.slice(2);
const argOf = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] ?? null) : null; };
const months = parseFloat(argOf('months') || '12');
const symbols = argOf('symbol') ? [argOf('symbol')!] : ['SOLUSDT', 'BTCUSDT', 'ETHUSDT'];

main().catch(err => { console.error('failed:', err.message); process.exit(1); });

async function main() {
  console.log(`Funding-capture backtest — ${months} months, fees ${ROUND_TRIP_FEE_PCT}% round trip\n`);

  const results: Array<{ symbol: string; net: number; row: any }> = [];
  for (const symbol of symbols) {
    const history = await fetchBinance(symbol, months);
    if (history.length < 30) {
      console.log(`${symbol}: only ${history.length} funding records — skipping.`);
      continue;
    }
    results.push({ symbol, ...evaluate(symbol, history) });
  }

  if (!results.length) { console.error('No usable data.'); process.exit(1); }

  console.log('Always-in market-neutral position (long spot + short perp, held the whole period):');
  console.table(results.map(r => r.row));

  await driftScaleCheck();

  // Verdict is decided on the primary asset (first requested), not on whichever looks best —
  // cherry-picking the best-performing symbol after the fact is exactly what the pre-committed
  // rule exists to prevent.
  const primary = results[0];
  console.log('');
  console.log('─'.repeat(74));
  console.log(`Verdict is read on ${primary.symbol} (the asset asked for), not the best performer.`);
  if (primary.net > 10) {
    console.log(`VERDICT: ${primary.net.toFixed(1)}% net annualised — above the 10% bar. Worth building.`);
  } else if (primary.net > 0) {
    console.log(`VERDICT: ${primary.net.toFixed(1)}% net annualised — positive but under the 10% bar.`);
    console.log('Too thin to justify liquidation risk and manual babysitting. Do not build.');
  } else {
    console.log(`VERDICT: ${primary.net.toFixed(1)}% net annualised. The crowd was not leaning long`);
    console.log('over this period. The strategy does not work. Stop.');
  }
  console.log('─'.repeat(74));
}

/** Page backwards through Binance funding history. Public endpoint, no key, max 1000 per call. */
async function fetchBinance(symbol: string, monthsBack: number): Promise<Funding[]> {
  const since = Date.now() - monthsBack * 30 * 24 * 3600_000;
  const out: Funding[] = [];
  let startTime = since;

  for (let page = 0; page < 20; page++) {
    const url = `${BINANCE}?symbol=${symbol}&startTime=${startTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance ${res.status} for ${symbol}: ${await res.text()}`);
    const batch: any[] = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const b of batch) {
      const rate = parseFloat(b.fundingRate);
      if (isFinite(rate)) out.push({ fundingTime: Number(b.fundingTime), fundingRate: rate });
    }
    if (batch.length < 1000) break;
    startTime = Number(batch[batch.length - 1].fundingTime) + 1;
  }

  out.sort((a, b) => a.fundingTime - b.fundingTime);
  return out;
}

function evaluate(symbol: string, h: Funding[]) {
  const days = (h[h.length - 1].fundingTime - h[0].fundingTime) / 86_400_000;

  // A short collects when fundingRate is positive (longs pay shorts on Binance).
  const grossPct = h.reduce((s, f) => s + f.fundingRate * 100, 0);
  const netPct = grossPct - ROUND_TRIP_FEE_PCT;
  const netAnnualised = netPct * (365 / days);

  // Conditional variant: only hold while funding was positive at the last payment, paying the
  // round-trip fee on every flip. Implementable in real time — funding sign is persistent and
  // published ahead of each payment — so this is a rule, not hindsight.
  let condGross = 0, flips = 0, inPosition = false;
  for (let i = 1; i < h.length; i++) {
    const wantIn = h[i - 1].fundingRate > 0;
    if (wantIn !== inPosition) { flips++; inPosition = wantIn; }
    if (inPosition) condGross += h[i].fundingRate * 100;
  }
  const condNet = condGross - flips * ROUND_TRIP_FEE_PCT;
  const condAnnualised = condNet * (365 / days);

  const negShare = h.filter(f => f.fundingRate <= 0).length / h.length * 100;

  return {
    net: netAnnualised,
    row: {
      symbol,
      days: Math.round(days),
      payments: h.length,
      'gross %': grossPct.toFixed(2),
      'net % APR': netAnnualised.toFixed(1),
      'negative payments': `${negShare.toFixed(0)}%`,
      'filtered APR': `${condAnnualised.toFixed(1)} (${flips} flips)`,
    },
  };
}

/** Drift only serves 30 days, so this is a magnitude sanity check on the venue — not a backtest. */
async function driftScaleCheck() {
  console.log('');
  try {
    const res = await fetch(`${DRIFT}?marketName=SOL-PERP`);
    if (!res.ok) { console.log(`Drift scale check unavailable (HTTP ${res.status}) — skipping.`); return; }
    const body: any = await res.json();
    const rows: any[] = Array.isArray(body) ? body : (body?.data ?? body?.fundingRates ?? []);
    if (!rows.length) { console.log('Drift returned no rows — check the response shape by hand.'); return; }

    // Documented conversion: fundingRatePct = (fundingRate / 1e9) / (oraclePriceTwap / 1e6),
    // paid hourly. Reported as an absolute magnitude only — see the sign-convention warning above.
    const pcts = rows.map(r => {
      const fr = Number(r.fundingRate), twap = Number(r.oraclePriceTwap);
      if (!isFinite(fr) || !isFinite(twap) || twap === 0) return NaN;
      return (fr / 1e9) / (twap / 1e6) * 100;
    }).filter(x => isFinite(x));
    if (!pcts.length) { console.log('Drift rows present but unparseable — inspect the payload.'); return; }

    const meanAbsApr = pcts.reduce((s, p) => s + Math.abs(p), 0) / pcts.length * 24 * 365;
    console.log(`Drift SOL-PERP scale check (last ${pcts.length} hourly payments, ~30d max):`);
    console.log(`  mean |funding| ≈ ${meanAbsApr.toFixed(1)}% APR in magnitude`);
    console.log('  Direction NOT asserted — Drift\'s sign convention looks inverted vs Binance and');
    console.log('  must be confirmed on-venue. Backwards means you PAY funding instead of earning it.');
  } catch (err: any) {
    console.log(`Drift scale check failed (${err.message}) — not fatal, Binance carries the analysis.`);
  }
}
