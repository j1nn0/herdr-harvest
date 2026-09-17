import { Buffer } from "node:buffer";

import {
  MAX_PI_FINAL_REPORT_BYTES,
  MAX_PI_INTERACTION_ID_BYTES,
  MAX_PI_PROMPT_BYTES,
  MAX_PI_PROVENANCE_BYTES,
  MAX_PI_REASON_BYTES,
  MAX_PI_SESSION_ID_BYTES,
  type PiInteractionInput,
} from "../domain/pi-interaction.ts";

export const MAX_PI_INGEST_JSON_BYTES =
  MAX_PI_PROMPT_BYTES +
  MAX_PI_FINAL_REPORT_BYTES +
  MAX_PI_PROVENANCE_BYTES +
  MAX_PI_REASON_BYTES +
  4096;

const ALLOWED_FIELDS = new Set([
  "interactionId",
  "sessionId",
  "submittedPrompt",
  "effectivePrompt",
  "finalReport",
  "status",
  "reason",
  "provenance",
]);

export class PiIngestInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PiIngestInputError";
    this.code = code;
  }
}

/** Parse and validate one terminal JSON record without touching SQLite. */
export function parsePiInteractionInput(json: string): PiInteractionInput {
  if (Buffer.byteLength(json, "utf8") > MAX_PI_INGEST_JSON_BYTES) {
    throw new PiIngestInputError("oversized-json", "stdin JSON exceeds the ingest size limit.");
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new PiIngestInputError("invalid-json", "stdin is not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new PiIngestInputError(
      "invalid-shape",
      "stdin JSON must contain one interaction object.",
    );
  }
  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new PiIngestInputError(
        "unsupported-field",
        "stdin JSON contains an unsupported field.",
      );
    }
  }

  const interactionId = validateIdentifier(
    value.interactionId,
    "interactionId",
    MAX_PI_INTERACTION_ID_BYTES,
  );
  const sessionId = validateIdentifier(value.sessionId, "sessionId", MAX_PI_SESSION_ID_BYTES);
  const submittedPrompt = validateText(
    value.submittedPrompt,
    "submittedPrompt",
    MAX_PI_PROMPT_BYTES,
  );
  const effectivePrompt =
    value.effectivePrompt === undefined || value.effectivePrompt === null
      ? null
      : validateText(value.effectivePrompt, "effectivePrompt", MAX_PI_PROMPT_BYTES);
  const provenance = validateNonEmptyText(value.provenance, "provenance", MAX_PI_PROVENANCE_BYTES);

  if (value.status !== "completed" && value.status !== "failed") {
    throw new PiIngestInputError("invalid-status", "stdin interaction must be terminal.");
  }
  if (value.status === "completed") {
    const finalReport = validateText(value.finalReport, "finalReport", MAX_PI_FINAL_REPORT_BYTES);
    if (finalReport.length === 0) {
      throw new PiIngestInputError(
        "empty-final-report",
        "completed interaction needs a final report.",
      );
    }
    if (value.reason !== undefined && value.reason !== null) {
      throw new PiIngestInputError(
        "completed-reason",
        "completed interaction cannot have a reason.",
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

  if (value.finalReport !== null) {
    throw new PiIngestInputError(
      "failed-report",
      "failed interaction must have a null final report.",
    );
  }
  const reason = validateNonEmptyText(value.reason, "reason", MAX_PI_REASON_BYTES);
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
  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
    throw new PiIngestInputError(`invalid-${name}`, `${name} is invalid.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new PiIngestInputError(`oversized-${name}`, `${name} exceeds its byte limit.`);
  }
  return value;
}

function validateText(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string") {
    throw new PiIngestInputError(`invalid-${name}`, `${name} must be text.`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new PiIngestInputError(`oversized-${name}`, `${name} exceeds its byte limit.`);
  }
  return value;
}

function validateNonEmptyText(value: unknown, name: string, maxBytes: number): string {
  const text = validateText(value, name, maxBytes);
  if (text.length === 0) {
    throw new PiIngestInputError(`invalid-${name}`, `${name} must be non-empty text.`);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
