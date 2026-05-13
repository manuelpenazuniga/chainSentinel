// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SentinelVault.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Mock ERC20 token for testing
contract MockToken is ERC20 {
    constructor() ERC20("Mock Token", "MOCK") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SentinelVaultTest is Test {
    SentinelVault public vault;
    MockToken public token;

    address public owner = address(this);
    address public guardian = makeAddr("guardian");
    address public safeAddr = makeAddr("safe");
    address public attacker = makeAddr("attacker");

    // Re-declare events for expectEmit
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event GuardianSet(address indexed guardian);
    event EmergencyWithdrawExecuted(
        address indexed guardian, address indexed token, uint256 amount, uint256 threatScore, string reason
    );
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    function setUp() public {
        // Start at block 100 to avoid cooldown issues with lastEmergencyBlock=0
        vm.roll(100);

        vault = new SentinelVault(safeAddr, 80);
        token = new MockToken();

        // Approve vault to spend owner's tokens
        token.approve(address(vault), type(uint256).max);
    }

    // ─── Constructor Tests ───

    function test_constructor_setsOwner() public view {
        assertEq(vault.owner(), owner);
    }

    function test_constructor_setsSafeAddress() public view {
        assertEq(vault.safeAddress(), safeAddr);
    }

    function test_constructor_setsThreshold() public view {
        assertEq(vault.threshold(), 80);
    }

    function test_constructor_defaultSafeAddress() public {
        SentinelVault v = new SentinelVault(address(0), 80);
        assertEq(v.safeAddress(), address(this));
    }

    function test_constructor_defaultThreshold() public {
        SentinelVault v = new SentinelVault(safeAddr, 0);
        assertEq(v.threshold(), 80);
    }

    function test_constructor_invalidThreshold_defaults() public {
        SentinelVault v = new SentinelVault(safeAddr, 101);
        assertEq(v.threshold(), 80);
    }

    // ─── Deposit Tests ───

    function test_deposit_erc20() public {
        vault.deposit(address(token), 100 ether);
        assertEq(vault.getBalance(address(token)), 100 ether);
    }

    function test_deposit_erc20_addsToTokenList() public {
        vault.deposit(address(token), 100 ether);
        assertEq(vault.getTokenCount(), 1);
    }

    function test_deposit_erc20_emitsEvent() public {
        vm.expectEmit(true, true, false, true);
        emit Deposited(owner, address(token), 100 ether);
        vault.deposit(address(token), 100 ether);
    }

    function test_depositNative() public {
        vault.depositNative{value: 1 ether}();
        assertEq(vault.getBalance(address(0)), 1 ether);
    }

    function test_deposit_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.deposit(address(token), 100 ether);
    }

    function test_deposit_revertsIfZeroAmount() public {
        vm.expectRevert(SentinelVault.ZeroAmount.selector);
        vault.deposit(address(token), 0);
    }

    // ─── Withdraw Tests ───

    function test_withdraw_erc20() public {
        vault.deposit(address(token), 100 ether);
        uint256 balBefore = token.balanceOf(owner);
        vault.withdraw(address(token), 50 ether);
        assertEq(vault.getBalance(address(token)), 50 ether);
        assertEq(token.balanceOf(owner), balBefore + 50 ether);
    }

    function test_withdraw_native() public {
        vault.depositNative{value: 1 ether}();
        uint256 balBefore = owner.balance;
        vault.withdraw(address(0), 0.5 ether);
        assertEq(vault.getBalance(address(0)), 0.5 ether);
        assertEq(owner.balance, balBefore + 0.5 ether);
    }

    function test_withdraw_revertsIfInsufficientBalance() public {
        vm.expectRevert(SentinelVault.InsufficientBalance.selector);
        vault.withdraw(address(token), 100 ether);
    }

    // ─── Guardian Management Tests ───

    function test_setGuardian() public {
        vault.setGuardian(guardian);
        assertEq(vault.guardian(), guardian);
    }

    function test_setGuardian_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit GuardianSet(guardian);
        vault.setGuardian(guardian);
    }

    function test_setGuardian_revertsIfZeroAddress() public {
        vm.expectRevert(SentinelVault.ZeroAddress.selector);
        vault.setGuardian(address(0));
    }

    function test_setGuardian_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setGuardian(guardian);
    }

    function test_removeGuardian() public {
        vault.setGuardian(guardian);
        vault.removeGuardian();
        assertEq(vault.guardian(), address(0));
    }

    // ─── Emergency Withdraw Tests ───

    function test_emergencyWithdraw_erc20() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "Flash loan detected");

        assertEq(vault.getBalance(address(token)), 0);
        assertEq(token.balanceOf(safeAddr), 100 ether);
    }

    function test_emergencyWithdraw_native() public {
        vault.depositNative{value: 1 ether}();
        vault.setGuardian(guardian);

        uint256 safeBefore = safeAddr.balance;
        vm.prank(guardian);
        vault.emergencyWithdraw(address(0), 85, "Drain detected");

        assertEq(vault.getBalance(address(0)), 0);
        assertEq(safeAddr.balance, safeBefore + 1 ether);
    }

    function test_emergencyWithdraw_emitsEvent() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vm.expectEmit(true, true, false, true);
        emit EmergencyWithdrawExecuted(guardian, address(token), 100 ether, 85, "Flash loan detected");
        vault.emergencyWithdraw(address(token), 85, "Flash loan detected");
    }

    function test_emergencyWithdraw_revertsIfBelowThreshold() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(SentinelVault.BelowThreshold.selector, 50, 80));
        vault.emergencyWithdraw(address(token), 50, "Low score");
    }

    function test_emergencyWithdraw_revertsIfCooldownActive() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        // First withdrawal succeeds
        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "First");

        // Deposit again
        vault.deposit(address(token), 100 ether);

        // Second withdrawal fails (cooldown)
        vm.prank(guardian);
        vm.expectRevert(); // CooldownActive
        vault.emergencyWithdraw(address(token), 85, "Second");
    }

    function test_emergencyWithdraw_worksAfterCooldown() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "First");

        // Deposit again
        vault.deposit(address(token), 100 ether);

        // Roll forward past cooldown
        vm.roll(block.number + 11);

        // Second withdrawal succeeds
        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "Second");
        assertEq(vault.getBalance(address(token)), 0);
    }

    function test_emergencyWithdraw_revertsIfNotGuardian() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotGuardian.selector);
        vault.emergencyWithdraw(address(token), 85, "Unauthorized");
    }

    function test_emergencyWithdraw_revertsIfNoGuardianSet() public {
        vault.deposit(address(token), 100 ether);
        // No guardian set

        vm.prank(guardian);
        vm.expectRevert(SentinelVault.NoGuardianSet.selector);
        vault.emergencyWithdraw(address(token), 85, "No guardian");
    }

    // ─── SECURITY INVARIANT: Guardian can NEVER steal funds ───

    function test_security_guardianCannotSendToSelf() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        // The guardian executes emergency withdraw — funds go to safeAddr, NOT to guardian
        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "Test");

        assertEq(token.balanceOf(guardian), 0, "Guardian must not receive any tokens");
        assertEq(token.balanceOf(safeAddr), 100 ether, "Safe address must receive all tokens");
    }

    // ─── EmergencyWithdrawAll Tests ───

    function test_emergencyWithdrawAll() public {
        // Deposit native + ERC20
        vault.depositNative{value: 1 ether}();
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        uint256 safeBefore = safeAddr.balance;

        vm.prank(guardian);
        vault.emergencyWithdrawAll(90, "Critical threat");

        assertEq(vault.getBalance(address(0)), 0);
        assertEq(vault.getBalance(address(token)), 0);
        assertEq(safeAddr.balance, safeBefore + 1 ether);
        assertEq(token.balanceOf(safeAddr), 100 ether);
    }

    // ─── View Functions Tests ───

    function test_getVaultStatus() public {
        vault.setGuardian(guardian);
        vault.deposit(address(token), 100 ether);

        (
            address _owner,
            address _guardian,
            address _safeAddress,
            uint256 _threshold,
            uint256 _cooldownBlocks,
            ,
            uint256 _tokenCount,
            bool _isProtected
        ) = vault.getVaultStatus();

        assertEq(_owner, owner);
        assertEq(_guardian, guardian);
        assertEq(_safeAddress, safeAddr);
        assertEq(_threshold, 80);
        assertEq(_cooldownBlocks, 10);
        assertEq(_tokenCount, 1);
        assertTrue(_isProtected);
    }

    function test_getAllBalances() public {
        vault.depositNative{value: 1 ether}();
        vault.deposit(address(token), 100 ether);

        (address[] memory tokens, uint256[] memory amounts) = vault.getAllBalances();

        assertEq(tokens.length, 2);
        assertEq(tokens[0], address(0));
        assertEq(amounts[0], 1 ether);
        assertEq(tokens[1], address(token));
        assertEq(amounts[1], 100 ether);
    }

    // ─── Receive function test ───

    function test_receive_fromOwner() public {
        (bool sent,) = address(vault).call{value: 1 ether}("");
        assertTrue(sent);
        assertEq(vault.getBalance(address(0)), 1 ether);
    }

    function test_receive_revertsFromNonOwner() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool sent,) = address(vault).call{value: 1 ether}("");
        assertFalse(sent);
    }

    // ─── Two-Step Ownership Transfer (transferOwnership + acceptOwnership) ───

    function test_transferOwnership_setsPendingOwnerWithoutChangingOwner() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);

        assertEq(vault.pendingOwner(), newOwner, "pendingOwner not set");
        assertEq(vault.owner(), owner, "owner must not change until accept");
    }

    function test_transferOwnership_emitsStartedEvent() public {
        address newOwner = makeAddr("newOwner");
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferStarted(owner, newOwner);
        vault.transferOwnership(newOwner);
    }

    function test_transferOwnership_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.transferOwnership(attacker);
    }

    function test_transferOwnership_canOverwritePending() public {
        address firstCandidate = makeAddr("first");
        address secondCandidate = makeAddr("second");

        vault.transferOwnership(firstCandidate);
        assertEq(vault.pendingOwner(), firstCandidate);

        vault.transferOwnership(secondCandidate);
        assertEq(vault.pendingOwner(), secondCandidate, "pending should be replaced");

        // First candidate can no longer accept
        vm.prank(firstCandidate);
        vm.expectRevert(SentinelVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_transferOwnership_zeroAddressCancelsPending() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);
        assertEq(vault.pendingOwner(), newOwner);

        // Cancel by transferring to zero
        vault.transferOwnership(address(0));
        assertEq(vault.pendingOwner(), address(0), "pending should be cleared");

        // The previously pending owner can no longer accept
        vm.prank(newOwner);
        vm.expectRevert(SentinelVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_acceptOwnership_succeedsForPendingOwner() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);

        vm.prank(newOwner);
        vault.acceptOwnership();

        assertEq(vault.owner(), newOwner, "owner not updated");
        assertEq(vault.pendingOwner(), address(0), "pendingOwner not cleared");
    }

    function test_acceptOwnership_emitsTransferredEvent() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);

        vm.prank(newOwner);
        vm.expectEmit(true, true, false, false);
        emit OwnershipTransferred(owner, newOwner);
        vault.acceptOwnership();
    }

    function test_acceptOwnership_revertsIfNotPendingOwner() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);

        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_acceptOwnership_revertsIfNoPendingTransfer() public {
        // No transferOwnership ever called -> pendingOwner is address(0)
        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_acceptOwnership_oldOwnerLosesPrivileges() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();

        // Old owner can no longer call owner-only functions
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setThreshold(75);

        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setGuardian(guardian);
    }

    function test_acceptOwnership_newOwnerGainsPrivileges() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);
        vm.prank(newOwner);
        vault.acceptOwnership();

        // New owner can now call owner-only functions
        vm.prank(newOwner);
        vault.setThreshold(75);
        assertEq(vault.threshold(), 75);

        vm.prank(newOwner);
        vault.setGuardian(guardian);
        assertEq(vault.guardian(), guardian);
    }

    function test_acceptOwnership_cannotBeReplayed() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);

        vm.prank(newOwner);
        vault.acceptOwnership();

        // Trying to accept again must revert (pendingOwner was cleared)
        vm.prank(newOwner);
        vm.expectRevert(SentinelVault.NotPendingOwner.selector);
        vault.acceptOwnership();
    }

    function test_security_pendingOwnerCannotActAsOwnerBeforeAccepting() public {
        address newOwner = makeAddr("newOwner");
        vault.transferOwnership(newOwner);

        // Even though listed as pendingOwner, they cannot invoke owner-only logic
        vm.prank(newOwner);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setThreshold(50);

        vm.prank(newOwner);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.setSafeAddress(makeAddr("malicious"));
    }

    // ─── Per-Token Cooldown (§2.4) ───────────────────────────────────────

    function test_perTokenCooldown_doesNotBlockDifferentToken() public {
        MockToken tokenB = new MockToken();
        tokenB.approve(address(vault), type(uint256).max);

        vault.deposit(address(token), 100 ether);
        vault.deposit(address(tokenB), 50 ether);
        vault.setGuardian(guardian);

        // Rescue token A
        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "drain A");

        // Immediately rescue token B (different token, different per-token cooldown)
        vm.prank(guardian);
        vault.emergencyWithdraw(address(tokenB), 85, "drain B");

        assertEq(token.balanceOf(safeAddr), 100 ether);
        assertEq(tokenB.balanceOf(safeAddr), 50 ether);
    }

    function test_perTokenCooldown_blocksSameTokenWithinWindow() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "first");

        vault.deposit(address(token), 100 ether);

        vm.prank(guardian);
        vm.expectRevert(); // CooldownActive
        vault.emergencyWithdraw(address(token), 85, "second");
    }

    function test_perTokenCooldown_globalCooldownNotTriggeredBySingleRescue() public {
        // Single-token rescue should not advance global cooldown.
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        assertFalse(vault.isCooldownActive(), "global cooldown should not be active initially");

        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "rescue token");

        // Global cooldown remains untouched (lastEmergencyBlock unchanged)
        assertFalse(vault.isCooldownActive(), "global cooldown must NOT activate after single emergencyWithdraw");
        // But per-token cooldown IS active for that token
        assertTrue(vault.isCooldownActiveForToken(address(token)), "per-token cooldown must activate for rescued token");
    }

    function test_perTokenCooldown_emergencyWithdrawAllUpdatesAllPerTokens() public {
        MockToken tokenB = new MockToken();
        tokenB.approve(address(vault), type(uint256).max);

        vault.depositNative{value: 1 ether}();
        vault.deposit(address(token), 100 ether);
        vault.deposit(address(tokenB), 50 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vault.emergencyWithdrawAll(95, "rescue all");

        // All three per-tokens should be marked
        assertTrue(vault.isCooldownActiveForToken(address(0)), "native per-token cooldown");
        assertTrue(vault.isCooldownActiveForToken(address(token)), "token A per-token cooldown");
        assertTrue(vault.isCooldownActiveForToken(address(tokenB)), "token B per-token cooldown");
        // Global cooldown is also active
        assertTrue(vault.isCooldownActive(), "global cooldown after withdrawAll");
    }

    function test_perTokenCooldown_isCooldownActiveForTokenViewWorks() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        assertFalse(vault.isCooldownActiveForToken(address(token)), "fresh token");

        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "rescue");

        assertTrue(vault.isCooldownActiveForToken(address(token)));

        vm.roll(block.number + 11);
        assertFalse(vault.isCooldownActiveForToken(address(token)), "after cooldown expires");
    }

    // ─── Emergency Withdraw Batch (§2.3) ─────────────────────────────────

    function test_emergencyWithdrawBatch_processesSlice() public {
        MockToken[] memory tokens = new MockToken[](5);
        for (uint256 i = 0; i < 5; i++) {
            tokens[i] = new MockToken();
            tokens[i].approve(address(vault), type(uint256).max);
            vault.deposit(address(tokens[i]), (i + 1) * 10 ether);
        }
        vault.setGuardian(guardian);

        // Batch the first 3 tokens
        vm.prank(guardian);
        vault.emergencyWithdrawBatch(85, "first batch", 0, 3);

        // First three drained
        for (uint256 i = 0; i < 3; i++) {
            assertEq(vault.getBalance(address(tokens[i])), 0, "first three should be empty");
            assertEq(tokens[i].balanceOf(safeAddr), (i + 1) * 10 ether);
        }
        // Last two untouched
        for (uint256 i = 3; i < 5; i++) {
            assertEq(vault.getBalance(address(tokens[i])), (i + 1) * 10 ether, "last two untouched");
        }
    }

    function test_emergencyWithdrawBatch_clampsEndIdxToListLength() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        // tokenList has 1 entry; pass endIdx way beyond — should clamp, not revert.
        vm.prank(guardian);
        vault.emergencyWithdrawBatch(85, "clamped", 0, 999);

        assertEq(vault.getBalance(address(token)), 0);
    }

    function test_emergencyWithdrawBatch_revertsOnInvalidRange() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        // start >= end after clamp
        vm.prank(guardian);
        vm.expectRevert(SentinelVault.InvalidBatchRange.selector);
        vault.emergencyWithdrawBatch(85, "bad range", 5, 3);
    }

    function test_emergencyWithdrawBatch_revertsOnEmptyTokenList() public {
        // tokenList is empty — endIdx clamps to 0, startIdx >= endIdx → revert
        vault.setGuardian(guardian);
        vm.prank(guardian);
        vm.expectRevert(SentinelVault.InvalidBatchRange.selector);
        vault.emergencyWithdrawBatch(85, "empty", 0, 5);
    }

    function test_emergencyWithdrawBatch_skipsZeroBalanceTokensInSlice() public {
        // Deposit tokens A and B, then withdraw A normally so its balance is 0 in vault.
        MockToken tokenB = new MockToken();
        tokenB.approve(address(vault), type(uint256).max);
        vault.deposit(address(token), 100 ether);
        vault.deposit(address(tokenB), 50 ether);

        vault.withdraw(address(token), 100 ether); // balance[token] = 0, but still in tokenList

        vault.setGuardian(guardian);
        vm.prank(guardian);
        vault.emergencyWithdrawBatch(85, "skip zero", 0, 2);

        assertEq(vault.getBalance(address(token)), 0);
        assertEq(vault.getBalance(address(tokenB)), 0);
        assertEq(tokenB.balanceOf(safeAddr), 50 ether);
    }

    function test_emergencyWithdrawBatch_revertsIfBelowThreshold() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(SentinelVault.BelowThreshold.selector, 50, 80));
        vault.emergencyWithdrawBatch(50, "low score", 0, 1);
    }

    function test_emergencyWithdrawBatch_revertsIfPerTokenCooldownActive() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        // Put token's per-token cooldown active
        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "first");

        // Re-deposit so balance > 0; batch must revert because per-token cooldown is active
        vault.deposit(address(token), 100 ether);

        vm.prank(guardian);
        vm.expectRevert(); // CooldownActive
        vault.emergencyWithdrawBatch(85, "second", 0, 1);
    }

    function test_emergencyWithdrawBatch_doesNotAdvanceGlobalCooldown() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);

        assertFalse(vault.isCooldownActive());

        vm.prank(guardian);
        vault.emergencyWithdrawBatch(85, "batch", 0, 1);

        // Per-token IS active for token; global is NOT.
        assertTrue(vault.isCooldownActiveForToken(address(token)));
        assertFalse(vault.isCooldownActive(), "batch must not touch global cooldown");
    }

    function test_security_emergencyWithdrawBatch_fundsGoToSafeAddressNotGuardian() public {
        MockToken tokenB = new MockToken();
        tokenB.approve(address(vault), type(uint256).max);
        vault.deposit(address(token), 100 ether);
        vault.deposit(address(tokenB), 50 ether);
        vault.setGuardian(guardian);

        vm.prank(guardian);
        vault.emergencyWithdrawBatch(95, "test", 0, 2);

        assertEq(token.balanceOf(guardian), 0, "guardian must not receive token A");
        assertEq(tokenB.balanceOf(guardian), 0, "guardian must not receive token B");
        assertEq(token.balanceOf(safeAddr), 100 ether);
        assertEq(tokenB.balanceOf(safeAddr), 50 ether);
    }

    // ─── Pause Switch (§2.5) ─────────────────────────────────────────────

    function test_pause_setsState() public {
        assertFalse(vault.paused());
        vault.pause();
        assertTrue(vault.paused());
    }

    function test_pause_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit Paused(owner);
        vault.pause();
    }

    function test_pause_revertsIfNotOwner() public {
        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.pause();
    }

    function test_unpause_clearsState() public {
        vault.pause();
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_unpause_emitsEvent() public {
        vault.pause();
        vm.expectEmit(true, false, false, false);
        emit Unpaused(owner);
        vault.unpause();
    }

    function test_unpause_revertsIfNotOwner() public {
        vault.pause();
        vm.prank(attacker);
        vm.expectRevert(SentinelVault.NotOwner.selector);
        vault.unpause();
    }

    function test_pause_blocksEmergencyWithdraw() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);
        vault.pause();

        vm.prank(guardian);
        vm.expectRevert(SentinelVault.VaultPaused.selector);
        vault.emergencyWithdraw(address(token), 85, "blocked");
    }

    function test_pause_blocksEmergencyWithdrawAll() public {
        vault.depositNative{value: 1 ether}();
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);
        vault.pause();

        vm.prank(guardian);
        vm.expectRevert(SentinelVault.VaultPaused.selector);
        vault.emergencyWithdrawAll(95, "blocked");
    }

    function test_pause_blocksEmergencyWithdrawBatch() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);
        vault.pause();

        vm.prank(guardian);
        vm.expectRevert(SentinelVault.VaultPaused.selector);
        vault.emergencyWithdrawBatch(85, "blocked", 0, 1);
    }

    function test_pause_doesNotBlockOwnerDeposit() public {
        vault.pause();
        // Owner can still deposit
        vault.deposit(address(token), 100 ether);
        assertEq(vault.getBalance(address(token)), 100 ether);
    }

    function test_pause_doesNotBlockOwnerWithdraw() public {
        vault.deposit(address(token), 100 ether);
        vault.pause();
        // Owner can still withdraw funds manually
        uint256 before = token.balanceOf(owner);
        vault.withdraw(address(token), 100 ether);
        assertEq(token.balanceOf(owner), before + 100 ether);
    }

    function test_pause_doesNotBlockOwnerConfiguration() public {
        vault.pause();
        // Owner can still change configuration
        vault.setThreshold(60);
        assertEq(vault.threshold(), 60);
        vault.setGuardian(guardian);
        assertEq(vault.guardian(), guardian);
    }

    function test_pause_unpauseRestoresEmergencyOps() public {
        vault.deposit(address(token), 100 ether);
        vault.setGuardian(guardian);
        vault.pause();
        vault.unpause();

        vm.prank(guardian);
        vault.emergencyWithdraw(address(token), 85, "unpause then rescue");
        assertEq(token.balanceOf(safeAddr), 100 ether);
    }

    function test_pause_canBeToggledRepeatedly() public {
        vault.pause();
        vault.unpause();
        vault.pause();
        assertTrue(vault.paused());
        vault.unpause();
        assertFalse(vault.paused());
    }

    // Allow this test contract to receive ETH
    receive() external payable {}
}
