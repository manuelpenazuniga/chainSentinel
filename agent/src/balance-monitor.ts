// ============================================================================
// ChainSentinel — Agent Balance Monitor (§3.8)
// ============================================================================
//
// Why this exists: in single-user mode the operator (you) eventually notices
// when the agent runs out of gas because there's only one wallet to watch.
// In multi-user mode (`plan-multiusuario-definitivo.md`) the gas tank is
// centralized — the agent pays for emergency withdrawals on behalf of every
// vault. If that wallet drains silently, the executor's catch block swallows
// the runtime "insufficient funds" error and you only discover the problem
// when the first rescue fails. By then it's too late for at least one user.
//
// This module periodically reads the agent wallet's balance and:
//   - Publishes the current balance as a Prometheus gauge
//     (`chainsentinel_agent_balance_pas`) for Grafana dashboards.
//   - Fires an AGENT_ERROR alert through the multi-channel Alerter (§6.3)
//     when the balance drops below a configurable threshold.
//   - Fires a recovery alert when the balance rises back above the threshold
//     (closes the operator loop: "OK, someone topped it up").
//
// Cooldowns:
//   - `intervalBlocks`  — how often we even consult the RPC (default 50 blocks
//                         ≈ 5 min on Polkadot Hub). Bounds RPC traffic.
//   - `alertCooldownMs` — minimum delay between repeated low-balance alerts
//                         while the balance stays below threshold (default 1h).
//                         Without this, operators get 12 identical alerts/hour
//                         and mute the channel — classic alert fatigue.
//
// All failures (RPC errors, alert delivery errors) are swallowed with a warn
// log. The balance monitor is a side observer; it must never crash or block
// the agent's main detection loop.
// ============================================================================

import { ethers } from "ethers";
import { Alerter } from "./alerter.js";
import { agentBalancePas, lowBalanceAlerts } from "./metrics.js";
import { createLogger } from "./logger.js";

const logger = createLogger("balance-monitor");

export interface BalanceMonitorConfig {
  /** Minimum acceptable balance in wei. Falling below triggers an alert. */
  minBalanceWei: bigint;
  /** Blocks between RPC reads (default: 50 ≈ 5 min @ 6s blocks). */
  intervalBlocks: number;
  /**
   * Minimum milliseconds between repeated low-balance alerts while the
   * balance remains below threshold (anti-spam). Default: 1 h.
   */
  alertCooldownMs: number;
}

/**
 * BalanceMonitor — periodic agent wallet balance check + alerting.
 *
 * Lifecycle (mirrors HeartbeatClient):
 *   const bm = new BalanceMonitor(provider, address, alerter, config);
 *   await bm.checkNow();             // optional eager check at startup
 *   monitor.setBalanceMonitor(bm);   // wire into the per-block loop
 *   // ... agent runs, maybeCheck fires every `intervalBlocks` blocks ...
 */
export class BalanceMonitor {
  private lastCheckedBlock = 0;
  private lastAlertedAt = 0;
  /** Internal state machine: were we below threshold on the last check? */
  private wasLow = false;

  constructor(
    // Accepts any AbstractProvider so the shared FallbackProvider works (§3.4).
    private readonly provider: ethers.AbstractProvider,
    private readonly agentAddress: string,
    private readonly alerter: Alerter,
    private readonly config: BalanceMonitorConfig
  ) {}

  /**
   * Read the wallet balance immediately and reconcile alerts. Returns the
   * balance in wei. Used at startup and from `maybeCheck`.
   *
   * Errors are caught, logged, and swallowed — this monitor is best-effort
   * and must NEVER crash the agent.
   */
  async checkNow(currentTime: number = Date.now()): Promise<bigint | null> {
    let balance: bigint;
    try {
      balance = await this.provider.getBalance(this.agentAddress);
    } catch (err) {
      logger.warn(`Balance check RPC failed: ${(err as Error).message}`);
      return null;
    }

    // Publish the gauge in PAS units (more readable in Grafana than wei).
    // Number conversion is safe up to ~9 × 10^15 PAS — far beyond any
    // realistic agent balance.
    agentBalancePas.set(Number(ethers.formatEther(balance)));

    const isLow = balance < this.config.minBalanceWei;

    if (isLow) {
      const elapsed = currentTime - this.lastAlertedAt;
      // First low-balance event OR cooldown has elapsed → alert
      if (!this.wasLow || elapsed >= this.config.alertCooldownMs) {
        await this.alertLow(balance);
        this.lastAlertedAt = currentTime;
        lowBalanceAlerts.inc();
      }
      this.wasLow = true;
    } else if (this.wasLow) {
      // Recovery: previously low, now healthy → notify and reset state.
      await this.alertRecovered(balance);
      this.wasLow = false;
      this.lastAlertedAt = 0;
    }

    return balance;
  }

  /**
   * Called from the Monitor's per-block loop. No-op until `intervalBlocks`
   * have elapsed since the last check. Swallows all errors so a transient
   * RPC failure cannot block block processing.
   */
  async maybeCheck(blockNumber: number): Promise<void> {
    if (blockNumber - this.lastCheckedBlock < this.config.intervalBlocks) return;
    this.lastCheckedBlock = blockNumber;
    try {
      await this.checkNow();
    } catch (err) {
      // checkNow already swallows internally, this is defense in depth.
      logger.warn(`Balance check failed unexpectedly: ${(err as Error).message}`);
    }
  }

  /** Internal — emit the AGENT_ERROR alert and log the warning. */
  private async alertLow(balance: bigint): Promise<void> {
    const balancePas = ethers.formatEther(balance);
    const minPas = ethers.formatEther(this.config.minBalanceWei);
    const shortAddr = `${this.agentAddress.slice(0, 6)}…${this.agentAddress.slice(-4)}`;
    const message =
      `Agent ${shortAddr} balance LOW: ${balancePas} PAS ` +
      `(threshold: ${minPas}). Emergency withdrawals will start to revert if balance reaches 0. ` +
      `Top up the wallet immediately.`;

    logger.warn(message);
    try {
      await this.alerter.sendAlert({
        type: "AGENT_ERROR",
        message,
        timestamp: Date.now(),
      });
    } catch (err) {
      // Multi-channel alerter already swallows per-channel failures, so this
      // catch only fires on truly catastrophic errors. Either way, never
      // propagate.
      logger.warn(`Low-balance alert delivery failed: ${(err as Error).message}`);
    }
  }

  /** Internal — emit the recovery alert. */
  private async alertRecovered(balance: bigint): Promise<void> {
    const balancePas = ethers.formatEther(balance);
    const message = `Agent balance recovered to ${balancePas} PAS — operating normally.`;
    logger.info(message);
    try {
      await this.alerter.sendAlert({
        type: "AGENT_STARTED",
        message,
        timestamp: Date.now(),
      });
    } catch (err) {
      logger.warn(`Recovery alert delivery failed: ${(err as Error).message}`);
    }
  }

  /** Test helper — observe internal state. */
  isCurrentlyLow(): boolean {
    return this.wasLow;
  }
}
