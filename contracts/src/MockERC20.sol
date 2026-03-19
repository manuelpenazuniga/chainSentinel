// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockERC20 — Test token for multi-token vault demos
/// @dev Freely mintable ERC20. Deploy on testnet and use with SentinelVault
/// to demonstrate that emergencyWithdrawAll rescues both native PAS and ERC-20 tokens.
contract MockERC20 is ERC20 {
    uint8 private _decimals;

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_
    ) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint tokens to any address — no access control (testnet only)
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
