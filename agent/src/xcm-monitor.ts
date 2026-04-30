// ============================================================================
// ChainSentinel — XCM Threat Monitor
// ============================================================================
//
// Monitors cross-chain transfers via Substrate RPC events on Polkadot Hub.
// XCM (Cross-Consensus Messaging) transfers are invisible to eth-rpc — they
// only appear as Substrate events. An attacker draining funds via EVM could
// immediately move the stolen assets to another parachain via XCM to escape
// monitoring. This module closes that blind spot.
//
// Detection strategy:
//   1. Subscribe to finalized blocks via polkadot-api.
//   2. For each block, scan for XCM-related events (PolkadotXcm.Sent,
//      XcmpQueue.XcmpMessageSent, Balances.Withdraw with XCM context).
//   3. Flag transfers that match suspicious patterns:
//      - Large outbound XCM transfer (amount >> historical average)
//      - XCM transfer from a recently-active EVM address (cross-layer escape)
//      - Rapid sequence of XCM transfers to different parachains (chain-hopping)
//      - XCM from a blacklisted address
//   4. Emit XcmThreatEvent for the alerter to pick up.
//
// Architecture:
//   This module operates independently from monitor.ts (which polls eth-rpc).
//   It connects to the same Substrate WebSocket already established by
//   AgentKitWrapper.initSubstrate(). Both monitors run concurrently —
//   EVM monitor catches contract-level attacks, XCM monitor catches
//   cross-chain fund movements.
// ============================================================================

import { createClient } from "polkadot-api";
import { createLogger } from "./logger.js";

const logger = createLogger("xcm-monitor");

// ─── Types ──────────────────────────────────────────────────────────────────

/** Parsed XCM transfer event from Substrate. */
export interface XcmTransferEvent {
  blockNumber: number;
  blockHash: string;
  /** Origin address (AccountId32 hex or H160-derived) */
  origin: string;
  /** Destination parachain ID (e.g. 1000 = Asset Hub, 2000 = Acala, etc.) */
  destinationParaId: number | null;
  /** Amount transferred in planck (native token) */
  amount: bigint;
  /** The specific event that was detected */
  eventType: XcmEventType;
  /** Raw event data for debugging */
  rawData: unknown;
}

export type XcmEventType =
  | "PolkadotXcm.Sent"
  | "PolkadotXcm.Attempted"
  | "XcmpQueue.XcmpMessageSent"
  | "Balances.Withdraw";

/** Threat assessment for an XCM transfer. */
export interface XcmThreatEvent {
  transfer: XcmTransferEvent;
  threatScore: number;
  reasons: string[];
  classification: "NORMAL" | "SUSPICIOUS" | "HIGH_RISK";
}

/** Callback for when a suspicious XCM transfer is detected. */
export type XcmThreatCallback = (event: XcmThreatEvent) => void | Promise<void>;

// ─── XCM Threat Scoring ─────────────────────────────────────────────────────

interface XcmScoringContext {
  /** Average XCM transfer amount (rolling, in planck). */
  avgXcmAmount: bigint;
  /** Number of XCM transfers seen so far. */
  totalXcmTransfers: number;
  /** Recent XCM transfers per origin (for burst detection). */
  recentByOrigin: Map<string, { count: number; lastBlock: number }>;
  /** Blacklisted addresses (shared with EVM monitor). */
  blacklist: Set<string>;
  /** Addresses involved in recent high-score EVM events. */
  recentEvmThreats: Set<string>;
}

const XCM_RULES = {
  LARGE_XCM_TRANSFER: {
    score: 35,
    description: "XCM transfer amount > 10x historical average",
  },
  BLACKLISTED_XCM_SENDER: {
    score: 50,
    description: "XCM sender is on the blacklist",
  },
  POST_EXPLOIT_ESCAPE: {
    score: 45,
    description: "XCM transfer from address involved in recent EVM threat",
  },
  XCM_BURST: {
    score: 30,
    description: "3+ XCM transfers from same origin within 5 blocks",
  },
} as const;

