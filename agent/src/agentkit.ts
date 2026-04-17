import { ethers } from "ethers";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseoAssetHubChain } from "@polkadot-agent-kit/common";
import { fromBufferToBase58 } from "@polkadot-api/substrate-bindings";
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

// ─── H160 → AccountId32 mapping (pallet-revive) ──────────────────────────────

/**
 * Convert an EVM H160 address (0x + 40 hex) to the AccountId32 used by
 * pallet-revive on Polkadot Hub.
 *
 * Scheme (deterministic fallback mapping, no hashing):
 *   AccountId32 = h160_bytes ‖ 0xEE × 12
 *
 * Source: `substrate/frame/revive/src/address.rs` —
 *   `AccountId32Mapper::to_fallback_account_id` in polkadot-sdk.
 *
 * The trailing 12 bytes of `0xEE` are the on-chain marker that the
 * AccountId32 originated as an Ethereum H160 (pallet-revive uses the
 * same pattern in reverse to identify EVM-derived accounts).
 *
 * NOT to be confused with Frontier's scheme (`blake2_256("evm:" ‖ h160)`),
 * which is used by pallet-evm on Moonbeam/Astar but NOT on Polkadot Hub.
 *
 * @param h160 - EVM address, e.g. "0xED0f50f714b1297ebCb5BD64484966DCE32717d1"
 * @returns    32-byte hex string, e.g. "0xed0f...17d1eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
 */
export function h160ToAccountId32(h160: string): string {
  const cleaned = h160.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(cleaned)) {
    throw new Error(`Invalid H160 address (expected 0x + 40 hex chars): ${h160}`);
  }
  return "0x" + cleaned + "ee".repeat(12);
}

