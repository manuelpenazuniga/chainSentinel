import { createLogger } from "./logger.js";

const logger = createLogger("agentkit");

/**
 * Polkadot Agent Kit wrapper — deferred integration.
 * The core agent works without it using ethers.js directly.
 */
export class AgentKitWrapper {
  constructor() {
    logger.info("AgentKit wrapper initialized (placeholder — not yet integrated)");
  }
}
