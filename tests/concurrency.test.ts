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
const lifecycleWorker = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "observe-worker.ts",
);

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

  test("serializes concurrent lifecycle observations so only one sees working", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-lifecycle-race-"));
    const databasePath = join(directory, "harvest.db");
    const seedStore = new SqliteResultStore(openDatabase(databasePath));
    try {
      assert.deepEqual(
        seedStore.observePaneStatus({
          herdrSessionKey: "socket-race",
          paneId: "pane-race",
          agentStatus: "working",
          atMs: 1,
        }),
        { previousStatus: null },
      );
    } finally {
      seedStore.close();
    }

    try {
      const runs = await Promise.all(
        Array.from({ length: 2 }, () =>
          execFileAsync(process.execPath, [lifecycleWorker, databasePath, "idle"], {
            encoding: "utf8",
          }),
        ),
      );
      assert.deepEqual(runs.map((run) => run.stdout.trim()).sort(), ["idle", "working"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("racing claims elect exactly one orchestration winner", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-claim-race-"));
    const databasePath = join(directory, "harvest.db");
    const firstId = "2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50";
    const secondId = "7c9e1d2a-3b4c-4d5e-8f90-a1b2c3d4e5f6";
    try {
      const runs = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          execFileAsync(
            process.execPath,
            [worker, databasePath, "0", index % 2 === 0 ? firstId : secondId],
            { encoding: "utf8" },
          ),
        ),
      );

      const statuses = runs.map((run) => run.stdout.trim());
      assert.equal(statuses.length, 6);
      // One writer wins the NULL-guarded claim; everyone else reads the winner
      // back and reports either an idempotent claim or a conflict, never a
      // second claim and never a lost row.
      assert.equal(
        statuses.filter((status) => status === "inserted:claimed").length,
        1,
        `expected exactly one claim, got ${JSON.stringify(statuses)}`,
      );
      assert.equal(
        statuses.filter((status) => status.endsWith(":claimed")).length,
        1,
        JSON.stringify(statuses),
      );
      for (const status of statuses) {
        assert.match(status, /^(inserted|duplicate):(claimed|already_claimed|conflict)$/);
      }

      const store = new SqliteResultStore(openDatabase(databasePath));
      try {
        const rows = store.list({ includeArchived: true });
        assert.equal(rows.length, 1);
        const storedId = rows[0]?.orchestrationId;
        assert.ok(
          storedId === firstId || storedId === secondId,
          `unexpected stored claim ${String(storedId)}`,
        );
        // Whatever the winner is, its two same-id peers see an idempotent claim
        // and the three workers carrying the other id see a conflict.
        assert.equal(
          statuses.filter((status) => status === "duplicate:already_claimed").length,
          2,
          JSON.stringify(statuses),
        );
        assert.equal(
          statuses.filter((status) => status === "duplicate:conflict").length,
          3,
          JSON.stringify(statuses),
        );
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
