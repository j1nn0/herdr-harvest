import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openDatabase } from "../src/persistence/database.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";

const execFileAsync = promisify(execFile);
const worker = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "insert-worker.ts");

describe("concurrent completion events across processes", () => {
  test("eight racing processes produce exactly one result and none fail", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-race-"));
    const databasePath = join(directory, "harvest.db");
    try {
      const runs = await Promise.all(
        Array.from({ length: 8 }, () =>
          execFileAsync(process.execPath, [worker, databasePath], { encoding: "utf8" }),
        ),
      );

      const statuses = runs.map((run) => run.stdout.trim());
      assert.equal(statuses.length, 8);
      assert.equal(
        statuses.filter((status) => status === "inserted").length,
        1,
        `expected exactly one insert, got ${JSON.stringify(statuses)}`,
      );
      assert.equal(statuses.filter((status) => status === "duplicate").length, 7);

      const store = new SqliteResultStore(openDatabase(databasePath));
      try {
        assert.equal(store.list({ includeArchived: true }).length, 1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
