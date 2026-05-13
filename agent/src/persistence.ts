// ============================================================================
// ChainSentinel — Context Persistence (§3.2)
// ============================================================================
//
// Without persistence, every agent restart loses 100+ blocks of rolling state:
//
//   - avgValues / avgERC20Values  → ANOMALOUS_VALUE rule blind for ~10 minutes
//                                   per contract until baseline rebuilds
//   - contractAges                → re-runs binary-search getCode on every
//                                   target contract (expensive RPC traffic)
//   - blacklistSet (local cache)  → must re-fetch from on-chain registry
//   - flashLoanTxHashes           → loses correlation across restarts
//   - recentTxBuffer              → TX_BURST + SANDWICH detection blind
//                                   until 500 fresh txs accumulate
//
// This module persists MonitorContext snapshots to a local SQLite database
// (better-sqlite3, synchronous, zero overhead). Snapshots happen every
// `flushIntervalBlocks` blocks; on startup the most recent snapshot is loaded.
//
// Storage choice: SQLite over flat-file JSON because:
//   - Atomic writes (no partial-snapshot corruption on crash mid-write)
//   - Easy to keep multiple snapshot generations and prune the oldest
//   - Foundation for future indexed queries (e.g. snapshot history per vault)
// ============================================================================

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { MonitorContext, ContextSnapshot } from "./context.js";
import { persistenceSnapshots } from "./metrics.js";
import { createLogger } from "./logger.js";

const logger = createLogger("persistence");

/** Configuration for ContextPersistence. */
export interface PersistenceConfig {
  /** Filesystem path to the SQLite database file. Parent dir is created if missing. */
  dbPath: string;
  /** How many blocks between snapshots. Recommended: 100 (≈10 min @ 6s blocks). */
  flushIntervalBlocks: number;
  /** Max snapshot generations to keep. Older are pruned. Default: 5. */
  maxSnapshots?: number;
}

interface SnapshotRow {
  id: number;
  block_number: number;
  payload_json: string;
  created_at: number;
}

/**
 * SQLite-backed persistence for MonitorContext rolling state.
 *
 * Usage:
 *   const persistence = new ContextPersistence({ dbPath: "./agent.db", flushIntervalBlocks: 100 });
 *   const restored = persistence.restoreLatest();
 *   if (restored) context.restoreFromSnapshot(restored.snapshot);
 *   // ... in monitor loop:
 *   if (persistence.shouldFlush(blockNumber)) persistence.flush(context, blockNumber);
 *   // ... on shutdown:
 *   persistence.close();
 */
export class ContextPersistence {
  private db: Database.Database;
  private flushIntervalBlocks: number;
  private maxSnapshots: number;
  private lastFlushBlock: number = 0;

  constructor(config: PersistenceConfig) {
    this.flushIntervalBlocks = Math.max(1, config.flushIntervalBlocks);
    this.maxSnapshots = Math.max(1, config.maxSnapshots ?? 5);

    // Ensure parent dir exists (better-sqlite3 will not auto-create directories)
    try {
      mkdirSync(dirname(config.dbPath), { recursive: true });
    } catch {
      // Directory may already exist — fine
    }

    this.db = new Database(config.dbPath);
    // WAL mode → better concurrent read while we write snapshots
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        block_number INTEGER NOT NULL,
        payload_json TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_snapshots_block_number ON snapshots(block_number);
    `);
    logger.info(`Persistence ready at ${config.dbPath} (flush every ${this.flushIntervalBlocks} blocks)`);
  }

  /**
   * Should we snapshot now? True if `blockNumber` is at least
   * `flushIntervalBlocks` past the last successful flush.
   */
  shouldFlush(blockNumber: number): boolean {
    return blockNumber - this.lastFlushBlock >= this.flushIntervalBlocks;
  }

  /**
   * Persist a snapshot of the given context at the given block height.
   * Prunes old snapshots so at most `maxSnapshots` rows remain.
   */
  flush(context: MonitorContext, blockNumber: number): void {
    try {
      const snapshot = context.toSnapshot();
      const payload = JSON.stringify(snapshot);

      const insert = this.db.prepare(
        "INSERT INTO snapshots (block_number, payload_json, created_at) VALUES (?, ?, ?)"
      );
      const prune = this.db.prepare(
        `DELETE FROM snapshots WHERE id NOT IN (
           SELECT id FROM snapshots ORDER BY id DESC LIMIT ?
         )`
      );

      // Wrap in a transaction so a crash mid-prune leaves the new snapshot intact
      const tx = this.db.transaction((blk: number, body: string, kept: number) => {
        insert.run(blk, body, Date.now());
        prune.run(kept);
      });
      tx(blockNumber, payload, this.maxSnapshots);

      this.lastFlushBlock = blockNumber;
      persistenceSnapshots.inc({ status: "ok" });
      logger.info(`Snapshot persisted at block ${blockNumber} (${payload.length} bytes)`);
    } catch (error) {
      persistenceSnapshots.inc({ status: "error" });
      logger.error(`Snapshot flush failed at block ${blockNumber}: ${(error as Error).message}`);
    }
  }

  /**
   * Restore the most recent snapshot. Returns null if no snapshots exist or the
   * snapshot is corrupt / incompatible.
   */
  restoreLatest(): { blockNumber: number; snapshot: ContextSnapshot } | null {
    try {
      const row = this.db
        .prepare("SELECT id, block_number, payload_json, created_at FROM snapshots ORDER BY id DESC LIMIT 1")
        .get() as SnapshotRow | undefined;

      if (!row) {
        logger.info("No snapshot to restore — starting cold");
        return null;
      }

      const snapshot = JSON.parse(row.payload_json) as ContextSnapshot;
      this.lastFlushBlock = row.block_number;
      logger.info(`Snapshot found at block ${row.block_number} (created ${new Date(row.created_at).toISOString()})`);
      return { blockNumber: row.block_number, snapshot };
    } catch (error) {
      logger.warn(`Failed to restore snapshot: ${(error as Error).message}`);
      return null;
    }
  }

  /** Number of snapshots currently stored. Used in tests. */
  countSnapshots(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM snapshots").get() as { n: number };
    return row.n;
  }

  /** Close the underlying database. Idempotent. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed — fine
    }
  }
}
