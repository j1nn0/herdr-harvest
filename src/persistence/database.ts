import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const inMemory = path === ":memory:";
  if (!inMemory) {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  // busy_timeout must be set before anything that can contend. Switching the
  // journal mode takes an exclusive lock, so several hook processes opening the
  // database at the same moment fail outright with SQLITE_BUSY unless they are
  // already willing to wait.
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  if (!inMemory) {
    db.exec("PRAGMA journal_mode = WAL");
  }
  return db;
}

/**
 * Every transaction Harvest opens is a write transaction, so it takes the write
 * lock up front. A deferred BEGIN only upgrades on first write, and two hook
 * processes completing at the same moment can then deadlock and surface
 * SQLITE_BUSY instead of waiting out busy_timeout.
 */
export function withTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
