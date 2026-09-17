import { Buffer } from "node:buffer";

export const MAX_SESSION_ID_BYTES = 128;
export const MAX_TEXT_BYTES = 64 * 1024;

const EVENT_KINDS = new Set([
  "prompt-submitted",
  "final-response",
  "interaction-failed",
]);

/**
 * Validate the small event contract used by the observer hooks and collector.
 * The returned object is a new value, so callers never mutate hook input.
 */
export function normalizeEvent(value) {
  if (!isRecord(value)) {
    throw new Error("event must be an object");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) {
    throw new Error("event kind is unknown");
  }
  const sessionId = validateSessionId(value.session_id);
  const arrivalOrder = validateArrivalOrder(value.arrival_order);
  const eventId = value.event_id === undefined ? undefined : validateEventId(value.event_id);

  if (kind === "prompt-submitted") {
    return {
      kind,
      session_id: sessionId,
      arrival_order: arrivalOrder,
      ...(eventId === undefined ? {} : { event_id: eventId }),
      prompt_id: validateOptionalPromptId(value.prompt_id),
      prompt: validateText(value.prompt, "prompt"),
      blocked: value.blocked === true,
    };
  }

  if (kind === "final-response") {
    const finalResponse =
      value.last_assistant_message === undefined
        ? value.final_response
        : value.last_assistant_message;
    if (
      value.last_assistant_message !== undefined &&
      value.final_response !== undefined &&
      value.last_assistant_message !== value.final_response
    ) {
      throw new Error("final response fields conflict");
    }
    const signals = normalizeSignals(value.continuation_signals);
    return {
      kind,
      session_id: sessionId,
      arrival_order: arrivalOrder,
      ...(eventId === undefined ? {} : { event_id: eventId }),
      prompt_id: validateOptionalPromptId(value.prompt_id),
      last_assistant_message: validateText(finalResponse, "last_assistant_message"),
      final_response: validateText(finalResponse, "final_response"),
      stop_hook_active: value.stop_hook_active === true,
      continuation_signals: signals,
      interrupted: value.interrupted === true,
    };
  }

  return {
    kind,
    session_id: sessionId,
    arrival_order: arrivalOrder,
    ...(eventId === undefined ? {} : { event_id: eventId }),
    prompt_id: validateOptionalPromptId(value.prompt_id),
    reason: validateReason(value.reason),
    ...(value.prompt_arrival_order === undefined
      ? {}
      : { prompt_arrival_order: validateArrivalOrder(value.prompt_arrival_order) }),
  };
}

/**
 * Pair only an unblocked prompt followed by a non-continued final response
 * with the same session_id and prompt_id. Results are intentionally
 * body-bearing in memory; presentation/reporting code must use summaries or
 * hashes instead.
 */
