import { ethers } from "ethers";
import { ThreatAssessment, ExecutorResult, AgentConfig } from "./types.js";
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

// ─── VaultTarget ────────────────────────────────────────────────────────────

/** A vault + registry pair that the executor can act on. */
interface VaultTarget {
  label: string; // "REVM" or "PVM"
  vault: ethers.Contract;
  registry: ethers.Contract;
}

// ─── Executor ───────────────────────────────────────────────────────────────

export class Executor {
  private wallet: ethers.Wallet;
  private targets: VaultTarget[] = [];
  private config: AgentConfig;
  private gasEstimator: GasPriorityEstimator;

  constructor(config: AgentConfig) {
    this.config = config;

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

  async execute(assessment: ThreatAssessment): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];

    const effectiveThreshold = assessment.llmUsed
      ? this.config.emergencyThreshold
      : 90;

    if (assessment.score >= effectiveThreshold) {
      // Execute emergency withdrawal on ALL vaults in parallel
      const withdrawResults = await Promise.all(
        this.targets.map((target) =>
          this.executeEmergencyWithdraw(assessment, target)
        )
      );
      results.push(...withdrawResults);
    }

    if (assessment.score > 50) {
      // Report threat to ALL registries in parallel
      const reportResults = await Promise.all(
        this.targets.map((target) =>
          this.reportThreat(assessment, target)
        )
      );
      results.push(...reportResults);
    }

    return results;
  }

  private async executeEmergencyWithdraw(
    assessment: ThreatAssessment,
    target: VaultTarget
  ): Promise<ExecutorResult> {
    try {
      const isCooldown = await target.vault.isCooldownActive();
      if (isCooldown) {
        logger.warn(`[${target.label}] Cooldown is active. Cannot execute emergency withdraw.`);
        return {
          success: false,
          error: "Cooldown active",
          action: "EMERGENCY_WITHDRAW_ALL",
          vmLabel: target.label,
        };
      }

      const guardian = await target.vault.guardian();
      if (guardian.toLowerCase() !== this.wallet.address.toLowerCase()) {
        logger.error(`[${target.label}] Agent is not the guardian of this vault!`);
        return {
          success: false,
          error: "Agent is not guardian",
          action: "EMERGENCY_WITHDRAW_ALL",
          vmLabel: target.label,
        };
      }

      const reason = `[ChainSentinel] Score: ${assessment.score}, ` +
        `Type: ${assessment.attackType}, ` +
        `Rules: ${assessment.triggeredRules.join("+")}`;

      logger.info(
        `[${target.label}] EXECUTING EMERGENCY WITHDRAW ALL - Score: ${assessment.score}, ` +
        `Tx: ${assessment.transaction.hash}`
      );

      // MEV-aware gas: higher threat score → higher priority fee
      const gasOverrides = await this.gasEstimator.estimateGasOverrides(assessment.score);

      const tx = await target.vault.emergencyWithdrawAll(
        assessment.score,
        reason,
        gasOverrides
      );

      const receipt = await tx.wait();

      logger.info(
        `[${target.label}] Emergency withdraw executed! Tx hash: ${receipt.hash}, ` +
        `Block: ${receipt.blockNumber}`
      );

      return {
        success: true,
        txHash: receipt.hash,
        action: "EMERGENCY_WITHDRAW_ALL",
        blockNumber: receipt.blockNumber,
        vmLabel: target.label,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[${target.label}] Emergency withdraw failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        action: "EMERGENCY_WITHDRAW_ALL",
        vmLabel: target.label,
      };
    }
  }

  private async reportThreat(
    assessment: ThreatAssessment,
    target: VaultTarget
  ): Promise<ExecutorResult> {
    try {
      const evidence = `tx:${assessment.transaction.hash}|score:${assessment.score}|rules:${assessment.triggeredRules.join(",")}`;

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
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`[${target.label}] Failed to report threat to registry: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        action: "REPORT_THREAT",
        vmLabel: target.label,
      };
    }
  }
}
