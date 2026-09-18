import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { MAX_PI_FINAL_REPORT_BYTES, MAX_PI_PROMPT_BYTES } from "../domain/pi-interaction.ts";

export const MAX_CODEX_ID_BYTES = 1024;
export const MAX_CODEX_SESSION_ID_BYTES = MAX_CODEX_ID_BYTES;
export const MAX_CODEX_TURN_ID_BYTES = MAX_CODEX_ID_BYTES;
export const MAX_CODEX_PROMPT_BYTES = MAX_PI_PROMPT_BYTES;
export const MAX_CODEX_FINAL_REPORT_BYTES = MAX_PI_FINAL_REPORT_BYTES;
export const CODEX_NATIVE_HOOKS_PROVENANCE = "codex-native-hooks";

const INTERNAL_STATE = Symbol("codex-collector-contract-state");

export interface CodexPromptObservedEvent {
  kind: "promptObserved";
  sessionId: string;
  turnId: string;
  submittedPrompt: string;
}

export interface CodexReportObservedEvent {
  kind: "reportObserved";
  sessionId: string;
  turnId: string;
  provisionalReport: string;
}

export interface CodexTurnCommittedEvent {
  kind: "turnCommitted";
  sessionId: string;
  turnId: string;
  finalReport: string;
}

export interface CodexSweepEvent {
  kind: "sweep";
  nowMs: number;
  maxAgeMs: number;
}

export type CodexContractEvent =
  | CodexPromptObservedEvent
  | CodexReportObservedEvent
  | CodexTurnCommittedEvent
  | CodexSweepEvent;

export interface CodexCompletedInteraction {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  finalReport: string;
  status: "completed";
  provenance: typeof CODEX_NATIVE_HOOKS_PROVENANCE;
}

export interface CodexPendingInteraction {
  key: string;
  sessionId: string;
  turnId: string;
  submittedPrompt: string | null;
  provisionalReport: string | null;
}

export interface CodexContractFailure {
  reason: string;
  sessionId?: string;
  turnId?: string;
}

export interface CodexContractState {
  pending: CodexPendingInteraction[];
  completed: CodexCompletedInteraction[];
  failures: CodexContractFailure[];
  [INTERNAL_STATE]?: unknown;
}

export interface CodexContractApplyResult {
  state: CodexContractState;
  emitted: CodexCompletedInteraction[];
  discardedKeys: string[];
  failure: CodexContractFailure | null;
}

export type CodexNormalizationResult<T> =
  | { ok: true; event: T }
  | { ok: false; failure: CodexContractFailure };

interface PendingRecord {
  key: string;
  sessionId: string;
  turnId: string;
  submittedPrompt: string | null;
  provisionalReport: string | null;
  observedAtMs: number;
}

interface InternalState {
  pending: Map<string, PendingRecord>;
  completed: Map<string, CodexCompletedInteraction>;
  failures: Map<string, CodexContractFailure>;
  clockMs: number;
}

interface RecordValue {
  [key: string]: unknown;
}

type IdentifierName = "session" | "turn";

interface IdentifierResult {
  ok: true;
  value: string;
}

interface InvalidIdentifierResult {
  ok: false;
  reason: string;
}

type ValidatedIdentifier = IdentifierResult | InvalidIdentifierResult;

/** Builds a collision-safe identity key for one Codex turn. */
export function codexInteractionKey(sessionId: string, turnId: string): string {
  return [sessionId, turnId]
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
    .join("");
}

/** Builds the stable identity persisted for one completed Codex turn. */
export function codexInteractionId(sessionId: string, turnId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([CODEX_NATIVE_HOOKS_PROVENANCE, sessionId, turnId]), "utf8")
    .digest("hex");
}

/** Creates an empty deferred Codex observer contract. */
export function createCodexContractState(): CodexContractState {
  return makeState({
    pending: new Map(),
    completed: new Map(),
    failures: new Map(),
    clockMs: 0,
  });
}

/**
 * Normalizes a native UserPromptSubmit hook payload. The original prompt is
 * retained exactly; trim is used only to reject an empty prompt.
 */
