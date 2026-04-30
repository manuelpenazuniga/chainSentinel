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

    // Allow this test contract to receive ETH
    receive() external payable {}
}
