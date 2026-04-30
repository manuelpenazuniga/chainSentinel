import { ethers } from "ethers";
import { createLogger } from "./logger.js";

const logger = createLogger("heartbeat");

const HEARTBEAT_ABI = [
  "function ping() external",
  "function isAlive() view returns (bool)",
  "function getStatus() view returns (address agent, uint256 lastPingBlock, uint256 lastPingTimestamp, uint256 pingCount, bool alive, uint256 blocksSinceLastPing)",
];

/**
 * On-chain heartbeat client for the SentinelHeartbeat contract.
 *
 * The agent calls `ping()` every `intervalBlocks` to prove liveness.
 * This is a lightweight watchdog that lets anyone verify on-chain
 * that the guardian agent is alive and monitoring.
 *
 * Gas cost: ~45K gas per ping (3 storage writes + 1 event).
 * At 50 blocks/interval (~5 min), that's ~13K pings/day → negligible cost on testnet.
 */
export class HeartbeatClient {
  private contract: ethers.Contract;
  private intervalBlocks: number;
  private lastPingBlock: number = 0;

  constructor(
    contractAddress: string,
    wallet: ethers.Wallet,
    intervalBlocks: number = 50
  ) {
    this.contract = new ethers.Contract(contractAddress, HEARTBEAT_ABI, wallet);
    this.intervalBlocks = intervalBlocks;

    logger.info(
      `Heartbeat client initialized. Contract: ${contractAddress.slice(0, 10)}..., ` +
      `interval: every ${intervalBlocks} blocks (~${Math.round(intervalBlocks * 6 / 60)} min)`
    );
  }

  /**
   * Called by the monitor on every new block. Sends a ping if enough blocks
   * have elapsed since the last one.
   *
   * Failures are logged but never propagated — heartbeat is best-effort
   * and must never interfere with threat detection.
   */
  async maybePing(currentBlock: number): Promise<void> {
    if (currentBlock - this.lastPingBlock < this.intervalBlocks) {
      return;
    }

    try {
      // Simulate first to avoid wasting gas
      await this.contract.ping.staticCall();

      const tx = await this.contract.ping();
      const receipt = await tx.wait();

      this.lastPingBlock = currentBlock;
      logger.info(
        `Heartbeat ping sent at block ${currentBlock}. ` +
        `Tx: ${receipt.hash}, gas: ${receipt.gasUsed.toString()}`
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      // Log but don't throw — heartbeat must never block threat detection
      logger.warn(`Heartbeat ping failed (non-fatal): ${msg.slice(0, 200)}`);
    }
  }

  /**
   * Check on-chain status of the heartbeat contract.
   * Useful for startup diagnostics.
   */
  async checkStatus(): Promise<{
    agent: string;
    lastPingBlock: number;
    pingCount: number;
    alive: boolean;
    blocksSinceLastPing: number;
  }> {
    const [agent, lastPingBlock, , pingCount, alive, blocksSinceLastPing] =
      await this.contract.getStatus();

    return {
      agent,
      lastPingBlock: Number(lastPingBlock),
      pingCount: Number(pingCount),
      alive,
      blocksSinceLastPing: Number(blocksSinceLastPing),
    };
  }
}
