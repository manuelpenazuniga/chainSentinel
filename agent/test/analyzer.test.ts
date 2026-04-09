// ============================================================================
// ChainSentinel — Analyzer Unit Tests
// ============================================================================
//
// Coverage for the dual-layer orchestrator (analyzer.ts):
//
//   Part 1 — computeFinalScore (pure function, no mocks)
//     Case A: LLM > heuristic — LLM can raise score; heuristic is the floor
//       • confidence=100 → result equals LLM score
//       • confidence=80  → weighted blend, heuristic floor still applied
//       • confidence=0   → LLM has no pull; result equals heuristic floor
//     Case B: LLM ≤ heuristic — heuristics dominate (70/30 blend)
//       • high confidence (≥50%) → base blend
//       • low confidence (<50%)  → score pulled further toward heuristic
//       • equal scores           → treated as Case B (condition is strictly >)
//     Boundary conditions
//       • clamp to 100 enforced
//       • both inputs 0
//
//   Part 2 — analyzeTransaction (mocked heuristics + LLM)
//     • score=0 fast path  → NORMAL, LLM never invoked
//     • below threshold    → heuristic-only, LLM not called
//     • LLM Case A path    → final score correctly blended upward
//     • LLM Case B path    → final score correctly dominated by heuristics
//     • LLM timeout        → graceful fallback to heuristic-only
//     • LLM invalid JSON   → graceful fallback to heuristic-only
//     • heuristic-only classification boundaries: 0 / 30 / 60 / 80
// ============================================================================

import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock() is hoisted above imports by Vitest's transformer, so the factories
// below run before analyzer.ts resolves its own `import` statements.
vi.mock("../src/heuristics.js");
vi.mock("../src/llm.js");

import { computeFinalScore, analyzeTransaction } from "../src/analyzer.js";
import { calculateHeuristicScore } from "../src/heuristics.js";
import { analyzeThreatWithLLM } from "../src/llm.js";
import type {
  TransactionData,
  MonitorContextInterface,
  AgentConfig,
  HeuristicResult,
  LLMAnalysis,
} from "../src/types.js";

// ─── Shared Fixtures ──────────────────────────────────────────────────────────

const ONE_DOT = 1_000_000_000_000_000_000n; // 1e18 wei

function makeTx(overrides: Partial<TransactionData> = {}): TransactionData {
  return {
    hash: "0xdeadbeef00000000000000000000000000000000000000000000000000000000",
    from: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    to:   "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    value: ONE_DOT.toString(),
    input: "0x",
    gasUsed: "21000",
    blockNumber: 200,
    timestamp: 1700000000,
    functionSelector: "0x",
    decodedFunction: null,
    ...overrides,
  };
}

function makeContext(): MonitorContextInterface {
  return {
    getHistoricalAvgValue: () => ONE_DOT,
    getHistoricalAvgERC20Value: () => 0n,
    getContractAge: () => 100000,
    getRecentTxs: () => [],
    getRecentTxCount: () => 0,
    getSignificantThreshold: () => ONE_DOT,
    hasFlashLoanInteraction: () => false,
    isBlacklisted: () => false,
    isWhitelisted: () => false,
    getBalanceBefore: () => 100n * ONE_DOT,
    getBalanceAfter: () => 100n * ONE_DOT,
    hasPreviousInteraction: () => true,
    getContractLabel: () => null,
    getBalance: () => 100n * ONE_DOT,
    getBalanceChange: () => 0,
  };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    rpcUrl: "http://localhost:8545",
    chainId: 1,
    agentPrivateKey: "0x" + "a".repeat(64),
    vaultAddress: "0x" + "0".repeat(40),
    registryAddress: "0x" + "0".repeat(40),
    geminiApiKey: "test-key",
    heuristicThreshold: 30,
    emergencyThreshold: 80,
    cooldownBlocks: 10,
    llmTimeoutMs: 5000,
    ...overrides,
  };
}

function makeHeuristicResult(
  score: number,
  rules: string[] = [],
  correlationBonus = 0
): HeuristicResult {
  return { score, triggeredRules: rules, details: [], correlationBonus };
}