export function normalizeSubmitPayload(
  value: unknown,
): CodexNormalizationResult<CodexPromptObservedEvent> {
  const record = asRecord(value);
  if (record === undefined) {
    return rejected("malformed-submit");
  }

  const sessionId = safeIdentifier(record.session_id);
  const turnId = safeIdentifier(record.turn_id);
  if (record.hook_event_name === "SubagentStop") {
    return rejected("subagent-event", sessionId, turnId);
  }
  if (record.hook_event_name !== "UserPromptSubmit") {
    return rejected("wrong-hook-event", sessionId, turnId);
  }
  if (hasOwn(record, "agent_id") || hasOwn(record, "agent_type")) {
    return rejected("agent-event", sessionId, turnId);
  }

  const pair = normalizePayloadIds(record, "session_id", "turn_id");
  if (!pair.ok) {
    return pair;
  }

  const prompt = record.prompt;
  if (typeof prompt !== "string") {
    return rejected("missing-prompt", pair.sessionId, pair.turnId);
  }
  if (Buffer.byteLength(prompt, "utf8") > MAX_CODEX_PROMPT_BYTES) {
    return rejected("oversized-prompt", pair.sessionId, pair.turnId);
  }
  if (prompt.trim().length === 0) {
    return rejected("empty-prompt", pair.sessionId, pair.turnId);
  }

  return {
    ok: true,
    event: {
      kind: "promptObserved",
      sessionId: pair.sessionId,
      turnId: pair.turnId,
      submittedPrompt: prompt,
    },
  };
}

/** Normalizes a native Stop hook payload into a provisional report event. */
export function normalizeStopPayload(
  value: unknown,
): CodexNormalizationResult<CodexReportObservedEvent> {
  const record = asRecord(value);
  if (record === undefined) {
    return rejected("malformed-stop");
  }

  const sessionId = safeIdentifier(record.session_id);
  const turnId = safeIdentifier(record.turn_id);
  if (record.hook_event_name === "SubagentStop") {
    return rejected("subagent-event", sessionId, turnId);
  }
  if (record.hook_event_name !== "Stop") {
    return rejected("wrong-hook-event", sessionId, turnId);
  }
  if (hasOwn(record, "agent_id") || hasOwn(record, "agent_type")) {
    return rejected("agent-event", sessionId, turnId);
  }

  const pair = normalizePayloadIds(record, "session_id", "turn_id");
  if (!pair.ok) {
    return pair;
  }

  for (const flag of ["interrupted", "cancelled", "failed"]) {
    if (record[flag] === true) {
      return rejected(flag, pair.sessionId, pair.turnId);
    }
  }

  const report = record.last_assistant_message;
  if (typeof report !== "string") {
    return rejected("missing-report", pair.sessionId, pair.turnId);
  }
  if (Buffer.byteLength(report, "utf8") > MAX_CODEX_FINAL_REPORT_BYTES) {
    return rejected("oversized-report", pair.sessionId, pair.turnId);
  }

  return {
    ok: true,
    event: {
      kind: "reportObserved",
      sessionId: pair.sessionId,
      turnId: pair.turnId,
      provisionalReport: report,
    },
  };
}

/**
 * Normalizes the legacy agent-turn-complete notify payload. A notify payload
 * may identify its session through thread-id, an already-adapted session id,
 * or the optional sessionId argument supplied by the adapter.
 */
export function normalizeNotifyPayload(
  value: unknown,
  sessionIdOverride?: unknown,
): CodexNormalizationResult<CodexTurnCommittedEvent> {
  const record = asRecord(value);
  if (record === undefined) {
    return rejected("malformed-notify");
  }
  if (record.type !== "agent-turn-complete") {
    return rejected("wrong-notify-type");
  }

  const rawSessionId =
    sessionIdOverride ??
    record.sessionId ??
    record.session_id ??
    record["session-id"] ??
    record["thread-id"];
  const sessionIdResult = validateIdentifier(rawSessionId, "session");
  const turnIdResult = validateIdentifier(record["turn-id"], "turn");
  const safeSessionId = safeIdentifier(rawSessionId);
  const safeTurnId = safeIdentifier(record["turn-id"]);
  if (!sessionIdResult.ok) {
    return rejected(sessionIdResult.reason, safeSessionId, safeTurnId);
  }
  if (!turnIdResult.ok) {
    return rejected(turnIdResult.reason, sessionIdResult.value, safeTurnId);
  }

  const report = record["last-assistant-message"];
  if (typeof report !== "string") {
    return rejected("missing-report", sessionIdResult.value, turnIdResult.value);
  }
  if (Buffer.byteLength(report, "utf8") > MAX_CODEX_FINAL_REPORT_BYTES) {
    return rejected("oversized-report", sessionIdResult.value, turnIdResult.value);
  }

  return {
    ok: true,
    event: {
      kind: "turnCommitted",
      sessionId: sessionIdResult.value,
      turnId: turnIdResult.value,
      finalReport: report,
    },
  };
}

