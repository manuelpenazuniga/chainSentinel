// ============================================================================
// ChainSentinel — LLM Threat Analysis (Layer 2)
// ============================================================================
//
// Wraps the Gemini 2.5 Flash API to perform contextual threat analysis on
// transactions that passed the heuristic filter (score ≥ heuristicThreshold).
//
// Prompt design principles:
//   1. Few-shot examples anchor the 0-100 scale with real attack signatures so
//      Gemini doesn't apply its own internal distribution (which is conservative).
//   2. Chain-of-thought is requested via a "reasoning" field before the score,
//      which consistently produces more accurate threat scores on structured
//      output tasks.
//   3. The attack pattern reference section uses concrete technical indicators
//      (gas patterns, call sequences, balance changes) not just category names.
//   4. Temperature 0.1 + responseMimeType: "application/json" guarantees
//      parseable output without markdown fences.
// ============================================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { TransactionData, HeuristicResult, LLMAnalysis, MonitorContextInterface } from "./types.js";
import { createLogger } from "./logger.js";
import { ethers } from "ethers";

const logger = createLogger("llm");

// ─── Prompt Construction ─────────────────────────────────────────────────────

function formatEther(wei: string | bigint): string {
  try {
    return ethers.formatEther(wei.toString()) + " DOT";
  } catch {
    return wei.toString() + " wei";
  }
}

/**
 * Infer a human-readable contract type from the most recently observed function
 * selector sent to this contract. Used to give the LLM better context about
 * what protocol it is analysing.
 */
function inferContractType(selector: string): string {
  const SWAP_PREFIXES = new Set([
    "0x38ed1739", "0x8803dbee", "0x7ff36ab5", "0x18cbafe5",
    "0x04e45aaf", "0x414bf389", "0xc04b8d59", "0xf28c0498",
  ]);
  const FLASH_PREFIXES = new Set([
    "0xab9c4b5d", "0x5cffe9de", "0xd9d98ce4", "0x1b11d0ff",
  ]);
  const WITHDRAW_PREFIXES = new Set([
    "0x2e1a7d4d", "0x3ccfd60b", "0x51cff8d9",
  ]);
  const ORACLE_PREFIXES = new Set([
    "0x668a0f02", "0x50d25bcd", "0x3850c7bd", "0x0902f1ac",
  ]);

  if (SWAP_PREFIXES.has(selector)) return "AMM/DEX (swap interface detected)";
  if (FLASH_PREFIXES.has(selector)) return "Lending protocol (flash loan interface)";
  if (WITHDRAW_PREFIXES.has(selector)) return "Vault or token contract (withdrawal interface)";
  if (ORACLE_PREFIXES.has(selector)) return "Price oracle (read interface)";
  return "Unknown contract type";
}

/**
 * Build the full analysis prompt for a transaction.
 *
 * The prompt structure:
 *   1. Role definition
 *   2. Few-shot calibration examples (anchor the 0-100 scale)
 *   3. Transaction under analysis
 *   4. Historical context from MonitorContext
 *   5. Triggered heuristic rules with their rationale
 *   6. Technical attack pattern reference
 *   7. Output schema with chain-of-thought instruction
 */
