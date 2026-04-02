import { HeuristicRule, HeuristicResult, TransactionData, MonitorContextInterface } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("heuristics");

const WITHDRAWAL_SELECTORS = [
  "0x2e1a7d4d", // withdraw(uint256)
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x3ccfd60b", // withdraw()
  "0x51cff8d9", // withdraw(address)
];

const FLASH_LOAN_SELECTORS = [
  "0xab9c4b5d", // flashLoan (Aave V2)
  "0x5cffe9de", // flashLoan (ERC-3156)
  "0xd9d98ce4", // flashBorrow
];

export const HEURISTIC_RULES: HeuristicRule[] = [
  {
    name: "ANOMALOUS_VALUE",
    description: "Transaction value exceeds 10x historical average for this contract",
    score: 35,
    evaluate: (tx, ctx) => {
      const avg = ctx.getHistoricalAvgValue(tx.to);
      if (avg === 0n) return false;
      return BigInt(tx.value) > avg * 10n;
    },
  },
  {
    name: "FRESH_CONTRACT",
    description: "Target contract is less than 24 hours old",
    score: 25,
    evaluate: (tx, ctx) => {
      const age = ctx.getContractAge(tx.to);
      if (age === null) return false;
      return age < 86400;
    },
  },
  {
    name: "TX_BURST",
    description: "Same sender sent 5+ transactions to same contract within 5 blocks",
    score: 30,
    evaluate: (tx, ctx) => {
      const recent = ctx.getRecentTxs(tx.from, tx.to, 5);
      return recent.length >= 5;
    },
  },
  {
    name: "LARGE_WITHDRAWAL",
    description: "Large withdrawal or transfer function call detected",
    score: 20,
    evaluate: (tx, ctx) => {
      if (tx.input.length < 10) return false;
      const selector = tx.input.slice(0, 10);
      if (!WITHDRAWAL_SELECTORS.includes(selector)) return false;
      // For withdraw() calls, tx.value is 0 (funds flow from contract to caller).
      // Check contract balance instead — a withdraw from a well-funded contract is notable.
      const contractBalance = ctx.getBalance(tx.to);
      if (contractBalance > 0n) return true;
      return BigInt(tx.value) > ctx.getSignificantThreshold(tx.to);
    },
  },
  {
    name: "FLASH_LOAN_PATTERN",
    description: "Transaction involves flash loan function signatures or very high gas",
    score: 40,
    evaluate: (tx, ctx) => {
      if (tx.input.length < 10) return false;
      const selector = tx.input.slice(0, 10);
      const isFlashLoan = FLASH_LOAN_SELECTORS.includes(selector);
      const hasHighGas = BigInt(tx.gasUsed) > 500000n;
      return isFlashLoan || (hasHighGas && ctx.hasFlashLoanInteraction(tx.hash));
    },
  },
  {
    name: "BLACKLISTED_ENTITY",
    description: "Transaction involves a blacklisted address",
    score: 50,
    evaluate: (tx, ctx) => {
      return ctx.isBlacklisted(tx.from) || ctx.isBlacklisted(tx.to);
    },
  },
  {
    name: "DRASTIC_BALANCE_CHANGE",
    description: "Monitored contract balance dropped >30% in single block",
    score: 45,
    evaluate: (tx, ctx) => {
      const before = ctx.getBalanceBefore(tx.to, tx.blockNumber);
      if (before === 0n) return false;
      const after = ctx.getBalanceAfter(tx.to, tx.blockNumber);
      const dropPercent = Number(((before - after) * 100n) / before);
      return dropPercent > 30;
    },
  },
  {
    name: "UNKNOWN_HIGH_VALUE_SENDER",
    description: "First-time sender with high-value transaction",
    score: 15,
    evaluate: (tx, ctx) => {
      const isFirstTime = !ctx.hasPreviousInteraction(tx.from, tx.to);
      const isHighValue = BigInt(tx.value) > ctx.getSignificantThreshold(tx.to);
      return isFirstTime && isHighValue;
    },
  },
];

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
      logger.warn(`Rule ${rule.name} failed for tx ${tx.hash}:`, error);
      details.push({ rule: rule.name, triggered: false, score: 0 });
    }
  }

  // Reduce score by 50% for whitelisted target contracts (fewer false positives)
  if (context.isWhitelisted(tx.to)) {
    totalScore = Math.floor(totalScore * 0.5);
    logger.debug(`Score reduced 50% for whitelisted contract ${tx.to}: ${totalScore}`);
  }

  const result: HeuristicResult = {
    score: Math.min(totalScore, 100),
    triggeredRules,
    details,
  };

  if (result.score > 0) {
    logger.info(
      `Heuristic score for tx ${tx.hash}: ${result.score}/100 ` +
      `(triggered: ${triggeredRules.join(", ")})`
    );
  }

  return result;
}
