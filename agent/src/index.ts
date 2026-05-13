import "dotenv/config";
import { AgentConfig } from "./types.js";
import { MonitorContext } from "./context.js";
import { Monitor } from "./monitor.js";
import { analyzeTransaction } from "./analyzer.js";
import { Executor, determineEscalation } from "./executor.js";
import { Alerter } from "./alerter.js";
import { HeartbeatClient } from "./heartbeat.js";
import { XcmMonitor } from "./xcm-monitor.js";
import { AgentKitWrapper } from "./agentkit.js";
import { ContextPersistence } from "./persistence.js";
import { MetricsServer } from "./metrics.js";
import { initSentry, flushSentry, captureException } from "./sentry.js";
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
    vaultAddressPvm: process.env.VAULT_ADDRESS_PVM,
    registryAddressPvm: process.env.REGISTRY_ADDRESS_PVM,
    geminiApiKey: process.env.GEMINI_API_KEY!,
    heuristicThreshold: parseInt(process.env.HEURISTIC_THRESHOLD || "30"),
    emergencyThreshold: parseInt(process.env.DEFAULT_EMERGENCY_THRESHOLD || "80"),
    cooldownBlocks: parseInt(process.env.COOLDOWN_BLOCKS || "10"),
    llmTimeoutMs: parseInt(process.env.LLM_TIMEOUT_MS || "10000"),
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    discordWebhookUrl: process.env.DISCORD_WEBHOOK_URL,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    pagerDutyRoutingKey: process.env.PAGERDUTY_ROUTING_KEY,
    pagerDutyMinScore: parseInt(process.env.PAGERDUTY_MIN_SCORE || "70"),
    heartbeatAddress: process.env.HEARTBEAT_ADDRESS,
    heartbeatIntervalBlocks: parseInt(process.env.HEARTBEAT_INTERVAL_BLOCKS || "50"),
    persistenceDbPath: process.env.PERSISTENCE_DB_PATH || undefined,
    persistenceFlushBlocks: parseInt(process.env.PERSISTENCE_FLUSH_BLOCKS || "100"),
    metricsPort: parseInt(process.env.METRICS_PORT || "9090"),
  };
}

