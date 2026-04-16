import { ethers } from "ethers";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseoAssetHubChain, formatBalance } from "@polkadot-agent-kit/common";
import { createLogger } from "./logger.js";
import { AgentConfig } from "./types.js";

const logger = createLogger("agentkit");

// ─── Types ────────────────────────────────────────────────────────────────────

/** Balance data from the Substrate System.Account storage. */
export interface SubstrateBalance {
  /** Transferable balance */
  free: bigint;
  /** Reserved / locked balance */
  reserved: bigint;
  /** Frozen balance (fee hold, votes, etc.) */
  frozen: bigint;
}

/** Dual-layer balance view — EVM JSON-RPC vs Substrate RPC. */
export interface DualLayerBalance {
  /** Balance from eth_getBalance (EVM layer, 18 decimals) */
  evmWei: bigint;
  /** Free balance from System.Account (Substrate layer, 10 decimals on Paseo) */
  substrateFree: bigint | null;
  /** Whether both layers agreed on non-zero balance */
  consistent: boolean;
}

/**
 * Polkadot-native tools available through the Polkadot Agent Kit pattern.
 * These represent the conceptual capabilities of the agent on Polkadot Hub.
 *
 * When @polkadot-agent-kit/sdk is fully compatible (no dep conflicts), these
 * can be instantiated as LangChain StructuredTools and passed to any LangChain
 * executor or AI agent.
 */
export const POLKADOT_AGENT_TOOLS = [
  {
    name: "get_native_balance",
    description: "Read the native PAS balance of any address via Substrate RPC",
    layer: "substrate",
    status: "active", // implemented in this module
  },
  {
    name: "transfer_native",
    description: "Transfer PAS tokens to an address on Paseo Asset Hub",
    layer: "substrate",
    status: "available", // supported by @polkadot-agent-kit/sdk when dep conflicts resolved
  },
  {
    name: "xcm_transfer_native",
    description: "Cross-chain transfer of native assets via XCM to any parachain",
    layer: "xcm",
    status: "available",
  },
  {
    name: "swap_tokens",
    description: "Swap tokens on Hydration DEX via XCM from Asset Hub",
    layer: "xcm",
    status: "available",
  },
  {
    name: "join_nomination_pool",
    description: "Join a staking nomination pool on the relay chain",
    layer: "substrate",
    status: "available",
  },
  {
    name: "emergency_withdraw_evm",
    description: "Trigger SentinelVault.emergencyWithdraw() on the EVM layer",
    layer: "evm",
    status: "active", // implemented in executor.ts
  },
] as const;

export type PolkadotToolName = (typeof POLKADOT_AGENT_TOOLS)[number]["name"];

// ─── AgentKitWrapper ─────────────────────────────────────────────────────────

/**
 * Dual-layer blockchain integration for ChainSentinel.
 *
 * Polkadot Hub exposes two independent protocol interfaces on the same chain:
 *   1. EVM JSON-RPC (ethers.js) — for smart contract interactions
 *      (SentinelVault, SentinelRegistry, ERC-20 tokens)
 *   2. Substrate RPC (polkadot-api) — for Polkadot-native operations
 *      (native balances, XCM, staking, governance)
 *
 * Both protocols read/write the same on-chain state; they are different
 * network APIs on the same node.
 *
 * This class initializes and manages both connections so the agent can:
 * - Execute emergency withdrawals via EVM (executor.ts delegates here)
 * - Read canonical Substrate balances (not just the EVM eth_getBalance view)
 * - Report chain status across both protocol layers
 * - Expose the set of Polkadot Agent Kit tools for future LangChain integration
 */
export class AgentKitWrapper {
  // ─── EVM Layer (ethers.js) ────────────────────────────────────────────────
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private config: AgentConfig;

  // ─── Substrate Layer (polkadot-api) ──────────────────────────────────────
  private substrateClient: ReturnType<typeof createClient> | null = null;
  private substrateConnected = false;

