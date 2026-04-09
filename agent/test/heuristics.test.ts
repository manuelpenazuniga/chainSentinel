import { describe, it, expect } from "vitest";
import { calculateHeuristicScore, HEURISTIC_RULES } from "../src/heuristics.js";
import { TransactionData, MonitorContextInterface } from "../src/types.js";

// ─── Test Fixtures ─────────────────────────────────────────────────────────────

const ONE_DOT = 1_000_000_000_000_000_000n; // 1e18 wei

function createMockContext(overrides: Partial<MonitorContextInterface> = {}): MonitorContextInterface {
  return {
    getHistoricalAvgValue: () => ONE_DOT,
    getHistoricalAvgERC20Value: () => 0n,
    getContractAge: () => 100000,            // ~27.8 hours — not fresh
    getRecentTxs: () => [],
    getRecentTxCount: () => 0,
    getSignificantThreshold: () => ONE_DOT,
    hasFlashLoanInteraction: () => false,
    isBlacklisted: () => false,
    isWhitelisted: () => false,
    getBalanceBefore: () => 100n * ONE_DOT,  // 100 DOT
    getBalanceAfter: () => 100n * ONE_DOT,   // no change
    hasPreviousInteraction: () => true,
    getContractLabel: () => null,
    getBalance: () => 100n * ONE_DOT,
    getBalanceChange: () => 0,
    ...overrides,
  };
}

function createMockTx(overrides: Partial<TransactionData> = {}): TransactionData {
  return {
    hash: "0xabc123",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: ONE_DOT.toString(),              // 1 DOT
    input: "0x",
    gasUsed: "21000",
    blockNumber: 100,
    timestamp: Math.floor(Date.now() / 1000),
    functionSelector: "0x",
    decodedFunction: null,
    ...overrides,
  };
}

