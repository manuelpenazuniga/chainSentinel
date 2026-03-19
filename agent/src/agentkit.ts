import { ethers } from "ethers";
import { createLogger } from "./logger.js";
import { AgentConfig } from "./types.js";

const logger = createLogger("agentkit");

/**
 * Polkadot Agent Kit integration layer.
 *
 * Provides blockchain utility functions that complement the core agent.
 * Currently implements balance checking, token transfer helpers, and
 * transaction building using ethers.js directly.
 *
 * When @polkadot-agent-kit/sdk is installed, this module can be extended
 * to use LangChain-compatible tools for more sophisticated on-chain
 * interactions (XCM transfers, staking, governance).
 *
 * Install: npm install @polkadot-agent-kit/sdk
 */
export class AgentKitWrapper {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private config: AgentConfig;

  constructor(config: AgentConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: "polkadot-hub-testnet",
    });
    this.wallet = new ethers.Wallet(config.agentPrivateKey, this.provider);

    logger.info(`AgentKit initialized — agent address: ${this.wallet.address}`);
  }

  /** Get the agent's wallet address */
  getAddress(): string {
    return this.wallet.address;
  }

  /** Check native PAS balance of any address */
  async getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  /** Check if the agent has enough gas to execute transactions */
  async hasEnoughGas(minBalance: bigint = ethers.parseEther("0.01")): Promise<boolean> {
    const balance = await this.getBalance(this.wallet.address);
    const sufficient = balance >= minBalance;

    if (!sufficient) {
      logger.warn(
        `Agent gas balance low: ${ethers.formatEther(balance)} PAS (need ${ethers.formatEther(minBalance)} PAS)`
      );
    }

    return sufficient;
  }

  /** Get current block number */
  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /** Get the chain ID to verify we're on the right network */
  async verifyNetwork(): Promise<boolean> {
    const network = await this.provider.getNetwork();
    const expected = BigInt(this.config.chainId);
    const actual = network.chainId;

    if (actual !== expected) {
      logger.error(`Network mismatch: expected chain ${expected}, got ${actual}`);
      return false;
    }

    logger.info(`Network verified: chain ID ${actual}`);
    return true;
  }

  /** Read an ERC-20 token balance */
  async getTokenBalance(tokenAddress: string, holder: string): Promise<bigint> {
    const erc20 = new ethers.Contract(
      tokenAddress,
      ["function balanceOf(address) view returns (uint256)"],
      this.provider
    );
    return erc20.balanceOf(holder);
  }

  /** Check if a contract exists at the given address */
  async isContract(address: string): Promise<boolean> {
    const code = await this.provider.getCode(address);
    return code !== "0x";
  }

  /** Estimate gas for a transaction to check feasibility before executing */
  async estimateGas(to: string, data: string): Promise<bigint | null> {
    try {
      return await this.provider.estimateGas({
        from: this.wallet.address,
        to,
        data,
      });
    } catch {
      return null;
    }
  }

  /**
   * Get formatted status summary of the agent's on-chain state.
   * Useful for logging and Telegram status reports.
   */
  async getStatusSummary(): Promise<string> {
    const balance = await this.getBalance(this.wallet.address);
    const block = await this.getBlockNumber();
    const networkOk = await this.verifyNetwork();

    return [
      `Agent: ${this.wallet.address}`,
      `Balance: ${ethers.formatEther(balance)} PAS`,
      `Block: #${block}`,
      `Network: ${networkOk ? "OK" : "MISMATCH"}`,
    ].join("\n");
  }
}
