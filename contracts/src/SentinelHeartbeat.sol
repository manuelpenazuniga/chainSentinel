// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SentinelHeartbeat
/// @notice On-chain liveness proof for the ChainSentinel AI agent.
///         The agent calls ping() every N blocks to prove it is alive and monitoring.
///         Anyone can call isAlive() to verify the agent's operational status.
/// @dev Minimal gas design: ping() writes 3 storage slots (~60K gas).
contract SentinelHeartbeat {
    // ─── State Variables ───

    /// @notice The owner who deployed the contract and controls agent registration
    address public owner;

    /// @notice The registered agent address (the only address that can ping)
    address public agent;

    /// @notice Block number of the most recent ping
    uint256 public lastPingBlock;

    /// @notice Timestamp of the most recent ping
    uint256 public lastPingTimestamp;

    /// @notice Total number of pings since deployment
    uint256 public pingCount;

    /// @notice Maximum blocks between pings before the agent is considered stale.
    ///         Default: 100 blocks (~10 minutes at 6s/block).
    uint256 public stalenessThreshold;

    // ─── Events ───

    /// @notice Emitted every time the agent pings
    event Heartbeat(
        address indexed agent,
        uint256 blockNumber,
        uint256 timestamp,
        uint256 pingCount
    );

    /// @notice Emitted when the agent address is updated
    event AgentUpdated(address indexed oldAgent, address indexed newAgent);

    /// @notice Emitted when the staleness threshold is updated
    event StalenessThresholdUpdated(uint256 newThreshold);

    // ─── Errors ───

    error NotOwner();
    error NotAgent();
    error ZeroAddress();
    error ZeroThreshold();

    // ─── Modifiers ───

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    // ─── Constructor ───

    /// @param _agent The initial agent address authorized to ping
    /// @param _stalenessThreshold Max blocks between pings (0 defaults to 100)
    constructor(address _agent, uint256 _stalenessThreshold) {
        if (_agent == address(0)) revert ZeroAddress();
        owner = msg.sender;
        agent = _agent;
        stalenessThreshold = _stalenessThreshold > 0 ? _stalenessThreshold : 100;
    }

    // ─── Agent Function ───

    /// @notice Record a heartbeat. Only callable by the registered agent.
    function ping() external onlyAgent {
        lastPingBlock = block.number;
        lastPingTimestamp = block.timestamp;
        pingCount++;

        emit Heartbeat(msg.sender, block.number, block.timestamp, pingCount);
    }

    // ─── Owner Functions ───

    /// @notice Update the registered agent address
    /// @param _agent The new agent address
    function setAgent(address _agent) external onlyOwner {
        if (_agent == address(0)) revert ZeroAddress();
        address old = agent;
        agent = _agent;
        emit AgentUpdated(old, _agent);
    }

    /// @notice Update the staleness threshold
    /// @param _threshold Max blocks between pings
    function setStalenessThreshold(uint256 _threshold) external onlyOwner {
        if (_threshold == 0) revert ZeroThreshold();
        stalenessThreshold = _threshold;
        emit StalenessThresholdUpdated(_threshold);
    }

    // ─── View Functions ───

    /// @notice Check if the agent is alive (pinged within stalenessThreshold blocks)
    /// @return alive True if the agent pinged recently
    function isAlive() external view returns (bool alive) {
        if (lastPingBlock == 0) return false;
        return block.number <= lastPingBlock + stalenessThreshold;
    }

    /// @notice Check if the agent is alive with a custom staleness window
    /// @param maxStaleBlocks Custom max blocks since last ping
    /// @return alive True if the agent pinged within maxStaleBlocks
    function isAliveCustom(uint256 maxStaleBlocks) external view returns (bool alive) {
        if (lastPingBlock == 0) return false;
        return block.number <= lastPingBlock + maxStaleBlocks;
    }

    /// @notice Get the full agent status in a single call
    /// @return _agent The registered agent address
    /// @return _lastPingBlock Block number of last ping (0 = never pinged)
    /// @return _lastPingTimestamp Timestamp of last ping (0 = never pinged)
    /// @return _pingCount Total pings
    /// @return _alive Whether the agent is alive (within stalenessThreshold)
    /// @return _blocksSinceLastPing Blocks elapsed since last ping (0 if never pinged)
    function getStatus()
        external
        view
        returns (
            address _agent,
            uint256 _lastPingBlock,
            uint256 _lastPingTimestamp,
            uint256 _pingCount,
            bool _alive,
            uint256 _blocksSinceLastPing
        )
    {
        _agent = agent;
        _lastPingBlock = lastPingBlock;
        _lastPingTimestamp = lastPingTimestamp;
        _pingCount = pingCount;
        _alive = lastPingBlock > 0 && block.number <= lastPingBlock + stalenessThreshold;
        _blocksSinceLastPing = lastPingBlock > 0 ? block.number - lastPingBlock : 0;
    }
}
