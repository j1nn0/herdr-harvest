import type { DatabaseSync } from "node:sqlite";
import type { PiInteraction, PiInteractionInput } from "../domain/pi-interaction.ts";
import { piInteractionDedupKey } from "../domain/pi-interaction.ts";
import { withTransaction } from "../persistence/database.ts";
import {
  PiInteractionConflictError,
  type PiInteractionStore,
  PiInteractionValidationError,
} from "../persistence/pi-interaction-store.ts";
import type {
  CodexContractFailure,
  CodexPromptObservedEvent,
  CodexReportObservedEvent,
  CodexTurnCommittedEvent,
} from "./collector-contract.ts";
import {
  CODEX_NATIVE_HOOKS_PROVENANCE,
  codexInteractionId,
  completeCodexPending,
} from "./collector-contract.ts";

/** Empty submitted_prompt is reserved as the report-before-prompt sentinel. */
const MISSING_PROMPT_SENTINEL = "";

/**
 * Codex uses the existing Pi table's pending state as a private staging row.
 * There is intentionally no timestamp sweep here: this schema has no safe
 * timestamp column, so stale rows remain for a later explicit prune command.
 */

export type CodexStagingOutcome =
  | {
      status: "accepted";
      action: "inserted" | "updated" | "duplicate";
      sessionId: string;
      turnId: string;
    }
  | {
      status: "rejected";
      failure: CodexContractFailure;
    };

export type CodexCommitOutcome =
  | {
      status: "inserted" | "duplicate";
      interaction: PiInteraction;
    }
  | {
      status: "rejected";
      failure: CodexContractFailure;
    };

export class CodexStagingError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexStagingError";
    this.code = code;
  }
}

export interface CodexPendingTurn {
  sessionId: string;
  interactionId: string;
  dedupKey: string;
}

const CODEX_PENDING_GUARD = `status = 'pending'
   AND provenance = ?
   AND session_id <> ''
   AND interaction_id <> ''
   AND dedup_key <> ''`;

/** Lists only unambiguous Codex pending rows without reading captured text. */
export function listCodexPending(db: DatabaseSync, sessionId?: string): CodexPendingTurn[] {
  const sessionClause = sessionId === undefined ? "" : " AND session_id = ?";
  const parameters =
    sessionId === undefined
      ? [CODEX_NATIVE_HOOKS_PROVENANCE]
      : [CODEX_NATIVE_HOOKS_PROVENANCE, sessionId];
  const rows = db
    .prepare(
      `SELECT session_id, interaction_id, dedup_key
         FROM pi_interactions
        WHERE ${CODEX_PENDING_GUARD}${sessionClause}
        ORDER BY rowid`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    sessionId: row.session_id as string,
    interactionId: row.interaction_id as string,
    dedupKey: row.dedup_key as string,
  }));
}

/** Deletes only the supplied, unambiguous Codex pending keys in one transaction. */
export function deleteCodexPending(
  db: DatabaseSync,
  dedupKeys: readonly string[],
  sessionId?: string,
): { deleted: string[] } {
  const uniqueKeys = [...new Set(dedupKeys.filter((key) => key.length > 0))];
  if (uniqueKeys.length === 0) {
    return { deleted: [] };
  }

  return withTransaction(db, () => {
    const sessionClause = sessionId === undefined ? "" : " AND session_id = ?";
    const selectionParameters: string[] =
      sessionId === undefined
        ? [CODEX_NATIVE_HOOKS_PROVENANCE]
        : [CODEX_NATIVE_HOOKS_PROVENANCE, sessionId];
    const candidates = db
      .prepare(
        `SELECT dedup_key
           FROM pi_interactions
          WHERE ${CODEX_PENDING_GUARD}${sessionClause}
          ORDER BY rowid`,
      )
      .all(...selectionParameters) as Array<Record<string, unknown>>;
    const requestedKeys = new Set(uniqueKeys);
    const candidateKeys = candidates
      .map((row) => row.dedup_key as string)
      .filter((key) => requestedKeys.has(key));
    if (candidateKeys.length === 0) {
      return { deleted: [] };
    }

    const deleted: string[] = [];
    for (let offset = 0; offset < candidateKeys.length; offset += 500) {
      const chunk = candidateKeys.slice(offset, offset + 500);
      const chunkPlaceholders = chunk.map(() => "?").join(", ");
      const deleteParameters =
        sessionId === undefined
          ? [CODEX_NATIVE_HOOKS_PROVENANCE, ...chunk]
          : [CODEX_NATIVE_HOOKS_PROVENANCE, sessionId, ...chunk];
      const result = db
        .prepare(
          `DELETE FROM pi_interactions
             WHERE ${CODEX_PENDING_GUARD}${sessionClause}
               AND dedup_key IN (${chunkPlaceholders})`,
        )
        .run(...deleteParameters);
      if (result.changes === chunk.length) {
        deleted.push(...chunk);
        continue;
      }

      // Keep the return value truthful if a database trigger or other local
      // constraint causes only part of a guarded delete to apply.
      for (const key of chunk) {
        const remaining = db
          .prepare(
            `SELECT 1
               FROM pi_interactions
              WHERE ${CODEX_PENDING_GUARD}${sessionClause}
                AND dedup_key = ?`,
          )
          .get(
            ...(sessionId === undefined
              ? [CODEX_NATIVE_HOOKS_PROVENANCE, key]
              : [CODEX_NATIVE_HOOKS_PROVENANCE, sessionId, key]),
          );
        if (remaining === undefined) {
          deleted.push(key);
        }
      }
    }
    return { deleted };
  });
}

