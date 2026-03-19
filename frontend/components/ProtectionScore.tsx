"use client";

import { useReadContract } from "wagmi";
import { VAULT_ABI, VAULT_ADDRESS, NATIVE_TOKEN } from "@/lib/contracts";
import { formatEther } from "viem";

export function ProtectionScore() {
  const { data: status } = useReadContract({
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

  const [, guardian, safeAddress, threshold, , , ,isProtected] = status || [];

  const hasGuardian = guardian && guardian !== "0x0000000000000000000000000000000000000000";
  const hasSafe = safeAddress && safeAddress !== "0x0000000000000000000000000000000000000000";
  const hasFunds = nativeBalance ? nativeBalance > BigInt(0) : false;
  const hasThreshold = threshold ? threshold > BigInt(0) : false;

  const checks = [
    { label: "Guardian assigned", ok: !!hasGuardian },
    { label: "Safe address configured", ok: !!hasSafe },
    { label: "Funds deposited", ok: hasFunds },
    { label: "Threshold configured", ok: hasThreshold },
  ];

  const completedCount = checks.filter((c) => c.ok).length;
  const percentage = Math.round((completedCount / checks.length) * 100);

  const ringColor =
    percentage === 100
      ? "text-emerald-400"
      : percentage >= 50
      ? "text-amber-400"
      : "text-red-400";

  const circumference = 2 * Math.PI * 40;
  const strokeDashoffset = circumference - (percentage / 100) * circumference;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <h2 className="text-lg font-semibold text-white mb-4">Protection Score</h2>

      <div className="flex items-center gap-6">
        {/* Circular progress */}
        <div className="relative w-24 h-24 shrink-0">
          <svg className="w-24 h-24 -rotate-90" viewBox="0 0 96 96">
            <circle
              cx="48"
              cy="48"
              r="40"
              fill="none"
              stroke="#1f2937"
              strokeWidth="6"
            />
            <circle
              cx="48"
              cy="48"
              r="40"
              fill="none"
              className={ringColor}
              stroke="currentColor"
              strokeWidth="6"
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffset}
              style={{ transition: "stroke-dashoffset 0.5s ease" }}
            />
          </svg>
          <div className="absolute inset-0 flex items-center justify-center">
            <span className={`text-xl font-bold ${ringColor}`}>
              {percentage}%
            </span>
          </div>
        </div>

        {/* Checklist */}
        <div className="space-y-2 flex-1">
          {checks.map((check) => (
            <div key={check.label} className="flex items-center gap-2 text-sm">
              {check.ok ? (
                <svg
                  className="w-4 h-4 text-emerald-400 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2.5}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M4.5 12.75l6 6 9-13.5"
                  />
                </svg>
              ) : (
                <svg
                  className="w-4 h-4 text-gray-600 shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <circle cx="12" cy="12" r="9" />
                </svg>
              )}
              <span className={check.ok ? "text-gray-300" : "text-gray-500"}>
                {check.label}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
