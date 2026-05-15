import { ethers } from "ethers";
import { TransactionData, MonitorContextInterface } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("context");

const FLASH_LOAN_SELECTORS = [
  "0xab9c4b5d", // flashLoan (Aave V2)
  "0x5cffe9de", // flashLoan (ERC-3156)
  "0xd9d98ce4", // flashBorrow
];

// ERC-20 selectors whose calldata encodes a token amount we can decode.
const ERC20_TRANSFER_SELECTORS: Record<string, { amountOffset: number }> = {
  "0xa9059cbb": { amountOffset: 64 },  // transfer(address,uint256)      — 2nd param
  "0x23b872dd": { amountOffset: 128 }, // transferFrom(address,address,uint256) — 3rd param
};

/**
 * Attempt to decode the token amount from ERC-20 transfer/transferFrom calldata.
 * Returns null when the calldata does not match the expected ABI layout.
 */
function decodeERC20Amount(input: string): bigint | null {
  if (input.length < 10) return null;
  const selector = input.slice(0, 10);
  const info = ERC20_TRANSFER_SELECTORS[selector];
  if (!info) return null;
  const params = input.slice(10); // hex without 0x and selector
  const end = info.amountOffset + 64;
  if (params.length < end) return null;
  try {
    const hex = params.slice(info.amountOffset, end);
    return BigInt("0x" + hex);
  } catch {
    return null;
  }
}

class CircularBuffer<T> {
  private buffer: T[];
  private head: number = 0;
  private count: number = 0;

  constructor(private capacity: number) {
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  toArray(): T[] {
    if (this.count < this.capacity) {
      return this.buffer.slice(0, this.count);
    }
    return [
      ...this.buffer.slice(this.head),
      ...this.buffer.slice(0, this.head),
    ];
  }

  get size(): number {
    return this.count;
  }
}

export class MonitorContext implements MonitorContextInterface {
  private avgValues: Map<string, { total: bigint; count: number }> = new Map();
  /** Rolling average of decoded ERC-20 transfer amounts per contract address. */
  private avgERC20Values: Map<string, { total: bigint; count: number }> = new Map();
  private contractAges: Map<string, number> = new Map();
  private recentTxBuffer: CircularBuffer<TransactionData>;
  private blacklist: Set<string> = new Set();
  private balanceCache: Map<string, Map<number, bigint>> = new Map();
  private interactionHistory: Set<string> = new Set();
  private contractLabels: Map<string, string> = new Map();
  private flashLoanTxHashes: Set<string> = new Set();
  private whitelistedContracts: Set<string> = new Set();
  private currentBlock: number = 0;
  private provider: ethers.AbstractProvider;
  private registryAddress: string;
  private vaultAddress: string;

  constructor(
    provider: ethers.AbstractProvider,
    registryAddress: string,
    bufferCapacity: number = 500,
    vaultAddress: string = ""
  ) {
    this.provider = provider;
    this.registryAddress = registryAddress;
    this.vaultAddress = vaultAddress;
    this.recentTxBuffer = new CircularBuffer<TransactionData>(bufferCapacity);
  }

  async updateWithBlock(blockNumber: number, txs: TransactionData[]): Promise<void> {
    this.currentBlock = blockNumber;

    for (const tx of txs) {
      const toLower = tx.to.toLowerCase();
      const fromLower = tx.from.toLowerCase();

      this.updateAvgValue(toLower, BigInt(tx.value));
      this.recentTxBuffer.push(tx);
      this.interactionHistory.add(`${fromLower}:${toLower}`);

      // Track ERC-20 transfer amounts decoded from calldata (independent of tx.value)
      const erc20Amount = decodeERC20Amount(tx.input);
      if (erc20Amount !== null && erc20Amount > 0n) {
        this.updateAvgERC20Value(toLower, erc20Amount);
      }

      // Track flash loan interactions by tx hash
      if (tx.input.length >= 10) {
        const selector = tx.input.slice(0, 10);
        if (FLASH_LOAN_SELECTORS.includes(selector)) {
          this.flashLoanTxHashes.add(tx.hash);
        }
      }
    }

    // Cap flash loan hash set to prevent unbounded growth
    if (this.flashLoanTxHashes.size > 10000) {
      const entries = [...this.flashLoanTxHashes];
      this.flashLoanTxHashes = new Set(entries.slice(entries.length - 5000));
    }

    if (blockNumber % 10 === 0) {
      await this.refreshBlacklistFromRegistry();
      await this.refreshWhitelistFromVault();
    }
  }

