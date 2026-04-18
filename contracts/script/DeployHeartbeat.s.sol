// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SentinelHeartbeat.sol";

contract DeployHeartbeat is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agentAddress = vm.envAddress("AGENT_ADDRESS");

        vm.startBroadcast(deployerPrivateKey);

        // 100 blocks ~= 10 minutes at 6s/block
        SentinelHeartbeat heartbeat = new SentinelHeartbeat(agentAddress, 100);

        vm.stopBroadcast();

        console.log("SentinelHeartbeat deployed at:", address(heartbeat));
        console.log("Agent registered:", agentAddress);
        console.log("Staleness threshold:", heartbeat.stalenessThreshold(), "blocks");
    }
}
