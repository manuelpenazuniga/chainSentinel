import { describe, it, expect } from "vitest";
import { ethers } from "ethers";
import { parseRpcUrls, redactRpcUrl, createProvider } from "../src/rpc.js";

// ─── parseRpcUrls ──────────────────────────────────────────────────────────

describe("parseRpcUrls", () => {
  it("returns [] when no env vars set", () => {
    expect(parseRpcUrls({})).toEqual([]);
  });

  it("returns just RPC_URL when only it is set (legacy single endpoint)", () => {
    expect(parseRpcUrls({ RPC_URL: "https://primary" })).toEqual(["https://primary"]);
  });

  it("splits RPC_URLS comma-separated into ordered list", () => {
    expect(parseRpcUrls({ RPC_URLS: "https://a,https://b,https://c" })).toEqual([
      "https://a",
      "https://b",
      "https://c",
    ]);
  });

  it("trims whitespace and ignores empty entries in RPC_URLS", () => {
    expect(parseRpcUrls({ RPC_URLS: "  https://a , , https://b ,," })).toEqual([
      "https://a",
      "https://b",
    ]);
  });

  it("appends RPC_URL after RPC_URLS when both are set (legacy + new)", () => {
    expect(
      parseRpcUrls({ RPC_URLS: "https://primary,https://fallback", RPC_URL: "https://legacy" })
    ).toEqual(["https://primary", "https://fallback", "https://legacy"]);
  });

  it("deduplicates URLs across RPC_URLS and RPC_URL (preserves first occurrence order)", () => {
    expect(
      parseRpcUrls({ RPC_URLS: "https://a,https://b,https://a", RPC_URL: "https://b" })
    ).toEqual(["https://a", "https://b"]);
  });

  it("RPC_URL not duplicated when already present in RPC_URLS", () => {
    expect(
      parseRpcUrls({ RPC_URLS: "https://primary,https://fallback", RPC_URL: "https://primary" })
    ).toEqual(["https://primary", "https://fallback"]);
  });
});

// ─── redactRpcUrl ──────────────────────────────────────────────────────────

describe("redactRpcUrl", () => {
  it("strips query string (often holds API keys)", () => {
    expect(redactRpcUrl("https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY?foo=bar")).toBe(
      "https://eth-mainnet.g.alchemy.com/v2/SECRET_KEY"
    );
  });

  it("preserves protocol, host, and path", () => {
    expect(redactRpcUrl("https://services.polkadothub-rpc.com/testnet")).toBe(
      "https://services.polkadothub-rpc.com/testnet"
    );
  });

  it("strips trailing slash for consistency", () => {
    expect(redactRpcUrl("https://rpc.example.com/")).toBe("https://rpc.example.com");
  });

  it("returns the input as-is when malformed (does not crash logging)", () => {
    expect(redactRpcUrl("not-a-url")).toBe("not-a-url");
  });
});

// ─── createProvider ────────────────────────────────────────────────────────

describe("createProvider", () => {
  it("throws when given zero URLs", () => {
    expect(() => createProvider([], 1)).toThrow(/at least one RPC URL/i);
  });

  it("returns a plain JsonRpcProvider for a single URL (no FallbackProvider overhead)", () => {
    const provider = createProvider(["http://localhost:8545"], 1337);
    expect(provider).toBeInstanceOf(ethers.JsonRpcProvider);
    expect(provider).not.toBeInstanceOf(ethers.FallbackProvider);
  });

  it("returns a FallbackProvider when given two or more URLs", () => {
    const provider = createProvider(
      ["http://primary:8545", "http://fallback:8545"],
      1337
    );
    expect(provider).toBeInstanceOf(ethers.FallbackProvider);
  });

  it("FallbackProvider preserves order via priority (index 0 = priority 1)", () => {
    const provider = createProvider(
      ["http://first:8545", "http://second:8545", "http://third:8545"],
      1337
    ) as ethers.FallbackProvider;

    // ethers exposes .providerConfigs after construction
    const configs = provider.providerConfigs;
    expect(configs).toHaveLength(3);
    expect(configs[0].priority).toBe(1);
    expect(configs[1].priority).toBe(2);
    expect(configs[2].priority).toBe(3);
  });

  it("custom stallTimeout / quorum overrides flow through to FallbackProvider", () => {
    const provider = createProvider(
      ["http://a:8545", "http://b:8545"],
      1337,
      { stallTimeoutMs: 500, quorum: 2 }
    ) as ethers.FallbackProvider;

    expect(provider.quorum).toBe(2);
    expect(provider.providerConfigs[0].stallTimeout).toBe(500);
    expect(provider.providerConfigs[1].stallTimeout).toBe(500);
  });

  it("uses static network so no eth_chainId call is made at construction time", () => {
    // If ethers tried to detect the network from the RPC, this would throw
    // because the URL doesn't resolve. The static network spec prevents that.
    expect(() =>
      createProvider(["http://does-not-exist.invalid:1234"], 420420417)
    ).not.toThrow();
  });
});
