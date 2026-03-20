import { GoogleGenerativeAI } from "@google/generative-ai";
import { TransactionData, HeuristicResult, LLMAnalysis, MonitorContextInterface } from "./types.js";
import { createLogger } from "./logger.js";
import { ethers } from "ethers";

const logger = createLogger("llm");

function buildAnalysisPrompt(
  tx: TransactionData,
  heuristicResult: HeuristicResult,
  context: MonitorContextInterface
): string {
  const formatValue = (wei: string | bigint): string => {
    try {
      return ethers.formatEther(wei.toString()) + " DOT";
    } catch {
      return wei.toString() + " wei";
    }
  };

  return `You are an expert threat detection system for DeFi smart contracts on Polkadot Hub.
Analyze the following transaction and determine if it represents a security threat.

## Transaction Data
- Hash: ${tx.hash}
- From: ${tx.from}
- To: ${tx.to} (${context.getContractLabel(tx.to) || "unknown contract"})
- Value: ${formatValue(tx.value)}
- Function: ${tx.decodedFunction || tx.functionSelector || "unknown"}
- Gas Used: ${tx.gasUsed}
- Block: ${tx.blockNumber}

## Historical Context
- Target contract age: ${context.getContractAge(tx.to) ?? "unknown"} seconds
- Average tx value to this contract: ${formatValue(context.getHistoricalAvgValue(tx.to).toString())}
- Txs from same sender in last 5 blocks: ${context.getRecentTxCount(tx.from, tx.to, 5)}
- Sender has previous interactions: ${context.hasPreviousInteraction(tx.from, tx.to)}
- Current contract balance: ${formatValue(context.getBalance(tx.to).toString())}
- Balance change this block: ${context.getBalanceChange(tx.to, tx.blockNumber)}%

## Triggered Heuristic Rules
${heuristicResult.triggeredRules.length > 0 ? heuristicResult.triggeredRules.map((r) => `- ${r}`).join("\n") : "- None"}
Heuristic score: ${heuristicResult.score}/100

## Known Attack Patterns (Reference)
- Flash loan attack: borrow large amount → manipulate price → exploit protocol → repay (all in 1 tx)
- Reentrancy: recursive callback drains funds before state update
- Price oracle manipulation: inflate/deflate price on DEX to exploit lending protocol
- Access control exploit: call admin functions without authorization
- Drain attack: rapid multiple withdrawals emptying a pool/vault

## Your Task
1. Analyze whether this transaction shows attack patterns
2. Consider the historical context and anomalies
3. Assign a Threat Score from 0-100:
   - 0-20: Normal, no attack indicators
   - 20-40: Unusual but likely benign
   - 40-60: Suspicious, requires close monitoring
   - 60-80: Probable threat, recommend alerting user
   - 80-100: High probability of attack, recommend emergency withdrawal

Respond ONLY with valid JSON in this exact format:
{
  "threatScore": <number 0-100>,
  "confidence": <number 0-100>,
  "classification": "<NORMAL|SUSPICIOUS|PROBABLE_THREAT|CRITICAL_THREAT>",
  "attackType": "<NONE|FLASH_LOAN|REENTRANCY|PRICE_MANIPULATION|DRAIN|ACCESS_CONTROL|UNKNOWN>",
  "explanation": "<concise explanation of your analysis>",
  "recommendedAction": "<NONE|MONITOR|ALERT|EMERGENCY_WITHDRAW>"
}`;
}

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
      "You are an expert threat detection system for DeFi smart contracts. " +
      "Always respond with valid JSON only. No markdown, no explanation outside the JSON.",
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.1,
      responseMimeType: "application/json",
    } as Record<string, unknown>,
  });

  const prompt = buildAnalysisPrompt(tx, heuristicResult, context);

  logger.info(`Invoking LLM analysis for tx ${tx.hash} (heuristic score: ${heuristicResult.score})`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const result = await model.generateContent(
      { contents: [{ role: "user", parts: [{ text: prompt }] }] },
      { signal: controller.signal } as Parameters<typeof model.generateContent>[1]
    );

    clearTimeout(timeoutId);

    const rawText = result.response.text().replace(/```json\s*|```\s*/g, "").trim();
    logger.info(`LLM raw response (first 300 chars): ${rawText.slice(0, 300)}`);
    const analysis: LLMAnalysis = JSON.parse(rawText);

    if (
      typeof analysis.threatScore !== "number" ||
      typeof analysis.confidence !== "number" ||
      analysis.threatScore < 0 ||
      analysis.threatScore > 100 ||
      analysis.confidence < 0 ||
      analysis.confidence > 100
    ) {
      throw new Error(`Invalid LLM response values: score=${analysis.threatScore}, confidence=${analysis.confidence}`);
    }

    logger.info(
      `LLM analysis for tx ${tx.hash}: score=${analysis.threatScore}, ` +
      `confidence=${analysis.confidence}, type=${analysis.attackType}, ` +
      `action=${analysis.recommendedAction}`
    );

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
