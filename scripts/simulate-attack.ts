/**
 * Attack Simulation Script for ChainSentinel Demo
 *
 * Deploys a DummyDeFi contract and simulates a multi-phase attack
 * that triggers progressively higher threat scores:
 *
 *   Phase 0 — Seed: 10 small "normal" transactions to build history
 *   Phase 1 — TX_BURST + ANOMALOUS_VALUE → score ~65 → triggers LLM
 *   Phase 2 — FLASH_LOAN_PATTERN + TX_BURST → score ~70 → triggers LLM
 *   Phase 3 — All combined → score >80 → triggers emergency withdraw
 *
 * Usage:
 *   cd chainSentinel
 *   set -a && source .env && set +a
 *   NODE_PATH=./agent/node_modules npx tsx scripts/simulate-attack.ts
 */

import { ethers } from "ethers";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// DummyDeFi minimal ABI
const DUMMY_ABI = [
  "function withdraw(uint256 amount) external",
  "function flashLoan(address, address, uint256 amount, bytes calldata) external",
  "function totalDeposited() view returns (uint256)",
];

// DummyDeFi bytecode — compiled from contracts/src/DummyDeFi.sol
// We deploy it inline so the script is self-contained
async function deployDummyDeFi(
  deployer: ethers.Wallet
): Promise<ethers.Contract> {
  console.log("  Deploying DummyDeFi contract...");

  // Get bytecode from the Foundry artifacts
  const fs = await import("fs");
  const path = await import("path");

  // Try multiple paths to find the artifact
  const candidates = [
    path.resolve(process.cwd(), "contracts/out/DummyDeFi.sol/DummyDeFi.json"),
    path.resolve(process.cwd(), "../contracts/out/DummyDeFi.sol/DummyDeFi.json"),
  ];
  const artifactPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];

  let bytecode: string;
  try {
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
    bytecode = artifact.bytecode.object;
  } catch {
    throw new Error(
      "DummyDeFi artifact not found. Run: cd contracts && forge build"
    );
  }

  const factory = new ethers.ContractFactory(DUMMY_ABI, bytecode, deployer);
  const contract = await factory.deploy();
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`  DummyDeFi deployed at: ${address}\n`);
  return new ethers.Contract(address, DUMMY_ABI, deployer);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(
    process.env.RPC_URL || "https://services.polkadothub-rpc.com/testnet",
    {
      chainId: parseInt(process.env.CHAIN_ID || "420420417"),
      name: "polkadot-hub-testnet",
    }
  );

  // Use DEPLOYER key (has funds) as the "attacker"
  const attackerKey =
    process.env.DEPLOYER_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY;
  if (!attackerKey)
    throw new Error("Need DEPLOYER_PRIVATE_KEY or AGENT_PRIVATE_KEY");
  const attacker = new ethers.Wallet(attackerKey, provider);

  const balance = await provider.getBalance(attacker.address);
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║       ChainSentinel — Attack Simulation           ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log(`  Attacker:  ${attacker.address}`);
  console.log(`  Balance:   ${ethers.formatEther(balance)} PAS`);
  console.log(`  Network:   Chain ID ${(await provider.getNetwork()).chainId}`);
  console.log(`  Vault:     ${process.env.VAULT_ADDRESS || "not set"}\n`);

  // ────────────────────────────────────────────
  // Deploy DummyDeFi (or reuse existing via DUMMY_DEFI_ADDRESS env var)
  // ────────────────────────────────────────────
  let dummy: ethers.Contract;
  let dummyAddr: string;

  if (process.env.DUMMY_DEFI_ADDRESS) {
    dummyAddr = process.env.DUMMY_DEFI_ADDRESS;
    dummy = new ethers.Contract(dummyAddr, DUMMY_ABI, attacker);
    console.log(`  Reusing DummyDeFi at: ${dummyAddr}\n`);
  } else {
    dummy = await deployDummyDeFi(attacker);
    dummyAddr = await dummy.getAddress();
  }

  // ────────────────────────────────────────────
  // Phase 0: Seed — build "normal" transaction history
  // 10 small txs so the agent learns the average value for this contract
  // ────────────────────────────────────────────
  console.log("─── Phase 0: Seeding normal transaction history ───");
  console.log("  Sending 10 small txs (0.01 PAS each) to build averages...\n");

  for (let i = 0; i < 10; i++) {
    try {
      const tx = await attacker.sendTransaction({
        to: dummyAddr,
        value: ethers.parseEther("0.01"),
      });
      await tx.wait();
      process.stdout.write(`  ✓ Tx ${i + 1}/10\r`);
    } catch (error) {
      console.log(
        `  ✗ Tx ${i + 1}/10:`,
        (error as Error).message.slice(0, 80)
      );
    }
    // Short pause between txs so they land in different blocks
    await sleep(2000);
  }
  console.log("  ✓ 10/10 seed transactions confirmed            ");
  console.log("  Agent now has avg value ~0.01 PAS for this contract.\n");

  // Wait for agent to process the seed transactions
  console.log("  Waiting 20s for agent to process seed data...\n");
  await sleep(20000);

  // ────────────────────────────────────────────
  // Phase 1: TX_BURST + ANOMALOUS_VALUE
  // 6 rapid txs of 5 PAS each (500x the average)
  // TX_BURST = +30, ANOMALOUS_VALUE = +35 → total = 65
  // Score 65 > heuristicThreshold (30) → triggers LLM analysis
  // ────────────────────────────────────────────
  console.log("─── Phase 1: TX_BURST + ANOMALOUS_VALUE ───");
  console.log("  6 rapid txs × 5 PAS = 500x average");
  console.log("  Expected score: ~65 (TX_BURST:30 + ANOMALOUS_VALUE:35)");
  console.log("  → Should trigger LLM analysis\n");

  for (let i = 0; i < 6; i++) {
    try {
      const tx = await attacker.sendTransaction({
        to: dummyAddr,
        value: ethers.parseEther("5"),
      });
      console.log(`  Tx ${i + 1}/6 sent: ${tx.hash.slice(0, 18)}...`);
      await tx.wait();
    } catch (error) {
      console.log(
        `  Tx ${i + 1}/6 failed:`,
        (error as Error).message.slice(0, 80)
      );
    }
  }

  console.log("\n  Waiting 20s for agent detection + LLM analysis...\n");
  await sleep(20000);

  // ────────────────────────────────────────────
  // Phase 2: FLASH_LOAN_PATTERN
  // Call flashLoan() on the DummyDeFi contract
  // FLASH_LOAN_PATTERN = +40
  // If combined with TX_BURST (still active) = +30 → total = 70
  // ────────────────────────────────────────────
  console.log("─── Phase 2: FLASH_LOAN_PATTERN ───");
  console.log("  Calling flashLoan() selector (0xab9c4b5d)");
  console.log("  Expected score: ~70 (FLASH_LOAN:40 + TX_BURST:30)");
  console.log("  → Should trigger LLM analysis + report to Registry\n");

  try {
    const tx = await dummy.flashLoan(
      attacker.address,
      dummyAddr,
      ethers.parseEther("1000"),
      "0x"
    );
    console.log(`  FlashLoan tx sent: ${tx.hash.slice(0, 18)}...`);
    await tx.wait();
    console.log("  ✓ Confirmed\n");
  } catch (error) {
    console.log(
      "  FlashLoan tx failed:",
      (error as Error).message.slice(0, 100)
    );
  }

  console.log("  Waiting 20s for agent detection...\n");
  await sleep(20000);

  // ────────────────────────────────────────────
  // Phase 3: Multi-rule combination for critical threat
  // Rapid burst + high value + withdrawal selectors
  // TX_BURST(30) + ANOMALOUS_VALUE(35) + LARGE_WITHDRAWAL(20) = 85
  // Score 85 > emergency threshold (80) → emergency withdraw
  // ────────────────────────────────────────────
  console.log("─── Phase 3: Critical threat (multi-rule) ───");
  console.log("  Rapid withdraw() calls with high value");
  console.log(
    "  Expected: TX_BURST(30) + ANOMALOUS_VALUE(35) + LARGE_WITHDRAWAL(20) = 85"
  );
  console.log("  → Should trigger LLM + emergency withdrawal!\n");

  // Send some ETH to the dummy first so withdraw has balance
  try {
    const fundTx = await attacker.sendTransaction({
      to: dummyAddr,
      value: ethers.parseEther("20"),
    });
    await fundTx.wait();
    console.log("  Funded DummyDeFi with 20 PAS for withdrawals");
  } catch (error) {
    console.log(
      "  Funding failed:",
      (error as Error).message.slice(0, 80)
    );
  }

  // Rapid withdraw calls
  for (let i = 0; i < 6; i++) {
    try {
      const tx = await dummy.withdraw(ethers.parseEther("3"));
      console.log(`  withdraw() ${i + 1}/6 sent: ${tx.hash.slice(0, 18)}...`);
      await tx.wait();
    } catch (error) {
      console.log(
        `  withdraw() ${i + 1}/6 failed:`,
        (error as Error).message.slice(0, 80)
      );
    }
  }

  console.log("\n  Waiting 25s for agent to detect + execute emergency...\n");
  await sleep(25000);

  // ────────────────────────────────────────────
  // Summary
  // ────────────────────────────────────────────
  const finalBalance = await provider.getBalance(attacker.address);
  console.log("╔═══════════════════════════════════════════════════╗");
  console.log("║             Simulation Complete                    ║");
  console.log("╚═══════════════════════════════════════════════════╝");
  console.log(`  DummyDeFi:  ${dummyAddr}`);
  console.log(
    `  Attacker balance: ${ethers.formatEther(finalBalance)} PAS`
  );
  console.log("\n  Check agent logs for:");
  console.log("  • Phase 1: score ~65 → LLM analysis triggered");
  console.log("  • Phase 2: score ~70 → LLM + Registry report");
  console.log("  • Phase 3: score ~85 → Emergency withdrawal executed");
  console.log("  • Frontend: /registry shows on-chain threat reports");
}

main().catch(console.error);
