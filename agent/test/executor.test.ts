import { describe, it, expect } from "vitest";
import { determineEscalation } from "../src/executor.js";
import type { EscalationLevel } from "../src/types.js";

// ─── determineEscalation ────────────────────────────────────────────────────
//
// Thresholds (with LLM):
//   0-49   → MONITOR
//   50-69  → REPORT
//   70-84  → DEFENSIVE_WITHDRAW
//   85+    → EMERGENCY_WITHDRAW_ALL
//
// Without LLM (heuristic-only penalty +5 on withdraw thresholds):
//   0-49   → MONITOR
//   50-74  → REPORT
//   75-89  → DEFENSIVE_WITHDRAW
//   90+    → EMERGENCY_WITHDRAW_ALL

describe("determineEscalation", () => {
  // ── With LLM (normal thresholds) ────────────────────────────────────────

  describe("with LLM used (llmUsed=true)", () => {
    it("returns MONITOR for score 0", () => {
      expect(determineEscalation(0, true)).toBe("MONITOR");
    });

    it("returns MONITOR for score 29", () => {
      expect(determineEscalation(29, true)).toBe("MONITOR");
    });

    it("returns MONITOR for score 49", () => {
      expect(determineEscalation(49, true)).toBe("MONITOR");
    });

    it("returns REPORT for score 50", () => {
      expect(determineEscalation(50, true)).toBe("REPORT");
    });

    it("returns REPORT for score 69", () => {
      expect(determineEscalation(69, true)).toBe("REPORT");
    });

    it("returns DEFENSIVE_WITHDRAW for score 70", () => {
      expect(determineEscalation(70, true)).toBe("DEFENSIVE_WITHDRAW");
    });

    it("returns DEFENSIVE_WITHDRAW for score 84", () => {
      expect(determineEscalation(84, true)).toBe("DEFENSIVE_WITHDRAW");
    });

    it("returns EMERGENCY_WITHDRAW_ALL for score 85", () => {
      expect(determineEscalation(85, true)).toBe("EMERGENCY_WITHDRAW_ALL");
    });

    it("returns EMERGENCY_WITHDRAW_ALL for score 100", () => {
      expect(determineEscalation(100, true)).toBe("EMERGENCY_WITHDRAW_ALL");
    });
  });

  // ── Without LLM (raised thresholds: +5 for withdraw levels) ─────────────

  describe("without LLM (llmUsed=false, +5 penalty)", () => {
    it("returns MONITOR for score 49", () => {
      expect(determineEscalation(49, false)).toBe("MONITOR");
    });

    it("returns REPORT for score 50", () => {
      // REPORT threshold is unchanged (50)
      expect(determineEscalation(50, false)).toBe("REPORT");
    });

    it("returns REPORT for score 70", () => {
      // Without LLM, 70 is below DEFENSIVE threshold (75)
      expect(determineEscalation(70, false)).toBe("REPORT");
    });

    it("returns REPORT for score 74", () => {
      expect(determineEscalation(74, false)).toBe("REPORT");
    });

    it("returns DEFENSIVE_WITHDRAW for score 75", () => {
      // 70 + 5 penalty = 75
      expect(determineEscalation(75, false)).toBe("DEFENSIVE_WITHDRAW");
    });

    it("returns DEFENSIVE_WITHDRAW for score 85", () => {
      // Without LLM, 85 is still DEFENSIVE (emergency is 90)
      expect(determineEscalation(85, false)).toBe("DEFENSIVE_WITHDRAW");
    });

    it("returns DEFENSIVE_WITHDRAW for score 89", () => {
      expect(determineEscalation(89, false)).toBe("DEFENSIVE_WITHDRAW");
    });

    it("returns EMERGENCY_WITHDRAW_ALL for score 90", () => {
      // 85 + 5 penalty = 90
      expect(determineEscalation(90, false)).toBe("EMERGENCY_WITHDRAW_ALL");
    });

    it("returns EMERGENCY_WITHDRAW_ALL for score 100", () => {
      expect(determineEscalation(100, false)).toBe("EMERGENCY_WITHDRAW_ALL");
    });
  });

  // ── LLM penalty effect on boundary scores ──────────────────────────────

  describe("LLM penalty boundary effects", () => {
    it("score 70 with LLM → DEFENSIVE, without LLM → REPORT", () => {
      expect(determineEscalation(70, true)).toBe("DEFENSIVE_WITHDRAW");
      expect(determineEscalation(70, false)).toBe("REPORT");
    });

    it("score 85 with LLM → EMERGENCY, without LLM → DEFENSIVE", () => {
      expect(determineEscalation(85, true)).toBe("EMERGENCY_WITHDRAW_ALL");
      expect(determineEscalation(85, false)).toBe("DEFENSIVE_WITHDRAW");
    });

    it("score 90 → EMERGENCY regardless of LLM", () => {
      expect(determineEscalation(90, true)).toBe("EMERGENCY_WITHDRAW_ALL");
      expect(determineEscalation(90, false)).toBe("EMERGENCY_WITHDRAW_ALL");
    });

    it("score 50 → REPORT regardless of LLM (report threshold unaffected)", () => {
      expect(determineEscalation(50, true)).toBe("REPORT");
      expect(determineEscalation(50, false)).toBe("REPORT");
    });
  });

  // ── Escalation ordering ─────────────────────────────────────────────────

  describe("escalation is monotonically increasing with score", () => {
    const levels: EscalationLevel[] = [
      "MONITOR",
      "REPORT",
      "DEFENSIVE_WITHDRAW",
      "EMERGENCY_WITHDRAW_ALL",
    ];

    it("never decreases as score increases (with LLM)", () => {
      let prevIndex = 0;
      for (let score = 0; score <= 100; score++) {
        const level = determineEscalation(score, true);
        const index = levels.indexOf(level);
        expect(index).toBeGreaterThanOrEqual(prevIndex);
        prevIndex = index;
      }
    });

    it("never decreases as score increases (without LLM)", () => {
      let prevIndex = 0;
      for (let score = 0; score <= 100; score++) {
        const level = determineEscalation(score, false);
        const index = levels.indexOf(level);
        expect(index).toBeGreaterThanOrEqual(prevIndex);
        prevIndex = index;
      }
    });
  });
});
