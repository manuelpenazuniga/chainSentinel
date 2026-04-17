// ─── Live smoke test: H160 → AccountId32 mapping on Polkadot Hub ──────────────
//
// Confirms that pallet-revive's fallback scheme (h160 ‖ 0xEE × 12) is correct
// by querying both EVM and Substrate layers for the same set of addresses and
// comparing their native balances.
//
// Run:  NODE_PATH=./agent/node_modules npx tsx scripts/verify-h160-mapping.ts
//
// Exit 0 on full agreement, 1 on any mismatch.

import "dotenv/config";
import { ethers } from "ethers";
import { AgentKitWrapper, h160ToAccountId32 } from "../agent/src/agentkit.js";
import { AgentConfig } from "../agent/src/types.js";

const config: AgentConfig = {
  rpcUrl: process.env.RPC_URL!,
  wsUrl: process.env.WS_URL!,
  chainId: Number(process.env.CHAIN_ID!),
  agentPrivateKey: process.env.AGENT_PRIVATE_KEY!,
  vaultAddress: process.env.VAULT_ADDRESS!,
  registryAddress: process.env.REGISTRY_ADDRESS!,
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  heuristicThreshold: 30,
  emergencyThreshold: 80,
  cooldownBlocks: 10,
  llmTimeoutMs: 10000,
  telegramBotToken: "",
  telegramChatId: "",
};

const addressesToCheck: { label: string; h160: string }[] = [
  { label: "Agent (guardian)", h160: process.env.AGENT_ADDRESS ?? "0xED0f50f714b1297ebCb5BD64484966DCE32717d1" },
  { label: "SentinelVault (REVM)", h160: process.env.VAULT_ADDRESS! },
  { label: "SentinelVault (PVM)", h160: process.env.VAULT_ADDRESS_PVM ?? process.env.VAULT_ADDRESS! },
  { label: "SentinelRegistry (REVM)", h160: process.env.REGISTRY_ADDRESS! },
  { label: "Deployer", h160: "0x675fe3d56d6D9A579B9d096708760B23C7F6Febe" },
];

const EVM_TO_PLANCK_DIVISOR = 10n ** 8n;
const EXISTENTIAL_DEPOSIT_PLANCK = 10n ** 8n; // 0.01 PAS — Asset Hub Paseo ED

function fmtWei(wei: bigint): string {
  return `${ethers.formatUnits(wei, 18).padStart(14)} PAS (${wei.toString().padStart(22)} wei)`;
}

function fmtPlanck(planck: bigint): string {
  return `${ethers.formatUnits(planck, 10).padStart(14)} PAS (${planck.toString().padStart(22)} planck)`;
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  Live verification — H160 → AccountId32 mapping on Paseo           ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  console.log("Mapping scheme: AccountId32 = h160_bytes ‖ 0xEE × 12  (pallet-revive fallback)");
  console.log("Invariant:      evmWei == (substrateFree − ED) × 10^8   where ED = 0.01 PAS\n");

  const agentKit = new AgentKitWrapper(config);
  const substrateReady = await agentKit.initSubstrate(10000);
  if (!substrateReady) {
    console.error("✗ Substrate connection failed — cannot run verification.");
    process.exit(1);
  }

  let mismatches = 0;

  for (const { label, h160 } of addressesToCheck) {
    const accountId = h160ToAccountId32(h160);
    const dual = await agentKit.getDualLayerBalance(h160);

    const evmFree = dual.evmWei;
    const subFree = dual.substrateFree;

    // Invariant: evmWei == max(0, substrateFree - ED) × 10^8
    let match = false;
    let spendablePlanck = 0n;
    if (subFree !== null) {
      spendablePlanck = subFree >= EXISTENTIAL_DEPOSIT_PLANCK ? subFree - EXISTENTIAL_DEPOSIT_PLANCK : 0n;
      match = spendablePlanck * EVM_TO_PLANCK_DIVISOR === evmFree;
    }

    console.log(`── ${label} ──`);
    console.log(`  H160:         ${h160}`);
    console.log(`  AccountId:    ${accountId}`);
    console.log(`  EVM:          ${fmtWei(evmFree)}`);
    console.log(
      `  Substrate:    ${subFree === null ? "<unavailable>".padStart(14) + " PAS" : fmtPlanck(subFree)}`
    );
    if (subFree !== null) {
      console.log(`  Spendable:    ${fmtPlanck(spendablePlanck)}  (free − ED)`);
      console.log(`  × 10^8:       ${fmtWei(spendablePlanck * EVM_TO_PLANCK_DIVISOR)}`);
    }
    console.log(
      `  Invariant:    ${match ? "✓ holds" : subFree === null ? "– (offline)" : "✗ broken"}`
    );
    console.log();

    if (subFree === null || !match) mismatches += 1;
  }

  await agentKit.disconnectSubstrate();

  console.log("── Verdict ────────────────────────────────────────────────────────");
  if (mismatches === 0) {
    console.log("  ✅ PASS — every mapped AccountId32 returns the same balance as");
    console.log("           the EVM layer. The pallet-revive fallback scheme is");
    console.log("           confirmed on Polkadot Hub (Paseo).");
    process.exit(0);
  } else {
    console.log(`  ❌ FAIL — ${mismatches} address(es) showed divergent balances.`);
    console.log("           The mapping scheme may differ from the assumption, or");
    console.log("           the addresses have not been funded via eth-rpc.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
