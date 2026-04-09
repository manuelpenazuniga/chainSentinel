// ============================================================================
// ChainSentinel — Threat Analyzer (Dual-Layer Orchestrator)
// ============================================================================
//
// Orchestrates the two-layer detection pipeline:
//
//   Layer 1 — Heuristics (always runs, ~1ms)
//     Deterministic rules applied to the raw transaction. If the score is 0
//     the transaction is immediately classified as NORMAL and the LLM is
//     never invoked (filters ~90% of transactions at zero API cost).
//
//   Layer 2 — LLM Analysis (runs when heuristicScore >= heuristicThreshold)
//     Gemini 2.5 Flash is given the full transaction context, historical data,
//     and triggered rules. Its output is blended with the heuristic score
//     using an asymmetric formula that preserves strong signals from either layer.
//
// ── Score Blending Formula ───────────────────────────────────────────────────
//
//  The key insight: the two layers can disagree in two meaningful ways.
//
//  Case A — LLM score > heuristic score
//    The model detected a pattern that the rules underweighted (e.g. complex
//    multi-step attack not yet covered by a dedicated rule). Trust the LLM
//    proportionally to its confidence, but never drop below the heuristic floor.
//
//      finalScore = max(heuristic, round(llm × cf + heuristic × (1 - cf)))
//
//  Case B — LLM score ≤ heuristic score
//    The deterministic rules caught something clear (e.g. BLACKLISTED_ENTITY +
//    FLASH_LOAN). The LLM acts as a corroborator. Heuristics get 70% weight.
//    If LLM confidence is below 50% the score is further pulled toward the
//    heuristic baseline to avoid false positives.
//
//      base        = round(heuristic × 0.7 + llm × 0.3)
//      finalScore  = (cf < 0.5) ? round(heuristic × 0.85 + base × 0.15) : base
//
//  In both cases the result is clamped to [0, 100].
//
// ── Fallback Behaviour ───────────────────────────────────────────────────────
//
//  If the LLM API times out or returns malformed JSON the function falls back
//  to heuristic-only scoring with a raised conservative threshold (+10 over the
//  normal emergency threshold). This is logged as a WARNING.
// ============================================================================

import { TransactionData, ThreatAssessment, MonitorContextInterface, AgentConfig } from "./types.js";
import { calculateHeuristicScore } from "./heuristics.js";
import { analyzeThreatWithLLM } from "./llm.js";
import { createLogger } from "./logger.js";

const logger = createLogger("analyzer");

// ─── Score Blending ───────────────────────────────────────────────────────────

/**
 * Blend heuristic and LLM scores using an asymmetric formula that preserves
 * the strongest signal from either layer.
 *
 * @param heuristicScore - Raw score from the heuristic engine (0-100).
 * @param llmScore       - Threat score reported by the LLM (0-100).
 * @param confidence     - LLM self-reported confidence (0-100).
 * @returns              Blended final score clamped to [0, 100].
 */
export function computeFinalScore(
  heuristicScore: number,
  llmScore: number,
  confidence: number
): number {
  const cf = confidence / 100;

  let finalScore: number;

  if (llmScore > heuristicScore) {
    // Case A: LLM sees more threat than heuristics.
    // Trust the LLM in proportion to its confidence, floored at the heuristic.
    finalScore = Math.max(
      heuristicScore,
      Math.round(llmScore * cf + heuristicScore * (1 - cf))
    );
  } else {
    // Case B: Heuristics caught the stronger signal; LLM corroborates.
    const base = Math.round(heuristicScore * 0.7 + llmScore * 0.3);

    // Low-confidence LLM: pull the result closer to the heuristic baseline
    // to reduce false-positive risk.
    finalScore = cf < 0.5
      ? Math.round(heuristicScore * 0.85 + base * 0.15)
      : base;
  }

  return Math.min(finalScore, 100);
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Analyse a single transaction through the dual-layer pipeline and return a
 * complete ThreatAssessment.
 *
 * @param tx      - Enriched transaction from the block monitor.
 * @param context - MonitorContext snapshot for this block (pre-update state).
 * @param config  - Agent configuration (thresholds, API keys, timeouts).
 */
export async function analyzeTransaction(
  tx: TransactionData,
  context: MonitorContextInterface,
  config: AgentConfig
): Promise<ThreatAssessment> {
  const timestamp = Date.now();

  // ── Layer 1: Heuristics ─────────────────────────────────────────────────────
  const heuristicResult = calculateHeuristicScore(tx, context);

  // Fast path: nothing triggered — skip LLM entirely
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

  // ── Layer 2: LLM Analysis ───────────────────────────────────────────────────
  if (heuristicResult.score >= config.heuristicThreshold) {
    try {
      const llmAnalysis = await analyzeThreatWithLLM(
        tx,
        heuristicResult,
        context,
        config.geminiApiKey,
        config.llmTimeoutMs
      );

      const finalScore = computeFinalScore(
        heuristicResult.score,
        llmAnalysis.threatScore,
        llmAnalysis.confidence
      );

      logger.info(
        `Final score for tx ${tx.hash}: ${finalScore} ` +
          `(heuristic=${heuristicResult.score}, llm=${llmAnalysis.threatScore}, ` +
          `confidence=${llmAnalysis.confidence}%)`
      );

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
        `LLM analysis failed for tx ${tx.hash} — falling back to heuristic-only. ` +
          `Heuristic score: ${heuristicResult.score}`,
        error
      );
      return buildHeuristicOnlyAssessment(tx, heuristicResult, timestamp);
    }
  }

  // Heuristic score below LLM trigger threshold — return heuristic-only result
  return buildHeuristicOnlyAssessment(tx, heuristicResult, timestamp);
}

// ─── Heuristic-Only Assessment ────────────────────────────────────────────────

/**
 * Build a ThreatAssessment from heuristic data alone.
 * Used when: score < heuristicThreshold, or as LLM fallback.
 */
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
