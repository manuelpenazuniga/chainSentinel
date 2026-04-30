// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title SentinelVault
/// @notice A protected vault that allows an AI guardian agent to execute emergency
///         withdrawals to a pre-configured safe address when threats are detected.
/// @dev The guardian can move funds but ONLY to safeAddress. The guardian can NEVER
///      send funds to its own address. This is the core security invariant.
contract SentinelVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── State Variables ───

    /// @notice The owner of the vault (the user who deposited funds)
    address public owner;

    /// @notice The guardian address (AI agent) authorized to execute emergency withdrawals
    address public guardian;

    /// @notice The address where funds are sent during emergency withdrawals
    /// @dev Configured by the owner. The guardian can ONLY send funds here.
    address public safeAddress;

    /// @notice Minimum threat score (0-100) required to trigger an emergency withdrawal
    uint256 public threshold;

    /// @notice Block number of the last emergency withdrawal (for cooldown enforcement)
    uint256 public lastEmergencyBlock;

    /// @notice Number of blocks that must pass between emergency withdrawals
    uint256 public cooldownBlocks;

    /// @notice Mapping of token address => deposited balance
    /// @dev address(0) represents the native token (DOT/PAS)
    mapping(address => uint256) public balances;

    /// @notice Tracks which tokens have been deposited (to avoid duplicates in tokenList)
    mapping(address => bool) public supportedTokens;

    /// @notice Ordered list of all ERC-20 token addresses that have been deposited
    /// @dev Used by emergencyWithdrawAll() to iterate over all tokens
    address[] public tokenList;

    /// @notice Mapping of contract addresses the owner trusts (whitelisted)
    mapping(address => bool) public whitelist;

    // ─── Events ───

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event NativeDeposited(address indexed user, uint256 amount);
    event GuardianSet(address indexed guardian);
    event GuardianRemoved();
    event EmergencyWithdrawExecuted(
        address indexed guardian,
        address indexed token,
        uint256 amount,
        uint256 threatScore,
        string reason
    );
    event ThresholdUpdated(uint256 newThreshold);
    event SafeAddressUpdated(address newSafeAddress);
    event CooldownUpdated(uint256 newCooldownBlocks);
    event ContractWhitelisted(address indexed contractAddress);
    event ContractRemovedFromWhitelist(address indexed contractAddress);

    // ─── Errors ───

    error NotOwner();
    error NotGuardian();
    error NoGuardianSet();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();
    error BelowThreshold(uint256 provided, uint256 required);
    error CooldownActive(uint256 currentBlock, uint256 availableAt);
    error InvalidThreshold();

    // ─── Modifiers ───

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyGuardian() {
        if (guardian == address(0)) revert NoGuardianSet();
        if (msg.sender != guardian) revert NotGuardian();
        _;
    }

    // ─── Constructor ───

    /// @notice Creates a new SentinelVault
    /// @param _safeAddress The address where emergency funds will be sent (defaults to msg.sender if zero)
    /// @param _threshold Minimum threat score to trigger emergency withdrawal (defaults to 80 if zero)
    constructor(address _safeAddress, uint256 _threshold) {
        owner = msg.sender;
        safeAddress = _safeAddress != address(0) ? _safeAddress : msg.sender;
        threshold = _threshold > 0 && _threshold <= 100 ? _threshold : 80;
        cooldownBlocks = 10;
    }

    // ─── Owner Functions ───

    /// @notice Deposit ERC-20 tokens into the vault
    /// @param token The ERC-20 token address
    /// @param amount The amount to deposit
    function deposit(address token, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (!supportedTokens[token]) {
            supportedTokens[token] = true;
            tokenList.push(token);
        }
        balances[token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Deposit native tokens (DOT/PAS) into the vault
    function depositNative() external payable onlyOwner {
        if (msg.value == 0) revert ZeroAmount();
        balances[address(0)] += msg.value;
        emit NativeDeposited(msg.sender, msg.value);
    }

    /// @notice Withdraw tokens from the vault (normal withdrawal by owner)
    /// @param token The token address (address(0) for native)
    /// @param amount The amount to withdraw
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        if (balances[token] < amount) revert InsufficientBalance();
        balances[token] -= amount;
        if (token == address(0)) {
            (bool sent,) = payable(owner).call{value: amount}("");
            require(sent, "Native transfer failed");
        } else {
            IERC20(token).safeTransfer(owner, amount);
        }
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice Set the guardian (AI agent) address
    /// @param _guardian The address of the AI agent wallet
    function setGuardian(address _guardian) external onlyOwner {
        if (_guardian == address(0)) revert ZeroAddress();
        guardian = _guardian;
        emit GuardianSet(_guardian);
    }

    /// @notice Remove the guardian (disables AI protection)
    function removeGuardian() external onlyOwner {
        guardian = address(0);
        emit GuardianRemoved();
    }

    /// @notice Set the minimum threat score for emergency withdrawals
    /// @param _threshold Score between 1 and 100
    function setThreshold(uint256 _threshold) external onlyOwner {
        if (_threshold == 0 || _threshold > 100) revert InvalidThreshold();
        threshold = _threshold;
        emit ThresholdUpdated(_threshold);
    }

    /// @notice Set the safe address for emergency withdrawals
    /// @param _safeAddress The new safe address
    function setSafeAddress(address _safeAddress) external onlyOwner {
        if (_safeAddress == address(0)) revert ZeroAddress();
        safeAddress = _safeAddress;
        emit SafeAddressUpdated(_safeAddress);
    }

    /// @notice Set the cooldown period between emergency withdrawals
    /// @param _cooldownBlocks Number of blocks
    function setCooldownBlocks(uint256 _cooldownBlocks) external onlyOwner {
        cooldownBlocks = _cooldownBlocks;
        emit CooldownUpdated(_cooldownBlocks);
    }

    /// @notice Add a contract to the whitelist (trusted, reduces false positives)
    /// @param contractAddress The contract to whitelist
    function addToWhitelist(address contractAddress) external onlyOwner {
        whitelist[contractAddress] = true;
        emit ContractWhitelisted(contractAddress);
    }

    /// @notice Remove a contract from the whitelist
    /// @param contractAddress The contract to remove
    function removeFromWhitelist(address contractAddress) external onlyOwner {
        whitelist[contractAddress] = false;
        emit ContractRemovedFromWhitelist(contractAddress);
    }

    // ─── Guardian Functions (AI Agent) ───
    //
    // CRITICAL SECURITY NOTE:
    // The guardian can move funds, but ONLY to safeAddress (configured by the owner).
    // The guardian can NEVER send funds to its own address or any arbitrary address.
    // This is enforced by the contract logic — safeAddress is hardcoded as the recipient.

    /// @notice Execute an emergency withdrawal for a specific token
    /// @param token The token to withdraw (address(0) for native)
    /// @param threatScore The threat score that triggered this action (must be >= threshold)
    /// @param reason Human-readable explanation of the detected threat
    function emergencyWithdraw(address token, uint256 threatScore, string calldata reason)
        external
        onlyGuardian
        nonReentrant
    {
        if (threatScore < threshold) revert BelowThreshold(threatScore, threshold);
        if (block.number < lastEmergencyBlock + cooldownBlocks) {
            revert CooldownActive(block.number, lastEmergencyBlock + cooldownBlocks);
        }

        uint256 amount = balances[token];
        if (amount == 0) revert InsufficientBalance();

        balances[token] = 0;
        lastEmergencyBlock = block.number;

        if (token == address(0)) {
            (bool sent,) = payable(safeAddress).call{value: amount}("");
            require(sent, "Native transfer failed");
        } else {
            IERC20(token).safeTransfer(safeAddress, amount);
        }

        emit EmergencyWithdrawExecuted(msg.sender, token, amount, threatScore, reason);
    }

    /// @notice Execute emergency withdrawal for ALL tokens in the vault
    /// @param threatScore The threat score that triggered this action
    /// @param reason Human-readable explanation of the detected threat
    function emergencyWithdrawAll(uint256 threatScore, string calldata reason)
        external
        onlyGuardian
        nonReentrant
    {
        if (threatScore < threshold) revert BelowThreshold(threatScore, threshold);
        if (block.number < lastEmergencyBlock + cooldownBlocks) {
            revert CooldownActive(block.number, lastEmergencyBlock + cooldownBlocks);
        }

        lastEmergencyBlock = block.number;

        // Withdraw native tokens
        uint256 nativeBalance = balances[address(0)];
        if (nativeBalance > 0) {
            balances[address(0)] = 0;
            (bool sent,) = payable(safeAddress).call{value: nativeBalance}("");
            require(sent, "Native transfer failed");
            emit EmergencyWithdrawExecuted(msg.sender, address(0), nativeBalance, threatScore, reason);
        }

        // Withdraw all ERC-20 tokens
        for (uint256 i = 0; i < tokenList.length; i++) {
            address token = tokenList[i];
            uint256 amount = balances[token];
            if (amount > 0) {
                balances[token] = 0;
                IERC20(token).safeTransfer(safeAddress, amount);
                emit EmergencyWithdrawExecuted(msg.sender, token, amount, threatScore, reason);
            }
        }
    }

    // ─── View Functions ───

    /// @notice Get the overall vault status
    function getVaultStatus()
        external
        view
        returns (
            address _owner,
            address _guardian,
            address _safeAddress,
            uint256 _threshold,
            uint256 _cooldownBlocks,
            uint256 _lastEmergencyBlock,
            uint256 _tokenCount,
            bool _isProtected
        )
    {
        return (owner, guardian, safeAddress, threshold, cooldownBlocks, lastEmergencyBlock, tokenList.length, guardian != address(0));
    }

    /// @notice Get the balance of a specific token in the vault
    /// @param token The token address (address(0) for native)
    function getBalance(address token) external view returns (uint256) {
        return balances[token];
    }

    /// @notice Get all token balances in the vault
    /// @return tokens Array of token addresses (index 0 is native token address(0))
    /// @return amounts Array of corresponding balances
    function getAllBalances() external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 len = tokenList.length;
        tokens = new address[](len + 1);
        amounts = new uint256[](len + 1);

        // Native token at index 0
        tokens[0] = address(0);
        amounts[0] = balances[address(0)];

        // ERC-20 tokens
        for (uint256 i = 0; i < len; i++) {
            tokens[i + 1] = tokenList[i];
            amounts[i + 1] = balances[tokenList[i]];
        }
    }

    /// @notice Check if a contract is whitelisted
    function isWhitelisted(address contractAddress) external view returns (bool) {
        return whitelist[contractAddress];
    }

    /// @notice Get the number of supported tokens
    function getTokenCount() external view returns (uint256) {
        return tokenList.length;
    }

    /// @notice Check if the cooldown period is active
    function isCooldownActive() external view returns (bool) {
        return block.number < lastEmergencyBlock + cooldownBlocks;
    }

    // ─── Receive function ───

    /// @notice Allow the vault to receive native tokens directly
    /// @dev Only the owner can send native tokens. Others are rejected.
    receive() external payable {
        if (msg.sender != owner) revert NotOwner();
        balances[address(0)] += msg.value;
        emit NativeDeposited(msg.sender, msg.value);
    }
}
