// ============================================================================
// ChainSentinel — Heuristic Detection Engine
// ============================================================================
//
// Layer 1 of the dual-layer threat detection pipeline. Runs 11 deterministic
// rules against each transaction and a MonitorContext snapshot. All rules are
// synchronous and complete in <1ms. The total score is capped at 100.
//
// Scores are intentionally conservative per-rule so that combinations drive
// the total; the correlation bonus rewards known dangerous rule combinations
// (e.g. FLASH_LOAN_PATTERN + DRASTIC_BALANCE_CHANGE) with extra weight.
//
// Rule taxonomy:
//   Value anomalies:     ANOMALOUS_VALUE, LARGE_WITHDRAWAL
//   Temporal patterns:   TX_BURST, SANDWICH_PATTERN
//   Protocol patterns:   FLASH_LOAN_PATTERN, PRICE_ORACLE_CALL
//   Contract state:      FRESH_CONTRACT, DRASTIC_BALANCE_CHANGE
//   Entity reputation:   BLACKLISTED_ENTITY, UNKNOWN_HIGH_VALUE_SENDER
//   Payload analysis:    CALLDATA_ANOMALY
// ============================================================================

import { HeuristicRule, HeuristicResult, TransactionData, MonitorContextInterface } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("heuristics");

// ─── Selector Sets ───────────────────────────────────────────────────────────

/**
 * ERC-20 / native withdrawal function selectors.
 * Used by LARGE_WITHDRAWAL to identify outbound value movements.
 */
const WITHDRAWAL_SELECTORS = new Set([
  "0x2e1a7d4d", // withdraw(uint256)
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x3ccfd60b", // withdraw()
  "0x51cff8d9", // withdraw(address)
]);

/**
 * Flash loan entry-point selectors across major lending protocols.
 * Aave V2/V3, ERC-3156, dYdX, and generic flashBorrow interfaces.
 */
const FLASH_LOAN_SELECTORS = new Set([
  "0xab9c4b5d", // flashLoan(address,address,uint256,bytes)   — Aave V2
  "0x5cffe9de", // flashLoan(address,uint256,bytes)           — ERC-3156
  "0xd9d98ce4", // flashBorrow(address,uint256)
  "0x1b11d0ff", // flashLoan(address[],uint256[],bytes)       — Aave V3 (multi-asset)
  "0x490e6cbc", // executeFlashLoan(address,uint256,bytes)
]);

/**
 * AMM swap selectors across Uniswap V2, V3, and compatible forks.
 * Used by SANDWICH_PATTERN to identify swap transactions.
 */
const SWAP_SELECTORS = new Set([
  "0x38ed1739", // swapExactTokensForTokens          — Uniswap V2
  "0x8803dbee", // swapTokensForExactTokens           — Uniswap V2
  "0x7ff36ab5", // swapExactETHForTokens              — Uniswap V2
  "0x18cbafe5", // swapExactTokensForETH              — Uniswap V2
  "0xfb3bdb41", // swapETHForExactTokens              — Uniswap V2
  "0x5c11d795", // swapExactTokensForTokensSupportingFeeOnTransferTokens
  "0x04e45aaf", // exactInputSingle(ExactInputSingleParams) — Uniswap V3
  "0x414bf389", // exactOutputSingle(ExactOutputSingleParams) — Uniswap V3
  "0xc04b8d59", // exactInput(ExactInputParams)       — Uniswap V3
  "0xf28c0498", // exactOutput(ExactOutputParams)     — Uniswap V3
]);

/**
 * Price oracle read selectors from Chainlink, Uniswap, and Compound-style protocols.
 * Used by PRICE_ORACLE_CALL to detect oracle queries that often precede price
 * manipulation attacks.
 */
