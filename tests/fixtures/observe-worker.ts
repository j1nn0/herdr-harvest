/**
 * Observes one pane status at argv[2] and prints the previous status. Used by the
 * multi-process lifecycle test to exercise the transaction's read-before-upsert behavior.
 */
import { openDatabase } from "../../src/persistence/database.ts";
import { SqliteResultStore } from "../../src/persistence/result-store.ts";

const databasePath = process.argv[2];
const agentStatus = process.argv[3];
if (databasePath === undefined || agentStatus === undefined) {
  throw new Error("usage: observe-worker.ts <database-path> <agent-status>");
}

const store = new SqliteResultStore(openDatabase(databasePath));
try {
  const outcome = store.observePaneStatus({
    herdrSessionKey: "socket-race",
    paneId: "pane-race",
    agentStatus,
    atMs: Date.now(),
  });
  process.stdout.write(outcome.previousStatus ?? "null");
} finally {
  store.close();
}
