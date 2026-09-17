import { Buffer } from "node:buffer";

import {
  MAX_PI_FINAL_REPORT_BYTES,
  MAX_PI_INTERACTION_ID_BYTES,
  MAX_PI_PROMPT_BYTES,
  MAX_PI_SESSION_ID_BYTES,
} from "../domain/pi-interaction.ts";

export const MAX_PI_EVENT_ID_BYTES = 128;
export const MAX_PI_SHORT_EVENT_TEXT_BYTES = 128;

const INTERNAL_STATE = Symbol("pi-collector-contract-state");
const EVENT_KINDS = new Set([
  "inputObserved",
  "promptObserved",
  "assistantCandidate",
  "settled",
  "sessionEnded",
  "writeFailed",
  "unsupported",
]);
const INPUT_MODES = new Set(["new", "steer", "followUp"]);
const PROMPT_MODES = new Set(["new", "steer"]);
const SUCCESS_OUTCOMES = new Set(["success", "idle"]);

export type PiContractStatus = "pending" | "completed" | "failed";

export interface PiContractInteraction {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  effectivePrompt: string | null;
  finalReport: string | null;
  status: PiContractStatus;
  reason: string | null;
}

export interface PiContractFailure {
  kind: "interaction-failed" | "event-failed";
  sessionId?: string;
  interactionId?: string;
  sequence?: number;
  reason: string;
}

export interface PiTerminalEmission {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  effectivePrompt: string | null;
  finalReport: string | null;
  status: Exclude<PiContractStatus, "pending">;
  reason: string | null;
}

export interface PiContractState {
  interactions: PiContractInteraction[];
  failures: PiContractFailure[];
  [INTERNAL_STATE]?: unknown;
}

export interface PiContractApplyResult {
  state: PiContractState;
  emitted: PiTerminalEmission[];
}

/**
 * The observer event vocabulary is deliberately independent of Pi's runtime
 * types. The extension adapts Pi events into these records before applying
 * them, which keeps pairing and finality deterministic in tests and in the
 * ingest boundary.
 */
export type PiContractEvent =
  | {
      kind: "inputObserved";
      sessionId: string;
      sequence: number;
      eventId?: string;
      submittedPrompt: string;
      mode?: "new" | "steer" | "followUp";
      handled?: boolean;
    }
  | {
      kind: "promptObserved";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId: string;
      effectivePrompt: string;
      mode?: "new" | "steer";
      hasAttachments?: boolean;
    }
  | {
      kind: "assistantCandidate";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId: string;
      role: string;
      stopReason: string;
      text?: string;
      textBlocks?: string[];
    }
  | {
      kind: "settled";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionIds?: string[];
      outcome?: string;
    }
  | {
      kind: "sessionEnded";
      sessionId: string;
      sequence: number;
      eventId?: string;
      reason?: string;
    }
  | {
      kind: "writeFailed";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId: string;
      reason?: string;
    }
  | {
      kind: "unsupported";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId?: string;
      reason: string;
    };

interface InternalState {
  events: NormalizedEventEntry[];
  fingerprints: Set<string>;
  eventIds: Map<string, string>;
  sequenceFingerprints: Map<number, string>;
  inputFailures: Map<string, PiContractFailure>;
  nextOrder: number;
}

interface NormalizedEventEntry {
  event: NormalizedEvent;
  order: number;
}

type NormalizedEvent =
  | {
      kind: "inputObserved";
      sessionId: string;
      sequence: number;
      eventId?: string;
      submittedPrompt: string;
      mode: "new" | "steer" | "followUp";
      handled: boolean;
      rejectedReason?: string;
    }
  | {
      kind: "promptObserved";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId: string;
      effectivePrompt: string;
      mode: "new" | "steer";
      hasAttachments: boolean;
      rejectedReason?: string;
    }
  | {
      kind: "assistantCandidate";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId: string;
      role: string;
      stopReason: string;
      text: string;
      rejectedReason?: string;
    }
  | {
      kind: "settled";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionIds?: string[];
      outcome: string;
    }
  | {
      kind: "sessionEnded";
      sessionId: string;
      sequence: number;
      eventId?: string;
      reason: string;
    }
  | {
      kind: "writeFailed";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId: string;
      reason: string;
    }
  | {
      kind: "unsupported";
      sessionId: string;
      sequence: number;
      eventId?: string;
      interactionId?: string;
      reason: string;
    };

