// Empirical peer-calibrated pre-token valuation model and chain-aware farm planner.
// Runs on Node 22 standard library only (erasable TypeScript, zero external dependencies).

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelParams {
  version: string;
  shrinkage_k: number;
  peer_ratio_min: number;
  peer_ratio_max: number;
  sector_mult_min: number;
  sector_mult_max: number;
  growth_floor_pct: number;
  growth_cap_pct: number;
  growth_weight: number;
  maturity_floor: number;
  maturity_span: number;
  maturity_cap_days: number;
  unknown_age_days: number;
  chain_step: number;
  chain_max_extra: number;
}

export const DEFAULT_PARAMS: ModelParams = {
  version: 'empirical-peer-v2',
  shrinkage_k: 5,
  peer_ratio_min: 0.06,
  peer_ratio_max: 1.05,
  sector_mult_min: 0.14,
  sector_mult_max: 0.55,
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  growth_weight: 0.45,
  maturity_floor: 0.65,
  maturity_span: 0.45,
  maturity_cap_days: 1095,
  unknown_age_days: 365,
  chain_step: 0.03,
  chain_max_extra: 8,
};

export interface SectorMultiple {
  category: string;
  peer_count: number;
  raw_median: number | null;
  shrunk_multiple: number;
  p25: number;
  p75: number;
}

export interface FarmStepDetail {
  phase: string;
  action: string;
  cost: string;
  time: string;
}

export interface FarmSummary {
  primary_chain: string;
  secondary_chain: string | null;
  capital_usd: number;
  tx_gas_usd: number;
  est_total_gas_usd: number;
  hold_days: number;
  setup_minutes: number;
  weekly_minutes: number;
  risk_tier: 'Low' | 'Moderate' | 'Active';
}

export interface ValuationBreakdown {
  sector_multiple: number;
  sector_peer_count: number;
  global_median_multiple: number;
  growth_pct_clamped: number;
  growth_mult: number;
  maturity_mult: number;
  chain_mult: number;
  effective_multiple: number;
  low_usd: number;
  high_usd: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string;
  chains: string[];
  tier: 'watchlist' | 'early';
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'no_token_recorded';
  implied_value_usd: number;
  valuation: ValuationBreakdown;
  farm_summary: FarmSummary;
  farm_plan: FarmStepDetail[];
  farm_steps: string[];
}

export interface LiveCompRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  mcap_tvl_ratio: number;
  change_7d: number | null;
  listed_at: string | null;
}

export interface RadarDataset {
  as_of: string;
  source: string;
  floor_usd: number;
  params: ModelParams;
  global_live_median: number;
  global_live_p25: number;
  global_live_p75: number;
  counts: {
    snapshot_total: number;
    watchlist_total: number;
    early_total: number;
    board_total: number;
    live_comps_total: number;
    total_pre_token_tvl_usd: number;
    total_implied_value_usd: number;
  };
  sector_multiples: SectorMultiple[];
  rows: BoardRow[];
  live_comps: LiveCompRow[];
}

const DAY_MS = 86_400_000;
const EXCLUDED_EARLY_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_STAKED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

export function computeAgeDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const t0 = Date.parse(`${asOf}T00:00:00Z`);
  const t1 = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return null;
  return Math.max(0, Math.floor((t0 - t1) / DAY_MS));
}

