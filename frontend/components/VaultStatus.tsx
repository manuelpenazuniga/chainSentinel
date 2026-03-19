"use client";

import { useReadContract } from "wagmi";
import { formatEther } from "viem";
import { VAULT_ABI, VAULT_ADDRESS, NATIVE_TOKEN } from "@/lib/contracts";

export function VaultStatus() {
  const { data: status, isLoading } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "getVaultStatus",
  });

  const { data: nativeBalance } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "getBalance",
    args: [NATIVE_TOKEN],
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 animate-pulse">
        <div className="h-6 bg-gray-800 rounded w-1/3 mb-4" />
        <div className="h-12 bg-gray-800 rounded w-1/2 mb-6" />
        <div className="grid grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-16 bg-gray-800 rounded" />
          ))}
        </div>
      </div>
    );
  }

  const [owner, guardian, safeAddress, threshold, cooldownBlocks, lastEmergencyBlock, tokenCount, isProtected] =
    status || [];

  const isGuardianSet = guardian && guardian !== "0x0000000000000000000000000000000000000000";
  const balance = nativeBalance ? formatEther(nativeBalance) : "0";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-white">Vault Status</h2>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
            isProtected
              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
              : "bg-red-500/10 text-red-400 border border-red-500/20"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isProtected ? "bg-emerald-400" : "bg-red-400"
            }`}
          />
          {isProtected ? "Protected" : "Unprotected"}
        </span>
      </div>

      <div className="mb-6">
        <p className="text-sm text-gray-500 mb-1">Total Balance</p>
        <p className="text-3xl font-bold text-white">
          {parseFloat(balance).toFixed(4)}{" "}
          <span className="text-lg text-gray-400">PAS</span>
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <InfoCard
          label="Guardian"
          value={
            isGuardianSet
              ? `${guardian!.slice(0, 6)}...${guardian!.slice(-4)}`
              : "None"
          }
          variant={isGuardianSet ? "success" : "warning"}
        />
        <InfoCard
          label="Threat Threshold"
          value={threshold ? `${threshold.toString()}/100` : "—"}
          variant="neutral"
        />
        <InfoCard
          label="Cooldown"
          value={cooldownBlocks ? `${cooldownBlocks.toString()} blocks` : "—"}
          variant="neutral"
        />
        <InfoCard
          label="Tokens Tracked"
          value={tokenCount?.toString() || "0"}
          variant="neutral"
        />
      </div>

      {owner && (
        <div className="mt-4 pt-4 border-t border-gray-800">
          <div className="flex justify-between text-sm">
            <span className="text-gray-500">Owner</span>
            <span className="text-gray-300 font-mono text-xs">
              {owner.slice(0, 10)}...{owner.slice(-8)}
            </span>
          </div>
          {safeAddress && safeAddress !== "0x0000000000000000000000000000000000000000" && (
            <div className="flex justify-between text-sm mt-1">
              <span className="text-gray-500">Safe Address</span>
              <span className="text-gray-300 font-mono text-xs">
                {safeAddress.slice(0, 10)}...{safeAddress.slice(-8)}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InfoCard({
  label,
  value,
  variant,
}: {
  label: string;
  value: string;
  variant: "success" | "warning" | "neutral";
}) {
  const colors = {
    success: "text-emerald-400",
    warning: "text-amber-400",
    neutral: "text-gray-200",
  };

  return (
    <div className="rounded-lg bg-gray-800/50 p-3">
      <p className="text-xs text-gray-500 mb-0.5">{label}</p>
      <p className={`text-sm font-semibold ${colors[variant]}`}>{value}</p>
    </div>
  );
}
