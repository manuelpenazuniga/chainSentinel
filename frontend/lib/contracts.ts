// Contract addresses — update after deploying to testnet (Steps 1-2)
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export const VAULT_ADDRESS =
  (process.env.NEXT_PUBLIC_VAULT_ADDRESS as `0x${string}`) || ZERO_ADDRESS;

export const REGISTRY_ADDRESS =
  (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS as `0x${string}`) || ZERO_ADDRESS;

// Native token represented as address(0)
export const NATIVE_TOKEN = ZERO_ADDRESS;

// Check if contracts are properly configured (env vars set and not zero address fallbacks)
export const IS_CONFIGURED =
  !!process.env.NEXT_PUBLIC_VAULT_ADDRESS &&
  !!process.env.NEXT_PUBLIC_REGISTRY_ADDRESS &&
  process.env.NEXT_PUBLIC_VAULT_ADDRESS !== ZERO_ADDRESS &&
  process.env.NEXT_PUBLIC_REGISTRY_ADDRESS !== ZERO_ADDRESS;

export const VAULT_ABI = [
  { type: "constructor", inputs: [{ name: "_safeAddress", type: "address" }, { name: "_threshold", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "receive", stateMutability: "payable" },
  { type: "function", name: "owner", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "guardian", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "safeAddress", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "threshold", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "cooldownBlocks", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "lastEmergencyBlock", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "isCooldownActive", inputs: [], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "balances", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getBalance", inputs: [{ name: "token", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getAllBalances", inputs: [], outputs: [{ name: "tokens", type: "address[]" }, { name: "amounts", type: "uint256[]" }], stateMutability: "view" },
  { type: "function", name: "getTokenCount", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  {
    type: "function", name: "getVaultStatus", inputs: [],
    outputs: [
      { name: "_owner", type: "address" },
      { name: "_guardian", type: "address" },
      { name: "_safeAddress", type: "address" },
      { name: "_threshold", type: "uint256" },
      { name: "_cooldownBlocks", type: "uint256" },
      { name: "_lastEmergencyBlock", type: "uint256" },
      { name: "_tokenCount", type: "uint256" },
      { name: "_isProtected", type: "bool" },
    ],
    stateMutability: "view",
  },
  { type: "function", name: "isWhitelisted", inputs: [{ name: "contractAddress", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "depositNative", inputs: [], outputs: [], stateMutability: "payable" },
  { type: "function", name: "deposit", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "withdraw", inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setGuardian", inputs: [{ name: "_guardian", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "removeGuardian", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setThreshold", inputs: [{ name: "_threshold", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setSafeAddress", inputs: [{ name: "_safeAddress", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "setCooldownBlocks", inputs: [{ name: "_cooldownBlocks", type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "addToWhitelist", inputs: [{ name: "contractAddress", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "removeFromWhitelist", inputs: [{ name: "contractAddress", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "emergencyWithdraw", inputs: [{ name: "token", type: "address" }, { name: "threatScore", type: "uint256" }, { name: "reason", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "emergencyWithdrawAll", inputs: [{ name: "threatScore", type: "uint256" }, { name: "reason", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  // Events
  { type: "event", name: "Deposited", inputs: [{ name: "user", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "NativeDeposited", inputs: [{ name: "user", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "Withdrawn", inputs: [{ name: "user", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }] },
  { type: "event", name: "GuardianSet", inputs: [{ name: "guardian", type: "address", indexed: true }] },
  { type: "event", name: "GuardianRemoved", inputs: [] },
  { type: "event", name: "EmergencyWithdrawExecuted", inputs: [{ name: "guardian", type: "address", indexed: true }, { name: "token", type: "address", indexed: true }, { name: "amount", type: "uint256", indexed: false }, { name: "threatScore", type: "uint256", indexed: false }, { name: "reason", type: "string", indexed: false }] },
  { type: "event", name: "ThresholdUpdated", inputs: [{ name: "newThreshold", type: "uint256", indexed: false }] },
  { type: "event", name: "SafeAddressUpdated", inputs: [{ name: "newSafeAddress", type: "address", indexed: false }] },
  { type: "event", name: "CooldownUpdated", inputs: [{ name: "newCooldownBlocks", type: "uint256", indexed: false }] },
] as const;

export const REGISTRY_ABI = [
  { type: "function", name: "BLACKLIST_THRESHOLD", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "aggregateScore", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "blacklisted", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isBlacklisted", inputs: [{ name: "contractAddress", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "getThreatScore", inputs: [{ name: "contractAddress", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "getReportCount", inputs: [{ name: "contractAddress", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "reportCount", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "totalReports", inputs: [], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  {
    type: "function", name: "getLatestReport", inputs: [{ name: "contractAddress", type: "address" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "reporter", type: "address" },
        { name: "targetContract", type: "address" },
        { name: "threatScore", type: "uint256" },
        { name: "attackType", type: "string" },
        { name: "evidence", type: "string" },
        { name: "timestamp", type: "uint256" },
        { name: "blockNumber", type: "uint256" },
      ],
    }],
    stateMutability: "view",
  },
  {
    type: "function", name: "getReports", inputs: [{ name: "contractAddress", type: "address" }, { name: "offset", type: "uint256" }, { name: "limit", type: "uint256" }],
    outputs: [{
      name: "reports", type: "tuple[]",
      components: [
        { name: "reporter", type: "address" },
        { name: "targetContract", type: "address" },
        { name: "threatScore", type: "uint256" },
        { name: "attackType", type: "string" },
        { name: "evidence", type: "string" },
        { name: "timestamp", type: "uint256" },
        { name: "blockNumber", type: "uint256" },
      ],
    }],
    stateMutability: "view",
  },
  { type: "function", name: "owner", inputs: [], outputs: [{ name: "", type: "address" }], stateMutability: "view" },
  { type: "function", name: "authorizedReporters", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }], stateMutability: "view" },
  { type: "function", name: "addReporter", inputs: [{ name: "reporter", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "removeReporter", inputs: [{ name: "reporter", type: "address" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "reportThreat", inputs: [{ name: "targetContract", type: "address" }, { name: "threatScore", type: "uint256" }, { name: "attackType", type: "string" }, { name: "evidence", type: "string" }], outputs: [], stateMutability: "nonpayable" },
  // Events
  { type: "event", name: "ThreatReported", inputs: [{ name: "reporter", type: "address", indexed: true }, { name: "targetContract", type: "address", indexed: true }, { name: "threatScore", type: "uint256", indexed: false }, { name: "attackType", type: "string", indexed: false }, { name: "blockNumber", type: "uint256", indexed: false }] },
  { type: "event", name: "ContractBlacklisted", inputs: [{ name: "contractAddress", type: "address", indexed: true }, { name: "aggregateScore", type: "uint256", indexed: false }] },
] as const;
