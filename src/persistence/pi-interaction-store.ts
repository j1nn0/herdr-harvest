import { Buffer } from "node:buffer";
import type { DatabaseSync } from "node:sqlite";

import {
  MAX_PI_FINAL_REPORT_BYTES,
  MAX_PI_INTERACTION_ID_BYTES,
  MAX_PI_PROMPT_BYTES,
  MAX_PI_PROVENANCE_BYTES,
  MAX_PI_REASON_BYTES,
  MAX_PI_SESSION_ID_BYTES,
  type PiInteraction,
  type PiInteractionInput,
  type PiInteractionTerminalStatus,
  piInteractionDedupKey,
} from "../domain/pi-interaction.ts";
import { withTransaction } from "./database.ts";
import { runMigrations } from "./migrations.ts";

export type PiInteractionInsertOutcome =
  | { status: "inserted"; interaction: PiInteraction }
  | { status: "duplicate"; interaction: PiInteraction };

export interface PiInteractionStoreDeps {
  now: () => number;
}

type SqlRow = Record<string, unknown>;

const SELECT_BY_DEDUP_KEY = "SELECT * FROM pi_interactions WHERE dedup_key = ?";
const DEFAULT_DEPS: PiInteractionStoreDeps = { now: () => Date.now() };

/** A malformed or oversized interaction is rejected before SQLite is touched. */
export class PiInteractionValidationError extends RangeError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PiInteractionValidationError";
    this.code = code;
  }
}

/** A deduplicated interaction cannot be overwritten by different content. */
export class PiInteractionConflictError extends Error {
  readonly dedupKey: string;

  constructor(dedupKey: string) {
    super("A Pi interaction dedup key already contains different content.");
    this.name = "PiInteractionConflictError";
    this.dedupKey = dedupKey;
  }
}