function buildAnalysisPrompt(
  tx: TransactionData,
  heuristicResult: HeuristicResult,
  context: MonitorContextInterface
): string {
  const contractLabel = context.getContractLabel(tx.to) ?? "unlabelled contract";
  const contractType = inferContractType(tx.functionSelector ?? "0x");
  const contractAge = context.getContractAge(tx.to);
  const contractAgeStr =
    contractAge === null
      ? "unknown"
      : contractAge === 0
      ? "older than search window (treat as established)"
      : `${contractAge}s (${(contractAge / 3600).toFixed(1)}h)`;

  const balanceBefore = context.getBalanceBefore(tx.to, tx.blockNumber);
  const balanceAfter = context.getBalanceAfter(tx.to, tx.blockNumber);
  const balanceChangeStr =
    balanceBefore === 0n
      ? "no prior balance data"
      : `${formatEther(balanceBefore)} → ${formatEther(balanceAfter)} ` +
        `(${context.getBalanceChange(tx.to, tx.blockNumber)}% change)`;

  const triggeredRulesStr =
    heuristicResult.triggeredRules.length > 0
      ? heuristicResult.triggeredRules.map((r) => `  • ${r}`).join("\n")
      : "  • (none)";

  const correlationStr =
    heuristicResult.correlationBonus > 0
      ? `\nCorrelation bonus: +${heuristicResult.correlationBonus} ` +
        `(triggered rules form a known dangerous combination)`
      : "";

  return `You are ChainSentinel's threat analysis engine for DeFi smart contracts on Polkadot Hub.
Your role is to determine whether a transaction represents a security threat and assign a precise threat score.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CALIBRATION EXAMPLES (use these to anchor your 0-100 scale)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Example A — Euler Finance-style flash loan drain (score: 91)
  Transaction: flashLoan() → donateToReserves() → liquidate() in single tx
  Context: 8-month-old lending protocol | flash loan selector detected |
           contract balance dropped 98% in one block | 1.4M gas used |
           sender had zero prior interactions
  Heuristic rules: FLASH_LOAN_PATTERN, DRASTIC_BALANCE_CHANGE, UNKNOWN_HIGH_VALUE_SENDER
  → This is a confirmed critical attack pattern. Score must be 80-100.

Example B — Normal Uniswap swap (score: 8)
  Transaction: swapExactTokensForTokens() | value: 2.1 DOT
  Context: Established DEX (18 months old) | 180K gas | sender has 47 prior swaps |
           contract balance unchanged | no heuristic rules triggered
  → Routine DeFi interaction. Score must be 0-15.

Example C — Suspicious but unconfirmed (score: 52)
  Transaction: withdraw(50000 USDC) | first interaction by this wallet
  Context: 6-hour-old contract | high value relative to history |
           no flash loan, no burst pattern
  Heuristic rules: FRESH_CONTRACT, ANOMALOUS_VALUE
  → Elevated risk but insufficient evidence for emergency action. Score 40-65.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRANSACTION UNDER ANALYSIS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Hash:          ${tx.hash}
From:          ${tx.from}
To:            ${tx.to} (${contractLabel})
Contract type: ${contractType}
Value:         ${formatEther(tx.value)}
Function:      ${tx.decodedFunction ?? tx.functionSelector ?? "unknown"}
Gas used:      ${tx.gasUsed}
Block:         ${tx.blockNumber}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
HISTORICAL CONTEXT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Contract age:               ${contractAgeStr}
Avg native tx value:        ${formatEther(context.getHistoricalAvgValue(tx.to))}
Avg ERC-20 transfer amount: ${formatEther(context.getHistoricalAvgERC20Value(tx.to))}
Native balance change:      ${balanceChangeStr}
Current contract balance:   ${formatEther(context.getBalance(tx.to))}
Txs from sender (5 blocks): ${context.getRecentTxCount(tx.from, tx.to, 5)}
Sender prior interactions:  ${context.hasPreviousInteraction(tx.from, tx.to) ? "yes" : "no (first interaction)"}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TRIGGERED HEURISTIC RULES (score: ${heuristicResult.score}/100)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${triggeredRulesStr}${correlationStr}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ATTACK PATTERN REFERENCE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Flash loan attack
  Signature: flashLoan() call → manipulate state → exploit → repay (1 tx, >400K gas)
  Indicators: FLASH_LOAN_PATTERN + DRASTIC_BALANCE_CHANGE in same block
  Real examples: Euler Finance ($197M), Beanstalk ($182M), Cream Finance ($130M)

Reentrancy drain
  Signature: withdraw() called recursively before state update; same sender burst
  Indicators: TX_BURST + DRASTIC_BALANCE_CHANGE; often <100K gas per tx but many txs
  Real examples: DAO hack (2016), Curve Finance ($70M Jul 2023)

Price oracle manipulation
  Signature: oracle query → swap to inflate/deflate price → exploit lending position
  Indicators: PRICE_ORACLE_CALL before/after LARGE_WITHDRAWAL; flash loan integration
  Real examples: Mango Markets ($117M), Inverse Finance ($15M)

Sandwich / MEV attack
  Signature: attacker tx → victim tx → attacker tx; all in same block on same DEX
  Indicators: SANDWICH_PATTERN; two swap txs within 1-2 blocks from same sender
  Impact: value extraction from victim, not direct protocol drain

Access control exploit
  Signature: privileged function called by non-owner; often first interaction
  Indicators: UNKNOWN_HIGH_VALUE_SENDER; admin/upgrade selectors in calldata
  Real examples: Ronin Bridge ($625M), Wormhole ($320M)

Drain / rug pull
  Signature: rapid large withdrawals emptying a pool; may use newly deployed router
  Indicators: TX_BURST + ANOMALOUS_VALUE + DRASTIC_BALANCE_CHANGE; FRESH_CONTRACT
  Real examples: Hundreds of DeFi rug pulls

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUR TASK
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Analyse the transaction above using all available context. Think step by step.

Score guidance (use the calibration examples above as anchors):
  0-15:  Normal — no meaningful attack indicators
  16-39: Unusual — worth noting but benign explanation is likely
  40-64: Suspicious — requires monitoring, user should be alerted
  65-79: Probable threat — alert strongly, prepare for emergency action
  80-100: Critical threat — emergency withdrawal recommended immediately

Confidence guide:
  90-100: Multiple indicators perfectly match a known attack pattern
  70-89:  Strong indicators but some ambiguity in context
  50-69:  Pattern is suggestive but incomplete data
  30-49:  Marginal indicators, could be benign
  0-29:   Highly uncertain

Respond ONLY with this exact JSON (no markdown, no text outside the object):
{
  "reasoning": "<2-4 sentences of step-by-step analysis explaining what you see>",
  "threatScore": <integer 0-100>,
  "confidence": <integer 0-100>,
  "classification": "<NORMAL|SUSPICIOUS|PROBABLE_THREAT|CRITICAL_THREAT>",
  "attackType": "<NONE|FLASH_LOAN|REENTRANCY|PRICE_MANIPULATION|SANDWICH|DRAIN|ACCESS_CONTROL|UNKNOWN>",
  "explanation": "<concise one-sentence summary for the alert>",
  "recommendedAction": "<NONE|MONITOR|ALERT|EMERGENCY_WITHDRAW>"
}`;
}

