"use client";

import { useReadContract, useBlockNumber } from "wagmi";
import {
  HEARTBEAT_ADDRESS,
  HEARTBEAT_ABI,
  HAS_HEARTBEAT,
} from "@/lib/contracts";

// ============================================================================
// AgentLivenessBadge (§4.5)
// ============================================================================
//
// Reads the on-chain SentinelHeartbeat status and renders a compact badge:
//
//   🟢 Agent alive (last ping 23s ago)   ← within stalenessThreshold
//   🔴 Agent offline (no ping for 4m)    ← beyond stalenessThreshold
//   ⚪ Heartbeat not configured           ← env var missing (silent in nav)
//
// The badge is THE trust signal for users: it proves on-chain that the AI
// guardian is alive and monitoring. Without this, a silently crashed agent
// leaves the vault unprotected with the user none the wiser.
//
// Refresh policy:
//   - useReadContract polls every block (subscribes to useBlockNumber). On
//     Polkadot Hub at ~6s blocks that's ~10 reads/min — well under the RPC
//     rate limit and snappy enough for UX.
// ============================================================================

interface HeartbeatStatus {
  agent: `0x${string}`;
  lastPingBlock: bigint;
  lastPingTimestamp: bigint;
  pingCount: bigint;
  alive: boolean;
  blocksSinceLastPing: bigint;
}

function formatBlocksAgo(blocks: bigint): string {
  // Polkadot Hub block time ≈ 6s
  const seconds = Number(blocks) * 6;
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

export function AgentLivenessBadge({ compact = false }: { compact?: boolean }) {
  const { data: blockNumber } = useBlockNumber({ watch: true });

  const { data, isLoading, error } = useReadContract({
    address: HEARTBEAT_ADDRESS,
    abi: HEARTBEAT_ABI,
    functionName: "getStatus",
    query: {
      enabled: HAS_HEARTBEAT,
      // Refetch when a new block lands so the "Xs ago" counter stays current.
      refetchInterval: 12_000,
    },
    blockNumber,
  });

  if (!HAS_HEARTBEAT) return null;

  if (isLoading || !data) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 ${
          compact ? "text-xs" : "text-sm"
        } text-gray-500`}
        title="Loading agent heartbeat status…"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-gray-600 animate-pulse" />
        Heartbeat…
      </span>
    );
  }

  if (error) {
    return (
      <span
        className={`inline-flex items-center gap-1.5 ${
          compact ? "text-xs" : "text-sm"
        } text-amber-400`}
        title={`Could not read heartbeat: ${error.message}`}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        Heartbeat unknown
      </span>
    );
  }

  // getStatus tuple positional: [agent, lastPingBlock, lastPingTimestamp, pingCount, alive, blocksSinceLastPing]
  const tuple = data as readonly [
    `0x${string}`,
    bigint,
    bigint,
    bigint,
    boolean,
    bigint
  ];
  const status: HeartbeatStatus = {
    agent: tuple[0],
    lastPingBlock: tuple[1],
    lastPingTimestamp: tuple[2],
    pingCount: tuple[3],
    alive: tuple[4],
    blocksSinceLastPing: tuple[5],
  };

  const ago = formatBlocksAgo(status.blocksSinceLastPing);
  const alive = status.alive;

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full ${
        compact ? "text-xs" : "text-sm"
      } font-medium ${
        alive
          ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
          : "bg-red-500/10 text-red-400 border border-red-500/20"
      }`}
      title={
        alive
          ? `Agent ${status.agent.slice(0, 6)}…${status.agent.slice(-4)} pinged ${ago} (${status.pingCount.toString()} total pings)`
          : `Agent has not pinged in ${ago} — vault may be unprotected`
      }
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          alive ? "bg-emerald-400 animate-pulse" : "bg-red-400"
        }`}
      />
      {alive ? `Agent alive (${ago})` : `Agent offline (${ago})`}
    </span>
  );
}