function scoreXcmTransfer(
  transfer: XcmTransferEvent,
  ctx: XcmScoringContext
): XcmThreatEvent {
  let score = 0;
  const reasons: string[] = [];
  const originLc = transfer.origin.toLowerCase();

  // Rule 1: Large transfer
  if (ctx.avgXcmAmount > 0n && transfer.amount > ctx.avgXcmAmount * 10n) {
    score += XCM_RULES.LARGE_XCM_TRANSFER.score;
    reasons.push(
      `Transfer ${transfer.amount} planck > 10x avg ${ctx.avgXcmAmount} planck`
    );
  }

  // Rule 2: Blacklisted sender
  if (ctx.blacklist.has(originLc)) {
    score += XCM_RULES.BLACKLISTED_XCM_SENDER.score;
    reasons.push(`Sender ${originLc.slice(0, 10)}... is blacklisted`);
  }

  // Rule 3: Post-exploit escape (cross-layer correlation)
  if (ctx.recentEvmThreats.has(originLc)) {
    score += XCM_RULES.POST_EXPLOIT_ESCAPE.score;
    reasons.push(
      `Sender was flagged in recent EVM threat — possible cross-chain escape`
    );
  }

  // Rule 4: XCM burst
  const recent = ctx.recentByOrigin.get(originLc);
  if (recent && recent.count >= 3 &&
      transfer.blockNumber - recent.lastBlock <= 5) {
    score += XCM_RULES.XCM_BURST.score;
    reasons.push(
      `${recent.count} XCM transfers from same origin within 5 blocks`
    );
  }

  score = Math.min(100, score);

  const classification: XcmThreatEvent["classification"] =
    score >= 60 ? "HIGH_RISK" : score >= 30 ? "SUSPICIOUS" : "NORMAL";

  return { transfer, threatScore: score, reasons, classification };
}

// ─── XCM Monitor ────────────────────────────────────────────────────────────

