import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";

import { contentHash, dedupKey } from "../src/domain/dedup.ts";
import type { OrchestrationClaim, OrchestrationRole } from "../src/domain/orchestration.ts";
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
    requestedLineCount: 400,
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

/** The schema version a database reports. */
function versionOf(db: DatabaseSync): number | undefined {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return row?.user_version;
}

/** Column names of the results table, in table order. */
function resultColumnNames(db: DatabaseSync): string[] {
  const rows = db.prepare("PRAGMA table_info(results)").all() as Array<{ name?: unknown }>;
  return rows.map((row) => String(row.name));
}

/** Index names defined on the results table. */
function resultIndexNames(db: DatabaseSync): string[] {
  const rows = db.prepare("PRAGMA index_list(results)").all() as Array<{ name?: unknown }>;
  return rows.map((row) => String(row.name));
}

/** The result without its claim fields, for byte-for-byte comparisons. */
function withoutClaim(result: HarvestResult): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...result };
  delete copy.orchestrationId;
  delete copy.orchestrationLabel;
  delete copy.orchestrationRole;
  return copy;
}

/** The claim fields of one stored result, for whole-value comparisons. */
function claimOf(result: HarvestResult): {
  orchestrationId: string | null;
  orchestrationLabel: string | null;
  orchestrationRole: string | null;
} {
  return {
    orchestrationId: result.orchestrationId,
    orchestrationLabel: result.orchestrationLabel,
    orchestrationRole: result.orchestrationRole,
  };
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

  test("gives a fresh database the orchestration claim column and index", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      assert.equal(versionOf(db), 4);
      assert.deepEqual(
        resultColumnNames(db).filter((name) => name.startsWith("orchestration_")),
        ["orchestration_id", "orchestration_label", "orchestration_role"],
      );
      assert.ok(resultIndexNames(db).includes("results_orchestration_id"));

      const result = inserted(store.insert(makeInput()));
      assert.equal(result.orchestrationId, null);
      assert.equal(result.orchestrationLabel, null);
      assert.equal(result.orchestrationRole, null);
    } finally {
      store.close();
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
    requestedLineCount: 321,
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
      legacy.requestedLineCount,
      legacy.rawText,
      legacy.contentHash,
      legacy.dedupKey,
      legacy.readAtMs,
      legacy.archivedAtMs,
    );

    assert.deepEqual(runMigrations(db), {
      from: 1,
      to: 4,
      applied: ["add-herdr-session", "create-pane-lifecycle", "add-orchestration-claim"],
    });
    const version = db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    assert.equal(version?.user_version, 4);

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
      requestedLineCount: legacy.requestedLineCount,
      rawText: legacy.rawText,
      contentHash: legacy.contentHash,
      dedupKey: legacy.dedupKey,
      readAtMs: legacy.readAtMs,
      archivedAtMs: legacy.archivedAtMs,
      orchestrationId: null,
      orchestrationLabel: null,
      orchestrationRole: null,
    });
  } finally {
    db.close();
  }
});