export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isCleanEarlyCandidate(p: SnapshotProtocol, floorUsd: number): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.tvl_usd >= floorUsd) return false;
  if (EXCLUDED_EARLY_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_STAKED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

export function parseSnapshot(rawText: string): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error('snapshot.json is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('snapshot.json root must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(obj.as_of)) {
    throw new Error('snapshot.json missing valid as_of');
  }
  if (typeof obj.source !== 'string') throw new Error('snapshot.json missing source');
  if (typeof obj.floor_usd !== 'number' || !Number.isSafeInteger(obj.floor_usd) || obj.floor_usd <= 0) {
    throw new Error('snapshot.json missing positive integer floor_usd');
  }
  if (!Array.isArray(obj.protocols)) throw new Error('snapshot.json missing protocols array');
  if (!Array.isArray(obj.watchlist) || obj.watchlist.some((s) => typeof s !== 'string')) {
    throw new Error('snapshot.json missing string watchlist');
  }
  const protocols: SnapshotProtocol[] = obj.protocols.map((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`protocol[${idx}] is not an object`);
    }
    const p = entry as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`protocol[${idx}] missing slug, name, or finite tvl_usd`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' && p.category.trim().length > 0 ? p.category.trim() : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string' && c.length > 0) : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: obj.as_of,
    source: obj.source,
    floor_usd: obj.floor_usd,
    protocols,
    watchlist: obj.watchlist as string[],
  };
}

/**
 * Calibrate empirical MCap/TVL multiples directly from live-token non-CEX peers in the snapshot.
 * Applies Empirical Bayes shrinkage toward the global live median when category peer count is small.
 */