const ORACLE_SELECTORS = new Set([
  "0x668a0f02", // latestRoundData()               — Chainlink AggregatorV3
  "0x50d25bcd", // latestAnswer()                  — Chainlink (deprecated but active)
  "0x9a6fc8f5", // getRoundData(uint80)             — Chainlink
  "0x3850c7bd", // slot0()                         — Uniswap V3 Pool
  "0x0902f1ac", // getReserves()                   — Uniswap V2 Pair
  "0xfc57d4df", // underlyingPrice(address)        — Compound v2 Oracle
  "0x1b0f7ba4", // getUnderlyingPrice(address)     — Venus / Compound forks
  "0xd06ca61f", // getAmountsOut(uint256,address[]) — Uniswap V2 Router (price query)
]);

// ─── Calldata Decoding Helpers ────────────────────────────────────────────────

/**
 * Decode the token amount from an ERC-20 transfer or transferFrom calldata.
 *
 * ABI layout:
 *   transfer(address recipient, uint256 amount)
 *     → amount at params[64..128]
 *   transferFrom(address from, address to, uint256 amount)
 *     → amount at params[128..192]
 *
 * @returns The decoded uint256 amount, or null on layout mismatch.
 */
function decodeERC20TransferAmount(tx: TransactionData): bigint | null {
  if (tx.input.length < 10) return null;
  const selector = tx.input.slice(0, 10);
  const params = tx.input.slice(10); // hex without 0x prefix and selector

  try {
    if (selector === "0xa9059cbb" && params.length >= 128) {
      return BigInt("0x" + params.slice(64, 128));
    }
    if (selector === "0x23b872dd" && params.length >= 192) {
      return BigInt("0x" + params.slice(128, 192));
    }
  } catch {
    // Malformed calldata — not a threat indicator on its own
  }
  return null;
}

/**
 * Decode the amount argument from a withdraw(uint256) calldata.
 *
 * ABI layout:
 *   withdraw(uint256 amount) selector 0x2e1a7d4d
 *     → amount at params[0..64]
 *
 * @returns The decoded uint256 amount, or null for other withdraw variants.
 */
function decodeWithdrawAmount(tx: TransactionData): bigint | null {
  if (tx.input.length < 10) return null;
  const selector = tx.input.slice(0, 10);
  const params = tx.input.slice(10);

  try {
    if (selector === "0x2e1a7d4d" && params.length >= 64) {
      return BigInt("0x" + params.slice(0, 64));
    }
  } catch {
    // Malformed calldata
  }
  return null;
}

// ─── Correlation Bonus ────────────────────────────────────────────────────────

/**
 * Dangerous rule combinations observed in real-world DeFi exploits.
 * When ALL rules in a combo are triggered simultaneously, the extra bonus
 * reflects that the combination is more diagnostic than the sum of its parts.
 *
 * References:
 *   - Euler Finance ($197M, Mar 2023): FLASH_LOAN + DRASTIC_BALANCE_CHANGE
 *   - Curve Reentrancy ($70M, Jul 2023): TX_BURST + DRASTIC_BALANCE_CHANGE
 *   - Mango Markets ($117M, Oct 2022): PRICE_ORACLE_CALL + LARGE_WITHDRAWAL
 */
const CORRELATION_COMBOS: ReadonlyArray<{
  rules: string[];
  bonus: number;
  reason: string;
}> = [
  {
    rules: ["FLASH_LOAN_PATTERN", "DRASTIC_BALANCE_CHANGE"],
    bonus: 20,
    reason: "Flash loan + balance drain — classic Euler/Aave-style exploit signature",
  },
  {
    rules: ["TX_BURST", "ANOMALOUS_VALUE"],
    bonus: 15,
    reason: "Rapid high-value transactions — drain or price manipulation pattern",
  },
  {
    rules: ["FRESH_CONTRACT", "FLASH_LOAN_PATTERN"],
    bonus: 15,
    reason: "Flash loan on newly deployed contract — rug pull or one-shot exploit setup",
  },
  {
    rules: ["PRICE_ORACLE_CALL", "LARGE_WITHDRAWAL"],
    bonus: 20,
    reason: "Oracle query followed by large withdrawal — Mango-style price oracle manipulation",
  },
  {
    rules: ["SANDWICH_PATTERN", "TX_BURST"],
    bonus: 10,
    reason: "Repeated sandwich attempts — sustained MEV attack in progress",
  },
  {
    rules: ["CALLDATA_ANOMALY", "FLASH_LOAN_PATTERN"],
    bonus: 15,
    reason: "Anomalous payload in flash loan — crafted exploit calldata",
  },
  {
    rules: ["TX_BURST", "DRASTIC_BALANCE_CHANGE"],
    bonus: 15,
    reason: "Burst of transactions with balance drain — Curve-style reentrancy pattern",
  },
];