interface StagingRow {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  provisionalReport: string | null;
  status: string;
  provenance: string;
  dedupKey: string;
}

export function stageCodexPrompt(
  db: DatabaseSync,
  event: CodexPromptObservedEvent,
): CodexStagingOutcome {
  const interactionId = codexInteractionId(event.sessionId, event.turnId);
  const dedupKey = piInteractionDedupKey({ interactionId, sessionId: event.sessionId });

  return withTransaction(db, () => {
    const row = readRow(db, dedupKey);
    if (row === undefined) {
      insertPending(db, {
        interactionId,
        sessionId: event.sessionId,
        submittedPrompt: event.submittedPrompt,
        provisionalReport: null,
        dedupKey,
      });
      return accepted("inserted", event);
    }
    if (!isCodexRow(row, event.sessionId, interactionId)) {
      return rejected("staging-identity-conflict", event);
    }
    if (row.status === "pending") {
      if (row.submittedPrompt === MISSING_PROMPT_SENTINEL) {
        db.prepare(
          "UPDATE pi_interactions SET submitted_prompt = ? WHERE dedup_key = ? AND status = 'pending'",
        ).run(event.submittedPrompt, dedupKey);
        return accepted("updated", event);
      }
      if (row.submittedPrompt === event.submittedPrompt) {
        return accepted("duplicate", event);
      }
      return rejected("conflicting-prompt", event);
    }
    if (row.submittedPrompt === event.submittedPrompt) {
      return accepted("duplicate", event);
    }
    return rejected("conflicting-prompt", event);
  });
}

export function stageCodexReport(
  db: DatabaseSync,
  event: CodexReportObservedEvent,
): CodexStagingOutcome {
  const interactionId = codexInteractionId(event.sessionId, event.turnId);
  const dedupKey = piInteractionDedupKey({ interactionId, sessionId: event.sessionId });

  return withTransaction(db, () => {
    const row = readRow(db, dedupKey);
    if (row === undefined) {
      insertPending(db, {
        interactionId,
        sessionId: event.sessionId,
        submittedPrompt: MISSING_PROMPT_SENTINEL,
        provisionalReport: event.provisionalReport,
        dedupKey,
      });
      return accepted("inserted", event);
    }
    if (!isCodexRow(row, event.sessionId, interactionId)) {
      return rejected("staging-identity-conflict", event);
    }
    if (row.status !== "pending") {
      return accepted("duplicate", event);
    }
    const action = row.provisionalReport === event.provisionalReport ? "duplicate" : "updated";
    db.prepare(
      "UPDATE pi_interactions SET effective_prompt = ? WHERE dedup_key = ? AND status = 'pending'",
    ).run(event.provisionalReport, dedupKey);
    return accepted(action, event);
  });
}

