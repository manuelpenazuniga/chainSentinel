// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SentinelRegistry.sol";

contract SentinelRegistryTest is Test {
    SentinelRegistry public registry;

    address public reporter1 = makeAddr("reporter1");
    address public reporter2 = makeAddr("reporter2");
    address public maliciousContract = makeAddr("malicious");

    // Re-declare events for expectEmit
    event ThreatReported(
        address indexed reporter, address indexed targetContract, uint256 threatScore, string attackType, uint256 blockNumber
    );
    event ContractBlacklisted(address indexed contractAddress, uint256 aggregateScore);

    function setUp() public {
        registry = new SentinelRegistry();
    }

    // ─── Report Tests ───

    function test_reportThreat() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 75, "FLASH_LOAN", "0xabc123");

        assertEq(registry.reportCount(maliciousContract), 1);
        assertEq(registry.aggregateScore(maliciousContract), 75);
        assertEq(registry.totalReports(), 1);
    }

    function test_reportThreat_multipleReports_averageScore() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 80, "FLASH_LOAN", "0xabc");

        vm.prank(reporter2);
        registry.reportThreat(maliciousContract, 60, "DRAIN", "0xdef");

        // Average: (80 + 60) / 2 = 70
        assertEq(registry.aggregateScore(maliciousContract), 70);
        assertEq(registry.reportCount(maliciousContract), 2);
    }

    function test_reportThreat_emitsEvent() public {
        vm.prank(reporter1);
        vm.expectEmit(true, true, false, true);
        emit ThreatReported(reporter1, maliciousContract, 75, "FLASH_LOAN", block.number);
        registry.reportThreat(maliciousContract, 75, "FLASH_LOAN", "0xabc");
    }

    function test_reportThreat_revertsIfInvalidScore() public {
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.InvalidScore.selector);
        registry.reportThreat(maliciousContract, 0, "FLASH_LOAN", "0xabc");

        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.InvalidScore.selector);
        registry.reportThreat(maliciousContract, 101, "FLASH_LOAN", "0xabc");
    }

    function test_reportThreat_revertsIfEmptyAttackType() public {
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.EmptyAttackType.selector);
        registry.reportThreat(maliciousContract, 75, "", "0xabc");
    }

    function test_reportThreat_revertsIfEmptyEvidence() public {
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.EmptyEvidence.selector);
        registry.reportThreat(maliciousContract, 75, "FLASH_LOAN", "");
    }

    function test_reportThreat_revertsIfZeroAddress() public {
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.ZeroAddress.selector);
        registry.reportThreat(address(0), 75, "FLASH_LOAN", "0xabc");
    }

    // ─── Blacklist Tests ───

    function test_autoBlacklist_singleHighScore() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 95, "DRAIN", "0xabc");

        assertTrue(registry.isBlacklisted(maliciousContract));
    }

    function test_autoBlacklist_multipleReportsReachThreshold() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 85, "FLASH_LOAN", "0xabc");
        assertFalse(registry.isBlacklisted(maliciousContract));

        vm.prank(reporter2);
        registry.reportThreat(maliciousContract, 95, "DRAIN", "0xdef");
        // Average: (85 + 95) / 2 = 90 => BLACKLISTED
        assertTrue(registry.isBlacklisted(maliciousContract));
    }

    function test_autoBlacklist_emitsEvent() public {
        vm.prank(reporter1);
        vm.expectEmit(true, false, false, true);
        emit ContractBlacklisted(maliciousContract, 95);
        registry.reportThreat(maliciousContract, 95, "DRAIN", "0xabc");
    }

    // ─── Query Tests ───

    function test_getReports_pagination() public {
        // Create 5 reports
        for (uint256 i = 1; i <= 5; i++) {
            vm.prank(reporter1);
            registry.reportThreat(maliciousContract, 50 + i, "DRAIN", "evidence");
        }

        // Get first 3
        SentinelRegistry.ThreatReport[] memory page1 = registry.getReports(maliciousContract, 0, 3);
        assertEq(page1.length, 3);
        assertEq(page1[0].threatScore, 51);

        // Get next 2
        SentinelRegistry.ThreatReport[] memory page2 = registry.getReports(maliciousContract, 3, 3);
        assertEq(page2.length, 2);
    }

    function test_getReports_emptyIfNoReports() public view {
        SentinelRegistry.ThreatReport[] memory reports = registry.getReports(maliciousContract, 0, 10);
        assertEq(reports.length, 0);
    }

    function test_getLatestReport() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 50, "FLASH_LOAN", "first");

        vm.prank(reporter2);
        registry.reportThreat(maliciousContract, 90, "DRAIN", "second");

        SentinelRegistry.ThreatReport memory latest = registry.getLatestReport(maliciousContract);
        assertEq(latest.threatScore, 90);
        assertEq(latest.reporter, reporter2);
    }

    function test_isBlacklisted_falseByDefault() public view {
        assertFalse(registry.isBlacklisted(maliciousContract));
    }
}
