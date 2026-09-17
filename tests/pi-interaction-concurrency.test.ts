import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openDatabase } from "../src/persistence/database.ts";
import { PiInteractionStore } from "../src/persistence/pi-interaction-store.ts";

const execFileAsync = promisify(execFile);
const worker = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pi-interaction-worker.ts",
);

describe("Pi interaction persistence concurrency", () => {
  test("concurrent processes insert one terminal row and read back the winner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-pi-interaction-race-"));
    const databasePath = join(directory, "harvest.db");
    try {
      const startAt = Date.now() + 1_000;
      const runs = await Promise.all(
        Array.from({ length: 8 }, () =>
          execFileAsync(process.execPath, [worker, databasePath, String(startAt)], {
            encoding: "utf8",
          }),
        ),
      );
      const statuses = runs.map((run) => run.stdout.trim()).sort();
      assert.equal(
        statuses.filter((status) => status === "inserted").length,
        1,
        JSON.stringify(statuses),
      );
      assert.equal(
        statuses.filter((status) => status === "duplicate").length,
        7,
        JSON.stringify(statuses),
      );

      const database = openDatabase(databasePath);
      const store = new PiInteractionStore(database);
      try {
        const rows = store.list();
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.interactionId, "race-interaction");
        assert.equal(rows[0]?.finalReport, "race final report");
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
