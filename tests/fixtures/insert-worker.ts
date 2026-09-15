/**
 * Inserts one fixed capture into the database at argv[2] and prints the outcome
 * status. Used by the multi-process concurrency test: several copies of this run
 * at once against a single database file to exercise real write-lock contention,
 * which an in-process test cannot reproduce because node:sqlite is synchronous.
 *
 * An optional orchestration id at argv[4] claims the capture too, and the printed
 * status then carries the claim result after a colon (`duplicate:conflict`).
 */
import { openDatabase } from "../../src/persistence/database.ts";
import { SqliteResultStore } from "../../src/persistence/result-store.ts";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("usage: insert-worker.ts <database-path> [start-at-ms] [orchestration-id]");
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

const claimId = process.argv[4];
const store = new SqliteResultStore(openDatabase(databasePath));
try {
  const outcome = store.insert(
    {
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
      requestedLineCount: 400,
      rawText: "racing completion snapshot",
    },
    claimId === undefined
      ? undefined
      : { id: claimId, label: "cross-process claim", role: "explorer" },
  );
  process.stdout.write(
    outcome.claim === undefined ? outcome.status : `${outcome.status}:${outcome.claim.status}`,
  );
} finally {
  store.close();
}
