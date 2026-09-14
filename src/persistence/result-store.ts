import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { contentHash, dedupKey } from "../domain/dedup.ts";
import type { OrchestrationClaim, OrchestrationRole } from "../domain/orchestration.ts";
import {
  isOrchestrationId,
  isOrchestrationLabel,
  isOrchestrationRole,
  MAX_ORCHESTRATION_LABEL_CODE_POINTS,
} from "../domain/orchestration.ts";
import type { AgentSessionKind, CaptureInput, HarvestResult } from "../domain/result.ts";
import { withTransaction } from "./database.ts";
import { runMigrations } from "./migrations.ts";

/** How a requested orchestration claim landed on the stored row. */
export type InsertClaimOutcome =
  | { status: "claimed"; orchestrationId: string }
  | { status: "already_claimed"; orchestrationId: string }
  | { status: "conflict"; requestedOrchestrationId: string; existingOrchestrationId: string };

export type InsertOutcome =
  | { status: "inserted"; result: HarvestResult; claim?: InsertClaimOutcome }
  | { status: "duplicate"; result: HarvestResult; claim?: InsertClaimOutcome };

/** The result of claiming one already-stored row. */
export type ClaimOutcome =
  | { status: "claimed"; result: HarvestResult }
  | { status: "already_claimed"; result: HarvestResult }
  | {
      status: "conflict";
      result: HarvestResult;
      requestedOrchestrationId: string;
      existingOrchestrationId: string;
    }
  | { status: "not_found" };

