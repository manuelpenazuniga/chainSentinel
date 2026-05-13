"use client";

// ============================================================================
// VaultContext (§4.1 + §4.2)
// ============================================================================
//
// Centralizes "which vault is the user looking at right now?" so every panel
// (VaultStatus, DepositForm, GuardianConfig, etc.) reads the same source of
// truth instead of importing a global VAULT_ADDRESS constant.
//
// Two orthogonal selectors live here:
//
//   selectedVault  — the vault address (multi-user mode discovers via factory;
//                    single-user mode falls back to NEXT_PUBLIC_VAULT_ADDRESS).
//                    Auto-selects the first vault when the user connects.
//
//   selectedVm     — REVM | PVM. Drives which registry events the dashboard
//                    reads when both VMs are deployed (HAS_PVM === true). For
//                    REVM-only deployments the toggle is hidden and the value
//                    stays at "REVM".
// ============================================================================

import {
  createContext,
  useContext,
  useState,
  useEffect,
  ReactNode,
  useCallback,
} from "react";
import {
  REGISTRY_ADDRESS,
  REGISTRY_ADDRESS_PVM,
  HAS_PVM,
} from "./contracts";
import { useUserVaults } from "./useUserVaults";

export type Vm = "REVM" | "PVM";

interface VaultContextValue {
  // Vault selection
  selectedVault: `0x${string}` | null;
  setSelectedVault: (addr: `0x${string}` | null) => void;
  vaults: `0x${string}`[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;

  // VM selection (REVM ↔ PVM)
  selectedVm: Vm;
  setSelectedVm: (vm: Vm) => void;
  /** True when both REVM and PVM are configured (and the toggle should render). */
  hasPvm: boolean;
  /** Registry address for the currently selected VM. */
  registryAddress: `0x${string}`;
}

const VaultContext = createContext<VaultContextValue | undefined>(undefined);

export function VaultProvider({ children }: { children: ReactNode }) {
  const { vaults, isLoading, error, refetch } = useUserVaults();
  const [selectedVault, setSelectedVaultRaw] = useState<`0x${string}` | null>(null);
  const [selectedVm, setSelectedVmRaw] = useState<Vm>("REVM");

  // Auto-select first vault on first load; reconcile when the list changes.
  useEffect(() => {
    if (vaults.length === 0) {
      if (selectedVault !== null) setSelectedVaultRaw(null);
      return;
    }
    if (!selectedVault || !vaults.includes(selectedVault)) {
      setSelectedVaultRaw(vaults[0]);
    }
  }, [vaults, selectedVault]);

  const setSelectedVault = useCallback((addr: `0x${string}` | null) => {
    setSelectedVaultRaw(addr);
  }, []);

  const setSelectedVm = useCallback((vm: Vm) => {
    if (vm === "PVM" && !HAS_PVM) return; // ignore — PVM not configured
    setSelectedVmRaw(vm);
  }, []);

  const registryAddress: `0x${string}` =
    selectedVm === "PVM" && HAS_PVM ? REGISTRY_ADDRESS_PVM : REGISTRY_ADDRESS;

  return (
    <VaultContext.Provider
      value={{
        selectedVault,
        setSelectedVault,
        vaults,
        isLoading,
        error,
        refetch: () => {
          void refetch();
        },
        selectedVm,
        setSelectedVm,
        hasPvm: HAS_PVM,
        registryAddress,
      }}
    >
      {children}
    </VaultContext.Provider>
  );
}

export function useVault() {
  const ctx = useContext(VaultContext);
  if (!ctx) throw new Error("useVault must be used inside <VaultProvider>");
  return ctx;
}
