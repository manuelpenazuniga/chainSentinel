import { describe, it, expect } from "vitest";
import { h160ToAccountId32 } from "../src/agentkit.js";

describe("h160ToAccountId32 — pallet-revive fallback mapping", () => {
  it("encodes a checksummed H160 into the h160 ‖ 0xEE × 12 pattern", () => {
    const h160 = "0xED0f50f714b1297ebCb5BD64484966DCE32717d1";
    const expected = "0xed0f50f714b1297ebcb5bd64484966dce32717d1" + "ee".repeat(12);
    expect(h160ToAccountId32(h160)).toBe(expected);
  });

  it("is case-insensitive on input (lowercases internally)", () => {
    const upper = "0xED0F50F714B1297EBCB5BD64484966DCE32717D1";
    const lower = "0xed0f50f714b1297ebcb5bd64484966dce32717d1";
    expect(h160ToAccountId32(upper)).toBe(h160ToAccountId32(lower));
  });

  it("produces exactly 32 bytes (64 hex chars + 0x prefix = 66)", () => {
    const out = h160ToAccountId32("0x0000000000000000000000000000000000000001");
    expect(out).toHaveLength(66);
    expect(out.startsWith("0x")).toBe(true);
  });

  it("always ends with 0xEE × 12 (the on-chain EVM-derived marker)", () => {
    const out = h160ToAccountId32("0xabcdef1234567890abcdef1234567890abcdef12");
    expect(out.slice(-24)).toBe("ee".repeat(12));
  });

  it("preserves the h160 bytes in the first 20 bytes (42 hex chars including 0x)", () => {
    const h160 = "0x675fe3d56d6d9a579b9d096708760b23c7f6febe";
    const out = h160ToAccountId32(h160);
    expect(out.slice(0, 42)).toBe(h160);
  });

  it("rejects H160 without 0x prefix of wrong length", () => {
    expect(() => h160ToAccountId32("0xABCDEF")).toThrow(/Invalid H160/);
    expect(() => h160ToAccountId32("0x" + "a".repeat(41))).toThrow(/Invalid H160/);
    expect(() => h160ToAccountId32("")).toThrow(/Invalid H160/);
  });

  it("rejects non-hex characters", () => {
    // 40 chars but contains 'z' (not hex)
    expect(() => h160ToAccountId32("0x" + "z".repeat(40))).toThrow(/Invalid H160/);
  });

  it("produces the exact AccountId32 verified live against Paseo (2026-04-16)", () => {
    // This is the deployer address whose Substrate balance was confirmed
    // to match the EVM balance (minus existential deposit) in the live test.
    const h160 = "0x675fe3d56d6D9A579B9d096708760B23C7F6Febe";
    const expected = "0x675fe3d56d6d9a579b9d096708760b23c7f6febeeeeeeeeeeeeeeeeeeeeeeeee";
    expect(h160ToAccountId32(h160)).toBe(expected);
  });
});
