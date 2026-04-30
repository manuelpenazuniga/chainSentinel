import { describe, it, expect } from "vitest";
import {
  scoreXcmTransfer,
  XCM_RULES,
  type XcmTransferEvent,
  type XcmScoringContext,
} from "../src/xcm-monitor.js";

// ─── Test Fixtures ──────────────────────────────────────────────────────────

const ONE_PAS_PLANCK = 10_000_000_000n; // 10^10 planck = 1 PAS

function createCtx(overrides: Partial<XcmScoringContext> = {}): XcmScoringContext {
  return {
    avgXcmAmount: ONE_PAS_PLANCK * 10n, // 10 PAS average
    totalXcmTransfers: 50,
    recentByOrigin: new Map(),
    blacklist: new Set(),
    recentEvmThreats: new Set(),
    ...overrides,
  };
}

function createTransfer(overrides: Partial<XcmTransferEvent> = {}): XcmTransferEvent {
  return {
    blockNumber: 1000,
    blockHash: "0xabc",
    origin: "0x1234567890abcdef1234567890abcdef12345678",
    destinationParaId: 2000,
    amount: ONE_PAS_PLANCK, // 1 PAS — well below 10x avg
    eventType: "PolkadotXcm.Sent",
    rawData: {},
    ...overrides,
  };
}

// ─── LARGE_XCM_TRANSFER ────────────────────────────────────────────────────

describe("LARGE_XCM_TRANSFER", () => {
  it("does not trigger when amount < 10x average", () => {
    const result = scoreXcmTransfer(createTransfer({ amount: ONE_PAS_PLANCK * 5n }), createCtx());
    expect(result.threatScore).toBe(0);
    expect(result.reasons).toHaveLength(0);
  });

  it("triggers when amount > 10x average", () => {
    const result = scoreXcmTransfer(
      createTransfer({ amount: ONE_PAS_PLANCK * 150n }), // 150 PAS >> 10x avg of 10 PAS
      createCtx()
    );
    expect(result.threatScore).toBe(XCM_RULES.LARGE_XCM_TRANSFER.score);
    expect(result.reasons).toHaveLength(1);
    expect(result.reasons[0]).toContain("10x avg");
  });

  it("does not trigger when avgXcmAmount is 0", () => {
    const result = scoreXcmTransfer(
      createTransfer({ amount: ONE_PAS_PLANCK * 1000n }),
      createCtx({ avgXcmAmount: 0n })
    );
    expect(result.threatScore).toBe(0);
  });

  it("triggers at exactly 10x + 1", () => {
    const avg = ONE_PAS_PLANCK * 10n;
    const result = scoreXcmTransfer(
      createTransfer({ amount: avg * 10n + 1n }),
      createCtx({ avgXcmAmount: avg })
    );
    expect(result.threatScore).toBe(XCM_RULES.LARGE_XCM_TRANSFER.score);
  });
});

// ─── BLACKLISTED_XCM_SENDER ────────────────────────────────────────────────

describe("BLACKLISTED_XCM_SENDER", () => {
  it("does not trigger for unlisted sender", () => {
    const result = scoreXcmTransfer(createTransfer(), createCtx());
    expect(result.threatScore).toBe(0);
  });

  it("triggers for blacklisted sender", () => {
    const origin = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
    const result = scoreXcmTransfer(
      createTransfer({ origin }),
      createCtx({ blacklist: new Set([origin.toLowerCase()]) })
    );
    expect(result.threatScore).toBe(XCM_RULES.BLACKLISTED_XCM_SENDER.score);
    expect(result.reasons[0]).toContain("blacklisted");
  });

  it("is case-insensitive", () => {
    const origin = "0xDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEfDeAdBeEf";
    const result = scoreXcmTransfer(
      createTransfer({ origin }),
      createCtx({ blacklist: new Set([origin.toLowerCase()]) })
    );
    expect(result.threatScore).toBe(XCM_RULES.BLACKLISTED_XCM_SENDER.score);
  });
});

// ─── POST_EXPLOIT_ESCAPE ────────────────────────────────────────────────────

describe("POST_EXPLOIT_ESCAPE", () => {
  it("does not trigger without EVM correlation", () => {
    const result = scoreXcmTransfer(createTransfer(), createCtx());
    expect(result.threatScore).toBe(0);
  });

  it("triggers when sender was flagged by EVM monitor", () => {
    const origin = "0xattackeraddress0000000000000000000000aa";
    const result = scoreXcmTransfer(
      createTransfer({ origin }),
      createCtx({ recentEvmThreats: new Set([origin.toLowerCase()]) })
    );
    expect(result.threatScore).toBe(XCM_RULES.POST_EXPLOIT_ESCAPE.score);
    expect(result.reasons[0]).toContain("cross-chain escape");
  });

  it("is case-insensitive", () => {
    const origin = "0xAtTaCkEr000000000000000000000000000000AA";
    const result = scoreXcmTransfer(
      createTransfer({ origin }),
      createCtx({ recentEvmThreats: new Set([origin.toLowerCase()]) })
    );
    expect(result.threatScore).toBe(XCM_RULES.POST_EXPLOIT_ESCAPE.score);
  });
});