/** Exposes normalized-event validation to the cross-process ingest boundary. */
export function normalizeCodexContractEvent(
  value: unknown,
): CodexNormalizationResult<CodexContractEvent> {
  return normalizeContractEvent(value);
}

/** Applies the notify finality rule to one persisted pending record. */
export function completeCodexPending(
  pending: Pick<
    CodexPendingInteraction,
    "sessionId" | "turnId" | "submittedPrompt" | "provisionalReport"
  > | null,
  finalReport: string,
):
  | { ok: true; interaction: CodexCompletedInteraction }
  | { ok: false; failure: CodexContractFailure } {
  if (pending === null) {
    return { ok: false, failure: makeFailure("orphan-notify") };
  }
  if (pending.submittedPrompt === null) {
    return {
      ok: false,
      failure: makeFailure("missing-prompt", pending.sessionId, pending.turnId),
    };
  }
  if (pending.provisionalReport === null) {
    return {
      ok: false,
      failure: makeFailure("missing-provisional", pending.sessionId, pending.turnId),
    };
  }
  if (pending.provisionalReport !== finalReport) {
    return {
      ok: false,
      failure: makeFailure("report-mismatch", pending.sessionId, pending.turnId),
    };
  }

  return {
    ok: true,
    interaction: {
      interactionId: codexInteractionId(pending.sessionId, pending.turnId),
      sessionId: pending.sessionId,
      submittedPrompt: pending.submittedPrompt,
      finalReport,
      status: "completed",
      provenance: CODEX_NATIVE_HOOKS_PROVENANCE,
    },
  };
}

/** Applies one normalized event without completing a turn on Stop/Submit. */
export function applyCodexContractEvent(
  state: CodexContractState,
  value: unknown,
): CodexContractApplyResult {
  const internal = cloneInternal(getInternalState(state));
  const normalized = normalizeContractEvent(value);
  if (!normalized.ok) {
    const failure = recordFailure(internal, normalized.failure);
    return finish(internal, [], [], failure);
  }

  switch (normalized.event.kind) {
    case "promptObserved":
      return applyPrompt(internal, normalized.event);
    case "reportObserved":
      return applyReport(internal, normalized.event);
    case "turnCommitted":
      return applyCommit(internal, normalized.event);
    case "sweep":
      return applySweep(internal, normalized.event);
  }
}

/** Reduces a sequence of normalized or runtime-shaped events deterministically. */
export function collectCodexInteractions(events: readonly unknown[]): CodexContractState {
  let state = createCodexContractState();
  for (const event of events) {
    state = applyCodexContractEvent(state, event).state;
  }
  return state;
}

function applyPrompt(
  internal: InternalState,
  event: CodexPromptObservedEvent,
): CodexContractApplyResult {
  const key = codexInteractionKey(event.sessionId, event.turnId);
  const completed = internal.completed.get(key);
  if (completed !== undefined) {
    if (completed.submittedPrompt === event.submittedPrompt) {
      return finish(internal);
    }
    return failed(internal, "conflicting-prompt", event.sessionId, event.turnId);
  }

  const pending = getOrCreatePending(internal, event.sessionId, event.turnId);
  if (pending.submittedPrompt === null) {
    pending.submittedPrompt = event.submittedPrompt;
    return finish(internal);
  }
  if (pending.submittedPrompt === event.submittedPrompt) {
    return finish(internal);
  }
  return failed(internal, "conflicting-prompt", event.sessionId, event.turnId);
}

function applyReport(
  internal: InternalState,
  event: CodexReportObservedEvent,
): CodexContractApplyResult {
  const key = codexInteractionKey(event.sessionId, event.turnId);
  if (internal.completed.has(key)) {
    return finish(internal);
  }

  const pending = getOrCreatePending(internal, event.sessionId, event.turnId);
  pending.provisionalReport = event.provisionalReport;
  return finish(internal);
}

