import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

import { contentHash, dedupKey } from "../src/domain/dedup.ts";
import type { CaptureInput, HarvestResult } from "../src/domain/result.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.ts";
import type { InsertOutcome } from "../src/persistence/result-store.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";

function makeInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    capturedAtMs: 1_000,
    workspaceId: "workspace-a",
    workspaceName: "Workspace A",
    tabId: "tab-a",
    paneId: "pane-a",
    paneName: "Pane A",
    agentName: "Agent A",
    agentKind: "terminal",
    agentSessionKind: "id",
    agentSessionValue: "session-a",
    herdrSessionKey: "/tmp/herdr/sessions/a/herdr.sock",
    herdrSessionLabel: "a",
    captureSource: "recent-unwrapped",
    captureLineCount: 400,
    rawText: "completion output",
    ...overrides,
  };
}

function inserted(outcome: InsertOutcome): HarvestResult {
  assert.equal(outcome.status, "inserted");
  if (outcome.status !== "inserted") {
    throw new Error("Expected an inserted result.");
  }
  return outcome.result;
}

describe("migrations", () => {
  test("migrates a fresh database and is idempotent", () => {
    const db = openDatabase(":memory:");
    try {
      const latest = MIGRATIONS[MIGRATIONS.length - 1];
      if (latest === undefined) {
        throw new Error("Expected at least one migration.");
      }

      assert.deepEqual(runMigrations(db), {
        from: 0,
        to: latest.version,
        applied: MIGRATIONS.map((migration) => migration.name),
      });
      assert.deepEqual(runMigrations(db), {
        from: latest.version,
        to: latest.version,
        applied: [],
      });
    } finally {
      db.close();
    }
  });

  test("rejects a database from a newer Harvest version", () => {
    const db = openDatabase(":memory:");
    try {
      db.exec("PRAGMA user_version = 999");
      assert.throws(() => runMigrations(db), /user_version.*newer/);
    } finally {
      db.close();
    }
  });

  test("keeps existing data readable after a migration re-run", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const result = inserted(store.insert(makeInput()));
      assert.deepEqual(runMigrations(db).applied, []);
      assert.deepEqual(store.get(result.id), result);
    } finally {
      store.close();
    }
  });

  test("opens a cold database while another connection holds an exclusive lock", () => {
    // Regression: `PRAGMA journal_mode = WAL` takes an exclusive lock, and SQLite does
    // not run the busy handler for that conversion, so a second process opening a
    // brand new database at the same moment used to die with "database is locked".
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-wal-race-"));
    const databasePath = join(directory, "harvest.db");
    let holder: ReturnType<typeof openDatabase> | null = null;
    let contender: ReturnType<typeof openDatabase> | null = null;
    try {
      holder = new DatabaseSync(databasePath);
      holder.exec("PRAGMA busy_timeout = 0");
      holder.exec("CREATE TABLE lock_holder (id INTEGER PRIMARY KEY)");
      holder.exec("BEGIN EXCLUSIVE");

      contender = openDatabase(databasePath);
      assert.ok(contender !== null);

      holder.exec("ROLLBACK");
    } finally {
      contender?.close();
      holder?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test("upgrades a v1 database without changing legacy rows", () => {
  const db = openDatabase(":memory:");
  const v1 = MIGRATIONS[0];
  if (v1 === undefined) {
    throw new Error("Expected the v1 migration.");
  }

  const legacy = {
    id: "legacy-result",
    capturedAtMs: 123_456,
    workspaceId: "legacy-workspace",
    workspaceName: "Legacy Workspace",
    tabId: "legacy-tab",
    paneId: "legacy-pane",
    paneName: "Legacy Pane",
    agentName: "Legacy Agent",
    agentKind: "legacy-kind",
    agentSessionKind: "path",
    agentSessionValue: "/tmp/legacy-session.jsonl",
    captureSource: "recent-unwrapped",
    captureLineCount: 321,
    rawText: "  legacy output  \\n世界 🚀\\n",
    contentHash: "legacy-content-hash",
    dedupKey: "legacy-dedup-key",
    readAtMs: 456_789,
    archivedAtMs: 567_890,
  } as const;

  try {
    v1.up(db);
    db.exec("PRAGMA user_version = 1");
    db.prepare(`
        INSERT INTO results (
          id,
          captured_at_ms,
          workspace_id,
          workspace_name,
          tab_id,
          pane_id,
          pane_name,
          agent_name,
          agent_kind,
          agent_session_kind,
          agent_session_value,
          capture_source,
          capture_line_count,
          raw_text,
          content_hash,
          dedup_key,
          read_at_ms,
          archived_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
      legacy.id,
      legacy.capturedAtMs,
      legacy.workspaceId,
      legacy.workspaceName,
      legacy.tabId,
      legacy.paneId,
      legacy.paneName,
      legacy.agentName,
      legacy.agentKind,
      legacy.agentSessionKind,
      legacy.agentSessionValue,
      legacy.captureSource,
      legacy.captureLineCount,
      legacy.rawText,
      legacy.contentHash,
      legacy.dedupKey,
      legacy.readAtMs,
      legacy.archivedAtMs,
    );

    assert.deepEqual(runMigrations(db), {
      from: 1,
      to: 2,
      applied: ["add-herdr-session"],
    });
    const version = db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    assert.equal(version?.user_version, 2);

    const store = new SqliteResultStore(db);
    assert.deepEqual(store.get(legacy.id), {
      id: legacy.id,
      capturedAtMs: legacy.capturedAtMs,
      workspaceId: legacy.workspaceId,
      workspaceName: legacy.workspaceName,
      tabId: legacy.tabId,
      paneId: legacy.paneId,
      paneName: legacy.paneName,
      agentName: legacy.agentName,
      agentKind: legacy.agentKind,
      agentSessionKind: legacy.agentSessionKind,
      agentSessionValue: legacy.agentSessionValue,
      herdrSessionKey: null,
      herdrSessionLabel: null,
      captureSource: legacy.captureSource,
      captureLineCount: legacy.captureLineCount,
      rawText: legacy.rawText,
      contentHash: legacy.contentHash,
      dedupKey: legacy.dedupKey,
      readAtMs: legacy.readAtMs,
      archivedAtMs: legacy.archivedAtMs,
    });
  } finally {
    db.close();
  }
});
describe("database permissions", () => {
  test("protects newly created state and preserves an existing state directory mode", {
    skip: process.platform === "win32",
  }, () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-permissions-"));
    try {
      const freshStateDirectory = join(directory, "fresh-state");
      const freshDatabasePath = join(freshStateDirectory, "harvest.db");
      const freshDb = openDatabase(freshDatabasePath);
      try {
        assert.equal(statSync(freshStateDirectory).mode & 0o777, 0o700);
        assert.equal(statSync(freshDatabasePath).mode & 0o777, 0o600);
      } finally {
        freshDb.close();
      }

      const existingStateDirectory = join(directory, "existing-state");
      mkdirSync(existingStateDirectory);
      chmodSync(existingStateDirectory, 0o755);
      const existingDb = openDatabase(join(existingStateDirectory, "harvest.db"));
      try {
        assert.equal(statSync(existingStateDirectory).mode & 0o777, 0o755);
      } finally {
        existingDb.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("SqliteResultStore", () => {
  test("round-trips every field, including nulls", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const input = makeInput({
        workspaceId: null,
        workspaceName: null,
        tabId: null,
        paneName: null,
        agentName: null,
        agentKind: null,
        agentSessionKind: null,
        agentSessionValue: null,
        rawText: "unicode: 世界 🚀\nline two",
      });
      const result = inserted(store.insert(input));

      assert.deepEqual(store.get(result.id), result);
      assert.deepEqual(
        {
          capturedAtMs: result.capturedAtMs,
          workspaceId: result.workspaceId,
          workspaceName: result.workspaceName,
          tabId: result.tabId,
          paneId: result.paneId,
          paneName: result.paneName,
          agentName: result.agentName,
          agentKind: result.agentKind,
          agentSessionKind: result.agentSessionKind,
          agentSessionValue: result.agentSessionValue,
          herdrSessionKey: result.herdrSessionKey,
          herdrSessionLabel: result.herdrSessionLabel,
          captureSource: result.captureSource,
          captureLineCount: result.captureLineCount,
          rawText: result.rawText,
          readAtMs: result.readAtMs,
          archivedAtMs: result.archivedAtMs,
        },
        { ...input, readAtMs: null, archivedAtMs: null },
      );
      assert.equal(result.contentHash, contentHash(input.rawText));
      assert.equal(result.dedupKey, dedupKey(input, contentHash(input.rawText)));
    } finally {
      store.close();
    }
  });

  test("preserves unicode and very large raw text exactly", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const rawText = "世界🚀\n".repeat(100_000);
      const result = inserted(store.insert(makeInput({ rawText })));

      assert.equal(store.get(result.id)?.rawText, rawText);
    } finally {
      store.close();
    }
  });

  test("deduplicates identical input and stores different input once each", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const input = makeInput();
      const first = store.insert(input);
      const second = store.insert(input);
      const different = store.insert(makeInput({ rawText: "different output" }));

      assert.equal(first.status, "inserted");
      assert.equal(second.status, "duplicate");
      assert.equal(second.result.id, first.result.id);
      assert.equal(different.status, "inserted");
      assert.equal(store.list({ includeArchived: true }).length, 2);
    } finally {
      store.close();
    }
  });

  test("separates identical pane captures from different Herdr sessions", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const first = inserted(
        store.insert(
          makeInput({
            agentSessionKind: null,
            agentSessionValue: null,
            herdrSessionKey: "socket-a",
            herdrSessionLabel: "alpha",
          }),
        ),
      );
      const second = inserted(
        store.insert({
          ...makeInput({
            agentSessionKind: null,
            agentSessionValue: null,
            herdrSessionKey: "socket-b",
            herdrSessionLabel: "beta",
          }),
        }),
      );

      assert.notEqual(first.dedupKey, second.dedupKey);
      assert.equal(store.list({ includeArchived: true }).length, 2);
      assert.deepEqual(store.distinctHerdrSessionKeys().sort(), ["socket-a", "socket-b"]);
    } finally {
      store.close();
    }
  });

  test("deduplicates repeated pane captures within one Herdr session", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const input = makeInput({
        agentSessionKind: null,
        agentSessionValue: null,
        herdrSessionKey: "socket-a",
        herdrSessionLabel: "alpha",
      });
      const first = store.insert(input);
      const second = store.insert(input);

      assert.equal(first.status, "inserted");
      assert.equal(second.status, "duplicate");
      assert.equal(second.result.id, first.result.id);
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      store.close();
    }
  });

  test("deduplicates with and without native session identity", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const session = makeInput({
        paneId: "pane-session-a",
        agentSessionKind: "id",
        agentSessionValue: "native-a",
        rawText: "same output",
      });
      assert.equal(store.insert(session).status, "inserted");
      assert.equal(store.insert({ ...session, capturedAtMs: 2_000 }).status, "duplicate");
      assert.equal(store.insert({ ...session, agentSessionValue: "native-b" }).status, "inserted");
      assert.equal(store.insert({ ...session, rawText: "new output" }).status, "inserted");

      const paneScoped = makeInput({
        paneId: "pane-scoped-a",
        agentSessionKind: null,
        agentSessionValue: null,
        rawText: "pane output",
      });
      assert.equal(store.insert(paneScoped).status, "inserted");
      assert.equal(store.insert({ ...paneScoped, capturedAtMs: 3_000 }).status, "duplicate");
      assert.equal(store.insert({ ...paneScoped, paneId: "pane-scoped-b" }).status, "inserted");
    } finally {
      store.close();
    }
  });

  test("orders unread results before read results and excludes archived by default", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const unreadOld = inserted(
        store.insert(makeInput({ capturedAtMs: 100, rawText: "unread old" })),
      );
      const unreadNew = inserted(
        store.insert(makeInput({ capturedAtMs: 300, rawText: "unread new" })),
      );
      const readOld = inserted(store.insert(makeInput({ capturedAtMs: 200, rawText: "read old" })));
      const readNew = inserted(store.insert(makeInput({ capturedAtMs: 500, rawText: "read new" })));
      store.markRead(readOld.id, 1_000);
      store.markRead(readNew.id, 1_001);
      store.archive(unreadOld.id, 1_002);

      assert.deepEqual(
        store.list().map((result) => result.id),
        [unreadNew.id, readNew.id, readOld.id],
      );
      assert.deepEqual(
        store.list({ includeArchived: true }).map((result) => result.id),
        [unreadNew.id, unreadOld.id, readNew.id, readOld.id],
      );
    } finally {
      store.close();
    }
  });

  test("markRead is idempotent and returns null for an unknown id", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const result = inserted(store.insert(makeInput()));

      assert.equal(store.markRead("missing", 10), null);
      assert.equal(store.markRead(result.id, 10)?.readAtMs, 10);
      assert.equal(store.markRead(result.id, 20)?.readAtMs, 10);
    } finally {
      store.close();
    }
  });

  test("archive is idempotent and returns null for an unknown id", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const result = inserted(store.insert(makeInput()));

      assert.equal(store.archive("missing", 10), null);
      assert.equal(store.archive(result.id, 10)?.archivedAtMs, 10);
      assert.equal(store.archive(result.id, 20)?.archivedAtMs, 10);
    } finally {
      store.close();
    }
  });

  test("handles two stores inserting the same key", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-"));
    const databasePath = join(directory, "nested", "harvest.db");
    const db1 = openDatabase(databasePath);
    const db2 = openDatabase(databasePath);
    const store1 = new SqliteResultStore(db1);
    const store2 = new SqliteResultStore(db2);
    try {
      const input = makeInput({ rawText: "racing output" });
      const outcomes = await Promise.all([
        Promise.resolve().then(() => store1.insert(input)),
        Promise.resolve().then(() => store2.insert(input)),
      ]);

      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["duplicate", "inserted"]);
      assert.equal(outcomes[0]?.result.id, outcomes[1]?.result.id);
      assert.equal(store1.list({ includeArchived: true }).length, 1);
      assert.equal(store2.list({ includeArchived: true }).length, 1);
    } finally {
      store1.close();
      store2.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
