"use client";

import { useReadContract } from "wagmi";
import { REGISTRY_ABI, REGISTRY_ADDRESS } from "@/lib/contracts";
import { useState } from "react";

interface ThreatReport {
  reporter: string;
  targetContract: string;
  threatScore: bigint;
  attackType: string;
  evidence: string;
  timestamp: bigint;
  blockNumber: bigint;
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

function timeAgo(timestamp: number): string {
  const seconds = Math.floor(Date.now() / 1000 - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function ThreatFeed({ contractAddress }: { contractAddress?: `0x${string}` }) {
  const [page, setPage] = useState(0);
  const pageSize = 10;

  const { data: totalReports } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "totalReports",
  });

  const { data: reports, isLoading } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "getReports",
    args: contractAddress
      ? [contractAddress, BigInt(page * pageSize), BigInt(pageSize)]
      : undefined,
    query: { enabled: !!contractAddress },
  });

  const total = Number(totalReports || 0);

  if (!contractAddress) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
        <h2 className="text-lg font-semibold text-white mb-4">Threat Feed</h2>
        <div className="flex flex-col items-center justify-center py-12 text-gray-500">
          <svg className="w-12 h-12 mb-3 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
          </svg>
          <p className="text-sm">No contract selected for monitoring</p>
          <p className="text-xs text-gray-600 mt-1">
            Total reports in registry: {total}
          </p>
        </div>
      </div>
    );
  }

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

  const reportList = (reports as ThreatReport[]) || [];

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Threat Feed</h2>
        <span className="text-xs text-gray-500">
          {reportList.length} report{reportList.length !== 1 ? "s" : ""}
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
                  <ScoreBadge score={Number(report.threatScore)} />
                  <AttackTypeBadge type={report.attackType} />
                </div>
                <span className="text-xs text-gray-500">
                  {timeAgo(Number(report.timestamp))}
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
                  <span>Block</span>
                  <span className="text-gray-300">
                    #{report.blockNumber.toString()}
                  </span>
                </div>
                {report.evidence && (
                  <p className="text-gray-500 mt-1 truncate">{report.evidence}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {reportList.length >= pageSize && (
        <div className="flex justify-between mt-3 pt-3 border-t border-gray-800">
          <button
            disabled={page === 0}
            onClick={() => setPage((p) => p - 1)}
            className="text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Previous
          </button>
          <button
            onClick={() => setPage((p) => p + 1)}
            className="text-xs text-gray-400 hover:text-white"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
