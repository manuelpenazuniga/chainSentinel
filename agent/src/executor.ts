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

export class Executor {
  private wallet: ethers.Wallet;
  private vault: ethers.Contract;
  private registry: ethers.Contract;
  private config: AgentConfig;
  private gasEstimator: GasPriorityEstimator;

  constructor(config: AgentConfig) {
    this.config = config;

    const provider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: "polkadot-hub-testnet",
    });

    this.wallet = new ethers.Wallet(config.agentPrivateKey, provider);
    this.vault = new ethers.Contract(config.vaultAddress, VAULT_ABI, this.wallet);
    this.registry = new ethers.Contract(config.registryAddress, REGISTRY_ABI, this.wallet);
    this.gasEstimator = new GasPriorityEstimator(provider);

    logger.info(`Executor initialized. Agent address: ${this.wallet.address}`);
  }

  /** Expose the gas estimator so the monitor can feed it block data. */
  getGasEstimator(): GasPriorityEstimator {
    return this.gasEstimator;
  }

  async execute(assessment: ThreatAssessment): Promise<ExecutorResult[]> {
    const results: ExecutorResult[] = [];

    const effectiveThreshold = assessment.llmUsed
      ? this.config.emergencyThreshold
      : 90;

    if (assessment.score >= effectiveThreshold) {
      const withdrawResult = await this.executeEmergencyWithdraw(assessment);
      results.push(withdrawResult);
    }

    if (assessment.score > 50) {
      const reportResult = await this.reportThreat(assessment);
      results.push(reportResult);
    }

    return results;
  }

  private async executeEmergencyWithdraw(assessment: ThreatAssessment): Promise<ExecutorResult> {
    try {
      const isCooldown = await this.vault.isCooldownActive();
      if (isCooldown) {
        logger.warn("Cooldown is active. Cannot execute emergency withdraw.");
        return {
          success: false,
          error: "Cooldown active",
          action: "EMERGENCY_WITHDRAW_ALL",
        };
      }

      const guardian = await this.vault.guardian();
      if (guardian.toLowerCase() !== this.wallet.address.toLowerCase()) {
        logger.error("Agent is not the guardian of this vault!");
        return {
          success: false,
          error: "Agent is not guardian",
          action: "EMERGENCY_WITHDRAW_ALL",
        };
      }

      const reason = `[ChainSentinel] Score: ${assessment.score}, ` +
        `Type: ${assessment.attackType}, ` +
        `Rules: ${assessment.triggeredRules.join("+")}`;

      logger.info(
        `EXECUTING EMERGENCY WITHDRAW ALL - Score: ${assessment.score}, ` +
        `Tx: ${assessment.transaction.hash}`
      );

      // MEV-aware gas: higher threat score → higher priority fee
      const gasOverrides = await this.gasEstimator.estimateGasOverrides(assessment.score);

      const tx = await this.vault.emergencyWithdrawAll(
        assessment.score,
        reason,
        gasOverrides
      );

      const receipt = await tx.wait();

      logger.info(
        `Emergency withdraw executed! Tx hash: ${receipt.hash}, ` +
        `Block: ${receipt.blockNumber}`
      );

      return {
        success: true,
        txHash: receipt.hash,
        action: "EMERGENCY_WITHDRAW_ALL",
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Emergency withdraw failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        action: "EMERGENCY_WITHDRAW_ALL",
      };
    }
  }

  private async reportThreat(assessment: ThreatAssessment): Promise<ExecutorResult> {
    try {
      const evidence = `tx:${assessment.transaction.hash}|score:${assessment.score}|rules:${assessment.triggeredRules.join(",")}`;

      const tx = await this.registry.reportThreat(
        assessment.transaction.to,
        assessment.score,
        assessment.attackType,
        evidence
      );

      const receipt = await tx.wait();

      logger.info(
        `Threat reported to registry. Target: ${assessment.transaction.to}, ` +
        `Score: ${assessment.score}, Tx: ${receipt.hash}`
      );

      return {
        success: true,
        txHash: receipt.hash,
        action: "REPORT_THREAT",
        blockNumber: receipt.blockNumber,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to report threat to registry: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        action: "REPORT_THREAT",
      };
    }
  }
}