export class XcmMonitor {
  private client: ReturnType<typeof createClient>;
  private scoringCtx: XcmScoringContext;
  private onThreat: XcmThreatCallback | null = null;
  private isRunning = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    client: ReturnType<typeof createClient>,
    blacklist?: Set<string>
  ) {
    this.client = client;
    this.scoringCtx = {
      avgXcmAmount: 0n,
      totalXcmTransfers: 0,
      recentByOrigin: new Map(),
      blacklist: blacklist ?? new Set(),
      recentEvmThreats: new Set(),
    };
  }

  /**
   * Register addresses that were flagged in recent EVM threat assessments.
   * When these addresses then perform XCM transfers, the POST_EXPLOIT_ESCAPE
   * rule fires — this is the cross-layer correlation that makes XCM monitoring
   * uniquely valuable.
   */
  registerEvmThreatAddress(address: string): void {
    this.scoringCtx.recentEvmThreats.add(address.toLowerCase());
  }

  /** Clear EVM threat addresses (call periodically to avoid unbounded growth). */
  clearEvmThreats(): void {
    this.scoringCtx.recentEvmThreats.clear();
  }

  /** Update the blacklist (shared with EVM monitor, refreshed from registry). */
  updateBlacklist(blacklist: Set<string>): void {
    this.scoringCtx.blacklist = blacklist;
  }

  /**
   * Start monitoring XCM events on finalized blocks.
   *
   * Uses polkadot-api's block subscription to watch every finalized block
   * for XCM-related events. This runs concurrently with the EVM HTTP poller
   * in monitor.ts — both are needed because XCM events are invisible to eth-rpc.
   */
  async start(onThreat: XcmThreatCallback): Promise<void> {
    this.onThreat = onThreat;
    this.isRunning = true;

    logger.info("XCM monitor starting — subscribing to finalized blocks...");

    const unsafeApi = this.client.getUnsafeApi();

    // watchValue returns an Observable — subscribe to get each finalized block's events
    const observable = unsafeApi.query.System.Events.watchValue("finalized");

    const subscription = observable.subscribe({
      next: (events: unknown) => {
        if (!this.isRunning) return;
        try {
          this.processEvents(events);
        } catch (err) {
          logger.debug(`XCM event processing error: ${(err as Error).message}`);
        }
      },
      error: (err: unknown) => {
        logger.error(`XCM event subscription error: ${(err as Error).message}`);
      },
    });

    this.unsubscribe = () => subscription.unsubscribe();

    logger.info("XCM monitor active — watching for cross-chain transfers");
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    logger.info("XCM monitor stopped");
  }

  /**
   * Process a block's events looking for XCM-related activity.
   *
   * Polkadot Hub emits these events for XCM transfers:
   *   - PolkadotXcm.Sent — outbound XCM message dispatched
   *   - PolkadotXcm.Attempted — XCM execution result (Complete/Error)
   *   - XcmpQueue.XcmpMessageSent — message enqueued for a sibling parachain
   *   - Balances.Withdraw — native balance decrease (may accompany XCM sends)
   *
   * The events array from System.Events is a SCALE-decoded structure.
   * We use a defensive, duck-typed approach because the unsafe API
   * doesn't provide typed event structures.
   */
  private processEvents(events: unknown): void {
    if (!Array.isArray(events)) return;

    for (const event of events) {
      const ev = event as {
        event?: {
          type?: string;
          value?: Record<string, unknown>;
        };
        phase?: unknown;
      };

      if (!ev?.event?.type) continue;

      const eventType = ev.event.type;
      const eventValue = ev.event.value ?? {};

      // ── PolkadotXcm.Sent ────────────────────────────────────────────────
      if (eventType === "PolkadotXcm" && this.getVariant(eventValue) === "Sent") {
        this.handleXcmSent(eventValue);
      }

      // ── XcmpQueue.XcmpMessageSent ───────────────────────────────────────
      if (eventType === "XcmpQueue" && this.getVariant(eventValue) === "XcmpMessageSent") {
        this.handleXcmpMessageSent(eventValue);
      }

      // ── Balances.Withdraw ──────────────────────────────────────────────
      if (eventType === "Balances" && this.getVariant(eventValue) === "Withdraw") {
        this.handleBalancesWithdraw(eventValue);
      }
    }
  }

  private getVariant(value: Record<string, unknown>): string | null {
    // polkadot-api represents enum events as { type: "VariantName", value: {...} }
    return (value as { type?: string }).type ?? null;
  }

  private handleXcmSent(eventValue: Record<string, unknown>): void {
    try {
      const value = (eventValue as { value?: Record<string, unknown> }).value ?? eventValue;
      const origin = this.extractOrigin(value);
      const destination = this.extractDestination(value);
      const amount = this.extractAmount(value);

      const transfer: XcmTransferEvent = {
        blockNumber: 0, // filled by caller if available
        blockHash: "",
        origin: origin ?? "unknown",
        destinationParaId: destination,
        amount: amount ?? 0n,
        eventType: "PolkadotXcm.Sent",
        rawData: value,
      };

      this.evaluateAndEmit(transfer);
    } catch (err) {
      logger.debug(`Failed to parse PolkadotXcm.Sent: ${(err as Error).message}`);
    }
  }

  private handleXcmpMessageSent(eventValue: Record<string, unknown>): void {
    try {
      const value = (eventValue as { value?: Record<string, unknown> }).value ?? eventValue;
      const transfer: XcmTransferEvent = {
        blockNumber: 0,
        blockHash: "",
        origin: "unknown",
        destinationParaId: null,
        amount: 0n,
        eventType: "XcmpQueue.XcmpMessageSent",
        rawData: value,
      };

      // XcmpMessageSent is a weaker signal — just log it for now
      logger.debug(`XCM message enqueued: ${JSON.stringify(value, (_, v) =>
        typeof v === "bigint" ? v.toString() : v
      ).slice(0, 200)}`);

      // Don't score unless we can extract meaningful fields
      if (transfer.amount > 0n || transfer.origin !== "unknown") {
        this.evaluateAndEmit(transfer);
      }
    } catch {
      // non-critical
    }
  }

  private handleBalancesWithdraw(eventValue: Record<string, unknown>): void {
    try {
      const value = (eventValue as { value?: Record<string, unknown> }).value ?? eventValue;
      const who = (value as { who?: string }).who;
      const amount = (value as { amount?: bigint | string }).amount;

      if (!who || !amount) return;

      // Balances.Withdraw events happen for many reasons (tx fees, transfers, etc.)
      // Only flag large withdrawals that could accompany XCM escapes
      const amountBig = BigInt(amount);
      const threshold = this.scoringCtx.avgXcmAmount > 0n
        ? this.scoringCtx.avgXcmAmount * 5n
        : 100n * 10n ** 10n; // 100 PAS default

      if (amountBig > threshold) {
        logger.debug(
          `Large Balances.Withdraw: ${who.toString().slice(0, 16)}... ` +
          `amount=${amountBig} planck (threshold=${threshold})`
        );
      }
    } catch {
      // non-critical
    }
  }

  // ─── Field extractors (defensive, duck-typed) ─────────────────────────

  private extractOrigin(value: Record<string, unknown>): string | null {
    // PolkadotXcm.Sent origin is typically a MultiLocation or AccountId
    const origin = value.origin ?? value.sender ?? value.who;
    if (typeof origin === "string") return origin;
    if (origin && typeof origin === "object") {
      const obj = origin as Record<string, unknown>;
      if (typeof obj.id === "string") return obj.id;
      if (typeof obj.value === "string") return obj.value;
    }
    return null;
  }

  private extractDestination(value: Record<string, unknown>): number | null {
    // Try to find parachain ID from destination MultiLocation
    const dest = value.destination ?? value.dest;
    if (!dest || typeof dest !== "object") return null;

    const d = dest as Record<string, unknown>;
    // Junctions can be nested: { interior: { X1: { Parachain: 2000 } } }
    const interior = d.interior ?? d;
    if (interior && typeof interior === "object") {
      const i = interior as Record<string, unknown>;
      // Try X1.Parachain
      const x1 = i.X1 ?? i.x1;
      if (x1 && typeof x1 === "object") {
        const parachain = (x1 as Record<string, unknown>).Parachain ??
                          (x1 as Record<string, unknown>).parachain;
        if (typeof parachain === "number") return parachain;
        if (typeof parachain === "string") return parseInt(parachain);
      }
      // Try direct parachain field
      if (typeof (i as Record<string, unknown>).parachain === "number") {
        return (i as Record<string, unknown>).parachain as number;
      }
    }
    return null;
  }

  private extractAmount(value: Record<string, unknown>): bigint | null {
    // Amount might be in assets, message, or a direct field
    const candidates = [value.amount, value.assets, value.total];
    for (const c of candidates) {
      if (typeof c === "bigint") return c;
      if (typeof c === "number") return BigInt(c);
      if (typeof c === "string" && /^\d+$/.test(c)) return BigInt(c);
    }
    // Try nested: assets[0].fun.Fungible
    if (Array.isArray(value.assets)) {
      for (const asset of value.assets) {
        const a = asset as Record<string, unknown>;
        const fun = a.fun ?? a.fungible;
        if (typeof fun === "bigint") return fun;
        if (fun && typeof fun === "object") {
          const f = fun as Record<string, unknown>;
          const fungible = f.Fungible ?? f.fungible ?? f.amount;
          if (typeof fungible === "bigint") return fungible;
          if (typeof fungible === "string") return BigInt(fungible);
        }
      }
    }
    return null;
  }

  // ─── Evaluation & Emission ────────────────────────────────────────────

  private evaluateAndEmit(transfer: XcmTransferEvent): void {
    // Update rolling average
    if (transfer.amount > 0n) {
      this.scoringCtx.totalXcmTransfers++;
      if (this.scoringCtx.avgXcmAmount === 0n) {
        this.scoringCtx.avgXcmAmount = transfer.amount;
      } else {
        // Exponential moving average (window of ~100 transfers)
        const n = BigInt(Math.min(this.scoringCtx.totalXcmTransfers, 100));
        this.scoringCtx.avgXcmAmount =
          (this.scoringCtx.avgXcmAmount * (n - 1n) + transfer.amount) / n;
      }
    }

    // Update burst tracking
    const originLc = transfer.origin.toLowerCase();
    const existing = this.scoringCtx.recentByOrigin.get(originLc);
    if (existing && transfer.blockNumber - existing.lastBlock <= 5) {
      existing.count++;
      existing.lastBlock = transfer.blockNumber;
    } else {
      this.scoringCtx.recentByOrigin.set(originLc, {
        count: 1,
        lastBlock: transfer.blockNumber,
      });
    }

    // Score
    const threat = scoreXcmTransfer(transfer, this.scoringCtx);

    if (threat.threatScore > 0) {
      logger.info(
        `XCM threat: score=${threat.threatScore} classification=${threat.classification} ` +
        `origin=${transfer.origin.slice(0, 16)}... ` +
        `dest=para${transfer.destinationParaId ?? "?"} ` +
        `amount=${transfer.amount} planck ` +
        `reasons=[${threat.reasons.join("; ")}]`
      );
    } else {
      logger.debug(
        `XCM transfer: origin=${transfer.origin.slice(0, 16)}... ` +
        `dest=para${transfer.destinationParaId ?? "?"} ` +
        `amount=${transfer.amount} planck → NORMAL`
      );
    }

    // Emit to alerter if above threshold
    if (threat.threatScore >= 30 && this.onThreat) {
      Promise.resolve(this.onThreat(threat)).catch((err) => {
        logger.error(`XCM threat callback error: ${(err as Error).message}`);
      });
    }
  }

  // ─── Status ────────────────────────────────────────────────────────────

  getStatus(): {
    isRunning: boolean;
    totalTransfers: number;
    avgAmount: string;
    trackedOrigins: number;
    evmCorrelations: number;
  } {
    return {
      isRunning: this.isRunning,
      totalTransfers: this.scoringCtx.totalXcmTransfers,
      avgAmount: this.scoringCtx.avgXcmAmount.toString(),
      trackedOrigins: this.scoringCtx.recentByOrigin.size,
      evmCorrelations: this.scoringCtx.recentEvmThreats.size,
    };
  }
}

// ─── Exported scoring function (for testing) ────────────────────────────────

export { scoreXcmTransfer, XCM_RULES };
export type { XcmScoringContext };
