// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../src/SentinelRegistry.sol";
import "./RegistryHandler.sol";

/// @title SentinelRegistry Invariant Tests
/// @notice Verifies properties that must hold after any sequence of reports.
///
/// Key invariants:
///   1. Aggregate score always in [0, 100]
///   2. Blacklist is monotonic (once blacklisted, always blacklisted)
///   3. totalReports matches the sum of all per-contract reportCounts
///   4. Aggregate score ≥ 90 implies blacklisted
///   5. Report count consistency
contract SentinelRegistryInvariantTest is Test {
    SentinelRegistry public registry;
    RegistryHandler public handler;

    address public reporter1 = makeAddr("reporter1");
    address public reporter2 = makeAddr("reporter2");
    address public reporter3 = makeAddr("reporter3");

    // Track which contracts were blacklisted at any point
    mapping(address => bool) private wasBlacklisted;

    function setUp() public {
        registry = new SentinelRegistry();
        registry.addReporter(reporter1);
        registry.addReporter(reporter2);
        registry.addReporter(reporter3);

        address[] memory reporters = new address[](3);
        reporters[0] = reporter1;
        reporters[1] = reporter2;
        reporters[2] = reporter3;

        handler = new RegistryHandler(registry, address(this), reporters);
        targetContract(address(handler));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 1 — AGGREGATE SCORE BOUNDS
    // Score is a weighted average of values in [1, 100], so the result
    // must always be in [0, 100]. A score > 100 would corrupt blacklist
    // logic. A score of 0 is valid (no reports yet).
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_aggregateScoreInBounds() public view {
        uint256 count = handler.getTargetCount();
        for (uint256 i = 0; i < count; i++) {
            address target = handler.ghost_targets(i);
            uint256 score = registry.aggregateScore(target);
            assertTrue(score <= 100, "Aggregate score > 100");
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 2 — BLACKLIST MONOTONICITY
    // Once a contract is blacklisted, it stays blacklisted forever.
    // There is no removeFromBlacklist function. This ensures the
    // on-chain blacklist is a permanent record of dangerous contracts.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_blacklistIsMonotonic() public {
        uint256 count = handler.getTargetCount();
        for (uint256 i = 0; i < count; i++) {
            address target = handler.ghost_targets(i);
            bool currentlyBlacklisted = registry.isBlacklisted(target);

            if (wasBlacklisted[target]) {
                assertTrue(
                    currentlyBlacklisted,
                    "Blacklist reversed - was blacklisted then un-blacklisted"
                );
            }

            if (currentlyBlacklisted) {
                wasBlacklisted[target] = true;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 3 — TOTAL REPORTS CONSISTENCY
    // totalReports must equal the sum of all per-contract reportCounts.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_totalReportsConsistency() public view {
        uint256 sum = 0;
        uint256 count = handler.getTargetCount();
        for (uint256 i = 0; i < count; i++) {
            address target = handler.ghost_targets(i);
            sum += registry.reportCount(target);
        }
        assertEq(registry.totalReports(), sum, "totalReports != sum of per-contract counts");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 4 — BLACKLIST THRESHOLD ENFORCEMENT
    // If aggregateScore >= 90, the contract MUST be blacklisted.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_highScoreImpliesBlacklisted() public view {
        uint256 count = handler.getTargetCount();
        for (uint256 i = 0; i < count; i++) {
            address target = handler.ghost_targets(i);
            if (registry.aggregateScore(target) >= 90) {
                assertTrue(
                    registry.isBlacklisted(target),
                    "Contract has score >= 90 but is not blacklisted"
                );
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 5 — REPORT COUNT MATCHES GHOST
    // The on-chain reportCount for each target must match our ghost count.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_reportCountMatchesGhost() public view {
        uint256 count = handler.getTargetCount();
        for (uint256 i = 0; i < count; i++) {
            address target = handler.ghost_targets(i);
            assertEq(
                registry.reportCount(target),
                handler.ghost_reportCount(target),
                "On-chain report count diverged from ghost"
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 6 — OWNER IMMUTABILITY
    // SentinelRegistry has no transferOwnership. Owner never changes.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_ownerNeverChanges() public view {
        assertEq(registry.owner(), address(this), "Owner changed - should be immutable");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // INVARIANT 7 — PLAYBOOK COUNT CONSISTENCY
    // totalPlaybooks must equal the sum of per-contract playbook counts.
    // Playbook count for a contract must never exceed its report count.
    // ═══════════════════════════════════════════════════════════════════════

    function invariant_playbookCountConsistency() public view {
        uint256 sum = 0;
        uint256 count = handler.getTargetCount();
        for (uint256 i = 0; i < count; i++) {
            address target = handler.ghost_targets(i);
            uint256 pbCount = registry.getPlaybookCount(target);
            sum += pbCount;
            assertTrue(
                pbCount <= registry.reportCount(target),
                "Playbook count exceeds report count"
            );
        }
        assertEq(registry.totalPlaybooks(), sum, "totalPlaybooks != sum of per-contract counts");
    }
}
