import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextPersistence } from "../src/persistence.js";
import { MonitorContext, ContextSnapshot } from "../src/context.js";
import { ethers } from "ethers";

/** Build a MonitorContext with deterministic seeded state for round-trip tests. */
function buildSeededContext(): MonitorContext {
  // Provider is unused in our tests (we only call serialize/restore + getters).
  const fakeProvider = new ethers.JsonRpcProvider("http://localhost:0", { chainId: 1, name: "test" });
  const ctx = new MonitorContext(fakeProvider, "0x0000000000000000000000000000000000000000", 50, "");

  // Seed rolling state via public methods
  ctx.setBalanceAtBlock("0xabc", 100, 5_000_000_000_000_000_000n); // 5 ETH
  ctx.setBalanceAtBlock("0xabc", 101, 4_500_000_000_000_000_000n);
  ctx.setBalanceAtBlock("0xdef", 100, 1_000_000_000_000_000_000n);
  ctx.setContractAge("0xabc", 1_700_000_000);
  ctx.setContractAge("0xdef", 1_700_500_000);
  ctx.setContractLabel("0xabc", "Uniswap V2 Router");
  ctx.addToBlacklist("0xbadbad");
  ctx.addToBlacklist("0xdeadbeef");

  // Inject ERC20 + native average state via updateWithBlock
  // (this also fills interactionHistory + recentTxBuffer)
  return ctx;
}

describe("MonitorContext snapshot round-trip", () => {
  it("toSnapshot returns a JSON-serializable object", () => {
    const ctx = buildSeededContext();
    const snap = ctx.toSnapshot();

    expect(snap.version).toBe(MonitorContext.SNAPSHOT_VERSION);
    expect(snap.contractAges["0xabc"]).toBe(1_700_000_000);
    expect(snap.contractLabels["0xabc"]).toBe("Uniswap V2 Router");
    expect(snap.blacklist).toContain("0xbadbad");
    expect(snap.blacklist).toContain("0xdeadbeef");

    // BigInts should be encoded as decimal strings
    expect(typeof snap.balanceCache["0xabc"]["100"]).toBe("string");
    expect(snap.balanceCache["0xabc"]["100"]).toBe("5000000000000000000");

    // Should pass JSON.stringify without throwing (no native BigInt)
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  it("restoreFromSnapshot produces a context with identical observable state", () => {
    const original = buildSeededContext();
    const snap = original.toSnapshot();

    const fakeProvider = new ethers.JsonRpcProvider("http://localhost:0", { chainId: 1, name: "test" });
    const restored = new MonitorContext(fakeProvider, "0x0000000000000000000000000000000000000000", 50, "");
    restored.restoreFromSnapshot(snap);

    expect(restored.getContractLabel("0xabc")).toBe("Uniswap V2 Router");
    expect(restored.getBalanceBefore("0xabc", 101)).toBe(5_000_000_000_000_000_000n);
    expect(restored.getBalanceAfter("0xabc", 101)).toBe(4_500_000_000_000_000_000n);
    expect(restored.isBlacklisted("0xbadbad")).toBe(true);
    expect(restored.isBlacklisted("0xnotblacklisted")).toBe(false);
  });

  it("rejects snapshots with mismatching schema version", () => {
    const ctx = buildSeededContext();
    const snap: ContextSnapshot = { ...ctx.toSnapshot(), version: 999 };

    expect(() => ctx.restoreFromSnapshot(snap)).toThrow(/schema mismatch/i);
  });
});

describe("ContextPersistence", () => {
  let persistence: ContextPersistence;

  beforeEach(() => {
    persistence = new ContextPersistence({
      dbPath: ":memory:",
      flushIntervalBlocks: 100,
    });
  });

  afterEach(() => {
    persistence.close();
  });

  it("returns null when there is no snapshot to restore", () => {
    expect(persistence.restoreLatest()).toBeNull();
  });

  it("flush stores a snapshot retrievable by restoreLatest", () => {
    const ctx = buildSeededContext();
    persistence.flush(ctx, 12_345);

    const restored = persistence.restoreLatest();
    expect(restored).not.toBeNull();
    expect(restored!.blockNumber).toBe(12_345);
    expect(restored!.snapshot.version).toBe(MonitorContext.SNAPSHOT_VERSION);
    expect(restored!.snapshot.blacklist).toContain("0xbadbad");
  });

  it("shouldFlush respects the configured interval", () => {
    // lastFlushBlock starts at 0; interval is 100 → first flush eligibility at block 100
    expect(persistence.shouldFlush(50)).toBe(false);
    expect(persistence.shouldFlush(99)).toBe(false);
    expect(persistence.shouldFlush(100)).toBe(true); // boundary

    const ctx = buildSeededContext();
    persistence.flush(ctx, 100);

    expect(persistence.shouldFlush(150)).toBe(false); // 150 - 100 = 50 < 100
    expect(persistence.shouldFlush(199)).toBe(false);
    expect(persistence.shouldFlush(200)).toBe(true); // boundary
    expect(persistence.shouldFlush(500)).toBe(true);
  });

  it("prunes old snapshots, keeping at most maxSnapshots generations", () => {
    const small = new ContextPersistence({
      dbPath: ":memory:",
      flushIntervalBlocks: 1,
      maxSnapshots: 3,
    });
    const ctx = buildSeededContext();
    for (let i = 1; i <= 10; i++) {
      small.flush(ctx, i * 100);
    }

    expect(small.countSnapshots()).toBe(3);

    // The most recent one should be retrievable
    const latest = small.restoreLatest();
    expect(latest!.blockNumber).toBe(1000);

    small.close();
  });

  it("close() is idempotent", () => {
    persistence.close();
    expect(() => persistence.close()).not.toThrow();
  });

  it("end-to-end: seed, flush, simulate restart, restore — observable state survives", () => {
    const original = buildSeededContext();
    persistence.flush(original, 5_000);

    // Simulate process restart: new persistence (same in-memory DB stays alive
    // because the shared SQLite handle would be lost; for true round-trip we
    // re-use the same persistence instance, which is the realistic scenario for
    // this DB-only test).
    const restored = persistence.restoreLatest();
    expect(restored).not.toBeNull();

    const fakeProvider = new ethers.JsonRpcProvider("http://localhost:0", { chainId: 1, name: "test" });
    const newCtx = new MonitorContext(fakeProvider, "0x0000000000000000000000000000000000000000", 50, "");
    newCtx.restoreFromSnapshot(restored!.snapshot);

    expect(newCtx.isBlacklisted("0xbadbad")).toBe(true);
    expect(newCtx.getContractLabel("0xabc")).toBe("Uniswap V2 Router");
  });
});
