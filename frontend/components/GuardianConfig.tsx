"use client";

import { useState } from "react";
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { VAULT_ABI, VAULT_ADDRESS } from "@/lib/contracts";

export function GuardianConfig() {
  const [guardianAddr, setGuardianAddr] = useState("");
  const [thresholdValue, setThresholdValue] = useState("");
  const [safeAddr, setSafeAddr] = useState("");

  const { data: currentGuardian } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "guardian",
  });

  const { data: currentThreshold } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "threshold",
  });

  const { data: currentSafe } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "safeAddress",
  });

  const { data: guardianHash, writeContract: writeGuardian, isPending: guardianPending } = useWriteContract();
  const { data: thresholdHash, writeContract: writeThreshold, isPending: thresholdPending } = useWriteContract();
  const { data: safeHash, writeContract: writeSafe, isPending: safePending } = useWriteContract();
  const { data: removeHash, writeContract: writeRemove, isPending: removePending } = useWriteContract();

  const { isSuccess: guardianSuccess } = useWaitForTransactionReceipt({ hash: guardianHash });
  const { isSuccess: thresholdSuccess } = useWaitForTransactionReceipt({ hash: thresholdHash });
  const { isSuccess: safeSuccess } = useWaitForTransactionReceipt({ hash: safeHash });
  const { isSuccess: removeSuccess } = useWaitForTransactionReceipt({ hash: removeHash });

  const hasGuardian =
    currentGuardian && currentGuardian !== "0x0000000000000000000000000000000000000000";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 space-y-6">
      <h3 className="text-base font-semibold text-white">
        Protection Settings
      </h3>

      {/* Guardian */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Guardian Address (AI Agent)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="0x..."
            value={guardianAddr}
            onChange={(e) => setGuardianAddr(e.target.value)}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 text-sm font-mono"
          />
          <button
            onClick={() =>
              writeGuardian({
                address: VAULT_ADDRESS,
                abi: VAULT_ABI,
                functionName: "setGuardian",
                args: [guardianAddr as `0x${string}`],
              })
            }
            disabled={guardianPending || !guardianAddr}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {guardianPending ? "..." : "Set"}
          </button>
        </div>
        {hasGuardian && (
          <div className="flex items-center justify-between mt-2">
            <p className="text-xs text-gray-500">
              Current:{" "}
              <span className="font-mono text-gray-400">
                {currentGuardian!.slice(0, 10)}...{currentGuardian!.slice(-6)}
              </span>
            </p>
            <button
              onClick={() =>
                writeRemove({
                  address: VAULT_ADDRESS,
                  abi: VAULT_ABI,
                  functionName: "removeGuardian",
                })
              }
              disabled={removePending}
              className="text-xs text-red-400 hover:text-red-300"
            >
              {removePending ? "Removing..." : "Remove Guardian"}
            </button>
          </div>
        )}
        {guardianSuccess && (
          <p className="text-xs text-emerald-400 mt-1">Guardian updated!</p>
        )}
        {removeSuccess && (
          <p className="text-xs text-amber-400 mt-1">Guardian removed.</p>
        )}
      </div>

      {/* Threshold */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Emergency Threshold (0-100)
        </label>
        <div className="flex gap-2">
          <input
            type="number"
            min="1"
            max="100"
            placeholder={currentThreshold ? currentThreshold.toString() : "80"}
            value={thresholdValue}
            onChange={(e) => setThresholdValue(e.target.value)}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 text-sm"
          />
          <button
            onClick={() =>
              writeThreshold({
                address: VAULT_ADDRESS,
                abi: VAULT_ABI,
                functionName: "setThreshold",
                args: [BigInt(thresholdValue)],
              })
            }
            disabled={thresholdPending || !thresholdValue}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {thresholdPending ? "..." : "Update"}
          </button>
        </div>
        {currentThreshold && (
          <p className="text-xs text-gray-500 mt-1">
            Current threshold: {currentThreshold.toString()}
          </p>
        )}
        {thresholdSuccess && (
          <p className="text-xs text-emerald-400 mt-1">Threshold updated!</p>
        )}
      </div>

      {/* Safe Address */}
      <div>
        <label className="block text-sm text-gray-400 mb-1.5">
          Safe Address (emergency fund destination)
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="0x..."
            value={safeAddr}
            onChange={(e) => setSafeAddr(e.target.value)}
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 text-sm font-mono"
          />
          <button
            onClick={() =>
              writeSafe({
                address: VAULT_ADDRESS,
                abi: VAULT_ABI,
                functionName: "setSafeAddress",
                args: [safeAddr as `0x${string}`],
              })
            }
            disabled={safePending || !safeAddr}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {safePending ? "..." : "Update"}
          </button>
        </div>
        {currentSafe && currentSafe !== "0x0000000000000000000000000000000000000000" && (
          <p className="text-xs text-gray-500 mt-1">
            Current:{" "}
            <span className="font-mono text-gray-400">
              {currentSafe.slice(0, 10)}...{currentSafe.slice(-6)}
            </span>
          </p>
        )}
        {safeSuccess && (
          <p className="text-xs text-emerald-400 mt-1">Safe address updated!</p>
        )}
      </div>
    </div>
  );
}
