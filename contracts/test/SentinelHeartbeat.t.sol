// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../src/SentinelHeartbeat.sol";

contract SentinelHeartbeatTest is Test {
    SentinelHeartbeat public heartbeat;

    address owner = address(this);
    address agent = address(0xA1);
    address stranger = address(0xBB);

    // Mirror events for expectEmit
    event Heartbeat(address indexed agent, uint256 blockNumber, uint256 timestamp, uint256 pingCount);
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);
    event StalenessThresholdUpdated(uint256 newThreshold);

    function setUp() public {
        heartbeat = new SentinelHeartbeat(agent, 100);
    }

    // ─── Constructor ───

    function test_constructor_sets_owner() public view {
        assertEq(heartbeat.owner(), owner);
    }

    function test_constructor_sets_agent() public view {
        assertEq(heartbeat.agent(), agent);
    }

    function test_constructor_sets_staleness_threshold() public view {
        assertEq(heartbeat.stalenessThreshold(), 100);
    }

    function test_constructor_default_staleness_when_zero() public {
        SentinelHeartbeat hb = new SentinelHeartbeat(agent, 0);
        assertEq(hb.stalenessThreshold(), 100);
    }

    function test_constructor_reverts_zero_agent() public {
        vm.expectRevert(SentinelHeartbeat.ZeroAddress.selector);
        new SentinelHeartbeat(address(0), 100);
    }

    function test_constructor_initial_state() public view {
        assertEq(heartbeat.lastPingBlock(), 0);
        assertEq(heartbeat.lastPingTimestamp(), 0);
        assertEq(heartbeat.pingCount(), 0);
    }

    // ─── ping() ───

    function test_ping_updates_state() public {
        vm.prank(agent);
        heartbeat.ping();

        assertEq(heartbeat.lastPingBlock(), block.number);
        assertEq(heartbeat.lastPingTimestamp(), block.timestamp);
        assertEq(heartbeat.pingCount(), 1);
    }

    function test_ping_increments_count() public {
        vm.startPrank(agent);
        heartbeat.ping();
        heartbeat.ping();
        heartbeat.ping();
        vm.stopPrank();

        assertEq(heartbeat.pingCount(), 3);
    }

    function test_ping_emits_heartbeat_event() public {
        vm.prank(agent);
        vm.expectEmit(true, false, false, true);
        emit Heartbeat(agent, block.number, block.timestamp, 1);
        heartbeat.ping();
    }

    function test_ping_updates_block_number_on_new_block() public {
        vm.prank(agent);
        heartbeat.ping();
        uint256 firstBlock = block.number;

        vm.roll(block.number + 50);

        vm.prank(agent);
        heartbeat.ping();
        assertEq(heartbeat.lastPingBlock(), firstBlock + 50);
        assertEq(heartbeat.pingCount(), 2);
    }

    function test_ping_reverts_for_non_agent() public {
        vm.prank(stranger);
        vm.expectRevert(SentinelHeartbeat.NotAgent.selector);
        heartbeat.ping();
    }

    function test_ping_reverts_for_owner_who_is_not_agent() public {
        vm.prank(owner);
        vm.expectRevert(SentinelHeartbeat.NotAgent.selector);
        heartbeat.ping();
    }

    // ─── isAlive() ───

    function test_isAlive_false_before_first_ping() public view {
        assertFalse(heartbeat.isAlive());
    }

    function test_isAlive_true_immediately_after_ping() public {
        vm.prank(agent);
        heartbeat.ping();
        assertTrue(heartbeat.isAlive());
    }

    function test_isAlive_true_within_threshold() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 99);
        assertTrue(heartbeat.isAlive());
    }

    function test_isAlive_true_at_exact_threshold() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 100);
        assertTrue(heartbeat.isAlive());
    }

    function test_isAlive_false_beyond_threshold() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 101);
        assertFalse(heartbeat.isAlive());
    }

    function test_isAlive_recovers_after_new_ping() public {
        vm.prank(agent);
        heartbeat.ping();

        // Go stale
        vm.roll(block.number + 200);
        assertFalse(heartbeat.isAlive());

        // Recover
        vm.prank(agent);
        heartbeat.ping();
        assertTrue(heartbeat.isAlive());
    }

    // ─── isAliveCustom() ───

    function test_isAliveCustom_with_shorter_window() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 10);
        assertTrue(heartbeat.isAliveCustom(10));

        vm.roll(block.number + 1);
        assertFalse(heartbeat.isAliveCustom(10));
    }

    function test_isAliveCustom_with_longer_window() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 500);
        assertFalse(heartbeat.isAlive()); // default threshold 100
        assertTrue(heartbeat.isAliveCustom(1000)); // custom 1000
    }

    function test_isAliveCustom_false_before_first_ping() public view {
        assertFalse(heartbeat.isAliveCustom(1000));
    }

    // ─── getStatus() ───

    function test_getStatus_before_ping() public view {
        (
            address _agent,
            uint256 _lastPingBlock,
            uint256 _lastPingTimestamp,
            uint256 _pingCount,
            bool _alive,
            uint256 _blocksSinceLastPing
        ) = heartbeat.getStatus();

        assertEq(_agent, agent);
        assertEq(_lastPingBlock, 0);
        assertEq(_lastPingTimestamp, 0);
        assertEq(_pingCount, 0);
        assertFalse(_alive);
        assertEq(_blocksSinceLastPing, 0);
    }

    function test_getStatus_after_ping() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 30);

        (
            address _agent,
            uint256 _lastPingBlock,
            ,
            uint256 _pingCount,
            bool _alive,
            uint256 _blocksSinceLastPing
        ) = heartbeat.getStatus();

        assertEq(_agent, agent);
        assertEq(_lastPingBlock, block.number - 30);
        assertEq(_pingCount, 1);
        assertTrue(_alive);
        assertEq(_blocksSinceLastPing, 30);
    }

    function test_getStatus_stale_agent() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 200);

        (, , , , bool _alive, uint256 _blocksSinceLastPing) = heartbeat.getStatus();

        assertFalse(_alive);
        assertEq(_blocksSinceLastPing, 200);
    }

    // ─── setAgent() ───

    function test_setAgent_by_owner() public {
        address newAgent = address(0xC3);
        heartbeat.setAgent(newAgent);
        assertEq(heartbeat.agent(), newAgent);
    }

    function test_setAgent_emits_event() public {
        address newAgent = address(0xC3);
        vm.expectEmit(true, true, false, false);
        emit AgentUpdated(agent, newAgent);
        heartbeat.setAgent(newAgent);
    }

    function test_setAgent_new_agent_can_ping() public {
        address newAgent = address(0xC3);
        heartbeat.setAgent(newAgent);

        vm.prank(newAgent);
        heartbeat.ping();
        assertEq(heartbeat.pingCount(), 1);
    }

    function test_setAgent_old_agent_cannot_ping() public {
        heartbeat.setAgent(address(0xC3));

        vm.prank(agent);
        vm.expectRevert(SentinelHeartbeat.NotAgent.selector);
        heartbeat.ping();
    }

    function test_setAgent_reverts_zero_address() public {
        vm.expectRevert(SentinelHeartbeat.ZeroAddress.selector);
        heartbeat.setAgent(address(0));
    }

    function test_setAgent_reverts_for_non_owner() public {
        vm.prank(stranger);
        vm.expectRevert(SentinelHeartbeat.NotOwner.selector);
        heartbeat.setAgent(address(0xC3));
    }

    // ─── setStalenessThreshold() ───

    function test_setStalenessThreshold() public {
        heartbeat.setStalenessThreshold(500);
        assertEq(heartbeat.stalenessThreshold(), 500);
    }

    function test_setStalenessThreshold_affects_isAlive() public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + 150);
        assertFalse(heartbeat.isAlive()); // default 100 exceeded

        heartbeat.setStalenessThreshold(200);
        assertTrue(heartbeat.isAlive()); // new threshold 200 not exceeded
    }

    function test_setStalenessThreshold_emits_event() public {
        vm.expectEmit(false, false, false, true);
        emit StalenessThresholdUpdated(500);
        heartbeat.setStalenessThreshold(500);
    }

    function test_setStalenessThreshold_reverts_zero() public {
        vm.expectRevert(SentinelHeartbeat.ZeroThreshold.selector);
        heartbeat.setStalenessThreshold(0);
    }

    function test_setStalenessThreshold_reverts_non_owner() public {
        vm.prank(stranger);
        vm.expectRevert(SentinelHeartbeat.NotOwner.selector);
        heartbeat.setStalenessThreshold(500);
    }

    // ─── Fuzz tests ───

    function testFuzz_ping_always_updates_block(uint8 rolls) public {
        vm.prank(agent);
        heartbeat.ping();

        vm.roll(block.number + uint256(rolls));

        vm.prank(agent);
        heartbeat.ping();

        assertEq(heartbeat.lastPingBlock(), block.number);
        assertEq(heartbeat.pingCount(), 2);
    }

    function testFuzz_isAlive_respects_threshold(uint8 elapsed, uint8 threshold) public {
        vm.assume(threshold > 0);

        SentinelHeartbeat hb = new SentinelHeartbeat(agent, uint256(threshold));

        vm.prank(agent);
        hb.ping();

        vm.roll(block.number + uint256(elapsed));

        if (uint256(elapsed) <= uint256(threshold)) {
            assertTrue(hb.isAlive());
        } else {
            assertFalse(hb.isAlive());
        }
    }
}