/** Persistence boundary for terminal Pi interactions. */
export class PiInteractionStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, deps: PiInteractionStoreDeps = DEFAULT_DEPS) {
    this.db = db;
    this.now = deps.now;
    runMigrations(db);
  }

  /**
   * Inserts one terminal interaction, or reads back the existing identical row.
   * Pending/provisional state is intentionally rejected at this boundary.
   */
  insert(input: PiInteractionInput): PiInteractionInsertOutcome {
    const normalized = normalizeInput(input);

    return withTransaction(this.db, () => this.insertNormalized(normalized));
  }

  /**
   * Inserts one terminal interaction inside a transaction owned by the caller.
   * This deliberately does not begin or commit a transaction.
   */
  insertIntoTransaction(input: PiInteractionInput): PiInteractionInsertOutcome {
    const normalized = normalizeInput(input);
    return this.insertNormalized(normalized);
  }

  private insertNormalized(normalized: NormalizedPiInteraction): PiInteractionInsertOutcome {
    const dedupKey = piInteractionDedupKey(normalized);
    const existing = this.db.prepare(SELECT_BY_DEDUP_KEY).get(dedupKey) as SqlRow | undefined;
    if (existing !== undefined) {
      const interaction = mapRow(existing);
      if (!sameContent(interaction, normalized, dedupKey)) {
        throw new PiInteractionConflictError(dedupKey);
      }
      return { status: "duplicate", interaction };
    }

    const completedAtMs = validateCompletedAtMs(this.now());
    const changes = this.db
      .prepare(`
        INSERT INTO pi_interactions (
          interaction_id,
          session_id,
          submitted_prompt,
          effective_prompt,
          final_report,
          status,
          failure_reason,
          provenance,
          dedup_key,
          completed_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedup_key) DO NOTHING
      `)
      .run(
        normalized.interactionId,
        normalized.sessionId,
        normalized.submittedPrompt,
        normalized.effectivePrompt,
        normalized.finalReport,
        normalized.status,
        normalized.reason,
        normalized.provenance,
        dedupKey,
        completedAtMs,
      );
    const row = this.db.prepare(SELECT_BY_DEDUP_KEY).get(dedupKey) as SqlRow | undefined;
    if (row === undefined) {
      throw new Error("Inserted Pi interaction could not be read back.");
    }

    const interaction = mapRow(row);
    if (!sameContent(interaction, normalized, dedupKey)) {
      throw new PiInteractionConflictError(dedupKey);
    }
    return {
      status: changes.changes > 0 ? "inserted" : "duplicate",
      interaction,
    };
  }

  get(sessionId: string, interactionId: string): PiInteraction | null {
    const row = this.db
      .prepare("SELECT * FROM pi_interactions WHERE session_id = ? AND interaction_id = ?")
      .get(sessionId, interactionId) as SqlRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  getByDedupKey(dedupKey: string): PiInteraction | null {
    const row = this.db.prepare(SELECT_BY_DEDUP_KEY).get(dedupKey) as SqlRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  list(): PiInteraction[] {
    return (this.db.prepare("SELECT * FROM pi_interactions ORDER BY rowid").all() as SqlRow[]).map(
      mapRow,
    );
  }
}

interface NormalizedPiInteraction {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  effectivePrompt: string | null;
  finalReport: string | null;
  status: PiInteractionTerminalStatus;
  reason: string | null;
  provenance: string;
}

function normalizeInput(input: PiInteractionInput): NormalizedPiInteraction {
  if (input === null || typeof input !== "object") {
    throw new PiInteractionValidationError(
      "invalid-input",
      "Pi interaction input must be an object.",
    );
  }

  const interactionId = validateIdentifier(
    input.interactionId,
    "interactionId",
    MAX_PI_INTERACTION_ID_BYTES,
  );
  const sessionId = validateIdentifier(input.sessionId, "sessionId", MAX_PI_SESSION_ID_BYTES);
  const submittedPrompt = validateText(
    input.submittedPrompt,
    "submittedPrompt",
    MAX_PI_PROMPT_BYTES,
  );
  const effectivePrompt =
    input.effectivePrompt === undefined || input.effectivePrompt === null
      ? null
      : validateText(input.effectivePrompt, "effectivePrompt", MAX_PI_PROMPT_BYTES);
  const provenance = validateShortText(input.provenance, "provenance", MAX_PI_PROVENANCE_BYTES);

  if (input.status === "pending") {
    throw new PiInteractionValidationError(
      "pending-not-persisted",
      "Provisional Pi interactions must not be persisted.",
    );
  }
  if (input.status !== "completed" && input.status !== "failed") {
    throw new PiInteractionValidationError("invalid-status", "Pi interaction status is invalid.");
  }

  if (input.status === "completed") {
    if (typeof input.finalReport !== "string") {
      throw new PiInteractionValidationError(
        "completed-report-missing",
        "A completed Pi interaction must have a final report.",
      );
    }
    if (input.finalReport.length === 0) {
      throw new PiInteractionValidationError(
        "empty-final-report",
        "A completed Pi interaction must have a non-empty final report.",
      );
    }
    const finalReport = validateText(input.finalReport, "finalReport", MAX_PI_FINAL_REPORT_BYTES);
    if (input.reason !== undefined && input.reason !== null) {
      throw new PiInteractionValidationError(
        "completed-reason-present",
        "A completed Pi interaction cannot have a failure reason.",
      );
    }
    return {
      interactionId,
      sessionId,
      submittedPrompt,
      effectivePrompt,
      finalReport,
      status: "completed",
      reason: null,
      provenance,
    };
  }

  if (input.finalReport !== null) {
    throw new PiInteractionValidationError(
      "failed-report-present",
      "A failed Pi interaction must have a null final report.",
    );
  }
  const reason = validateShortText(input.reason, "reason", MAX_PI_REASON_BYTES);
  return {
    interactionId,
    sessionId,
    submittedPrompt,
    effectivePrompt,
    finalReport: null,
    status: "failed",
    reason,
    provenance,
  };
}

function validateIdentifier(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PiInteractionValidationError(`invalid-${name}`, `${name} must be non-empty text.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || hasControlCharacter(value)) {
    throw new PiInteractionValidationError(`invalid-${name}`, `${name} is invalid.`);
  }
  return value;
}

function validateText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new PiInteractionValidationError(`invalid-${name}`, `${name} must be text.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new PiInteractionValidationError(`oversized-${name}`, `${name} exceeds its byte limit.`);
  }
  return value;
}

function validateShortText(value: unknown, name: string, maxBytes: number): string {
  const text = validateText(value, name, maxBytes);
  if (text.length === 0) {
    throw new PiInteractionValidationError(`invalid-${name}`, `${name} must be non-empty text.`);
  }
  return text;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      return true;
    }
  }
  return false;
}

function mapRow(row: SqlRow): PiInteraction {
  return {
    interactionId: row.interaction_id as string,
    sessionId: row.session_id as string,
    submittedPrompt: row.submitted_prompt as string,
    effectivePrompt: row.effective_prompt as string | null,
    finalReport: row.final_report as string | null,
    status: row.status as PiInteractionTerminalStatus,
    reason: row.failure_reason as string | null,
    provenance: row.provenance as string,
    completedAtMs: readCompletedAtMs(row.completed_at_ms),
    dedupKey: row.dedup_key as string,
  };
}

function readCompletedAtMs(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return validateCompletedAtMs(value);
}

function validateCompletedAtMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new PiInteractionValidationError(
      "invalid-completedAtMs",
      "completedAtMs must be a finite non-negative integer.",
    );
  }
  return value;
}

function sameContent(
  stored: PiInteraction,
  normalized: NormalizedPiInteraction,
  dedupKey: string,
): boolean {
  return (
    stored.interactionId === normalized.interactionId &&
    stored.sessionId === normalized.sessionId &&
    stored.submittedPrompt === normalized.submittedPrompt &&
    stored.effectivePrompt === normalized.effectivePrompt &&
    stored.finalReport === normalized.finalReport &&
    stored.status === normalized.status &&
    stored.reason === normalized.reason &&
    stored.provenance === normalized.provenance &&
    stored.dedupKey === dedupKey
  );
}
