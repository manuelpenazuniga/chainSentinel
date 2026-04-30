// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/SentinelVault.sol";

contract DeployVault is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address safeAddress = vm.envOr("SAFE_ADDRESS", vm.addr(deployerPrivateKey));
        uint256 threshold = vm.envOr("VAULT_THRESHOLD", uint256(80));

        vm.startBroadcast(deployerPrivateKey);

        SentinelVault vault = new SentinelVault(safeAddress, threshold);

        vm.stopBroadcast();

        console.log("SentinelVault deployed at:", address(vault));
        console.log("Owner:", vault.owner());
        console.log("Safe address:", vault.safeAddress());
        console.log("Threshold:", vault.threshold());
    }
}
