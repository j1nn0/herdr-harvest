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

const addHerdrSession: Migration = {
  version: 2,
  name: "add-herdr-session",
  up(db) {
    db.exec(`
      ALTER TABLE results ADD COLUMN herdr_session_key   TEXT;
      ALTER TABLE results ADD COLUMN herdr_session_label TEXT;
    `);
  },
};

const createPaneLifecycle: Migration = {
  version: 3,
  name: "create-pane-lifecycle",
  up(db) {
    db.exec(`
      CREATE TABLE pane_lifecycle (
        herdr_session_key TEXT    NOT NULL,
        pane_id           TEXT    NOT NULL,
        agent_status      TEXT    NOT NULL,
        updated_at_ms     INTEGER NOT NULL,
        PRIMARY KEY (herdr_session_key, pane_id)
      );
    `);
  },
};

/**
 * Explicit orchestration claims. Existing rows keep NULL claims: a claim is
 * never backfilled, because only the caller that recorded the capture knows
 * which task it belonged to.
 */
const addOrchestrationClaim: Migration = {
  version: 4,
  name: "add-orchestration-claim",
  up(db) {
    db.exec(`
      ALTER TABLE results ADD COLUMN orchestration_id    TEXT;
      ALTER TABLE results ADD COLUMN orchestration_label TEXT;
      ALTER TABLE results ADD COLUMN orchestration_role  TEXT;
      CREATE INDEX results_orchestration_id ON results (orchestration_id);
    `);
  },
};

const createPiInteractions: Migration = {
  version: 5,
  name: "create-pi-interactions",
  up(db) {
    db.exec(`
      CREATE TABLE pi_interactions (
        interaction_id  TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        submitted_prompt TEXT NOT NULL,
        effective_prompt TEXT,
        final_report    TEXT,
        status          TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
        failure_reason  TEXT,
        provenance      TEXT NOT NULL,
        dedup_key       TEXT NOT NULL,
        PRIMARY KEY (session_id, interaction_id),
        CHECK (status != 'completed' OR (final_report IS NOT NULL AND failure_reason IS NULL)),
        CHECK (status != 'failed' OR (final_report IS NULL AND failure_reason IS NOT NULL)),
        CHECK (status != 'pending' OR final_report IS NULL)
      );
      CREATE UNIQUE INDEX pi_interactions_dedup_key ON pi_interactions (dedup_key);
    `);
  },
};

export const MIGRATIONS: readonly Migration[] = [
  createResults,
  addHerdrSession,
  createPaneLifecycle,
  addOrchestrationClaim,
  createPiInteractions,
];

export function runMigrations(db: DatabaseSync): { from: number; to: number; applied: string[] } {
  const newestVersion = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const observedVersion = readUserVersion(db);
  if (observedVersion > newestVersion) {
    throw new Error(
      `Database user_version ${observedVersion} is newer than this Harvest supports (latest ${newestVersion}).`,
    );
  }
  if (observedVersion === newestVersion) {
    return { from: observedVersion, to: newestVersion, applied: [] };
  }

  return withTransaction(db, () => {
    const currentVersion = readUserVersion(db);
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

      migration.up(db);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      applied.push(migration.name);
    }

    return {
      from: currentVersion,
      to: newestVersion,
      applied,
    };
  });
}

function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  const version = row?.user_version;
  return typeof version === "number" ? version : 0;
}
