"use client";

import { useVault } from "@/lib/VaultContext";

/**
 * Compact REVM ↔ PVM toggle. Renders only when both VMs are configured,
 * i.e. `NEXT_PUBLIC_VAULT_ADDRESS_PVM` is set in addition to the REVM address.
 *
 * The selection drives which `SentinelRegistry` the dashboard reads from
 * (events, aggregate scores, threat feed). Vault selection is independent.
 */
export function VmToggle() {
  const { selectedVm, setSelectedVm, hasPvm } = useVault();

  if (!hasPvm) return null;

  return (
    <div
      role="group"
      aria-label="Select execution VM"
      className="inline-flex rounded-md border border-gray-700 bg-gray-800/60 overflow-hidden"
    >
      {(["REVM", "PVM"] as const).map((vm) => (
        <button
          key={vm}
          onClick={() => setSelectedVm(vm)}
          className={`px-3 py-1 text-xs font-medium transition-colors ${
            selectedVm === vm
              ? "bg-emerald-600 text-white"
              : "text-gray-400 hover:text-white hover:bg-gray-700/60"
          }`}
        >
          {vm}
        </button>
      ))}
    </div>
  );
}
