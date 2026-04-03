import { describe, it, expect } from "vitest";
import { calculateHeuristicScore, HEURISTIC_RULES } from "../src/heuristics.js";
import { TransactionData, MonitorContextInterface } from "../src/types.js";

function createMockContext(overrides: Partial<MonitorContextInterface> = {}): MonitorContextInterface {
  return {
    getHistoricalAvgValue: () => 1000000000000000000n, // 1 DOT
    getContractAge: () => 100000, // ~27 hours
    getRecentTxs: () => [],
    getSignificantThreshold: () => 1000000000000000000n, // 1 DOT
    hasFlashLoanInteraction: () => false,
    isBlacklisted: () => false,
    isWhitelisted: () => false,
    getBalanceBefore: () => 100000000000000000000n, // 100 DOT
    getBalanceAfter: () => 100000000000000000000n, // 100 DOT (no change)
    hasPreviousInteraction: () => true,
    getContractLabel: () => null,
    getBalance: () => 100000000000000000000n,
    getBalanceChange: () => 0,
    getRecentTxCount: () => 0,
    ...overrides,
  };
}

function createMockTx(overrides: Partial<TransactionData> = {}): TransactionData {
  return {
    hash: "0xabc123",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "1000000000000000000", // 1 DOT
    input: "0x",
    gasUsed: "21000",
    blockNumber: 100,
    timestamp: Math.floor(Date.now() / 1000),
    functionSelector: "0x",
    decodedFunction: null,
    ...overrides,
  };
}

describe("Heuristic Engine", () => {
  it("should return score 0 for a normal transaction", () => {
    const tx = createMockTx();
    const ctx = createMockContext();
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBe(0);
    expect(result.triggeredRules).toHaveLength(0);
  });

  it("should trigger ANOMALOUS_VALUE for 10x+ value", () => {
    const tx = createMockTx({ value: "20000000000000000000" }); // 20 DOT
    const ctx = createMockContext();
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("ANOMALOUS_VALUE");
    expect(result.score).toBeGreaterThanOrEqual(35);
  });

  it("should trigger FRESH_CONTRACT for new contracts", () => {
    const tx = createMockTx();
    const ctx = createMockContext({ getContractAge: () => 3600 }); // 1 hour old
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("FRESH_CONTRACT");
  });

  it("should trigger TX_BURST for rapid transactions", () => {
    const tx = createMockTx();
    const ctx = createMockContext({
      getRecentTxs: () => [tx, tx, tx, tx, tx],
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("TX_BURST");
  });

  it("should trigger BLACKLISTED_ENTITY for known bad actors", () => {
    const tx = createMockTx();
    const ctx = createMockContext({ isBlacklisted: (addr) => addr === tx.from });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("BLACKLISTED_ENTITY");
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  it("should trigger FLASH_LOAN_PATTERN for flash loan selectors", () => {
    const tx = createMockTx({ input: "0xab9c4b5d0000000000" });
    const ctx = createMockContext();
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("FLASH_LOAN_PATTERN");
  });

  it("should trigger DRASTIC_BALANCE_CHANGE for large drops", () => {
    const tx = createMockTx();
    const ctx = createMockContext({
      getBalanceBefore: () => 100000000000000000000n, // 100 DOT
      getBalanceAfter: () => 50000000000000000000n,   // 50 DOT (50% drop)
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("DRASTIC_BALANCE_CHANGE");
  });

  it("should cap total score at 100", () => {
    const tx = createMockTx({
      value: "20000000000000000000",
      input: "0xab9c4b5d0000000000",
    });
    const ctx = createMockContext({
      getContractAge: () => 3600,
      isBlacklisted: () => true,
      getRecentTxs: () => Array(5).fill(tx),
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("should have exactly 8 rules", () => {
    expect(HEURISTIC_RULES).toHaveLength(8);
  });

  it("should not alter score when contract is not whitelisted", () => {
    const tx = createMockTx({ value: "20000000000000000000" }); // triggers ANOMALOUS_VALUE (+35)
    const ctx = createMockContext({ isWhitelisted: () => false });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBe(35);
  });

  it("should reduce score by 50% when target contract is whitelisted", () => {
    const tx = createMockTx({ value: "20000000000000000000" }); // triggers ANOMALOUS_VALUE (+35)
    const ctx = createMockContext({ isWhitelisted: () => true });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBe(17); // Math.floor(35 * 0.5)
  });

  it("should still respect cap of 100 after whitelist reduction", () => {
    const tx = createMockTx({
      value: "20000000000000000000",
      input: "0xab9c4b5d0000000000",
    });
    const ctx = createMockContext({
      getContractAge: () => 3600,
      isBlacklisted: () => true,
      isWhitelisted: () => true,
      getRecentTxs: () => Array(5).fill(tx),
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThan(0);
  });
});
