"use client";

import { usePublicClient, useReadContract } from "wagmi";
import { REGISTRY_ABI, REGISTRY_ADDRESS } from "@/lib/contracts";
import { useState, useEffect } from "react";

interface FeedItem {
  targetContract: string;
  threatScore: number;
  attackType: string;
  blockNumber: number;
  reporter: string;
}

function ScoreBadge({ score }: { score: number }) {
  let color = "bg-gray-700 text-gray-300";
  if (score >= 80) color = "bg-red-500/20 text-red-400";
  else if (score >= 50) color = "bg-amber-500/20 text-amber-400";
  else if (score >= 30) color = "bg-yellow-500/20 text-yellow-400";

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${color}`}>
      {score}
    </span>
  );
}

function AttackTypeBadge({ type }: { type: string }) {
  const colors: Record<string, string> = {
    FLASH_LOAN: "bg-purple-500/15 text-purple-400 border-purple-500/20",
    REENTRANCY: "bg-red-500/15 text-red-400 border-red-500/20",
    PRICE_MANIPULATION: "bg-orange-500/15 text-orange-400 border-orange-500/20",
    DRAIN: "bg-rose-500/15 text-rose-400 border-rose-500/20",
    ACCESS_CONTROL: "bg-yellow-500/15 text-yellow-400 border-yellow-500/20",
  };
  const style = colors[type] || "bg-gray-500/15 text-gray-400 border-gray-500/20";

  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium border ${style}`}>
      {type.replace(/_/g, " ")}
    </span>
  );
}

export function ThreatFeed() {
  const publicClient = usePublicClient();
  const [reportList, setReportList] = useState<FeedItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const { data: totalReports } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "totalReports",
  });

  const total = Number(totalReports || 0);

  useEffect(() => {
    if (!publicClient) return;

    async function fetchEvents() {
      try {
        const currentBlock = await publicClient!.getBlockNumber();
        const fromBlock = currentBlock > BigInt(2000) ? currentBlock - BigInt(2000) : BigInt(0);

        const logs = await publicClient!.getLogs({
          address: REGISTRY_ADDRESS,
          event: {
            type: "event",
            name: "ThreatReported",
            inputs: [
              { name: "reporter", type: "address", indexed: true },
              { name: "targetContract", type: "address", indexed: true },
              { name: "threatScore", type: "uint256", indexed: false },
              { name: "attackType", type: "string", indexed: false },
              { name: "blockNumber", type: "uint256", indexed: false },
            ],
          },
          fromBlock,
          toBlock: currentBlock,
        });

        const items: FeedItem[] = logs.map((log) => ({
          targetContract: log.args.targetContract ?? "0x",
          threatScore: Number(log.args.threatScore ?? 0),
          attackType: log.args.attackType ?? "UNKNOWN",
          blockNumber: Number(log.args.blockNumber ?? log.blockNumber),
          reporter: log.args.reporter ?? "0x",
        }));

        // Most recent first
        items.sort((a, b) => b.blockNumber - a.blockNumber);
        setReportList(items);
      } catch (err) {
        console.error("Failed to fetch ThreatReported events:", err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchEvents();
  }, [publicClient]);

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 animate-pulse">
        <div className="h-6 bg-gray-800 rounded w-1/3 mb-4" />
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-16 bg-gray-800 rounded mb-2" />
        ))}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Threat Feed</h2>
        <span className="text-xs text-gray-500">
          {total} total report{total !== 1 ? "s" : ""} on-chain
        </span>
      </div>

      {reportList.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-gray-500">
          <svg className="w-10 h-10 mb-2 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <p className="text-sm text-emerald-500">No threats detected</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-96 overflow-y-auto">
          {reportList.map((report, i) => (
            <div
              key={i}
              className="rounded-lg bg-gray-800/50 border border-gray-800 p-3 hover:border-gray-700 transition-colors"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <ScoreBadge score={report.threatScore} />
                  <AttackTypeBadge type={report.attackType} />
                </div>
                <span className="text-xs text-gray-500">
                  Block #{report.blockNumber}
                </span>
              </div>
              <div className="text-xs text-gray-400 space-y-1">
                <div className="flex justify-between">
                  <span>Target</span>
                  <span className="font-mono text-gray-300">
                    {report.targetContract.slice(0, 10)}...
                    {report.targetContract.slice(-6)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Reporter</span>
                  <span className="font-mono text-gray-300">
                    {report.reporter.slice(0, 10)}...
                    {report.reporter.slice(-4)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
