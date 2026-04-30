"use client";

import { useState } from "react";
import { useReadContract } from "wagmi";
import { REGISTRY_ABI, REGISTRY_ADDRESS } from "@/lib/contracts";

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

export default function RegistryPage() {
  const [searchAddress, setSearchAddress] = useState("");
  const [queryAddress, setQueryAddress] = useState<`0x${string}` | "">("");
  const [page, setPage] = useState(0);
  const pageSize = 10;

  const isValidAddress = queryAddress.length === 42 && queryAddress.startsWith("0x");

  const { data: totalReports } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "totalReports",
  });

  const { data: threatScore } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "getThreatScore",
    args: isValidAddress ? [queryAddress as `0x${string}`] : undefined,
    query: { enabled: isValidAddress },
  });

  const { data: isBlacklisted } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "isBlacklisted",
    args: isValidAddress ? [queryAddress as `0x${string}`] : undefined,
    query: { enabled: isValidAddress },
  });

  const { data: reportCount } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "getReportCount",
    args: isValidAddress ? [queryAddress as `0x${string}`] : undefined,
    query: { enabled: isValidAddress },
  });

  const { data: reports, isLoading: reportsLoading } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "getReports",
    args: isValidAddress
      ? [queryAddress as `0x${string}`, BigInt(page * pageSize), BigInt(pageSize)]
      : undefined,
    query: { enabled: isValidAddress },
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setQueryAddress(searchAddress as `0x${string}`);
    setPage(0);
  }

  const reportList = (reports as ThreatReport[]) || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Threat Registry</h1>
        <p className="text-sm text-gray-500 mt-1">
          Explore the public on-chain registry of detected threats
        </p>
      </div>

      {/* Global stats */}
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
        <p className="text-sm text-gray-500">Total Reports On-Chain</p>
        <p className="text-3xl font-bold text-white">
          {totalReports?.toString() || "0"}
        </p>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <input
          type="text"
          placeholder="Search by contract address (0x...)"
          value={searchAddress}
          onChange={(e) => setSearchAddress(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 font-mono text-sm"
        />
        <button
          type="submit"
          className="px-6 py-2.5 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white transition-colors"
        >
          Search
        </button>
      </form>

      {/* Results */}
      {isValidAddress && (
        <div className="space-y-4">
          {/* Contract summary */}
          <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-white">
                Contract Analysis
              </h2>
              {isBlacklisted && (
                <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-red-500/20 text-red-400 border border-red-500/20">
                  BLACKLISTED
                </span>
              )}
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg bg-gray-800/50 p-3">
                <p className="text-xs text-gray-500 mb-0.5">Aggregate Score</p>
                <p className="text-lg font-bold text-white">
                  {threatScore?.toString() || "0"}
                  <span className="text-sm text-gray-500">/100</span>
                </p>
              </div>
              <div className="rounded-lg bg-gray-800/50 p-3">
                <p className="text-xs text-gray-500 mb-0.5">Reports</p>
                <p className="text-lg font-bold text-white">
                  {reportCount?.toString() || "0"}
                </p>
              </div>
              <div className="rounded-lg bg-gray-800/50 p-3">
                <p className="text-xs text-gray-500 mb-0.5">Status</p>
                <p
                  className={`text-lg font-bold ${
                    isBlacklisted ? "text-red-400" : "text-emerald-400"
                  }`}
                >
                  {isBlacklisted ? "Blocked" : "Active"}
                </p>
              </div>
            </div>

            <p className="text-xs text-gray-500 mt-3 font-mono">
              {queryAddress}
            </p>
          </div>

          {/* Report table */}
          {reportsLoading ? (
            <div className="animate-pulse space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-16 bg-gray-800 rounded-lg" />
              ))}
            </div>
          ) : reportList.length > 0 ? (
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-800 text-xs text-gray-500">
                    <th className="text-left py-3 px-4 font-medium">Score</th>
                    <th className="text-left py-3 px-4 font-medium">Attack Type</th>
                    <th className="text-left py-3 px-4 font-medium">Reporter</th>
                    <th className="text-left py-3 px-4 font-medium">Block</th>
                    <th className="text-left py-3 px-4 font-medium">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {reportList.map((report, i) => (
                    <tr
                      key={i}
                      className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                    >
                      <td className="py-3 px-4">
                        <ScoreBadge score={Number(report.threatScore)} />
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-300">
                        {report.attackType.replace(/_/g, " ")}
                      </td>
                      <td className="py-3 px-4 text-xs font-mono text-gray-400">
                        {report.reporter.slice(0, 8)}...{report.reporter.slice(-4)}
                      </td>
                      <td className="py-3 px-4 text-sm text-gray-400">
                        #{report.blockNumber.toString()}
                      </td>
                      <td className="py-3 px-4 text-xs text-gray-500 max-w-48 truncate">
                        {report.evidence}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Pagination */}
              <div className="flex justify-between items-center px-4 py-3 border-t border-gray-800">
                <button
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Previous
                </button>
                <span className="text-xs text-gray-500">Page {page + 1}</span>
                <button
                  disabled={reportList.length < pageSize}
                  onClick={() => setPage((p) => p + 1)}
                  className="text-xs text-gray-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next
                </button>
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-8 text-center">
              <p className="text-gray-500">No reports found for this contract</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