// ─── API Call ─────────────────────────────────────────────────────────────────

/**
 * Invoke Gemini 2.5 Flash to analyse a transaction and return a structured
 * LLMAnalysis. Throws on timeout or parse failure — callers should catch and
 * fall back to heuristic-only assessment.
 *
 * @param tx             - Enriched transaction data.
 * @param heuristicResult - Result from Layer 1 (rules + correlation bonus).
 * @param context        - MonitorContext snapshot.
 * @param apiKey         - Gemini API key.
 * @param timeoutMs      - Abort timeout in milliseconds (default: 30s).
 */
export async function analyzeThreatWithLLM(
  tx: TransactionData,
  heuristicResult: HeuristicResult,
  context: MonitorContextInterface,
  apiKey: string,
  timeoutMs: number = 30000
): Promise<LLMAnalysis> {
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction:
      "You are ChainSentinel's threat detection engine for DeFi smart contracts. " +
      "Always respond with valid JSON only. Never include markdown fences or text outside the JSON object.",
    generationConfig: {
      maxOutputTokens: 1024,
      temperature: 0.1,
      responseMimeType: "application/json",
    } as Record<string, unknown>,
  });

  const prompt = buildAnalysisPrompt(tx, heuristicResult, context);

  logger.info(
    `Invoking LLM for tx ${tx.hash} (heuristic=${heuristicResult.score}, ` +
      `correlation=+${heuristicResult.correlationBonus}, ` +
      `rules=[${heuristicResult.triggeredRules.join(", ")}])`
  );

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await model.generateContent(
      { contents: [{ role: "user", parts: [{ text: prompt }] }] },
      { signal: controller.signal } as Parameters<typeof model.generateContent>[1]
    );

    clearTimeout(timeoutId);

    const rawText = result.response.text().replace(/```json\s*|```\s*/g, "").trim();
    logger.debug(`LLM raw response (first 400 chars): ${rawText.slice(0, 400)}`);

    const analysis: LLMAnalysis = JSON.parse(rawText);

    // Validate required numeric fields
    if (
      typeof analysis.threatScore !== "number" ||
      typeof analysis.confidence !== "number" ||
      analysis.threatScore < 0 ||
      analysis.threatScore > 100 ||
      analysis.confidence < 0 ||
      analysis.confidence > 100
    ) {
      throw new Error(
        `Invalid LLM response values: score=${analysis.threatScore}, confidence=${analysis.confidence}`
      );
    }

    logger.info(
      `LLM result for tx ${tx.hash}: score=${analysis.threatScore}, ` +
        `confidence=${analysis.confidence}%, type=${analysis.attackType}, ` +
        `action=${analysis.recommendedAction}`
    );

    if (analysis.reasoning) {
      logger.debug(`LLM reasoning: ${analysis.reasoning}`);
    }

    return analysis;
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      logger.warn(`LLM analysis timed out after ${timeoutMs}ms for tx ${tx.hash}`);
    } else {
      logger.error(`LLM analysis failed for tx ${tx.hash}:`, error);
    }

    throw error;
  }
}