interface PendingOriginal {
  submittedPrompt: string;
  mode: "new" | "steer" | "followUp";
  sequence: number;
  rejectedReason?: string;
  targetInteractionId?: string;
}

interface Candidate {
  sequence: number;
  assistantStop: boolean;
  eligible: boolean;
  text: string;
  reason?: string;
}

interface InternalInteraction {
  interactionId: string;
  sessionId: string;
  submittedPrompt: string;
  effectivePrompt: string | null;
  finalReport: string | null;
  status: PiContractStatus;
  reason?: string;
  candidates: Candidate[];
  order: number;
}

/** Create an empty deterministic Pi observer contract. */
export function createPiContractState(): PiContractState {
  return makeState({
    events: [],
    fingerprints: new Set(),
    eventIds: new Map(),
    sequenceFingerprints: new Map(),
    inputFailures: new Map(),
    nextOrder: 0,
  });
}

/** Add one event, reordering only by its explicit sequence key. */
export function applyPiContractEvent(
  state: PiContractState,
  value: unknown,
): PiContractApplyResult {
  assertState(state);
  const before = state.interactions;
  const internal = cloneInternal(state[INTERNAL_STATE] as InternalState);
  let event: NormalizedEvent;
  try {
    event = normalizeEvent(value);
  } catch (error) {
    const reason = error instanceof ContractInputError ? error.code : "malformed-event";
    const key = `invalid:${rawIdentity(value)}:${reason}`;
    if (!internal.inputFailures.has(key)) {
      internal.inputFailures.set(key, inputFailure(value, reason));
    }
    return rebuild(internal, before);
  }

  const fullFingerprint = eventFingerprint(event);
  const semanticFingerprint = semanticEventFingerprint(event);
  if (event.eventId !== undefined) {
    const prior = internal.eventIds.get(event.eventId);
    if (prior !== undefined) {
      if (prior === semanticFingerprint) {
        return { state, emitted: [] };
      }
      const key = `event-id-conflict:${event.eventId}:${fullFingerprint}`;
      if (!internal.inputFailures.has(key)) {
        internal.inputFailures.set(key, eventFailure(event, "conflicting-event"));
      }
      return rebuild(internal, before);
    }
  }
  if (internal.fingerprints.has(fullFingerprint)) {
    return { state, emitted: [] };
  }
  const priorSequence = internal.sequenceFingerprints.get(event.sequence);
  if (priorSequence !== undefined && priorSequence !== fullFingerprint) {
    const key = `sequence-conflict:${event.sequence}:${fullFingerprint}`;
    if (!internal.inputFailures.has(key)) {
      internal.inputFailures.set(key, eventFailure(event, "conflicting-sequence"));
    }
    return rebuild(internal, before);
  }

  internal.events.push({ event, order: internal.nextOrder });
  internal.nextOrder += 1;
  internal.fingerprints.add(fullFingerprint);
  internal.sequenceFingerprints.set(event.sequence, fullFingerprint);
  if (event.eventId !== undefined) {
    internal.eventIds.set(event.eventId, semanticFingerprint);
  }
  return rebuild(internal, before);
}

/** Reduce an event sequence using the same ordering rules as incremental use. */
export function collectPiInteractions(events: readonly unknown[]): PiContractState {
  let state = createPiContractState();
  for (const event of events) {
    state = applyPiContractEvent(state, event).state;
  }
  return state;
}

