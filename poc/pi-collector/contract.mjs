import { Buffer } from "node:buffer";

export const MAX_SESSION_ID_BYTES = 128;
export const MAX_INTERACTION_ID_BYTES = 128;
export const MAX_EVENT_ID_BYTES = 128;
export const MAX_PROMPT_BYTES = 64 * 1024;
export const MAX_CANDIDATE_TEXT_BYTES = 64 * 1024;

const INTERNAL_STATE = Symbol("pi-collector-contract-state");
const EVENT_KINDS = new Set([
  "promptObserved",
  "assistantCandidate",
  "settled",
  "sessionEnded",
  "writeFailed",
]);
const PROMPT_MODES = new Set(["new", "steer"]);
const SUCCESS_OUTCOMES = new Set(["success", "idle"]);

/**
 * Create a pure event-sourced contract state. Candidate bodies stay behind a
 * non-enumerable internal symbol and never appear in interaction snapshots.
 */
export function createContractState() {
  return makeState({
    events: [],
    fingerprints: new Set(),
    eventIds: new Map(),
    sequenceFingerprints: new Map(),
    inputFailures: new Map(),
    nextOrder: 0,
  });
}

/**
 * Normalize one observer event without trimming or otherwise rewriting text.
 * `prompt` is the effective post-expansion prompt; unrelated input fields are
 * intentionally ignored. Oversized text becomes a rejected event without
 * retaining the oversized body.
 */
export function normalizeEvent(value) {
  if (!isRecord(value)) {
    throw new ContractInputError("malformed-event", "event must be an object");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) {
    throw new ContractInputError("malformed-event", "event kind is unknown");
  }

  const sessionId = validateIdentifier(value.sessionId, "sessionId", MAX_SESSION_ID_BYTES);
  const sequence = validateSequence(value.sequence);
  const eventId = value.eventId === undefined ? undefined : validateIdentifier(value.eventId, "eventId", MAX_EVENT_ID_BYTES);

  if (kind === "promptObserved") {
    // The observer mints this ID per before_agent_start within the session scope.
    const interactionId = validateIdentifier(
      value.interactionId ?? value.id,
      "interactionId",
      MAX_INTERACTION_ID_BYTES,
    );
    const mode = value.mode ?? "new";
    if (typeof mode !== "string" || !PROMPT_MODES.has(mode)) {
      throw new ContractInputError("malformed-event", "prompt mode is unknown");
    }
    const prompt = value.prompt ?? value.effectivePrompt;
    if (typeof prompt !== "string") {
      throw new ContractInputError("malformed-event", "prompt is not text");
    }
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
      return {
        kind,
        sessionId,
        sequence,
        ...(eventId === undefined ? {} : { eventId }),
        interactionId,
        mode,
        prompt: "",
        rejectedReason: "oversized-prompt",
      };
    }
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      interactionId,
      mode,
      prompt,
    };
  }

  if (kind === "assistantCandidate") {
    const interactionId = validateIdentifier(
      value.interactionId ?? value.id,
      "interactionId",
      MAX_INTERACTION_ID_BYTES,
    );
    const role = value.role === undefined ? "unknown" : validateShortText(value.role, "role");
    const stopReason = value.stopReason === undefined ? "unknown" : validateShortText(value.stopReason, "stopReason");
    const text = candidateText(value);
    if (Buffer.byteLength(text, "utf8") > MAX_CANDIDATE_TEXT_BYTES) {
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
    const interactionIds = value.interactionIds ?? (value.interactionId === undefined ? undefined : [value.interactionId]);
    const normalizedIds = interactionIds === undefined
      ? undefined
      : validateIdentifierList(interactionIds, "interactionIds", MAX_INTERACTION_ID_BYTES);
    const outcome = value.outcome === undefined ? "success" : validateShortText(value.outcome, "outcome");
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      ...(normalizedIds === undefined ? {} : { interactionIds: normalizedIds }),
      outcome,
    };
  }

  if (kind === "sessionEnded") {
    const reason = value.reason === undefined ? "session-ended" : validateShortText(value.reason, "reason");
    return {
      kind,
      sessionId,
      sequence,
      ...(eventId === undefined ? {} : { eventId }),
      reason,
    };
  }

  const interactionId = validateIdentifier(
    value.interactionId ?? value.id,
    "interactionId",
    MAX_INTERACTION_ID_BYTES,
  );
  const reason = value.reason === undefined ? "write-failed" : validateShortText(value.reason, "reason");
  return {
    kind,
    sessionId,
    sequence,
    ...(eventId === undefined ? {} : { eventId }),
    interactionId,
    reason,
  };
}

