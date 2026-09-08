import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentHash, dedupKey } from "../domain/dedup.ts";
import type { AgentSessionKind, CaptureInput, HarvestResult } from "../domain/result.ts";
import { withTransaction } from "./database.ts";
import { runMigrations } from "./migrations.ts";

export type InsertOutcome =
  | { status: "inserted"; result: HarvestResult }
  | { status: "duplicate"; result: HarvestResult };

export interface ResultStore {
  insert(input: CaptureInput): InsertOutcome;
  list(options?: { includeArchived?: boolean; limit?: number }): HarvestResult[];
  get(id: string): HarvestResult | null;
  markRead(id: string, atMs: number): HarvestResult | null;
  archive(id: string, atMs: number): HarvestResult | null;
  close(): void;
  distinctHerdrSessionKeys(): Array<string | null>;
}

type SqlRow = Record<string, unknown>;

type InsertParams = [
  string,
  number,
  string | null,
  string | null,
  string | null,
  string,
  string | null,
  string | null,
  string | null,
  AgentSessionKind | null,
  string | null,
  string,
  number,
  string,
  string,
  string,
  string | null,
  string | null,
];

const SELECT_BY_ID = "SELECT * FROM results WHERE id = ?";
const SELECT_BY_DEDUP_KEY = "SELECT * FROM results WHERE dedup_key = ?";

export class SqliteResultStore implements ResultStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    runMigrations(db);
  }

  insert(input: CaptureInput): InsertOutcome {
    const rawContentHash = contentHash(input.rawText);
    const key = dedupKey(input, rawContentHash);
    const id = randomUUID();
    const params: InsertParams = [
      id,
      input.capturedAtMs,
      input.workspaceId,
      input.workspaceName,
      input.tabId,
      input.paneId,
      input.paneName,
      input.agentName,
      input.agentKind,
      input.agentSessionKind,
      input.agentSessionValue,
      input.captureSource,
      input.captureLineCount,
      input.rawText,
      rawContentHash,
      key,
      input.herdrSessionKey,
      input.herdrSessionLabel,
    ];

    const transaction = withTransaction(this.db, () => {
      const changes = this.db
        .prepare(`
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
            herdr_session_label
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(dedup_key) DO NOTHING
        `)
        .run(...params);
      const row = this.db.prepare(SELECT_BY_DEDUP_KEY).get(key) as SqlRow | undefined;
      if (row === undefined) {
        throw new Error(`Inserted result ${id} could not be read back.`);
      }

      return { inserted: changes.changes > 0, row };
    });

    return {
      status: transaction.inserted ? "inserted" : "duplicate",
      result: mapRow(transaction.row),
    };
  }

  list(options: { includeArchived?: boolean; limit?: number } = {}): HarvestResult[] {
    const limit = options.limit;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
      throw new RangeError("Result list limit must be a non-negative integer.");
    }

    const where = options.includeArchived ? "" : "WHERE archived_at_ms IS NULL";
    const order = "ORDER BY (read_at_ms IS NOT NULL) ASC, captured_at_ms DESC, id DESC";
    const sql = `SELECT * FROM results ${where} ${order}`;
    const rows =
      limit === undefined
        ? (this.db.prepare(sql).all() as SqlRow[])
        : (this.db.prepare(`${sql} LIMIT ?`).all(limit) as SqlRow[]);
    return rows.map(mapRow);
  }

  distinctHerdrSessionKeys(): Array<string | null> {
    const rows = this.db
      .prepare("SELECT DISTINCT herdr_session_key FROM results")
      .all() as SqlRow[];
    return rows.map((row) => row.herdr_session_key as string | null);
  }

  get(id: string): HarvestResult | null {
    const row = this.rowById(id);
    return row === undefined ? null : mapRow(row);
  }

  markRead(id: string, atMs: number): HarvestResult | null {
    const row = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE results SET read_at_ms = ? WHERE id = ? AND read_at_ms IS NULL")
        .run(atMs, id);
      return this.rowById(id);
    });
    return row === undefined ? null : mapRow(row);
  }

  archive(id: string, atMs: number): HarvestResult | null {
    const row = withTransaction(this.db, () => {
      this.db
        .prepare("UPDATE results SET archived_at_ms = ? WHERE id = ? AND archived_at_ms IS NULL")
        .run(atMs, id);
      return this.rowById(id);
    });
    return row === undefined ? null : mapRow(row);
  }

  close(): void {
    this.db.close();
  }

  private rowById(id: string): SqlRow | undefined {
    return this.db.prepare(SELECT_BY_ID).get(id) as SqlRow | undefined;
  }
}

function mapRow(row: SqlRow): HarvestResult {
  return {
    id: row.id as string,
    capturedAtMs: row.captured_at_ms as number,
    workspaceId: row.workspace_id as string | null,
    workspaceName: row.workspace_name as string | null,
    tabId: row.tab_id as string | null,
    paneId: row.pane_id as string,
    paneName: row.pane_name as string | null,
    agentName: row.agent_name as string | null,
    agentKind: row.agent_kind as string | null,
    agentSessionKind: row.agent_session_kind as AgentSessionKind | null,
    agentSessionValue: row.agent_session_value as string | null,
    herdrSessionKey: row.herdr_session_key as string | null,
    herdrSessionLabel: row.herdr_session_label as string | null,
    captureSource: row.capture_source as string,
    captureLineCount: row.capture_line_count as number,
    rawText: row.raw_text as string,
    contentHash: row.content_hash as string,
    dedupKey: row.dedup_key as string,
    readAtMs: row.read_at_ms as number | null,
    archivedAtMs: row.archived_at_ms as number | null,
  };
}
