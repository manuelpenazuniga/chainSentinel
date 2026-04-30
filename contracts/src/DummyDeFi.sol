// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title DummyDeFi
/// @notice Minimal simulated DeFi protocol for demo and testing purposes ONLY.
/// @dev Intentionally insecure — used to trigger ChainSentinel threat detection
///      during attack simulations. Do NOT deploy with real funds.
contract DummyDeFi {
    uint256 public totalDeposited;

    event Deposited(address indexed sender, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event FlashLoanRequested(address indexed borrower, uint256 amount);

    /// @notice Accepts ETH deposits.
    receive() external payable {
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Fallback accepts any call with ETH.
    fallback() external payable {
        totalDeposited += msg.value;
        emit Deposited(msg.sender, msg.value);
    }

    /// @notice Withdraw ETH — intentionally unrestricted for demo purposes.
    /// @param amount The amount of ETH to withdraw (in wei).
    function withdraw(uint256 amount) external {
        require(address(this).balance >= amount, "Insufficient balance");
        totalDeposited -= amount;
        (bool ok, ) = msg.sender.call{value: amount}("");
        require(ok, "Transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Simulated flash loan entry point (selector 0xab9c4b5d).
    /// @dev Does nothing meaningful — exists so the AI agent can detect the selector.
    function flashLoan(address, address, uint256 amount, bytes calldata) external {
        emit FlashLoanRequested(msg.sender, amount);
    }
}