function makeLLMAnalysis(threatScore: number, confidence: number): LLMAnalysis {
  const classification =
    threatScore >= 80 ? "CRITICAL_THREAT"
    : threatScore >= 65 ? "PROBABLE_THREAT"
    : threatScore >= 40 ? "SUSPICIOUS"
    : "NORMAL";
  const recommendedAction =
    threatScore >= 80 ? "EMERGENCY_WITHDRAW"
    : threatScore >= 65 ? "ALERT"
    : threatScore >= 40 ? "MONITOR"
    : "NONE";
  return {
    threatScore,
    confidence,
    classification,
    attackType: "FLASH_LOAN",
    explanation: "Mock LLM explanation.",
    recommendedAction,
    reasoning: "Step 1: observed flash loan selector. Step 2: balance dropped 95%. Score: high.",
  };
}

// ─── Typed mock references ────────────────────────────────────────────────────

const mockHeuristics = vi.mocked(calculateHeuristicScore);
const mockLLM = vi.mocked(analyzeThreatWithLLM);

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// Part 1 — computeFinalScore
// ============================================================================

describe("computeFinalScore — Case A: LLM > heuristic", () => {
  // Formula: max(heuristic, round(llm × cf + heuristic × (1 − cf)))

  it("confidence=100 → final equals LLM score exactly", () => {
    // cf=1: max(40, round(80*1 + 40*0)) = max(40, 80) = 80
    expect(computeFinalScore(40, 80, 100)).toBe(80);
  });

  it("confidence=80 → weighted blend between heuristic and LLM", () => {
    // cf=0.8: max(40, round(80*0.8 + 40*0.2)) = max(40, round(64+8)) = max(40, 72) = 72
    expect(computeFinalScore(40, 80, 80)).toBe(72);
  });

  it("confidence=50 → midpoint blend", () => {
    // cf=0.5: max(40, round(80*0.5 + 40*0.5)) = max(40, round(60)) = 60
    expect(computeFinalScore(40, 80, 50)).toBe(60);
  });

  it("confidence=0 → heuristic floor; LLM has no influence", () => {
    // cf=0: max(40, round(0 + 40)) = 40 — LLM cannot lower score below heuristic
    expect(computeFinalScore(40, 80, 0)).toBe(40);
  });

  it("heuristic=0, LLM=100, confidence=100 → 100", () => {
    expect(computeFinalScore(0, 100, 100)).toBe(100);
  });

  it("LLM only marginally above heuristic → preserves LLM uplift", () => {
    // h=60, llm=61, cf=1.0 → max(60, 61) = 61
    expect(computeFinalScore(60, 61, 100)).toBe(61);
  });

  it("heuristic floor prevents LLM from reducing the score", () => {
    // h=70, llm=80, cf=0.01 → max(70, round(80*0.01 + 70*0.99))
    //   = max(70, round(0.8 + 69.3)) = max(70, round(70.1)) = max(70, 70) = 70
    expect(computeFinalScore(70, 80, 1)).toBe(70);
  });
});

describe("computeFinalScore — Case B: LLM ≤ heuristic", () => {
  // Formula: base = round(h×0.7 + llm×0.3)
  //          if cf < 0.5: round(h×0.85 + base×0.15)  else: base

  it("high confidence (≥50%) → 70/30 blend of heuristic and LLM", () => {
    // h=70, llm=40, cf=0.8 (≥0.5)
    // base = round(70*0.7 + 40*0.3) = round(49+12) = 61
    expect(computeFinalScore(70, 40, 80)).toBe(61);
  });

  it("low confidence (<50%) → score pulled closer to heuristic baseline", () => {
    // h=70, llm=40, cf=0.4 (<0.5)
    // base = round(49+12) = 61
    // finalScore = round(70*0.85 + 61*0.15) = round(59.5+9.15) = round(68.65) = 69
    expect(computeFinalScore(70, 40, 40)).toBe(69);
  });

  it("confidence=0 → maximal pull toward heuristic", () => {
    // h=80, llm=20, cf=0 (<0.5)
    // base = round(80*0.7 + 20*0.3) = round(56+6) = 62
    // finalScore = round(80*0.85 + 62*0.15) = round(68+9.3) = round(77.3) = 77
    expect(computeFinalScore(80, 20, 0)).toBe(77);
  });

  it("equal scores → Case B (condition is strictly >), result equals inputs", () => {
    // h=50, llm=50, cf=0.8: base = round(50*0.7 + 50*0.3) = 50
    expect(computeFinalScore(50, 50, 80)).toBe(50);
  });

  it("LLM=0 with high heuristic and low confidence", () => {
    // h=60, llm=0, cf=0 (<0.5)
    // base = round(60*0.7 + 0*0.3) = round(42) = 42
    // finalScore = round(60*0.85 + 42*0.15) = round(51+6.3) = round(57.3) = 57
    expect(computeFinalScore(60, 0, 0)).toBe(57);
  });
});