/**
 * Compute the total correlation bonus for a set of triggered rule names.
 * Logs each matched combo at DEBUG level for auditability.
 */
function computeCorrelationBonus(triggeredRules: string[]): number {
  const triggered = new Set(triggeredRules);
  let total = 0;
  for (const combo of CORRELATION_COMBOS) {
    if (combo.rules.every((r) => triggered.has(r))) {
      total += combo.bonus;
      logger.debug(`Correlation bonus +${combo.bonus}: ${combo.reason}`);
    }
  }
  return total;
}

// ─── Rule Definitions ─────────────────────────────────────────────────────────

export const HEURISTIC_RULES: HeuristicRule[] = [
  // ── 1. ANOMALOUS_VALUE ──────────────────────────────────────────────────────
  // Fires when a transaction moves an unusually large amount of value to a
  // contract — either as native PAS (tx.value) or as an ERC-20 transfer decoded
  // from calldata. Both channels use their own rolling average as baseline.
  {
    name: "ANOMALOUS_VALUE",
    description:
      "Transaction value (native or ERC-20) exceeds 10× historical average for this contract",
    score: 35,
    evaluate: (tx, ctx) => {
      // — Native token channel —
      const avgNative = ctx.getHistoricalAvgValue(tx.to);
      if (avgNative > 0n && BigInt(tx.value) > avgNative * 10n) return true;

      // — ERC-20 channel: decode amount from transfer/transferFrom calldata —
      const erc20Amount = decodeERC20TransferAmount(tx);
      if (erc20Amount !== null && erc20Amount > 0n) {
        const avgERC20 = ctx.getHistoricalAvgERC20Value(tx.to);
        if (avgERC20 > 0n && erc20Amount > avgERC20 * 10n) return true;
      }

      return false;
    },
  },

  // ── 2. FRESH_CONTRACT ──────────────────────────────────────────────────────
  // Newly deployed contracts (< 24 h old) are disproportionately involved in
  // exploits. The age is resolved via binary search in context.ts and stored
  // as 0 (unknown/old) when the contract was deployed before the 2000-block
  // search window — preventing false positives for established contracts.
  {
    name: "FRESH_CONTRACT",
    description: "Target contract is less than 24 hours old",
    score: 25,
    evaluate: (tx, ctx) => {
      const age = ctx.getContractAge(tx.to);
      if (age === null) return false;
      // age === 0 means "too old to determine" — never treat as fresh
      if (age === 0) return false;
      return age < 86400; // 24 hours in seconds
    },
  },

  // ── 3. TX_BURST ─────────────────────────────────────────────────────────────
  // Rapid repeated interactions from the same sender to the same contract are
  // a hallmark of reentrancy attacks and drain loops. Five transactions within
  // five blocks (~30 s on Polkadot Hub) is well above normal usage patterns.
  {
    name: "TX_BURST",
    description: "Same sender sent 5+ transactions to same contract within 5 blocks (~30s)",
    score: 30,
    evaluate: (tx, ctx) => {
      return ctx.getRecentTxs(tx.from, tx.to, 5).length >= 5;
    },
  },

  // ── 4. LARGE_WITHDRAWAL ─────────────────────────────────────────────────────
  // Detects outbound value transfers that are large relative to the contract's
  // own state. For ERC-20 withdrawals, the decoded calldata amount is compared
  // against the historical ERC-20 average (not the native balance, avoiding
  // apples-to-oranges comparisons). As a fallback for native withdrawals, a
  // >20% native balance drop is required — far stricter than the previous
  // "any contract with balance > 0" condition that fired on every DeFi call.
  {
    name: "LARGE_WITHDRAWAL",
    description:
      "Withdrawal amount is significantly large — decoded from calldata or measured as >20% native balance drop",
    score: 20,
    evaluate: (tx, ctx) => {
      if (tx.input.length < 10) return false;
      const selector = tx.input.slice(0, 10);
      if (!WITHDRAWAL_SELECTORS.has(selector)) return false;

      // — ERC-20 channel: decode withdraw(uint256) amount —
      const withdrawAmount = decodeWithdrawAmount(tx);
      if (withdrawAmount !== null && withdrawAmount > 0n) {
        const avgERC20 = ctx.getHistoricalAvgERC20Value(tx.to);
        if (avgERC20 > 0n && withdrawAmount > avgERC20 * 5n) return true;
        return withdrawAmount > ctx.getSignificantThreshold(tx.to);
      }

      // — ERC-20 channel: transfer/transferFrom amount —
      const transferAmount = decodeERC20TransferAmount(tx);
      if (transferAmount !== null && transferAmount > 0n) {
        const avgERC20 = ctx.getHistoricalAvgERC20Value(tx.to);
        if (avgERC20 > 0n && transferAmount > avgERC20 * 5n) return true;
        return transferAmount > ctx.getSignificantThreshold(tx.to);
      }

      // — Native token fallback: require >20% balance drop —
      const before = ctx.getBalanceBefore(tx.to, tx.blockNumber);
      if (before === 0n) return false;
      const after = ctx.getBalanceAfter(tx.to, tx.blockNumber);
      if (after >= before) return false;
      return Number(((before - after) * 100n) / before) > 20;
    },
  },

  // ── 5. FLASH_LOAN_PATTERN ───────────────────────────────────────────────────
  // Three complementary detection branches:
  //   a) Direct selector match (fast path, catches explicit flash loan calls)
  //   b) High gas (>500K) combined with a flash loan interaction in the same tx
  //      (preRegisterFlashLoans in monitor.ts ensures this check is current-block-accurate)
  //   c) Very high gas (>1M) alone — nearly diagnostic of complex multi-call exploits
  {
    name: "FLASH_LOAN_PATTERN",
    description:
      "Transaction involves flash loan selectors, very high gas (>1M), or high gas combined with a flash loan interaction",
    score: 40,
    evaluate: (tx, ctx) => {
      if (tx.input.length < 10) return false;
      const selector = tx.input.slice(0, 10);

      // Branch a: direct flash loan selector
      if (FLASH_LOAN_SELECTORS.has(selector)) return true;

      const gasUsed = BigInt(tx.gasUsed);

      // Branch b: high gas + known flash loan interaction in this tx
      if (gasUsed > 500000n && ctx.hasFlashLoanInteraction(tx.hash)) return true;

      // Branch c: extremely high gas alone — complex multi-call exploit territory
      if (gasUsed > 1000000n) return true;

      return false;
    },
  },

  // ── 6. BLACKLISTED_ENTITY ───────────────────────────────────────────────────
  // The local blacklist is seeded from the SentinelRegistry on-chain and
  // supplemented by the agent's own observations. Any transaction involving a
  // known malicious address is immediately high-priority.
  {
    name: "BLACKLISTED_ENTITY",
    description: "Transaction sender or target is on the local/on-chain blacklist",
    score: 50,
    evaluate: (tx, ctx) => {
      return ctx.isBlacklisted(tx.from) || ctx.isBlacklisted(tx.to);
    },
  },

  // ── 7. DRASTIC_BALANCE_CHANGE ────────────────────────────────────────────────
  // A single-block balance drop of more than 30% on a contract is the post-hoc
  // signature of a successful drain. When caught in real time it means the attack
  // may still be in progress (multi-tx drains) and emergency withdrawal is urgent.
  {
    name: "DRASTIC_BALANCE_CHANGE",
    description: "Monitored contract native balance dropped >30% within this block",
    score: 45,
    evaluate: (tx, ctx) => {
      const before = ctx.getBalanceBefore(tx.to, tx.blockNumber);
      if (before === 0n) return false;
      const after = ctx.getBalanceAfter(tx.to, tx.blockNumber);
      if (after >= before) return false;
      return Number(((before - after) * 100n) / before) > 30;
    },
  },

  // ── 8. UNKNOWN_HIGH_VALUE_SENDER ─────────────────────────────────────────────
  // A first-time interactor sending a high-value transaction is a common profile
  // for newly funded exploit wallets. Low individual score because it can also
  // be a new legitimate user — always needs LLM corroboration.
  {
    name: "UNKNOWN_HIGH_VALUE_SENDER",
    description: "First-time sender to this contract with a high-value transaction",
    score: 15,
    evaluate: (tx, ctx) => {
      return (
        !ctx.hasPreviousInteraction(tx.from, tx.to) &&
        BigInt(tx.value) > ctx.getSignificantThreshold(tx.to)
      );
    },
  },

  // ── 9. SANDWICH_PATTERN ──────────────────────────────────────────────────────
  // Sandwich attacks require the attacker to place two swap transactions around
  // a victim: front-run (buy before victim) and back-run (sell after victim).
  // If the same sender has already made a swap to the same DEX within 2 blocks
  // and sends another swap now, it matches the front-run + back-run profile.
  // Note: this is a necessary condition, not sufficient — the LLM provides the
  // final confirmation by analysing the broader block context.
  {
    name: "SANDWICH_PATTERN",
    description:
      "Same sender made multiple swap transactions to the same AMM within 2 blocks — front-run/back-run profile",
    score: 30,
    evaluate: (tx, ctx) => {
      if (tx.input.length < 10) return false;
      if (!SWAP_SELECTORS.has(tx.input.slice(0, 10))) return false;

      // Look for a prior swap from the same sender to the same AMM within 2 blocks
      const recentSwaps = ctx.getRecentTxs(tx.from, tx.to, 2).filter(
        (t) => t.input.length >= 10 && SWAP_SELECTORS.has(t.input.slice(0, 10))
      );
      return recentSwaps.length >= 1;
    },
  },

  // ── 10. PRICE_ORACLE_CALL ─────────────────────────────────────────────────────
  // Direct external calls to price oracle functions are unusual — DeFi protocols
  // normally query oracles as internal calls within a larger transaction. A
  // standalone oracle query with anomalously high gas (>150K; normal oracle reads
  // cost ~30-50K) indicates complex logic that may be manipulating price feeds.
  // Repeated queries (≥2 in 3 blocks) from the same sender are also flagged.
  {
    name: "PRICE_ORACLE_CALL",
    description:
      "Direct price oracle query with anomalous gas or repeated calls — precursor to price manipulation",
    score: 25,
    evaluate: (tx, ctx) => {
      if (tx.input.length < 10) return false;
      if (!ORACLE_SELECTORS.has(tx.input.slice(0, 10))) return false;

      // Oracle reads are ~30-50K gas; >150K signals complex additional logic
      const hasAnomalousGas = BigInt(tx.gasUsed) > 150000n;

      // Multiple oracle queries in rapid succession from the same sender
      const hasRepeatedQueries = ctx.getRecentTxCount(tx.from, tx.to, 3) >= 2;

      return hasAnomalousGas || hasRepeatedQueries;
    },
  },

  // ── 11. CALLDATA_ANOMALY ──────────────────────────────────────────────────────
  // Exploit PoCs often contain two calldata signatures:
  //   a) Oversized calldata (>5KB) — complex multi-call payloads, ABI-encoded
  //      arrays of attack parameters, or deliberate offset manipulation
  //   b) Consecutive zero-padded 32-byte words (≥3 in a row) — a common artifact
  //      of hand-crafted ABI encoding in Foundry/Hardhat PoC scripts
  // Normal DeFi interactions rarely exceed 1KB of calldata.
  {
    name: "CALLDATA_ANOMALY",
    description:
      "Transaction calldata is oversized (>5KB) or contains ≥3 consecutive zero-padded words — exploit payload pattern",
    score: 20,
    evaluate: (tx, _ctx) => {
      if (tx.input.length < 10) return false;
      const data = tx.input.startsWith("0x") ? tx.input.slice(2) : tx.input;

      // Condition a: calldata > 5KB (10,000 hex characters)
      if (data.length > 10000) return true;

      // Condition b: 3+ consecutive 64-char zero words after the 4-byte selector
      const zeroWord = "0".repeat(64);
      let consecutive = 0;
      for (let i = 8; i + 64 <= data.length; i += 64) {
        if (data.slice(i, i + 64) === zeroWord) {
          if (++consecutive >= 3) return true;
        } else {
          consecutive = 0;
        }
      }

      return false;
    },
  },
];

