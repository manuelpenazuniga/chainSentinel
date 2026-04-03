import { ethers } from "ethers";
import { TransactionData, AgentConfig } from "./types.js";
import { MonitorContext } from "./context.js";
import { createLogger } from "./logger.js";

const logger = createLogger("monitor");

/**
 * Block monitor using HTTP polling.
 *
 * Polkadot Hub's eth-rpc adapter does not support eth_subscribe("newHeads"),
 * so we poll for new blocks via eth_getBlockByNumber instead.
 * Default interval: 6 seconds (matching Polkadot Hub block time).
 */
export class Monitor {
  private httpProvider: ethers.JsonRpcProvider;
  private context: MonitorContext;
  private isRunning: boolean = false;
  private lastProcessedBlock: number = 0;
  private pollIntervalMs: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private onBlockCallback:
    | ((txs: TransactionData[], blockNumber: number) => Promise<void>)
    | null = null;

  constructor(config: AgentConfig, context: MonitorContext) {
    this.context = context;
    this.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "6000");
    this.httpProvider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: "polkadot-hub-testnet",
    });
  }

  async start(
    onBlock: (txs: TransactionData[], blockNumber: number) => Promise<void>
  ): Promise<void> {
    this.onBlockCallback = onBlock;
    this.isRunning = true;

    this.lastProcessedBlock = await this.httpProvider.getBlockNumber();
    logger.info(
      `Starting monitor (HTTP polling every ${this.pollIntervalMs}ms). ` +
        `Current block: ${this.lastProcessedBlock}`
    );

    this.schedulePoll();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info("Monitor stopped");
  }

  private schedulePoll(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const latestBlock = await this.httpProvider.getBlockNumber();

      if (latestBlock > this.lastProcessedBlock) {
        // Process each new block sequentially
        for (
          let bn = this.lastProcessedBlock + 1;
          bn <= latestBlock && this.isRunning;
          bn++
        ) {
          try {
            await this.processBlock(bn);
          } catch (error) {
            logger.error(`Error processing block ${bn}:`, error);
          }
        }
        this.lastProcessedBlock = latestBlock;
      }
    } catch (error) {
      logger.error("Polling error:", error);
    }

    this.schedulePoll();
  }

  private async processBlock(blockNumber: number): Promise<void> {
    const block = await this.httpProvider.getBlock(blockNumber, true);
    if (!block || !block.prefetchedTransactions) {
      logger.debug(`Block ${blockNumber}: no transactions`);
      return;
    }

    const txs: TransactionData[] = [];

    for (const tx of block.prefetchedTransactions) {
      if (!tx.to) continue;

      const txData: TransactionData = {
        hash: tx.hash,
        from: tx.from.toLowerCase(),
        to: tx.to.toLowerCase(),
        value: tx.value.toString(),
        input: tx.data,
        gasUsed: (tx.gasLimit ?? 0n).toString(),
        blockNumber: blockNumber,
        timestamp: block.timestamp,
        functionSelector: tx.data.length >= 10 ? tx.data.slice(0, 10) : "0x",
        decodedFunction: null,
      };

      txs.push(txData);
    }

    const startTime = Date.now();

    // Resolve contract ages (sequential — binary search involves multiple RPC calls per address)
    const contractAddresses = [...new Set(txs.map((tx) => tx.to))];
    for (const addr of contractAddresses) {
      try {
        await this.context.resolveContractAge(addr, blockNumber);
      } catch {
        // Contract age resolution is best-effort
      }
    }

    // Fetch balances in parallel batches of 5
    for (let i = 0; i < contractAddresses.length; i += 5) {
      const batch = contractAddresses.slice(i, i + 5);
      await Promise.all(
        batch.map(async (addr) => {
          try {
            const balance = await this.httpProvider.getBalance(addr, blockNumber);
            this.context.setBalanceAtBlock(addr, blockNumber, balance);
          } catch {
            // Balance fetch may fail for some addresses
          }
        })
      );
    }

    // Fetch receipts in parallel batches of 5 (only for contract calls, not simple transfers)
    const txsNeedingReceipt = txs.filter((tx) => tx.input.length > 2);
    for (let i = 0; i < txsNeedingReceipt.length; i += 5) {
      const batch = txsNeedingReceipt.slice(i, i + 5);
      await Promise.all(
        batch.map(async (txData) => {
          try {
            const receipt = await this.httpProvider.getTransactionReceipt(txData.hash);
            if (receipt) {
              txData.gasUsed = receipt.gasUsed.toString();
            }
          } catch {
            // Gas used from gasLimit is an approximation
          }
        })
      );
    }

    const elapsed = Date.now() - startTime;
    if (txs.length > 0) {
      logger.info(`Block ${blockNumber}: ${txs.length} transactions (enriched in ${elapsed}ms)`);
    }

    // Pre-register flash loan transactions so hasFlashLoanInteraction returns the correct
    // result during analysis. This must happen before the analysis callback but does not
    // affect TX_BURST or UNKNOWN_HIGH_VALUE_SENDER (which depend on pre-block state).
    this.context.preRegisterFlashLoans(txs);

    // Run analysis callback BEFORE updating context with this block's txs.
    // This ensures heuristics (TX_BURST, UNKNOWN_HIGH_VALUE_SENDER) evaluate
    // each tx against the pre-block state, not contaminated by same-block data.
    if (this.onBlockCallback) {
      await this.onBlockCallback(txs, blockNumber);
    }

    // Update context with this block's data AFTER analysis is complete
    await this.context.updateWithBlock(blockNumber, txs);
  }
}