describe("computeFinalScore — boundary conditions", () => {
  it("both inputs 0 → 0", () => {
    expect(computeFinalScore(0, 0, 0)).toBe(0);
    expect(computeFinalScore(0, 0, 100)).toBe(0);
  });

  it("both inputs 100 → 100 (clamp holds)", () => {
    expect(computeFinalScore(100, 100, 100)).toBe(100);
  });

  it("Case A result clamped to 100 when LLM score is 100", () => {
    // h=95, llm=100, cf=100: max(95, 100) = 100 → clamped to 100
    expect(computeFinalScore(95, 100, 100)).toBe(100);
  });

  it("result is always an integer", () => {
    const result = computeFinalScore(33, 71, 67);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("result is always in [0, 100]", () => {
    const cases: [number, number, number][] = [
      [0, 100, 100], [100, 0, 0], [50, 50, 50],
      [1, 99, 1], [99, 1, 99], [37, 63, 42],
    ];
    for (const [h, l, c] of cases) {
      const result = computeFinalScore(h, l, c);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    }
  });
});

// ============================================================================
// Part 2 — analyzeTransaction
// ============================================================================

describe("analyzeTransaction — score=0 fast path", () => {
  it("returns NORMAL immediately without calling the LLM", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(0));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.score).toBe(0);
    expect(result.classification).toBe("NORMAL");
    expect(result.recommendedAction).toBe("NONE");
    expect(result.llmUsed).toBe(false);
    expect(result.llmScore).toBeNull();
    expect(result.llmConfidence).toBeNull();
    expect(result.triggeredRules).toHaveLength(0);
    expect(mockLLM).not.toHaveBeenCalled();
  });
});

describe("analyzeTransaction — below heuristic threshold", () => {
  it("skips LLM when score is below threshold", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(20, ["ANOMALOUS_VALUE"]));

    const result = await analyzeTransaction(
      makeTx(),
      makeContext(),
      makeConfig({ heuristicThreshold: 30 })
    );

    expect(result.llmUsed).toBe(false);
    expect(mockLLM).not.toHaveBeenCalled();
    expect(result.heuristicScore).toBe(20);
    expect(result.score).toBe(20);
  });

  it("score=0 boundary: threshold=1 still takes fast path at 0", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(0));
    await analyzeTransaction(makeTx(), makeContext(), makeConfig({ heuristicThreshold: 1 }));
    expect(mockLLM).not.toHaveBeenCalled();
  });
});