// Encode a uint256 as 64 hex chars (ABI-style, no 0x prefix)
function encodeUint256(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

// Encode an address as 64 hex chars (ABI-style, no 0x prefix)
function encodeAddress(addr: string): string {
  return addr.replace("0x", "").padStart(64, "0");
}

// ─── Baseline ─────────────────────────────────────────────────────────────────

describe("Heuristic Engine — baseline", () => {
  it("returns score 0 for a fully normal transaction", () => {
    const result = calculateHeuristicScore(createMockTx(), createMockContext());
    expect(result.score).toBe(0);
    expect(result.triggeredRules).toHaveLength(0);
    expect(result.correlationBonus).toBe(0);
  });

  it("exposes exactly 11 rules", () => {
    expect(HEURISTIC_RULES).toHaveLength(11);
  });

  it("includes correlationBonus in every result", () => {
    const result = calculateHeuristicScore(createMockTx(), createMockContext());
    expect(typeof result.correlationBonus).toBe("number");
  });
});

// ─── Individual Rules ─────────────────────────────────────────────────────────

describe("ANOMALOUS_VALUE", () => {
  it("triggers for native value > 10x historical average", () => {
    const tx = createMockTx({ value: (20n * ONE_DOT).toString() }); // 20 DOT — 20x avg of 1 DOT
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).toContain("ANOMALOUS_VALUE");
    expect(result.score).toBeGreaterThanOrEqual(35);
  });

  it("does not trigger when native value is within normal range", () => {
    const tx = createMockTx({ value: (5n * ONE_DOT).toString() }); // 5x — below 10x threshold
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).not.toContain("ANOMALOUS_VALUE");
  });

  it("does not trigger when no historical average exists (avg = 0)", () => {
    const tx = createMockTx({ value: (100n * ONE_DOT).toString() });
    const ctx = createMockContext({ getHistoricalAvgValue: () => 0n });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("ANOMALOUS_VALUE");
  });

  it("triggers for ERC-20 transfer amount > 10x historical ERC-20 average", () => {
    // transfer(address, uint256): selector 0xa9059cbb
    // ABI params: [address(32 bytes)][amount(32 bytes)]
    const amount = 50n * ONE_DOT; // 50 DOT worth of tokens
    const recipient = "0x3333333333333333333333333333333333333333";
    const input = "0xa9059cbb" + encodeAddress(recipient) + encodeUint256(amount);

    const tx = createMockTx({ input, value: "0" });
    const ctx = createMockContext({
      getHistoricalAvgERC20Value: () => 2n * ONE_DOT, // avg 2 DOT — 25x anomaly
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("ANOMALOUS_VALUE");
  });

  it("does not trigger ERC-20 path when amount is within normal range", () => {
    const amount = 3n * ONE_DOT; // 3 DOT — below 10x of 1 DOT average
    const recipient = "0x3333333333333333333333333333333333333333";
    const input = "0xa9059cbb" + encodeAddress(recipient) + encodeUint256(amount);

    const tx = createMockTx({ input, value: "0" });
    const ctx = createMockContext({
      getHistoricalAvgERC20Value: () => ONE_DOT,
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("ANOMALOUS_VALUE");
  });
});

describe("FRESH_CONTRACT", () => {
  it("triggers for contracts less than 24 hours old", () => {
    const ctx = createMockContext({ getContractAge: () => 3600 }); // 1 hour
    const result = calculateHeuristicScore(createMockTx(), ctx);
    expect(result.triggeredRules).toContain("FRESH_CONTRACT");
  });

  it("does not trigger for contracts older than 24 hours", () => {
    const ctx = createMockContext({ getContractAge: () => 90000 }); // 25 hours
    const result = calculateHeuristicScore(createMockTx(), ctx);
    expect(result.triggeredRules).not.toContain("FRESH_CONTRACT");
  });

  it("does not trigger when age is null (unresolved)", () => {
    const ctx = createMockContext({ getContractAge: () => null });
    const result = calculateHeuristicScore(createMockTx(), ctx);
    expect(result.triggeredRules).not.toContain("FRESH_CONTRACT");
  });

  it("does not trigger when age is 0 (older than search window)", () => {
    // age=0 means the binary search hit the window boundary — treat as old
    const ctx = createMockContext({ getContractAge: () => 0 });
    const result = calculateHeuristicScore(createMockTx(), ctx);
    expect(result.triggeredRules).not.toContain("FRESH_CONTRACT");
  });
});

describe("TX_BURST", () => {
  it("triggers when same sender sends 5+ txs in 5 blocks", () => {
    const tx = createMockTx();
    const ctx = createMockContext({ getRecentTxs: () => [tx, tx, tx, tx, tx] });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("TX_BURST");
  });

  it("does not trigger for fewer than 5 recent transactions", () => {
    const tx = createMockTx();
    const ctx = createMockContext({ getRecentTxs: () => [tx, tx, tx, tx] }); // only 4
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("TX_BURST");
  });
});

describe("LARGE_WITHDRAWAL", () => {
  it("triggers when decoded withdraw(uint256) amount > significant threshold", () => {
    // withdraw(uint256): selector 0x2e1a7d4d, amount as first ABI param
    const amount = 10n * ONE_DOT; // 10 DOT
    const input = "0x2e1a7d4d" + encodeUint256(amount);

    const tx = createMockTx({ input, value: "0" });
    const ctx = createMockContext({
      getHistoricalAvgERC20Value: () => 0n,                // no ERC-20 history
      getSignificantThreshold: () => 5n * ONE_DOT,         // threshold: 5 DOT
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("LARGE_WITHDRAWAL");
  });

  it("triggers when decoded ERC-20 transfer amount > 5x ERC-20 average", () => {
    const amount = 30n * ONE_DOT; // 30 DOT worth — 30x avg of 1 DOT
    const recipient = "0x3333333333333333333333333333333333333333";
    const input = "0xa9059cbb" + encodeAddress(recipient) + encodeUint256(amount);

    const tx = createMockTx({ input, value: "0" });
    const ctx = createMockContext({
      getHistoricalAvgERC20Value: () => ONE_DOT,           // avg: 1 DOT
      getSignificantThreshold: () => 100n * ONE_DOT,       // high threshold
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("LARGE_WITHDRAWAL");
  });

  it("triggers when native balance drops >20% (fallback path)", () => {
    // withdraw() with no amount: selector 0x3ccfd60b
    const tx = createMockTx({ input: "0x3ccfd60b", value: "0" });
    const ctx = createMockContext({
      getBalanceBefore: () => 100n * ONE_DOT,
      getBalanceAfter: () => 75n * ONE_DOT,  // 25% drop — above 20% threshold
      getHistoricalAvgERC20Value: () => 0n,
      getSignificantThreshold: () => ONE_DOT,
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("LARGE_WITHDRAWAL");
  });

  it("does not trigger for a small native balance drop (≤20%)", () => {
    const tx = createMockTx({ input: "0x3ccfd60b", value: "0" });
    const ctx = createMockContext({
      getBalanceBefore: () => 100n * ONE_DOT,
      getBalanceAfter: () => 85n * ONE_DOT,  // 15% drop — below threshold
      getHistoricalAvgERC20Value: () => 0n,
      getSignificantThreshold: () => ONE_DOT,
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("LARGE_WITHDRAWAL");
  });

  it("does not trigger for non-withdrawal selectors", () => {
    // Random function call — not a withdrawal
    const tx = createMockTx({ input: "0xdeadbeef00000000" });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).not.toContain("LARGE_WITHDRAWAL");
  });
});

describe("FLASH_LOAN_PATTERN", () => {
  it("triggers on Aave V2 flashLoan selector (0xab9c4b5d)", () => {
    const tx = createMockTx({ input: "0xab9c4b5d" + "00".repeat(100) });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).toContain("FLASH_LOAN_PATTERN");
  });

  it("triggers on ERC-3156 flashLoan selector (0x5cffe9de)", () => {
    const tx = createMockTx({ input: "0x5cffe9de" + "00".repeat(100) });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).toContain("FLASH_LOAN_PATTERN");
  });

  it("triggers when gas > 500K and tx hash is registered as flash loan interaction", () => {
    const tx = createMockTx({ input: "0xdeadbeef00", gasUsed: "600000" });
    const ctx = createMockContext({ hasFlashLoanInteraction: (hash) => hash === tx.hash });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("FLASH_LOAN_PATTERN");
  });

  it("triggers on very high gas alone (>1M) — complex multi-call exploit territory", () => {
    const tx = createMockTx({ input: "0xdeadbeef00", gasUsed: "1500000" });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).toContain("FLASH_LOAN_PATTERN");
  });

  it("does not trigger for normal gas without flash loan indicators", () => {
    const tx = createMockTx({ input: "0xdeadbeef00", gasUsed: "200000" });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).not.toContain("FLASH_LOAN_PATTERN");
  });
});

describe("BLACKLISTED_ENTITY", () => {
  it("triggers when sender is blacklisted", () => {
    const tx = createMockTx();
    const ctx = createMockContext({ isBlacklisted: (addr) => addr === tx.from });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("BLACKLISTED_ENTITY");
    expect(result.score).toBeGreaterThanOrEqual(50);
  });

  it("triggers when target contract is blacklisted", () => {
    const tx = createMockTx();
    const ctx = createMockContext({ isBlacklisted: (addr) => addr === tx.to });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("BLACKLISTED_ENTITY");
  });
});

describe("DRASTIC_BALANCE_CHANGE", () => {
  it("triggers when contract balance drops >30% in one block", () => {
    const ctx = createMockContext({
      getBalanceBefore: () => 100n * ONE_DOT,
      getBalanceAfter: () => 60n * ONE_DOT,   // 40% drop
    });
    const result = calculateHeuristicScore(createMockTx(), ctx);
    expect(result.triggeredRules).toContain("DRASTIC_BALANCE_CHANGE");
  });

  it("does not trigger for drops ≤30%", () => {
    const ctx = createMockContext({
      getBalanceBefore: () => 100n * ONE_DOT,
      getBalanceAfter: () => 75n * ONE_DOT,   // 25% drop
    });
    const result = calculateHeuristicScore(createMockTx(), ctx);
    expect(result.triggeredRules).not.toContain("DRASTIC_BALANCE_CHANGE");
  });

  it("does not trigger when there is no prior balance data", () => {
    const ctx = createMockContext({
      getBalanceBefore: () => 0n,
      getBalanceAfter: () => 0n,
    });
    const result = calculateHeuristicScore(createMockTx(), ctx);
    expect(result.triggeredRules).not.toContain("DRASTIC_BALANCE_CHANGE");
  });
});

describe("UNKNOWN_HIGH_VALUE_SENDER", () => {
  it("triggers for first-time sender with high-value transaction", () => {
    const tx = createMockTx({ value: (5n * ONE_DOT).toString() });
    const ctx = createMockContext({
      hasPreviousInteraction: () => false,
      getSignificantThreshold: () => 2n * ONE_DOT,
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("UNKNOWN_HIGH_VALUE_SENDER");
  });

  it("does not trigger for returning senders", () => {
    const tx = createMockTx({ value: (5n * ONE_DOT).toString() });
    const ctx = createMockContext({
      hasPreviousInteraction: () => true, // returning sender
      getSignificantThreshold: () => 2n * ONE_DOT,
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("UNKNOWN_HIGH_VALUE_SENDER");
  });
});

describe("SANDWICH_PATTERN", () => {
  // Uniswap V2 swapExactTokensForTokens selector
  const SWAP_INPUT = "0x38ed1739" + "00".repeat(160);

  it("triggers when same sender has a prior swap to the same AMM within 2 blocks", () => {
    const tx = createMockTx({ input: SWAP_INPUT });
    const priorSwap = createMockTx({ input: SWAP_INPUT, blockNumber: 99 });
    const ctx = createMockContext({
      getRecentTxs: () => [priorSwap],
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("SANDWICH_PATTERN");
  });

  it("does not trigger on the first swap (no prior swap to compare)", () => {
    const tx = createMockTx({ input: SWAP_INPUT });
    const ctx = createMockContext({ getRecentTxs: () => [] });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("SANDWICH_PATTERN");
  });

  it("does not trigger for non-swap transactions", () => {
    const tx = createMockTx({ input: "0xdeadbeef00" });
    const ctx = createMockContext({ getRecentTxs: () => [createMockTx()] });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("SANDWICH_PATTERN");
  });
});

describe("PRICE_ORACLE_CALL", () => {
  // Chainlink latestRoundData selector
  const ORACLE_INPUT = "0x668a0f02";

  it("triggers for oracle call with anomalous gas (>150K)", () => {
    const tx = createMockTx({ input: ORACLE_INPUT, gasUsed: "200000" });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).toContain("PRICE_ORACLE_CALL");
  });

  it("triggers for repeated oracle calls from the same sender (≥2 in 3 blocks)", () => {
    const tx = createMockTx({ input: ORACLE_INPUT, gasUsed: "50000" });
    const ctx = createMockContext({ getRecentTxCount: () => 2 });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("PRICE_ORACLE_CALL");
  });

  it("does not trigger for a single oracle call with normal gas", () => {
    const tx = createMockTx({ input: ORACLE_INPUT, gasUsed: "40000" });
    const ctx = createMockContext({ getRecentTxCount: () => 0 });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).not.toContain("PRICE_ORACLE_CALL");
  });

  it("does not trigger for non-oracle selectors regardless of gas", () => {
    const tx = createMockTx({ input: "0xdeadbeef", gasUsed: "200000" });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).not.toContain("PRICE_ORACLE_CALL");
  });
});

describe("CALLDATA_ANOMALY", () => {
  it("triggers for calldata longer than 5KB (>10000 hex chars)", () => {
    const oversizedInput = "0xdeadbeef" + "ab".repeat(5010); // ~10KB
    const tx = createMockTx({ input: oversizedInput });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).toContain("CALLDATA_ANOMALY");
  });

  it("triggers for 3+ consecutive zero-padded 32-byte words after selector", () => {
    const zeroWord = "0".repeat(64);
    // selector (4 bytes = 8 hex) + 3 consecutive zero 32-byte words
    const input = "0xdeadbeef" + zeroWord + zeroWord + zeroWord;
    const tx = createMockTx({ input });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).toContain("CALLDATA_ANOMALY");
  });

  it("does not trigger for 2 consecutive zero words (below threshold)", () => {
    const zeroWord = "0".repeat(64);
    const nonZeroWord = "a".repeat(64);
    // Only 2 consecutive zeros, then a non-zero
    const input = "0xdeadbeef" + zeroWord + zeroWord + nonZeroWord;
    const tx = createMockTx({ input });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).not.toContain("CALLDATA_ANOMALY");
  });

  it("does not trigger for normal calldata", () => {
    const tx = createMockTx({ input: "0xa9059cbb" + "aa".repeat(64) });
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.triggeredRules).not.toContain("CALLDATA_ANOMALY");
  });
});

// ─── Scoring Mechanics ────────────────────────────────────────────────────────

describe("Score mechanics", () => {
  it("caps total score at 100 even when many rules trigger", () => {
    const tx = createMockTx({
      value: (20n * ONE_DOT).toString(),
      input: "0xab9c4b5d" + "00".repeat(100),
      gasUsed: "600000",
    });
    const ctx = createMockContext({
      getContractAge: () => 3600,
      isBlacklisted: () => true,
      getRecentTxs: () => Array(5).fill(tx),
      hasFlashLoanInteraction: () => true,
      getBalanceBefore: () => 100n * ONE_DOT,
      getBalanceAfter: () => 10n * ONE_DOT,
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it("halves score when target contract is whitelisted", () => {
    const tx = createMockTx({ value: (20n * ONE_DOT).toString() }); // ANOMALOUS_VALUE +35
    const ctx = createMockContext({ isWhitelisted: () => true });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBe(17); // Math.floor(35 * 0.5)
  });

  it("does not alter score when contract is not whitelisted", () => {
    const tx = createMockTx({ value: (20n * ONE_DOT).toString() }); // ANOMALOUS_VALUE +35
    const ctx = createMockContext({ isWhitelisted: () => false });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.score).toBe(35);
  });

  it("score cap of 100 is respected after whitelist reduction", () => {
    const tx = createMockTx({
      value: (20n * ONE_DOT).toString(),
      input: "0xab9c4b5d" + "00".repeat(100),
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

// ─── Correlation Bonus ────────────────────────────────────────────────────────

describe("Correlation bonus", () => {
  it("adds +20 for FLASH_LOAN_PATTERN + DRASTIC_BALANCE_CHANGE (Euler-style)", () => {
    const tx = createMockTx({
      input: "0xab9c4b5d" + "00".repeat(100), // FLASH_LOAN_PATTERN
    });
    const ctx = createMockContext({
      getBalanceBefore: () => 100n * ONE_DOT,
      getBalanceAfter: () => 50n * ONE_DOT,   // 50% drop → DRASTIC_BALANCE_CHANGE
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("FLASH_LOAN_PATTERN");
    expect(result.triggeredRules).toContain("DRASTIC_BALANCE_CHANGE");
    expect(result.correlationBonus).toBeGreaterThanOrEqual(20);
  });

  it("adds +15 for TX_BURST + ANOMALOUS_VALUE (drain pattern)", () => {
    const tx = createMockTx({ value: (20n * ONE_DOT).toString() }); // ANOMALOUS_VALUE
    const ctx = createMockContext({
      getRecentTxs: () => [tx, tx, tx, tx, tx], // TX_BURST
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.triggeredRules).toContain("TX_BURST");
    expect(result.triggeredRules).toContain("ANOMALOUS_VALUE");
    expect(result.correlationBonus).toBeGreaterThanOrEqual(15);
  });

  it("adds combined bonus when multiple combos match simultaneously", () => {
    // This tx can trigger both FLASH_LOAN+BALANCE and TX_BURST+ANOMALOUS_VALUE
    const tx = createMockTx({
      value: (20n * ONE_DOT).toString(),
      input: "0xab9c4b5d" + "00".repeat(100),
    });
    const ctx = createMockContext({
      getBalanceBefore: () => 100n * ONE_DOT,
      getBalanceAfter: () => 50n * ONE_DOT,
      getRecentTxs: () => [tx, tx, tx, tx, tx],
    });
    const result = calculateHeuristicScore(tx, ctx);
    expect(result.correlationBonus).toBeGreaterThanOrEqual(35); // 20 + 15
  });

  it("returns correlationBonus of 0 when no dangerous combinations are present", () => {
    const tx = createMockTx({ value: (20n * ONE_DOT).toString() }); // only ANOMALOUS_VALUE
    const result = calculateHeuristicScore(tx, createMockContext());
    expect(result.correlationBonus).toBe(0);
  });

  it("final score reflects correlation bonus in the total", () => {
    const tx = createMockTx({ value: (20n * ONE_DOT).toString() }); // +35
    const ctx = createMockContext({
      getRecentTxs: () => [tx, tx, tx, tx, tx], // TX_BURST +30, combo bonus +15
    });
    const result = calculateHeuristicScore(tx, ctx);
    // ANOMALOUS_VALUE(35) + TX_BURST(30) + combo_bonus(15) = 80
    expect(result.score).toBe(80);
    expect(result.correlationBonus).toBe(15);
  });
});
