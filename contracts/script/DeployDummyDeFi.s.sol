// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";
import "../src/DummyDeFi.sol";

contract DeployDummyDeFi is Script {
    function run() external {
        uint256 deployerPrivateKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        vm.startBroadcast(deployerPrivateKey);

        DummyDeFi dummyDefi = new DummyDeFi();

        vm.stopBroadcast();

        console.log("DummyDeFi deployed at:", address(dummyDefi));
    }
}