describe("analyzeTransaction — LLM Case A (LLM score > heuristic)", () => {
  it("blends upward correctly and marks llmUsed=true", async () => {
    // h=40, LLM=80 conf=90: cf=0.9
    // Case A: max(40, round(80*0.9 + 40*0.1)) = max(40, round(72+4)) = max(40, 76) = 76
    mockHeuristics.mockReturnValue(makeHeuristicResult(40, ["FRESH_CONTRACT"]));
    mockLLM.mockResolvedValue(makeLLMAnalysis(80, 90));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.llmUsed).toBe(true);
    expect(result.heuristicScore).toBe(40);
    expect(result.llmScore).toBe(80);
    expect(result.llmConfidence).toBe(90);
    expect(result.score).toBe(76);
  });

  it("inherits classification and attackType from LLM, not heuristic engine", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(35, ["FRESH_CONTRACT"]));
    mockLLM.mockResolvedValue(makeLLMAnalysis(85, 95));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.classification).toBe("CRITICAL_THREAT");
    expect(result.attackType).toBe("FLASH_LOAN");
    expect(result.recommendedAction).toBe("EMERGENCY_WITHDRAW");
  });

  it("LLM full confidence: final score equals LLM score", async () => {
    // h=30, LLM=75, conf=100: max(30, round(75*1 + 30*0)) = 75
    mockHeuristics.mockReturnValue(makeHeuristicResult(30, ["UNKNOWN_HIGH_VALUE_SENDER"]));
    mockLLM.mockResolvedValue(makeLLMAnalysis(75, 100));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(result.score).toBe(75);
  });
});

describe("analyzeTransaction — LLM Case B (LLM score ≤ heuristic)", () => {
  it("heuristic dominates when LLM scores lower", async () => {
    // h=70, LLM=40, conf=80: cf=0.8 (≥0.5)
    // base = round(70*0.7 + 40*0.3) = round(49+12) = 61
    mockHeuristics.mockReturnValue(makeHeuristicResult(70, ["DRASTIC_BALANCE_CHANGE", "TX_BURST"]));
    mockLLM.mockResolvedValue(makeLLMAnalysis(40, 80));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.llmUsed).toBe(true);
    expect(result.heuristicScore).toBe(70);
    expect(result.llmScore).toBe(40);
    expect(result.score).toBe(61);
  });

  it("low LLM confidence pulls result further toward heuristic", async () => {
    // h=70, LLM=40, conf=30: cf=0.3 (<0.5)
    // base = 61 (same as above)
    // finalScore = round(70*0.85 + 61*0.15) = round(59.5+9.15) = 69
    mockHeuristics.mockReturnValue(makeHeuristicResult(70, ["BLACKLISTED_ENTITY"]));
    mockLLM.mockResolvedValue(makeLLMAnalysis(40, 30));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(result.score).toBe(69);
  });

  it("equal LLM and heuristic scores blend to same value", async () => {
    // h=50, LLM=50, conf=80: base = round(50*0.7 + 50*0.3) = 50
    mockHeuristics.mockReturnValue(makeHeuristicResult(50, ["ANOMALOUS_VALUE"]));
    mockLLM.mockResolvedValue(makeLLMAnalysis(50, 80));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(result.score).toBe(50);
  });
});

describe("analyzeTransaction — LLM failure fallback", () => {
  it("falls back to heuristic-only on AbortError (timeout)", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(55, ["FLASH_LOAN_PATTERN"]));
    const abortError = Object.assign(new Error("Request timed out"), { name: "AbortError" });
    mockLLM.mockRejectedValue(abortError);

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.llmUsed).toBe(false);
    expect(result.llmScore).toBeNull();
    expect(result.llmConfidence).toBeNull();
    // Score equals heuristic score, not blended
    expect(result.score).toBe(55);
    // Classification from heuristic thresholds: 55 >= 30 → SUSPICIOUS
    expect(result.classification).toBe("SUSPICIOUS");
    expect(result.recommendedAction).toBe("MONITOR");
  });

  it("falls back to heuristic-only on JSON parse failure", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(65, ["DRASTIC_BALANCE_CHANGE"]));
    mockLLM.mockRejectedValue(new SyntaxError("Unexpected token '<' in JSON"));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.llmUsed).toBe(false);
    expect(result.score).toBe(65);
    // 65 >= 60 → PROBABLE_THREAT
    expect(result.classification).toBe("PROBABLE_THREAT");
    expect(result.recommendedAction).toBe("ALERT");
  });

  it("falls back to heuristic-only on any unexpected error", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(80, ["BLACKLISTED_ENTITY"]));
    mockLLM.mockRejectedValue(new Error("Network error: ECONNREFUSED"));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.llmUsed).toBe(false);
    expect(result.score).toBe(80);
    expect(result.classification).toBe("CRITICAL_THREAT");
    expect(result.recommendedAction).toBe("EMERGENCY_WITHDRAW");
  });

  it("fallback result preserves the original triggered rules", async () => {
    const rules = ["FLASH_LOAN_PATTERN", "DRASTIC_BALANCE_CHANGE"];
    mockHeuristics.mockReturnValue(makeHeuristicResult(60, rules));
    mockLLM.mockRejectedValue(new Error("Gemini API unavailable"));

    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());

    expect(result.triggeredRules).toEqual(rules);
  });
});

