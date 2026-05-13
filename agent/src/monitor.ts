import { ethers } from "ethers";
import { TransactionData, AgentConfig } from "./types.js";
import { MonitorContext } from "./context.js";
import { GasPriorityEstimator, FeeSnapshot } from "./gas-priority.js";
import { HeartbeatClient } from "./heartbeat.js";
import { ContextPersistence } from "./persistence.js";
import {
  blocksFetched,
  blocksProcessed,
  blockEnrichmentSeconds,
  blockProcessingSeconds,
} from "./metrics.js";
import { captureException } from "./sentry.js";
import { createLogger } from "./logger.js";

const logger = createLogger("monitor");

/**
 * Run an array of async tasks with at most `concurrency` in flight at once.
 * Preserves input order in the returned array (mirrors `Promise.all`).
 *
 * Replaces a `p-limit` dependency with ~15 lines of inline code.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length));
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/** Output of the enrichment phase — everything block-N analysis needs. */
interface EnrichedBlock {
  blockNumber: number;
  timestamp: number;
  txs: TransactionData[];
  feeSnapshot: FeeSnapshot | null;
}

/**
 * Block monitor using HTTP polling.
 *
 * Polkadot Hub's eth-rpc adapter does not support eth_subscribe("newHeads"),
 * so we poll for new blocks via eth_getBlockByNumber instead.
 * Default interval: 6 seconds (matching Polkadot Hub block time).
 *
 * Block processing is split into two phases for performance under catch-up:
 *
 *   Phase 1 — Enrichment (parallel, I/O bound):
 *     For each pending block, fetch the block body, contract ages, balances,
 *     receipts. Up to `fetchConcurrency` blocks enriched in parallel.
 *
 *   Phase 2 — Analysis (sequential, state-dependent):
 *     Each enriched block runs preRegisterFlashLoans → onBlockCallback →
 *     updateWithBlock in strict block order, because rolling state (avg
 *     values, blacklist, balance deltas) creates a hard dependency between
 *     consecutive blocks.
 *
 * Result: catch-up of N blocks is bound by max(enrichment_p99 / concurrency,
 * sum(analysis_time)) instead of sum(enrichment + analysis). Typical 2-3x
 * speedup on cold start.
 */
export class Monitor {
  private httpProvider: ethers.JsonRpcProvider;
  private context: MonitorContext;
  private isRunning: boolean = false;
  private lastProcessedBlock: number = 0;
  private pollIntervalMs: number;
  private fetchConcurrency: number;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private onBlockCallback:
    | ((txs: TransactionData[], blockNumber: number) => Promise<void>)
    | null = null;
  private gasEstimator: GasPriorityEstimator | null = null;
  private heartbeat: HeartbeatClient | null = null;
  private persistence: ContextPersistence | null = null;