test("upgrades a v2 database without changing legacy rows", () => {
  const db = openDatabase(":memory:");
  const v1 = MIGRATIONS[0];
  const v2 = MIGRATIONS[1];
  if (v1 === undefined || v2 === undefined) {
    throw new Error("Expected the v1 and v2 migrations.");
  }

  const legacy = {
    id: "legacy-v2-result",
    capturedAtMs: 223_344,
    workspaceId: "v2-workspace",
    workspaceName: "V2 Workspace",
    tabId: "v2-tab",
    paneId: "v2-pane",
    paneName: "V2 Pane",
    agentName: "V2 Agent",
    agentKind: "v2-kind",
    agentSessionKind: "id",
    agentSessionValue: "v2-session",
    captureSource: "detection",
    requestedLineCount: 123,
    rawText: "  v2 output  \\n世界 🚀\\n",
    contentHash: "v2-content-hash",
    dedupKey: "v2-dedup-key",
    herdrSessionKey: "socket-v2",
    herdrSessionLabel: "v2",
    readAtMs: 334_455,
    archivedAtMs: 445_566,
  };

  try {
    v1.up(db);
    db.exec("PRAGMA user_version = 1");
    v2.up(db);
    db.exec("PRAGMA user_version = 2");
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
        herdr_session_key,
        herdr_session_label,
        read_at_ms,
        archived_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      legacy.requestedLineCount,
      legacy.rawText,
      legacy.contentHash,
      legacy.dedupKey,
      legacy.herdrSessionKey,
      legacy.herdrSessionLabel,
      legacy.readAtMs,
      legacy.archivedAtMs,
    );

    assert.deepEqual(runMigrations(db), {
      from: 2,
      to: 4,
      applied: ["create-pane-lifecycle", "add-orchestration-claim"],
    });
    const version = db.prepare("PRAGMA user_version").get();
    assert.equal(version?.user_version, 4);

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
      herdrSessionKey: legacy.herdrSessionKey,
      herdrSessionLabel: legacy.herdrSessionLabel,
      captureSource: legacy.captureSource,
      requestedLineCount: legacy.requestedLineCount,
      rawText: legacy.rawText,
      contentHash: legacy.contentHash,
      dedupKey: legacy.dedupKey,
      readAtMs: legacy.readAtMs,
      archivedAtMs: legacy.archivedAtMs,
      orchestrationId: null,
      orchestrationLabel: null,
      orchestrationRole: null,
    });
  } finally {
    db.close();
  }
});

