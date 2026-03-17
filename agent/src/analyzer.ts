import { TransactionData, ThreatAssessment, MonitorContextInterface, AgentConfig } from "./types.js";
import { calculateHeuristicScore } from "./heuristics.js";
import { analyzeThreatWithLLM } from "./llm.js";
import { createLogger } from "./logger.js";

const logger = createLogger("analyzer");

export async function analyzeTransaction(
  tx: TransactionData,
  context: MonitorContextInterface,
  config: AgentConfig
): Promise<ThreatAssessment> {
  const timestamp = Date.now();

  // Layer 1: Heuristics (always runs)
  const heuristicResult = calculateHeuristicScore(tx, context);

  if (heuristicResult.score === 0) {
    return {
      score: 0,
      classification: "NORMAL",
      attackType: "NONE",
      explanation: "No heuristic rules triggered. Transaction appears normal.",
      recommendedAction: "NONE",
      heuristicScore: 0,
      llmScore: null,
      llmConfidence: null,
      llmUsed: false,
      triggeredRules: [],
      transaction: tx,
      assessedAt: timestamp,
    };
  }

  // Layer 2: LLM Analysis (only if heuristic score > threshold)
  if (heuristicResult.score > config.heuristicThreshold) {
    try {
      const llmAnalysis = await analyzeThreatWithLLM(
        tx,
        heuristicResult,
        context,
        config.claudeApiKey,
        config.llmTimeoutMs
      );

      const rawScore = heuristicResult.score * 0.4 + llmAnalysis.threatScore * 0.6;
      const confidenceMultiplier = llmAnalysis.confidence / 100;
      const adjustedScore = Math.round(
        rawScore * confidenceMultiplier +
        heuristicResult.score * (1 - confidenceMultiplier)
      );
      const finalScore = Math.min(adjustedScore, 100);

      return {
        score: finalScore,
        classification: llmAnalysis.classification,
        attackType: llmAnalysis.attackType,
        explanation: llmAnalysis.explanation,
        recommendedAction: llmAnalysis.recommendedAction,
        heuristicScore: heuristicResult.score,
        llmScore: llmAnalysis.threatScore,
        llmConfidence: llmAnalysis.confidence,
        llmUsed: true,
        triggeredRules: heuristicResult.triggeredRules,
        transaction: tx,
        assessedAt: timestamp,
      };
    } catch (error) {
      logger.warn(
        `LLM analysis failed for tx ${tx.hash}, falling back to heuristic-only. ` +
        `Heuristic score: ${heuristicResult.score}`
      );
      return buildHeuristicOnlyAssessment(tx, heuristicResult, timestamp);
    }
  }

  return buildHeuristicOnlyAssessment(tx, heuristicResult, timestamp);
}

function buildHeuristicOnlyAssessment(
  tx: TransactionData,
  heuristicResult: { score: number; triggeredRules: string[] },
  timestamp: number
): ThreatAssessment {
  let classification: ThreatAssessment["classification"];
  let recommendedAction: ThreatAssessment["recommendedAction"];

  if (heuristicResult.score >= 80) {
    classification = "CRITICAL_THREAT";
    recommendedAction = "EMERGENCY_WITHDRAW";
  } else if (heuristicResult.score >= 60) {
    classification = "PROBABLE_THREAT";
    recommendedAction = "ALERT";
  } else if (heuristicResult.score >= 30) {
    classification = "SUSPICIOUS";
    recommendedAction = "MONITOR";
  } else {
    classification = "NORMAL";
    recommendedAction = "NONE";
  }

  return {
    score: heuristicResult.score,
    classification,
    attackType: "UNKNOWN",
    explanation: `Heuristic-only assessment. Triggered rules: ${heuristicResult.triggeredRules.join(", ")}`,
    recommendedAction,
    heuristicScore: heuristicResult.score,
    llmScore: null,
    llmConfidence: null,
    llmUsed: false,
    triggeredRules: heuristicResult.triggeredRules,
    transaction: tx,
    assessedAt: timestamp,
  };
}