async function main(): Promise<void> {
  // Sentry must initialise BEFORE anything else so it can capture errors
  // raised during config load / provider connect. No-op if SENTRY_DSN unset.
  initSentry();

  logger.info("=== ChainSentinel Agent Starting ===");

  const config = loadConfig();
  logger.info(`RPC: ${config.rpcUrl}`);
  logger.info(`Chain ID: ${config.chainId}`);
  logger.info(`Vault (REVM): ${config.vaultAddress}`);
  logger.info(`Registry (REVM): ${config.registryAddress}`);
  if (config.vaultAddressPvm) {
    logger.info(`Vault (PVM): ${config.vaultAddressPvm}`);
    logger.info(`Registry (PVM): ${config.registryAddressPvm}`);
    logger.info("Dual-VM mode: monitoring REVM + PVM simultaneously");
  }
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

  // Connect the gas estimator so the monitor feeds block fee data to the executor
  monitor.setGasEstimator(executor.getGasEstimator());

  // ─── Metrics server (§3.3) ────────────────────────────────────────────
  let metricsServer: MetricsServer | null = null;
  if (config.metricsPort > 0) {
    metricsServer = new MetricsServer();
    metricsServer.start(config.metricsPort);
  } else {
    logger.info("METRICS_PORT=0 — Prometheus endpoint disabled");
  }

  // ─── Persistence (§3.2) — restore + schedule snapshots ────────────────
  let persistence: ContextPersistence | null = null;
  if (config.persistenceDbPath) {
    persistence = new ContextPersistence({
      dbPath: config.persistenceDbPath,
      flushIntervalBlocks: config.persistenceFlushBlocks,
    });
    const restored = persistence.restoreLatest();
    if (restored) {
      try {
        context.restoreFromSnapshot(restored.snapshot);
        monitor.setLastProcessedBlock(restored.blockNumber);
        logger.info(
          `Resumed from persisted snapshot at block ${restored.blockNumber} ` +
            `(skipping cold-start rebuild)`
        );
      } catch (err) {
        logger.warn(
          `Could not restore snapshot: ${(err as Error).message}. Starting cold.`
        );
      }
    }
    monitor.setPersistence(persistence);
  } else {
    logger.info("PERSISTENCE_DB_PATH not set — context state will be lost on restart");
  }

  // ─── Heartbeat (on-chain liveness proof) ────────────────────────────────
  let heartbeat: HeartbeatClient | null = null;

  if (config.heartbeatAddress) {
    const wallet = new ethers.Wallet(config.agentPrivateKey, provider);
    heartbeat = new HeartbeatClient(
      config.heartbeatAddress,
      wallet,
      config.heartbeatIntervalBlocks
    );

    // Check initial status
    try {
      const status = await heartbeat.checkStatus();
      logger.info(
        `Heartbeat status: alive=${status.alive}, pings=${status.pingCount}, ` +
        `blocksSinceLastPing=${status.blocksSinceLastPing}`
      );
    } catch (err) {
      logger.warn(`Heartbeat status check failed (non-fatal): ${(err as Error).message}`);
    }
  } else {
    logger.info("HEARTBEAT_ADDRESS not set - on-chain liveness proof disabled");
  }

  // Connect heartbeat to monitor so it pings on each new block
  monitor.setHeartbeat(heartbeat);

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

  const vmMode = executor.getActiveVMs().join("+");
  await alerter.sendAlert({
    type: "AGENT_STARTED",
    message: `ChainSentinel agent started. Mode: ${vmMode}. Monitoring vault(s): ${config.vaultAddress.slice(0, 10)}...` +
      (config.vaultAddressPvm ? ` + ${config.vaultAddressPvm.slice(0, 10)}...` : "") +
      (heartbeat ? ` | Heartbeat: every ${config.heartbeatIntervalBlocks} blocks` : ""),
    timestamp: Date.now(),
  });

  await monitor.start(async (txs, _blockNum) => {
    for (const tx of txs) {
      const assessment = await analyzeTransaction(tx, context, config);

      if (assessment.score === 0) continue;

      const escalation = determineEscalation(assessment.score, assessment.llmUsed);

      logger.info(
        `Assessment for tx ${tx.hash}: score=${assessment.score}, ` +
        `classification=${assessment.classification}, escalation=${escalation}`
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
          message: `[${escalation}] Threat detected! Score: ${assessment.score}/100`,
          timestamp: Date.now(),
        });
      }

      // Executor handles graduated response internally:
      //   MONITOR → no-op (returns [])
      //   REPORT  → reportThreat() only
      //   DEFENSIVE_WITHDRAW → emergencyWithdraw(native) + reportThreat()
      //   EMERGENCY_WITHDRAW_ALL → emergencyWithdrawAll() + reportThreat()
      //
      // Every on-chain write is preceded by a simulation (eth_call dry-run).
      const results = await executor.execute(assessment);

      for (const result of results) {
        if (result.success && (result.action === "EMERGENCY_WITHDRAW_ALL" || result.action === "EMERGENCY_WITHDRAW")) {
          await alerter.sendAlert({
            type: "EMERGENCY_EXECUTED",
            assessment,
            message: `[${result.vmLabel ?? "REVM"}] ${escalation} executed! Tx: ${result.txHash}`,
            timestamp: Date.now(),
          });
        }
      }
    }
  });

  const shutdown = async () => {
    logger.info("Shutting down...");
    if (xcmMonitor) await xcmMonitor.stop();
    await monitor.stop();
    // Final snapshot before close so we don't lose the most recent state
    if (persistence) {
      try {
        const lastBlock = await provider.getBlockNumber();
        persistence.flush(context, lastBlock);
      } catch (err) {
        logger.warn(`Final snapshot failed: ${(err as Error).message}`);
      }
      persistence.close();
    }
    if (metricsServer) {
      try { await metricsServer.stop(); } catch { /* shutting down anyway */ }
    }
    await alerter.sendAlert({
      type: "AGENT_STOPPED",
      message: "ChainSentinel agent stopped.",
      timestamp: Date.now(),
    });
    // Flush any in-flight Sentry events before the process exits.
    await flushSentry(2000);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info("=== ChainSentinel Agent Running ===");
}

main().catch(async (error) => {
  logger.error("Fatal error:", error);
  captureException(error, { tags: { phase: "fatal_main" } });
  await flushSentry(2000);
  process.exit(1);
});
