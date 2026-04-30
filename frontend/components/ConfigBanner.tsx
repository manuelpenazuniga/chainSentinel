"use client";

import { IS_CONFIGURED } from "@/lib/contracts";

export function ConfigBanner() {
  if (IS_CONFIGURED) return null;

  return (
    <div className="mb-6 rounded-lg border border-amber-800 bg-amber-900/20 px-4 py-3">
      <p className="text-sm text-amber-400">
        <span className="font-semibold">Configuration required:</span>{" "}
        Contract addresses not set. Add{" "}
        <code className="text-xs bg-gray-800 px-1.5 py-0.5 rounded">NEXT_PUBLIC_VAULT_ADDRESS</code> and{" "}
        <code className="text-xs bg-gray-800 px-1.5 py-0.5 rounded">NEXT_PUBLIC_REGISTRY_ADDRESS</code>{" "}
        to your <code className="text-xs bg-gray-800 px-1.5 py-0.5 rounded">.env.local</code> file.
      </p>
    </div>
  );
}