test("upgrades a v3 database without changing legacy rows", () => {
  const db = openDatabase(":memory:");
  const v1 = MIGRATIONS[0];
  const v2 = MIGRATIONS[1];
  const v3 = MIGRATIONS[2];
  if (v1 === undefined || v2 === undefined || v3 === undefined) {
    throw new Error("Expected the v1, v2, and v3 migrations.");
  }

  const legacy = {
    id: "legacy-v3-result",
    capturedAtMs: 334_455,
    workspaceId: "v3-workspace",
    workspaceName: "V3 Workspace",
    tabId: "v3-tab",
    paneId: "v3-pane",
    paneName: "V3 Pane",
    agentName: "V3 Agent",
    agentKind: "v3-kind",
    agentSessionKind: "id",
    agentSessionValue: "v3-session",
    captureSource: "detection",
    requestedLineCount: 12,
    rawText: "  v3 output  \\n世界 🚀\\n",
    contentHash: "v3-content-hash",
    dedupKey: "v3-dedup-key",
    herdrSessionKey: "socket-v3",
    herdrSessionLabel: "v3",
    readAtMs: 445_566,
    archivedAtMs: 556_677,
  };

  try {
    v1.up(db);
    db.exec("PRAGMA user_version = 1");
    v2.up(db);
    db.exec("PRAGMA user_version = 2");
    v3.up(db);
    db.exec("PRAGMA user_version = 3");
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
        herdr_session_key,
        herdr_session_label,
        read_at_ms,
        archived_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      legacy.requestedLineCount,
      legacy.rawText,
      legacy.contentHash,
      legacy.dedupKey,
      legacy.herdrSessionKey,
      legacy.herdrSessionLabel,
      legacy.readAtMs,
      legacy.archivedAtMs,
    );

    assert.deepEqual(runMigrations(db), {
      from: 3,
      to: 4,
      applied: ["add-orchestration-claim"],
    });
    assert.equal(versionOf(db), 4);

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
      herdrSessionKey: legacy.herdrSessionKey,
      herdrSessionLabel: legacy.herdrSessionLabel,
      captureSource: legacy.captureSource,
      requestedLineCount: legacy.requestedLineCount,
      rawText: legacy.rawText,
      contentHash: legacy.contentHash,
      dedupKey: legacy.dedupKey,
      readAtMs: legacy.readAtMs,
      archivedAtMs: legacy.archivedAtMs,
      orchestrationId: null,
      orchestrationLabel: null,
      orchestrationRole: null,
    });
    assert.ok(resultColumnNames(db).includes("orchestration_id"));
    assert.ok(resultIndexNames(db).includes("results_orchestration_id"));
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
          requestedLineCount: result.requestedLineCount,
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

  test("stores the requested line count independently of returned text", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const input = makeInput({ requestedLineCount: 5000, rawText: "one returned row" });
      const result = inserted(store.insert(input));
      const row = db
        .prepare("SELECT capture_line_count FROM results WHERE id = ?")
        .get(result.id) as { capture_line_count?: number } | undefined;

      assert.equal(result.requestedLineCount, 5000);
      assert.equal(row?.capture_line_count, 5000);
      assert.equal(versionOf(db), 4);
      assert.ok(resultColumnNames(db).includes("capture_line_count"));
    } finally {
      store.close();
    }
  });

  test("deduplicates identical identity and content despite different requested counts", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const input = makeInput();
      const first = store.insert(input);
      const second = store.insert(makeInput({ requestedLineCount: 5000 }));
      const different = store.insert(makeInput({ rawText: "different output" }));

      assert.equal(first.status, "inserted");
      assert.equal(second.status, "duplicate");
      assert.equal(second.result.id, first.result.id);
      assert.equal(second.result.requestedLineCount, first.result.requestedLineCount);
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

  test("observes and upserts pane lifecycle status by session and pane", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: "socket-a",
          paneId: "pane-a",
          agentStatus: "working",
          atMs: 100,
        }),
        { previousStatus: null },
      );
      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: "socket-a",
          paneId: "pane-a",
          agentStatus: "idle",
          atMs: 200,
        }),
        { previousStatus: "working" },
      );
      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: "socket-a",
          paneId: "pane-b",
          agentStatus: "idle",
          atMs: 300,
        }),
        { previousStatus: null },
      );
      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: "socket-b",
          paneId: "pane-a",
          agentStatus: "unknown",
          atMs: 400,
        }),
        { previousStatus: null },
      );
      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: "socket-a",
          paneId: "pane-a",
          agentStatus: "done",
          atMs: 500,
        }),
        { previousStatus: "idle" },
      );

      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: null,
          paneId: "pane-unknown",
          agentStatus: "idle",
          atMs: 600,
        }),
        { previousStatus: null },
      );
      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: "",
          paneId: "pane-unknown",
          agentStatus: "working",
          atMs: 700,
        }),
        { previousStatus: "idle" },
      );
      assert.deepEqual(
        store.observePaneStatus({
          herdrSessionKey: null,
          paneId: "pane-unknown",
          agentStatus: "done",
          atMs: 800,
        }),
        { previousStatus: "working" },
      );
    } finally {
      store.close();
    }
  });

  test("separates archived results from the active list", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const archived = inserted(
        store.insert(makeInput({ capturedAtMs: 100, rawText: "archived output" })),
      );
      const active = inserted(
        store.insert(makeInput({ capturedAtMs: 200, rawText: "active output" })),
      );
      store.markRead(archived.id, 500);
      store.archive(archived.id, 1_000);

      assert.deepEqual(
        store.listArchived().map((result) => result.id),
        [archived.id],
      );
      assert.equal(store.listArchived()[0]?.archivedAtMs, 1_000);
      assert.equal(store.listArchived()[0]?.readAtMs, 500);
      assert.deepEqual(
        store.list().map((result) => result.id),
        [active.id],
      );
      assert.deepEqual(
        store
          .list({ includeArchived: true })
          .map((result) => result.id)
          .sort(),
        [active.id, archived.id].sort(),
      );
    } finally {
      store.close();
    }
  });

  test("orders archived results by archive time, captured time, then id", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const first = inserted(store.insert(makeInput({ capturedAtMs: 100, rawText: "first" })));
      const second = inserted(store.insert(makeInput({ capturedAtMs: 200, rawText: "second" })));
      const third = inserted(store.insert(makeInput({ capturedAtMs: 300, rawText: "third" })));
      store.archive(first.id, 1_000);
      store.archive(second.id, 2_000);
      store.archive(third.id, 3_000);

      const olderCapture = inserted(
        store.insert(makeInput({ capturedAtMs: 10, rawText: "older capture" })),
      );
      const newerCapture = inserted(
        store.insert(makeInput({ capturedAtMs: 20, rawText: "newer capture" })),
      );
      store.archive(olderCapture.id, 4_000);
      store.archive(newerCapture.id, 4_000);

      const twinA = inserted(store.insert(makeInput({ capturedAtMs: 30, rawText: "twin a" })));
      const twinB = inserted(store.insert(makeInput({ capturedAtMs: 30, rawText: "twin b" })));
      store.archive(twinA.id, 5_000);
      store.archive(twinB.id, 5_000);

      const twins = [twinA.id, twinB.id].sort((left, right) => (left < right ? 1 : -1));
      assert.deepEqual(
        store.listArchived().map((result) => result.id),
        [...twins, newerCapture.id, olderCapture.id, third.id, second.id, first.id],
      );
      assert.deepEqual(
        store.listArchived({ limit: 3 }).map((result) => result.id),
        [...twins, newerCapture.id],
      );
      assert.deepEqual(store.listArchived({ limit: 0 }), []);
      assert.throws(() => store.listArchived({ limit: -1 }), RangeError);
      assert.throws(() => store.listArchived({ limit: 1.5 }), RangeError);
    } finally {
      store.close();
    }
  });

  test("restores an archived result without changing its stored fields", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const rawText = "first line\n\nsecond line 世界 🚀\n";
      const input = makeInput({ capturedAtMs: 1_234, rawText });
      const result = inserted(store.insert(input));
      store.markRead(result.id, 111);
      assert.equal(store.archive(result.id, 222)?.archivedAtMs, 222);

      const restored = store.restore(result.id);

      assert.deepEqual(restored, { ...result, readAtMs: 111, archivedAtMs: null });
      assert.equal(restored?.rawText, rawText);
      assert.equal(restored?.capturedAtMs, 1_234);
      assert.equal(restored?.contentHash, result.contentHash);
      assert.equal(restored?.dedupKey, result.dedupKey);
      assert.equal(restored?.agentSessionKind, input.agentSessionKind);
      assert.equal(restored?.agentSessionValue, input.agentSessionValue);
      assert.equal(restored?.herdrSessionKey, input.herdrSessionKey);
      assert.equal(restored?.herdrSessionLabel, input.herdrSessionLabel);
      assert.equal(restored?.paneId, input.paneId);
      assert.deepEqual(store.listArchived(), []);
      assert.deepEqual(
        store.list().map((row) => row.id),
        [result.id],
      );
    } finally {
      store.close();
    }
  });

  test("is a no-op for active rows and supports an archive, restore, archive cycle", () => {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      const result = inserted(store.insert(makeInput()));

      assert.equal(store.restore("missing"), null);
      assert.deepEqual(store.restore(result.id), result);

      assert.equal(store.archive(result.id, 1_000)?.archivedAtMs, 1_000);
      assert.equal(store.restore(result.id)?.archivedAtMs, null);
      assert.equal(store.archive(result.id, 2_000)?.archivedAtMs, 2_000);
      assert.deepEqual(store.list(), []);
      assert.deepEqual(
        store.listArchived().map((row) => row.id),
        [result.id],
      );

      assert.equal(store.restore(result.id)?.archivedAtMs, null);
      assert.deepEqual(store.listArchived(), []);
      assert.deepEqual(
        store.list({ includeArchived: true }).map((row) => row.id),
        [result.id],
      );
    } finally {
      store.close();
    }
  });
});

