import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

export type HookEventName = "UserPromptSubmit" | "Stop";
export type HookEventKind = "prompt" | "stop";

export interface HookEvent {
  id: string;
  kind: HookEventKind;
  sessionId: string;
  turnId: string;
  text: string;
  textSha256: string;
  textByteLength: number;
  source?: string;
}

export interface Interaction {
  id: string;
  sessionId: string;
  turnId: string;
  submittedPrompt: string;
  finalReport: string;
  status: "completed";
  provenance: "codex-native-hooks";
}

export interface NormalizationResult {
  event: HookEvent | null;
  reason: string | null;
}

export type CorrelationResult =
  | {
      key: string;
      status: "accepted";
      interaction: Interaction;
    }
  | {
      key: string;
      status: "incomplete";
      reason: "awaiting-pair";
    }
  | {
      key: string;
      status: "rejected";
      reason:
        | "ambiguous-event-count"
        | "source-mismatch"
        | "invalid-event-set";
    };

const MAX_ID_BYTES = 1_024;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const hasOwn = Object.prototype.hasOwnProperty;
const SOURCE_FIELDS = [
  "source",
  "thread_source",
  "session_source",
  "threadSource",
  "sessionSource",
] as const;

/**
 * Normalize exactly the event-specific fields emitted by Codex 0.154.0.
 * Unknown fields are ignored, but fields that would make root-vs-subagent
 * identity ambiguous reject the event.
 */
export function normalizeHookPayload(
  payload: unknown,
  expectedEventName: HookEventName,
): NormalizationResult {
  if (!isRecord(payload)) {
    return rejected("payload-not-object");
  }

  const hookEventName = payload.hook_event_name;
  if (hookEventName === "SubagentStop") {
    return rejected("subagent-stop");
  }
  if (hookEventName !== expectedEventName) {
    return rejected("unrelated-event");
  }

  const sourceResult = readSource(payload);
  if (sourceResult.reason !== null) {
    return rejected(sourceResult.reason);
  }

  const sessionId = readBoundedString(payload.session_id, MAX_ID_BYTES);
  const turnId = readBoundedString(payload.turn_id, MAX_ID_BYTES);
  if (sessionId === null || turnId === null) {
    return rejected("missing-correlation-id");
  }

  if (hasOwn.call(payload, "agent_id") || hasOwn.call(payload, "agent_type")) {
    return rejected("agent-fields-present");
  }

  if (expectedEventName === "UserPromptSubmit") {
    const prompt = payload.prompt;
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return rejected("missing-prompt");
    }
    if (Buffer.byteLength(prompt, "utf8") > MAX_TEXT_BYTES) {
      return rejected("prompt-too-large");
    }
    return acceptedEvent("prompt", sessionId, turnId, prompt, sourceResult.source);
  }

  if (payload.interrupted === true || payload.cancelled === true || payload.failed === true) {
    return rejected("interrupted-or-failed");
  }
  if (!hasOwn.call(payload, "last_assistant_message")) {
    return rejected("missing-final-report");
  }
  const finalReport = payload.last_assistant_message;
  if (typeof finalReport !== "string") {
    return rejected("missing-final-report");
  }
  if (Buffer.byteLength(finalReport, "utf8") > MAX_TEXT_BYTES) {
    return rejected("final-report-too-large");
  }
  return acceptedEvent("stop", sessionId, turnId, finalReport, sourceResult.source);
}

/** Correlate every session/turn independently, preserving exact text values. */
export function correlateEvents(events: readonly HookEvent[]): CorrelationResult[] {
  const groups = new Map<string, HookEvent[]>();
  for (const event of deduplicateEvents(events)) {
    const key = turnKey(event.sessionId, event.turnId);
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [event]);
    } else {
      group.push(event);
    }
  }

  return [...groups.entries()].map(([key, group]) => {
    const prompts = group.filter((event) => event.kind === "prompt");
    const stops = group.filter((event) => event.kind === "stop");
    if (prompts.length === 0 || stops.length === 0) {
      return { key, status: "incomplete", reason: "awaiting-pair" };
    }
    if (prompts.length !== 1 || stops.length !== 1) {
      return { key, status: "rejected", reason: "ambiguous-event-count" };
    }

    const prompt = prompts[0];
    const stop = stops[0];
    if (prompt === undefined || stop === undefined) {
      return { key, status: "rejected", reason: "invalid-event-set" };
    }
    if (prompt.source !== stop.source) {
      return { key, status: "rejected", reason: "source-mismatch" };
    }

    return {
      key,
      status: "accepted",
      interaction: {
        id: interactionId(prompt.sessionId, prompt.turnId),
        sessionId: prompt.sessionId,
        turnId: prompt.turnId,
        submittedPrompt: prompt.text,
        finalReport: stop.text,
        status: "completed",
        provenance: "codex-native-hooks",
      },
    };
  });
}

export function turnKey(sessionId: string, turnId: string): string {
  return JSON.stringify([sessionId, turnId]);
}

export function interactionId(sessionId: string, turnId: string): string {
  return sha256(JSON.stringify(["codex-native-hooks", sessionId, turnId]));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sameInteraction(left: Interaction, right: Interaction): boolean {
  return (
    left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.submittedPrompt === right.submittedPrompt &&
    left.finalReport === right.finalReport &&
    left.status === right.status &&
    left.provenance === right.provenance
  );
}

function acceptedEvent(
  kind: HookEventKind,
  sessionId: string,
  turnId: string,
  text: string,
  source: string | undefined,
): NormalizationResult {
  const textSha256 = sha256(text);
  const eventData = [kind, sessionId, turnId, source ?? null, textSha256, Buffer.byteLength(text, "utf8")];
  const event: HookEvent = {
    id: sha256(JSON.stringify(eventData)),
    kind,
    sessionId,
    turnId,
    text,
    textSha256,
    textByteLength: Buffer.byteLength(text, "utf8"),
    ...(source === undefined ? {} : { source }),
  };
  return { event, reason: null };
}

function deduplicateEvents(events: readonly HookEvent[]): HookEvent[] {
  const byId = new Map<string, HookEvent>();
  for (const event of events) {
    if (!byId.has(event.id)) {
      byId.set(event.id, event);
    }
  }
  return [...byId.values()];
}

function readSource(payload: Record<string, unknown>): {
  source: string | undefined;
  reason: string | null;
} {
  let source: string | undefined;
  for (const field of SOURCE_FIELDS) {
    if (!hasOwn.call(payload, field)) {
      continue;
    }
    const value = payload[field];
    if (typeof value !== "string" || value.length === 0) {
      return { source: undefined, reason: "invalid-source" };
    }
    if (source !== undefined && source !== value) {
      return { source: undefined, reason: "conflicting-source" };
    }
    source = value;
  }

  if (source !== undefined && !isUserSource(source)) {
    return { source, reason: "non-user-source" };
  }
  return { source, reason: null };
}

function isUserSource(source: string): boolean {
  return source === "User" || source === "user" || source === "root";
}

function readBoundedString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return Buffer.byteLength(value, "utf8") <= maxBytes ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejected(reason: string): NormalizationResult {
  return { event: null, reason };
}