describe("analyzeTransaction — heuristic-only classification thresholds", () => {
  // These thresholds apply both for the below-threshold path
  // and for fallback assessments. Test each boundary exactly.

  it("score=29 → NORMAL / NONE", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(29));
    const r = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(r.classification).toBe("NORMAL");
    expect(r.recommendedAction).toBe("NONE");
  });

  it("score=30 → SUSPICIOUS / MONITOR (inclusive boundary)", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(30, ["ANOMALOUS_VALUE"]));
    mockLLM.mockRejectedValue(new Error("timeout")); // force fallback
    const r = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(r.classification).toBe("SUSPICIOUS");
    expect(r.recommendedAction).toBe("MONITOR");
  });

  it("score=59 → SUSPICIOUS / MONITOR", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(59));
    mockLLM.mockRejectedValue(new Error("timeout"));
    const r = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(r.classification).toBe("SUSPICIOUS");
    expect(r.recommendedAction).toBe("MONITOR");
  });

  it("score=60 → PROBABLE_THREAT / ALERT (inclusive boundary)", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(60, ["TX_BURST"]));
    mockLLM.mockRejectedValue(new Error("timeout"));
    const r = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(r.classification).toBe("PROBABLE_THREAT");
    expect(r.recommendedAction).toBe("ALERT");
  });

  it("score=79 → PROBABLE_THREAT / ALERT", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(79));
    mockLLM.mockRejectedValue(new Error("timeout"));
    const r = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(r.classification).toBe("PROBABLE_THREAT");
    expect(r.recommendedAction).toBe("ALERT");
  });

  it("score=80 → CRITICAL_THREAT / EMERGENCY_WITHDRAW (inclusive boundary)", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(80, ["BLACKLISTED_ENTITY"]));
    mockLLM.mockRejectedValue(new Error("timeout"));
    const r = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(r.classification).toBe("CRITICAL_THREAT");
    expect(r.recommendedAction).toBe("EMERGENCY_WITHDRAW");
  });

  it("score=100 → CRITICAL_THREAT / EMERGENCY_WITHDRAW", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(100, ["BLACKLISTED_ENTITY", "FLASH_LOAN_PATTERN"]));
    mockLLM.mockRejectedValue(new Error("timeout"));
    const r = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(r.classification).toBe("CRITICAL_THREAT");
    expect(r.recommendedAction).toBe("EMERGENCY_WITHDRAW");
  });
});

describe("analyzeTransaction — output shape invariants", () => {
  it("always includes the original transaction in the result", async () => {
    const tx = makeTx({ hash: "0xspecialhash" });
    mockHeuristics.mockReturnValue(makeHeuristicResult(0));

    const result = await analyzeTransaction(tx, makeContext(), makeConfig());
    expect(result.transaction.hash).toBe("0xspecialhash");
  });

  it("assessedAt is a recent Unix timestamp in milliseconds", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(0));
    const before = Date.now();
    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    const after = Date.now();

    expect(result.assessedAt).toBeGreaterThanOrEqual(before);
    expect(result.assessedAt).toBeLessThanOrEqual(after);
  });

  it("attackType is UNKNOWN when LLM was not used", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(20));
    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    // Below threshold → heuristic-only. attackType must be UNKNOWN (not NONE),
    // because we cannot classify without LLM context.
    expect(result.attackType).toBe("UNKNOWN");
  });

  it("attackType is NONE when score=0 (no threat at all)", async () => {
    mockHeuristics.mockReturnValue(makeHeuristicResult(0));
    const result = await analyzeTransaction(makeTx(), makeContext(), makeConfig());
    expect(result.attackType).toBe("NONE");
  });
});
