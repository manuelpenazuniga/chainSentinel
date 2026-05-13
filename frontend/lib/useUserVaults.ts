"use client";

import { useAccount, useReadContract } from "wagmi";
import {
  FACTORY_ADDRESS,
  FACTORY_ABI,
  IS_MULTI_USER,
  VAULT_ADDRESS,
} from "./contracts";

/**
 * Returns the list of vault addresses owned by the connected wallet.
 *
 * Behavior:
 *   - Multi-user mode (`NEXT_PUBLIC_FACTORY_ADDRESS` set): queries
 *     `factory.getUserVaults(connectedAddress)`. Refetches every 30s so newly
 *     created vaults appear without a manual refresh.
 *   - Single-user / demo mode: returns the single `NEXT_PUBLIC_VAULT_ADDRESS`
 *     as a one-element array. Backwards-compat with the existing deployment.
 *
 * Always returns `[]` when no wallet is connected.
 */
export function useUserVaults() {
  const { address, isConnected } = useAccount();

  const { data, isLoading, error, refetch } = useReadContract({
    address: FACTORY_ADDRESS,
    abi: FACTORY_ABI,
    functionName: "getUserVaults",
    args: address ? [address] : undefined,
    query: {
      enabled: IS_MULTI_USER && isConnected && !!address,
      refetchInterval: 30_000,
    },
  });

  // Single-user fallback: use the env-configured vault address as the only entry.
  if (!IS_MULTI_USER) {
    const fallback =
      VAULT_ADDRESS && VAULT_ADDRESS !== "0x0000000000000000000000000000000000000000"
        ? [VAULT_ADDRESS]
        : [];
    return {
      vaults: fallback,
      isLoading: false,
      error: null,
      refetch: () => Promise.resolve(),
    };
  }

  return {
    vaults: (data as `0x${string}`[]) ?? [],
    isLoading,
    error: (error as Error | null) ?? null,
    refetch,
  };
}
