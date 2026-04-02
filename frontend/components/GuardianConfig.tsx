"use client";

import { useState } from "react";
import { isAddress } from "viem";
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { VAULT_ABI, VAULT_ADDRESS } from "@/lib/contracts";

export function GuardianConfig() {
  const [guardianAddr, setGuardianAddr] = useState("");
  const [thresholdValue, setThresholdValue] = useState("");
  const [safeAddr, setSafeAddr] = useState("");
  const [error, setError] = useState<string | null>(null);

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

  const isValidGuardian = guardianAddr === "" || isAddress(guardianAddr);
  const isValidSafe = safeAddr === "" || isAddress(safeAddr);
  const isValidThreshold = thresholdValue === "" || (
    !isNaN(Number(thresholdValue)) &&
    Number(thresholdValue) >= 1 &&
    Number(thresholdValue) <= 100 &&
    Number.isInteger(Number(thresholdValue))
  );

  function handleSetGuardian() {
    setError(null);
    if (!isAddress(guardianAddr)) {
      setError("Invalid guardian address");
      return;
    }
    writeGuardian({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "setGuardian",
      args: [guardianAddr as `0x${string}`],
    });
  }

  function handleSetThreshold() {
    setError(null);
    const num = Number(thresholdValue);
    if (isNaN(num) || num < 1 || num > 100 || !Number.isInteger(num)) {
      setError("Threshold must be an integer between 1 and 100");
      return;
    }
    try {
      writeThreshold({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "setThreshold",
        args: [BigInt(num)],
      });
    } catch {
      setError("Invalid threshold value");
    }
  }

  function handleSetSafe() {
    setError(null);
    if (!isAddress(safeAddr)) {
      setError("Invalid safe address");
      return;
    }
    writeSafe({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "setSafeAddress",
      args: [safeAddr as `0x${string}`],
    });
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6 space-y-6">
      <h3 className="text-base font-semibold text-white">
        Protection Settings
      </h3>

      {error && (
        <p className="text-xs text-red-400 bg-red-900/20 border border-red-800 rounded-lg px-3 py-2">
          {error}
        </p>
      )}

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
            onChange={(e) => { setGuardianAddr(e.target.value); setError(null); }}
            className={`flex-1 bg-gray-800 border rounded-lg px-4 py-2 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 text-sm font-mono ${
              guardianAddr && !isValidGuardian ? "border-red-500" : "border-gray-700"
            }`}
          />
          <button
            onClick={handleSetGuardian}
            disabled={guardianPending || !guardianAddr || !isValidGuardian}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {guardianPending ? "..." : "Set"}
          </button>
        </div>
        {guardianAddr && !isValidGuardian && (
          <p className="text-xs text-red-400 mt-1">Invalid Ethereum address</p>
        )}
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
          Emergency Threshold (1-100)
        </label>
        <div className="flex gap-2">
          <input
            type="number"
            min="1"
            max="100"
            placeholder={currentThreshold ? currentThreshold.toString() : "80"}
            value={thresholdValue}
            onChange={(e) => { setThresholdValue(e.target.value); setError(null); }}
            className={`flex-1 bg-gray-800 border rounded-lg px-4 py-2 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 text-sm ${
              thresholdValue && !isValidThreshold ? "border-red-500" : "border-gray-700"
            }`}
          />
          <button
            onClick={handleSetThreshold}
            disabled={thresholdPending || !thresholdValue || !isValidThreshold}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {thresholdPending ? "..." : "Update"}
          </button>
        </div>
        {thresholdValue && !isValidThreshold && (
          <p className="text-xs text-red-400 mt-1">Must be an integer between 1 and 100</p>
        )}
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
            onChange={(e) => { setSafeAddr(e.target.value); setError(null); }}
            className={`flex-1 bg-gray-800 border rounded-lg px-4 py-2 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500 text-sm font-mono ${
              safeAddr && !isValidSafe ? "border-red-500" : "border-gray-700"
            }`}
          />
          <button
            onClick={handleSetSafe}
            disabled={safePending || !safeAddr || !isValidSafe}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {safePending ? "..." : "Update"}
          </button>
        </div>
        {safeAddr && !isValidSafe && (
          <p className="text-xs text-red-400 mt-1">Invalid Ethereum address</p>
        )}
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