  setBalanceAtBlock(contractAddress: string, blockNumber: number, balance: bigint): void {
    const addr = contractAddress.toLowerCase();
    if (!this.balanceCache.has(addr)) {
      this.balanceCache.set(addr, new Map());
    }
    this.balanceCache.get(addr)!.set(blockNumber, balance);

    const cache = this.balanceCache.get(addr)!;
    if (cache.size > 100) {
      const oldestBlock = blockNumber - 100;
      for (const [block] of cache) {
        if (block < oldestBlock) cache.delete(block);
      }
    }
  }

  setContractAge(contractAddress: string, deployTimestamp: number): void {
    this.contractAges.set(contractAddress.toLowerCase(), deployTimestamp);
  }

  setContractLabel(contractAddress: string, label: string): void {
    this.contractLabels.set(contractAddress.toLowerCase(), label);
  }

  addToBlacklist(address: string): void {
    this.blacklist.add(address.toLowerCase());
  }

  /// Resolve the deployment age of a contract via binary search over block history.
  /// Caches the result so subsequent calls for the same address are free.
  async resolveContractAge(address: string, currentBlockNumber: number): Promise<void> {
    const addr = address.toLowerCase();
    if (this.contractAges.has(addr)) return;

    try {
      const code = await this.provider.getCode(addr, currentBlockNumber);
      if (!code || code === "0x") {
        // Not a contract — mark with large age so FRESH_CONTRACT won't trigger
        this.contractAges.set(addr, 0);
        return;
      }

      // Binary search: find the earliest block where code exists (max 2000 blocks back)
      const searchDepth = 2000;
      const windowStart = Math.max(0, currentBlockNumber - searchDepth);
      let lo = windowStart;
      let hi = currentBlockNumber;
      let deployBlock = currentBlockNumber;

      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        try {
          const midCode = await this.provider.getCode(addr, mid);
          if (midCode && midCode !== "0x") {
            deployBlock = mid;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        } catch {
          // If getCode at historical block fails, narrow search from the other side
          lo = mid + 1;
        }
      }

      // If deployBlock is at the window boundary, the contract existed before our search
      // window — we cannot confirm it's fresh. Treat as old to avoid false positives.
      if (deployBlock === windowStart) {
        this.contractAges.set(addr, 0);
        logger.debug(`Contract ${addr}: deploy at or before window start (block ${windowStart}), treating as old`);
        return;
      }

      // Get timestamp of the deploy block
      const block = await this.provider.getBlock(deployBlock);
      if (block) {
        this.contractAges.set(addr, block.timestamp);
        logger.debug(`Contract ${addr} deployed at block ${deployBlock} (timestamp ${block.timestamp})`);
      } else {
        // Fallback: treat as old contract
        this.contractAges.set(addr, 0);
      }
    } catch (error) {
      logger.warn(`Failed to resolve contract age for ${addr}:`, error);
      // Don't cache on error — allow retry next block
    }
  }

  // ─── MonitorContextInterface Implementation ───

  getHistoricalAvgValue(contractAddress: string): bigint {
    const data = this.avgValues.get(contractAddress.toLowerCase());
    if (!data || data.count === 0) return 0n;
    return data.total / BigInt(data.count);
  }

  getHistoricalAvgERC20Value(contractAddress: string): bigint {
    const data = this.avgERC20Values.get(contractAddress.toLowerCase());
    if (!data || data.count === 0) return 0n;
    return data.total / BigInt(data.count);
  }

  getContractAge(contractAddress: string): number | null {
    const deployTime = this.contractAges.get(contractAddress.toLowerCase());
    if (deployTime === undefined) return null;
    return Math.floor(Date.now() / 1000) - deployTime;
  }