export function collectInteractions(events) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array");
  }

  const accepted = [];
  const rejected = [];
  for (const [index, value] of events.entries()) {
    try {
      accepted.push({ event: normalizeEvent(value), input_index: index });
    } catch (error) {
      rejected.push({
        kind: "interaction-failed",
        reason: "malformed-event",
        input_index: index,
        detail: error instanceof Error ? error.message : "invalid event",
      });
    }
  }

  accepted.sort((left, right) =>
    left.event.arrival_order === right.event.arrival_order
      ? left.input_index - right.input_index
      : left.event.arrival_order - right.event.arrival_order,
  );

  const seenIds = new Set();
  const seenFingerprints = new Set();
  const sessions = new Map();
  const interactions = [];
  const failures = [...rejected];

  for (const { event } of accepted) {
    const duplicateKey = duplicateKeyFor(event);
    if (
      (event.event_id !== undefined && seenIds.has(event.event_id)) ||
      seenFingerprints.has(duplicateKey)
    ) {
      failures.push(failureFor(event, "duplicate-event"));
      continue;
    }
    if (event.event_id !== undefined) {
      seenIds.add(event.event_id);
    }
    seenFingerprints.add(duplicateKey);

    const session = sessions.get(event.session_id) ?? {
      pending: [],
      completedPromptIds: new Set(),
    };
    sessions.set(event.session_id, session);

    if (event.kind === "prompt-submitted") {
      if (event.prompt_id === undefined) {
        failures.push(failureFor(event, "missing-prompt-id"));
      } else if (event.blocked) {
        failures.push(failureFor(event, "prompt-blocked"));
      } else {
        session.pending.push(event);
      }
      continue;
    }

    if (event.kind === "interaction-failed") {
      const pending =
        event.prompt_id === undefined
          ? undefined
          : takePending(session, event.arrival_order, event.prompt_arrival_order, event.prompt_id);
      failures.push(
        failureFor(
          event,
          pending === undefined ? "unmatched-failure" : event.reason,
          pending,
          event.prompt_id === undefined ? "missing-prompt-id" : undefined,
        ),
      );
      continue;
    }

    if (event.interrupted) {
      const pending =
        event.prompt_id === undefined
          ? undefined
          : takePending(session, event.arrival_order, undefined, event.prompt_id);
      failures.push(
        failureFor(
          event,
          "interrupted",
          pending,
          event.prompt_id === undefined
            ? "missing-prompt-id"
            : pending === undefined && hasPendingBefore(session, event.arrival_order)
              ? "prompt-id-mismatch"
              : undefined,
        ),
      );
      continue;
    }

    if (isContinued(event)) {
      failures.push(
        failureFor(event, "continued-stop", undefined, event.prompt_id === undefined ? "missing-prompt-id" : undefined),
      );
      continue;
    }

    if (event.prompt_id === undefined) {
      failures.push(failureFor(event, "missing-prompt-id"));
      continue;
    }

    const pending = takePending(session, event.arrival_order, undefined, event.prompt_id);
    if (pending === undefined) {
      failures.push(
        failureFor(
          event,
          session.completedPromptIds.has(event.prompt_id)
            ? "conflicting-final"
            : hasPendingBefore(session, event.arrival_order)
              ? "prompt-id-mismatch"
              : "unmatched-final",
        ),
      );
      continue;
    }
    interactions.push({
      kind: "interaction",
      session_id: event.session_id,
      prompt: pending.prompt,
      final_response: event.final_response,
      prompt_id: event.prompt_id,
      prompt_arrival_order: pending.arrival_order,
      final_arrival_order: event.arrival_order,
    });
    session.completedPromptIds.add(event.prompt_id);
  }

  for (const session of sessions.values()) {
    for (const pending of session.pending) {
      failures.push(failureFor(pending, "missing-final"));
    }
  }

  return { interactions, failures };
}

export function isContinued(event) {
  return (
    event.stop_hook_active === true ||
    event.continuation_signals?.continued === true ||
    event.continuation_signals?.continue === true ||
    event.continuation_signals?.decision === "continue"
  );
}

function takePending(session, finalArrivalOrder, requestedArrivalOrder, requestedPromptId) {
  const index = session.pending.findIndex(
    (prompt) =>
      prompt.arrival_order < finalArrivalOrder &&
      (requestedArrivalOrder === undefined || prompt.arrival_order === requestedArrivalOrder) &&
      (requestedPromptId === undefined || prompt.prompt_id === requestedPromptId),
  );
  return index < 0 ? undefined : session.pending.splice(index, 1)[0];
}

function hasPendingBefore(session, arrivalOrder) {
  return session.pending.some((prompt) => prompt.arrival_order < arrivalOrder);
}

function failureFor(event, reason, pending, correlationReason) {
  return {
    kind: "interaction-failed",
    session_id: event.session_id,
    reason,
    arrival_order: event.arrival_order,
    ...(event.prompt_id === undefined ? {} : { prompt_id: event.prompt_id }),
    ...(correlationReason === undefined ? {} : { correlation_reason: correlationReason }),
    ...(pending === undefined ? {} : { prompt_arrival_order: pending.arrival_order }),
  };
}

function duplicateKeyFor(event) {
  return JSON.stringify([
    event.kind,
    event.session_id,
    event.arrival_order,
    event.event_id,
    event.prompt_id,
    event.prompt,
    event.final_response,
    event.reason,
  ]);
}

function normalizeSignals(value) {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("continuation_signals must be an object");
  }
  return {
    ...(value.continued === true ? { continued: true } : {}),
    ...(value.continue === true ? { continue: true } : {}),
    ...(value.decision === "continue" ? { decision: "continue" } : {}),
  };
}

function validateSessionId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_SESSION_ID_BYTES) {
    throw new Error("session_id is invalid");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_SESSION_ID_BYTES || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("session_id contains invalid characters");
  }
  return value;
}

function validateEventId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error("event_id is invalid");
  }
  return value;
}

function validateOptionalPromptId(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error("prompt_id is invalid");
  }
  if (Buffer.byteLength(value, "utf8") > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("prompt_id contains invalid characters");
  }
  return value;
}

function validateArrivalOrder(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("arrival_order is invalid");
  }
  return value;
}

function validateText(value, name) {
  if (typeof value !== "string") {
    throw new Error(`${name} is not text`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES || value.includes("\u0000")) {
    throw new Error(`${name} is oversized or invalid`);
  }
  return value;
}

function validateReason(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new Error("reason is invalid");
  }
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
