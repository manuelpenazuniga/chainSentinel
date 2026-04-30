// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/SentinelRegistry.sol";

/// @title RegistryHandler
/// @notice Constrains Foundry's fuzzer to valid SentinelRegistry interactions.
contract RegistryHandler is Test {
    SentinelRegistry public registry;

    address public owner;
    address[] public reporters;

    // ─── Ghost variables ────────────────────────────────────────────────────

    /// @dev Tracks all unique target contracts that have been reported
    address[] public ghost_targets;
    mapping(address => bool) private ghost_targetSeen;

    /// @dev Tracks the sum of all scores submitted per target (for average verification)
    mapping(address => uint256) public ghost_scoreSum;
    mapping(address => uint256) public ghost_reportCount;

    uint256 public ghost_totalReports;
    uint256 public ghost_totalPlaybooks;

    constructor(SentinelRegistry _registry, address _owner, address[] memory _reporters) {
        registry = _registry;
        owner = _owner;
        reporters = _reporters;
    }

    function reportThreat(uint256 reporterIdx, uint256 targetSeed, uint256 score) external {
        // Pick a random authorized reporter
        reporterIdx = bound(reporterIdx, 0, reporters.length - 1);
        address reporter = reporters[reporterIdx];

        // Generate a deterministic target address from seed
        address target = address(uint160(uint256(keccak256(abi.encode(targetSeed)))));
        if (target == address(0)) target = address(1); // avoid zero address revert

        score = bound(score, 1, 100);

        vm.prank(reporter);
        registry.reportThreat(target, score, "FUZZ", "fuzz-evidence");

        ghost_scoreSum[target] += score;
        ghost_reportCount[target]++;
        ghost_totalReports++;

        if (!ghost_targetSeen[target]) {
            ghost_targetSeen[target] = true;
            ghost_targets.push(target);
        }
    }

    function reportThreatWithPlaybook(uint256 reporterIdx, uint256 targetSeed, uint256 score) external {
        reporterIdx = bound(reporterIdx, 0, reporters.length - 1);
        address reporter = reporters[reporterIdx];

        address target = address(uint160(uint256(keccak256(abi.encode(targetSeed)))));
        if (target == address(0)) target = address(1);

        score = bound(score, 1, 100);

        SentinelRegistry.AttackPlaybook memory playbook = SentinelRegistry.AttackPlaybook({
            triggeredRules: "FUZZ_RULE",
            functionSelector: bytes4(0xdeadbeef),
            calldataHash: keccak256(abi.encode(targetSeed, score)),
            escalationLevel: "REPORT",
            llmUsed: score > 50,
            llmConfidence: score > 50 ? score : 0
        });

        vm.prank(reporter);
        registry.reportThreatWithPlaybook(target, score, "FUZZ", "fuzz-evidence", playbook);

        ghost_scoreSum[target] += score;
        ghost_reportCount[target]++;
        ghost_totalReports++;
        ghost_totalPlaybooks++;

        if (!ghost_targetSeen[target]) {
            ghost_targetSeen[target] = true;
            ghost_targets.push(target);
        }
    }

    function getTargetCount() external view returns (uint256) {
        return ghost_targets.length;
    }
}
