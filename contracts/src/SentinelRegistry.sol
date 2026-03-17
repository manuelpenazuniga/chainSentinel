// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SentinelRegistry
/// @notice A public, community-driven threat registry for smart contracts on Polkadot Hub.
///         Any address can report threats. Aggregate scores are computed per contract,
///         and contracts exceeding the blacklist threshold are automatically flagged.
contract SentinelRegistry {
    // ─── Data Structures ───

    struct ThreatReport {
        address reporter;
        address targetContract;
        uint256 threatScore;
        string attackType;
        string evidence;
        uint256 timestamp;
        uint256 blockNumber;
    }

    // ─── State Variables ───

    /// @notice All reports for a given contract address
    mapping(address => ThreatReport[]) private _reportsByContract;

    /// @notice Running weighted average score for a given contract
    mapping(address => uint256) public aggregateScore;

    /// @notice Number of reports for a given contract
    mapping(address => uint256) public reportCount;

    /// @notice Whether a contract has been auto-blacklisted
    mapping(address => bool) public blacklisted;

    /// @notice Total number of reports across all contracts
    uint256 public totalReports;

    /// @notice Aggregate score threshold for auto-blacklisting
    uint256 public constant BLACKLIST_THRESHOLD = 90;

    // ─── Events ───

    event ThreatReported(
        address indexed reporter,
        address indexed targetContract,
        uint256 threatScore,
        string attackType,
        uint256 blockNumber
    );

    event ContractBlacklisted(address indexed contractAddress, uint256 aggregateScore);

    // ─── Errors ───

    error InvalidScore();
    error EmptyAttackType();
    error EmptyEvidence();
    error ZeroAddress();

    // ─── Functions ───

    /// @notice Report a detected threat against a smart contract
    /// @param targetContract The contract address identified as a threat
    /// @param threatScore The threat score (1-100) assigned by the reporter
    /// @param attackType Classification of the attack (e.g., "FLASH_LOAN", "REENTRANCY")
    /// @param evidence Transaction hash or description serving as evidence
    function reportThreat(address targetContract, uint256 threatScore, string calldata attackType, string calldata evidence)
        external
    {
        if (targetContract == address(0)) revert ZeroAddress();
        if (threatScore == 0 || threatScore > 100) revert InvalidScore();
        if (bytes(attackType).length == 0) revert EmptyAttackType();
        if (bytes(evidence).length == 0) revert EmptyEvidence();

        ThreatReport memory report = ThreatReport({
            reporter: msg.sender,
            targetContract: targetContract,
            threatScore: threatScore,
            attackType: attackType,
            evidence: evidence,
            timestamp: block.timestamp,
            blockNumber: block.number
        });

        _reportsByContract[targetContract].push(report);
        reportCount[targetContract]++;
        totalReports++;

        // Update aggregate score using running weighted average
        // Formula: newAvg = ((oldAvg * (count - 1)) + newScore) / count
        uint256 count = reportCount[targetContract];
        aggregateScore[targetContract] = ((aggregateScore[targetContract] * (count - 1)) + threatScore) / count;

        // Auto-blacklist if aggregate score exceeds threshold
        if (aggregateScore[targetContract] >= BLACKLIST_THRESHOLD && !blacklisted[targetContract]) {
            blacklisted[targetContract] = true;
            emit ContractBlacklisted(targetContract, aggregateScore[targetContract]);
        }

        emit ThreatReported(msg.sender, targetContract, threatScore, attackType, block.number);
    }

    /// @notice Get the aggregate threat score for a contract
    /// @param contractAddress The contract to query
    /// @return The aggregate score (0-100), or 0 if no reports exist
    function getThreatScore(address contractAddress) external view returns (uint256) {
        return aggregateScore[contractAddress];
    }

    /// @notice Check if a contract is blacklisted
    /// @param contractAddress The contract to query
    /// @return True if the contract is blacklisted
    function isBlacklisted(address contractAddress) external view returns (bool) {
        return blacklisted[contractAddress];
    }

    /// @notice Get the number of reports for a contract
    /// @param contractAddress The contract to query
    /// @return The number of reports
    function getReportCount(address contractAddress) external view returns (uint256) {
        return reportCount[contractAddress];
    }

    /// @notice Get paginated threat reports for a contract
    /// @param contractAddress The contract to query
    /// @param offset Starting index (0-based)
    /// @param limit Maximum number of reports to return
    /// @return reports Array of ThreatReport structs
    function getReports(address contractAddress, uint256 offset, uint256 limit)
        external
        view
        returns (ThreatReport[] memory reports)
    {
        ThreatReport[] storage allReports = _reportsByContract[contractAddress];
        uint256 total = allReports.length;

        if (offset >= total) return new ThreatReport[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 resultLength = end - offset;

        reports = new ThreatReport[](resultLength);
        for (uint256 i = 0; i < resultLength; i++) {
            reports[i] = allReports[offset + i];
        }
    }

    /// @notice Get the most recent report for a contract
    /// @param contractAddress The contract to query
    /// @return The most recent ThreatReport, or an empty struct if no reports exist
    function getLatestReport(address contractAddress) external view returns (ThreatReport memory) {
        ThreatReport[] storage allReports = _reportsByContract[contractAddress];
        if (allReports.length == 0) {
            return ThreatReport(address(0), address(0), 0, "", "", 0, 0);
        }
        return allReports[allReports.length - 1];
    }
}