function rebuild(
  internal: InternalState,
  before: readonly PiContractInteraction[],
): PiContractApplyResult {
  const replayed = replayEvents(internal.events);
  const failures = [...replayed.failures, ...internal.inputFailures.values()];
  const state = makeState({ ...internal, interactions: replayed.interactions, failures });
  const beforeTerminal = new Map(
    before
      .filter((interaction) => interaction.status !== "pending")
      .map((interaction) => [
        interactionKey(interaction.sessionId, interaction.interactionId),
        interaction,
      ]),
  );
  const emitted = replayed.interactions
    .filter((interaction) => interaction.status !== "pending")
    .filter((interaction) => {
      const previous = beforeTerminal.get(
        interactionKey(interaction.sessionId, interaction.interactionId),
      );
      return previous === undefined || !sameInteractionOutcome(previous, interaction);
    })
    .map(toEmission);
  return { state, emitted };
}

function replayEvents(entries: readonly NormalizedEventEntry[]): {
  interactions: PiContractInteraction[];
  failures: PiContractFailure[];
} {
  const ordered = entries
    .slice()
    .sort((left, right) => left.event.sequence - right.event.sequence || left.order - right.order);
  const records = new Map<string, InternalInteraction>();
  const pendingInputs = new Map<string, PendingOriginal[]>();
  const failures: PiContractFailure[] = [];

  for (const { event } of ordered) {
    switch (event.kind) {
      case "inputObserved":
        applyInputObserved(pendingInputs, records, event, failures);
        break;
      case "promptObserved":
        applyPromptObserved(pendingInputs, records, event, failures);
        break;
      case "assistantCandidate":
        applyAssistantCandidate(records, event, failures);
        break;
      case "settled":
        applySettled(pendingInputs, records, event, failures);
        break;
      case "sessionEnded":
        applySessionEnded(pendingInputs, records, event, failures);
        break;
      case "writeFailed":
        applyWriteFailed(records, event, failures);
        break;
      case "unsupported":
        failures.push(eventFailure(event, event.reason, event.interactionId));
        break;
    }
  }

  return {
    interactions: [...records.values()].map(publicInteraction),
    failures,
  };
}

function applyInputObserved(
  pendingInputs: Map<string, PendingOriginal[]>,
  records: Map<string, InternalInteraction>,
  event: Extract<NormalizedEvent, { kind: "inputObserved" }>,
  failures: PiContractFailure[],
): void {
  if (event.handled) {
    return;
  }
  if (event.mode === "followUp") {
    failures.push(eventFailure(event, "unsupported-direct-follow-up"));
    return;
  }
  if (event.mode === "steer") {
    const active = pendingRecords(records, event.sessionId);
    if (active.length !== 1) {
      failures.push(
        eventFailure(event, active.length === 0 ? "unsupported-direct-steer" : "ambiguous-steer"),
      );
      return;
    }
    addPendingInput(pendingInputs, event.sessionId, {
      submittedPrompt: event.submittedPrompt,
      mode: event.mode,
      sequence: event.sequence,
      ...(event.rejectedReason === undefined ? {} : { rejectedReason: event.rejectedReason }),
      targetInteractionId: active[0]?.interactionId,
    });
    return;
  }
  addPendingInput(pendingInputs, event.sessionId, {
    submittedPrompt: event.submittedPrompt,
    mode: event.mode,
    sequence: event.sequence,
    ...(event.rejectedReason === undefined ? {} : { rejectedReason: event.rejectedReason }),
  });
}

