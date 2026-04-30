// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/SentinelVault.sol";
import "./VaultHandler.sol";

/// @title SentinelVault Invariant Tests
/// @notice Verifies security properties that must hold after ANY sequence of
///         valid operations on the vault. Foundry's fuzzer calls random
///         handler functions with random args — if any invariant breaks,
///         the fuzzer reports the exact call sequence that caused it.
///
/// Key invariants tested:
///   1. Guardian NEVER receives funds (core security guarantee)
///   2. Vault balance bookkeeping is always consistent with real balances
///   3. Deposits minus withdrawals equals current vault balance
///   4. Emergency withdrawals always go to safeAddress
///   5. Threshold stays within [1, 100]
///   6. Owner address never changes
contract SentinelVaultInvariantTest is Test {
    SentinelVault public vault;
    InvariantMockToken public token;
    VaultHandler public handler;

    address public owner;
    address public guardian = makeAddr("guardian");
    address public safeAddr = makeAddr("safe");

    function setUp() public {
        vm.roll(100);

        owner = address(this);
        vault = new SentinelVault(safeAddr, 80);
        token = new InvariantMockToken();

        vault.setGuardian(guardian);

        handler = new VaultHandler(vault, token, owner, guardian, safeAddr);

        // Tell Foundry to only call functions on the handler
        targetContract(address(handler));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 1 — GUARDIAN NEVER RECEIVES FUNDS
    // This is THE core security guarantee of ChainSentinel.
    // The guardian (AI agent) can trigger emergency withdrawals, but funds
    // ALWAYS go to safeAddress. Even if the agent's private key is
    // compromised, the attacker cannot redirect funds to themselves.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_guardianNeverReceivesNativeTokens() public view {
        assertEq(
            handler.ghost_nativeToGuardian(),
            0,
            "CRITICAL: Guardian received native tokens - security invariant broken"
        );
    }

    function invariant_guardianNeverReceivesERC20Tokens() public view {
        assertEq(
            handler.ghost_tokenToGuardian(),
            0,
            "CRITICAL: Guardian received ERC20 tokens - security invariant broken"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 2 — BALANCE BOOKKEEPING CONSISTENCY
    // The vault's internal `balances` mapping must always match the actual
    // token balances held by the contract. A mismatch means funds are
    // locked or phantom balances exist.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_nativeBalanceMatchesActual() public view {
        assertEq(
            vault.getBalance(address(0)),
            address(vault).balance,
            "Native balance accounting mismatch"
        );
    }

    function invariant_tokenBalanceMatchesActual() public view {
        assertEq(
            vault.getBalance(address(token)),
            token.balanceOf(address(vault)),
            "ERC20 balance accounting mismatch"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 3 — CONSERVATION OF FUNDS
    // Total deposited = total withdrawn (by owner) + total emergency
    // withdrawn + current vault balance. No tokens created or destroyed.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_nativeConservation() public view {
        uint256 expected = handler.ghost_nativeDeposited()
            - handler.ghost_nativeWithdrawnByOwner()
            - handler.ghost_nativeEmergencyWithdrawn();
        assertEq(
            vault.getBalance(address(0)),
            expected,
            "Native token conservation violated"
        );
    }

    function invariant_tokenConservation() public view {
        uint256 expected = handler.ghost_tokenDeposited()
            - handler.ghost_tokenWithdrawnByOwner()
            - handler.ghost_tokenEmergencyWithdrawn();
        assertEq(
            vault.getBalance(address(token)),
            expected,
            "ERC20 token conservation violated"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 4 — EMERGENCY FUNDS GO TO SAFE ADDRESS
    // Every token moved via emergency withdraw must arrive at safeAddress.
    // Combined with invariant 1, this proves funds can only flow to the
    // owner's chosen safe address.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_emergencyNativeGoesToSafe() public view {
        assertEq(
            handler.ghost_nativeToSafe(),
            handler.ghost_nativeEmergencyWithdrawn(),
            "Emergency native tokens did not all reach safeAddress"
        );
    }

    function invariant_emergencyTokensGoToSafe() public view {
        assertEq(
            handler.ghost_tokenToSafe(),
            handler.ghost_tokenEmergencyWithdrawn(),
            "Emergency ERC20 tokens did not all reach safeAddress"
        );
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 5 — THRESHOLD BOUNDS
    // The threshold must always be in [1, 100]. A threshold of 0 would
    // allow any score to trigger emergency withdrawal. A threshold > 100
    // would make emergency withdrawal impossible.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_thresholdBounds() public view {
        uint256 t = vault.threshold();
        assertTrue(t >= 1 && t <= 100, "Threshold out of bounds [1, 100]");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 6 — OWNER IMMUTABILITY
    // SentinelVault has no transferOwnership function. The owner set in
    // the constructor must never change.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_ownerNeverChanges() public view {
        assertEq(vault.owner(), owner, "Owner changed - should be immutable");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 7 — SAFE ADDRESS NEVER ZERO
    // Constructor prevents zero safeAddress (defaults to msg.sender).
    // setSafeAddress reverts on zero. So safeAddress is always non-zero.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_safeAddressNeverZero() public view {
        assertTrue(vault.safeAddress() != address(0), "safeAddress is zero - funds would be burned");
    }

    // Allow this test contract to receive ETH
    receive() external payable {}
}
