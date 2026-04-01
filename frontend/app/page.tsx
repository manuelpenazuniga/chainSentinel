"use client";

import { useAccount, useReadContract } from "wagmi";
import { VaultStatus } from "@/components/VaultStatus";
import { ThreatFeed } from "@/components/ThreatFeed";
import { ThreatChart } from "@/components/ThreatChart";
import { ProtectionScore } from "@/components/ProtectionScore";
import { ActivityLog } from "@/components/ActivityLog";
import { VAULT_ABI, VAULT_ADDRESS, REGISTRY_ABI, REGISTRY_ADDRESS } from "@/lib/contracts";

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: "emerald" | "amber" | "red" | "default";
}) {
  const valueColors = {
    emerald: "text-emerald-400",
    amber: "text-amber-400",
    red: "text-red-400",
    default: "text-white",
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-5 hover:border-gray-700 transition-all duration-200">
      <p className="text-sm text-gray-500 mb-1">{label}</p>
      <p className={`text-2xl font-bold ${valueColors[accent || "default"]}`}>
        {value}
      </p>
      {sub && <p className="text-xs text-gray-500 mt-1">{sub}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { isConnected } = useAccount();

  const { data: vaultStatus } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "getVaultStatus",
  });

  const { data: totalReports } = useReadContract({
    address: REGISTRY_ADDRESS,
    abi: REGISTRY_ABI,
    functionName: "totalReports",
  });

  const isProtected = vaultStatus?.[7] ?? false;
  const threshold = vaultStatus?.[3] ? Number(vaultStatus[3]) : 0;

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <div className="w-20 h-20 rounded-2xl bg-emerald-500/10 flex items-center justify-center mb-6 animate-pulse">
          <svg
            className="w-10 h-10 text-emerald-400"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
            />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-white mb-3">
          Chain<span className="text-emerald-400">Sentinel</span>
        </h1>
        <p className="text-gray-400 max-w-md mb-2">
          AI-powered DeFi protection on Polkadot Hub.
        </p>
        <p className="text-gray-500 max-w-md mb-8 text-sm">
          Monitor your vault, detect threats in real-time, and automatically
          rescue your funds before exploits materialize.
        </p>

        <div className="grid grid-cols-3 gap-6 text-center max-w-lg mb-10">
          <div>
            <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <p className="text-xs text-gray-400">Real-time Monitoring</p>
          </div>
          <div>
            <div className="w-10 h-10 rounded-lg bg-purple-500/10 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <p className="text-xs text-gray-400">AI Threat Detection</p>
          </div>
          <div>
            <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center mx-auto mb-2">
              <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
              </svg>
            </div>
            <p className="text-xs text-gray-400">Auto Fund Rescue</p>
          </div>
        </div>

        <p className="text-sm text-gray-600">
          Connect your wallet to get started
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-1">
          Monitor your vault and threat activity
        </p>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard
          label="Protection Status"
          value={isProtected ? "Active" : "Inactive"}
          sub={isProtected ? "Guardian is monitoring" : "Set a guardian to activate"}
          accent={isProtected ? "emerald" : "red"}
        />
        <StatCard
          label="Threat Threshold"
          value={`${threshold}/100`}
          sub="Min score for emergency action"
        />
        <StatCard
          label="Registry Reports"
          value={totalReports?.toString() || "0"}
          sub="Total threats reported on-chain"
        />
      </div>

      {/* Main grid — 3 columns on large, 1 on mobile */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <ThreatChart />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <VaultStatus />
            <ThreatFeed />
          </div>
        </div>
        <div className="space-y-6">
          <ProtectionScore />
          <ActivityLog />
        </div>
      </div>
    </div>
  );
}
