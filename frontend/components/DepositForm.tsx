"use client";

import { useState } from "react";
import { parseEther } from "viem";
import { useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { VAULT_ABI, VAULT_ADDRESS } from "@/lib/contracts";

export function DepositForm() {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { data: hash, writeContract, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  function handleDeposit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!amount || parseFloat(amount) <= 0) return;

    try {
      const value = parseEther(amount);
      writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "depositNative",
        value,
      });
    } catch {
      setError("Invalid amount format");
    }
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <h3 className="text-base font-semibold text-white mb-4">
        Deposit PAS
      </h3>
      <form onSubmit={handleDeposit} className="space-y-4">
        <div>
          <label className="block text-sm text-gray-400 mb-1.5">
            Amount (PAS)
          </label>
          <div className="relative">
            <input
              type="number"
              step="0.0001"
              min="0"
              placeholder="0.0"
              value={amount}
              onChange={(e) => { setAmount(e.target.value); setError(null); }}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-500">
              PAS
            </span>
          </div>
          {error && (
            <p className="text-xs text-red-400 mt-1">{error}</p>
          )}
        </div>

        <button
          type="submit"
          disabled={isPending || isConfirming || !amount || parseFloat(amount) <= 0}
          className="w-full py-2.5 px-4 rounded-lg font-medium text-sm bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending
            ? "Confirm in wallet..."
            : isConfirming
            ? "Depositing..."
            : "Deposit"}
        </button>

        {isSuccess && (
          <p className="text-sm text-emerald-400 text-center">
            Deposit successful!
          </p>
        )}
      </form>
    </div>
  );
}
