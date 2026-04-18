// ============================================================================
// ChainSentinel Agent — Shared Type Definitions
// ============================================================================

// ─── Transaction Data ───

export interface TransactionData {
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  gasUsed: string;
  blockNumber: number;
  timestamp: number;
  functionSelector: string;
  decodedFunction: string | null;
}

// ─── Heuristic Engine ───

export interface HeuristicRule {
  name: string;
  description: string;
  score: number;
  evaluate: (tx: TransactionData, context: MonitorContextInterface) => boolean | Promise<boolean>;
}

export interface HeuristicResult {
  score: number;
  triggeredRules: string[];
  details: Array<{ rule: string; triggered: boolean; score: number }>;
  /** Extra score added when multiple rules form a known dangerous combination. */
  correlationBonus: number;
}

// ─── LLM Analysis ───

export interface LLMAnalysis {
  threatScore: number;
  confidence: number;
  classification: ThreatClassification;
  attackType: AttackType;
  explanation: string;
  recommendedAction: RecommendedAction;
  /** Step-by-step chain-of-thought produced by the model before reaching the score. */
  reasoning?: string;
}

export type ThreatClassification = "NORMAL" | "SUSPICIOUS" | "PROBABLE_THREAT" | "CRITICAL_THREAT";

export type AttackType =
  | "NONE"
  | "FLASH_LOAN"
  | "REENTRANCY"
  | "PRICE_MANIPULATION"
  | "SANDWICH"
  | "DRAIN"
  | "ACCESS_CONTROL"
  | "UNKNOWN";

export type RecommendedAction = "NONE" | "MONITOR" | "ALERT" | "EMERGENCY_WITHDRAW";

// ─── Final Threat Assessment ───

export interface ThreatAssessment {
  score: number;
  classification: ThreatClassification;
  attackType: AttackType;
  explanation: string;
  recommendedAction: RecommendedAction;
  heuristicScore: number;
  llmScore: number | null;
  llmConfidence: number | null;
  llmUsed: boolean;
  triggeredRules: string[];
  transaction: TransactionData;
  assessedAt: number;
}

// ─── Monitor Context Interface ───

export interface MonitorContextInterface {
  getHistoricalAvgValue(contractAddress: string): bigint;
  getContractAge(contractAddress: string): number | null;
  getRecentTxs(from: string, to: string, withinBlocks: number): TransactionData[];
  getSignificantThreshold(contractAddress: string): bigint;
  hasFlashLoanInteraction(txHash: string): boolean;
  isBlacklisted(address: string): boolean;
  isWhitelisted(address: string): boolean;
  getBalanceBefore(contractAddress: string, blockNumber: number): bigint;
  getBalanceAfter(contractAddress: string, blockNumber: number): bigint;
  hasPreviousInteraction(from: string, to: string): boolean;
  getContractLabel(contractAddress: string): string | null;
  getBalance(contractAddress: string): bigint;
  getBalanceChange(contractAddress: string, blockNumber: number): number;
  getRecentTxCount(from: string, to: string, withinBlocks: number): number;
  /**
   * Returns the historical average ERC-20 transfer amount (decoded from calldata)
   * observed for transactions sent TO the given contract address.
   * Returns 0n when no ERC-20 transfers have been recorded yet.
   */
  getHistoricalAvgERC20Value(contractAddress: string): bigint;
}

// ─── Agent Configuration ───

export interface AgentConfig {
  rpcUrl: string;
  wsUrl?: string;
  chainId: number;
  agentPrivateKey: string;
  vaultAddress: string;
  registryAddress: string;
  /** PVM vault address — when set, the agent monitors both REVM and PVM vaults simultaneously. */
  vaultAddressPvm?: string;
  /** PVM registry address — when set, threats are reported to both registries. */
  registryAddressPvm?: string;
  geminiApiKey: string;
  heuristicThreshold: number;
  emergencyThreshold: number;
  cooldownBlocks: number;
  llmTimeoutMs: number;
  telegramBotToken?: string;
  telegramChatId?: string;
}

// ─── Alert Data ───

export interface AlertData {
  type: "THREAT_DETECTED" | "EMERGENCY_EXECUTED" | "AGENT_ERROR" | "AGENT_STARTED" | "AGENT_STOPPED";
  assessment?: ThreatAssessment;
  message: string;
  timestamp: number;
}

// ─── Escalation Level ───

/**
 * Graduated response levels, from least to most disruptive.
 *
 *   MONITOR               → Log + alert only (no on-chain action)
 *   REPORT                → reportThreat() to registry
 *   DEFENSIVE_WITHDRAW    → emergencyWithdraw(native token) + reportThreat()
 *   EMERGENCY_WITHDRAW_ALL→ emergencyWithdrawAll() + reportThreat()
 */
export type EscalationLevel =
  | "MONITOR"
  | "REPORT"
  | "DEFENSIVE_WITHDRAW"
  | "EMERGENCY_WITHDRAW_ALL";

// ─── Executor Result ───

export interface ExecutorResult {
  success: boolean;
  txHash?: string;
  error?: string;
  action: "EMERGENCY_WITHDRAW" | "EMERGENCY_WITHDRAW_ALL" | "REPORT_THREAT";
  blockNumber?: number;
  /** Which vault/registry was targeted (e.g. "REVM", "PVM"). */
  vmLabel?: string;
  /** Whether this action was preceded by a successful simulation (eth_call dry-run). */
  simulated?: boolean;
}
