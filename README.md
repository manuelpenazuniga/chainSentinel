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
|Frontend|Next.js 14, TailwindCSS, Recharts, wagmi + viem|
|Notifications|Telegram Bot API, Discord Webhooks|
|Testnet|Paseo Hub (Chain ID: 420420417)|

## Project Structure

```
chainsentinel/
├── contracts/
│   ├── src/
│   │   ├── SentinelVault.sol
│   │   └── SentinelRegistry.sol
│   ├── test/
│   └── script/
├── agent/
│   └── src/
│       ├── index.ts          # Orchestrator
│       ├── monitor.ts        # WebSocket block listener
│       ├── analyzer.ts       # Dual-layer threat scoring
│       ├── executor.ts       # On-chain emergency actions
│       ├── alerter.ts        # Notification dispatch
│       ├── context.ts        # Local state manager
│       ├── heuristics.ts     # Rule definitions
│       ├── llm.ts            # Claude API integration
│       └── agentkit.ts       # Polkadot Agent Kit wrapper
├── frontend/
│   ├── app/
│   └── components/
├── scripts/
│   └── simulate-attack.ts    # Attack simulator for demos
└── docs/
```

<!--
## Getting Started

### Prerequisites

- Node.js v22+
- Foundry (forge, cast, anvil)
- MetaMask configured for Paseo Hub testnet
- Anthropic API key

### Setup

bash

```bash
# Clone the repository
git clone https://github.com/<your-username>/chainsentinel.git
cd chainsentinel

# Install contract dependencies
cd contracts && forge install

# Deploy to Paseo testnet
forge script script/DeployVault.s.sol --rpc-url https://services.polkadothub-rpc.com/testnet --broadcast

# Install agent dependencies
cd ../agent && npm install

# Configure environment
cp .env.example .env
# Edit .env with your keys

# Start the agent
npm run start

# Start the dashboard
cd ../frontend && npm install && npm run dev
```
-->

## Why Polkadot Hub

Polkadot Hub is a unified chain that brings permissionless smart contract deployment to Polkadot with full EVM compatibility. This means familiar Solidity tooling (Foundry, Hardhat, MetaMask) works out of the box, while developers get access to Polkadot's shared security, native DOT integration, and cross-chain messaging via XCM.

ChainSentinel is built specifically for this ecosystem because security tooling should be available from day one, not retrofitted after the first major exploit.

## Roadmap

- [ ]  Dual-layer threat detection engine
- [ ]  SentinelVault with guardian pattern
- [ ]  SentinelRegistry for community threat data
- [ ]  Real-time dashboard with threat feed
- [ ]  Insurance pool for community-funded coverage
- [ ]  XCM integration for cross-chain monitoring
- [ ]  Additional detection patterns (governance attacks, MEV)
- [ ]  PAL integration for ecosystem-wide protection


## License

MIT

## Acknowledgments

Built during the Polkadot Solidity Hackathon 2026, organized by [OpenGuild](https://openguild.wtf) in partnership with [Web3 Foundation](https://web3.foundation).

Powered by [Polkadot Agent Kit](https://github.com/elasticlabs-org/polkadot-agent-kit)
