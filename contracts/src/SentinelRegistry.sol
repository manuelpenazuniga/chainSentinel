// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SentinelRegistry
/// @notice An access-controlled threat registry for smart contracts on Polkadot Hub.
///         Only authorized reporters (e.g., AI agents) can submit threats.
///         Aggregate scores are computed per contract, and contracts exceeding
///         the blacklist threshold are automatically flagged.
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

    /// @notice Structured attack playbook stored alongside a threat report.
    ///         Enables collective security: other agents, dashboards, and contracts
    ///         can consume these playbooks to improve their own detection.
    struct AttackPlaybook {
        /// @dev Comma-separated list of heuristic rule names that triggered
        ///      (e.g., "FLASH_LOAN_PATTERN,DRASTIC_BALANCE_CHANGE")
        string triggeredRules;
        /// @dev The 4-byte function selector of the suspicious call
        ///      (e.g., 0xab9c4b5d for Aave V2 flashLoan)
        bytes4 functionSelector;
        /// @dev keccak256 hash of the full calldata — allows correlation
        ///      without storing the (potentially large) raw calldata on-chain
        bytes32 calldataHash;
        /// @dev The escalation level chosen by the agent
        ///      (e.g., "REPORT", "DEFENSIVE_WITHDRAW", "EMERGENCY_WITHDRAW_ALL")
        string escalationLevel;
        /// @dev Whether the LLM was used for this assessment (true = dual-layer)
        bool llmUsed;
        /// @dev The LLM confidence percentage (0-100), or 0 if LLM was not used
        uint256 llmConfidence;
    }

    // ─── State Variables ───

    /// @notice Contract owner (deployer)
    address public owner;

    /// @notice Addresses authorized to submit threat reports
    mapping(address => bool) public authorizedReporters;

    /// @notice All reports for a given contract address
    mapping(address => ThreatReport[]) private _reportsByContract;

    /// @notice Attack playbooks indexed by contract → parallel to _reportsByContract.
    ///         _playbooksByContract[addr].length <= _reportsByContract[addr].length
    ///         (reports submitted via reportThreat() have no playbook entry).
    mapping(address => AttackPlaybook[]) private _playbooksByContract;

    /// @notice Maps (contract, report index) → true if that report has a playbook
    mapping(address => mapping(uint256 => bool)) private _hasPlaybook;

    /// @notice Running weighted average score for a given contract
    mapping(address => uint256) public aggregateScore;

    /// @notice Number of reports for a given contract
    mapping(address => uint256) public reportCount;

    /// @notice Whether a contract has been auto-blacklisted
    mapping(address => bool) public blacklisted;

    /// @notice Total number of reports across all contracts
    uint256 public totalReports;

    /// @notice Total number of playbooks across all contracts
    uint256 public totalPlaybooks;

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
    event ReporterAdded(address indexed reporter);
    event ReporterRemoved(address indexed reporter);

    /// @notice Emitted when a threat report includes a structured playbook
    event PlaybookSubmitted(
        address indexed reporter,
        address indexed targetContract,
        uint256 reportIndex,
        bytes4 functionSelector,
        string escalationLevel
    );

    // ─── Errors ───

    error InvalidScore();
    error EmptyAttackType();
    error EmptyEvidence();
    error ZeroAddress();
    error NotOwner();
    error NotAuthorizedReporter();

    // ─── Modifiers ───

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAuthorizedReporter() {
        if (!authorizedReporters[msg.sender]) revert NotAuthorizedReporter();
        _;
    }

    // ─── Constructor ───

    constructor() {
        owner = msg.sender;
        authorizedReporters[msg.sender] = true;
        emit ReporterAdded(msg.sender);
    }

    // ─── Access Control ───

    /// @notice Authorize an address to submit threat reports
    /// @param reporter The address to authorize
    function addReporter(address reporter) external onlyOwner {
        if (reporter == address(0)) revert ZeroAddress();
        authorizedReporters[reporter] = true;
        emit ReporterAdded(reporter);
    }

    /// @notice Revoke an address's reporting authorization
    /// @param reporter The address to revoke
    function removeReporter(address reporter) external onlyOwner {
        if (reporter == address(0)) revert ZeroAddress();
        authorizedReporters[reporter] = false;
        emit ReporterRemoved(reporter);
    }

    // ─── Functions ───

    /// @notice Report a detected threat against a smart contract
    /// @param targetContract The contract address identified as a threat
    /// @param threatScore The threat score (1-100) assigned by the reporter
    /// @param attackType Classification of the attack (e.g., "FLASH_LOAN", "REENTRANCY")
    /// @param evidence Transaction hash or description serving as evidence
    function reportThreat(
        address targetContract,
        uint256 threatScore,
        string calldata attackType,
        string calldata evidence
    ) external onlyAuthorizedReporter {
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

    // ─── Attack Playbook Functions ───

    /// @notice Report a threat AND attach a structured attack playbook.
    ///         The playbook is stored alongside the report for collective security:
    ///         other agents, dashboards, and contracts can consume it.
    ///
    ///         Use cases:
    ///         - Other AI agents query recent playbooks to update their own detection rules
    ///         - Dashboards display which heuristic rules fire most frequently
    ///         - Contracts gate operations on whether a known exploit pattern is active
    ///         - Security researchers correlate calldataHash across multiple attacks
    ///
    /// @param targetContract The contract under attack
    /// @param threatScore    Threat score 1-100
    /// @param attackType     Attack classification (e.g., "FLASH_LOAN")
    /// @param evidence       Transaction hash or evidence string
    /// @param playbook       Structured attack playbook
    function reportThreatWithPlaybook(
        address targetContract,
        uint256 threatScore,
        string calldata attackType,
        string calldata evidence,
        AttackPlaybook calldata playbook
    ) external onlyAuthorizedReporter {
        if (targetContract == address(0)) revert ZeroAddress();
        if (threatScore == 0 || threatScore > 100) revert InvalidScore();
        if (bytes(attackType).length == 0) revert EmptyAttackType();
        if (bytes(evidence).length == 0) revert EmptyEvidence();

        // ── Store the threat report (identical logic to reportThreat) ────────
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

        uint256 count = reportCount[targetContract];
        aggregateScore[targetContract] = ((aggregateScore[targetContract] * (count - 1)) + threatScore) / count;

        if (aggregateScore[targetContract] >= BLACKLIST_THRESHOLD && !blacklisted[targetContract]) {
            blacklisted[targetContract] = true;
            emit ContractBlacklisted(targetContract, aggregateScore[targetContract]);
        }

        emit ThreatReported(msg.sender, targetContract, threatScore, attackType, block.number);

        // ── Store the playbook alongside the report ──────────────────────────
        uint256 reportIndex = _reportsByContract[targetContract].length - 1;

        _playbooksByContract[targetContract].push(playbook);
        _hasPlaybook[targetContract][reportIndex] = true;
        totalPlaybooks++;

        emit PlaybookSubmitted(
            msg.sender, targetContract, reportIndex, playbook.functionSelector, playbook.escalationLevel
        );
    }

    /// @notice Check whether a specific report has an attached playbook
    /// @param contractAddress The target contract
    /// @param reportIndex    Index into the reports array
    /// @return True if a playbook was submitted with that report
    function hasPlaybook(address contractAddress, uint256 reportIndex) external view returns (bool) {
        return _hasPlaybook[contractAddress][reportIndex];
    }

    /// @notice Get the playbook for a specific report
    /// @param contractAddress The target contract
    /// @param reportIndex    Index into the reports array
    /// @return playbook The AttackPlaybook struct (empty if no playbook exists)
    function getPlaybook(address contractAddress, uint256 reportIndex)
        external
        view
        returns (AttackPlaybook memory playbook)
    {
        if (!_hasPlaybook[contractAddress][reportIndex]) {
            return AttackPlaybook("", bytes4(0), bytes32(0), "", false, 0);
        }

        // Find which playbook array index corresponds to this report index.
        // Playbooks are stored contiguously; count how many reports before
        // reportIndex have playbooks to derive the playbook array index.
        uint256 playbookIdx = 0;
        for (uint256 i = 0; i < reportIndex; i++) {
            if (_hasPlaybook[contractAddress][i]) {
                playbookIdx++;
            }
        }

        return _playbooksByContract[contractAddress][playbookIdx];
    }

    /// @notice Get all playbooks for a contract (paginated)
    /// @param contractAddress The contract to query
    /// @param offset Starting index (0-based) into the playbooks array
    /// @param limit  Maximum number of playbooks to return
    /// @return playbooks Array of AttackPlaybook structs
    function getPlaybooks(address contractAddress, uint256 offset, uint256 limit)
        external
        view
        returns (AttackPlaybook[] memory playbooks)
    {
        AttackPlaybook[] storage all = _playbooksByContract[contractAddress];
        uint256 total = all.length;

        if (offset >= total) return new AttackPlaybook[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 resultLength = end - offset;

        playbooks = new AttackPlaybook[](resultLength);
        for (uint256 i = 0; i < resultLength; i++) {
            playbooks[i] = all[offset + i];
        }
    }

    /// @notice Get the total number of playbooks for a contract
    /// @param contractAddress The contract to query
    /// @return The number of playbooks submitted for this contract
    function getPlaybookCount(address contractAddress) external view returns (uint256) {
        return _playbooksByContract[contractAddress].length;
    }
}
