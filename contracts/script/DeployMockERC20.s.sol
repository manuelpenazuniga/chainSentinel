// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/MockERC20.sol";

/// @dev Deploy a MockERC20 token for multi-token vault testing.
/// Usage:
///   forge script script/DeployMockERC20.s.sol \
///     --rpc-url $RPC_URL --broadcast -vvv
contract DeployMockERC20 is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerKey);

        MockERC20 token = new MockERC20("Sentinel Test Token", "STT", 18);

        // Mint 10,000 tokens to deployer for testing
        token.mint(vm.addr(deployerKey), 10_000 ether);

        vm.stopBroadcast();

        console.log("MockERC20 deployed at:", address(token));
        console.log("Symbol: STT, Decimals: 18");
        console.log("Minted 10,000 STT to deployer");
    }
}
