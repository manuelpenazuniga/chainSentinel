// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/SentinelVault.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 for invariant testing
contract InvariantMockToken is ERC20 {
    constructor() ERC20("Invariant Mock", "IMOCK") {
        _mint(msg.sender, 10_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title VaultHandler
/// @notice Constrains Foundry's fuzzer to valid SentinelVault interactions.
///         Tracks ghost variables that mirror expected contract state so
///         invariant assertions can compare actual vs expected.
contract VaultHandler is Test {
    SentinelVault public vault;
    InvariantMockToken public token;

    address public owner;
    address public guardian;
    address public safeAddr;

    // ─── Ghost variables ────────────────────────────────────────────────────
    // These track what we EXPECT the contract state to be, so invariant
    // tests can compare ghost state against actual contract state.

    uint256 public ghost_nativeDeposited;
    uint256 public ghost_nativeWithdrawnByOwner;
    uint256 public ghost_nativeEmergencyWithdrawn;

    uint256 public ghost_tokenDeposited;
    uint256 public ghost_tokenWithdrawnByOwner;
    uint256 public ghost_tokenEmergencyWithdrawn;

    uint256 public ghost_emergencyCount;
    uint256 public ghost_depositCount;

    // Tracks total sent to safeAddress via emergency withdraw
    uint256 public ghost_nativeToSafe;
    uint256 public ghost_tokenToSafe;

    // Tracks total sent to guardian (should ALWAYS be zero)
    uint256 public ghost_nativeToGuardian;
    uint256 public ghost_tokenToGuardian;

    constructor(SentinelVault _vault, InvariantMockToken _token, address _owner, address _guardian, address _safeAddr) {
        vault = _vault;
        token = _token;
        owner = _owner;
        guardian = _guardian;
        safeAddr = _safeAddr;
    }

    // ─── Owner actions ──────────────────────────────────────────────────────

    function depositNative(uint256 amount) external {
        amount = bound(amount, 1, 10 ether);
        vm.deal(owner, amount);
        vm.prank(owner);
        vault.depositNative{value: amount}();
        ghost_nativeDeposited += amount;
        ghost_depositCount++;
    }

    function depositToken(uint256 amount) external {
        amount = bound(amount, 1, 1_000_000 ether);
        token.mint(owner, amount);
        vm.startPrank(owner);
        token.approve(address(vault), amount);
        vault.deposit(address(token), amount);
        vm.stopPrank();
        ghost_tokenDeposited += amount;
        ghost_depositCount++;
    }

    function withdrawNative(uint256 amount) external {
        uint256 bal = vault.getBalance(address(0));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(owner);
        vault.withdraw(address(0), amount);
        ghost_nativeWithdrawnByOwner += amount;
    }

    function withdrawToken(uint256 amount) external {
        uint256 bal = vault.getBalance(address(token));
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(owner);
        vault.withdraw(address(token), amount);
        ghost_tokenWithdrawnByOwner += amount;
    }

    function setThreshold(uint256 t) external {
        t = bound(t, 1, 100);
        vm.prank(owner);
        vault.setThreshold(t);
    }

    // ─── Guardian actions ───────────────────────────────────────────────────

    function emergencyWithdrawNative(uint256 threatScore) external {
        uint256 bal = vault.getBalance(address(0));
        if (bal == 0) return;
        threatScore = bound(threatScore, vault.threshold(), 100);

        // Skip cooldown
        vm.roll(block.number + vault.cooldownBlocks() + 1);

        uint256 guardianBefore = guardian.balance;
        uint256 safeBefore = safeAddr.balance;

        vm.prank(guardian);
        vault.emergencyWithdraw(address(0), threatScore, "invariant test");

        ghost_nativeEmergencyWithdrawn += bal;
        ghost_nativeToSafe += (safeAddr.balance - safeBefore);
        ghost_nativeToGuardian += (guardian.balance - guardianBefore);
        ghost_emergencyCount++;
    }

    function emergencyWithdrawToken(uint256 threatScore) external {
        uint256 bal = vault.getBalance(address(token));
        if (bal == 0) return;
        threatScore = bound(threatScore, vault.threshold(), 100);

        // Skip cooldown
        vm.roll(block.number + vault.cooldownBlocks() + 1);

        uint256 guardianBefore = token.balanceOf(guardian);
        uint256 safeBefore = token.balanceOf(safeAddr);

        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), threatScore, "invariant test");

        ghost_tokenEmergencyWithdrawn += bal;
        ghost_tokenToSafe += (token.balanceOf(safeAddr) - safeBefore);
        ghost_tokenToGuardian += (token.balanceOf(guardian) - guardianBefore);
        ghost_emergencyCount++;
    }

    function emergencyWithdrawAll(uint256 threatScore) external {
        uint256 nBal = vault.getBalance(address(0));
        uint256 tBal = vault.getBalance(address(token));
        if (nBal == 0 && tBal == 0) return;
        threatScore = bound(threatScore, vault.threshold(), 100);

        vm.roll(block.number + vault.cooldownBlocks() + 1);

        uint256 guardianNBefore = guardian.balance;
        uint256 safeNBefore = safeAddr.balance;
        uint256 guardianTBefore = token.balanceOf(guardian);
        uint256 safeTBefore = token.balanceOf(safeAddr);

        vm.prank(guardian);
        vault.emergencyWithdrawAll(threatScore, "invariant withdraw all");

        ghost_nativeEmergencyWithdrawn += nBal;
        ghost_tokenEmergencyWithdrawn += tBal;
        ghost_nativeToSafe += (safeAddr.balance - safeNBefore);
        ghost_nativeToGuardian += (guardian.balance - guardianNBefore);
        ghost_tokenToSafe += (token.balanceOf(safeAddr) - safeTBefore);
        ghost_tokenToGuardian += (token.balanceOf(guardian) - guardianTBefore);
        ghost_emergencyCount++;
    }
}