function applyPromptObserved(
  pendingInputs: Map<string, PendingOriginal[]>,
  records: Map<string, InternalInteraction>,
  event: Extract<NormalizedEvent, { kind: "promptObserved" }>,
  failures: PiContractFailure[],
): void {
  const inputs = pendingInputs.get(event.sessionId) ?? [];
  const steerInputs = inputs.filter((input) => input.mode === "steer");
  const newInputs = inputs.filter((input) => input.mode === "new");
  const isSteer = event.mode === "steer" || steerInputs.length > 0;

  if (isSteer) {
    if (steerInputs.length !== 1 || newInputs.length !== 0) {
      pendingInputs.delete(event.sessionId);
      failures.push(
        eventFailure(
          event,
          steerInputs.length === 0 ? "unpaired-steer" : "ambiguous-steer",
          event.interactionId,
        ),
      );
      return;
    }
    const steer = steerInputs[0];
    const target =
      steer?.targetInteractionId === undefined
        ? pendingRecords(records, event.sessionId)
        : [records.get(interactionKey(event.sessionId, steer.targetInteractionId))];
    const record = target.length === 1 ? target[0] : undefined;
    pendingInputs.delete(event.sessionId);
    if (record === undefined || record.status !== "pending") {
      failures.push(eventFailure(event, "unpaired-steer", event.interactionId));
      return;
    }
    if (steer?.rejectedReason !== undefined) {
      failRecord(record, steer.rejectedReason, event, failures);
      return;
    }
    if (event.rejectedReason !== undefined) {
      failRecord(record, event.rejectedReason, event, failures);
      return;
    }
    if (event.hasAttachments) {
      failRecord(record, "unsupported-attachments", event, failures);
      return;
    }
    const submittedPrompt = `${record.submittedPrompt}\n${steer?.submittedPrompt ?? ""}`;
    const effectivePrompt = `${record.effectivePrompt ?? ""}\n${event.effectivePrompt}`;
    if (Buffer.byteLength(submittedPrompt, "utf8") > MAX_PI_PROMPT_BYTES) {
      failRecord(record, "oversized-submitted-prompt", event, failures);
      return;
    }
    if (Buffer.byteLength(effectivePrompt, "utf8") > MAX_PI_PROMPT_BYTES) {
      failRecord(record, "oversized-effective-prompt", event, failures);
      return;
    }
    record.submittedPrompt = submittedPrompt;
    record.effectivePrompt = effectivePrompt;
    return;
  }

  if (newInputs.length !== 1 || inputs.length !== 1) {
    pendingInputs.delete(event.sessionId);
    failures.push(
      eventFailure(
        event,
        newInputs.length === 0 ? "unpaired-before-agent-start" : "ambiguous-prompt-pairing",
        event.interactionId,
      ),
    );
    return;
  }
  const original = newInputs[0];
  pendingInputs.delete(event.sessionId);
  if (original === undefined) {
    failures.push(eventFailure(event, "unpaired-before-agent-start", event.interactionId));
    return;
  }

  const key = interactionKey(event.sessionId, event.interactionId);
  const existing = records.get(key);
  if (existing !== undefined) {
    failures.push(eventFailure(event, "conflicting-prompt", event.interactionId));
    return;
  }
  const record: InternalInteraction = {
    interactionId: event.interactionId,
    sessionId: event.sessionId,
    submittedPrompt: original.submittedPrompt,
    effectivePrompt: event.effectivePrompt,
    finalReport: null,
    status: "pending",
    candidates: [],
    order: event.sequence,
  };
  records.set(key, record);
  if (original.rejectedReason !== undefined) {
    failRecord(record, original.rejectedReason, event, failures);
  } else if (event.rejectedReason !== undefined) {
    failRecord(record, event.rejectedReason, event, failures);
  } else if (event.hasAttachments) {
    failRecord(record, "unsupported-attachments", event, failures);
  }
}

function applyAssistantCandidate(
  records: Map<string, InternalInteraction>,
  event: Extract<NormalizedEvent, { kind: "assistantCandidate" }>,
  failures: PiContractFailure[],
): void {
  const record = records.get(interactionKey(event.sessionId, event.interactionId));
  if (record === undefined) {
    failures.push(eventFailure(event, "unpaired-candidate", event.interactionId));
    return;
  }
  if (record.status !== "pending") {
    failures.push(eventFailure(event, "late-candidate", event.interactionId));
    return;
  }
  if (event.rejectedReason !== undefined) {
    failRecord(record, event.rejectedReason, event, failures);
    return;
  }

  const assistantStop = event.role === "assistant" && event.stopReason === "stop";
  let reason: string | undefined;
  if (!assistantStop) {
    reason =
      event.role !== "assistant"
        ? "non-assistant"
        : event.stopReason === "unknown"
          ? "intermediate"
          : event.stopReason;
  } else if (event.text.length === 0) {
    reason = "textless-final";
  }
  record.candidates.push({
    sequence: event.sequence,
    assistantStop,
    eligible: assistantStop && event.text.length > 0,
    text: assistantStop && event.text.length > 0 ? event.text : "",
    ...(reason === undefined ? {} : { reason }),
  });
}

