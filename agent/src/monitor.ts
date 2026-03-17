import { ethers } from "ethers";
import { TransactionData, AgentConfig } from "./types.js";
import { MonitorContext } from "./context.js";
import { createLogger } from "./logger.js";

const logger = createLogger("monitor");

export class Monitor {
  private wsProvider: ethers.WebSocketProvider | null = null;
  private httpProvider: ethers.JsonRpcProvider;
  private context: MonitorContext;
  private config: AgentConfig;
  private isRunning: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 50;
  private onBlockCallback: ((txs: TransactionData[], blockNumber: number) => Promise<void>) | null = null;

  constructor(config: AgentConfig, context: MonitorContext) {
    this.config = config;
    this.context = context;
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

    logger.info(`Starting monitor on ${this.config.wsUrl}`);
    await this.connect();
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.wsProvider) {
      await this.wsProvider.destroy();
      this.wsProvider = null;
    }
    logger.info("Monitor stopped");
  }

  private async connect(): Promise<void> {
    try {
      this.wsProvider = new ethers.WebSocketProvider(this.config.wsUrl, {
        chainId: this.config.chainId,
        name: "polkadot-hub-testnet",
      });

      this.wsProvider.on("block", async (blockNumber: number) => {
        try {
          await this.processBlock(blockNumber);
        } catch (error) {
          logger.error(`Error processing block ${blockNumber}:`, error);
        }
      });

      // Handle provider errors and disconnection
      this.wsProvider.on("error", (error: Error) => {
        logger.error("WebSocket error:", error);
        if (this.isRunning) {
          this.scheduleReconnect();
        }
      });

      this.reconnectAttempts = 0;
      logger.info("WebSocket connected. Listening for new blocks...");
    } catch (error) {
      logger.error("Failed to connect WebSocket:", error);
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("Max reconnect attempts reached. Stopping monitor.");
      this.isRunning = false;
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      if (this.isRunning) {
        await this.connect();
      }
    }, delay);
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

    await this.context.updateWithBlock(blockNumber, txs);

    for (const txData of txs) {
      if (txData.input.length > 2) {
        try {
          const receipt = await this.httpProvider.getTransactionReceipt(txData.hash);
          if (receipt) {
            txData.gasUsed = receipt.gasUsed.toString();
          }
        } catch {
          // Gas used from gasLimit is an approximation
        }
      }
    }

    if (txs.length > 0) {
      logger.info(`Block ${blockNumber}: ${txs.length} transactions`);
    }

    if (this.onBlockCallback) {
      await this.onBlockCallback(txs, blockNumber);
    }
  }
}
