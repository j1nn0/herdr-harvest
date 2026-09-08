/**
 * Inserts one fixed capture into the database at argv[2] and prints the outcome
 * status. Used by the multi-process concurrency test: several copies of this run
 * at once against a single database file to exercise real write-lock contention,
 * which an in-process test cannot reproduce because node:sqlite is synchronous.
 */
import { openDatabase } from "../../src/persistence/database.ts";
import { SqliteResultStore } from "../../src/persistence/result-store.ts";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("usage: insert-worker.ts <database-path>");
}

const startAtArg = process.argv[3];
if (startAtArg !== undefined) {
  const startAt = Number(startAtArg);
  if (!Number.isFinite(startAt)) {
    throw new Error("start time must be a finite epoch millisecond value");
  }
  while (Date.now() < startAt) {
    // Intentionally busy-wait so all workers cross the database-open barrier together.
  }
}
const store = new SqliteResultStore(openDatabase(databasePath));
try {
  const outcome = store.insert({
    capturedAtMs: 1_700_000_000_000,
    workspaceId: "w1",
    workspaceName: "harvest",
    tabId: "w1:t1",
    paneId: "w1:p1",
    paneName: "agent",
    agentName: "claude",
    agentKind: "claude",
    agentSessionKind: "id",
    agentSessionValue: "session-race",
    herdrSessionKey: "/tmp/herdr.sock",
    herdrSessionLabel: "default",
    captureSource: "recent-unwrapped",
    captureLineCount: 400,
    rawText: "racing completion snapshot",
  });
  process.stdout.write(outcome.status);
} finally {
  store.close();
}