  constructor(config: AgentConfig, context: MonitorContext) {
    this.context = context;
    this.pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS || "6000");
    this.fetchConcurrency = Math.max(
      1,
      parseInt(process.env.FETCH_CONCURRENCY || "3")
    );
    this.httpProvider = new ethers.JsonRpcProvider(config.rpcUrl, {
      chainId: config.chainId,
      name: "polkadot-hub-testnet",
    });
  }

  /** Connect the gas estimator so each block's fee data is recorded. */
  setGasEstimator(estimator: GasPriorityEstimator): void {
    this.gasEstimator = estimator;
  }

  /** Connect the heartbeat client so it pings on each new block. */
  setHeartbeat(client: HeartbeatClient | null): void {
    this.heartbeat = client;
  }

  /** Connect the persistence layer so context snapshots are written periodically. */
  setPersistence(persistence: ContextPersistence | null): void {
    this.persistence = persistence;
  }

  /** Override the starting block (e.g. after restoring from a snapshot). */
  setLastProcessedBlock(blockNumber: number): void {
    this.lastProcessedBlock = blockNumber;
  }

  async start(
    onBlock: (txs: TransactionData[], blockNumber: number) => Promise<void>
  ): Promise<void> {
    this.onBlockCallback = onBlock;
    this.isRunning = true;

    // If lastProcessedBlock was already seeded (e.g. via restored snapshot),
    // honor it. Otherwise default to "right now" so we don't try to chew
    // through chain history.
    if (this.lastProcessedBlock === 0) {
      this.lastProcessedBlock = await this.httpProvider.getBlockNumber();
    }
    logger.info(
      `Starting monitor (HTTP polling every ${this.pollIntervalMs}ms, ` +
        `fetchConcurrency=${this.fetchConcurrency}). ` +
        `Resuming from block: ${this.lastProcessedBlock}`
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
        const pending: number[] = [];
        for (let bn = this.lastProcessedBlock + 1; bn <= latestBlock; bn++) {
          pending.push(bn);
        }

        // Phase 1 — Parallel enrichment (I/O bound).
        // Fetch block bodies, balances, receipts, contract ages concurrently
        // for up to `fetchConcurrency` blocks at a time. Order is preserved.
        const enrichmentTasks = pending.map((bn) => () => this.fetchAndEnrichBlock(bn));
        const enrichedBlocks = await runWithConcurrency(enrichmentTasks, this.fetchConcurrency);

        // Phase 2 — Sequential analysis + state update (block-ordered).
        for (const enriched of enrichedBlocks) {
          if (!this.isRunning) break;
          if (!enriched) continue; // fetch may have failed for this block — skip
          try {
            await this.processEnrichedBlock(enriched);
            this.lastProcessedBlock = enriched.blockNumber;
          } catch (error) {
            logger.error(`Error processing block ${enriched.blockNumber}:`, error);
            captureException(error, {
              tags: { phase: "process_block" },
              extra: { blockNumber: enriched.blockNumber },
            });
          }
        }
      }
    } catch (error) {
      logger.error("Polling error:", error);
      captureException(error, { tags: { phase: "monitor_poll" } });
    }

    this.schedulePoll();
  }

  // ─── Phase 1: Enrichment (parallel-safe) ─────────────────────────────────

  /**
   * Fetch and enrich one block's data without touching `MonitorContext` mutating
   * state. Safe to run in parallel for distinct block numbers.
   *
   * The only context method called here is `setBalanceAtBlock` which is keyed
   * by (address, blockNumber) — no cross-block ordering required.
   *
   * Returns null if the block could not be fetched (e.g. transient RPC error).
   */
  private async fetchAndEnrichBlock(blockNumber: number): Promise<EnrichedBlock | null> {
    const stop = blockEnrichmentSeconds.startTimer();
    try {
      const block = await this.httpProvider.getBlock(blockNumber, true);
      if (!block) {
        logger.debug(`Block ${blockNumber}: not found`);
        return null;
      }
      blocksFetched.inc();

      const feeSnapshot: FeeSnapshot | null =
        block.baseFeePerGas != null
          ? {
              blockNumber,
              baseFeePerGas: block.baseFeePerGas,
              gasUsed: block.gasUsed,
              gasLimit: block.gasLimit,
            }
          : null;

      const txs: TransactionData[] = [];
      if (block.prefetchedTransactions) {
        for (const tx of block.prefetchedTransactions) {
          if (!tx.to) continue;
          txs.push({
            hash: tx.hash,
            from: tx.from.toLowerCase(),
            to: tx.to.toLowerCase(),
            value: tx.value.toString(),
            input: tx.data,
            gasUsed: (tx.gasLimit ?? 0n).toString(),
            blockNumber,
            timestamp: block.timestamp,
            functionSelector: tx.data.length >= 10 ? tx.data.slice(0, 10) : "0x",
            decodedFunction: null,
          });
        }
      }

      // Resolve contract ages — sequential within a block (binary search reuses prior calls)
      const contractAddresses = [...new Set(txs.map((tx) => tx.to))];
      for (const addr of contractAddresses) {
        try {
          await this.context.resolveContractAge(addr, blockNumber);
        } catch {
          // best effort
        }
      }

      // Fetch balances — batches of 5 within this block
      for (let i = 0; i < contractAddresses.length; i += 5) {
        const batch = contractAddresses.slice(i, i + 5);
        await Promise.all(
          batch.map(async (addr) => {
            try {
              const balance = await this.httpProvider.getBalance(addr, blockNumber);
              this.context.setBalanceAtBlock(addr, blockNumber, balance);
            } catch {
              // skip
            }
          })
        );
      }

      // Fetch receipts — only for contract calls
      const txsNeedingReceipt = txs.filter((tx) => tx.input.length > 2);
      for (let i = 0; i < txsNeedingReceipt.length; i += 5) {
        const batch = txsNeedingReceipt.slice(i, i + 5);
        await Promise.all(
          batch.map(async (txData) => {
            try {
              const receipt = await this.httpProvider.getTransactionReceipt(txData.hash);
              if (receipt) txData.gasUsed = receipt.gasUsed.toString();
            } catch {
              // gas used from gasLimit is approximation; that's OK
            }
          })
        );
      }

      return { blockNumber, timestamp: block.timestamp, txs, feeSnapshot };
    } finally {
      stop();
    }
  }

  // ─── Phase 2: Analysis + state update (strictly sequential) ──────────────

  /**
   * Run the analysis callback against an enriched block, then advance shared
   * state. MUST be called in block order — heuristics (TX_BURST,
   * UNKNOWN_HIGH_VALUE_SENDER) and rolling averages depend on prior blocks
   * having been fully processed.
   */
  private async processEnrichedBlock(enriched: EnrichedBlock): Promise<void> {
    const stop = blockProcessingSeconds.startTimer();
    try {
      // Feed gas estimator before analysis (executor uses it for emergency txs)
      if (this.gasEstimator && enriched.feeSnapshot) {
        this.gasEstimator.recordBlock(enriched.feeSnapshot);
      }

      if (enriched.txs.length > 0) {
        logger.info(`Block ${enriched.blockNumber}: ${enriched.txs.length} transactions`);
      }

      // Pre-register flash loans so hasFlashLoanInteraction() returns the
      // correct result during analysis of THIS block's transactions.
      this.context.preRegisterFlashLoans(enriched.txs);

      // Run analysis BEFORE updating context with this block's txs — heuristics
      // need pre-block state to compute TX_BURST etc.
      if (this.onBlockCallback) {
        await this.onBlockCallback(enriched.txs, enriched.blockNumber);
      }

      // Now advance the rolling context state with this block's data.
      await this.context.updateWithBlock(enriched.blockNumber, enriched.txs);

      // Heartbeat ping (best-effort, never blocks the loop).
      if (this.heartbeat) {
        await this.heartbeat.maybePing(enriched.blockNumber);
      }

      // Persistence snapshot (best-effort, runs once per `flushIntervalBlocks`).
      if (this.persistence && this.persistence.shouldFlush(enriched.blockNumber)) {
        this.persistence.flush(this.context, enriched.blockNumber);
      }

      blocksProcessed.inc();
    } finally {
      stop();
    }
  }
}
