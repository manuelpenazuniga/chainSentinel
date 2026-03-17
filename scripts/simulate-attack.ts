/**
 * Attack Simulation Script for ChainSentinel Demo
 *
 * Simulates suspicious transaction patterns that the agent should detect:
 * 1. Rapid burst of transactions (TX_BURST rule)
 * 2. High-value transactions with withdrawal selectors (LARGE_WITHDRAWAL + ANOMALOUS_VALUE)
 * 3. Flash loan function signatures (FLASH_LOAN_PATTERN)
 *
 * Usage: npx tsx scripts/simulate-attack.ts
 */

import "dotenv/config";
import { ethers } from "ethers";

async function main() {
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL || "https://services.polkadothub-rpc.com/testnet",
    { chainId: parseInt(process.env.CHAIN_ID || "420420417"), name: "polkadot-hub-testnet" }
  );

  const attackerKey = process.env.ATTACKER_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY;
  if (!attackerKey) throw new Error("No attacker private key configured");
  const attacker = new ethers.Wallet(attackerKey, provider);

  console.log("=== ChainSentinel Attack Simulation ===");
  console.log(`Attacker address: ${attacker.address}`);
  console.log(`Network: ${(await provider.getNetwork()).chainId}`);

  const vaultAddress = process.env.VAULT_ADDRESS;
  if (!vaultAddress) throw new Error("VAULT_ADDRESS not set");

  console.log(`\nTarget vault: ${vaultAddress}`);
  console.log("\nPhase 1: Sending rapid burst of transactions...");

  for (let i = 0; i < 6; i++) {
    try {
      const tx = await attacker.sendTransaction({
        to: vaultAddress,
        value: ethers.parseEther("0.1"),
        data: "0x2e1a7d4d" + "0".repeat(64), // withdraw(uint256) selector
      });
      console.log(`  Tx ${i + 1}/6 sent: ${tx.hash}`);
    } catch (error) {
      console.log(`  Tx ${i + 1}/6 failed (expected for demo):`, (error as Error).message.slice(0, 80));
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\nPhase 2: Sending high-value transaction with flash loan selector...");
  try {
    const tx = await attacker.sendTransaction({
      to: vaultAddress,
      value: ethers.parseEther("50"),
      data: "0xab9c4b5d" + "0".repeat(64), // flashLoan selector
    });
    console.log(`  High-value tx sent: ${tx.hash}`);
  } catch (error) {
    console.log(`  High-value tx failed (expected):`, (error as Error).message.slice(0, 80));
  }

  console.log("\n=== Simulation Complete ===");
  console.log("The ChainSentinel agent should have detected these patterns.");
  console.log("Check the agent logs for threat assessments and emergency actions.");
}

main().catch(console.error);