  getRecentTxs(from: string, to: string, withinBlocks: number): TransactionData[] {
    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const minBlock = this.currentBlock - withinBlocks;

    return this.recentTxBuffer
      .toArray()
      .filter(
        (tx) =>
          tx.from.toLowerCase() === fromLower &&
          tx.to.toLowerCase() === toLower &&
          tx.blockNumber >= minBlock
      );
  }

  getRecentTxCount(from: string, to: string, withinBlocks: number): number {
    return this.getRecentTxs(from, to, withinBlocks).length;
  }

  getSignificantThreshold(contractAddress: string): bigint {
    const avg = this.getHistoricalAvgValue(contractAddress);
    const oneDOT = ethers.parseEther("1");
    const fiveXAvg = avg * 5n;
    if (avg === 0n) return oneDOT;
    return fiveXAvg < oneDOT ? fiveXAvg : oneDOT;
  }

  /// Pre-register flash loan transactions from the current block before analysis runs.
  /// This must be called before onBlockCallback so that hasFlashLoanInteraction returns
  /// the correct result for transactions in the current block.
  preRegisterFlashLoans(txs: TransactionData[]): void {
    for (const tx of txs) {
      if (tx.input.length >= 10) {
        const selector = tx.input.slice(0, 10);
        if (FLASH_LOAN_SELECTORS.includes(selector)) {
          this.flashLoanTxHashes.add(tx.hash);
        }
      }
    }
  }

  hasFlashLoanInteraction(txHash: string): boolean {
    return this.flashLoanTxHashes.has(txHash);
  }

  isBlacklisted(address: string): boolean {
    return this.blacklist.has(address.toLowerCase());
  }

  getBlacklistSet(): Set<string> {
    return this.blacklist;
  }

  isWhitelisted(address: string): boolean {
    return this.whitelistedContracts.has(address.toLowerCase());
  }

  getBalanceBefore(contractAddress: string, blockNumber: number): bigint {
    const cache = this.balanceCache.get(contractAddress.toLowerCase());
    if (!cache) return 0n;
    return cache.get(blockNumber - 1) ?? 0n;
  }

  getBalanceAfter(contractAddress: string, blockNumber: number): bigint {
    const cache = this.balanceCache.get(contractAddress.toLowerCase());
    if (!cache) return 0n;
    return cache.get(blockNumber) ?? 0n;
  }

  hasPreviousInteraction(from: string, to: string): boolean {
    return this.interactionHistory.has(`${from.toLowerCase()}:${to.toLowerCase()}`);
  }

  getContractLabel(contractAddress: string): string | null {
    return this.contractLabels.get(contractAddress.toLowerCase()) ?? null;
  }

  getBalance(contractAddress: string): bigint {
    const cache = this.balanceCache.get(contractAddress.toLowerCase());
    if (!cache || cache.size === 0) return 0n;
    let maxBlock = 0;
    let balance = 0n;
    for (const [block, bal] of cache) {
      if (block > maxBlock) {
        maxBlock = block;
        balance = bal;
      }
    }
    return balance;
  }

  getBalanceChange(contractAddress: string, blockNumber: number): number {
    const before = this.getBalanceBefore(contractAddress, blockNumber);
    const after = this.getBalanceAfter(contractAddress, blockNumber);
    if (before === 0n) return 0;
    return Number(((before - after) * 100n) / before);
  }

  // ─── Private Methods ───

  private updateAvgValue(contractAddress: string, value: bigint): void {
    const existing = this.avgValues.get(contractAddress);
    if (existing) {
      if (existing.count >= 100) {
        existing.total = existing.total - (existing.total / BigInt(existing.count)) + value;
      } else {
        existing.total += value;
        existing.count++;
      }
    } else {
      this.avgValues.set(contractAddress, { total: value, count: 1 });
    }
  }

  private updateAvgERC20Value(contractAddress: string, amount: bigint): void {
    const existing = this.avgERC20Values.get(contractAddress);
    if (existing) {
      if (existing.count >= 100) {
        existing.total = existing.total - (existing.total / BigInt(existing.count)) + amount;
      } else {
        existing.total += amount;
        existing.count++;
      }
    } else {
      this.avgERC20Values.set(contractAddress, { total: amount, count: 1 });
    }
  }