function applyCommit(
  internal: InternalState,
  event: CodexTurnCommittedEvent,
): CodexContractApplyResult {
  const key = codexInteractionKey(event.sessionId, event.turnId);
  const completed = internal.completed.get(key);
  if (completed !== undefined) {
    if (completed.finalReport === event.finalReport) {
      return finish(internal);
    }
    return failed(internal, "conflicting-commit", event.sessionId, event.turnId);
  }

  const pending = internal.pending.get(key);
  const completion = completeCodexPending(pending ?? null, event.finalReport);
  if (!completion.ok) {
    return failed(internal, completion.failure.reason, event.sessionId, event.turnId);
  }

  const interaction = completion.interaction;
  internal.pending.delete(key);
  internal.completed.set(key, interaction);
  return finish(internal, [interaction]);
}

function applySweep(internal: InternalState, event: CodexSweepEvent): CodexContractApplyResult {
  internal.clockMs = Math.max(internal.clockMs, event.nowMs);
  const discardedKeys: string[] = [];
  for (const [key, pending] of internal.pending) {
    if (
      event.nowMs >= pending.observedAtMs &&
      event.nowMs - pending.observedAtMs >= event.maxAgeMs
    ) {
      internal.pending.delete(key);
      discardedKeys.push(key);
    }
  }
  discardedKeys.sort();
  return finish(internal, [], discardedKeys);
}

function normalizeContractEvent(value: unknown): CodexNormalizationResult<CodexContractEvent> {
  const record = asRecord(value);
  if (record === undefined || typeof record.kind !== "string") {
    return rejected("malformed-event");
  }

  if (record.kind === "sweep") {
    const nowMs = normalizeTime(record.nowMs);
    const maxAgeMs = normalizeTime(record.maxAgeMs);
    if (nowMs === undefined || maxAgeMs === undefined) {
      return rejected("invalid-sweep");
    }
    return { ok: true, event: { kind: "sweep", nowMs, maxAgeMs } };
  }

  const pair = normalizePayloadIds(record, "sessionId", "turnId");
  if (!pair.ok) {
    return pair;
  }

  switch (record.kind) {
    case "promptObserved": {
      const prompt = normalizePromptText(record.submittedPrompt);
      if (!prompt.ok) {
        return rejected(prompt.reason, pair.sessionId, pair.turnId);
      }
      return {
        ok: true,
        event: {
          kind: "promptObserved",
          sessionId: pair.sessionId,
          turnId: pair.turnId,
          submittedPrompt: prompt.value,
        },
      };
    }
    case "reportObserved": {
      const report = normalizeReportText(record.provisionalReport);
      if (!report.ok) {
        return rejected(report.reason, pair.sessionId, pair.turnId);
      }
      return {
        ok: true,
        event: {
          kind: "reportObserved",
          sessionId: pair.sessionId,
          turnId: pair.turnId,
          provisionalReport: report.value,
        },
      };
    }
    case "turnCommitted": {
      const report = normalizeReportText(record.finalReport);
      if (!report.ok) {
        return rejected(report.reason, pair.sessionId, pair.turnId);
      }
      return {
        ok: true,
        event: {
          kind: "turnCommitted",
          sessionId: pair.sessionId,
          turnId: pair.turnId,
          finalReport: report.value,
        },
      };
    }
    default:
      return rejected("unknown-event", pair.sessionId, pair.turnId);
  }
}

function normalizePayloadIds(
  record: RecordValue,
  sessionField: string,
  turnField: string,
): { ok: true; sessionId: string; turnId: string } | { ok: false; failure: CodexContractFailure } {
  const sessionResult = validateIdentifier(record[sessionField], "session");
  const turnResult = validateIdentifier(record[turnField], "turn");
  const turnId = safeIdentifier(record[turnField]);
  if (!sessionResult.ok) {
    return { ok: false, failure: makeFailure(sessionResult.reason, undefined, turnId) };
  }
  if (!turnResult.ok) {
    return { ok: false, failure: makeFailure(turnResult.reason, sessionResult.value, turnId) };
  }
  return { ok: true, sessionId: sessionResult.value, turnId: turnResult.value };
}

function normalizePromptText(
  value: unknown,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "missing-prompt" };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CODEX_PROMPT_BYTES) {
    return { ok: false, reason: "oversized-prompt" };
  }
  if (value.trim().length === 0) {
    return { ok: false, reason: "empty-prompt" };
  }
  return { ok: true, value };
}

