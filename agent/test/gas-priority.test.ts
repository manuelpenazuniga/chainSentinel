import { describe, it, expect } from "vitest";
import {
  getUrgencyTier,
  computeUtilization,
  computePriorityFee,
  computeGasOverrides,
  URGENCY_TIERS,
  type FeeSnapshot,
} from "../src/gas-priority.js";
import { ethers } from "ethers";

// ─── Helpers ────────────────────────────────────────────────────────────────

const ONE_GWEI = ethers.parseUnits("1", "gwei");
const TEN_GWEI = ethers.parseUnits("10", "gwei");

function createSnapshot(overrides: Partial<FeeSnapshot> = {}): FeeSnapshot {
  return {
    blockNumber: 1000,
    baseFeePerGas: TEN_GWEI,
    gasUsed: 5_000_000n,
    gasLimit: 10_000_000n, // 50% utilization
    ...overrides,
  };
}

// ─── getUrgencyTier ─────────────────────────────────────────────────────────

describe("getUrgencyTier", () => {
  it("returns CRITICAL for score >= 90", () => {
    expect(getUrgencyTier(90).label).toBe("CRITICAL");
    expect(getUrgencyTier(100).label).toBe("CRITICAL");
    expect(getUrgencyTier(95).multiplier).toBe(3.0);
  });

  it("returns HIGH for score 80-89", () => {
    expect(getUrgencyTier(80).label).toBe("HIGH");
    expect(getUrgencyTier(89).label).toBe("HIGH");
    expect(getUrgencyTier(85).multiplier).toBe(2.0);
  });

  it("returns ELEVATED for score 60-79", () => {
    expect(getUrgencyTier(60).label).toBe("ELEVATED");
    expect(getUrgencyTier(79).label).toBe("ELEVATED");
    expect(getUrgencyTier(70).multiplier).toBe(1.5);
  });

  it("returns NORMAL for score < 60", () => {
    expect(getUrgencyTier(0).label).toBe("NORMAL");
    expect(getUrgencyTier(59).label).toBe("NORMAL");
    expect(getUrgencyTier(30).multiplier).toBe(1.0);
  });
});

// ─── computeUtilization ─────────────────────────────────────────────────────

describe("computeUtilization", () => {
  it("returns 0.5 for 50% gas used", () => {
    const snapshot = createSnapshot({ gasUsed: 5_000_000n, gasLimit: 10_000_000n });
    expect(computeUtilization(snapshot)).toBe(0.5);
  });

  it("returns 1.0 for full blocks", () => {
    const snapshot = createSnapshot({ gasUsed: 10_000_000n, gasLimit: 10_000_000n });
    expect(computeUtilization(snapshot)).toBe(1.0);
  });

  it("returns 0 for empty blocks", () => {
    const snapshot = createSnapshot({ gasUsed: 0n, gasLimit: 10_000_000n });
    expect(computeUtilization(snapshot)).toBe(0);
  });

  it("returns 0 if gasLimit is 0 (edge case)", () => {
    const snapshot = createSnapshot({ gasUsed: 0n, gasLimit: 0n });
    expect(computeUtilization(snapshot)).toBe(0);
  });
});

// ─── computePriorityFee ─────────────────────────────────────────────────────

describe("computePriorityFee", () => {
  it("applies 1.0x multiplier for NORMAL urgency", () => {
    const fee = computePriorityFee(TEN_GWEI, 30, 0.5);
    // 10 gwei * 1.0 * 1.0 (congestion boost at 0.5 util) = 10 gwei
    expect(fee).toBe(TEN_GWEI);
  });

  it("applies 3.0x multiplier for CRITICAL urgency", () => {
    const fee = computePriorityFee(TEN_GWEI, 95, 0.5);
    // 10 gwei * 3.0 * 1.0 = 30 gwei
    expect(fee).toBe(ethers.parseUnits("30", "gwei"));
  });

  it("applies congestion boost at high utilization", () => {
    const fee = computePriorityFee(TEN_GWEI, 30, 1.0);
    // 10 gwei * 1.0 * 1.5 (congestion at 100%) = 15 gwei
    expect(fee).toBe(ethers.parseUnits("15", "gwei"));
  });

  it("no congestion boost at low utilization", () => {
    const feeAt20 = computePriorityFee(TEN_GWEI, 30, 0.2);
    const feeAt50 = computePriorityFee(TEN_GWEI, 30, 0.5);
    // Both should be the same — congestion boost only starts above 50%
    expect(feeAt20).toBe(feeAt50);
  });

  it("respects minimum floor of 1 gwei", () => {
    // Very low base fee
    const fee = computePriorityFee(100n, 30, 0.0);
    expect(fee).toBe(ONE_GWEI);
  });

  it("respects maximum ceiling of 50 gwei", () => {
    // Very high base fee + critical urgency + full congestion
    const highBaseFee = ethers.parseUnits("100", "gwei");
    const fee = computePriorityFee(highBaseFee, 95, 1.0);
    // 100 gwei * 3.0 * 1.5 = 450 gwei → capped at 50 gwei
    expect(fee).toBe(ethers.parseUnits("50", "gwei"));
  });

  it("combines urgency and congestion multiplicatively", () => {
    const fee = computePriorityFee(TEN_GWEI, 85, 0.75);
    // 10 gwei * 2.0 (HIGH) * 1.25 (congestion: 1.0 + (0.75-0.5)*1.0) = 25 gwei
    expect(fee).toBe(ethers.parseUnits("25", "gwei"));
  });
});

// ─── computeGasOverrides ────────────────────────────────────────────────────

describe("computeGasOverrides", () => {
  it("sets maxFeePerGas = 2 * baseFee + priorityFee", () => {
    const overrides = computeGasOverrides(TEN_GWEI, 30, 0.5);
    // priority = 10 gwei, maxFee = 2*10 + 10 = 30 gwei
    expect(overrides.maxPriorityFeePerGas).toBe(TEN_GWEI);
    expect(overrides.maxFeePerGas).toBe(ethers.parseUnits("30", "gwei"));
  });

  it("critical urgency produces higher maxFee", () => {
    const normal = computeGasOverrides(TEN_GWEI, 30, 0.5);
    const critical = computeGasOverrides(TEN_GWEI, 95, 0.5);
    expect(critical.maxFeePerGas).toBeGreaterThan(normal.maxFeePerGas);
    expect(critical.maxPriorityFeePerGas).toBeGreaterThan(normal.maxPriorityFeePerGas);
  });

  it("returns valid overrides for zero base fee", () => {
    const overrides = computeGasOverrides(0n, 95, 0.5);
    // Priority fee floors at 1 gwei, maxFee = 2*0 + 1 gwei = 1 gwei
    expect(overrides.maxPriorityFeePerGas).toBe(ONE_GWEI);
    expect(overrides.maxFeePerGas).toBe(ONE_GWEI);
  });
});

// ─── Urgency tier ordering ─────────────────────────────────────────────────

describe("URGENCY_TIERS", () => {
  it("is sorted highest-first", () => {
    for (let i = 1; i < URGENCY_TIERS.length; i++) {
      expect(URGENCY_TIERS[i - 1].minScore).toBeGreaterThan(URGENCY_TIERS[i].minScore);
    }
  });

  it("multipliers increase with score", () => {
    for (let i = 1; i < URGENCY_TIERS.length; i++) {
      expect(URGENCY_TIERS[i - 1].multiplier).toBeGreaterThan(URGENCY_TIERS[i].multiplier);
    }
  });
});