// ─── Score Calculation ────────────────────────────────────────────────────────

/**
 * Run all heuristic rules against a transaction and return a scored result.
 *
 * Scoring pipeline:
 *   1. Evaluate each of the 11 rules (synchronous, catch-isolated)
 *   2. Sum scores of triggered rules
 *   3. Compute correlation bonus for known dangerous rule combinations
 *   4. Apply 50% reduction for whitelisted target contracts
 *   5. Cap total at 100
 */
export function calculateHeuristicScore(
  tx: TransactionData,
  context: MonitorContextInterface
): HeuristicResult {
  let totalScore = 0;
  const triggeredRules: string[] = [];
  const details: Array<{ rule: string; triggered: boolean; score: number }> = [];

  for (const rule of HEURISTIC_RULES) {
    try {
      const triggered = rule.evaluate(tx, context) as boolean;
      details.push({ rule: rule.name, triggered, score: triggered ? rule.score : 0 });

      if (triggered) {
        totalScore += rule.score;
        triggeredRules.push(rule.name);
        logger.debug(`Rule ${rule.name} triggered (+${rule.score}) for tx ${tx.hash}`);
      }
    } catch (error) {
      logger.warn(`Rule ${rule.name} evaluation error for tx ${tx.hash}:`, error);
      details.push({ rule: rule.name, triggered: false, score: 0 });
    }
  }

  // Correlation bonus: reward dangerous rule combinations
  const correlationBonus = computeCorrelationBonus(triggeredRules);
  if (correlationBonus > 0) {
    totalScore += correlationBonus;
    logger.info(
      `Correlation bonus +${correlationBonus} for tx ${tx.hash} ` +
        `(rules: ${triggeredRules.join(", ")})`
    );
  }

  // Whitelist reduction: trusted contracts receive 50% score discount
  if (context.isWhitelisted(tx.to)) {
    totalScore = Math.floor(totalScore * 0.5);
    logger.debug(
      `Score halved for whitelisted contract ${tx.to}: ${totalScore}`
    );
  }

  const finalScore = Math.min(totalScore, 100);

  if (finalScore > 0) {
    logger.info(
      `Heuristic score for tx ${tx.hash}: ${finalScore}/100 ` +
        `(rules: ${triggeredRules.join(", ")}` +
        (correlationBonus > 0 ? `, correlation: +${correlationBonus}` : "") +
        ")"
    );
  }

  return { score: finalScore, triggeredRules, details, correlationBonus };
}
