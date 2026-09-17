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

interface StagingRow {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  provisionalReport: string | null;
  status: string;
  provenance: string;
  dedupKey: string;
}

interface PreparedCommit {
  input: PiInteractionInput;
  sessionId: string;
  turnId: string;
}

type CommitPreparation =
  | { kind: "rejected"; failure: CodexContractFailure }
  | { kind: "persist"; value: PreparedCommit };

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
  const preparation = withTransaction<CommitPreparation>(db, () => {
    const row = readRow(db, dedupKey);
    if (row === undefined) {
      return {
        kind: "rejected",
        failure: failure("orphan-notify", event),
      };
    }
    if (!isCodexRow(row, event.sessionId, interactionId)) {
      return {
        kind: "rejected",
        failure: failure("staging-identity-conflict", event),
      };
    }

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
          kind: "rejected",
          failure: failure(completion.failure.reason, event),
        };
      }

      const deleted = db
        .prepare("DELETE FROM pi_interactions WHERE dedup_key = ? AND status = 'pending'")
        .run(dedupKey);
      if (deleted.changes !== 1) {
        return {
          kind: "rejected",
          failure: failure("orphan-notify", event),
        };
      }
      return {
        kind: "persist",
        value: {
          input: toPiInput(completion.interaction),
          sessionId: event.sessionId,
          turnId: event.turnId,
        },
      };
    }

    return {
      kind: "persist",
      value: {
        input: {
          interactionId: row.interactionId,
          sessionId: row.sessionId,
          submittedPrompt: row.submittedPrompt,
          effectivePrompt: null,
          finalReport: event.finalReport,
          status: "completed",
          reason: null,
          provenance: CODEX_NATIVE_HOOKS_PROVENANCE,
        },
        sessionId: event.sessionId,
        turnId: event.turnId,
      },
    };
  });

  if (preparation.kind === "rejected") {
    return { status: "rejected", failure: preparation.failure };
  }

  try {
    return store.insert(preparation.value.input);
  } catch (error) {
    if (error instanceof PiInteractionConflictError) {
      return {
        status: "rejected",
        failure: failureWithIds(
          "conflicting-commit",
          preparation.value.sessionId,
          preparation.value.turnId,
        ),
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
