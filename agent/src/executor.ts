import { ethers } from "ethers";
import { ThreatAssessment, ExecutorResult, AgentConfig, EscalationLevel } from "./types.js";
import { GasPriorityEstimator } from "./gas-priority.js";
import { createLogger } from "./logger.js";

const logger = createLogger("executor");

const VAULT_ABI = [
  "function emergencyWithdraw(address token, uint256 threatScore, string reason) external",
  "function emergencyWithdrawAll(uint256 threatScore, string reason) external",
  "function threshold() view returns (uint256)",
  "function isCooldownActive() view returns (bool)",
  "function guardian() view returns (address)",
];

const REGISTRY_ABI = [
  "function reportThreat(address targetContract, uint256 threatScore, string attackType, string evidence) external",
];

// ─── Escalation Thresholds ─────────────────────────────────────────────────
//
//   Score 0-29   → no action (filtered before reaching executor)
//   Score 30-49  → MONITOR: log + alert (no on-chain action)
//   Score 50-69  → REPORT: reportThreat() to registry
//   Score 70-84  → DEFENSIVE_WITHDRAW: emergencyWithdraw(native) + report
//   Score 85+    → EMERGENCY_WITHDRAW_ALL: emergencyWithdrawAll() + report
//
// When the LLM was NOT used (heuristic-only fallback), the DEFENSIVE_WITHDRAW
// and EMERGENCY_WITHDRAW_ALL thresholds are raised by +5 each to reduce
// false-positive risk from heuristic-only assessments.

const ESCALATION_REPORT_THRESHOLD = 50;
const ESCALATION_DEFENSIVE_THRESHOLD = 70;
const ESCALATION_EMERGENCY_THRESHOLD = 85;

// Heuristic-only penalty: raise withdraw thresholds by this much when LLM was not used
const HEURISTIC_ONLY_PENALTY = 5;

// ─── VaultTarget ────────────────────────────────────────────────────────────

/** A vault + registry pair that the executor can act on. */
interface VaultTarget {
  label: string; // "REVM" or "PVM"
  vault: ethers.Contract;
  registry: ethers.Contract;
}

// ─── Exported helpers (for testing) ─────────────────────────────────────────

/**
 * Determine the escalation level for a given assessment.
 *
 * Exported as a pure function so it can be unit-tested without mocking
 * contracts or providers.
 */
