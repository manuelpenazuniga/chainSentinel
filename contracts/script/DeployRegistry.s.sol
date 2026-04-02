// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SentinelRegistry.sol";

contract DeployRegistry is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agentAddress = vm.envAddress("AGENT_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        SentinelRegistry registry = new SentinelRegistry();
        registry.addReporter(agentAddress);

        vm.stopBroadcast();

        console.log("SentinelRegistry deployed at:", address(registry));
        console.log("Agent authorized as reporter:", agentAddress);
    }
}
