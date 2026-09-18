import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

/** The lifecycle states represented by the Pi persistence schema. */
export type PiInteractionStatus = "pending" | "completed" | "failed";

/** Terminal states accepted by the production persistence boundary. */
export type PiInteractionTerminalStatus = Exclude<PiInteractionStatus, "pending">;

/** Byte bounds applied before any Pi text reaches SQLite. */
export const MAX_PI_INTERACTION_ID_BYTES = 128;
export const MAX_PI_SESSION_ID_BYTES = 128;
export const MAX_PI_PROMPT_BYTES = 64 * 1024;
export const MAX_PI_FINAL_REPORT_BYTES = 64 * 1024;
export const MAX_PI_REASON_BYTES = 256;
/** @deprecated Use MAX_PI_REASON_BYTES. */
export const MAX_PI_FAILURE_REASON_BYTES = MAX_PI_REASON_BYTES;
export const MAX_PI_PROVENANCE_BYTES = 128;

/** Input handed to the persistence layer by a terminal observer. */
export interface PiInteractionInput {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  effectivePrompt?: string | null;
  finalReport: string | null;
  status: PiInteractionStatus;
  reason?: string | null;
  provenance: string;
}

/** A normalized terminal Pi interaction stored in Harvest. */
export interface PiInteraction {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  effectivePrompt: string | null;
  finalReport: string | null;
  status: PiInteractionTerminalStatus;
  reason: string | null;
  provenance: string;
  completedAtMs: number | null;
  dedupKey: string;
}

/**
 * Builds an identity key for one observer interaction. The observer id is
 * scoped by the opaque session id; prompt and report text are deliberately
 * excluded so a changed duplicate is detected as a conflict on read-back.
 */
export function piInteractionDedupKey(
  input: Pick<PiInteractionInput, "interactionId" | "sessionId">,
): string {
  const components = ["v1", "pi-interaction", input.sessionId, input.interactionId];
  const framed = components
    .map((component) => `${Buffer.byteLength(component, "utf8")}:${component}`)
    .join("");
  return createHash("sha256").update(framed, "utf8").digest("hex");
}
