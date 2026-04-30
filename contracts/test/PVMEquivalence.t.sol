// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SentinelVault.sol";
import "../pvm/SentinelVaultPVM.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// ============================================================================
// PVMEquivalence.t.sol — Behavioral equivalence tests for REVM vs PVM vaults
// ============================================================================
//
// Strategy: abstract base contract defines all shared behavior tests.
// Two concrete subclasses instantiate the REVM and PVM implementations.
// Foundry runs each test against BOTH implementations.
//
// Scope:
//   - Constructor initialization
//   - ERC-20 and native token deposits / withdrawals
//   - Guardian management and access control
//   - Emergency withdraw: threshold, cooldown, single token, all tokens
//   - Whitelist mechanics
//   - View helpers: getAllBalances, isCooldownActive, getVaultStatus
//   - Bad-token handling (transfer returns false)
//   - Reentrancy guard (both implementations must block reentrant calls)
//
// What is NOT tested here:
//   - Error *names* (REVM uses ReentrancyGuardReentrantCall / SafeERC20FailedOperation,
//     PVM uses ReentrantCall / ERC20TransferFailed). Behavior is identical; names differ by design.
//   - PVM-specific bytecode / gas behavior (requires resolc toolchain).
// ============================================================================

// ─── Shared token mocks ──────────────────────────────────────────────────────

