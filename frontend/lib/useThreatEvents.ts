"use client";

import { usePublicClient } from "wagmi";
import { useState, useEffect } from "react";
import { REGISTRY_ADDRESS } from "@/lib/contracts";

export interface ThreatEvent {
  targetContract: string;
  threatScore: number;
  attackType: string;
  blockNumber: number;
  reporter: string;
  timestamp: number; // Unix timestamp from block
}

const THREAT_REPORTED_EVENT = {
  type: "event" as const,
  name: "ThreatReported" as const,
  inputs: [
    { name: "reporter", type: "address" as const, indexed: true },
    { name: "targetContract", type: "address" as const, indexed: true },
    { name: "threatScore", type: "uint256" as const, indexed: false },
    { name: "attackType", type: "string" as const, indexed: false },
    { name: "blockNumber", type: "uint256" as const, indexed: false },
  ],
};

export function useThreatEvents(limit?: number) {
  const publicClient = usePublicClient();
  const [events, setEvents] = useState<ThreatEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (!publicClient) return;

    async function fetchEvents() {
      try {
        const currentBlock = await publicClient!.getBlockNumber();
        const fromBlock = currentBlock > BigInt(2000) ? currentBlock - BigInt(2000) : BigInt(0);

        const logs = await publicClient!.getLogs({
          address: REGISTRY_ADDRESS,
          event: THREAT_REPORTED_EVENT,
          fromBlock,
          toBlock: currentBlock,
        });

        // Fetch block timestamps in parallel (deduplicate block numbers)
        const uniqueBlocks = [...new Set(logs.map((log) => log.blockNumber))];
        const blockTimestamps = new Map<bigint, number>();

        // Batch fetch timestamps (5 at a time)
        for (let i = 0; i < uniqueBlocks.length; i += 5) {
          const batch = uniqueBlocks.slice(i, i + 5);
          const results = await Promise.all(
            batch.map(async (bn) => {
              try {
                const block = await publicClient!.getBlock({ blockNumber: bn });
                return { blockNumber: bn, timestamp: Number(block.timestamp) };
              } catch {
                return { blockNumber: bn, timestamp: Math.floor(Date.now() / 1000) };
              }
            })
          );
          for (const r of results) {
            blockTimestamps.set(r.blockNumber, r.timestamp);
          }
        }

        const items: ThreatEvent[] = logs.map((log) => ({
          targetContract: log.args.targetContract ?? "0x",
          threatScore: Number(log.args.threatScore ?? 0),
          attackType: log.args.attackType ?? "UNKNOWN",
          blockNumber: Number(log.args.blockNumber ?? log.blockNumber),
          reporter: log.args.reporter ?? "0x",
          timestamp: blockTimestamps.get(log.blockNumber) ?? Math.floor(Date.now() / 1000),
        }));

        // Sort by block descending (most recent first)
        items.sort((a, b) => b.blockNumber - a.blockNumber);

        // Apply limit if specified
        setEvents(limit ? items.slice(0, limit) : items);
      } catch (err) {
        console.error("Failed to fetch ThreatReported events:", err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchEvents();
  }, [publicClient, limit]);

  return { events, isLoading };
}