export interface ResultStore {
  /**
   * Records one capture, and optionally claims the surviving row for an
   * orchestration task in the same transaction. A claim is written only while
   * `orchestration_id IS NULL`, so an automatic capture can never overwrite an
   * explicit claim and a repeated claim is idempotent rather than destructive.
   * `claim` must already be validated (`RangeError` otherwise).
   */
  insert(input: CaptureInput, claim?: OrchestrationClaim): InsertOutcome;
  /** Claims one already-stored row for an orchestration task. */
  claimOrchestration(id: string, claim: OrchestrationClaim): ClaimOutcome;
  observePaneStatus(input: {
    herdrSessionKey: string | null;
    paneId: string;
    agentStatus: string;
    atMs: number;
  }): { previousStatus: string | null };
  list(options?: { includeArchived?: boolean; limit?: number }): HarvestResult[];
  listArchived(options?: { limit?: number }): HarvestResult[];
  get(id: string): HarvestResult | null;
  markRead(id: string, atMs: number): HarvestResult | null;
  archive(id: string, atMs: number): HarvestResult | null;
  restore(id: string): HarvestResult | null;
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
/**
 * First-writer-wins: the guard keeps an existing claim intact, so a competing
 * claim can only ever read the winner back and report an idempotent claim or a
 * conflict.
 */
const CLAIM_ORCHESTRATION =
  "UPDATE results SET orchestration_id = ?, orchestration_label = ?, orchestration_role = ? WHERE id = ? AND orchestration_id IS NULL";

export class SqliteResultStore implements ResultStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    runMigrations(db);
  }

  insert(input: CaptureInput, claim?: OrchestrationClaim): InsertOutcome {
    if (claim !== undefined) {
      assertValidOrchestrationClaim(claim);
    }
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
      let row = this.db.prepare(SELECT_BY_DEDUP_KEY).get(key) as SqlRow | undefined;
      if (row === undefined) {
        throw new Error(`Inserted result ${id} could not be read back.`);
      }

      // The claim belongs to the surviving row, which on a duplicate is the row
      // that already owns this content, not the id generated for this attempt.
      let claimed: InsertClaimOutcome | undefined;
      if (claim !== undefined) {
        const survivingId = row.id;
        if (typeof survivingId !== "string") {
          throw new Error(`Inserted result ${id} could not be read back.`);
        }
        claimed = this.applyClaim(survivingId, claim);
        row = this.db.prepare(SELECT_BY_DEDUP_KEY).get(key) as SqlRow | undefined;
        if (row === undefined) {
          throw new Error(`Claimed result ${survivingId} could not be read back.`);
        }
      }

      return { inserted: changes.changes > 0, row, claimed };
    });

    const result = mapRow(transaction.row);
    if (transaction.inserted) {
      return transaction.claimed === undefined
        ? { status: "inserted", result }
        : { status: "inserted", result, claim: transaction.claimed };
    }
    return transaction.claimed === undefined
      ? { status: "duplicate", result }
      : { status: "duplicate", result, claim: transaction.claimed };
  }

  claimOrchestration(id: string, claim: OrchestrationClaim): ClaimOutcome {
    assertValidOrchestrationClaim(claim);
    return withTransaction(this.db, () => {
      if (this.rowById(id) === undefined) {
        return { status: "not_found" };
      }

      const applied = this.applyClaim(id, claim);
      const row = this.rowById(id);
      if (row === undefined) {
        return { status: "not_found" };
      }
      const result = mapRow(row);

      if (applied.status === "conflict") {
        return {
          status: "conflict",
          result,
          requestedOrchestrationId: applied.requestedOrchestrationId,
          existingOrchestrationId: applied.existingOrchestrationId,
        };
      }
      if (applied.status === "claimed") {
        return { status: "claimed", result };
      }
      return { status: "already_claimed", result };
    });
  }

  /**
   * Applies one NULL-guarded claim and classifies what it found. Callers must
   * hold the write transaction: the read-back that classifies a lost race is
   * only trustworthy while no other writer can slip in between.
   */
  private applyClaim(id: string, claim: OrchestrationClaim): InsertClaimOutcome {
    const changes = this.db.prepare(CLAIM_ORCHESTRATION).run(claim.id, claim.label, claim.role, id);
    if (changes.changes > 0) {
      return { status: "claimed", orchestrationId: claim.id };
    }

    const row = this.rowById(id);
    if (row === undefined) {
      throw new Error(`Result ${id} disappeared before its orchestration claim could be resolved.`);
    }
    const existing = mapRow(row);
    if (
      existing.orchestrationId === null ||
      existing.orchestrationLabel === null ||
      existing.orchestrationRole === null
    ) {
      throw new Error(`Result ${id} has an incomplete orchestration claim.`);
    }

    if (
      existing.orchestrationId === claim.id &&
      existing.orchestrationLabel === claim.label &&
      existing.orchestrationRole === claim.role
    ) {
      return { status: "already_claimed", orchestrationId: existing.orchestrationId };
    }
    return {
      status: "conflict",
      requestedOrchestrationId: claim.id,
      existingOrchestrationId: existing.orchestrationId,
    };
  }

  observePaneStatus(input: {
    herdrSessionKey: string | null;
    paneId: string;
    agentStatus: string;
    atMs: number;
  }): { previousStatus: string | null } {
    const sessionKey = lifecycleSessionKey(input.herdrSessionKey);
    return withTransaction(this.db, () => {
      const row = this.db
        .prepare(
          "SELECT agent_status FROM pane_lifecycle WHERE herdr_session_key = ? AND pane_id = ?",
        )
        .get(sessionKey, input.paneId);
      const previousStatus = typeof row?.agent_status === "string" ? row.agent_status : null;

      this.db
        .prepare(`
          INSERT INTO pane_lifecycle (herdr_session_key, pane_id, agent_status, updated_at_ms)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(herdr_session_key, pane_id) DO UPDATE SET
            agent_status = excluded.agent_status,
            updated_at_ms = excluded.updated_at_ms
        `)
        .run(sessionKey, input.paneId, input.agentStatus, input.atMs);

      return { previousStatus };
    });
  }

  list(options: { includeArchived?: boolean; limit?: number } = {}): HarvestResult[] {
    const limit = options.limit;
    assertValidListLimit(limit);

    const where = options.includeArchived ? "" : "WHERE archived_at_ms IS NULL";
    const order = "ORDER BY (read_at_ms IS NOT NULL) ASC, captured_at_ms DESC, id DESC";
    const sql = `SELECT * FROM results ${where} ${order}`;
    const rows =
      limit === undefined
        ? (this.db.prepare(sql).all() as SqlRow[])
        : (this.db.prepare(`${sql} LIMIT ?`).all(limit) as SqlRow[]);
    return rows.map(mapRow);
  }

  listArchived(options: { limit?: number } = {}): HarvestResult[] {
    const limit = options.limit;
    assertValidListLimit(limit);

    const order = "ORDER BY archived_at_ms DESC, captured_at_ms DESC, id DESC";
    const sql = `SELECT * FROM results WHERE archived_at_ms IS NOT NULL ${order}`;
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

  restore(id: string): HarvestResult | null {
    const row = withTransaction(this.db, () => {
      this.db
        .prepare(
          "UPDATE results SET archived_at_ms = NULL WHERE id = ? AND archived_at_ms IS NOT NULL",
        )
        .run(id);
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
    orchestrationId: row.orchestration_id as string | null,
    orchestrationLabel: row.orchestration_label as string | null,
    orchestrationRole: row.orchestration_role as OrchestrationRole | null,
  };
}

function assertValidOrchestrationClaim(claim: OrchestrationClaim): void {
  if (!isOrchestrationId(claim.id)) {
    throw new RangeError("An orchestration claim id must be a canonical lowercase UUIDv4.");
  }
  if (!isOrchestrationRole(claim.role)) {
    throw new RangeError("An orchestration claim role must be explorer or fixer.");
  }
  if (!isOrchestrationLabel(claim.label)) {
    throw new RangeError(
      `An orchestration claim label must be 1-${MAX_ORCHESTRATION_LABEL_CODE_POINTS} non-blank code points.`,
    );
  }
}

function assertValidListLimit(limit: number | undefined): void {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new RangeError("Result list limit must be a non-negative integer.");
  }
}

function lifecycleSessionKey(herdrSessionKey: string | null): string {
  return herdrSessionKey ?? "";
}