  private async refreshBlacklistFromRegistry(): Promise<void> {
    if (!this.registryAddress || this.registryAddress === "0x") return;

    try {
      const registryAbi = [
        "function isBlacklisted(address) view returns (bool)",
      ];
      const registry = new ethers.Contract(
        this.registryAddress,
        registryAbi,
        this.provider
      );

      // Check all known contract addresses against the on-chain blacklist
      const knownAddresses = new Set([
        ...this.avgValues.keys(),
        ...this.contractAges.keys(),
      ]);

      const addresses = [...knownAddresses];
      // Batch with concurrency limit of 5
      for (let i = 0; i < addresses.length; i += 5) {
        const batch = addresses.slice(i, i + 5);
        const results = await Promise.all(
          batch.map(async (addr) => {
            try {
              const result = await registry.isBlacklisted(addr);
              return { addr, blacklisted: result as boolean };
            } catch {
              return { addr, blacklisted: false };
            }
          })
        );
        for (const { addr, blacklisted } of results) {
          if (blacklisted) {
            this.blacklist.add(addr);
          }
        }
      }

      logger.debug(`Blacklist refresh completed (checked ${addresses.length} addresses)`);
    } catch (error) {
      logger.warn("Failed to refresh blacklist from registry:", error);
    }
  }

  // ─── Persistence (§3.2) ────────────────────────────────────────────────
  //
  // Snapshot the whole rolling state so the agent can recover quickly after
  // a restart instead of needing 100+ blocks of fresh observations to rebuild
  // the averages. BigInts are serialized as decimal strings (CircularBuffer is
  // dumped as an array). The schema version lets us evolve the format safely.

  /** Schema version for the snapshot format. Bump when changing layout. */
  static readonly SNAPSHOT_VERSION = 1;

  /**
   * Produce a JSON-serializable snapshot of the rolling state. Does NOT
   * include the provider, registry address, or vault address — those come
   * from configuration on restart.
   */
  toSnapshot(): ContextSnapshot {
    return {
      version: MonitorContext.SNAPSHOT_VERSION,
      currentBlock: this.currentBlock,
      avgValues: serializeBigIntCountMap(this.avgValues),
      avgERC20Values: serializeBigIntCountMap(this.avgERC20Values),
      contractAges: Object.fromEntries(this.contractAges),
      balanceCache: serializeBalanceCache(this.balanceCache),
      interactionHistory: [...this.interactionHistory],
      contractLabels: Object.fromEntries(this.contractLabels),
      flashLoanTxHashes: [...this.flashLoanTxHashes],
      whitelistedContracts: [...this.whitelistedContracts],
      blacklist: [...this.blacklist],
      recentTxBuffer: this.recentTxBuffer.toArray(),
    };
  }

  /**
   * Restore in-memory state from a snapshot. Throws on schema mismatch so the
   * agent can decide to discard and start cold rather than misinterpret data.
   */
  restoreFromSnapshot(snapshot: ContextSnapshot): void {
    if (snapshot.version !== MonitorContext.SNAPSHOT_VERSION) {
      throw new Error(
        `Snapshot schema mismatch: expected v${MonitorContext.SNAPSHOT_VERSION}, got v${snapshot.version}`
      );
    }

    this.currentBlock = snapshot.currentBlock;
    this.avgValues = deserializeBigIntCountMap(snapshot.avgValues);
    this.avgERC20Values = deserializeBigIntCountMap(snapshot.avgERC20Values);
    this.contractAges = new Map(Object.entries(snapshot.contractAges));
    this.balanceCache = deserializeBalanceCache(snapshot.balanceCache);
    this.interactionHistory = new Set(snapshot.interactionHistory);
    this.contractLabels = new Map(Object.entries(snapshot.contractLabels));
    this.flashLoanTxHashes = new Set(snapshot.flashLoanTxHashes);
    this.whitelistedContracts = new Set(snapshot.whitelistedContracts);
    this.blacklist = new Set(snapshot.blacklist);

    // Rehydrate the CircularBuffer by replaying entries (preserves insertion order).
    for (const tx of snapshot.recentTxBuffer) {
      this.recentTxBuffer.push(tx);
    }

    logger.info(
      `Context restored from snapshot at block ${snapshot.currentBlock}: ` +
        `${this.avgValues.size} avg(native), ${this.avgERC20Values.size} avg(erc20), ` +
        `${this.contractAges.size} ages, ${this.blacklist.size} blacklist, ` +
        `${this.recentTxBuffer.size} recent txs`
    );
  }