function applySettled(
  pendingInputs: Map<string, PendingOriginal[]>,
  records: Map<string, InternalInteraction>,
  event: Extract<NormalizedEvent, { kind: "settled" }>,
  failures: PiContractFailure[],
): void {
  const pending = pendingInputs.get(event.sessionId) ?? [];
  pendingInputs.delete(event.sessionId);
  for (const input of pending) {
    if (input.mode === "steer") {
      failures.push(eventFailure(event, "unsupported-direct-steer"));
    } else if (input.mode === "followUp") {
      failures.push(eventFailure(event, "unsupported-direct-follow-up"));
    } else {
      failures.push(eventFailure(event, "unpaired-input"));
    }
  }

  const targets =
    event.interactionIds === undefined
      ? pendingRecords(records, event.sessionId)
      : event.interactionIds.map((id) => records.get(interactionKey(event.sessionId, id)));
  const pendingTargets = targets.filter(
    (record): record is InternalInteraction => record?.status === "pending",
  );

  if (event.interactionIds === undefined && pendingTargets.length === 0) {
    failures.push(
      eventFailure(event, targets.length === 0 ? "unmatched-settlement" : "conflicting-settlement"),
    );
    return;
  }
  if (event.interactionIds !== undefined) {
    for (const [index, record] of targets.entries()) {
      const interactionId = event.interactionIds[index];
      if (record === undefined) {
        failures.push(eventFailure(event, "unmatched-settlement", interactionId));
      } else if (record.status !== "pending") {
        failures.push(eventFailure(event, "conflicting-settlement", record.interactionId));
      }
    }
  }

  for (const record of pendingTargets) {
    if (!SUCCESS_OUTCOMES.has(event.outcome)) {
      failRecord(record, event.outcome, event, failures);
    } else {
      finalizeRecord(record, event, failures);
    }
  }
}

function applySessionEnded(
  pendingInputs: Map<string, PendingOriginal[]>,
  records: Map<string, InternalInteraction>,
  event: Extract<NormalizedEvent, { kind: "sessionEnded" }>,
  failures: PiContractFailure[],
): void {
  const pending = pendingInputs.get(event.sessionId) ?? [];
  pendingInputs.delete(event.sessionId);
  for (const input of pending) {
    if (input.mode === "steer") {
      failures.push(eventFailure(event, "unsupported-direct-steer"));
    } else if (input.mode === "followUp") {
      failures.push(eventFailure(event, "unsupported-direct-follow-up"));
    }
  }
  for (const record of pendingRecords(records, event.sessionId)) {
    failRecord(record, event.reason, event, failures);
  }
}

function applyWriteFailed(
  records: Map<string, InternalInteraction>,
  event: Extract<NormalizedEvent, { kind: "writeFailed" }>,
  failures: PiContractFailure[],
): void {
  const record = records.get(interactionKey(event.sessionId, event.interactionId));
  if (record === undefined) {
    failures.push(eventFailure(event, "unpaired-write-failure", event.interactionId));
  } else if (record.status === "pending") {
    failRecord(record, event.reason, event, failures);
  } else {
    failures.push(eventFailure(event, `conflicting-${event.reason}`, event.interactionId));
  }
}

function finalizeRecord(
  record: InternalInteraction,
  event: Extract<NormalizedEvent, { kind: "settled" }>,
  failures: PiContractFailure[],
): void {
  const stopCandidates = record.candidates.filter((candidate) => candidate.assistantStop);
  const finalCandidate = stopCandidates.at(-1);
  if (finalCandidate === undefined) {
    failRecord(record, lastCandidateReason(record), event, failures);
    return;
  }
  if (!finalCandidate.eligible) {
    failRecord(record, finalCandidate.reason ?? "unsupported-final", event, failures);
    return;
  }
  record.status = "completed";
  record.finalReport = finalCandidate.text;
  record.reason = undefined;
}