export function calibratePeerMultiples(
  snapshot: Snapshot,
  params: ModelParams,
): {
  globalMedian: number;
  globalP25: number;
  globalP75: number;
  byCategory: Map<string, SectorMultiple>;
  liveComps: LiveCompRow[];
} {
  const liveComps: LiveCompRow[] = [];
  const allRatios: number[] = [];
  const catRatios = new Map<string, number[]>();

  for (const p of snapshot.protocols) {
    if (recordsNoToken(p)) continue;
    if (p.category === 'CEX') continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;

    const rawRatio = p.mcap_usd / p.tvl_usd;
    const winsorRatio = clamp(rawRatio, params.peer_ratio_min, params.peer_ratio_max);
    const cat = p.category ?? 'Uncategorized';

    allRatios.push(winsorRatio);
    const bucket = catRatios.get(cat) ?? [];
    bucket.push(winsorRatio);
    catRatios.set(cat, bucket);

    liveComps.push({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: cat,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      mcap_tvl_ratio: round4(rawRatio),
      change_7d: p.change_7d,
      listed_at: p.listed_at,
    });
  }

  liveComps.sort((a, b) => b.mcap_usd - a.mcap_usd || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
  allRatios.sort((a, b) => a - b);

  const globalMedian = allRatios.length > 0 ? round4(quantile(allRatios, 0.5)) : 0.25;
  const globalP25 = allRatios.length > 0 ? round4(quantile(allRatios, 0.25)) : 0.12;
  const globalP75 = allRatios.length > 0 ? round4(quantile(allRatios, 0.75)) : 0.50;

  const byCategory = new Map<string, SectorMultiple>();
  for (const [cat, vals] of catRatios.entries()) {
    vals.sort((a, b) => a - b);
    const n = vals.length;
    const rawMed = quantile(vals, 0.5);
    // Use stronger Bayesian shrinkage when a category has fewer than 3 live peers to prevent single-outlier distortion.
    const effectiveK = n >= 3 ? params.shrinkage_k : params.shrinkage_k * 3;
    const shrunk = (n * rawMed + effectiveK * globalMedian) / (n + effectiveK);
    const clampedMult = round4(clamp(shrunk, params.sector_mult_min, params.sector_mult_max));
    const p25 = n >= 3 ? round4(clamp(quantile(vals, 0.25), 0.06, clampedMult)) : round4(clampedMult * 0.65);
    const p75 = n >= 3 ? round4(clamp(quantile(vals, 0.75), clampedMult, 1.35)) : round4(clampedMult * 1.48);
    byCategory.set(cat, {
      category: cat,
      peer_count: n,
      raw_median: round4(rawMed),
      shrunk_multiple: clampedMult,
      p25,
      p75,
    });
  }

  return { globalMedian, globalP25, globalP75, byCategory, liveComps };
}

interface ChainGasInfo {
  chain: string;
  txUsd: number;
  label: string;
}

const LOW_FEE_CHAINS = new Map<string, number>([
  ['Solana', 0.02],
  ['Base', 0.05],
  ['Arbitrum', 0.08],
  ['Optimism', 0.06],
  ['Monad', 0.04],
  ['Hyperliquid L1', 0.05],
  ['Sui', 0.02],
  ['Aptos', 0.02],
  ['Polygon', 0.04],
  ['Sonic', 0.03],
  ['Ink', 0.05],
  ['MegaETH', 0.04],
  ['Abstract', 0.05],
  ['Scroll', 0.10],
  ['Linea', 0.10],
  ['Mantle', 0.05],
  ['Berachain', 0.06],
  ['Plasma', 0.05],
  ['Unichain', 0.05],
  ['Plume Mainnet', 0.06],
  ['Avalanche', 0.15],
  ['Binance', 0.15],
  ['Gnosis', 0.02],
  ['Sei', 0.03],
  ['Starknet', 0.12],
  ['zkSync Era', 0.10],
  ['Tron', 0.45],
  ['Ton', 0.05],
  ['Near', 0.02],
  ['Stellar', 0.01],
  ['Flare', 0.03],
  ['Bittensor', 0.15],
]);

function gasForChain(chain: string): number {
  const known = LOW_FEE_CHAINS.get(chain);
  if (known !== undefined) return known;
  if (chain === 'Ethereum') return 4.50;
  if (chain === 'Bitcoin') return 2.80;
  return 0.25;
}

function chooseBestChains(chains: string[]): { primary: ChainGasInfo; secondary: ChainGasInfo | null } {
  if (chains.length === 0) {
    return { primary: { chain: 'Primary L2', txUsd: 0.15, label: 'low-fee network' }, secondary: null };
  }
  // Balance low transaction cost with core liquidity presence (earlier chains in snapshot order).
  const scored = chains.map((c, idx) => {
    const txUsd = gasForChain(c);
    const feeBucket = txUsd <= 0.25 ? 0 : txUsd <= 1.0 ? 1 : 2;
    return { chain: c, txUsd, feeBucket, idx };
  });
  scored.sort((a, b) => a.feeBucket - b.feeBucket || a.idx - b.idx || a.txUsd - b.txUsd);
  const best = scored[0]!;
  const second = scored.length >= 2 ? scored[1]! : null;
  const label = best.txUsd <= 0.15 ? 'low-fee L2/alt-L1' : best.txUsd >= 2.0 ? 'L1 mainnet' : 'mid-fee network';
  return {
    primary: { chain: best.chain, txUsd: best.txUsd, label },
    secondary: second ? { chain: second.chain, txUsd: second.txUsd, label: second.txUsd <= 0.15 ? 'low-fee chain' : 'secondary chain' } : null,
  };
}

function formatUsdCompact(n: number): string {
  if (n < 1) return `$${n.toFixed(2)}`;
  if (n < 10) return `$${n.toFixed(2).replace(/\.00$/, '')}`;
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

function selectCapitalUsd(tvlUsd: number, txGasUsd: number): number {
  let cap = 100;
  if (tvlUsd >= 1_000_000_000) cap = 500;
  else if (tvlUsd >= 250_000_000) cap = 300;
  else if (tvlUsd >= 50_000_000) cap = 200;
  else if (tvlUsd >= 15_000_000) cap = 125;
  else cap = 75;
  // On expensive L1s, size up slightly so gas stays under ~3% of principal.
  if (txGasUsd >= 3.0 && cap < 400) cap = 400;
  return cap;
}

function selectHoldDays(ageDays: number | null, change7d: number | null): number {
  const base = ageDays === null ? 45 : ageDays < 120 ? 75 : ageDays < 300 ? 60 : ageDays < 700 ? 45 : 30;
  if (change7d !== null && change7d >= 15) return Math.min(90, base + 15);
  return base;
}

function buildCategoryActions(
  p: SnapshotProtocol,
  cat: string,
  capital: number,
  primary: ChainGasInfo,
  secondary: ChainGasInfo | null,
  holdDays: number,
): { entry: FarmStepDetail; weekly: FarmStepDetail; riskTier: 'Low' | 'Moderate' | 'Active' } {
  const c = cat.toLowerCase();
  const ch = primary.chain;
  const setupGas = round2(primary.txUsd * 2.5);
  const weeklyGas = round2(primary.txUsd * 1.2);
  const secNote = secondary ? ` (or split 70/30 with ${secondary.chain})` : '';

  if (c.includes('risk curator') || c.includes('allocator') || c.includes('liquidity manager')) {
    return {
      riskTier: 'Low',
      entry: {
        phase: 'Core Deposit',
        action: `Deposit $${capital} of USDC or blue-chip collateral into ${p.name}'s flagship curated vault on ${ch}${secNote} and retain the vault share tokens.`,
        cost: `$${capital} principal + ~${formatUsdCompact(setupGas)} gas (approve + deposit)`,
        time: '12 minutes setup',
      },
      weekly: {
        phase: 'Recurring Activity',
        action: `Top up $15–$25 or rebalance across a second ${p.name} vault tier every 14 days to log multi-epoch TVL weight without resetting hold multipliers.`,
        cost: `~${formatUsdCompact(weeklyGas)} gas per bi-weekly tx`,
        time: '8 minutes every 2 weeks',
      },
    };
  }
  if (c.includes('rwa') || c.includes('stable') || c.includes('anchor') || c.includes('decentralized btc')) {
    return {
      riskTier: 'Low',
      entry: {
        phase: 'Mint & Hold',
        action: `Mint or subscribe $${capital} into ${p.name}'s yield-bearing RWA or synthetic asset on ${ch}${secNote} and keep the receipt token in your farming wallet.`,
        cost: `$${capital} principal + ~${formatUsdCompact(setupGas)} gas (plus 0–0.1% mint spread)`,
        time: '15 minutes setup',
      },
      weekly: {
        phase: 'Ecosystem Utility',
        action: `Deploy 30% of the ${p.name} receipt token as lending collateral or in a low-slippage stable pool on ${ch} once every 2 weeks to prove organic composability.`,
        cost: `~${formatUsdCompact(round2(primary.txUsd * 2))} gas per cycle`,
        time: '10 minutes every 2 weeks',
      },
    };
  }
  if (c.includes('dex') || c.includes('farm')) {
    return {
      riskTier: 'Moderate',
      entry: {
        phase: 'Liquidity & Volume',
        action: `Provide $${capital} in a correlated or blue-chip LP range on ${p.name} (${ch}${secNote}) and execute two organic spot swaps ($25–$50 each) to register trader + LP activity.`,
        cost: `$${capital} LP capital + ~${formatUsdCompact(round2(setupGas + 0.30))} gas & 0.05–0.30% swap fees`,
        time: '15 minutes setup',
      },
      weekly: {
        phase: 'Weekly Volume',
        action: `Run 2–3 distinct-day swaps ($25–$50) and harvest or compound LP fees on ${p.name} each week to build consistent weekly volume across ${holdDays} days.`,
        cost: `~${formatUsdCompact(round2(weeklyGas * 2 + 0.25))} gas + swap fees per week`,
        time: '10 minutes per week',
      },
    };
  }
  if (c.includes('lending') || c.includes('cdp') || c.includes('collateral')) {
    return {
      riskTier: 'Moderate',
      entry: {
        phase: 'Supply & Conservative Borrow',
        action: `Supply $${capital} of USDC/ETH collateral on ${p.name} (${ch}${secNote}) and borrow 20–25% against it (keeping health factor > 2.5) to qualify for both lender and borrower buckets.`,
        cost: `$${capital} collateral + ~${formatUsdCompact(round2(primary.txUsd * 3))} gas + ~1–4% net borrow spread`,
        time: '15 minutes setup',
      },
      weekly: {
        phase: 'Health & Repay Cycle',
        action: `Check health factor weekly and execute one small supply top-up or partial repayment ($10–$20) every 14 days so on-chain credit history spans multiple snapshots.`,
        cost: `~${formatUsdCompact(weeklyGas)} gas per bi-weekly adjustment`,
        time: '8 minutes per week',
      },
    };
  }
  if (c.includes('derivative') || c.includes('basis') || c.includes('prediction')) {
    return {
      riskTier: 'Active',
      entry: {
        phase: 'Margin & Delta-Neutral Trade',
        action: `Deposit $${capital} USDC margin into ${p.name} on ${ch}${secNote} and open a low-leverage (1x–2x) hedged position or market order to generate verified fee/volume points.`,
        cost: `$${capital} margin + ~${formatUsdCompact(round2(setupGas + 0.60))} gas & taker/maker fees`,
        time: '20 minutes setup',
      },
      weekly: {
        phase: 'Epoch Volume',
        action: `Execute 2 small hedged trades per week ($50–$100 notional) and keep net funding exposure near zero so fees stay predictable across the ${holdDays}-day window.`,
        cost: `~${formatUsdCompact(round2(weeklyGas * 2 + 0.40))} gas + trading fees per week`,
        time: '12 minutes per week',
      },
    };
  }
  if (c.includes('restak') || c.includes('staking')) {
    return {
      riskTier: 'Low',
      entry: {
        phase: 'Stake & Delegate',
        action: `Deposit $${capital} of eligible staking collateral into ${p.name} on ${ch}${secNote} and delegate to an active operator set so epoch points accrue continuously.`,
        cost: `$${capital} staked principal + ~${formatUsdCompact(round2(primary.txUsd * 2.5))} gas`,
        time: '15 minutes setup',
      },
      weekly: {
        phase: 'Epoch Monitoring',
        action: `Verify operator uptime and restaking points weekly; avoid early unbonding since cooldowns typically take 7–14 days and reset loyalty streaks.`,
        cost: `$0 monitoring (only ~${formatUsdCompact(primary.txUsd)} if re-delegating)`,
        time: '5 minutes per week',
      },
    };
  }
  if (c.includes('payment') || c.includes('card')) {
    return {
      riskTier: 'Low',
      entry: {
        phase: 'Channel / Account Funding',
        action: `Fund $${capital} into ${p.name} on ${ch} and complete two real payment transfers or settlement routes to establish active sender/receiver history.`,
        cost: `$${capital} float + ~${formatUsdCompact(round2(primary.txUsd * 2))} routing/network fees`,
        time: '15 minutes setup',
      },
      weekly: {
        phase: 'Recurring Settlements',
        action: `Route 1–2 small transfers ($15–$30) per week across distinct days on ${p.name} to accumulate consistent payment count and duration.`,
        cost: `~${formatUsdCompact(round2(primary.txUsd * 1.5))} fees per week`,
        time: '8 minutes per week',
      },
    };
  }
  if (c.includes('yield') || c.includes('index') || c.includes('insurance') || c.includes('governance') || c.includes('cedefi') || c.includes('chain')) {
    return {
      riskTier: 'Low',
      entry: {
        phase: 'Vault / Ecosystem Entry',
        action: `Deposit $${capital} of USDC or native gas asset into ${p.name}'s core ${cat.toLowerCase()} contract on ${ch}${secNote} and keep the position unstaked-free.`,
        cost: `$${capital} principal + ~${formatUsdCompact(setupGas)} gas`,
        time: '15 minutes setup',
      },
      weekly: {
        phase: 'Epoch Activity',
        action: `Log one qualifying on-chain interaction (small top-up, reward claim, or governance/gauge vote) every 7–14 days on ${ch}.`,
        cost: `~${formatUsdCompact(weeklyGas)} gas per cycle`,
        time: '8 minutes per week',
      },
    };
  }

  return {
    riskTier: 'Low',
    entry: {
      phase: 'Initial Position',
      action: `Deposit $${capital} of USDC into ${p.name}'s primary contract on ${ch}${secNote} and keep the receipt balance untouched.`,
      cost: `$${capital} principal + ~${formatUsdCompact(setupGas)} gas`,
      time: '15 minutes setup',
    },
    weekly: {
      phase: 'Weekly Cadence',
      action: `Perform one organic on-chain action (top-up, swap, or claim) every week on ${ch} to demonstrate active multi-week usage.`,
      cost: `~${formatUsdCompact(weeklyGas)} gas per week`,
      time: '10 minutes per week',
    },
  };
}

export function buildFarmPlan(
  p: SnapshotProtocol,
  ageDays: number | null,
): { summary: FarmSummary; steps: FarmStepDetail[]; stepStrings: string[] } {
  const cat = p.category ?? 'DeFi Protocol';
  const { primary, secondary } = chooseBestChains(p.chains);
  const capital = selectCapitalUsd(p.tvl_usd, primary.txUsd);
  const holdDays = selectHoldDays(ageDays, p.change_7d);
  const weeks = Math.max(4, Math.round(holdDays / 7));
  const { entry, weekly, riskTier } = buildCategoryActions(p, cat, capital, primary, secondary, holdDays);

  const setupGas = round2(primary.txUsd * 3.5);
  const ongoingGas = round2(primary.txUsd * 1.5 * Math.ceil(weeks / 2));
  const exitGas = round2(primary.txUsd * 2.0);
  const estTotalGas = round2(setupGas + ongoingGas + exitGas);

  const steps: FarmStepDetail[] = [
    {
      phase: '1. Wallet & Funding',
      action: `Bridge or withdraw $${capital} plus a ${formatUsdCompact(Math.max(5, Math.ceil(estTotalGas * 2)))} gas buffer onto ${primary.chain} (${primary.label}) in a dedicated non-custodial wallet with clean history.`,
      cost: `~${formatUsdCompact(round2(primary.txUsd * 1.5 + 1.0))} bridge/withdrawal fee`,
      time: '8 minutes',
    },
    {
      phase: `2. ${entry.phase}`,
      action: entry.action,
      cost: entry.cost,
      time: entry.time,
    },
    {
      phase: `3. ${weekly.phase}`,
      action: weekly.action,
      cost: weekly.cost,
      time: weekly.time,
    },
  ];

  if (secondary) {
    steps.push({
      phase: '4. Cross-Chain Footprint',
      action: `Mirror a smaller $${Math.max(25, Math.round(capital * 0.25))} position on ${secondary.chain} (${p.chains.length} chains supported) so multi-chain snapshot filters credit full ecosystem breadth.`,
      cost: `$${Math.max(25, Math.round(capital * 0.25))} principal + ~${formatUsdCompact(round2(secondary.txUsd * 2.5))} gas`,
      time: '10 minutes once',
    });
  }

  steps.push({
    phase: `${steps.length + 1}. Hold Through Snapshots`,
    action: `Maintain the ${p.name} position uninterrupted for at least ${holdDays} days (${weeks} weeks) across month-end epochs; withdraw only after verifying points or TGE eligibility on official channels.`,
    cost: `$0 extra (est. total campaign gas ~${formatUsdCompact(estTotalGas)} incl. exit)`,
    time: `${holdDays} days passive hold + 10 min final audit`,
  });

  steps.push({
    phase: `${steps.length + 1}. Risk & Ledger Hygiene`,
    action: `Revoke unlimited token approvals after setup, bookmark official contract addresses on ${primary.chain}, and log deposit tx hashes and timestamps for airdrop claim verification.`,
    cost: `~${formatUsdCompact(primary.txUsd)} optional revoke tx`,
    time: '5 minutes',
  });

  const stepStrings = steps.map((s) => {
    let line = `${s.phase}: ${s.action} Cost: ${s.cost}. Time: ${s.time}.`;
    if (line.length > 595) line = `${line.slice(0, 591)}...`;
    return line;
  });

  return {
    summary: {
      primary_chain: primary.chain,
      secondary_chain: secondary ? secondary.chain : null,
      capital_usd: capital,
      tx_gas_usd: primary.txUsd,
      est_total_gas_usd: estTotalGas,
      hold_days: holdDays,
      setup_minutes: secondary ? 38 : 28,
      weekly_minutes: riskTier === 'Active' ? 12 : 8,
      risk_tier: riskTier,
    },
    steps,
    stepStrings,
  };
}

export function buildRadarDataset(snapshot: Snapshot, params: ModelParams = DEFAULT_PARAMS): RadarDataset {
  const { globalMedian, globalP25, globalP75, byCategory, liveComps } = calibratePeerMultiples(snapshot, params);
  const bySlug = new Map<string, SnapshotProtocol>(snapshot.protocols.map((p) => [p.slug, p]));
  const wlSet = new Set(snapshot.watchlist);

  const selected = new Map<string, { protocol: SnapshotProtocol; tier: 'watchlist' | 'early' }>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p) selected.set(slug, { protocol: p, tier: 'watchlist' });
  }

  const earlyCandidates = snapshot.protocols
    .filter((p) => !selected.has(p.slug) && isCleanEarlyCandidate(p, snapshot.floor_usd))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));

  for (const p of earlyCandidates) {
    selected.set(p.slug, { protocol: p, tier: 'early' });
  }

  // Fallback safety: if a future snapshot had fewer than 100 clean candidates, top up with pre-token non-CEX protocols.
  if (selected.size < 100) {
    const extra = snapshot.protocols
      .filter((p) => !selected.has(p.slug) && recordsNoToken(p) && p.category !== 'CEX')
      .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1));
    for (const p of extra) {
      selected.set(p.slug, { protocol: p, tier: 'early' });
      if (selected.size >= 120) break;
    }
  }

  const prelim = [...selected.values()].map(({ protocol: p, tier }) => {
    const cat = p.category ?? 'Uncategorized';
    const sec = byCategory.get(cat);
    const sectorMult = sec ? sec.shrunk_multiple : round4(clamp(globalMedian, params.sector_mult_min, params.sector_mult_max));
    const peerCount = sec ? sec.peer_count : 0;

    const age = computeAgeDays(snapshot.as_of, p.listed_at);
    const rawGrowth = p.change_7d ?? 0;
    const clampedGrowth = round2(clamp(rawGrowth, params.growth_floor_pct, params.growth_cap_pct));
    const growthMult = 1 + (clampedGrowth / 100) * params.growth_weight;
    const ageEff = age ?? params.unknown_age_days;
    const maturityMult = params.maturity_floor + (clamp(ageEff, 0, params.maturity_cap_days) / params.maturity_cap_days) * params.maturity_span;
    const extraChains = clamp(Math.max(p.chains.length - 1, 0), 0, params.chain_max_extra);
    const chainMult = 1 + extraChains * params.chain_step;

    const combinedMult = sectorMult * growthMult * maturityMult * chainMult;
    const implied = Math.max(1, Math.round(p.tvl_usd * combinedMult));

    const bandLoMult = (sec ? sec.p25 : globalP25) * growthMult * maturityMult * chainMult;
    const bandHiMult = (sec ? sec.p75 : globalP75) * growthMult * maturityMult * chainMult;
    const lowUsd = Math.max(1, Math.min(implied, Math.round(p.tvl_usd * Math.max(0.05, bandLoMult))));
    const highUsd = Math.max(implied, Math.round(p.tvl_usd * Math.min(2.2, Math.max(combinedMult * 1.18, bandHiMult))));

    const farm = buildFarmPlan(p, age);

    return {
      protocol: p,
      tier,
      cat,
      age,
      implied,
      valuation: {
        sector_multiple: round4(sectorMult),
        sector_peer_count: peerCount,
        global_median_multiple: globalMedian,
        growth_pct_clamped: clampedGrowth,
        growth_mult: round4(growthMult),
        maturity_mult: round4(maturityMult),
        chain_mult: round4(chainMult),
        effective_multiple: round4(implied / Math.max(1, p.tvl_usd)),
        low_usd: lowUsd,
        high_usd: highUsd,
      },
      farm,
    };
  });

  prelim.sort((a, b) => b.implied - a.implied || b.protocol.tvl_usd - a.protocol.tvl_usd || (a.protocol.slug < b.protocol.slug ? -1 : 1));

  const rows: BoardRow[] = prelim.map((item, idx) => ({
    rank: idx + 1,
    slug: item.protocol.slug,
    name: item.protocol.name,
    category: item.cat,
    chains: item.protocol.chains,
    tier: wlSet.has(item.protocol.slug) ? 'watchlist' : item.tier,
    tvl_usd: item.protocol.tvl_usd,
    change_7d: item.protocol.change_7d,
    mcap_usd: item.protocol.mcap_usd,
    listed_at: item.protocol.listed_at,
    age_days: item.age,
    gecko_id: item.protocol.gecko_id,
    symbol: item.protocol.symbol,
    token_status: 'no_token_recorded',
    implied_value_usd: item.implied,
    valuation: item.valuation,
    farm_summary: item.farm.summary,
    farm_plan: item.farm.steps,
    farm_steps: item.farm.stepStrings,
  }));

  const sectorMultiples = [...byCategory.values()].sort(
    (a, b) => b.peer_count - a.peer_count || b.shrunk_multiple - a.shrunk_multiple || (a.category < b.category ? -1 : 1),
  );

  const totalTvl = rows.reduce((acc, r) => acc + r.tvl_usd, 0);
  const totalImplied = rows.reduce((acc, r) => acc + r.implied_value_usd, 0);
  const wlCount = rows.filter((r) => r.tier === 'watchlist').length;

  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    params,
    global_live_median: globalMedian,
    global_live_p25: globalP25,
    global_live_p75: globalP75,
    counts: {
      snapshot_total: snapshot.protocols.length,
      watchlist_total: wlCount,
      early_total: rows.length - wlCount,
      board_total: rows.length,
      live_comps_total: liveComps.length,
      total_pre_token_tvl_usd: totalTvl,
      total_implied_value_usd: totalImplied,
    },
    sector_multiples: sectorMultiples,
    rows,
    live_comps: liveComps,
  };
}

export function validateBoardGate(rows: BoardRow[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) {
    return `row count ${rows.length} outside [100, 4000]`;
  }
  const validSlugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!validSlugs.has(r.slug)) return `unknown slug ${r.slug}`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (r.rank !== i + 1) return `rank mismatch at index ${i}: got ${r.rank}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `invalid implied_value_usd on ${r.slug}: ${r.implied_value_usd}`;
    }
    if (i > 0 && r.implied_value_usd > rows[i - 1]!.implied_value_usd) {
      return `non-monotonic implied_value_usd at rank ${r.rank}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} has ${r.farm_steps.length} farm_steps`;
    }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has farm_step length ${len}`;
    }
  }
  if (rows[0]!.implied_value_usd === rows[rows.length - 1]!.implied_value_usd) {
    return 'all rows share identical implied_value_usd';
  }
  const missingWl = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missingWl.length > 0) return `missing ${missingWl.length} watchlist slugs: ${missingWl.slice(0, 5).join(', ')}`;
  return null;
}

export function serializeDataScript(dataset: RadarDataset): string {
  return `window.TOKEN_RADAR_DATA = ${JSON.stringify(dataset)};\n`;
}
