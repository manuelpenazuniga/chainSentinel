"use client";

import { useState } from "react";
import { parseEther } from "viem";
import { useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { VAULT_ABI, VAULT_ADDRESS, NATIVE_TOKEN } from "@/lib/contracts";
import { formatEther } from "viem";

export function WithdrawForm() {
  const [amount, setAmount] = useState("");

  const { data: balance } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "getBalance",
    args: [NATIVE_TOKEN],
  });

  const { data: hash, writeContract, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess } = useWaitForTransactionReceipt({
    hash,
  });

  function handleWithdraw(e: React.FormEvent) {
    e.preventDefault();
    if (!amount || parseFloat(amount) <= 0) return;

    writeContract({
      address: VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: "withdraw",
      args: [NATIVE_TOKEN, parseEther(amount)],
    });
  }

  const currentBalance = balance ? formatEther(balance) : "0";

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <h3 className="text-base font-semibold text-white mb-4">
        Withdraw PAS
      </h3>
      <form onSubmit={handleWithdraw} className="space-y-4">
        <div>
          <div className="flex justify-between items-center mb-1.5">
            <label className="text-sm text-gray-400">Amount (PAS)</label>
            <button
              type="button"
              onClick={() => setAmount(currentBalance)}
              className="text-xs text-emerald-500 hover:text-emerald-400"
            >
              Max: {parseFloat(currentBalance).toFixed(4)}
            </button>
          </div>
          <input
            type="number"
            step="0.0001"
            min="0"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-white placeholder-gray-600 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 focus:border-emerald-500"
          />
        </div>

        <button
          type="submit"
          disabled={isPending || isConfirming || !amount}
          className="w-full py-2.5 px-4 rounded-lg font-medium text-sm bg-gray-700 hover:bg-gray-600 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {isPending
            ? "Confirm in wallet..."
            : isConfirming
            ? "Withdrawing..."
            : "Withdraw"}
        </button>

        {isSuccess && (
          <p className="text-sm text-emerald-400 text-center">
            Withdrawal successful!
          </p>
        )}
      </form>
    </div>
  );
}
