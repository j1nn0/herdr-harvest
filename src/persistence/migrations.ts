import type { DatabaseSync } from "node:sqlite";

import { withTransaction } from "./database.ts";

export interface Migration {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
}

const createResults: Migration = {
  version: 1,
  name: "create-results",
  up(db) {
    db.exec(`
      CREATE TABLE results (
        id                  TEXT    PRIMARY KEY,
        captured_at_ms      INTEGER NOT NULL,
        workspace_id        TEXT,
        workspace_name      TEXT,
        tab_id              TEXT,
        pane_id             TEXT    NOT NULL,
        pane_name           TEXT,
        agent_name          TEXT,
        agent_kind          TEXT,
        agent_session_kind  TEXT,
        agent_session_value TEXT,
        capture_source      TEXT    NOT NULL,
        capture_line_count  INTEGER NOT NULL,
        raw_text            TEXT    NOT NULL,
        content_hash        TEXT    NOT NULL,
        dedup_key           TEXT    NOT NULL,
        read_at_ms          INTEGER,
        archived_at_ms      INTEGER
      );
      CREATE UNIQUE INDEX results_dedup_key ON results (dedup_key);
      CREATE INDEX results_inbox_order ON results (archived_at_ms, read_at_ms, captured_at_ms DESC);
    `);
  },
};

export const MIGRATIONS: readonly Migration[] = [createResults];

export function runMigrations(db: DatabaseSync): { from: number; to: number; applied: string[] } {
  const currentVersion = readUserVersion(db);
  const newestVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (currentVersion > newestVersion) {
    throw new Error(
      `Database user_version ${currentVersion} is newer than this Harvest supports (latest ${newestVersion}).`,
    );
  }

  const applied: string[] = [];
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) {
      continue;
    }

    withTransaction(db, () => {
      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    });
    applied.push(migration.name);
  }

  return {
    from: currentVersion,
    to: newestVersion,
    applied,
  };
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const version = row?.user_version;
  return typeof version === "number" ? version : 0;
}