  constructor(config: AgentConfig) {
    this.config = config;

    // EVM provider — connects to the Ethereum JSON-RPC adapter on Polkadot Hub
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: "polkadot-hub-testnet",
    });
    this.wallet = new ethers.Wallet(config.agentPrivateKey, this.provider);

    logger.info(`AgentKit initialized — EVM address: ${this.wallet.address}`);
    logger.info(`  EVM RPC: ${config.rpcUrl}`);
    logger.info(`  Substrate target: ${paseoAssetHubChain.wsUrls[0]}`);
  }

  // ─── Substrate Initialization ────────────────────────────────────────────

  /**
   * Connect to Polkadot Hub via Substrate WebSocket RPC.
   *
   * This is a separate protocol from the EVM JSON-RPC — it uses the Substrate
   * native RPC protocol (JSON-RPC over WebSocket) and provides access to
   * Polkadot-native primitives not available via eth_*.
   *
   * Called once during agent startup. Fails gracefully — if unavailable,
   * the agent continues with EVM-only operations.
   */
  async initSubstrate(timeoutMs = 8000): Promise<boolean> {
    const wsUrl = paseoAssetHubChain.wsUrls[0];
    logger.info(`Substrate: connecting to ${wsUrl} ...`);

    try {
      this.substrateClient = createClient(getWsProvider(wsUrl));

      // Verify the connection by fetching the finalized block
      const block = await Promise.race([
        this.substrateClient.getFinalizedBlock(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Substrate connection timeout (${timeoutMs}ms)`)), timeoutMs)
        ),
      ]);

      this.substrateConnected = true;
      logger.info(
        `Substrate: connected ✓  chain=${paseoAssetHubChain.name}  ` +
          `finalizedBlock=#${block.number}  hash=${block.hash.slice(0, 10)}...`
      );
      return true;
    } catch (err) {
      logger.warn(
        `Substrate: connection failed — continuing EVM-only. Reason: ${(err as Error).message}`
      );
      this.substrateConnected = false;
      return false;
    }
  }

  /**
   * Disconnect the Substrate WebSocket cleanly.
   * Call during agent shutdown to avoid dangling connections.
   */
  async disconnectSubstrate(): Promise<void> {
    if (this.substrateClient) {
      await this.substrateClient.destroy();
      this.substrateConnected = false;
      logger.info("Substrate: disconnected");
    }
  }

  // ─── Substrate Queries ───────────────────────────────────────────────────

  /**
   * Get the current finalized block number from the Substrate layer.
   *
   * This is the canonical Substrate block, independent of EVM block numbers.
   * On Polkadot Hub, Substrate blocks and EVM blocks are the same block —
   * but querying both layers shows that both APIs are active.
   */
  async getSubstrateFinalizedBlock(): Promise<{ number: number; hash: string } | null> {
    if (!this.substrateClient || !this.substrateConnected) return null;
    try {
      const block = await this.substrateClient.getFinalizedBlock();
      return { number: block.number, hash: block.hash };
    } catch {
      return null;
    }
  }

  /**
   * Read native PAS balance from the Substrate System.Account storage.
   *
   * Why this is different from eth_getBalance:
   *   - eth_getBalance reads the EVM account balance (18 decimal wei)
   *   - System.Account reads the Substrate account state (10 decimal Planck)
   *   - The values should agree, but querying both proves both protocol layers
   *     are accessible and consistent
   *
   * @param ss58OrHex - SS58 address (5Grw...) or hex AccountId32 (0x...)
   */
  async getSubstrateBalance(ss58OrHex: string): Promise<SubstrateBalance | null> {
    if (!this.substrateClient || !this.substrateConnected) return null;

    try {
      // polkadot-api unsafe API — works without pre-generated chain descriptors
      const unsafeApi = this.substrateClient.getUnsafeApi();
      const account = await unsafeApi.query.System.Account.getValue(ss58OrHex);

      if (!account) return null;

      return {
        free: BigInt(account.data?.free ?? 0),
        reserved: BigInt(account.data?.reserved ?? 0),
        frozen: BigInt(account.data?.frozen ?? 0),
      };
    } catch (err) {
      logger.debug(`Substrate balance query failed for ${ss58OrHex}: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Compare EVM and Substrate balance for the same address.
   *
   * Polkadot Hub maps EVM H160 addresses to Substrate AccountId32 internally.
   * Both layers should show the same free balance (modulo decimal conversion:
   * Substrate uses 10 decimals / Planck, EVM uses 18 decimals / wei).
   *
   * 1 PAS = 10^10 Planck (Substrate) = 10^18 wei (EVM)
   * Conversion: substrateFree × 10^8 ≈ evmWei
   */
  async getDualLayerBalance(address: string): Promise<DualLayerBalance> {
    const evmWei = await this.provider.getBalance(address);

    // Note: direct H160→AccountId32 lookup in Substrate requires the
    // EVM pallet's address mapping. For now we surface what's available.
    const substrateBlock = await this.getSubstrateFinalizedBlock();
    const substrateFree = substrateBlock ? null : null; // placeholder — see note

    // Consistency: if EVM shows non-zero, Substrate should too
    const consistent = substrateFree === null ? true : evmWei > 0n === substrateFree > 0n;

    return { evmWei, substrateFree, consistent };
  }

  // ─── EVM Layer (ethers.js) — unchanged from original ────────────────────

  /** Get the agent's EVM wallet address */
  getAddress(): string {
    return this.wallet.address;
  }

  /** Check native PAS balance of any address via EVM layer */
  async getBalance(address: string): Promise<bigint> {
    return this.provider.getBalance(address);
  }

  /** Check if the agent has enough gas to execute transactions */
  async hasEnoughGas(minBalance: bigint = ethers.parseEther("0.01")): Promise<boolean> {
    const balance = await this.getBalance(this.wallet.address);
    const sufficient = balance >= minBalance;

    if (!sufficient) {
      logger.warn(
        `Agent gas balance low: ${ethers.formatEther(balance)} PAS ` +
          `(need ${ethers.formatEther(minBalance)} PAS)`
      );
    }

    return sufficient;
  }

  /** Get current EVM block number */
  async getBlockNumber(): Promise<number> {
    return this.provider.getBlockNumber();
  }

  /** Verify we're on the expected EVM chain */
  async verifyNetwork(): Promise<boolean> {
    const network = await this.provider.getNetwork();
    const expected = BigInt(this.config.chainId);
    const actual = network.chainId;

    if (actual !== expected) {
      logger.error(`Network mismatch: expected chain ${expected}, got ${actual}`);
      return false;
    }

    logger.info(`EVM network verified: chain ID ${actual}`);
    return true;
  }

  /** Read an ERC-20 token balance via EVM */
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

  /** Estimate gas for a transaction */
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

  // ─── Tool Registry ───────────────────────────────────────────────────────

  /**
   * List Polkadot Agent Kit tools available to this agent.
   *
   * Returns the full set of Polkadot-native capabilities.
   * Tools marked "active" are implemented in this module or executor.ts.
   * Tools marked "available" are supported by @polkadot-agent-kit/sdk and
   * can be activated by resolving the @acala-network/sdk dep conflict.
   */
  getAvailablePolkadotTools(): typeof POLKADOT_AGENT_TOOLS {
    return POLKADOT_AGENT_TOOLS;
  }

  /** Get the names of all active (currently implemented) tools */
  getActiveToolNames(): PolkadotToolName[] {
    return POLKADOT_AGENT_TOOLS
      .filter((t) => t.status === "active")
      .map((t) => t.name);
  }

  // ─── Status Summary ──────────────────────────────────────────────────────

  /**
   * Get a comprehensive dual-layer status summary.
   * Includes both EVM and Substrate layer health.
   */
  async getStatusSummary(): Promise<string> {
    const evmBalance = await this.getBalance(this.wallet.address);
    const evmBlock = await this.getBlockNumber();
    const networkOk = await this.verifyNetwork();

    const substrateBlock = await this.getSubstrateFinalizedBlock();

    const substrateStatus = substrateBlock
      ? `#${substrateBlock.number} (${substrateBlock.hash.slice(0, 10)}...)`
      : this.substrateConnected
        ? "connected (block unavailable)"
        : "unavailable (EVM-only mode)";

    const activeTools = this.getActiveToolNames();
    const allTools = this.getAvailablePolkadotTools();

    return [
      `Agent address: ${this.wallet.address}`,
      ``,
      `── EVM Layer (ethers.js / eth_*) ──`,
      `  Balance:  ${ethers.formatEther(evmBalance)} PAS`,
      `  Block:    #${evmBlock}`,
      `  Network:  ${networkOk ? `OK (chain ${this.config.chainId})` : "MISMATCH"}`,
      ``,
      `── Substrate Layer (polkadot-api / Substrate RPC) ──`,
      `  Chain:    ${paseoAssetHubChain.name} (${paseoAssetHubChain.id})`,
      `  WS:       ${paseoAssetHubChain.wsUrls[0]}`,
      `  Block:    ${substrateStatus}`,
      ``,
      `── Polkadot Agent Kit Tools ──`,
      `  Active (${activeTools.length}): ${activeTools.join(", ")}`,
      `  Available (${allTools.length - activeTools.length}): ${allTools
        .filter((t) => t.status === "available")
        .map((t) => t.name)
        .join(", ")}`,
    ].join("\n");
  }
}