export function commitCodexTurn(
  db: DatabaseSync,
  store: PiInteractionStore,
  event: CodexTurnCommittedEvent,
): CodexCommitOutcome {
  const interactionId = codexInteractionId(event.sessionId, event.turnId);
  const dedupKey = piInteractionDedupKey({ interactionId, sessionId: event.sessionId });
  try {
    return withTransaction<CodexCommitOutcome>(db, () => {
      const row = readRow(db, dedupKey);
      if (row === undefined) {
        return {
          status: "rejected",
          failure: failure("orphan-notify", event),
        };
      }
      if (!isCodexRow(row, event.sessionId, interactionId)) {
        return {
          status: "rejected",
          failure: failure("staging-identity-conflict", event),
        };
      }

      let input: PiInteractionInput;
      if (row.status === "pending") {
        const completion = completeCodexPending(
          {
            sessionId: row.sessionId,
            turnId: event.turnId,
            submittedPrompt:
              row.submittedPrompt === MISSING_PROMPT_SENTINEL ? null : row.submittedPrompt,
            provisionalReport: row.provisionalReport,
          },
          event.finalReport,
        );
        if (!completion.ok) {
          return {
            status: "rejected",
            failure: failure(completion.failure.reason, event),
          };
        }

        const deleted = db
          .prepare("DELETE FROM pi_interactions WHERE dedup_key = ? AND status = 'pending'")
          .run(dedupKey);
        if (deleted.changes !== 1) {
          return {
            status: "rejected",
            failure: failure("orphan-notify", event),
          };
        }
        input = toPiInput(completion.interaction);
      } else {
        input = {
          interactionId: row.interactionId,
          sessionId: row.sessionId,
          submittedPrompt: row.submittedPrompt,
          effectivePrompt: null,
          finalReport: event.finalReport,
          status: "completed",
          reason: null,
          provenance: CODEX_NATIVE_HOOKS_PROVENANCE,
        };
      }

      return store.insertIntoTransaction(input);
    });
  } catch (error) {
    if (error instanceof PiInteractionConflictError) {
      return {
        status: "rejected",
        failure: failure("conflicting-commit", event),
      };
    }
    if (error instanceof PiInteractionValidationError) {
      throw new CodexStagingError(error.code);
    }
    throw new CodexStagingError("store-write-failed");
  }
}

function readRow(db: DatabaseSync, dedupKey: string): StagingRow | undefined {
  const row = db
    .prepare(
      `SELECT interaction_id, session_id, submitted_prompt, status,
              effective_prompt AS provisional_report, provenance, dedup_key
         FROM pi_interactions
        WHERE dedup_key = ?`,
    )
    .get(dedupKey) as Record<string, unknown> | undefined;
  if (row === undefined) {
    return undefined;
  }
  return {
    interactionId: row.interaction_id as string,
    sessionId: row.session_id as string,
    submittedPrompt: row.submitted_prompt as string,
    provisionalReport: row.provisional_report as string | null,
    status: row.status as string,
    provenance: row.provenance as string,
    dedupKey: row.dedup_key as string,
  };
}

function insertPending(
  db: DatabaseSync,
  value: {
    interactionId: string;
    sessionId: string;
    submittedPrompt: string;
    provisionalReport: string | null;
    dedupKey: string;
  },
): void {
  db.prepare(
    `INSERT INTO pi_interactions (
       interaction_id, session_id, submitted_prompt, effective_prompt,
       final_report, status, failure_reason, provenance, dedup_key
     ) VALUES (?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)`,
  ).run(
    value.interactionId,
    value.sessionId,
    value.submittedPrompt,
    value.provisionalReport,
    CODEX_NATIVE_HOOKS_PROVENANCE,
    value.dedupKey,
  );
}

function isCodexRow(row: StagingRow, sessionId: string, interactionId: string): boolean {
  return (
    row.sessionId === sessionId &&
    row.interactionId === interactionId &&
    row.provenance === CODEX_NATIVE_HOOKS_PROVENANCE
  );
}

function accepted(
  action: "inserted" | "updated" | "duplicate",
  event: CodexPromptObservedEvent | CodexReportObservedEvent,
): CodexStagingOutcome {
  return { status: "accepted", action, sessionId: event.sessionId, turnId: event.turnId };
}

function rejected(
  reason: string,
  event: CodexPromptObservedEvent | CodexReportObservedEvent,
): CodexStagingOutcome {
  return { status: "rejected", failure: failure(reason, event) };
}

function failure(
  reason: string,
  event: Pick<
    CodexPromptObservedEvent | CodexReportObservedEvent | CodexTurnCommittedEvent,
    "sessionId" | "turnId"
  >,
): CodexContractFailure {
  return failureWithIds(reason, event.sessionId, event.turnId);
}

function failureWithIds(reason: string, sessionId: string, turnId: string): CodexContractFailure {
  return { reason, sessionId, turnId };
}

function toPiInput(interaction: {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  finalReport: string;
  provenance: string;
}): PiInteractionInput {
  return {
    interactionId: interaction.interactionId,
    sessionId: interaction.sessionId,
    submittedPrompt: interaction.submittedPrompt,
    effectivePrompt: null,
    finalReport: interaction.finalReport,
    status: "completed",
    reason: null,
    provenance: interaction.provenance,
  };
}
