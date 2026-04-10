#!/usr/bin/env bash
# =============================================================================
# ChainSentinel — PVM Parallel Deployment Script
# =============================================================================
#
# Compiles SentinelVaultPVM.sol and SentinelRegistryPVM.sol with `resolc`
# (the Parity Solidity → PolkaVM compiler) and deploys both contracts to
# Polkadot Hub Testnet (Paseo).
#
# This produces a second set of on-chain addresses alongside the REVM
# deployments, demonstrating ChainSentinel running on BOTH execution
# environments supported by Polkadot Hub.
#
# Prerequisites:
#   1. resolc installed (see "Installing resolc" below)
#   2. cast (Foundry) installed: curl -L https://foundry.paradigm.xyz | bash
#   3. .env sourced with DEPLOYER_PRIVATE_KEY, SAFE_ADDRESS, RPC_URL
#
# Usage:
#   set -a && source .env && set +a
#   bash scripts/deploy-pvm.sh
#
# Installing resolc:
#   Option A — Pre-built binary (fastest):
#     curl -L https://github.com/paritytech/revive/releases/latest/download/resolc-x86_64-apple-darwin \
#       -o /usr/local/bin/resolc && chmod +x /usr/local/bin/resolc
#
#   Option B — Build from source (requires Rust + LLVM):
#     git clone https://github.com/paritytech/revive
#     cd revive && cargo build --release
#     cp target/release/resolc /usr/local/bin/resolc
#
#   Verify: resolc --version
#
# Output:
#   contracts/out/pvm/
#   ├── SentinelVaultPVM.abi      — ABI (identical to REVM version)
#   ├── SentinelVaultPVM.bin      — PVM bytecode
#   ├── SentinelRegistryPVM.abi   — ABI (identical to REVM version)
#   └── SentinelRegistryPVM.bin   — PVM bytecode
# =============================================================================

set -euo pipefail