/** Detect whether a string is an EVM H160 (0x + 40 hex, not a 32-byte AccountId). */
function isH160(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/** Detect whether a string is a 32-byte AccountId32 hex (0x + 64 hex). */
function isAccountId32Hex(addr: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(addr);
}

/** Decode a 0x-prefixed hex string into Uint8Array. */
function hexToBytes(hex: string): Uint8Array {
  const cleaned = hex.replace(/^0x/, "");
  const bytes = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert a 32-byte hex AccountId32 into a generic SS58 string (format 42).
 * polkadot-api's `System.Account.getValue` expects an SS58 string, not raw hex.
 * The SS58 format index is cosmetic — balance lookups are identical across prefixes.
 */
const accountId32ToSs58 = fromBufferToBase58(42);

/**
 * Decimal ratio between EVM wei (eth-rpc view) and Substrate planck (native view).
 * Polkadot Hub native PAS: 1 PAS = 10^10 planck = 10^18 wei. The eth-rpc adapter
 * rescales by 10^8 so EVM-facing tooling sees the familiar 18-decimal unit.
 */
const EVM_TO_PLANCK_DIVISOR = 10n ** 8n;

/**
 * Existential deposit on Asset Hub Paseo: 0.01 PAS = 10^8 planck.
 *
 * The eth-rpc adapter hides the ED from eth_getBalance — it reports
 * `free - ED` as the "spendable" balance. This means:
 *   substrateFree - EXISTENTIAL_DEPOSIT ≡ evmWei / 10^8
 * Empirically verified live on Paseo against 5 addresses (2026-04-16):
 * every address diverged by EXACTLY 10^8 planck (0.01 PAS).
 *
 * See: https://docs.polkadot.com/reference/polkadot-hub/assets/
 */
const EXISTENTIAL_DEPOSIT_PLANCK = 10n ** 8n;

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

  /** Expose the Substrate client for modules that need direct access (e.g. XCM monitor). */
  getSubstrateClient(): ReturnType<typeof createClient> | null {
    return this.substrateConnected ? this.substrateClient : null;
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
   * Accepts THREE input formats:
   *   1. EVM H160 (0x + 40 hex)     → auto-mapped to AccountId32 via pallet-revive scheme
   *   2. Hex AccountId32 (0x + 64 hex) → used verbatim
   *   3. SS58 string (e.g. 5Grw...)    → used verbatim
   *
   * Why this is different from eth_getBalance:
   *   - eth_getBalance reads via the eth-rpc adapter (EVM view, 18 decimal wei)
   *   - System.Account reads the canonical Substrate state (native chain decimals)
   *   - Both layers read the SAME on-chain account (pallet-revive credits funds
   *     received via eth_sendRawTransaction directly to System.Account under
   *     the derived AccountId32 = h160 ‖ 0xEE × 12).
   *   - Querying both proves Substrate and EVM layers agree on the ground truth.
   *
   * @param addr - SS58 address, hex AccountId32, or EVM H160
   */
  async getSubstrateBalance(addr: string): Promise<SubstrateBalance | null> {
    if (!this.substrateClient || !this.substrateConnected) return null;

    // Normalize input → SS58 string (what polkadot-api's System.Account expects).
    // H160 → pallet-revive AccountId32 → SS58
    // Hex AccountId32 → SS58 directly
    // SS58 → pass through unchanged
    let ss58: string;
    try {
      if (isH160(addr)) {
        const hex = h160ToAccountId32(addr);
        ss58 = accountId32ToSs58(hexToBytes(hex));
      } else if (isAccountId32Hex(addr)) {
        ss58 = accountId32ToSs58(hexToBytes(addr));
      } else {
        ss58 = addr; // assume already-valid SS58
      }
    } catch (err) {
      logger.debug(`Substrate address normalization failed for ${addr}: ${(err as Error).message}`);
      return null;
    }

    try {
      // polkadot-api unsafe API — works without pre-generated chain descriptors
      const unsafeApi = this.substrateClient.getUnsafeApi();
      const account = await unsafeApi.query.System.Account.getValue(ss58);

      if (!account) return null;

      const data = (account as { data?: { free?: unknown; reserved?: unknown; frozen?: unknown } }).data;
      return {
        free: BigInt((data?.free as string | number | bigint) ?? 0),
        reserved: BigInt((data?.reserved as string | number | bigint) ?? 0),
        frozen: BigInt((data?.frozen as string | number | bigint) ?? 0),
      };
    } catch (err) {
      logger.debug(`Substrate balance query failed for ${addr} (ss58=${ss58}): ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Compare EVM and Substrate balance for the same address.
   *
   * Polkadot Hub's pallet-revive maps each EVM H160 to a deterministic
   * AccountId32 using the fallback scheme (h160 ‖ 0xEE × 12). Both
   * protocol layers read the SAME underlying account — `eth_getBalance`
   * and `System.Account` are two different RPC faces on the same state.
   *
   * Decimal and existential-deposit invariants (verified live on Paseo):
   *   - 1 PAS = 10^10 planck = 10^18 wei
   *   - The eth-rpc adapter hides the existential deposit (10^8 planck)
   *     from eth_getBalance, reporting "spendable" (free − ED) instead of free.
   *   - Invariant:  evmWei == (substrateFree − ED) × 10^8
   *
   * Consistency is true when the invariant holds. Divergence points to a
   * mapping bug, a read-time race, or an account that hasn't yet been
   * activated on the Substrate side (ED not yet provisioned).
   */
  async getDualLayerBalance(address: string): Promise<DualLayerBalance> {
    const [evmWei, substrate] = await Promise.all([
      this.provider.getBalance(address),
      this.getSubstrateBalance(address),
    ]);

    const substrateFree = substrate ? substrate.free : null;

    // Invariant: evmWei == (substrateFree - ED) × 10^8, when the account is ED-provisioned.
    // For addresses with zero balance on both sides, the invariant trivially holds.
    let consistent = true;
    if (substrateFree !== null) {
      const spendablePlanck =
        substrateFree >= EXISTENTIAL_DEPOSIT_PLANCK
          ? substrateFree - EXISTENTIAL_DEPOSIT_PLANCK
          : 0n;
      consistent = spendablePlanck * EVM_TO_PLANCK_DIVISOR === evmWei;
    }

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