// ─── XCM_BURST ──────────────────────────────────────────────────────────────

describe("XCM_BURST", () => {
  it("does not trigger with no prior transfers", () => {
    const result = scoreXcmTransfer(createTransfer(), createCtx());
    expect(result.threatScore).toBe(0);
  });

  it("does not trigger with only 2 prior transfers", () => {
    const origin = "0x1234567890abcdef1234567890abcdef12345678";
    const ctx = createCtx({
      recentByOrigin: new Map([
        [origin.toLowerCase(), { count: 2, lastBlock: 998 }],
      ]),
    });
    const result = scoreXcmTransfer(createTransfer({ origin, blockNumber: 1000 }), ctx);
    expect(result.threatScore).toBe(0);
  });

  it("triggers with 3+ prior transfers within 5 blocks", () => {
    const origin = "0x1234567890abcdef1234567890abcdef12345678";
    const ctx = createCtx({
      recentByOrigin: new Map([
        [origin.toLowerCase(), { count: 3, lastBlock: 998 }],
      ]),
    });
    const result = scoreXcmTransfer(createTransfer({ origin, blockNumber: 1000 }), ctx);
    expect(result.threatScore).toBe(XCM_RULES.XCM_BURST.score);
    expect(result.reasons[0]).toContain("XCM transfers from same origin");
  });

  it("does not trigger if last transfer was more than 5 blocks ago", () => {
    const origin = "0x1234567890abcdef1234567890abcdef12345678";
    const ctx = createCtx({
      recentByOrigin: new Map([
        [origin.toLowerCase(), { count: 5, lastBlock: 990 }],
      ]),
    });
    const result = scoreXcmTransfer(createTransfer({ origin, blockNumber: 1000 }), ctx);
    expect(result.threatScore).toBe(0);
  });
});

// ─── Combined Rules ─────────────────────────────────────────────────────────

describe("Combined rules", () => {
  it("accumulates multiple rule scores", () => {
    const origin = "0xblacklisted0000000000000000000000000000";
    const ctx = createCtx({
      blacklist: new Set([origin.toLowerCase()]),
      recentEvmThreats: new Set([origin.toLowerCase()]),
    });
    const result = scoreXcmTransfer(
      createTransfer({ origin, amount: ONE_PAS_PLANCK * 200n }), // large + blacklisted + evm threat
      ctx
    );
    const expected = XCM_RULES.LARGE_XCM_TRANSFER.score +
                     XCM_RULES.BLACKLISTED_XCM_SENDER.score +
                     XCM_RULES.POST_EXPLOIT_ESCAPE.score;
    expect(result.threatScore).toBe(Math.min(100, expected));
    expect(result.reasons).toHaveLength(3);
  });

  it("caps total score at 100", () => {
    const origin = "0xblacklisted0000000000000000000000000000";
    const ctx = createCtx({
      blacklist: new Set([origin.toLowerCase()]),
      recentEvmThreats: new Set([origin.toLowerCase()]),
      recentByOrigin: new Map([
        [origin.toLowerCase(), { count: 5, lastBlock: 998 }],
      ]),
    });
    const result = scoreXcmTransfer(
      createTransfer({ origin, amount: ONE_PAS_PLANCK * 200n, blockNumber: 1000 }),
      ctx
    );
    // 35 + 50 + 45 + 30 = 160 → capped at 100
    expect(result.threatScore).toBe(100);
  });
});

// ─── Classification ─────────────────────────────────────────────────────────

describe("Classification", () => {
  it("classifies score 0 as NORMAL", () => {
    const result = scoreXcmTransfer(createTransfer(), createCtx());
    expect(result.classification).toBe("NORMAL");
  });

  it("classifies score 30-59 as SUSPICIOUS", () => {
    const origin = "0x1234567890abcdef1234567890abcdef12345678";
    const ctx = createCtx({
      recentByOrigin: new Map([
        [origin.toLowerCase(), { count: 3, lastBlock: 999 }],
      ]),
    });
    const result = scoreXcmTransfer(createTransfer({ origin, blockNumber: 1000 }), ctx);
    expect(result.threatScore).toBe(30);
    expect(result.classification).toBe("SUSPICIOUS");
  });

  it("classifies score >= 60 as HIGH_RISK", () => {
    const origin = "0xblacklisted0000000000000000000000000000";
    const ctx = createCtx({
      blacklist: new Set([origin.toLowerCase()]),
      recentEvmThreats: new Set([origin.toLowerCase()]),
    });
    const result = scoreXcmTransfer(createTransfer({ origin }), ctx);
    // 50 + 45 = 95
    expect(result.threatScore).toBe(95);
    expect(result.classification).toBe("HIGH_RISK");
  });
});