# ─── Colours ─────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${BLUE}[pvm]${RESET} $*"; }
success() { echo -e "${GREEN}[pvm]${RESET} $*"; }
warn()    { echo -e "${YELLOW}[pvm]${RESET} $*"; }
error()   { echo -e "${RED}[pvm] ERROR:${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# ─── Paths ───────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PVM_SRC="$PROJECT_ROOT/contracts/pvm"
PVM_OUT="$PROJECT_ROOT/contracts/out/pvm"

# ─── Environment Validation ───────────────────────────────────────────────────

header "════ ChainSentinel PVM Deployment ════"
info "Project root: $PROJECT_ROOT"

# Required env vars
: "${DEPLOYER_PRIVATE_KEY:?'DEPLOYER_PRIVATE_KEY is not set. Source your .env file.'}"
: "${RPC_URL:?'RPC_URL is not set. Source your .env file.'}"

# Optional with defaults
SAFE_ADDRESS="${SAFE_ADDRESS:-}"
THRESHOLD="${DEFAULT_EMERGENCY_THRESHOLD:-80}"

# ─── Tool Checks ─────────────────────────────────────────────────────────────

header "1. Checking required tools"

if ! command -v resolc &> /dev/null; then
  error "'resolc' not found. Install it with:"
  echo ""
  echo "  # macOS / Linux (pre-built binary):"
  echo "  curl -L https://github.com/paritytech/revive/releases/latest/download/resolc-x86_64-apple-darwin \\"
  echo "    -o /usr/local/bin/resolc && chmod +x /usr/local/bin/resolc"
  echo ""
  echo "  # Verify:"
  echo "  resolc --version"
  exit 1
fi

RESOLC_VERSION=$(resolc --version 2>&1 | head -1)
success "resolc found: $RESOLC_VERSION"

if ! command -v cast &> /dev/null; then
  error "'cast' not found. Install Foundry: curl -L https://foundry.paradigm.xyz | bash"
  exit 1
fi

CAST_VERSION=$(cast --version 2>&1 | head -1)
success "cast found: $CAST_VERSION"

# ─── Deployer Info ───────────────────────────────────────────────────────────

DEPLOYER_ADDRESS=$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
info "Deployer address: $DEPLOYER_ADDRESS"

DEPLOYER_BALANCE=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL" --ether 2>/dev/null || echo "unknown")
info "Deployer balance: $DEPLOYER_BALANCE PAS"

# ─── Compilation ─────────────────────────────────────────────────────────────

header "2. Compiling with resolc (PolkaVM target)"

mkdir -p "$PVM_OUT"

# Compile SentinelRegistryPVM
# No external imports — simplest case, used to validate resolc setup.
info "Compiling SentinelRegistryPVM.sol..."
resolc "$PVM_SRC/SentinelRegistryPVM.sol" \
  --abi \
  --bin \
  --output-dir "$PVM_OUT" \
  --overwrite \
  2>&1 | while IFS= read -r line; do warn "  resolc: $line"; done

if [[ ! -f "$PVM_OUT/SentinelRegistryPVM.bin" ]]; then
  error "Compilation of SentinelRegistryPVM.sol failed. Check resolc output above."
  exit 1
fi
success "SentinelRegistryPVM.sol compiled → $(wc -c < "$PVM_OUT/SentinelRegistryPVM.bin") bytes"

# Compile SentinelVaultPVM
# Self-contained (no imports) — inline IERC20, inline ReentrancyGuard.
info "Compiling SentinelVaultPVM.sol..."
resolc "$PVM_SRC/SentinelVaultPVM.sol" \
  --abi \
  --bin \
  --output-dir "$PVM_OUT" \
  --overwrite \
  2>&1 | while IFS= read -r line; do warn "  resolc: $line"; done

if [[ ! -f "$PVM_OUT/SentinelVaultPVM.bin" ]]; then
  error "Compilation of SentinelVaultPVM.sol failed. Check resolc output above."
  exit 1
fi
success "SentinelVaultPVM.sol compiled → $(wc -c < "$PVM_OUT/SentinelVaultPVM.bin") bytes"

# ─── ABI Diff Sanity Check ────────────────────────────────────────────────────
# The PVM ABI must be functionally equivalent to the REVM ABI.
# A mismatch would mean the frontend/agent couldn't interact with the PVM contract.

header "3. ABI sanity check"

REVM_VAULT_ABI="$PROJECT_ROOT/contracts/out/SentinelVault.sol/SentinelVault.json"
PVM_VAULT_ABI="$PVM_OUT/SentinelVaultPVM.abi"

if [[ -f "$REVM_VAULT_ABI" ]] && command -v jq &> /dev/null; then
  # Extract function selectors from both ABIs and compare
  REVM_FUNCS=$(jq -r '.abi[] | select(.type=="function") | .name' "$REVM_VAULT_ABI" 2>/dev/null | sort || true)
  PVM_FUNCS=$(jq -r '.[] | select(.type=="function") | .name' "$PVM_VAULT_ABI" 2>/dev/null | sort || true)
  if [[ "$REVM_FUNCS" == "$PVM_FUNCS" ]]; then
    success "ABI function names match between REVM and PVM versions ✓"
  else
    warn "ABI function names differ — this may indicate a version skew."
    warn "REVM: $REVM_FUNCS"
    warn "PVM:  $PVM_FUNCS"
  fi
else
  info "Skipping ABI diff (jq not found or REVM artifact missing — run 'forge build' first)"
fi

# ─── Deployment ───────────────────────────────────────────────────────────────

header "4. Deploying to Polkadot Hub Testnet (PVM)"

# Resolve constructor arguments
VAULT_SAFE="${SAFE_ADDRESS:-$DEPLOYER_ADDRESS}"
info "SentinelVaultPVM constructor: safeAddress=$VAULT_SAFE, threshold=$THRESHOLD"

# Encode constructor args
VAULT_INIT=$(cast abi-encode "constructor(address,uint256)" "$VAULT_SAFE" "$THRESHOLD")
VAULT_BYTECODE=$(cat "$PVM_OUT/SentinelVaultPVM.bin")

# Deploy SentinelRegistryPVM
info "Deploying SentinelRegistryPVM..."
REGISTRY_BYTECODE=$(cat "$PVM_OUT/SentinelRegistryPVM.bin")
REGISTRY_TX=$(cast send \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --rpc-url "$RPC_URL" \
  --create "$REGISTRY_BYTECODE" \
  --json 2>&1) || { error "SentinelRegistryPVM deploy failed:\n$REGISTRY_TX"; exit 1; }

REGISTRY_PVM_ADDRESS=$(echo "$REGISTRY_TX" | jq -r '.contractAddress // .creates')
REGISTRY_TX_HASH=$(echo "$REGISTRY_TX" | jq -r '.transactionHash')
success "SentinelRegistryPVM deployed:"
success "  address: $REGISTRY_PVM_ADDRESS"
success "  tx:      $REGISTRY_TX_HASH"

# Deploy SentinelVaultPVM
info "Deploying SentinelVaultPVM..."
VAULT_TX=$(cast send \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  --rpc-url "$RPC_URL" \
  --create "${VAULT_BYTECODE}${VAULT_INIT:2}" \
  --json 2>&1) || { error "SentinelVaultPVM deploy failed:\n$VAULT_TX"; exit 1; }

VAULT_PVM_ADDRESS=$(echo "$VAULT_TX" | jq -r '.contractAddress // .creates')
VAULT_TX_HASH=$(echo "$VAULT_TX" | jq -r '.transactionHash')
success "SentinelVaultPVM deployed:"
success "  address: $VAULT_PVM_ADDRESS"
success "  tx:      $VAULT_TX_HASH"

# ─── Post-deploy: Authorize Agent ─────────────────────────────────────────────

if [[ -n "${AGENT_ADDRESS:-}" ]]; then
  header "5. Configuring guardian"
  info "Authorizing agent $AGENT_ADDRESS as guardian on PVM vault..."
  cast send "$VAULT_PVM_ADDRESS" \
    "setGuardian(address)" "$AGENT_ADDRESS" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --json > /dev/null && success "Guardian set ✓" || warn "setGuardian failed — set manually"

  info "Authorizing agent $AGENT_ADDRESS as reporter on PVM registry..."
  cast send "$REGISTRY_PVM_ADDRESS" \
    "addReporter(address)" "$AGENT_ADDRESS" \
    --private-key "$DEPLOYER_PRIVATE_KEY" \
    --rpc-url "$RPC_URL" \
    --json > /dev/null && success "Reporter authorized ✓" || warn "addReporter failed — set manually"
else
  warn "AGENT_ADDRESS not set — skipping guardian/reporter setup."
  warn "Run manually:"
  warn "  cast send $VAULT_PVM_ADDRESS 'setGuardian(address)' <AGENT_ADDRESS> --private-key \$DEPLOYER_PRIVATE_KEY --rpc-url \$RPC_URL"
  warn "  cast send $REGISTRY_PVM_ADDRESS 'addReporter(address)' <AGENT_ADDRESS> --private-key \$DEPLOYER_PRIVATE_KEY --rpc-url \$RPC_URL"
fi

# ─── Summary ──────────────────────────────────────────────────────────────────

header "════ Deployment Summary ════"
echo ""
echo -e "  ${BOLD}VM Target:${RESET}          PolkaVM (PVM) via resolc"
echo -e "  ${BOLD}Network:${RESET}            Polkadot Hub Testnet (Paseo)"
echo -e "  ${BOLD}RPC:${RESET}                $RPC_URL"
echo ""
echo -e "  ${BOLD}SentinelVaultPVM:${RESET}   $VAULT_PVM_ADDRESS"
echo -e "  ${BOLD}SentinelRegistryPVM:${RESET} $REGISTRY_PVM_ADDRESS"
echo ""
echo "  Add to .env for agent PVM mode:"
echo "    VAULT_ADDRESS_PVM=$VAULT_PVM_ADDRESS"
echo "    REGISTRY_ADDRESS_PVM=$REGISTRY_PVM_ADDRESS"
echo ""
success "PVM deployment complete. ChainSentinel now runs on BOTH execution environments."
echo ""