export function determineEscalation(
  score: number,
  llmUsed: boolean
): EscalationLevel {
  const defensiveThreshold = llmUsed
    ? ESCALATION_DEFENSIVE_THRESHOLD
    : ESCALATION_DEFENSIVE_THRESHOLD + HEURISTIC_ONLY_PENALTY;

  const emergencyThreshold = llmUsed
    ? ESCALATION_EMERGENCY_THRESHOLD
    : ESCALATION_EMERGENCY_THRESHOLD + HEURISTIC_ONLY_PENALTY;

  if (score >= emergencyThreshold) return "EMERGENCY_WITHDRAW_ALL";
  if (score >= defensiveThreshold) return "DEFENSIVE_WITHDRAW";
  if (score >= ESCALATION_REPORT_THRESHOLD) return "REPORT";
  return "MONITOR";
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class Executor {
  private wallet: ethers.Wallet;
  private targets: VaultTarget[] = [];
  private gasEstimator: GasPriorityEstimator;

  constructor(config: AgentConfig) {
    const provider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: "polkadot-hub-testnet",
    });

    this.wallet = new ethers.Wallet(config.agentPrivateKey, provider);
    this.gasEstimator = new GasPriorityEstimator(provider);

    // Primary vault (REVM)
    this.targets.push({
      label: "REVM",
      vault: new ethers.Contract(config.vaultAddress, VAULT_ABI, this.wallet),
      registry: new ethers.Contract(config.registryAddress, REGISTRY_ABI, this.wallet),
    });

    // PVM vault (optional — only if configured)
    if (config.vaultAddressPvm && config.registryAddressPvm) {
      this.targets.push({
        label: "PVM",
        vault: new ethers.Contract(config.vaultAddressPvm, VAULT_ABI, this.wallet),
        registry: new ethers.Contract(config.registryAddressPvm, REGISTRY_ABI, this.wallet),
      });
      logger.info(
        `Dual-VM executor: REVM=${config.vaultAddress.slice(0, 10)}... ` +
        `PVM=${config.vaultAddressPvm.slice(0, 10)}...`
      );
    }

    logger.info(
      `Executor initialized. Agent: ${this.wallet.address}, ` +
      `vaults: ${this.targets.map((t) => t.label).join("+")}`
    );
  }

  /** Expose the gas estimator so the monitor can feed it block data. */
  getGasEstimator(): GasPriorityEstimator {
    return this.gasEstimator;
  }

  /** Returns the labels of all active vault targets. */
  getActiveVMs(): string[] {
    return this.targets.map((t) => t.label);
  }

  /**
   * Execute the appropriate response for a threat assessment using graduated
   * escalation. The escalation level is determined by the final score:
   *
   *   MONITOR               → no-op (caller handles alerting)
   *   REPORT                → reportThreat()
   *   DEFENSIVE_WITHDRAW    → emergencyWithdraw(native) + reportThreat()
   *   EMERGENCY_WITHDRAW_ALL→ emergencyWithdrawAll() + reportThreat()
   *
   * Every on-chain write is preceded by a simulation (eth_call dry-run).
   * If the simulation reverts, the action is skipped and the revert reason
   * is logged — no gas is wasted.
   */
  async execute(assessment: ThreatAssessment): Promise<ExecutorResult[]> {
    const escalation = determineEscalation(assessment.score, assessment.llmUsed);

    logger.info(
      `Escalation: ${escalation} (score=${assessment.score}, llmUsed=${assessment.llmUsed})`
    );

    if (escalation === "MONITOR") {
      return [];
    }

    const results: ExecutorResult[] = [];

    // ── Withdrawal actions (DEFENSIVE or EMERGENCY) ─────────────────────────
    if (escalation === "EMERGENCY_WITHDRAW_ALL") {
      const withdrawResults = await Promise.all(
        this.targets.map((target) =>
          this.executeEmergencyWithdrawAll(assessment, target)
        )
      );
      results.push(...withdrawResults);
    } else if (escalation === "DEFENSIVE_WITHDRAW") {
      const withdrawResults = await Promise.all(
        this.targets.map((target) =>
          this.executeDefensiveWithdraw(assessment, target)
        )
      );
      results.push(...withdrawResults);
    }

    // ── Report to registry (REPORT, DEFENSIVE, and EMERGENCY) ───────────────
    const reportResults = await Promise.all(
      this.targets.map((target) =>
        this.reportThreat(assessment, target)
      )
    );
    results.push(...reportResults);

    return results;
  }

  // ─── Simulation Sandbox ─────────────────────────────────────────────────────
  //
  // Every on-chain write is preceded by a staticCall (eth_call) that executes
  // the transaction in a read-only EVM fork. If the simulation reverts we
  // capture the revert reason and skip the real transaction entirely.
  //
  // This prevents:
  //   1. Wasting gas on transactions that will revert (cooldown, not guardian)
  //   2. Silent failures that only surface in transaction receipts
  //   3. Race conditions where state changed between decision and execution

  /**
   * Simulate a contract call via eth_call. Returns null on success, or the
   * revert reason string on failure.
   */
  private async simulate(
    contract: ethers.Contract,
    method: string,
    args: unknown[],
    label: string
  ): Promise<string | null> {
    try {
      await contract[method].staticCall(...args);
      logger.info(`[${label}] Simulation OK: ${method}`);
      return null;
    } catch (error) {
      const reason = this.extractRevertReason(error);
      logger.warn(`[${label}] Simulation REVERTED: ${method} - ${reason}`);
      return reason;
    }
  }

  /**
   * Extract a human-readable revert reason from an ethers error.
   */
  private extractRevertReason(error: unknown): string {
    if (error instanceof Error) {
      // ethers v6 embeds revert data in the error message
      const msg = error.message;

      // Custom error: e.g. CooldownActive(100, 110)
      const customMatch = msg.match(/reverted with custom error '([^']+)'/);
      if (customMatch) return customMatch[1];

      // Reason string: e.g. "Native transfer failed"
      const reasonMatch = msg.match(/reverted with reason string '([^']+)'/);
      if (reasonMatch) return reasonMatch[1];

      // Panic code
      const panicMatch = msg.match(/reverted with panic code (\w+)/);
      if (panicMatch) return `Panic(${panicMatch[1]})`;

      return msg.slice(0, 200);
    }
    return String(error).slice(0, 200);
  }

  // ─── Emergency Withdraw ALL ─────────────────────────────────────────────────

  private async executeEmergencyWithdrawAll(
    assessment: ThreatAssessment,
    target: VaultTarget
  ): Promise<ExecutorResult> {
    const reason = this.buildReason(assessment);
    const gasOverrides = await this.gasEstimator.estimateGasOverrides(assessment.score);

    // ── Simulate first ────────────────────────────────────────────────────
    const revertReason = await this.simulate(
      target.vault,
      "emergencyWithdrawAll",
      [assessment.score, reason, gasOverrides],
      target.label
    );

    if (revertReason) {
      return {
        success: false,
        error: `Simulation reverted: ${revertReason}`,
        action: "EMERGENCY_WITHDRAW_ALL",
        vmLabel: target.label,
        simulated: true,
      };
    }

    // ── Execute for real ──────────────────────────────────────────────────
    try {
      logger.info(
        `[${target.label}] EXECUTING EMERGENCY WITHDRAW ALL - Score: ${assessment.score}, ` +
        `Tx: ${assessment.transaction.hash}`
      );

      const tx = await target.vault.emergencyWithdrawAll(
        assessment.score,
        reason,
        gasOverrides
      );

      const receipt = await tx.wait();

      logger.info(
        `[${target.label}] Emergency withdraw ALL executed! Tx hash: ${receipt.hash}, ` +
        `Block: ${receipt.blockNumber}`
      );

      return {
        success: true,
        txHash: receipt.hash,
        action: "EMERGENCY_WITHDRAW_ALL",
        blockNumber: receipt.blockNumber,
        vmLabel: target.label,
        simulated: true,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[${target.label}] Emergency withdraw ALL failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        action: "EMERGENCY_WITHDRAW_ALL",
        vmLabel: target.label,
        simulated: true,
      };
    }
  }

  // ─── Defensive Withdraw (native token only) ────────────────────────────────

  private async executeDefensiveWithdraw(
    assessment: ThreatAssessment,
    target: VaultTarget
  ): Promise<ExecutorResult> {
    const reason = this.buildReason(assessment);
    const nativeToken = ethers.ZeroAddress;
    const gasOverrides = await this.gasEstimator.estimateGasOverrides(assessment.score);

    // ── Simulate first ────────────────────────────────────────────────────
    const revertReason = await this.simulate(
      target.vault,
      "emergencyWithdraw",
      [nativeToken, assessment.score, reason, gasOverrides],
      target.label
    );

    if (revertReason) {
      return {
        success: false,
        error: `Simulation reverted: ${revertReason}`,
        action: "EMERGENCY_WITHDRAW",
        vmLabel: target.label,
        simulated: true,
      };
    }

    // ── Execute for real ──────────────────────────────────────────────────
    try {
      logger.info(
        `[${target.label}] EXECUTING DEFENSIVE WITHDRAW (native token) - Score: ${assessment.score}, ` +
        `Tx: ${assessment.transaction.hash}`
      );

      const tx = await target.vault.emergencyWithdraw(
        nativeToken,
        assessment.score,
        reason,
        gasOverrides
      );

      const receipt = await tx.wait();

      logger.info(
        `[${target.label}] Defensive withdraw executed! Tx hash: ${receipt.hash}, ` +
        `Block: ${receipt.blockNumber}`
      );

      return {
        success: true,
        txHash: receipt.hash,
        action: "EMERGENCY_WITHDRAW",
        blockNumber: receipt.blockNumber,
        vmLabel: target.label,
        simulated: true,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[${target.label}] Defensive withdraw failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        action: "EMERGENCY_WITHDRAW",
        vmLabel: target.label,
        simulated: true,
      };
    }
  }

  // ─── Report Threat ──────────────────────────────────────────────────────────

  private async reportThreat(
    assessment: ThreatAssessment,
    target: VaultTarget
  ): Promise<ExecutorResult> {
    const evidence = `tx:${assessment.transaction.hash}|score:${assessment.score}|rules:${assessment.triggeredRules.join(",")}`;

    // ── Simulate first ────────────────────────────────────────────────────
    const revertReason = await this.simulate(
      target.registry,
      "reportThreat",
      [assessment.transaction.to, assessment.score, assessment.attackType, evidence],
      target.label
    );

    if (revertReason) {
      logger.warn(`[${target.label}] Report simulation reverted: ${revertReason}`);
      return {
        success: false,
        error: `Simulation reverted: ${revertReason}`,
        action: "REPORT_THREAT",
        vmLabel: target.label,
        simulated: true,
      };
    }

    // ── Execute for real ──────────────────────────────────────────────────
    try {
      const tx = await target.registry.reportThreat(
        assessment.transaction.to,
        assessment.score,
        assessment.attackType,
        evidence
      );

      const receipt = await tx.wait();

      logger.info(
        `[${target.label}] Threat reported to registry. Target: ${assessment.transaction.to}, ` +
        `Score: ${assessment.score}, Tx: ${receipt.hash}`
      );

      return {
        success: true,
        txHash: receipt.hash,
        action: "REPORT_THREAT",
        blockNumber: receipt.blockNumber,
        vmLabel: target.label,
        simulated: true,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`[${target.label}] Failed to report threat to registry: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        action: "REPORT_THREAT",
        vmLabel: target.label,
        simulated: true,
      };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private buildReason(assessment: ThreatAssessment): string {
    return (
      `[ChainSentinel] Score: ${assessment.score}, ` +
      `Type: ${assessment.attackType}, ` +
      `Rules: ${assessment.triggeredRules.join("+")}`
    );
  }
}
