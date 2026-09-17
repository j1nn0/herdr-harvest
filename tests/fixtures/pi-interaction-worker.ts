/**
 * Inserts one fixed terminal Pi interaction and prints only the outcome status.
 * Several copies run against one database to exercise real SQLite writer
 * contention and the Pi dedup read-back path.
 */
import { openDatabase } from "../../src/persistence/database.ts";
import { PiInteractionStore } from "../../src/persistence/pi-interaction-store.ts";

const databasePath = process.argv[2];
if (databasePath === undefined) {
  throw new Error("usage: pi-interaction-worker.ts <database-path> [start-at-ms]");
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

const database = openDatabase(databasePath);
const store = new PiInteractionStore(database);
try {
  process.stdout.write(
    store.insert({
      interactionId: "race-interaction",
      sessionId: "race-session",
      submittedPrompt: "race prompt",
      effectivePrompt: "race effective prompt",
      finalReport: "race final report",
      status: "completed",
      reason: null,
      provenance: "pi-test-worker",
    }).status,
  );
} finally {
  database.close();
}
