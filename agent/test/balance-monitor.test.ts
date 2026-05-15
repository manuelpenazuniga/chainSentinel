import { describe, it, expect, vi, beforeEach } from "vitest";
import { ethers } from "ethers";
import { BalanceMonitor } from "../src/balance-monitor.js";
import { Alerter } from "../src/alerter.js";
import { AgentConfig, AlertData } from "../src/types.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

const AGENT_ADDR = "0x1234567890123456789012345678901234567890";
const ONE_PAS = ethers.parseEther("1");
const HALF_PAS = ethers.parseEther("0.5");
const TENTH_PAS = ethers.parseEther("0.1");

function buildConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    rpcUrl: "http://localhost",
    chainId: 1,
    agentPrivateKey: "0x" + "0".repeat(64),
    vaultAddress: "0x0000000000000000000000000000000000000001",
    registryAddress: "0x0000000000000000000000000000000000000002",
    geminiApiKey: "dummy",
    heuristicThreshold: 30,
    emergencyThreshold: 80,
    cooldownBlocks: 10,
    llmTimeoutMs: 10_000,
    heartbeatIntervalBlocks: 50,
    persistenceFlushBlocks: 100,
    metricsPort: 0,
    pagerDutyMinScore: 70,
    minAgentBalancePas: 0.5,
    balanceCheckIntervalBlocks: 50,
    balanceAlertCooldownMs: 3_600_000,
    ...overrides,
  };
}

interface MockedAlerter {
  alerter: Alerter;
  sentAlerts: AlertData[];
}

/**
 * Build a real Alerter instance and spy on its sendAlert. We use a real one
 * (not a mock) so the test catches breakages if the Alerter signature changes.
 */
function buildAlerterSpy(): MockedAlerter {
  const alerter = new Alerter(buildConfig());
  const sentAlerts: AlertData[] = [];
  vi.spyOn(alerter, "sendAlert").mockImplementation(async (a: AlertData) => {
    sentAlerts.push(a);
  });
  return { alerter, sentAlerts };
}