  private async refreshWhitelistFromVault(): Promise<void> {
    if (!this.vaultAddress || this.vaultAddress === "0x") return;

    try {
      const vaultAbi = [
        "function isWhitelisted(address) view returns (bool)",
      ];
      const vault = new ethers.Contract(
        this.vaultAddress,
        vaultAbi,
        this.provider
      );

      // Check known contract addresses against vault whitelist
      const knownAddresses = new Set([
        ...this.avgValues.keys(),
        ...this.contractAges.keys(),
      ]);

      const addresses = [...knownAddresses];
      for (let i = 0; i < addresses.length; i += 5) {
        const batch = addresses.slice(i, i + 5);
        const results = await Promise.all(
          batch.map(async (addr) => {
            try {
              const result = await vault.isWhitelisted(addr);
              return { addr, whitelisted: result as boolean };
            } catch {
              return { addr, whitelisted: false };
            }
          })
        );
        for (const { addr, whitelisted } of results) {
          if (whitelisted) {
            this.whitelistedContracts.add(addr);
          } else {
            this.whitelistedContracts.delete(addr);
          }
        }
      }

      logger.debug(`Whitelist refresh completed (checked ${addresses.length} addresses)`);
    } catch (error) {
      logger.warn("Failed to refresh whitelist from vault:", error);
    }
  }
}

// ─── Snapshot Types & Serialization Helpers ────────────────────────────────

/** Serialized form of `{ total: bigint; count: number }`. */
interface BigIntCountEntry {
  total: string; // bigint as decimal string
  count: number;
}

/** JSON-serializable snapshot of MonitorContext rolling state. */
export interface ContextSnapshot {
  version: number;
  currentBlock: number;
  avgValues: Record<string, BigIntCountEntry>;
  avgERC20Values: Record<string, BigIntCountEntry>;
  contractAges: Record<string, number>;
  balanceCache: Record<string, Record<string, string>>; // addr → { blockNumber → balanceString }
  interactionHistory: string[];
  contractLabels: Record<string, string>;
  flashLoanTxHashes: string[];
  whitelistedContracts: string[];
  blacklist: string[];
  recentTxBuffer: TransactionData[];
}

function serializeBigIntCountMap(
  map: Map<string, { total: bigint; count: number }>
): Record<string, BigIntCountEntry> {
  const out: Record<string, BigIntCountEntry> = {};
  for (const [k, v] of map) out[k] = { total: v.total.toString(), count: v.count };
  return out;
}

function deserializeBigIntCountMap(
  obj: Record<string, BigIntCountEntry>
): Map<string, { total: bigint; count: number }> {
  const m = new Map<string, { total: bigint; count: number }>();
  for (const [k, v] of Object.entries(obj)) {
    m.set(k, { total: BigInt(v.total), count: v.count });
  }
  return m;
}

function serializeBalanceCache(
  cache: Map<string, Map<number, bigint>>
): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const [addr, perBlock] of cache) {
    const inner: Record<string, string> = {};
    for (const [block, bal] of perBlock) inner[block.toString()] = bal.toString();
    out[addr] = inner;
  }
  return out;
}

function deserializeBalanceCache(
  obj: Record<string, Record<string, string>>
): Map<string, Map<number, bigint>> {
  const m = new Map<string, Map<number, bigint>>();
  for (const [addr, perBlock] of Object.entries(obj)) {
    const inner = new Map<number, bigint>();
    for (const [block, bal] of Object.entries(perBlock)) {
      inner.set(Number(block), BigInt(bal));
    }
    m.set(addr, inner);
  }
  return m;
}