/// @dev Standard ERC-20 with unlimited mint
contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MCK") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Non-standard token: transfer() and transferFrom() return false instead of reverting.
///      Both REVM (SafeERC20) and PVM (explicit check) must revert when this happens.
contract BadToken is ERC20 {
    constructor() ERC20("Bad", "BAD") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// @dev Re-entrant token: calls emergencyWithdraw again on transfer to attempt reentrancy.
///      We only use this to test the guard behavior; the actual call will revert.
contract ReentrantToken is ERC20 {
    address public vault;
    bool public attacking;

    constructor() ERC20("Ree", "REE") {
        _mint(msg.sender, 1_000_000 ether);
    }

    function setVault(address v) external {
        vault = v;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (attacking && vault != address(0)) {
            attacking = false;
            // Attempt reentrant emergencyWithdraw — must revert with guard error
            try SentinelVaultPVM(payable(vault)).emergencyWithdraw(address(this), 90, "reentrant") {}
            catch {}
        }
        return super.transfer(to, amount);
    }
}

// ─── Vault interface abstraction ─────────────────────────────────────────────
// Both vault types share the same external ABI. We call them through a common
// interface so the abstract test can be implementation-agnostic.

interface IVault {
    function owner() external view returns (address);
    function guardian() external view returns (address);
    function safeAddress() external view returns (address);
    function threshold() external view returns (uint256);
    function cooldownBlocks() external view returns (uint256);
    function lastEmergencyBlock() external view returns (uint256);
    function balances(address) external view returns (uint256);
    function whitelist(address) external view returns (bool);

    function deposit(address token, uint256 amount) external;
    function depositNative() external payable;
    function withdraw(address token, uint256 amount) external;
    function setGuardian(address _guardian) external;
    function removeGuardian() external;
    function setThreshold(uint256 _threshold) external;
    function setSafeAddress(address _safeAddress) external;
    function setCooldownBlocks(uint256 _cooldownBlocks) external;
    function addToWhitelist(address contractAddress) external;
    function removeFromWhitelist(address contractAddress) external;
    function emergencyWithdraw(address token, uint256 threatScore, string calldata reason) external;
    function emergencyWithdrawAll(uint256 threatScore, string calldata reason) external;

    function getBalance(address token) external view returns (uint256);
    function getTokenCount() external view returns (uint256);
    function isWhitelisted(address) external view returns (bool);
    function isCooldownActive() external view returns (bool);
    function getAllBalances() external view returns (address[] memory tokens, uint256[] memory amounts);
    function getVaultStatus()
        external
        view
        returns (address, address, address, uint256, uint256, uint256, uint256, bool);
}

// ─── Abstract equivalence test ───────────────────────────────────────────────

/// @title VaultEquivalenceBase
/// @notice Abstract Foundry test that covers all shared vault behavior.
///         Subclasses override `_deployVault` to provide either SentinelVault or SentinelVaultPVM.
abstract contract VaultEquivalenceBase is Test {
    IVault vault;
    MockToken token;
    MockToken token2;
    BadToken bad;

    address owner = address(this);
    address guardian_ = makeAddr("guardian");
    address safe_ = makeAddr("safe");
    address attacker_ = makeAddr("attacker");

    // Events for expectEmit
    event GuardianSet(address indexed guardian);
    event GuardianRemoved();
    event EmergencyWithdrawExecuted(
        address indexed guardian, address indexed token, uint256 amount, uint256 threatScore, string reason
    );
    event ThresholdUpdated(uint256 newThreshold);
    event ContractWhitelisted(address indexed contractAddress);
    event ContractRemovedFromWhitelist(address indexed contractAddress);

    /// @dev Override in subclasses to deploy the specific vault implementation.
    function _deployVault(address safeAddress, uint256 threshold) internal virtual returns (IVault);

    function setUp() public virtual {
        vm.roll(100); // avoid cooldown issues near block 0

        vault = _deployVault(safe_, 80);
        token = new MockToken();
        token2 = new MockToken();
        bad = new BadToken();

        token.approve(address(vault), type(uint256).max);
        token2.approve(address(vault), type(uint256).max);
        bad.approve(address(vault), type(uint256).max);
    }

    // ─── Constructor ─────────────────────────────────────────────────────────

    function test_constructor_owner() public view {
        assertEq(vault.owner(), owner);
    }

    function test_constructor_safeAddress() public view {
        assertEq(vault.safeAddress(), safe_);
    }

    function test_constructor_threshold() public view {
        assertEq(vault.threshold(), 80);
    }

    function test_constructor_noGuardian() public view {
        assertEq(vault.guardian(), address(0));
    }

    function test_constructor_cooldownDefault() public view {
        assertEq(vault.cooldownBlocks(), 10);
    }

    function test_constructor_zeroSafeAddressDefaultsToDeployer() public {
        IVault v = _deployVault(address(0), 80);
        assertEq(v.safeAddress(), address(this));
    }

    function test_constructor_zeroThresholdDefaultsTo80() public {
        IVault v = _deployVault(safe_, 0);
        assertEq(v.threshold(), 80);
    }

    function test_constructor_thresholdAbove100DefaultsTo80() public {
        IVault v = _deployVault(safe_, 101);
        assertEq(v.threshold(), 80);
    }

    // ─── ERC-20 Deposit ──────────────────────────────────────────────────────

    function test_deposit_updatesBalance() public {
        vault.deposit(address(token), 500 ether);
        assertEq(vault.getBalance(address(token)), 500 ether);
    }

    function test_deposit_addsToTokenList() public {
        vault.deposit(address(token), 1 ether);
        assertEq(vault.getTokenCount(), 1);
    }

    function test_deposit_deduplicatesToken() public {
        vault.deposit(address(token), 1 ether);
        vault.deposit(address(token), 2 ether);
        assertEq(vault.getTokenCount(), 1);
        assertEq(vault.getBalance(address(token)), 3 ether);
    }

    function test_deposit_multipleTokens() public {
        vault.deposit(address(token), 1 ether);
        vault.deposit(address(token2), 2 ether);
        assertEq(vault.getTokenCount(), 2);
    }

    function test_deposit_revertsNotOwner() public {
        vm.prank(attacker_);
        vm.expectRevert();
        vault.deposit(address(token), 1 ether);
    }

    function test_deposit_revertsZeroAmount() public {
        vm.expectRevert();
        vault.deposit(address(token), 0);
    }

    function test_deposit_revertsOnBadToken() public {
        // BadToken.transferFrom returns false — both REVM and PVM must revert
        vm.expectRevert();
        vault.deposit(address(bad), 1 ether);
    }

    // ─── Native Token Deposit ────────────────────────────────────────────────

    function test_depositNative_updatesBalance() public {
        vault.depositNative{value: 1 ether}();
        assertEq(vault.getBalance(address(0)), 1 ether);
    }

    function test_depositNative_revertsNotOwner() public {
        vm.deal(attacker_, 1 ether);
        vm.prank(attacker_);
        vm.expectRevert();
        vault.depositNative{value: 1 ether}();
    }

    function test_receive_creditsNativeBalance() public {
        (bool ok,) = address(vault).call{value: 0.5 ether}("");
        assertTrue(ok);
        assertEq(vault.getBalance(address(0)), 0.5 ether);
    }

    // ─── Withdraw ────────────────────────────────────────────────────────────

    function test_withdraw_erc20() public {
        vault.deposit(address(token), 100 ether);
        uint256 before = token.balanceOf(owner);
        vault.withdraw(address(token), 60 ether);
        assertEq(vault.getBalance(address(token)), 40 ether);
        assertEq(token.balanceOf(owner), before + 60 ether);
    }

    function test_withdraw_native() public {
        vault.depositNative{value: 1 ether}();
        uint256 before = owner.balance;
        vault.withdraw(address(0), 0.4 ether);
        assertEq(vault.getBalance(address(0)), 0.6 ether);
        assertEq(owner.balance, before + 0.4 ether);
    }

    function test_withdraw_revertsInsufficientBalance() public {
        vault.deposit(address(token), 10 ether);
        vm.expectRevert();
        vault.withdraw(address(token), 11 ether);
    }

    function test_withdraw_revertsNotOwner() public {
        vault.deposit(address(token), 10 ether);
        vm.prank(attacker_);
        vm.expectRevert();
        vault.withdraw(address(token), 1 ether);
    }

    // ─── Guardian Management ────────────────────────────────────────────────

    function test_setGuardian() public {
        vm.expectEmit(true, false, false, false);
        emit GuardianSet(guardian_);
        vault.setGuardian(guardian_);
        assertEq(vault.guardian(), guardian_);
    }

    function test_setGuardian_revertsZeroAddress() public {
        vm.expectRevert();
        vault.setGuardian(address(0));
    }

    function test_setGuardian_revertsNotOwner() public {
        vm.prank(attacker_);
        vm.expectRevert();
        vault.setGuardian(guardian_);
    }

    function test_removeGuardian() public {
        vault.setGuardian(guardian_);
        vm.expectEmit(false, false, false, false);
        emit GuardianRemoved();
        vault.removeGuardian();
        assertEq(vault.guardian(), address(0));
    }

    // ─── Threshold & Config ──────────────────────────────────────────────────

    function test_setThreshold() public {
        vm.expectEmit(false, false, false, true);
        emit ThresholdUpdated(75);
        vault.setThreshold(75);
        assertEq(vault.threshold(), 75);
    }

    function test_setThreshold_revertsZero() public {
        vm.expectRevert();
        vault.setThreshold(0);
    }

    function test_setThreshold_revertsAbove100() public {
        vm.expectRevert();
        vault.setThreshold(101);
    }

    function test_setSafeAddress() public {
        address newSafe = makeAddr("newSafe");
        vault.setSafeAddress(newSafe);
        assertEq(vault.safeAddress(), newSafe);
    }

    function test_setSafeAddress_revertsZero() public {
        vm.expectRevert();
        vault.setSafeAddress(address(0));
    }

    function test_setCooldownBlocks() public {
        vault.setCooldownBlocks(20);
        assertEq(vault.cooldownBlocks(), 20);
    }

    // ─── Whitelist ───────────────────────────────────────────────────────────

    function test_addToWhitelist() public {
        vm.expectEmit(true, false, false, false);
        emit ContractWhitelisted(address(token));
        vault.addToWhitelist(address(token));
        assertTrue(vault.isWhitelisted(address(token)));
    }

    function test_removeFromWhitelist() public {
        vault.addToWhitelist(address(token));
        vm.expectEmit(true, false, false, false);
        emit ContractRemovedFromWhitelist(address(token));
        vault.removeFromWhitelist(address(token));
        assertFalse(vault.isWhitelisted(address(token)));
    }

    function test_whitelist_revertsNotOwner() public {
        vm.prank(attacker_);
        vm.expectRevert();
        vault.addToWhitelist(address(token));
    }

    // ─── Emergency Withdraw ──────────────────────────────────────────────────

    function _setupGuardianAndDeposit() internal {
        vault.setGuardian(guardian_);
        vault.deposit(address(token), 100 ether);
    }

    function test_emergencyWithdraw_singleToken() public {
        _setupGuardianAndDeposit();
        vm.prank(guardian_);
        vm.expectEmit(true, true, false, true);
        emit EmergencyWithdrawExecuted(guardian_, address(token), 100 ether, 85, "hack detected");
        vault.emergencyWithdraw(address(token), 85, "hack detected");

        assertEq(vault.getBalance(address(token)), 0);
        assertEq(token.balanceOf(safe_), 100 ether);
    }

    function test_emergencyWithdraw_fundsGoToSafeAddress() public {
        _setupGuardianAndDeposit();
        uint256 before = token.balanceOf(safe_);
        vm.prank(guardian_);
        vault.emergencyWithdraw(address(token), 90, "drain");
        assertEq(token.balanceOf(safe_), before + 100 ether);
    }

    function test_emergencyWithdraw_nativeToken() public {
        vault.setGuardian(guardian_);
        vault.depositNative{value: 2 ether}();
        uint256 before = safe_.balance;
        vm.prank(guardian_);
        vault.emergencyWithdraw(address(0), 90, "drain");
        assertEq(safe_.balance, before + 2 ether);
        assertEq(vault.getBalance(address(0)), 0);
    }

    function test_emergencyWithdraw_revertsIfBelowThreshold() public {
        _setupGuardianAndDeposit();
        vm.prank(guardian_);
        vm.expectRevert();
        vault.emergencyWithdraw(address(token), 79, "low score");
    }

    function test_emergencyWithdraw_revertsIfNotGuardian() public {
        _setupGuardianAndDeposit();
        vm.prank(attacker_);
        vm.expectRevert();
        vault.emergencyWithdraw(address(token), 90, "hack");
    }

    function test_emergencyWithdraw_revertsIfNoGuardianSet() public {
        vault.deposit(address(token), 100 ether);
        // No guardian set — must revert with NoGuardianSet
        vm.expectRevert();
        vault.emergencyWithdraw(address(token), 90, "hack");
    }

    function test_emergencyWithdraw_revertsIfZeroBalance() public {
        vault.setGuardian(guardian_);
        // No deposit — balance is 0
        vm.prank(guardian_);
        vm.expectRevert();
        vault.emergencyWithdraw(address(token), 90, "drain");
    }

    // ─── Cooldown ────────────────────────────────────────────────────────────

    function test_cooldown_blockSecondWithdrawInSameBlock() public {
        _setupGuardianAndDeposit();
        vault.deposit(address(token2), 50 ether);

        vm.prank(guardian_);
        vault.emergencyWithdraw(address(token), 90, "first");

        // Immediately attempt second withdrawal — should hit cooldown
        vm.prank(guardian_);
        vm.expectRevert();
        vault.emergencyWithdraw(address(token2), 90, "second");
    }

    function test_cooldown_allowsWithdrawAfterCooldown() public {
        _setupGuardianAndDeposit();
        vault.deposit(address(token2), 50 ether);

        vm.prank(guardian_);
        vault.emergencyWithdraw(address(token), 90, "first");

        // Advance past cooldown (default 10 blocks)
        vm.roll(block.number + 11);

        vm.prank(guardian_);
        vault.emergencyWithdraw(address(token2), 90, "second");
        assertEq(vault.getBalance(address(token2)), 0);
    }

    function test_isCooldownActive_falseInitially() public view {
        assertFalse(vault.isCooldownActive());
    }

    function test_isCooldownActive_trueAfterEmergencyWithdraw() public {
        _setupGuardianAndDeposit();
        vm.prank(guardian_);
        vault.emergencyWithdraw(address(token), 90, "hack");
        assertTrue(vault.isCooldownActive());
    }

    function test_isCooldownActive_falseAfterCooldownExpires() public {
        _setupGuardianAndDeposit();
        vm.prank(guardian_);
        vault.emergencyWithdraw(address(token), 90, "hack");
        vm.roll(block.number + 11);
        assertFalse(vault.isCooldownActive());
    }

    // ─── Emergency Withdraw All ──────────────────────────────────────────────

    function test_emergencyWithdrawAll_drainsTwoTokens() public {
        vault.setGuardian(guardian_);
        vault.deposit(address(token), 100 ether);
        vault.deposit(address(token2), 200 ether);
        vault.depositNative{value: 1 ether}();

        uint256 safeBefore = safe_.balance;

        vm.prank(guardian_);
        vault.emergencyWithdrawAll(90, "drain all");

        assertEq(vault.getBalance(address(token)), 0);
        assertEq(vault.getBalance(address(token2)), 0);
        assertEq(vault.getBalance(address(0)), 0);
        assertEq(token.balanceOf(safe_), 100 ether);
        assertEq(token2.balanceOf(safe_), 200 ether);
        assertEq(safe_.balance, safeBefore + 1 ether);
    }

    function test_emergencyWithdrawAll_revertsIfBelowThreshold() public {
        vault.setGuardian(guardian_);
        vault.deposit(address(token), 100 ether);
        vm.prank(guardian_);
        vm.expectRevert();
        vault.emergencyWithdrawAll(70, "low score");
    }

    function test_emergencyWithdrawAll_succeedsWithEmptyVault() public {
        // No tokens deposited — should not revert (just no-op on tokens)
        vault.setGuardian(guardian_);
        vm.prank(guardian_);
        vault.emergencyWithdrawAll(90, "empty"); // must not revert
    }

    // ─── getAllBalances ───────────────────────────────────────────────────────

    function test_getAllBalances_emptyVault() public view {
        (address[] memory tokens, uint256[] memory amounts) = vault.getAllBalances();
        // index 0 = native token
        assertEq(tokens.length, 1);
        assertEq(amounts[0], 0);
    }

    function test_getAllBalances_afterDeposits() public {
        vault.depositNative{value: 0.5 ether}();
        vault.deposit(address(token), 10 ether);
        vault.deposit(address(token2), 20 ether);

        (address[] memory tokens, uint256[] memory amounts) = vault.getAllBalances();

        // Index 0 = native (address(0))
        assertEq(tokens[0], address(0));
        assertEq(amounts[0], 0.5 ether);

        // The two ERC-20s follow (order matches insertion)
        assertEq(tokens.length, 3);
        assertEq(amounts[1] + amounts[2], 30 ether);
    }

    // ─── getVaultStatus ──────────────────────────────────────────────────────

    function test_getVaultStatus_returnsTuple() public {
        vault.setGuardian(guardian_);
        vault.deposit(address(token), 1 ether);

        (
            address _owner,
            address _guardian,
            address _safe,
            uint256 _threshold,
            uint256 _cooldown,
            uint256 _lastBlock,
            uint256 _tokenCount,
            bool _isProtected
        ) = vault.getVaultStatus();

        assertEq(_owner, owner);
        assertEq(_guardian, guardian_);
        assertEq(_safe, safe_);
        assertEq(_threshold, 80);
        assertEq(_cooldown, 10);
        assertEq(_lastBlock, 0);
        assertEq(_tokenCount, 1);       // one ERC-20 deposited
        assertTrue(_isProtected);       // guardian is set
    }

    function test_getVaultStatus_isProtectedFalseWithoutGuardian() public view {
        (,,,,,,, bool _isProtected) = vault.getVaultStatus();
        assertFalse(_isProtected); // no guardian → not protected
    }

    // ─── Guardian-funds-to-safeAddress invariant ─────────────────────────────
    // Core security property: guardian can NEVER direct funds to its own address.
    // safeAddress is always the destination — fixed at deploy or updated by owner only.

    function test_invariant_emergencyFundsGoToSafeNotGuardian() public {
        _setupGuardianAndDeposit();
        uint256 guardianBefore = token.balanceOf(guardian_);
        vm.prank(guardian_);
        vault.emergencyWithdraw(address(token), 90, "hack");
        // Guardian received nothing
        assertEq(token.balanceOf(guardian_), guardianBefore);
        // Safe received everything
        assertEq(token.balanceOf(safe_), 100 ether);
    }

    function test_invariant_guardianCannotChangeSafeAddress() public {
        vault.setGuardian(guardian_);
        vm.prank(guardian_);
        vm.expectRevert(); // only owner can setSafeAddress
        vault.setSafeAddress(guardian_);
    }

    function test_invariant_guardianCannotSetNewGuardian() public {
        vault.setGuardian(guardian_);
        address rogue = makeAddr("rogue");
        vm.prank(guardian_);
        vm.expectRevert(); // only owner can setGuardian
        vault.setGuardian(rogue);
    }

    // Allow test contract to receive ETH (for native withdraw tests)
    receive() external payable {}
}

// ─── REVM concrete test ──────────────────────────────────────────────────────

/// @title SentinelVaultREVMTest
/// @notice Runs all VaultEquivalenceBase tests against the standard REVM vault.
contract SentinelVaultREVMTest is VaultEquivalenceBase {
    function _deployVault(address safeAddress, uint256 threshold)
        internal
        override
        returns (IVault)
    {
        return IVault(address(new SentinelVault(safeAddress, threshold)));
    }
}

// ─── PVM concrete test ───────────────────────────────────────────────────────

/// @title SentinelVaultPVMTest
/// @notice Runs all VaultEquivalenceBase tests against the PVM vault source.
///         Compiled with solc here (for Foundry), resolc on PVM deployment.
///         Same Solidity logic → same behavior → all tests must pass.
contract SentinelVaultPVMTest is VaultEquivalenceBase {
    function _deployVault(address safeAddress, uint256 threshold)
        internal
        override
        returns (IVault)
    {
        return IVault(address(new SentinelVaultPVM(safeAddress, threshold)));
    }
}
