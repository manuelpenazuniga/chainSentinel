"use client";

import { useVault } from "@/lib/VaultContext";
import { IS_MULTI_USER } from "@/lib/contracts";

/**
 * Dropdown selector for switching between vaults the connected wallet owns.
 * Hidden when only one vault is available (single-user demo mode).
 */
export function VaultSelector() {
  const { vaults, selectedVault, setSelectedVault, isLoading } = useVault();

  if (isLoading) {
    return (
      <span className="text-xs text-gray-500 px-2 py-1 rounded bg-gray-800/50 border border-gray-800">
        Loading vaults…
      </span>
    );
  }

  // Single-user / demo mode with one vault: don't show a useless dropdown.
  if (!IS_MULTI_USER || vaults.length <= 1) return null;

  return (
    <select
      value={selectedVault ?? ""}
      onChange={(e) => setSelectedVault(e.target.value as `0x${string}`)}
      className="px-2 py-1 rounded border border-gray-700 bg-gray-800 text-white text-xs font-mono focus:outline-none focus:ring-1 focus:ring-emerald-500/50"
      aria-label="Select active vault"
    >
      {vaults.map((v) => (
        <option key={v} value={v}>
          {v.slice(0, 6)}…{v.slice(-4)}
        </option>
      ))}
    </select>
  );
}
