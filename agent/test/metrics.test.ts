import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  registry,
  blocksProcessed,
  blocksFetched,
  heuristicTriggered,
  llmCalls,
  llmFailures,
  emergencyWithdraws,
  simulationReverts,
  threatReports,
  persistenceSnapshots,
  blockProcessingSeconds,
  blockEnrichmentSeconds,
  llmCallSeconds,
  MetricsServer,
  resetMetricsForTests,
} from "../src/metrics.js";

describe("metrics module", () => {
  beforeEach(() => {
    resetMetricsForTests();
  });

  // NOTE: prom-client v15 emits label key/value pairs in DECLARATION order
  // (the order passed to `labelNames` when constructing the metric), and
  // appends the registry's default labels (e.g. `service`) at the END.
  // The assertions below match the literal serialized form.

  it("counters start at zero and increment correctly", async () => {
    blocksProcessed.inc();
    blocksProcessed.inc();
    blocksFetched.inc();

    const text = await registry.metrics();
    expect(text).toMatch(/chainsentinel_blocks_processed_total\{service="chainsentinel-agent"} 2/);
    expect(text).toMatch(/chainsentinel_blocks_fetched_total\{service="chainsentinel-agent"} 1/);
  });

  it("labelled counters track each label combination independently", async () => {
    heuristicTriggered.inc({ rule: "FLASH_LOAN_PATTERN" });
    heuristicTriggered.inc({ rule: "FLASH_LOAN_PATTERN" });
    heuristicTriggered.inc({ rule: "TX_BURST" });

    const text = await registry.metrics();
    // Declaration order: rule (declared) then service (default appended at end)
    expect(text).toContain('chainsentinel_heuristic_triggered_total{rule="FLASH_LOAN_PATTERN",service="chainsentinel-agent"} 2');
    expect(text).toContain('chainsentinel_heuristic_triggered_total{rule="TX_BURST",service="chainsentinel-agent"} 1');
  });

  it("emergencyWithdraws labels distinguish success/failure × VM × level", async () => {
    emergencyWithdraws.inc({ success: "true", vm: "REVM", level: "EMERGENCY_WITHDRAW_ALL" });
    emergencyWithdraws.inc({ success: "false", vm: "REVM", level: "DEFENSIVE_WITHDRAW" });
    emergencyWithdraws.inc({ success: "true", vm: "PVM", level: "EMERGENCY_WITHDRAW_ALL" });

    const text = await registry.metrics();
    // Declaration order in metrics.ts: ["success", "vm", "level"], then service
    expect(text).toContain('chainsentinel_emergency_withdraws_total{success="true",vm="REVM",level="EMERGENCY_WITHDRAW_ALL",service="chainsentinel-agent"} 1');
    expect(text).toContain('chainsentinel_emergency_withdraws_total{success="false",vm="REVM",level="DEFENSIVE_WITHDRAW",service="chainsentinel-agent"} 1');
    expect(text).toContain('chainsentinel_emergency_withdraws_total{success="true",vm="PVM",level="EMERGENCY_WITHDRAW_ALL",service="chainsentinel-agent"} 1');
  });

  it("llm failure reasons keep separate counts", async () => {
    llmFailures.inc({ reason: "timeout" });
    llmFailures.inc({ reason: "timeout" });
    llmFailures.inc({ reason: "parse_error" });
    llmFailures.inc({ reason: "api_error" });

    const text = await registry.metrics();
    expect(text).toContain('reason="timeout",service="chainsentinel-agent"} 2');
    expect(text).toContain('reason="parse_error",service="chainsentinel-agent"} 1');
    expect(text).toContain('reason="api_error",service="chainsentinel-agent"} 1');
  });

  it("simulationReverts and threatReports increments are observable", async () => {
    simulationReverts.inc({ method: "emergencyWithdrawAll", vm: "REVM" });
    threatReports.inc({ level: "REPORT", success: "true", vm: "REVM" });
    persistenceSnapshots.inc({ status: "ok" });
    llmCalls.inc();

    const text = await registry.metrics();
    // simulationReverts labelNames: ["method", "vm"]
    expect(text).toContain('chainsentinel_simulation_reverts_total{method="emergencyWithdrawAll",vm="REVM",service="chainsentinel-agent"} 1');
    // threatReports labelNames: ["level", "success", "vm"]
    expect(text).toContain('chainsentinel_threat_reports_total{level="REPORT",success="true",vm="REVM",service="chainsentinel-agent"} 1');
    // persistenceSnapshots labelNames: ["status"]
    expect(text).toContain('chainsentinel_persistence_snapshots_total{status="ok",service="chainsentinel-agent"} 1');
    expect(text).toContain('chainsentinel_llm_calls_total{service="chainsentinel-agent"} 1');
  });

  it("histogram observe records timing buckets", async () => {
    blockProcessingSeconds.observe(0.05);
    blockProcessingSeconds.observe(2.5);
    blockEnrichmentSeconds.observe(0.3);
    llmCallSeconds.observe(1.5);

    const text = await registry.metrics();
    // Histograms emit _count, _sum, and per-bucket _bucket lines
    expect(text).toMatch(/chainsentinel_block_processing_seconds_count[^]*?} 2/);
    expect(text).toMatch(/chainsentinel_block_enrichment_seconds_count[^]*?} 1/);
    expect(text).toMatch(/chainsentinel_llm_call_seconds_count[^]*?} 1/);
  });

  it("histogram startTimer returns a stop function that records elapsed seconds", async () => {
    const stop = blockProcessingSeconds.startTimer();
    await new Promise((r) => setTimeout(r, 10));
    stop();

    const text = await registry.metrics();
    expect(text).toMatch(/chainsentinel_block_processing_seconds_count[^]*?} 1/);
  });

  it("default Node.js metrics are exposed under chainsentinel_node_ prefix", async () => {
    const text = await registry.metrics();
    expect(text).toMatch(/chainsentinel_node_process_cpu_user_seconds_total/);
    expect(text).toMatch(/chainsentinel_node_nodejs_heap_size_total_bytes/);
  });
});

describe("MetricsServer", () => {
  let server: MetricsServer;
  // Use a high port unlikely to collide with anything in CI
  const TEST_PORT = 19099;

  beforeEach(() => {
    resetMetricsForTests();
    server = new MetricsServer();
  });

  afterEach(async () => {
    await server.stop();
  });

  it("isRunning() reflects start/stop state", async () => {
    expect(server.isRunning()).toBe(false);
    server.start(TEST_PORT);
    expect(server.isRunning()).toBe(true);
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("/health returns 200 ok", async () => {
    server.start(TEST_PORT);
    // Allow listen() callback to fire
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("/metrics returns Prometheus exposition format with our metric names", async () => {
    blocksProcessed.inc();
    server.start(TEST_PORT);
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/metrics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    const text = await res.text();
    expect(text).toContain("chainsentinel_blocks_processed_total");
  });

  it("unknown paths return 404", async () => {
    server.start(TEST_PORT);
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/nope`);
    expect(res.status).toBe(404);
  });

  it("stop() is safe to call when not started", async () => {
    await expect(server.stop()).resolves.toBeUndefined();
  });

  it("start() is idempotent (second call is a no-op)", async () => {
    server.start(TEST_PORT);
    server.start(TEST_PORT); // should not throw EADDRINUSE
    expect(server.isRunning()).toBe(true);
  });
});