/**
 * Add one observer event and replay the deterministic event log. Replaying
 * makes prompt-before-settled causality safe even when delivery is reordered.
 */
export function applyEvent(state, value) {
  assertState(state);
  const before = state.interactions;
  const internal = cloneInternal(state[INTERNAL_STATE]);
  let event;
  try {
    event = normalizeEvent(value);
  } catch (error) {
    const reason = error instanceof ContractInputError ? error.code : "malformed-event";
    const failureKey = `invalid:${rawIdentity(value)}:${reason}`;
    if (!internal.inputFailures.has(failureKey)) {
      internal.inputFailures.set(failureKey, inputFailure(value, reason));
    }
    return rebuild(internal, before);
  }

  const fingerprint = eventFingerprint(event);
  if (event.eventId !== undefined && internal.eventIds.has(event.eventId)) {
    if (internal.eventIds.get(event.eventId) === fingerprint) {
      return { state, emitted: [] };
    }
    const failureKey = `event-id-conflict:${event.eventId}:${fingerprint}`;
    if (!internal.inputFailures.has(failureKey)) {
      internal.inputFailures.set(failureKey, eventFailure(event, "conflicting-event"));
    }
    return rebuild(internal, before);
  }
  if (internal.fingerprints.has(fingerprint)) {
    return { state, emitted: [] };
  }
  const priorFingerprint = internal.sequenceFingerprints.get(event.sequence);
  if (priorFingerprint !== undefined && priorFingerprint !== fingerprint) {
    const failureKey = `sequence-conflict:${event.sequence}:${fingerprint}`;
    if (!internal.inputFailures.has(failureKey)) {
      internal.inputFailures.set(failureKey, eventFailure(event, "conflicting-sequence"));
    }
    return rebuild(internal, before);
  }

  internal.events.push({ event, order: internal.nextOrder });
  internal.nextOrder += 1;
  internal.fingerprints.add(fingerprint);
  internal.sequenceFingerprints.set(event.sequence, fingerprint);
  if (event.eventId !== undefined) {
    internal.eventIds.set(event.eventId, fingerprint);
  }
  return rebuild(internal, before);
}

/** Reduce a finite observer event stream into public interaction snapshots. */
export function collectInteractions(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  let state = createContractState();
  for (const event of events) {
    state = applyEvent(state, event).state;
  }
  return state;
}

function rebuild(internal, beforeInteractions) {
  const replayed = replayEvents(internal.events);
  const failures = [...replayed.failures, ...internal.inputFailures.values()];
  const state = makeState({
    ...internal,
    interactions: replayed.interactions,
    failures,
  });
  const beforeTerminal = new Map(
    beforeInteractions
      .filter((interaction) => interaction.status !== "pending")
      .map((interaction) => [interactionKey(interaction.sessionId, interaction.id), interaction]),
  );
  const emitted = replayed.interactions
    .filter((interaction) => {
      if (interaction.status === "pending") {
        return false;
      }
      const previous = beforeTerminal.get(interactionKey(interaction.sessionId, interaction.id));
      return previous === undefined || !sameInteractionOutcome(previous, interaction);
    })
    .map(cloneInteraction);
  return { state, emitted };
}

