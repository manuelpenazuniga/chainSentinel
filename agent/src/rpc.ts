// ============================================================================
// ChainSentinel — RPC Provider Factory (§3.4)
// ============================================================================
//
// Replaces the three independent `new JsonRpcProvider(rpcUrl, ...)` calls that
// previously lived in `index.ts`, `monitor.ts`, and `executor.ts` (one per
// component, all hitting the same single endpoint) with:
//
//   - A single shared provider instance, created once by `index.ts` and
//     passed by reference into Monitor / Executor / Context. This collapses
//     three independent HTTP keep-alive pools into one and removes redundant
//     network-id detections at startup.
//
//   - Optional N-endpoint failover via ethers' `FallbackProvider` with
//     `quorum: 1` semantics — first successful response wins, dead endpoints
//     are skipped automatically. With a single endpoint configured (the
//     common case today), we return a plain JsonRpcProvider — no overhead.
//
// Why this matters more for multi-user than for single-user:
// In single-tenant the operator (you) eventually notices RPC outages because
// you're around. In multi-tenant a single endpoint outage = N vaults blind
// at the same time = N incidents at the same time. Failover infrastructure
// is the cheapest insurance against the most embarrassing failure mode.
//
// Honest note about Polkadot Hub Testnet (Paseo) RPC ecosystem:
// The eth-rpc adapter is a Parity-built JSON-RPC ⇄ Substrate translator. As
// of 2026-05-10 there is no widely-known second public eth-rpc adapter for
// the testnet. Practical free fallback strategies until that changes:
//   1. Run your own eth-rpc adapter locally (Docker image from Parity).
//      Cheap to host on the same VPS as the agent. Most reliable.
//   2. Stack with the public Parity endpoint as primary.
//
// Configuration:
//   RPC_URL=https://services.polkadothub-rpc.com/testnet              ← legacy single endpoint, still works
//   RPC_URLS=https://primary.example,http://localhost:8545,https://...  ← comma-separated multi-endpoint
//
// Both are honored. If both are set, RPC_URLS takes priority and RPC_URL is
// appended at the end (deduplicated). With a single resulting URL the
// FallbackProvider overhead is skipped; with N >= 2 the failover kicks in.
// ============================================================================

import { ethers } from "ethers";
import { createLogger } from "./logger.js";

const logger = createLogger("rpc");

// ─── URL parsing ────────────────────────────────────────────────────────────

/**
 * Parse RPC URLs from environment variables. Returns a deduplicated, ordered
 * list. The order defines failover priority — index 0 is tried first.
 *
 * Both `RPC_URLS` (comma-separated) and `RPC_URL` (legacy single) are
 * accepted. If both are set, RPC_URLS comes first; RPC_URL is appended only
 * if not already present.
 *
 * Useful for tests too — pass any object with the relevant string keys.
 */
export function parseRpcUrls(env: { RPC_URL?: string; RPC_URLS?: string }): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];

  if (env.RPC_URLS) {
    for (const raw of env.RPC_URLS.split(",")) {
      const url = raw.trim();
      if (url && !seen.has(url)) {
        seen.add(url);
        urls.push(url);
      }
    }
  }
  if (env.RPC_URL) {
    const single = env.RPC_URL.trim();
    if (single && !seen.has(single)) {
      seen.add(single);
      urls.push(single);
    }
  }

  return urls;
}

/** Strip query string (often holds an API key) for safe logging. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    // Drop search params and credentials (user:pass@); keep host + path.
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    // Malformed URL — return as-is rather than crashing on a logging call.
    return url;
  }
}

// ─── Provider factory ──────────────────────────────────────────────────────

export interface CreateProviderOptions {
  /**
   * If a provider doesn't respond within this many milliseconds,
   * FallbackProvider stops waiting on it and tries the next one.
   * Default: 2000.
   */
  stallTimeoutMs?: number;
  /**
   * How many providers must agree on a result before FallbackProvider
   * accepts it. `1` = first response wins (race). `2+` = wait for N matches
   * (anti-corruption against a malicious RPC). Default: 1.
   */
  quorum?: number;
}

/**
 * Build the shared RPC provider for the agent.
 *
 * - 0 URLs → throws (config error)
 * - 1 URL  → plain `JsonRpcProvider` (no FallbackProvider overhead)
 * - N URLs → `FallbackProvider` with `quorum: 1`, priorities matching input order
 */
export function createProvider(
  urls: string[],
  chainId: number,
  options: CreateProviderOptions = {}
): ethers.AbstractProvider {
  if (urls.length === 0) {
    throw new Error(
      "createProvider: at least one RPC URL is required. " +
        "Set RPC_URL or RPC_URLS in your environment."
    );
  }

  // Important: pass the network as a static object (not "any") so ethers
  // doesn't perform a network-detection RPC at construction time. Saves one
  // round-trip per startup and works even when the primary endpoint is down
  // at boot.
  const network = { chainId, name: "polkadot-hub-testnet" };

  if (urls.length === 1) {
    logger.info(`RPC: single endpoint ${redactRpcUrl(urls[0])}`);
    return new ethers.JsonRpcProvider(urls[0], network);
  }

  const stallTimeout = options.stallTimeoutMs ?? 2000;
  const quorum = options.quorum ?? 1;

  const configs = urls.map((url, i) => ({
    provider: new ethers.JsonRpcProvider(url, network),
    weight: 1,
    // Lower priority number = tried first. Index 0 of urls = priority 1.
    priority: i + 1,
    stallTimeout,
  }));

  logger.info(
    `RPC: failover across ${urls.length} endpoints ` +
      `(quorum=${quorum}, stallTimeout=${stallTimeout}ms): ` +
      urls.map(redactRpcUrl).join(" → ")
  );

  return new ethers.FallbackProvider(configs, network, { quorum });
}