function lastCandidateReason(record: InternalInteraction): string {
  const last = record.candidates.at(-1);
  if (last === undefined) {
    return "missing-final";
  }
  if (last.reason === "textless-final") {
    return "textless-final";
  }
  if (last.reason === "non-assistant") {
    return "non-assistant-final";
  }
  return last.reason ?? "unsupported-final";
}

function failRecord(
  record: InternalInteraction,
  reason: string,
  event: { sessionId: string; sequence: number; interactionId?: string },
  failures: PiContractFailure[],
): void {
  if (record.status !== "pending") {
    failures.push(eventFailure(event, `conflicting-${reason}`, record.interactionId));
    return;
  }
  record.status = "failed";
  record.finalReport = null;
  record.reason = reason;
  failures.push(eventFailure(event, reason, record.interactionId));
}

function pendingRecords(
  records: Map<string, InternalInteraction>,
  sessionId: string,
): InternalInteraction[] {
  return [...records.values()].filter(
    (record) => record.sessionId === sessionId && record.status === "pending",
  );
}

function addPendingInput(
  pendingInputs: Map<string, PendingOriginal[]>,
  sessionId: string,
  input: PendingOriginal,
): void {
  const values = pendingInputs.get(sessionId) ?? [];
  values.push(input);
  pendingInputs.set(sessionId, values);
}

function publicInteraction(record: InternalInteraction): PiContractInteraction {
  return {
    interactionId: record.interactionId,
    sessionId: record.sessionId,
    submittedPrompt: record.submittedPrompt,
    effectivePrompt: record.effectivePrompt,
    finalReport: record.finalReport,
    status: record.status,
    reason: record.reason ?? null,
  };
}

function toEmission(record: PiContractInteraction): PiTerminalEmission {
  if (record.status === "completed") {
    return { ...record, status: "completed" };
  }
  if (record.status === "failed") {
    return { ...record, status: "failed" };
  }
  throw new Error("Pending interactions cannot be emitted.");
}

function sameInteractionOutcome(
  left: PiContractInteraction,
  right: PiContractInteraction,
): boolean {
  return (
    left.interactionId === right.interactionId &&
    left.sessionId === right.sessionId &&
    left.submittedPrompt === right.submittedPrompt &&
    left.effectivePrompt === right.effectivePrompt &&
    left.finalReport === right.finalReport &&
    left.status === right.status &&
    left.reason === right.reason
  );
}

function eventFailure(
  event: { sessionId: string; sequence: number },
  reason: string,
  interactionId?: string,
): PiContractFailure {
  return {
    kind: interactionId === undefined ? "event-failed" : "interaction-failed",
    sessionId: event.sessionId,
    sequence: event.sequence,
    ...(interactionId === undefined ? {} : { interactionId }),
    reason,
  };
}

function inputFailure(value: unknown, reason: string): PiContractFailure {
  const raw = isRecord(value) ? value : {};
  return {
    kind: "event-failed",
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.sequence === "number" && Number.isSafeInteger(raw.sequence)
      ? { sequence: raw.sequence }
      : {}),
    reason,
  };
}

