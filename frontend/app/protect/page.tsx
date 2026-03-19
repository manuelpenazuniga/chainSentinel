"use client";

import { useAccount } from "wagmi";
import { DepositForm } from "@/components/DepositForm";
import { WithdrawForm } from "@/components/WithdrawForm";
import { GuardianConfig } from "@/components/GuardianConfig";

export default function ProtectPage() {
  const { isConnected } = useAccount();

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] text-gray-500">
        <p>Connect your wallet to configure protection</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Protect Your Vault</h1>
        <p className="text-sm text-gray-500 mt-1">
          Deposit funds, set up the AI guardian, and configure emergency
          thresholds
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="space-y-6">
          <DepositForm />
          <WithdrawForm />
        </div>
        <GuardianConfig />
      </div>
    </div>
  );
}
