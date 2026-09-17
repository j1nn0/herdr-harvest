import { Buffer } from "node:buffer";

import { isCodexCollectionEnabled, loadConfig } from "../config/config.ts";
import type { PiInteraction } from "../domain/pi-interaction.ts";
import { openDatabase } from "../persistence/database.ts";
import { PiInteractionStore } from "../persistence/pi-interaction-store.ts";
import {
  type CodexContractEvent,
  type CodexContractFailure,
  normalizeCodexContractEvent,
} from "./collector-contract.ts";
import {
  type CodexCommitOutcome,
  CodexStagingError,
  type CodexStagingOutcome,
  commitCodexTurn,
  stageCodexPrompt,
  stageCodexReport,
} from "./staging.ts";

export const MAX_CODEX_INGEST_JSON_BYTES = 2 * 1024 + 2 * 64 * 1024 + 4096;

const COMMON_FIELDS = new Set(["kind", "sessionId", "turnId"]);
const EVENT_FIELDS = {
  promptObserved: new Set([...COMMON_FIELDS, "submittedPrompt"]),
  reportObserved: new Set([...COMMON_FIELDS, "provisionalReport"]),
  turnCommitted: new Set([...COMMON_FIELDS, "finalReport"]),
} as const;

export class CodexIngestInputError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "CodexIngestInputError";
    this.code = code;
  }
}

export type CodexIngestEvent = Exclude<CodexContractEvent, { kind: "sweep" }>;

export type CodexIngestOutcome =
  | { status: "disabled" }
  | {
      status: "staged";
      action: "inserted" | "updated" | "duplicate";
      sessionId: string;
      turnId: string;
    }
  | { status: "inserted" | "duplicate"; interaction: PiInteraction }
  | { status: "rejected"; failure: CodexContractFailure };

/** Parse one normalized event at the process boundary without touching SQLite. */
export function parseCodexIngestInput(json: string): CodexIngestEvent {
  if (Buffer.byteLength(json, "utf8") > MAX_CODEX_INGEST_JSON_BYTES) {
    throw new CodexIngestInputError("oversized-json");
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new CodexIngestInputError("invalid-json");
  }
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new CodexIngestInputError("invalid-shape");
  }
  if (value.kind === "sweep" || !(value.kind in EVENT_FIELDS)) {
    throw new CodexIngestInputError("unsupported-event");
  }

  const allowed = EVENT_FIELDS[value.kind as keyof typeof EVENT_FIELDS];
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CodexIngestInputError("unsupported-field");
  }

  const normalized = normalizeCodexContractEvent(value);
  if (!normalized.ok) {
    throw new CodexIngestInputError(normalized.failure.reason);
  }
  if (normalized.event.kind === "sweep") {
    throw new CodexIngestInputError("unsupported-event");
  }
  return normalized.event;
}

/** Apply one normalized event through the opt-in, existing-database boundary. */
export function ingestCodexEvent(
  event: CodexIngestEvent,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexIngestOutcome {
  if (!isCodexCollectionEnabled(env)) {
    return { status: "disabled" };
  }

  const databasePath = loadConfig(env).config.databasePath;
  const db = openDatabase(databasePath);
  try {
    const store = new PiInteractionStore(db);
    return applyEvent(db, store, event);
  } finally {
    db.close();
  }
}

function applyEvent(
  db: ReturnType<typeof openDatabase>,
  store: PiInteractionStore,
  event: CodexIngestEvent,
): CodexIngestOutcome {
  switch (event.kind) {
    case "promptObserved":
      return stageOutcome(stageCodexPrompt(db, event));
    case "reportObserved":
      return stageOutcome(stageCodexReport(db, event));
    case "turnCommitted":
      return commitOutcome(commitCodexTurn(db, store, event));
  }
}

function stageOutcome(outcome: CodexStagingOutcome): CodexIngestOutcome {
  if (outcome.status === "rejected") {
    return outcome;
  }
  return {
    status: "staged",
    action: outcome.action,
    sessionId: outcome.sessionId,
    turnId: outcome.turnId,
  };
}

function commitOutcome(outcome: CodexCommitOutcome): CodexIngestOutcome {
  return outcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export { CodexStagingError };