function normalizeEvent(value: unknown): NormalizedEvent {
  if (!isRecord(value)) {
    throw new ContractInputError("malformed-event", "event must be an object");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) {
    throw new ContractInputError("malformed-event", "event kind is unknown");
  }
  const sessionId = validateIdentifier(value.sessionId, "sessionId", MAX_PI_SESSION_ID_BYTES);
  const sequence = validateSequence(value.sequence);
  const eventId =
    value.eventId === undefined
      ? undefined
      : validateIdentifier(value.eventId, "eventId", MAX_PI_EVENT_ID_BYTES);

  if (kind === "inputObserved") {
    const mode = value.mode === undefined ? "new" : value.mode;
    if (!isInputMode(mode)) {
      throw new ContractInputError("malformed-event", "input mode is unknown");
    }
    const handled = value.handled === true;
    const submittedPrompt = value.submittedPrompt;
    if (typeof submittedPrompt !== "string") {
      throw new ContractInputError("malformed-event", "submitted prompt is not text");
    }
    if (Buffer.byteLength(submittedPrompt, "utf8") > MAX_PI_PROMPT_BYTES) {
      return {
        kind,
        sessionId,
        sequence,
        ...(eventId === undefined ? {} : { eventId }),
        submittedPrompt: "",
        mode,
        handled,
        rejectedReason: "oversized-submitted-prompt",
      };
    }
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      submittedPrompt,
      mode,
      handled,
    };
  }

  if (kind === "promptObserved") {
    const interactionId = validateIdentifier(
      value.interactionId,
      "interactionId",
      MAX_PI_INTERACTION_ID_BYTES,
    );
    const effectivePrompt = value.effectivePrompt;
    if (typeof effectivePrompt !== "string") {
      throw new ContractInputError("malformed-event", "effective prompt is not text");
    }
    const mode = value.mode === undefined ? "new" : value.mode;
    if (!isPromptMode(mode)) {
      throw new ContractInputError("malformed-event", "prompt mode is unknown");
    }
    if (Buffer.byteLength(effectivePrompt, "utf8") > MAX_PI_PROMPT_BYTES) {
      return {
        kind,
        sessionId,
        sequence,
        ...(eventId === undefined ? {} : { eventId }),
        interactionId,
        effectivePrompt: "",
        mode,
        hasAttachments: hasAttachments(value),
        rejectedReason: "oversized-effective-prompt",
      };
    }
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      interactionId,
      effectivePrompt,
      mode,
      hasAttachments: hasAttachments(value),
    };
  }

  if (kind === "assistantCandidate") {
    const interactionId = validateIdentifier(
      value.interactionId,
      "interactionId",
      MAX_PI_INTERACTION_ID_BYTES,
    );
    const role = value.role === undefined ? "unknown" : validateShortText(value.role, "role");
    const stopReason =
      value.stopReason === undefined
        ? "unknown"
        : validateShortText(value.stopReason, "stopReason");
    const text = candidateText(value);
    if (Buffer.byteLength(text, "utf8") > MAX_PI_FINAL_REPORT_BYTES) {
      return {
        kind,
        sessionId,
        sequence,
        ...(eventId === undefined ? {} : { eventId }),
        interactionId,
        role,
        stopReason,
        text: "",
        rejectedReason: "oversized-candidate",
      };
    }
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      interactionId,
      role,
      stopReason,
      text,
    };
  }

  if (kind === "settled") {
    const interactionIds =
      value.interactionIds === undefined
        ? undefined
        : validateIdentifierList(
            value.interactionIds,
            "interactionIds",
            MAX_PI_INTERACTION_ID_BYTES,
          );
    const outcome =
      value.outcome === undefined ? "success" : validateShortText(value.outcome, "outcome");
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      ...(interactionIds === undefined ? {} : { interactionIds }),
      outcome,
    };
  }

  if (kind === "sessionEnded") {
    const reason =
      value.reason === undefined ? "session-ended" : validateShortText(value.reason, "reason");
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      reason,
    };
  }

  if (kind === "writeFailed") {
    const interactionId = validateIdentifier(
      value.interactionId,
      "interactionId",
      MAX_PI_INTERACTION_ID_BYTES,
    );
    const reason =
      value.reason === undefined ? "write-failed" : validateShortText(value.reason, "reason");
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      interactionId,
      reason,
    };
  }

  const interactionId =
    value.interactionId === undefined
      ? undefined
      : validateIdentifier(value.interactionId, "interactionId", MAX_PI_INTERACTION_ID_BYTES);
  const reason = validateShortText(value.reason, "reason");
  return {
    kind: "unsupported",
    sessionId,
    sequence,
    ...(eventId === undefined ? {} : { eventId }),
    ...(interactionId === undefined ? {} : { interactionId }),
    reason,
  };
}

