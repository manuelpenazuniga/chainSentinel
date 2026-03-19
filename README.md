<image src="/img/logo_cS.jpg" alt="chainSentinel">

# ChainSentinel

**Autonomous AI Security Agent for DeFi on Polkadot Hub**

ChainSentinel monitors transactions in real time on Polkadot Hub, detects exploit patterns (flash loans, drains, reentrancy, price manipulation), and automatically rescues user funds before an attack materializes.

> Built for the [Polkadot Solidity Hackathon 2026](https://dorahacks.io/hackathon/polkadot-solidity-hackathon/detail) — EVM Smart Contracts / AI-Powered dApps Track

## The Problem

Billions of dollars are lost every year to DeFi exploits. Polkadot Hub launched permissionless smart contracts on January 27, 2026, and its DeFi ecosystem is growing fast. Yet there is **no real-time security monitoring infrastructure** available today:

- Forta, Hypernative, and BlockSec operate on Ethereum and other EVM chains but do not support Polkadot Hub
- PAL (Polkadot Assurance Legion) funds audits but provides no live monitoring
- Smart contracts on Polkadot Hub are weeks old, meaning the ecosystem needs proactive protection from day one

## How It Works

ChainSentinel operates as a guardian that users assign to their vault. The agent watches every block, scores threats using a dual-layer detection engine, and triggers emergency withdrawals when a real threat is identified. Funds always go to the user's own safe address, never to the agent.


<image src="/img/diagram_cs.png" alt="How It Works chainSentinel">


### Threat Detection Engine

**Layer 1 (Heuristics):** Fast, deterministic rules that flag anomalies:

- Anomalous transaction value (>10x historical average)
- Freshly deployed contracts (<24h old)
- Transaction bursts from same sender
- Flash loan function signatures
- Drastic balance drops (>30% in one block)
- Blacklisted address interaction
- Unknown high-value senders

**Layer 2 (LLM Analysis):** Only triggered for pre-filtered transactions. Claude API analyzes full context, identifies attack patterns, assigns a confidence-weighted threat score, and explains its reasoning in structured output.

**Final score:** `(heuristic × 0.4) + (LLM × 0.6)`, adjusted by LLM confidence.

### False Positive Mitigation

- User-configurable threshold (default: 80/100 for auto-action)
- Cooldown period between emergency withdrawals (10 blocks)
- Contract whitelist for trusted protocols
- Heuristic-only fallback if LLM API is unavailable (with higher threshold)

## Architecture

```
┌──────────────────────────────────────────────┐
│           Presentation Layer                  │
│  Next.js Dashboard  |  Telegram/Discord Bot   │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│           Intelligence Layer                  │
│  Monitor → Analyzer → Executor → Alerter      │
│                                               │
│  Polkadot Agent Kit + LangChain ReAct Agent   │
│  Claude API for threat analysis               │
└──────────────┬───────────────────────────────┘
               │
┌──────────────▼───────────────────────────────┐
│           On-Chain Layer (Solidity / REVM)     │
│  SentinelVault.sol    SentinelRegistry.sol    │
│  Polkadot Hub Testnet (Paseo)                 │
└───────────────────────────────────────────────┘
```

## Smart Contracts

### SentinelVault.sol

The vault holds user funds and implements the guardian pattern:

- **Owner** deposits, withdraws, and configures protection parameters
- **Guardian** (AI agent address) can only execute `emergencyWithdraw`, sending funds exclusively to the owner's pre-set safe address
- Cooldown mechanism prevents repeated emergency actions
- ReentrancyGuard from OpenZeppelin protects all state-changing functions
- Supports both native DOT and ERC-20 tokens

### SentinelRegistry.sol

A public, community-driven threat registry:

- Any guardian can report threats with score, attack type, and evidence
- Aggregate scores computed across multiple reports per contract
- Auto-blacklist when aggregate score exceeds threshold
- Queryable by any agent or dApp in the ecosystem

## Tech Stack

|Layer|Technology|
|---|---|
|Smart Contracts|Solidity ^0.8.20, Foundry, OpenZeppelin v5, REVM on Polkadot Hub|
|AI Agent|Node.js/TypeScript, LangChain.js, Polkadot Agent Kit, ethers.js v6|
|LLM|Claude API (claude-sonnet-4-20250514)|
|Frontend|Next.js 16, TailwindCSS v4, Recharts, wagmi v3 + viem|
|Notifications|Telegram Bot API, Discord Webhooks|
|Testnet|Paseo Hub (Chain ID: 420420417)|

## Project Structure

```
chainsentinel/
├── contracts/                  # Solidity smart contracts (Foundry)
│   ├── src/
│   │   ├── SentinelVault.sol       # Protected vault with guardian pattern
│   │   ├── SentinelRegistry.sol    # Community threat registry
│   │   └── MockERC20.sol           # Test token for multi-token demos
│   ├── test/                       # 48 Foundry tests
│   └── script/                     # Deployment scripts
├── agent/                      # AI Agent (TypeScript)
│   ├── src/
│   │   ├── index.ts                # Entry point & orchestrator
│   │   ├── monitor.ts              # WebSocket block listener
│   │   ├── analyzer.ts             # Dual-layer threat scoring
│   │   ├── executor.ts             # On-chain emergency actions
│   │   ├── alerter.ts              # Telegram notifications
│   │   ├── context.ts              # Local state manager
│   │   ├── heuristics.ts           # 8 heuristic rule definitions
│   │   ├── llm.ts                  # Claude API integration
│   │   ├── agentkit.ts             # Polkadot Agent Kit wrapper
│   │   └── types.ts                # Shared interfaces
│   └── test/                       # 9 agent tests (Vitest)
├── frontend/                   # Next.js 16 Dashboard
│   ├── app/                        # 3 pages (dashboard, protect, registry)
│   ├── components/                 # 9 components (charts, forms, feeds)
│   └── lib/                        # Chain config, ABIs, wagmi setup
├── scripts/
│   └── simulate-attack.ts         # Attack simulator for demos
└── .env.example                    # Environment variable template
```

## Getting Started

### Prerequisites

- Node.js v22+
- Foundry (forge, cast, anvil)
- MetaMask configured for Paseo Hub testnet
- Anthropic API key (for Claude LLM analysis)

### Setup

```bash
# Clone the repository
git clone https://github.com/manuelpenazuniga/chainSentinel.git
cd chainSentinel

# Install contract dependencies and run tests
cd contracts && forge install && forge test

# Configure environment
cd .. && cp .env.example .env
# Edit .env with your private keys, API key, and contract addresses

# Deploy contracts to Paseo Hub testnet
cd contracts
forge script script/DeployVault.s.sol --rpc-url https://services.polkadothub-rpc.com/testnet --broadcast -vvv
forge script script/DeployRegistry.s.sol --rpc-url https://services.polkadothub-rpc.com/testnet --broadcast -vvv

# Set up the guardian (AI agent) on the vault
cast send $VAULT_ADDRESS "setGuardian(address)" $AGENT_ADDRESS \
  --rpc-url https://services.polkadothub-rpc.com/testnet \
  --private-key $DEPLOYER_PRIVATE_KEY

# Install and start the AI agent
cd ../agent && npm install && npm run start

# Install and start the dashboard
cd ../frontend && npm install && npm run dev
```

### Testnet Configuration (MetaMask)

| Field | Value |
|---|---|
| Network Name | Polkadot Hub TestNet |
| RPC URL | `https://services.polkadothub-rpc.com/testnet` |
| Chain ID | 420420417 |
| Currency Symbol | PAS |
| Block Explorer | `https://blockscout-passet-hub.parity-testnet.parity.io` |

Get testnet PAS from [faucet.polkadot.io](https://faucet.polkadot.io/) — select **"Hub (smart contracts)"** as the chain.

## Testing

```bash
# Smart contract tests (48 tests)
cd contracts && forge test -v

# AI agent tests (9 tests)
cd agent && npx vitest run

# Agent type-check
cd agent && npx tsc --noEmit

# Frontend build verification
cd frontend && npm run build
```

## Demo

ChainSentinel includes a built-in attack simulation script for demonstrating the full protection flow:

```bash
# Terminal 1: Start the AI agent
cd agent && npm run start

# Terminal 2: Run the attack simulator
npx tsx scripts/simulate-attack.ts

# Terminal 3: Watch the dashboard
cd frontend && npm run dev
# Open http://localhost:3000
```

The simulator sends suspicious transactions that trigger the agent's threat detection. When the score exceeds the threshold (default: 80), the agent automatically executes an emergency withdrawal, moving funds to the owner's safe address before the simulated attack can complete.

## Why Polkadot Hub

Polkadot Hub is a unified chain that brings permissionless smart contract deployment to Polkadot with full EVM compatibility. This means familiar Solidity tooling (Foundry, Hardhat, MetaMask) works out of the box, while developers get access to Polkadot's shared security, native DOT integration, and cross-chain messaging via XCM.

ChainSentinel is built specifically for this ecosystem because security tooling should be available from day one, not retrofitted after the first major exploit.

## Roadmap

- [x]  Dual-layer threat detection engine (heuristics + Claude LLM)
- [x]  SentinelVault with guardian pattern (native + ERC-20)
- [x]  SentinelRegistry for community threat data
- [x]  Real-time dashboard with threat feed and protection score
- [x]  Telegram alert notifications
- [x]  Attack simulation script for demos
- [ ]  Insurance pool for community-funded coverage
- [ ]  XCM integration for cross-chain monitoring
- [ ]  Additional detection patterns (governance attacks, MEV)
- [ ]  PAL integration for ecosystem-wide protection


## License

MIT

## Acknowledgments

Built during the Polkadot Solidity Hackathon 2026, organized by [OpenGuild](https://openguild.wtf) in partnership with [Web3 Foundation](https://web3.foundation).

Powered by [Polkadot Agent Kit](https://github.com/elasticlabs-org/polkadot-agent-kit)
