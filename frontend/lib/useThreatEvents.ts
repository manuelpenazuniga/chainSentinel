"use client";

import { usePublicClient } from "wagmi";
import { useState, useEffect, useCallback } from "react";
import type { Log } from "viem";
import { useVault } from "./VaultContext";

// ============================================================================
// useThreatEvents (§4.3)
// ============================================================================
//
// Subscribes to ThreatReported events from the registry contract for the
// currently-selected VM (REVM or PVM). Provides:
//
//   1. Initial backfill via getLogs (last 2000 blocks).
//   2. Live subscription via watchContractEvent — viem auto-falls-back to
//      polling when the RPC doesn't support eth_subscribe (which is exactly
//      the case for Polkadot Hub's eth-rpc adapter). New events are merged
//      into the feed without requiring a page refresh.
//   3. Reactivity to VM toggle (§4.2): when the user switches REVM↔PVM,
//      the subscription tears down and rebinds to the new registry address.
// ============================================================================

export interface ThreatEvent {
  targetContract: string;
  threatScore: number;
  attackType: string;
  blockNumber: number;
  reporter: string;
  timestamp: number; // Unix timestamp from block
}

const THREAT_REPORTED_EVENT = {
  type: "event",
  name: "ThreatReported",
  inputs: [
    { name: "reporter", type: "address", indexed: true },
    { name: "targetContract", type: "address", indexed: true },
    { name: "threatScore", type: "uint256", indexed: false },
    { name: "attackType", type: "string", indexed: false },
    { name: "blockNumber", type: "uint256", indexed: false },
  ],
} as const;

interface ThreatLogArgs {
  reporter?: `0x${string}`;
  targetContract?: `0x${string}`;
  threatScore?: bigint;
  attackType?: string;
  blockNumber?: bigint;
}

type ThreatLog = Log<bigint, number, false, typeof THREAT_REPORTED_EVENT> & {
  args: ThreatLogArgs;
};

export interface UseThreatEventsResult {
  events: ThreatEvent[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useThreatEvents(limit?: number): UseThreatEventsResult {
  const publicClient = usePublicClient();
  const { registryAddress, selectedVm } = useVault();

  const [events, setEvents] = useState<ThreatEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  // Bumping `reloadKey` forces the effect to re-run (used by `refetch`).
  const [reloadKey, setReloadKey] = useState(0);

  const refetch = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!publicClient || !registryAddress) return;

    let cancelled = false;
    let unwatch: (() => void) | null = null;

    async function bootstrapAndWatch() {
      setIsLoading(true);
      setError(null);

      try {
        // ── 1. Initial backfill via getLogs ────────────────────────────────
        const currentBlock = await publicClient!.getBlockNumber();
        const fromBlock =
          currentBlock > BigInt(2000) ? currentBlock - BigInt(2000) : BigInt(0);

        const logs = (await publicClient!.getLogs({
          address: registryAddress,
          event: THREAT_REPORTED_EVENT,
          fromBlock,
          toBlock: currentBlock,
        })) as ThreatLog[];

        const blockTimestamps = await fetchBlockTimestamps(publicClient!, logs);
        const initial = logs.map((log) => toThreatEvent(log, blockTimestamps));
        initial.sort((a, b) => b.blockNumber - a.blockNumber);

        if (cancelled) return;
        setEvents(limit ? initial.slice(0, limit) : initial);
        setIsLoading(false);

        // ── 2. Live subscription ────────────────────────────────────────────
        unwatch = publicClient!.watchContractEvent({
          address: registryAddress,
          abi: [THREAT_REPORTED_EVENT],
          eventName: "ThreatReported",
          onLogs: async (newLogs) => {
            if (cancelled) return;
            const ts = await fetchBlockTimestamps(publicClient!, newLogs as ThreatLog[]);
            const incoming = (newLogs as ThreatLog[]).map((l) => toThreatEvent(l, ts));
            setEvents((prev) => mergeUnique(incoming, prev, limit));
          },
          onError: (err) => {
            if (cancelled) return;
            console.error("watchContractEvent error:", err);
            // Don't set error state — backfill data is still good. The watcher
            // will retry automatically.
          },
        });
      } catch (err) {
        if (cancelled) return;
        console.error("Failed to fetch ThreatReported events:", err);
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsLoading(false);
      }
    }

    bootstrapAndWatch();

    return () => {
      cancelled = true;
      if (unwatch) unwatch();
    };
    // selectedVm is included so the subscription rebinds when the VM toggles —
    // even though registryAddress already changes, switching VMs without
    // touching the address (e.g. same registry, different label) still re-runs.
  }, [publicClient, registryAddress, selectedVm, limit, reloadKey]);

  return { events, isLoading, error, refetch };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function fetchBlockTimestamps(
  client: NonNullable<ReturnType<typeof usePublicClient>>,
  logs: ThreatLog[]
): Promise<Map<bigint, number>> {
  const uniqueBlocks = [...new Set(logs.map((log) => log.blockNumber))];
  const timestamps = new Map<bigint, number>();

  for (let i = 0; i < uniqueBlocks.length; i += 5) {
    const batch = uniqueBlocks.slice(i, i + 5);
    const results = await Promise.all(
      batch.map(async (bn) => {
        try {
          const block = await client.getBlock({ blockNumber: bn });
          return { blockNumber: bn, timestamp: Number(block.timestamp) };
        } catch {
          return { blockNumber: bn, timestamp: Math.floor(Date.now() / 1000) };
        }
      })
    );
    for (const r of results) timestamps.set(r.blockNumber, r.timestamp);
  }
  return timestamps;
}

function toThreatEvent(log: ThreatLog, blockTimestamps: Map<bigint, number>): ThreatEvent {
  const args = log.args;
  return {
    targetContract: args.targetContract ?? "0x",
    threatScore: Number(args.threatScore ?? BigInt(0)),
    attackType: args.attackType ?? "UNKNOWN",
    blockNumber: Number(args.blockNumber ?? log.blockNumber),
    reporter: args.reporter ?? "0x",
    timestamp:
      blockTimestamps.get(log.blockNumber) ?? Math.floor(Date.now() / 1000),
  };
}

/**
 * Merge incoming live events with the existing list, dedupe by
 * (blockNumber + reporter + targetContract + score), keep newest first,
 * and cap at `limit` if specified.
 */
function mergeUnique(
  incoming: ThreatEvent[],
  existing: ThreatEvent[],
  limit?: number
): ThreatEvent[] {
  const key = (e: ThreatEvent) =>
    `${e.blockNumber}:${e.reporter}:${e.targetContract}:${e.threatScore}`;
  const seen = new Set(existing.map(key));
  const merged = [...existing];
  for (const ev of incoming) {
    if (!seen.has(key(ev))) {
      merged.push(ev);
      seen.add(key(ev));
    }
  }
  merged.sort((a, b) => b.blockNumber - a.blockNumber);
  return limit ? merged.slice(0, limit) : merged;
}
