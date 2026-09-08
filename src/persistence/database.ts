import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path: string): DatabaseSync {
  const inMemory = path === ":memory:";
  if (!inMemory) {
    if (process.platform === "win32") {
      mkdirSync(dirname(path), { recursive: true });
    } else {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
  }

  const db = new DatabaseSync(path);
  // busy_timeout must be set before anything that can contend.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  if (!inMemory) {
    enableWalMode(db);
    protectDatabaseFiles(path);
  }
  return db;
}

const BUSY_TIMEOUT_MS = 5000;
const WAL_ATTEMPTS = 40;
const WAL_SETUP_BUSY_TIMEOUT_MS = 50;
const WAL_RETRY_DELAY_MS = 25;

/**
 * Converting the journal mode takes an exclusive lock, and SQLite does not run the
 * busy handler for that conversion: a racing connection is told the database is
 * locked immediately, however large busy_timeout is. Several hook processes opening
 * a cold database at the same instant therefore used to fail outright.
 *
 * Reading the mode first means only the very first open of a new database contends
 * at all, and the retry covers that one moment. If a racing process is still
 * converting when the budget runs out, a rollback journal is left in place rather
 * than failing the capture: it is still correct, because BEGIN IMMEDIATE and
 * busy_timeout are what serialize writers. WAL only widens reader concurrency.
 */
function enableWalMode(db: DatabaseSync): void {
  // Reading the mode needs a shared lock, so it can block for the whole busy_timeout
  // while a racing process converts. Shorten the timeout for setup only, so each
  // attempt stays responsive, and restore it before any real work happens.
  db.exec(`PRAGMA busy_timeout = ${WAL_SETUP_BUSY_TIMEOUT_MS}`);
  try {
    for (let attempt = 0; attempt < WAL_ATTEMPTS; attempt += 1) {
      try {
        if (journalMode(db) === "wal") {
          return;
        }
        db.exec("PRAGMA journal_mode = WAL");
        return;
      } catch (error) {
        if (!isBusyError(error)) {
          throw error;
        }
        sleepSync(WAL_RETRY_DELAY_MS);
      }
    }
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}

function journalMode(db: DatabaseSync): string | null {
  const row = db.prepare("PRAGMA journal_mode").get();
  const mode = row?.journal_mode;
  return typeof mode === "string" ? mode.toLowerCase() : null;
}

function isBusyError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  // SQLITE_BUSY is 5 and SQLITE_LOCKED is 6; node:sqlite surfaces them as errcode.
  const { errcode } = error as { errcode?: unknown };
  if (errcode === 5 || errcode === 6) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("locked") || message.includes("busy");
}

function sleepSync(milliseconds: number): void {
  // node:sqlite is synchronous, so the retry has to block this thread.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function protectDatabaseFiles(path: string): void {
  if (process.platform === "win32") {
    return;
  }

  for (const filePath of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(filePath, 0o600);
    } catch {
      // Permissions are defense in depth; inability to tighten them must not block capture.
    }
  }
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