describe("orchestration claims", () => {
  const claim: OrchestrationClaim = {
    id: "2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50",
    label: "探索: fix the parser",
    role: "explorer",
  };
  const rival: OrchestrationClaim = {
    id: "7c9e1d2a-3b4c-4d5e-8f90-a1b2c3d4e5f6",
    label: "Repair the parser",
    role: "fixer",
  };

  function withStore(run: (store: SqliteResultStore) => void): void {
    const db = openDatabase(":memory:");
    const store = new SqliteResultStore(db);
    try {
      run(store);
    } finally {
      store.close();
    }
  }

  test("records no claim for an automatic capture", () => {
    withStore((store) => {
      const outcome = store.insert(makeInput());
      assert.equal(outcome.status, "inserted");
      assert.equal(outcome.claim, undefined);
      assert.deepEqual(claimOf(outcome.result), {
        orchestrationId: null,
        orchestrationLabel: null,
        orchestrationRole: null,
      });
    });
  });

  test("claims a fresh capture inside the insert", () => {
    withStore((store) => {
      const outcome = store.insert(makeInput(), claim);
      assert.equal(outcome.status, "inserted");
      assert.deepEqual(outcome.claim, { status: "claimed", orchestrationId: claim.id });
      assert.deepEqual(claimOf(outcome.result), {
        orchestrationId: claim.id,
        orchestrationLabel: claim.label,
        orchestrationRole: claim.role,
      });
      assert.deepEqual(store.get(outcome.result.id), outcome.result);
    });
  });

  test("treats an identical repeated claim as idempotent", () => {
    withStore((store) => {
      const first = store.insert(makeInput(), claim);
      const second = store.insert(makeInput(), claim);

      assert.equal(second.status, "duplicate");
      assert.deepEqual(second.claim, { status: "already_claimed", orchestrationId: claim.id });
      assert.equal(second.result.id, first.result.id);
      assert.deepEqual(claimOf(second.result), {
        orchestrationId: claim.id,
        orchestrationLabel: claim.label,
        orchestrationRole: claim.role,
      });
      assert.equal(store.list({ includeArchived: true }).length, 1);
    });
  });

  test("conflicts when a different task claims the same content", () => {
    withStore((store) => {
      const first = store.insert(makeInput(), claim);
      const second = store.insert(makeInput(), rival);

      assert.equal(second.status, "duplicate");
      assert.deepEqual(second.claim, {
        status: "conflict",
        requestedOrchestrationId: rival.id,
        existingOrchestrationId: claim.id,
      });
      // First writer wins: the stored row keeps the original claim untouched.
      assert.deepEqual(claimOf(second.result), {
        orchestrationId: claim.id,
        orchestrationLabel: claim.label,
        orchestrationRole: claim.role,
      });
      assert.deepEqual(store.get(first.result.id), first.result);
      assert.equal(store.list({ includeArchived: true }).length, 1);
    });
  });

  test("conflicts when the same id returns with a different label or role", () => {
    withStore((store) => {
      store.insert(makeInput(), claim);

      const otherLabel = store.insert(makeInput(), { ...claim, label: "another label" });
      assert.deepEqual(otherLabel.claim, {
        status: "conflict",
        requestedOrchestrationId: claim.id,
        existingOrchestrationId: claim.id,
      });

      const otherRole = store.insert(makeInput(), { ...claim, role: "fixer" });
      assert.deepEqual(otherRole.claim, {
        status: "conflict",
        requestedOrchestrationId: claim.id,
        existingOrchestrationId: claim.id,
      });
      assert.equal(store.get(otherRole.result.id)?.orchestrationLabel, claim.label);
      assert.equal(store.get(otherRole.result.id)?.orchestrationRole, "explorer");
    });
  });

  test("keeps every non-orchestration field byte-for-byte when claiming a row", () => {
    withStore((store) => {
      const rawText = "first line  \n\n世界 🚀\ttrailing  ";
      const result = inserted(store.insert(makeInput({ capturedAtMs: 1_234, rawText })));
      const before = store.get(result.id);
      if (before === null) {
        throw new Error("Expected the stored result.");
      }

      const claimed = store.claimOrchestration(result.id, claim);
      assert.equal(claimed.status, "claimed");
      if (claimed.status !== "claimed") {
        throw new Error("Expected a claimed outcome.");
      }

      assert.deepEqual(withoutClaim(claimed.result), withoutClaim(before));
      assert.equal(claimed.result.rawText, rawText);
      assert.deepEqual([...claimed.result.rawText], [...rawText]);
      assert.equal(claimed.result.contentHash, before.contentHash);
      assert.equal(claimed.result.dedupKey, before.dedupKey);
      assert.equal(claimed.result.capturedAtMs, before.capturedAtMs);
    });
  });

  test("claims an existing unclaimed row and reports an unknown id", () => {
    withStore((store) => {
      const result = inserted(store.insert(makeInput()));

      const claimed = store.claimOrchestration(result.id, claim);
      assert.equal(claimed.status, "claimed");
      if (claimed.status !== "claimed") {
        throw new Error("Expected a claimed outcome.");
      }
      assert.deepEqual(claimOf(claimed.result), {
        orchestrationId: claim.id,
        orchestrationLabel: claim.label,
        orchestrationRole: claim.role,
      });
      assert.deepEqual(store.claimOrchestration("missing", claim), { status: "not_found" });
    });
  });

  test("claims an archived row without changing its flags", () => {
    withStore((store) => {
      const result = inserted(store.insert(makeInput()));
      store.markRead(result.id, 10);
      store.archive(result.id, 20);

      const claimed = store.claimOrchestration(result.id, claim);
      assert.equal(claimed.status, "claimed");
      if (claimed.status !== "claimed") {
        throw new Error("Expected a claimed outcome.");
      }
      assert.equal(claimed.result.readAtMs, 10);
      assert.equal(claimed.result.archivedAtMs, 20);
    });
  });

  test("lets an explicit claim survive a later automatic capture", () => {
    withStore((store) => {
      const first = store.insert(makeInput(), claim);
      const automatic = store.insert(makeInput());

      assert.equal(automatic.status, "duplicate");
      assert.equal(automatic.claim, undefined);
      assert.deepEqual(claimOf(automatic.result), claimOf(first.result));
    });
  });

  test("lets an explicit claim follow an automatic capture", () => {
    withStore((store) => {
      const automatic = store.insert(makeInput());
      assert.equal(automatic.claim, undefined);

      const claimed = store.insert(makeInput(), claim);
      assert.equal(claimed.status, "duplicate");
      assert.deepEqual(claimed.claim, { status: "claimed", orchestrationId: claim.id });
      assert.equal(claimed.result.id, automatic.result.id);
      assert.deepEqual(claimOf(claimed.result), {
        orchestrationId: claim.id,
        orchestrationLabel: claim.label,
        orchestrationRole: claim.role,
      });
    });
  });

  test("resolves competing claims first-writer-wins in either order", () => {
    withStore((store) => {
      store.insert(makeInput(), claim);
      const lost = store.insert(makeInput(), rival);
      assert.deepEqual(lost.claim, {
        status: "conflict",
        requestedOrchestrationId: rival.id,
        existingOrchestrationId: claim.id,
      });
      assert.equal(lost.result.orchestrationLabel, claim.label);
    });

    withStore((store) => {
      store.insert(makeInput(), rival);
      const lost = store.insert(makeInput(), claim);
      assert.deepEqual(lost.claim, {
        status: "conflict",
        requestedOrchestrationId: claim.id,
        existingOrchestrationId: rival.id,
      });
      assert.equal(lost.result.orchestrationRole, "fixer");
    });
  });

  test("preserves a Unicode label exactly", () => {
    withStore((store) => {
      const label = "  探索 🔍 – 修正  ";
      const result = inserted(store.insert(makeInput(), { ...claim, label }));
      const stored = store.get(result.id);

      assert.equal(stored?.orchestrationLabel, label);
      assert.deepEqual([...(stored?.orchestrationLabel ?? "")], [...label]);
    });
  });

  test("rejects a malformed claim before writing a row", () => {
    withStore((store) => {
      assert.throws(() => store.insert(makeInput(), { ...claim, id: "orch_7f3a" }), RangeError);
      assert.throws(
        () => store.insert(makeInput(), { ...claim, id: claim.id.toUpperCase() }),
        RangeError,
      );
      assert.throws(
        () => store.insert(makeInput(), { ...claim, role: "Explorer" as OrchestrationRole }),
        RangeError,
      );
      assert.throws(() => store.insert(makeInput(), { ...claim, label: "   " }), RangeError);
      assert.throws(
        () => store.insert(makeInput(), { ...claim, label: "a".repeat(257) }),
        RangeError,
      );
      assert.deepEqual(store.list({ includeArchived: true }), []);
    });
  });
});