function replayEvents(entries) {
  const ordered = entries
    .slice()
    .sort((left, right) => left.event.sequence - right.event.sequence || left.order - right.order);
  const records = new Map();
  const failures = [];

  for (const { event } of ordered) {
    if (event.kind === "promptObserved") {
      applyPromptObserved(records, event, failures);
    } else if (event.kind === "assistantCandidate") {
      applyAssistantCandidate(records, event, failures);
    } else if (event.kind === "settled") {
      applySettled(records, event, failures);
    } else if (event.kind === "sessionEnded") {
      applySessionEnded(records, event, failures);
    } else {
      applyWriteFailed(records, event, failures);
    }
  }

  return {
    interactions: [...records.values()].map(publicInteraction),
    failures,
  };
}

function applyPromptObserved(records, event, failures) {
  const key = interactionKey(event.sessionId, event.interactionId);
  const existing = records.get(key);
  if (event.mode === "steer") {
    if (existing === undefined) {
      failures.push(eventFailure(event, "unpaired-steer", event.interactionId));
    } else if (existing.status !== "pending") {
      failures.push(eventFailure(event, "conflicting-prompt", event.interactionId));
    } else if (event.rejectedReason !== undefined) {
      failRecord(existing, event.rejectedReason, event, failures);
    } else {
      // Steering is a separate segment; the newline is the only synthetic delimiter.
      const mergedPrompt = `${existing.prompt}\n${event.prompt}`;
      if (Buffer.byteLength(mergedPrompt, "utf8") > MAX_PROMPT_BYTES) {
        failRecord(existing, "oversized-prompt", event, failures);
      } else {
        existing.prompt = mergedPrompt;
      }
    }
    return;
  }

  if (existing !== undefined) {
    if (existing.status === "pending") {
      failRecord(existing, "conflicting-prompt", event, failures);
    } else {
      failures.push(eventFailure(event, "conflicting-prompt", event.interactionId));
    }
    return;
  }

  const record = {
    id: event.interactionId,
    sessionId: event.sessionId,
    prompt: event.prompt,
    finalReport: null,
    status: "pending",
    candidates: [],
    order: event.sequence,
  };
  records.set(key, record);
  if (event.rejectedReason !== undefined) {
    failRecord(record, event.rejectedReason, event, failures);
  }
}

function applyAssistantCandidate(records, event, failures) {
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
  let reason;
  if (!assistantStop) {
    reason = event.role !== "assistant"
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
    reason,
  });
}

function applySettled(records, event, failures) {
  const targets = event.interactionIds === undefined
    ? [...records.values()].filter((record) => record.sessionId === event.sessionId)
    : event.interactionIds.map((id) => records.get(interactionKey(event.sessionId, id)));
  const pendingTargets = targets.filter((record) => record?.status === "pending");

  if (event.interactionIds === undefined && pendingTargets.length === 0) {
    failures.push(eventFailure(
      event,
      targets.length === 0 ? "unmatched-settlement" : "conflicting-settlement",
    ));
    return;
  }

  if (event.interactionIds !== undefined) {
    for (const [index, record] of targets.entries()) {
      if (record === undefined) {
        failures.push(eventFailure(event, "unmatched-settlement", event.interactionIds[index]));
      } else if (record.status !== "pending") {
        failures.push(eventFailure(event, "conflicting-settlement", record.id));
      }
    }
  }

  for (const record of pendingTargets) {
    if (!SUCCESS_OUTCOMES.has(event.outcome)) {
      failRecord(record, event.outcome, event, failures);
      continue;
    }
    finalizeRecord(record, event, failures);
  }
}

function applySessionEnded(records, event, failures) {
  for (const record of records.values()) {
    if (record.sessionId === event.sessionId && record.status === "pending") {
      failRecord(record, event.reason, event, failures);
    }
  }
}