function buildProvider(balance: bigint): ethers.JsonRpcProvider {
  // We don't need a real provider — only getBalance is called.
  const provider = {} as ethers.JsonRpcProvider;
  provider.getBalance = vi.fn().mockResolvedValue(balance);
  return provider;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("BalanceMonitor.checkNow", () => {
  let alerterCtx: MockedAlerter;
  beforeEach(() => {
    alerterCtx = buildAlerterSpy();
  });

  it("does NOT alert when balance is above threshold", async () => {
    const provider = buildProvider(ONE_PAS); // 1 PAS, threshold 0.5
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    const balance = await bm.checkNow();
    expect(balance).toBe(ONE_PAS);
    expect(alerterCtx.sentAlerts).toEqual([]);
    expect(bm.isCurrentlyLow()).toBe(false);
  });

  it("alerts AGENT_ERROR when balance drops below threshold", async () => {
    const provider = buildProvider(TENTH_PAS); // 0.1 PAS, threshold 0.5
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    await bm.checkNow();

    expect(alerterCtx.sentAlerts).toHaveLength(1);
    const alert = alerterCtx.sentAlerts[0];
    expect(alert.type).toBe("AGENT_ERROR");
    expect(alert.message).toMatch(/balance LOW/i);
    expect(alert.message).toContain("0.1");
    expect(alert.message).toContain("0.5"); // threshold
    expect(bm.isCurrentlyLow()).toBe(true);
  });

  it("alerts EXACTLY ONCE during the cooldown window when balance stays low", async () => {
    const provider = buildProvider(TENTH_PAS);
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000, // 1 h
    });

    const t0 = 1_700_000_000_000;
    await bm.checkNow(t0);
    await bm.checkNow(t0 + 5 * 60 * 1000); // +5 min
    await bm.checkNow(t0 + 30 * 60 * 1000); // +30 min
    await bm.checkNow(t0 + 59 * 60 * 1000); // +59 min — still inside 1h cooldown

    expect(alerterCtx.sentAlerts).toHaveLength(1);
  });

  it("re-alerts after the cooldown window elapses", async () => {
    const provider = buildProvider(TENTH_PAS);
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 60_000, // 60 s for testability
    });

    const t0 = 1_700_000_000_000;
    await bm.checkNow(t0);
    await bm.checkNow(t0 + 30_000); // +30s — still cooled
    await bm.checkNow(t0 + 70_000); // +70s — cooldown elapsed → re-alert

    expect(alerterCtx.sentAlerts).toHaveLength(2);
    expect(alerterCtx.sentAlerts[0].type).toBe("AGENT_ERROR");
    expect(alerterCtx.sentAlerts[1].type).toBe("AGENT_ERROR");
  });

  it("emits a recovery alert when balance climbs back above threshold", async () => {
    const provider = {} as ethers.JsonRpcProvider;
    let returnedBalance = TENTH_PAS;
    provider.getBalance = vi.fn().mockImplementation(async () => returnedBalance);

    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    await bm.checkNow(); // LOW → alert #1 (AGENT_ERROR)
    expect(alerterCtx.sentAlerts).toHaveLength(1);

    // Top-up: balance recovers to 2 PAS
    returnedBalance = ethers.parseEther("2");
    await bm.checkNow(); // RECOVERED → alert #2 (AGENT_STARTED w/ recovery message)

    expect(alerterCtx.sentAlerts).toHaveLength(2);
    expect(alerterCtx.sentAlerts[1].type).toBe("AGENT_STARTED");
    expect(alerterCtx.sentAlerts[1].message).toMatch(/recovered/i);
    expect(bm.isCurrentlyLow()).toBe(false);
  });

  it("does not re-alert recovery if already healthy (no oscillation noise)", async () => {
    const provider = buildProvider(ONE_PAS);
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    await bm.checkNow();
    await bm.checkNow();
    await bm.checkNow();

    expect(alerterCtx.sentAlerts).toEqual([]);
  });

  it("returns null and does NOT alert when the RPC throws", async () => {
    const provider = {} as ethers.JsonRpcProvider;
    provider.getBalance = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    const balance = await bm.checkNow();
    expect(balance).toBeNull();
    expect(alerterCtx.sentAlerts).toEqual([]);
    // wasLow stays false — we never confirmed a low state
    expect(bm.isCurrentlyLow()).toBe(false);
  });

  it("treats balance EXACTLY at threshold as healthy (strict <)", async () => {
    const provider = buildProvider(HALF_PAS); // exactly 0.5 PAS
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    await bm.checkNow();
    expect(alerterCtx.sentAlerts).toEqual([]);
    expect(bm.isCurrentlyLow()).toBe(false);
  });
});

describe("BalanceMonitor.maybeCheck (per-block hook)", () => {
  let alerterCtx: MockedAlerter;
  beforeEach(() => {
    alerterCtx = buildAlerterSpy();
  });

  it("is a no-op until intervalBlocks have elapsed since the last check", async () => {
    const provider = buildProvider(ONE_PAS);
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    // First call ALWAYS fires (lastCheckedBlock starts at 0; any blockNumber > 0 fires).
    await bm.maybeCheck(100);
    expect(provider.getBalance).toHaveBeenCalledTimes(1);

    // Subsequent within the interval: no-op
    await bm.maybeCheck(120); // 100 + 50 = 150, 120 < 150 → skip
    await bm.maybeCheck(149); // 149 < 150 → skip
    expect(provider.getBalance).toHaveBeenCalledTimes(1);

    // At/after the interval: fires again
    await bm.maybeCheck(150); // boundary → fires
    expect(provider.getBalance).toHaveBeenCalledTimes(2);

    await bm.maybeCheck(199); // 150 + 50 = 200, 199 < 200 → skip
    await bm.maybeCheck(200); // boundary → fires
    expect(provider.getBalance).toHaveBeenCalledTimes(3);
  });

  it("swallows checkNow errors so block processing is never blocked", async () => {
    const provider = {} as ethers.JsonRpcProvider;
    provider.getBalance = vi.fn().mockRejectedValue(new Error("RPC down"));
    const bm = new BalanceMonitor(provider, AGENT_ADDR, alerterCtx.alerter, {
      minBalanceWei: HALF_PAS,
      intervalBlocks: 50,
      alertCooldownMs: 3_600_000,
    });

    await expect(bm.maybeCheck(100)).resolves.toBeUndefined();
  });
});
