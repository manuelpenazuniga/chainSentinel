import "dotenv/config";
import { AgentConfig } from "./types.js";
import { MonitorContext } from "./context.js";
import { Monitor } from "./monitor.js";
import { analyzeTransaction } from "./analyzer.js";
import { Executor } from "./executor.js";
import { Alerter } from "./alerter.js";
import { XcmMonitor } from "./xcm-monitor.js";
import { AgentKitWrapper } from "./agentkit.js";
import { createLogger } from "./logger.js";
import { ethers } from "ethers";

const logger = createLogger("main");

function loadConfig(): AgentConfig {
  const required = ["RPC_URL", "CHAIN_ID", "AGENT_PRIVATE_KEY", "VAULT_ADDRESS", "REGISTRY_ADDRESS", "GEMINI_API_KEY"];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  return {
    rpcUrl: process.env.RPC_URL!,
    wsUrl: process.env.WS_URL,
    chainId: parseInt(process.env.CHAIN_ID!),
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY!,
    vaultAddress: process.env.VAULT_ADDRESS!,
    registryAddress: process.env.REGISTRY_ADDRESS!,
    geminiApiKey: process.env.GEMINI_API_KEY!,
    heuristicThreshold: parseInt(process.env.HEURISTIC_THRESHOLD || "30"),
    emergencyThreshold: parseInt(process.env.DEFAULT_EMERGENCY_THRESHOLD || "80"),
    cooldownBlocks: parseInt(process.env.COOLDOWN_BLOCKS || "10"),
    llmTimeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || "10000"),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
  };
}

async function main(): Promise<void> {
  logger.info("=== ChainSentinel Agent Starting ===");

  const config = loadConfig();
  logger.info(`RPC: ${config.rpcUrl}`);
  logger.info(`Chain ID: ${config.chainId}`);
  logger.info(`Vault: ${config.vaultAddress}`);
  logger.info(`Registry: ${config.registryAddress}`);
  logger.info(`Heuristic threshold: ${config.heuristicThreshold}`);
  logger.info(`Emergency threshold: ${config.emergencyThreshold}`);

  const provider = new ethers.JsonRpcProvider(config.rpcUrl, {
    chainId: config.chainId,
    name: "polkadot-hub-testnet",
  });

  const network = await provider.getNetwork();
  logger.info(`Connected to network: ${network.name} (chainId: ${network.chainId})`);

  const blockNumber = await provider.getBlockNumber();
  logger.info(`Current block: ${blockNumber}`);

  const context = new MonitorContext(provider, config.registryAddress, 500, config.vaultAddress);
  const monitor = new Monitor(config, context);
  const executor = new Executor(config);
  const alerter = new Alerter(config);

  // ─── XCM Monitor (Substrate layer) ──────────────────────────────────────
  let xcmMonitor: XcmMonitor | null = null;

  if (config.wsUrl) {
    try {
      const agentKit = new AgentKitWrapper(config);
      await agentKit.initSubstrate();
      const subClient = agentKit.getSubstrateClient();
      if (subClient) {
        xcmMonitor = new XcmMonitor(subClient, context.getBlacklistSet());
        await xcmMonitor.start(async (threat) => {
          logger.info(
            `[XCM] Threat: score=${threat.threatScore} class=${threat.classification} ` +
            `origin=${threat.transfer.origin.slice(0, 16)}... ` +
            `reasons=[${threat.reasons.join("; ")}]`
          );
          await alerter.sendAlert({
            type: "THREAT_DETECTED",
            message: `XCM threat detected! Score: ${threat.threatScore}/100 — ${threat.reasons.join("; ")}`,
            timestamp: Date.now(),
          });
        });
        logger.info("XCM monitor active — cross-chain transfers are being watched");
      }
    } catch (err) {
      logger.warn(`XCM monitor failed to start (non-fatal): ${(err as Error).message}`);
    }
  } else {
    logger.info("WS_URL not set — XCM monitoring disabled (EVM-only mode)");
  }

  await alerter.sendAlert({
    type: "AGENT_STARTED",
    message: `ChainSentinel agent started. Monitoring vault ${config.vaultAddress}`,
    timestamp: Date.now(),
  });

  await monitor.start(async (txs, _blockNum) => {
    for (const tx of txs) {
      const assessment = await analyzeTransaction(tx, context, config);

      if (assessment.score === 0) continue;

      logger.info(
        `Assessment for tx ${tx.hash}: score=${assessment.score}, ` +
        `classification=${assessment.classification}, action=${assessment.recommendedAction}`
      );

      // Cross-layer correlation: register high-score senders with XCM monitor
      if (assessment.score >= 30 && xcmMonitor) {
        xcmMonitor.registerEvmThreatAddress(tx.from);
        if (tx.to) xcmMonitor.registerEvmThreatAddress(tx.to);
      }

      if (assessment.score >= 30) {
        await alerter.sendAlert({
          type: "THREAT_DETECTED",
          assessment,
          message: `Threat detected! Score: ${assessment.score}/100`,
          timestamp: Date.now(),
        });
      }

      if (assessment.recommendedAction === "EMERGENCY_WITHDRAW" ||
          assessment.score >= config.emergencyThreshold) {
        const results = await executor.execute(assessment);

        for (const result of results) {
          if (result.success && result.action === "EMERGENCY_WITHDRAW_ALL") {
            await alerter.sendAlert({
              type: "EMERGENCY_EXECUTED",
              assessment,
              message: `Emergency withdrawal executed! Tx: ${result.txHash}`,
              timestamp: Date.now(),
            });
          }
        }
      } else if (assessment.score > 50) {
        await executor.execute(assessment);
      }
    }
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    if (xcmMonitor) await xcmMonitor.stop();
    await monitor.stop();
    await alerter.sendAlert({
      type: "AGENT_STOPPED",
      message: "ChainSentinel agent stopped.",
      timestamp: Date.now(),
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("=== ChainSentinel Agent Running ===");
}

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
