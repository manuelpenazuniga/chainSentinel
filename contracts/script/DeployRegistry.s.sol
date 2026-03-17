// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SentinelRegistry.sol";

contract DeployRegistry is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        SentinelRegistry registry = new SentinelRegistry();

        vm.stopBroadcast();

        console.log("SentinelRegistry deployed at:", address(registry));
    }
}