function candidateText(value: Record<string, unknown>): string {
  if (value.textBlocks !== undefined) {
    if (
      !Array.isArray(value.textBlocks) ||
      value.textBlocks.some((block) => typeof block !== "string")
    ) {
      throw new ContractInputError("malformed-event", "textBlocks must contain only text");
    }
    const text = value.textBlocks.join("");
    if (value.text !== undefined && value.text !== text) {
      throw new ContractInputError("conflicting-text", "text and textBlocks conflict");
    }
    return text;
  }
  if (value.text === undefined) {
    return "";
  }
  if (typeof value.text !== "string") {
    throw new ContractInputError("malformed-event", "candidate text is not text");
  }
  return value.text;
}

function hasAttachments(value: Record<string, unknown>): boolean {
  if (value.hasAttachments === true) {
    return true;
  }
  if (Array.isArray(value.images)) {
    return value.images.length > 0;
  }
  return typeof value.imageCount === "number" && value.imageCount > 0;
}

function validateIdentifier(value: unknown, name: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || hasControlCharacter(value)) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  return value;
}

function validateIdentifierList(value: unknown, name: string, maxBytes: number): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  return value.map((item) => validateIdentifier(item, name, maxBytes));
}

function validateSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ContractInputError("malformed-event", "sequence is invalid");
  }
  return value;
}

function isInputMode(value: unknown): value is "new" | "steer" | "followUp" {
  return typeof value === "string" && INPUT_MODES.has(value);
}

function isPromptMode(value: unknown): value is "new" | "steer" {
  return typeof value === "string" && PROMPT_MODES.has(value);
}

function validateShortText(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PI_SHORT_EVENT_TEXT_BYTES
  ) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  return value;
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

function interactionKey(sessionId: string, interactionId: string): string {
  return `${sessionId.length}:${sessionId}${interactionId.length}:${interactionId}`;
}

function eventFingerprint(event: NormalizedEvent): string {
  return JSON.stringify(event);
}

function semanticEventFingerprint(event: NormalizedEvent): string {
  const { eventId: _eventId, sequence: _sequence, ...semantic } = event;
  return JSON.stringify(semantic);
}

function rawIdentity(value: unknown): string {
  if (!isRecord(value)) {
    return typeof value;
  }
  return JSON.stringify([
    typeof value.kind === "string" ? value.kind : "unknown",
    typeof value.sessionId === "string" ? value.sessionId : "unknown",
    typeof value.sequence === "number" ? value.sequence : "unknown",
    typeof value.eventId === "string" ? value.eventId : "unknown",
    typeof value.interactionId === "string" ? value.interactionId : "unknown",
  ]);
}

function makeState(
  internal: InternalState & {
    interactions?: PiContractInteraction[];
    failures?: PiContractFailure[];
  },
): PiContractState {
  const state: PiContractState = {
    interactions: internal.interactions ?? [],
    failures: internal.failures ?? [],
  };
  Object.defineProperty(state, INTERNAL_STATE, {
    value: {
      events: internal.events,
      fingerprints: internal.fingerprints,
      eventIds: internal.eventIds,
      sequenceFingerprints: internal.sequenceFingerprints,
      inputFailures: internal.inputFailures,
      nextOrder: internal.nextOrder,
    },
    enumerable: false,
  });
  return state;
}

function cloneInternal(internal: InternalState): InternalState {
  return {
    events: internal.events.slice(),
    fingerprints: new Set(internal.fingerprints),
    eventIds: new Map(internal.eventIds),
    sequenceFingerprints: new Map(internal.sequenceFingerprints),
    inputFailures: new Map(internal.inputFailures),
    nextOrder: internal.nextOrder,
  };
}

function assertState(state: PiContractState): asserts state is PiContractState & {
  [INTERNAL_STATE]: InternalState;
} {
  if (!isRecord(state) || state[INTERNAL_STATE] === undefined) {
    throw new TypeError("state must come from createPiContractState");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class ContractInputError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ContractInputError";
    this.code = code;
  }
}
