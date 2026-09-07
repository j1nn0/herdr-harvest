import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openDatabase } from "../src/persistence/database.ts";
import { MIGRATIONS } from "../src/persistence/migrations.ts";
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
  test("racing first opens migrate fresh databases atomically", async () => {
    const latest = MIGRATIONS[MIGRATIONS.length - 1];
    if (latest === undefined) {
      throw new Error("Expected at least one migration.");
    }

    for (let iteration = 0; iteration < 10; iteration += 1) {
      const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-migration-race-"));
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

        const statuses = runs.map((run) => run.stdout.trim());
        assert.equal(statuses.length, 8, `iteration ${iteration}`);
        assert.equal(
          statuses.filter((status) => status === "inserted").length,
          1,
          `iteration ${iteration}: expected exactly one insert, got ${JSON.stringify(statuses)}`,
        );
        assert.equal(
          statuses.filter((status) => status === "duplicate").length,
          7,
          `iteration ${iteration}`,
        );

        const db = openDatabase(databasePath);
        try {
          const versionRow = db.prepare("PRAGMA user_version").get() as
            | { user_version?: number }
            | undefined;
          assert.equal(
            versionRow?.user_version,
            latest.version,
            `iteration ${iteration}: schema version`,
          );

          const tableRow = db
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'results'")
            .get() as { name?: string } | undefined;
          assert.equal(tableRow?.name, "results", `iteration ${iteration}: results table`);

          const countRow = db.prepare("SELECT COUNT(*) AS count FROM results").get() as
            | { count?: number }
            | undefined;
          assert.equal(countRow?.count, 1, `iteration ${iteration}: inserted row count`);
        } finally {
          db.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