function applyWriteFailed(records, event, failures) {
  const record = records.get(interactionKey(event.sessionId, event.interactionId));
  if (record === undefined) {
    failures.push(eventFailure(event, "unpaired-write-failure", event.interactionId));
  } else if (record.status === "pending") {
    failRecord(record, "write-failed", event, failures);
  } else {
    failures.push(eventFailure(event, "conflicting-write-failure", event.interactionId));
  }
}

function finalizeRecord(record, event, failures) {
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
}

function lastCandidateReason(record) {
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
  return last.reason === undefined ? "unsupported-final" : last.reason;
}

function failRecord(record, reason, event, failures) {
  if (record.status !== "pending") {
    failures.push(eventFailure(event, `conflicting-${reason}`, record.id));
    return;
  }
  record.status = "failed";
  record.finalReport = null;
  record.reason = reason;
  failures.push(eventFailure(event, reason, record.id));
}

function publicInteraction(record) {
  return {
    id: record.id,
    sessionId: record.sessionId,
    prompt: record.prompt,
    finalReport: record.finalReport,
    status: record.status,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
  };
}

function cloneInteraction(interaction) {
  return { ...interaction };
}

function sameInteractionOutcome(left, right) {
  return left.status === right.status &&
    left.prompt === right.prompt &&
    left.finalReport === right.finalReport &&
    left.reason === right.reason;
}

function eventFailure(event, reason, id) {
  return {
    kind: "interaction-failed",
    sessionId: event.sessionId,
    sequence: event.sequence,
    ...(id === undefined ? {} : { id }),
    reason,
  };
}

function inputFailure(value, reason) {
  const raw = isRecord(value) ? value : {};
  return {
    kind: "event-failed",
    ...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
    ...(Number.isSafeInteger(raw.sequence) ? { sequence: raw.sequence } : {}),
    reason,
  };
}

function makeState(internal) {
  const state = {
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

function cloneInternal(internal) {
  return {
    events: internal.events.slice(),
    fingerprints: new Set(internal.fingerprints),
    eventIds: new Map(internal.eventIds),
    sequenceFingerprints: new Map(internal.sequenceFingerprints),
    inputFailures: new Map(internal.inputFailures),
    nextOrder: internal.nextOrder,
  };
}

function assertState(state) {
  if (!isRecord(state) || state[INTERNAL_STATE] === undefined) {
    throw new TypeError("state must come from createContractState");
  }
}

function eventFingerprint(event) {
  const { eventId: _eventId, ...withoutEventId } = event;
  return JSON.stringify(withoutEventId);
}

function rawIdentity(value) {
  if (!isRecord(value)) {
    return typeof value;
  }
  return JSON.stringify([
    typeof value.kind === "string" ? value.kind : "unknown",
    typeof value.sessionId === "string" ? value.sessionId : "unknown",
    typeof value.sequence === "number" ? value.sequence : "unknown",
    typeof value.eventId === "string" ? value.eventId : "unknown",
    typeof (value.interactionId ?? value.id) === "string" ? value.interactionId ?? value.id : "unknown",
  ]);
}

function interactionKey(sessionId, interactionId) {
  return `${sessionId.length}:${sessionId}${interactionId.length}:${interactionId}`;
}

function candidateText(value) {
  if (value.textBlocks !== undefined) {
    if (!Array.isArray(value.textBlocks) || value.textBlocks.some((block) => typeof block !== "string")) {
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

function validateIdentifier(value, name, maxBytes) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  return value;
}

function validateIdentifierList(value, name, maxBytes) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  return value.map((item) => validateIdentifier(item, name, maxBytes));
}

function validateSequence(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ContractInputError("malformed-event", "sequence is invalid");
  }
  return value;
}

function validateShortText(value, name) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > 128) {
    throw new ContractInputError("malformed-event", `${name} is invalid`);
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class ContractInputError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractInputError";
    this.code = code;
  }
}
