// ============================================================================
// ChainSentinel — MEV-Aware Gas Priority Fee Estimator
// ============================================================================
//
// When the agent detects an exploit and triggers emergencyWithdraw, the rescue
// tx must land ASAP — ideally in the very next block. On chains with a public
// mempool (Ethereum, BSC, Polygon), an attacker watching the mempool could
// front-run the rescue with an even higher-gas transaction. Even on Polkadot
// Hub (which has deterministic block ordering and no public mempool), setting
// appropriate fees prevents the rescue from being deprioritized during
// congestion spikes.
//
// Strategy:
//   1. Track a rolling window of recent block base fees and gas utilization.
//   2. Given a threat score (0-100), compute an urgency multiplier:
//      - Score < 60:  1.0x  (normal priority — registry reports)
//      - Score 60-79: 1.5x  (elevated — suspicious activity)
//      - Score 80-89: 2.0x  (high — probable exploit)
//      - Score ≥ 90:  3.0x  (critical — confirmed exploit, max urgency)
//   3. Apply the multiplier to the current base fee to set maxPriorityFeePerGas.
//   4. Set maxFeePerGas = 2 * baseFee + priorityFee (EIP-1559 headroom).
//
// The module exposes a pure `computePriorityFee()` for testing and an
// `estimateGasOverrides()` method that returns ethers.js-compatible overrides.
// ============================================================================

import { ethers } from "ethers";
import { createLogger } from "./logger.js";

const logger = createLogger("gas-priority");

// ─── Types ──────────────────────────────────────────────────────────────────

export interface GasOverrides {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export interface FeeSnapshot {
  blockNumber: number;
  baseFeePerGas: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
}

// ─── Urgency Tiers ──────────────────────────────────────────────────────────

export interface UrgencyTier {
  minScore: number;
  multiplier: number;
  label: string;
}

export const URGENCY_TIERS: UrgencyTier[] = [
  { minScore: 90, multiplier: 3.0, label: "CRITICAL" },
  { minScore: 80, multiplier: 2.0, label: "HIGH" },
  { minScore: 60, multiplier: 1.5, label: "ELEVATED" },
  { minScore: 0,  multiplier: 1.0, label: "NORMAL" },
];

// ─── Minimum priority fee (floor) ──────────────────────────────────────────
// Even at NORMAL urgency, we set a floor of 1 gwei to ensure inclusion.
const MIN_PRIORITY_FEE = ethers.parseUnits("1", "gwei");

// ─── Maximum priority fee (ceiling) ────────────────────────────────────────
// Cap at 50 gwei to prevent accidental gas drain on malfunctioning fee data.
const MAX_PRIORITY_FEE = ethers.parseUnits("50", "gwei");

// ─── Pure Functions (testable) ──────────────────────────────────────────────

/**
 * Determine the urgency tier for a given threat score.
 * Tiers are evaluated highest-first; first match wins.
 */
export function getUrgencyTier(threatScore: number): UrgencyTier {
  for (const tier of URGENCY_TIERS) {
    if (threatScore >= tier.minScore) return tier;
  }
  return URGENCY_TIERS[URGENCY_TIERS.length - 1];
}

/**
 * Compute gas utilization ratio from a block snapshot.
 * Returns a value between 0.0 and 1.0. A ratio above 0.8 indicates
 * high congestion — we should bid more aggressively.
 */
export function computeUtilization(snapshot: FeeSnapshot): number {
  if (snapshot.gasLimit === 0n) return 0;
  return Number((snapshot.gasUsed * 10000n) / snapshot.gasLimit) / 10000;
}

/**
 * Compute the priority fee given a base fee, threat score, and optional
 * congestion ratio.
 *
 * Formula:
 *   basePriority = baseFee * urgencyMultiplier * congestionBoost
 *   priorityFee  = clamp(basePriority, MIN_PRIORITY_FEE, MAX_PRIORITY_FEE)
 *
 * congestionBoost is 1.0 when utilization ≤ 0.5, scaling linearly to 1.5
 * at utilization = 1.0. This ensures we bid more during full blocks.
 */
export function computePriorityFee(
  baseFee: bigint,
  threatScore: number,
  utilization: number = 0.5
): bigint {
  const tier = getUrgencyTier(threatScore);

  // Congestion boost: linear from 1.0 at ≤50% utilization to 1.5 at 100%
  const congestionBoost = utilization <= 0.5
    ? 1.0
    : 1.0 + (utilization - 0.5) * 1.0; // 0.5→1.0, 0.75→1.25, 1.0→1.5

  // Compute raw priority fee as a fraction of the base fee
  // Use integer math: multiply first, then divide
  const multiplied = Number(baseFee) * tier.multiplier * congestionBoost;
  let priorityFee = BigInt(Math.ceil(multiplied));

  // Clamp to [MIN, MAX]
  if (priorityFee < MIN_PRIORITY_FEE) priorityFee = MIN_PRIORITY_FEE;
  if (priorityFee > MAX_PRIORITY_FEE) priorityFee = MAX_PRIORITY_FEE;

  return priorityFee;
}

/**
 * Compute the full EIP-1559 gas overrides.
 *
 * maxFeePerGas is set to 2 * baseFee + priorityFee, following the standard
 * EIP-1559 recommendation. This gives headroom for up to one block of base
 * fee doubling without the transaction becoming unexecutable.
 */
export function computeGasOverrides(
  baseFee: bigint,
  threatScore: number,
  utilization: number = 0.5
): GasOverrides {
  const priorityFee = computePriorityFee(baseFee, threatScore, utilization);
  const maxFee = baseFee * 2n + priorityFee;

  return {
    maxFeePerGas: maxFee,
    maxPriorityFeePerGas: priorityFee,
  };
}

// ─── GasPriorityEstimator (stateful, tracks recent blocks) ──────────────────

const FEE_WINDOW_SIZE = 10; // track last 10 blocks

export class GasPriorityEstimator {
  private provider: ethers.JsonRpcProvider;
  private recentFees: FeeSnapshot[] = [];