function normalizeReportText(
  value: unknown,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return { ok: false, reason: "missing-report" };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CODEX_FINAL_REPORT_BYTES) {
    return { ok: false, reason: "oversized-report" };
  }
  return { ok: true, value };
}

function validateIdentifier(value: unknown, name: IdentifierName): ValidatedIdentifier {
  const invalidReason = `invalid-${name}-id`;
  const oversizedReason = `oversized-${name}-id`;
  if (typeof value !== "string" || value.length === 0) {
    return { ok: false, reason: invalidReason };
  }
  if (Buffer.byteLength(value, "utf8") > MAX_CODEX_ID_BYTES) {
    return { ok: false, reason: oversizedReason };
  }
  return { ok: true, value };
}

function safeIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_CODEX_ID_BYTES
  ) {
    return undefined;
  }
  return value;
}

function normalizeTime(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return undefined;
  }
  return value;
}

function getOrCreatePending(
  internal: InternalState,
  sessionId: string,
  turnId: string,
): PendingRecord {
  const key = codexInteractionKey(sessionId, turnId);
  const existing = internal.pending.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const pending: PendingRecord = {
    key,
    sessionId,
    turnId,
    submittedPrompt: null,
    provisionalReport: null,
    observedAtMs: internal.clockMs,
  };
  internal.pending.set(key, pending);
  return pending;
}

function failed(
  internal: InternalState,
  reason: string,
  sessionId: string,
  turnId: string,
): CodexContractApplyResult {
  const failure = recordFailure(internal, makeFailure(reason, sessionId, turnId));
  return finish(internal, [], [], failure);
}

function rejected(
  reason: string,
  sessionId?: string,
  turnId?: string,
): { ok: false; failure: CodexContractFailure } {
  return { ok: false, failure: makeFailure(reason, sessionId, turnId) };
}

function makeFailure(reason: string, sessionId?: string, turnId?: string): CodexContractFailure {
  const failure: CodexContractFailure = { reason };
  if (sessionId !== undefined) {
    failure.sessionId = sessionId;
  }
  if (turnId !== undefined) {
    failure.turnId = turnId;
  }
  return failure;
}

function recordFailure(
  internal: InternalState,
  failure: CodexContractFailure,
): CodexContractFailure {
  const key = JSON.stringify([failure.reason, failure.sessionId ?? null, failure.turnId ?? null]);
  const existing = internal.failures.get(key);
  if (existing !== undefined) {
    return existing;
  }
  internal.failures.set(key, failure);
  return failure;
}

function finish(
  internal: InternalState,
  emitted: CodexCompletedInteraction[] = [],
  discardedKeys: string[] = [],
  failure: CodexContractFailure | null = null,
): CodexContractApplyResult {
  return {
    state: makeState(internal),
    emitted,
    discardedKeys,
    failure,
  };
}

function getInternalState(state: CodexContractState): InternalState {
  const attached = state[INTERNAL_STATE];
  if (isInternalState(attached)) {
    return attached;
  }
  throw new TypeError("invalid Codex contract state");
}

function isInternalState(value: unknown): value is InternalState {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<InternalState>;
  return (
    candidate.pending instanceof Map &&
    candidate.completed instanceof Map &&
    candidate.failures instanceof Map &&
    typeof candidate.clockMs === "number"
  );
}

function cloneInternal(internal: InternalState): InternalState {
  return {
    pending: new Map([...internal.pending].map(([key, value]) => [key, { ...value }] as const)),
    completed: new Map([...internal.completed].map(([key, value]) => [key, { ...value }] as const)),
    failures: new Map([...internal.failures].map(([key, value]) => [key, { ...value }] as const)),
    clockMs: internal.clockMs,
  };
}

function makeState(internal: InternalState): CodexContractState {
  return {
    pending: [...internal.pending.values()].map((value) => ({
      key: value.key,
      sessionId: value.sessionId,
      turnId: value.turnId,
      submittedPrompt: value.submittedPrompt,
      provisionalReport: value.provisionalReport,
    })),
    completed: [...internal.completed.values()].map((value) => ({ ...value })),
    failures: [...internal.failures.values()].map((value) => ({ ...value })),
    [INTERNAL_STATE]: internal,
  };
}

function asRecord(value: unknown): RecordValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as RecordValue;
}

function hasOwn(record: RecordValue, key: string): boolean {
  return Object.hasOwn(record, key);
}
