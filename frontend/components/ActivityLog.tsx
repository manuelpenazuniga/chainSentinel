"use client";

import { useReadContract } from "wagmi";
import { VAULT_ABI, VAULT_ADDRESS } from "@/lib/contracts";

const eventIcons: Record<string, { icon: string; color: string }> = {
  deposit: { icon: "+", color: "text-emerald-400 bg-emerald-500/10" },
  withdraw: { icon: "-", color: "text-amber-400 bg-amber-500/10" },
  emergency: { icon: "!", color: "text-red-400 bg-red-500/10" },
  guardian: { icon: "G", color: "text-blue-400 bg-blue-500/10" },
};

interface ActivityEvent {
  type: "deposit" | "withdraw" | "emergency" | "guardian";
  label: string;
  detail: string;
  time: string;
}

export function ActivityLog() {
  const { data: status } = useReadContract({
    address: VAULT_ADDRESS,
    abi: VAULT_ABI,
    functionName: "getVaultStatus",
  });

  const lastEmergencyBlock = status?.[5] ? Number(status[5]) : 0;
  const isProtected = status?.[7] ?? false;

  // Build activity from on-chain state
  const events: ActivityEvent[] = [];

  if (lastEmergencyBlock > 0) {
    events.push({
      type: "emergency",
      label: "Emergency Withdrawal",
      detail: `Executed at block #${lastEmergencyBlock}`,
      time: "On-chain",
    });
  }

  if (isProtected) {
    events.push({
      type: "guardian",
      label: "Guardian Active",
      detail: "AI agent is monitoring your vault",
      time: "Current",
    });
  }

  if (events.length === 0) {
    events.push({
      type: "deposit",
      label: "Ready",
      detail: "Deposit funds and set a guardian to start protection",
      time: "—",
    });
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900/50 p-6">
      <h2 className="text-lg font-semibold text-white mb-4">Activity</h2>
      <div className="space-y-3">
        {events.map((event, i) => {
          const config = eventIcons[event.type];
          return (
            <div key={i} className="flex items-start gap-3">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${config.color}`}
              >
                {config.icon}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-200">
                    {event.label}
                  </p>
                  <span className="text-xs text-gray-600">{event.time}</span>
                </div>
                <p className="text-xs text-gray-500 truncate">{event.detail}</p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
