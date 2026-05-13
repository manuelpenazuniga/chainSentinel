// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SentinelRegistry.sol";

contract SentinelRegistryTest is Test {
    SentinelRegistry public registry;

    address public deployer;
    address public reporter1 = makeAddr("reporter1");
    address public reporter2 = makeAddr("reporter2");
    address public unauthorized = makeAddr("unauthorized");
    address public maliciousContract = makeAddr("malicious");

    // Re-declare events for expectEmit
    event ThreatReported(
        address indexed reporter, address indexed targetContract, uint256 threatScore, string attackType, uint256 blockNumber
    );
    event ContractBlacklisted(address indexed contractAddress, uint256 aggregateScore);
    event ReporterAdded(address indexed reporter);
    event ReporterRemoved(address indexed reporter);

    function setUp() public {
        deployer = address(this);
        registry = new SentinelRegistry();
        // Authorize test reporters
        registry.addReporter(reporter1);
        registry.addReporter(reporter2);
    }

    // ─── Access Control Tests ───

    function test_owner_isDeployer() public view {
        assertEq(registry.owner(), deployer);
    }

    function test_deployer_isAuthorizedReporter() public view {
        assertTrue(registry.authorizedReporters(deployer));
    }

    function test_addReporter_onlyOwner() public {
        address newReporter = makeAddr("newReporter");
        registry.addReporter(newReporter);
        assertTrue(registry.authorizedReporters(newReporter));
    }

    function test_addReporter_revertsIfNotOwner() public {
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.NotOwner.selector);
        registry.addReporter(makeAddr("someone"));
    }

    function test_addReporter_revertsIfZeroAddress() public {
        vm.expectRevert(SentinelRegistry.ZeroAddress.selector);
        registry.addReporter(address(0));
    }

    function test_addReporter_emitsEvent() public {
        address newReporter = makeAddr("newReporter");
        vm.expectEmit(true, false, false, false);
        emit ReporterAdded(newReporter);
        registry.addReporter(newReporter);
    }

    function test_removeReporter_onlyOwner() public {
        registry.removeReporter(reporter1);
        assertFalse(registry.authorizedReporters(reporter1));
    }

    function test_removeReporter_revertsIfNotOwner() public {
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.NotOwner.selector);
        registry.removeReporter(reporter2);
    }

    function test_removeReporter_revertsIfZeroAddress() public {
        vm.expectRevert(SentinelRegistry.ZeroAddress.selector);
        registry.removeReporter(address(0));
    }

    function test_removeReporter_emitsEvent() public {
        vm.expectEmit(true, false, false, false);
        emit ReporterRemoved(reporter1);
        registry.removeReporter(reporter1);
    }

    function test_reportThreat_revertsIfNotAuthorized() public {
        vm.prank(unauthorized);
        vm.expectRevert(SentinelRegistry.NotAuthorizedReporter.selector);
        registry.reportThreat(maliciousContract, 75, "FLASH_LOAN", "0xabc123");
    }

    function test_reportThreat_revertsAfterRemoval() public {
        registry.removeReporter(reporter1);
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.NotAuthorizedReporter.selector);
        registry.reportThreat(maliciousContract, 75, "FLASH_LOAN", "0xabc123");
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

    // ─── Playbook Tests ───

    // Re-declare event for expectEmit
    event PlaybookSubmitted(
        address indexed reporter,
        address indexed targetContract,
        uint256 reportIndex,
        bytes4 functionSelector,
        string escalationLevel
    );

    function _samplePlaybook() internal pure returns (SentinelRegistry.AttackPlaybook memory) {
        return SentinelRegistry.AttackPlaybook({
            triggeredRules: "FLASH_LOAN_PATTERN,DRASTIC_BALANCE_CHANGE",
            functionSelector: bytes4(0xab9c4b5d),
            calldataHash: keccak256("sample-calldata"),
            escalationLevel: "EMERGENCY_WITHDRAW_ALL",
            llmUsed: true,
            llmConfidence: 85
        });
    }

    function test_reportThreatWithPlaybook() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);
        registry.reportThreatWithPlaybook(maliciousContract, 90, "FLASH_LOAN", "0xabc123", playbook);

        // Report should be stored
        assertEq(registry.reportCount(maliciousContract), 1);
        assertEq(registry.aggregateScore(maliciousContract), 90);
        assertEq(registry.totalReports(), 1);

        // Playbook should be stored
        assertTrue(registry.hasPlaybook(maliciousContract, 0));
        assertEq(registry.getPlaybookCount(maliciousContract), 1);
        assertEq(registry.totalPlaybooks(), 1);
    }

    function test_reportThreatWithPlaybook_playbookData() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);
        registry.reportThreatWithPlaybook(maliciousContract, 80, "FLASH_LOAN", "0xabc", playbook);

        SentinelRegistry.AttackPlaybook memory stored = registry.getPlaybook(maliciousContract, 0);

        assertEq(stored.triggeredRules, "FLASH_LOAN_PATTERN,DRASTIC_BALANCE_CHANGE");
        assertEq(stored.functionSelector, bytes4(0xab9c4b5d));
        assertEq(stored.calldataHash, keccak256("sample-calldata"));
        assertEq(stored.escalationLevel, "EMERGENCY_WITHDRAW_ALL");
        assertTrue(stored.llmUsed);
        assertEq(stored.llmConfidence, 85);
    }

    function test_reportThreatWithPlaybook_emitsBothEvents() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);

        // Expect ThreatReported
        vm.expectEmit(true, true, false, true);
        emit ThreatReported(reporter1, maliciousContract, 80, "FLASH_LOAN", block.number);

        // Expect PlaybookSubmitted
        vm.expectEmit(true, true, false, true);
        emit PlaybookSubmitted(reporter1, maliciousContract, 0, bytes4(0xab9c4b5d), "EMERGENCY_WITHDRAW_ALL");

        registry.reportThreatWithPlaybook(maliciousContract, 80, "FLASH_LOAN", "0xabc", playbook);
    }

    function test_reportThreatWithPlaybook_blacklists() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);
        registry.reportThreatWithPlaybook(maliciousContract, 95, "DRAIN", "0xabc", playbook);

        assertTrue(registry.isBlacklisted(maliciousContract));
    }

    function test_reportThreatWithPlaybook_revertsIfNotAuthorized() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(unauthorized);
        vm.expectRevert(SentinelRegistry.NotAuthorizedReporter.selector);
        registry.reportThreatWithPlaybook(maliciousContract, 80, "FLASH_LOAN", "0xabc", playbook);
    }

    function test_reportThreatWithPlaybook_revertsIfInvalidScore() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.InvalidScore.selector);
        registry.reportThreatWithPlaybook(maliciousContract, 0, "FLASH_LOAN", "0xabc", playbook);

        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.InvalidScore.selector);
        registry.reportThreatWithPlaybook(maliciousContract, 101, "FLASH_LOAN", "0xabc", playbook);
    }

    function test_reportThreatWithPlaybook_revertsIfZeroAddress() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.ZeroAddress.selector);
        registry.reportThreatWithPlaybook(address(0), 80, "FLASH_LOAN", "0xabc", playbook);
    }

    function test_reportThreatWithPlaybook_revertsIfEmptyAttackType() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.EmptyAttackType.selector);
        registry.reportThreatWithPlaybook(maliciousContract, 80, "", "0xabc", playbook);
    }

    function test_reportThreatWithPlaybook_revertsIfEmptyEvidence() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.EmptyEvidence.selector);
        registry.reportThreatWithPlaybook(maliciousContract, 80, "FLASH_LOAN", "", playbook);
    }

    function test_hasPlaybook_falseForNormalReport() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 75, "FLASH_LOAN", "0xabc");

        assertFalse(registry.hasPlaybook(maliciousContract, 0));
    }

    function test_getPlaybook_emptyForNormalReport() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 75, "FLASH_LOAN", "0xabc");

        SentinelRegistry.AttackPlaybook memory pb = registry.getPlaybook(maliciousContract, 0);
        assertEq(pb.triggeredRules, "");
        assertEq(pb.functionSelector, bytes4(0));
        assertEq(pb.calldataHash, bytes32(0));
        assertEq(pb.escalationLevel, "");
        assertFalse(pb.llmUsed);
        assertEq(pb.llmConfidence, 0);
    }

    function test_mixedReportsAndPlaybooks() public {
        // Report 0: normal (no playbook)
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 50, "DRAIN", "evidence0");

        // Report 1: with playbook
        SentinelRegistry.AttackPlaybook memory pb1 = SentinelRegistry.AttackPlaybook({
            triggeredRules: "TX_BURST",
            functionSelector: bytes4(0x12345678),
            calldataHash: keccak256("calldata1"),
            escalationLevel: "REPORT",
            llmUsed: false,
            llmConfidence: 0
        });
        vm.prank(reporter2);
        registry.reportThreatWithPlaybook(maliciousContract, 60, "REENTRANCY", "evidence1", pb1);

        // Report 2: normal (no playbook)
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 70, "DRAIN", "evidence2");

        // Report 3: with playbook
        SentinelRegistry.AttackPlaybook memory pb2 = _samplePlaybook();
        vm.prank(reporter2);
        registry.reportThreatWithPlaybook(maliciousContract, 80, "FLASH_LOAN", "evidence3", pb2);

        // Verify report count and playbook count
        assertEq(registry.reportCount(maliciousContract), 4);
        assertEq(registry.totalReports(), 4);
        assertEq(registry.getPlaybookCount(maliciousContract), 2);
        assertEq(registry.totalPlaybooks(), 2);

        // Verify hasPlaybook flags
        assertFalse(registry.hasPlaybook(maliciousContract, 0));
        assertTrue(registry.hasPlaybook(maliciousContract, 1));
        assertFalse(registry.hasPlaybook(maliciousContract, 2));
        assertTrue(registry.hasPlaybook(maliciousContract, 3));

        // Verify playbook data for report 1
        SentinelRegistry.AttackPlaybook memory stored1 = registry.getPlaybook(maliciousContract, 1);
        assertEq(stored1.triggeredRules, "TX_BURST");
        assertEq(stored1.functionSelector, bytes4(0x12345678));
        assertEq(stored1.escalationLevel, "REPORT");
        assertFalse(stored1.llmUsed);

        // Verify playbook data for report 3
        SentinelRegistry.AttackPlaybook memory stored3 = registry.getPlaybook(maliciousContract, 3);
        assertEq(stored3.triggeredRules, "FLASH_LOAN_PATTERN,DRASTIC_BALANCE_CHANGE");
        assertEq(stored3.functionSelector, bytes4(0xab9c4b5d));
        assertEq(stored3.escalationLevel, "EMERGENCY_WITHDRAW_ALL");
        assertTrue(stored3.llmUsed);
        assertEq(stored3.llmConfidence, 85);
    }

    function test_getPlaybooks_pagination() public {
        SentinelRegistry.AttackPlaybook memory pb = _samplePlaybook();

        // Submit 5 reports with playbooks
        for (uint256 i = 0; i < 5; i++) {
            vm.prank(reporter1);
            registry.reportThreatWithPlaybook(
                maliciousContract, 50 + uint256(i), "DRAIN", "evidence", pb
            );
        }

        // Get first 3
        SentinelRegistry.AttackPlaybook[] memory page1 = registry.getPlaybooks(maliciousContract, 0, 3);
        assertEq(page1.length, 3);

        // Get remaining 2
        SentinelRegistry.AttackPlaybook[] memory page2 = registry.getPlaybooks(maliciousContract, 3, 10);
        assertEq(page2.length, 2);

        // Out of bounds offset
        SentinelRegistry.AttackPlaybook[] memory page3 = registry.getPlaybooks(maliciousContract, 10, 5);
        assertEq(page3.length, 0);
    }

    function test_getPlaybookCount_zeroByDefault() public view {
        assertEq(registry.getPlaybookCount(maliciousContract), 0);
    }

    function test_reportThreatWithPlaybook_llmNotUsed() public {
        SentinelRegistry.AttackPlaybook memory playbook = SentinelRegistry.AttackPlaybook({
            triggeredRules: "ANOMALOUS_VALUE,FRESH_CONTRACT",
            functionSelector: bytes4(0xa9059cbb),
            calldataHash: keccak256("some-calldata"),
            escalationLevel: "DEFENSIVE_WITHDRAW",
            llmUsed: false,
            llmConfidence: 0
        });

        vm.prank(reporter1);
        registry.reportThreatWithPlaybook(maliciousContract, 75, "DRAIN", "0xabc", playbook);

        SentinelRegistry.AttackPlaybook memory stored = registry.getPlaybook(maliciousContract, 0);
        assertFalse(stored.llmUsed);
        assertEq(stored.llmConfidence, 0);
    }

    function test_reportThreatWithPlaybook_aggregateScoreAverage() public {
        SentinelRegistry.AttackPlaybook memory playbook = _samplePlaybook();

        // Report via reportThreat: score 80
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 80, "DRAIN", "0xabc");

        // Report via reportThreatWithPlaybook: score 60
        vm.prank(reporter2);
        registry.reportThreatWithPlaybook(maliciousContract, 60, "FLASH_LOAN", "0xdef", playbook);

        // Average: (80 + 60) / 2 = 70
        assertEq(registry.aggregateScore(maliciousContract), 70);
        assertEq(registry.reportCount(maliciousContract), 2);
    }

    // ─── Report TTL & Recompute (§2.6) ───────────────────────────────────

    event ReportTTLUpdated(uint256 newTTL);
    event AggregateScoreRecomputed(
        address indexed contractAddress,
        uint256 previousScore,
        uint256 newScore,
        uint256 freshReportCount,
        bool blacklistChanged
    );
    event ContractUnblacklisted(address indexed contractAddress, uint256 aggregateScore);

    function test_reportTTL_defaultIsZero() public view {
        assertEq(registry.reportTTL(), 0, "TTL must default to 0 (disabled)");
    }

    function test_setReportTTL_updatesValue() public {
        registry.setReportTTL(432_000); // ~30 days at 6s/block
        assertEq(registry.reportTTL(), 432_000);
    }

    function test_setReportTTL_emitsEvent() public {
        vm.expectEmit(false, false, false, true);
        emit ReportTTLUpdated(100_800);
        registry.setReportTTL(100_800);
    }

    function test_setReportTTL_revertsIfNotOwner() public {
        vm.prank(reporter1);
        vm.expectRevert(SentinelRegistry.NotOwner.selector);
        registry.setReportTTL(1000);
    }

    function test_getThreatScoreFresh_ttlDisabledReturnsStoredAggregate() public {
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 70, "DRAIN", "0xabc");

        (uint256 fresh, uint256 freshCount, uint256 totalCount) = registry.getThreatScoreFresh(maliciousContract);
        assertEq(fresh, 70);
        assertEq(freshCount, 1);
        assertEq(totalCount, 1);
    }

    function test_getThreatScoreFresh_ignoresExpiredReports() public {
        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 90, "DRAIN", "0xabc");

        registry.setReportTTL(50);

        // At block 200, the report (from block 100) is 100 blocks old → expired (TTL=50)
        vm.roll(200);

        (uint256 fresh, uint256 freshCount, uint256 totalCount) = registry.getThreatScoreFresh(maliciousContract);
        assertEq(fresh, 0, "expired report should not contribute");
        assertEq(freshCount, 0);
        assertEq(totalCount, 1);
    }

    function test_getThreatScoreFresh_keepsReportAtTTLBoundary() public {
        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 80, "DRAIN", "0xabc");

        registry.setReportTTL(50);
        vm.roll(150); // 100 + 50 == 150 → boundary, fresh

        (uint256 fresh, uint256 freshCount,) = registry.getThreatScoreFresh(maliciousContract);
        assertEq(fresh, 80, "report at TTL boundary still fresh");
        assertEq(freshCount, 1);
    }

    function test_getThreatScoreFresh_mixedFreshAndExpired() public {
        registry.setReportTTL(100);

        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 50, "DRAIN", "old");

        vm.roll(150);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 90, "DRAIN", "recent");

        // At block 250: report at 100 → 100+100=200 < 250 → expired.
        //               report at 150 → 150+100=250 >= 250 → fresh (boundary).
        vm.roll(250);

        (uint256 fresh, uint256 freshCount, uint256 totalCount) = registry.getThreatScoreFresh(maliciousContract);
        assertEq(fresh, 90, "only fresh report should count");
        assertEq(freshCount, 1);
        assertEq(totalCount, 2);
    }

    function test_getThreatScoreFresh_emptyContract() public view {
        (uint256 fresh, uint256 freshCount, uint256 totalCount) = registry.getThreatScoreFresh(maliciousContract);
        assertEq(fresh, 0);
        assertEq(freshCount, 0);
        assertEq(totalCount, 0);
    }

    function test_recomputeAggregateScore_updatesStoredAggregate() public {
        registry.setReportTTL(100);

        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 60, "DRAIN", "old1");
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 80, "DRAIN", "old2");

        // Both reports at block 100; both fresh now → average 70
        assertEq(registry.aggregateScore(maliciousContract), 70);

        // Advance well past TTL
        vm.roll(250);
        registry.recomputeAggregateScore(maliciousContract);

        // Both expired → aggregate drops to 0
        assertEq(registry.aggregateScore(maliciousContract), 0);
    }

    function test_recomputeAggregateScore_unblacklistsWhenScoreDrops() public {
        // Single report at 95 → auto-blacklist (>= 90)
        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 95, "DRAIN", "critical");
        assertTrue(registry.blacklisted(maliciousContract));

        // TTL=50; advance past expiry
        registry.setReportTTL(50);
        vm.roll(200);

        vm.expectEmit(true, false, false, true);
        emit ContractUnblacklisted(maliciousContract, 0);
        registry.recomputeAggregateScore(maliciousContract);

        assertFalse(registry.blacklisted(maliciousContract));
        assertEq(registry.aggregateScore(maliciousContract), 0);
    }

    function test_recomputeAggregateScore_blacklistsViaFreshReports() public {
        // Setup: stored aggregate is somehow below threshold despite fresh high-score
        // reports. We achieve this by manipulating: report low, then high — running avg
        // is mid; but if we expire the low report via TTL, fresh avg jumps to high.
        registry.setReportTTL(100);

        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 50, "DRAIN", "low");

        vm.roll(150);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 95, "DRAIN", "high");

        // Stored running avg: (50 + 95) / 2 = 72 → not blacklisted
        assertEq(registry.aggregateScore(maliciousContract), 72);
        assertFalse(registry.blacklisted(maliciousContract));

        // Move forward: low report (block 100) expires (TTL=100, now block 220 > 200);
        // high report (block 150) still fresh (150+100=250 >= 220).
        vm.roll(220);
        registry.recomputeAggregateScore(maliciousContract);

        // Fresh avg = 95 → should auto-blacklist
        assertEq(registry.aggregateScore(maliciousContract), 95);
        assertTrue(registry.blacklisted(maliciousContract), "should be blacklisted via recompute");
    }

    function test_recomputeAggregateScore_emitsEvent() public {
        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 70, "DRAIN", "x");

        // No TTL: stored aggregate already 70; recompute confirms it.
        vm.expectEmit(true, false, false, true);
        emit AggregateScoreRecomputed(maliciousContract, 70, 70, 1, false);
        registry.recomputeAggregateScore(maliciousContract);
    }

    function test_recomputeAggregateScore_revertsOnZeroAddress() public {
        vm.expectRevert(SentinelRegistry.ZeroAddress.selector);
        registry.recomputeAggregateScore(address(0));
    }

    function test_recomputeAggregateScore_callableByAnyone() public {
        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 70, "DRAIN", "x");

        // Anyone (not just owner / reporter) can call — pays own gas
        vm.prank(unauthorized);
        registry.recomputeAggregateScore(maliciousContract);
    }

    function test_recomputeAggregateScore_emptyContractIsNoOp() public {
        registry.recomputeAggregateScore(maliciousContract);
        assertEq(registry.aggregateScore(maliciousContract), 0);
        assertFalse(registry.blacklisted(maliciousContract));
    }

    function test_reportThreat_unaffectedByTTL() public {
        // Documented behavior: reportThreat keeps using the running average even when
        // TTL is set. TTL only applies to recompute and getThreatScoreFresh — this
        // keeps the hot path (reportThreat) cheap and predictable.
        registry.setReportTTL(1);

        vm.roll(100);
        vm.prank(reporter1);
        registry.reportThreat(maliciousContract, 80, "DRAIN", "x");

        assertEq(registry.aggregateScore(maliciousContract), 80, "running avg unaffected by TTL");
    }
}
