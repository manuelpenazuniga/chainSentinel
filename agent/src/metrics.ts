// ============================================================================
// ChainSentinel — Prometheus Metrics (§3.3)
// ============================================================================
//
// Exposes runtime telemetry over an HTTP endpoint that Prometheus / Grafana /
// any compatible scraper can read. The agent emits counters and histograms at
// every observable inflection point so operators can:
//
//   - Catch silent regressions (LLM latency creeping up, simulation reverts
//     spiking, heuristic-rule misfires) before users notice.
//   - Quantify the agent's effectiveness (emergency_withdraws_total{success="true"}).
//   - Build alerts: e.g. "page if blocks_processed_total stops increasing for 60s".
//
// Endpoints exposed by `MetricsServer`:
//   GET /metrics  → Prometheus exposition format (text/plain; version=0.0.4)
//   GET /health   → 200 "ok" (for K8s/Docker liveness probes)
//
// The metrics module also auto-collects Node.js defaults (heap, GC, event-loop
// lag) under the `chainsentinel_` namespace.
// ============================================================================

import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";
import { createServer, Server } from "http";
import { createLogger } from "./logger.js";

const logger = createLogger("metrics");

// ─── Registry ───────────────────────────────────────────────────────────────
//
// We use a dedicated Registry instance (instead of the global default) so that
// tests can spawn isolated metric universes without polluting each other. All
// metrics in this module register against `registry`.

export const registry = new Registry();
registry.setDefaultLabels({ service: "chainsentinel-agent" });
collectDefaultMetrics({ register: registry, prefix: "chainsentinel_node_" });

// ─── Counters ───────────────────────────────────────────────────────────────

export const blocksProcessed = new Counter({
  name: "chainsentinel_blocks_processed_total",
  help: "Total blocks fully processed by the monitor (enriched + analysed + persisted)",
  registers: [registry],
});

export const blocksFetched = new Counter({
  name: "chainsentinel_blocks_fetched_total",
  help: "Total blocks fetched from the RPC (parallel enrichment phase)",
  registers: [registry],
});

export const heuristicTriggered = new Counter({
  name: "chainsentinel_heuristic_triggered_total",
  help: "Times a specific heuristic rule fired across all transactions",
  labelNames: ["rule"] as const,
  registers: [registry],
});

export const llmCalls = new Counter({
  name: "chainsentinel_llm_calls_total",
  help: "Total LLM (Gemini) calls dispatched",
  registers: [registry],
});

export const llmFailures = new Counter({
  name: "chainsentinel_llm_failures_total",
  help: "LLM call failures grouped by reason",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const emergencyWithdraws = new Counter({
  name: "chainsentinel_emergency_withdraws_total",
  help: "Emergency withdrawal attempts (the KPI metric)",
  labelNames: ["success", "vm", "level"] as const,
  registers: [registry],
});

export const simulationReverts = new Counter({
  name: "chainsentinel_simulation_reverts_total",
  help: "On-chain write simulations (eth_call dry-run) that reverted",
  labelNames: ["method", "vm"] as const,
  registers: [registry],
});

export const persistenceSnapshots = new Counter({
  name: "chainsentinel_persistence_snapshots_total",
  help: "Persistence snapshot writes grouped by status",
  labelNames: ["status"] as const,
  registers: [registry],
});

export const threatReports = new Counter({
  name: "chainsentinel_threat_reports_total",
  help: "Threat reports published to the registry, by escalation level and outcome",
  labelNames: ["level", "success", "vm"] as const,
  registers: [registry],
});

// ─── Histograms ─────────────────────────────────────────────────────────────

export const blockProcessingSeconds = new Histogram({
  name: "chainsentinel_block_processing_seconds",
  help: "Wall-clock time to fully process one block",
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
  registers: [registry],
});

export const llmCallSeconds = new Histogram({
  name: "chainsentinel_llm_call_seconds",
  help: "Latency of a single Gemini LLM call",
  buckets: [0.5, 1, 2, 5, 10, 20, 30],
  registers: [registry],
});

export const blockEnrichmentSeconds = new Histogram({
  name: "chainsentinel_block_enrichment_seconds",
  help: "Wall-clock time for the enrichment phase (RPC fan-out) of a single block",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

// ─── HTTP Server ────────────────────────────────────────────────────────────

/**
 * Tiny HTTP server that serves `/metrics` and `/health`. Designed to be cheap:
 * a single Node `http` server, no Express, no middleware, no dependencies.
 *
 * Lifecycle:
 *   const srv = new MetricsServer();
 *   srv.start(9090);   // listens on 0.0.0.0:9090
 *   // ... agent runs ...
 *   await srv.stop();  // closes gracefully on shutdown
 */
export class MetricsServer {
  private server: Server | null = null;

  start(port: number): void {
    if (this.server) return; // already started, idempotent

    this.server = createServer(async (req, res) => {
      try {
        if (req.url === "/metrics") {
          const body = await registry.metrics();
          res.statusCode = 200;
          res.setHeader("Content-Type", registry.contentType);
          res.end(body);
        } else if (req.url === "/health") {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/plain");
          res.end("ok");
        } else {
          res.statusCode = 404;
          res.end();
        }
      } catch (error) {
        res.statusCode = 500;
        res.end(`metrics error: ${(error as Error).message}`);
      }
    });

    this.server.listen(port, () => {
      logger.info(`Metrics server listening on :${port}/metrics + /health`);
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
    logger.info("Metrics server stopped");
  }

  /** Exposed for tests that want to assert on the server's state. */
  isRunning(): boolean {
    return this.server !== null;
  }
}

// ─── Test helpers ───────────────────────────────────────────────────────────

/** Reset every metric in the registry. ONLY for use in tests. */
export function resetMetricsForTests(): void {
  registry.resetMetrics();
}