  constructor(provider: ethers.JsonRpcProvider) {
    this.provider = provider;
  }

  /**
   * Record a block's fee data. Called from the monitor on each new block.
   * Maintains a rolling window of the last 10 blocks.
   */
  recordBlock(snapshot: FeeSnapshot): void {
    this.recentFees.push(snapshot);
    if (this.recentFees.length > FEE_WINDOW_SIZE) {
      this.recentFees.shift();
    }
  }

  /**
   * Get the current median base fee from the rolling window.
   * Falls back to fetching from the provider if no blocks recorded yet.
   */
  getMedianBaseFee(): bigint {
    if (this.recentFees.length === 0) return 0n;

    const fees = this.recentFees.map((s) => s.baseFeePerGas).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    return fees[Math.floor(fees.length / 2)];
  }

  /**
   * Get the average gas utilization across the rolling window.
   */
  getAvgUtilization(): number {
    if (this.recentFees.length === 0) return 0.5;

    const total = this.recentFees.reduce(
      (sum, s) => sum + computeUtilization(s),
      0
    );
    return total / this.recentFees.length;
  }

  /**
   * Estimate gas overrides for a transaction based on the current network
   * state and the threat score that triggered it.
   *
   * Falls back to provider.getFeeData() if no blocks have been recorded.
   */
  async estimateGasOverrides(threatScore: number): Promise<GasOverrides> {
    let baseFee = this.getMedianBaseFee();
    let utilization = this.getAvgUtilization();

    // Fallback: if no block data, query the provider directly
    if (baseFee === 0n) {
      try {
        const feeData = await this.provider.getFeeData();
        baseFee = feeData.gasPrice ?? ethers.parseUnits("1", "gwei");
      } catch {
        baseFee = ethers.parseUnits("1", "gwei"); // absolute fallback
      }
    }

    const overrides = computeGasOverrides(baseFee, threatScore, utilization);

    const tier = getUrgencyTier(threatScore);
    logger.info(
      `Gas estimate: score=${threatScore} urgency=${tier.label} ` +
      `baseFee=${ethers.formatUnits(baseFee, "gwei")}gwei ` +
      `utilization=${(utilization * 100).toFixed(1)}% ` +
      `priorityFee=${ethers.formatUnits(overrides.maxPriorityFeePerGas, "gwei")}gwei ` +
      `maxFee=${ethers.formatUnits(overrides.maxFeePerGas, "gwei")}gwei`
    );

    return overrides;
  }

  /**
   * Get diagnostics about the fee tracker state.
   */
  getStatus(): {
    trackedBlocks: number;
    medianBaseFee: string;
    avgUtilization: string;
  } {
    return {
      trackedBlocks: this.recentFees.length,
      medianBaseFee: `${ethers.formatUnits(this.getMedianBaseFee(), "gwei")} gwei`,
      avgUtilization: `${(this.getAvgUtilization() * 100).toFixed(1)}%`,
    };
  }
}
