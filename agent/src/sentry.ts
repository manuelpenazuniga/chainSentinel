// ============================================================================
// ChainSentinel — Sentry Integration (§5.4)
// ============================================================================
//
// Without Sentry, an uncaught exception in production leaves a single line in
// stdout (and in our winston logs if we're lucky). With Sentry:
//
//   - Stack traces with source-map resolution
//   - Aggregation by error fingerprint (1 incident, N occurrences)
//   - Tags for `release`, `environment`, `vault_address`, `vm`
//   - Alerting via the Sentry app / Slack / PagerDuty (orthogonal to our own
//     §6.3 channels — Sentry covers crashes, our channels cover threats)
//
// Activation is OPT-IN: setting `SENTRY_DSN` in the env enables it. Without
// the env var, every function in this module is a no-op — no overhead, no
// network calls, no behaviour change. This means the dev workflow never
// needs to think about Sentry.
//
// What gets captured automatically once initialized:
//   - process.on("uncaughtException")
//   - process.on("unhandledRejection")
//   - HTTP client / server breadcrumbs (handled by @sentry/node defaults)
//
// What we explicitly capture (see callers):
//   - LLM API failures              (analyzer.ts catch block)
//   - On-chain tx failures          (executor.ts catch blocks)
//   - Persistence flush errors      (persistence.ts catch block)
//   - Block enrichment errors       (monitor.ts poll loop)
// ============================================================================

import * as Sentry from "@sentry/node";
import { createLogger } from "./logger.js";

const logger = createLogger("sentry");

let initialized = false;

export interface SentryInitOptions {
  dsn?: string;
  /** e.g. "production", "staging", "demo". Defaults to NODE_ENV. */
  environment?: string;
  /** Git SHA or semver. Helps Sentry deduplicate by release. */
  release?: string;
  /** Sample rate for performance traces (0-1). Default 0 = off. */
  tracesSampleRate?: number;
}

/**
 * Initialize Sentry from environment variables. Safe to call multiple times
 * (subsequent calls are no-ops). If `SENTRY_DSN` is missing, the function
 * logs a notice and returns false — every other function in this module
 * remains safely callable.
 *
 * Returns true if Sentry was actually initialized.
 */
export function initSentry(options: SentryInitOptions = {}): boolean {
  if (initialized) return true;

  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    logger.info("SENTRY_DSN not set — Sentry disabled (uncaught exceptions will only hit local logs)");
    return false;
  }

  try {
    Sentry.init({
      dsn,
      environment: options.environment ?? process.env.NODE_ENV ?? "development",
      release: options.release ?? process.env.SENTRY_RELEASE,
      tracesSampleRate: options.tracesSampleRate ?? 0,
      // Attach the stack trace even for `captureMessage` calls.
      attachStacktrace: true,
      // Don't send default PII (request IPs, cookies). We're a backend, this
      // is mostly a no-op but explicit is better than implicit.
      sendDefaultPii: false,
    });

    // Tag every event with the agent address derived from the wallet,
    // if available — extremely useful when running multiple agents.
    if (process.env.AGENT_ADDRESS) {
      Sentry.setTag("agent_address", process.env.AGENT_ADDRESS);
    }

    initialized = true;
    logger.info(`Sentry initialized (env=${options.environment ?? process.env.NODE_ENV ?? "development"})`);
    return true;
  } catch (err) {
    // Initialization failure must NEVER crash the agent.
    logger.warn(`Sentry init failed (continuing without): ${(err as Error).message}`);
    return false;
  }
}

/**
 * Capture an exception. No-op when Sentry is not initialized.
 *
 * Use this in catch blocks where you want the error to reach observability
 * AND you've already handled the user-facing fallback (e.g. retry, log,
 * graceful degradation).
 */
export function captureException(
  error: unknown,
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> }
): void {
  if (!initialized) return;
  try {
    if (context?.tags || context?.extra) {
      Sentry.withScope((scope) => {
        if (context.tags) for (const [k, v] of Object.entries(context.tags)) scope.setTag(k, v);
        if (context.extra) for (const [k, v] of Object.entries(context.extra)) scope.setExtra(k, v);
        Sentry.captureException(error);
      });
    } else {
      Sentry.captureException(error);
    }
  } catch {
    // Sentry transport failure must never propagate.
  }
}

/**
 * Capture a structured message (non-error). Useful for unexpected branches
 * that aren't strictly exceptions but warrant investigation.
 */
export function captureMessage(
  message: string,
  level: Sentry.SeverityLevel = "warning",
  context?: { tags?: Record<string, string>; extra?: Record<string, unknown> }
): void {
  if (!initialized) return;
  try {
    Sentry.withScope((scope) => {
      scope.setLevel(level);
      if (context?.tags) for (const [k, v] of Object.entries(context.tags)) scope.setTag(k, v);
      if (context?.extra) for (const [k, v] of Object.entries(context.extra)) scope.setExtra(k, v);
      Sentry.captureMessage(message);
    });
  } catch {
    // ignore
  }
}

/**
 * Flush pending events before shutdown. Returns a promise that resolves
 * when in-flight events finish or `timeoutMs` elapses.
 */
export async function flushSentry(timeoutMs: number = 2000): Promise<void> {
  if (!initialized) return;
  try {
    await Sentry.close(timeoutMs);
  } catch {
    // already closed or transport failure — ignore
  }
}

/** Returns whether Sentry has been initialized. Used by tests. */
export function isSentryInitialized(): boolean {
  return initialized;
}

/** Reset module state. ONLY for use in tests. */
export function _resetSentryForTests(): void {
  initialized = false;
}
