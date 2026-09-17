import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyPiContractEvent,
  collectPiInteractions,
  createPiContractState,
} from "../src/pi/collector-contract.ts";

test("reorders causally keyed events and completes only after the settled event", () => {
  const state = collectPiInteractions([
    settled("session-order", 4, "interaction-order"),
    candidate("session-order", 3, "interaction-order", "ordered report", "candidate-order"),
    prompt("session-order", 2, "interaction-order", "effective order"),
    input("session-order", 1, "ordered prompt"),
  ]);

  assert.deepEqual(state.interactions, [
    {
      interactionId: "interaction-order",
      sessionId: "session-order",
      submittedPrompt: "ordered prompt",
      effectivePrompt: "effective order",
      finalReport: "ordered report",
      status: "completed",
      reason: null,
    },
  ]);
  assert.deepEqual(state.failures, []);
});

test("deduplicates one event id and reports a conflicting replacement without overwriting", () => {
  let state = createPiContractState();
  state = applyPiContractEvent(state, input("session-events", 1, "prompt")).state;
  state = applyPiContractEvent(
    state,
    prompt("session-events", 2, "interaction-events", "effective"),
  ).state;
  const first = candidate("session-events", 3, "interaction-events", "original", "same-message");
  state = applyPiContractEvent(state, first).state;
  state = applyPiContractEvent(state, { ...first, sequence: 30 }).state;
  state = applyPiContractEvent(
    state,
    candidate("session-events", 4, "interaction-events", "replacement", "same-message"),
  ).state;
  state = applyPiContractEvent(state, settled("session-events", 5, "interaction-events")).state;

  assert.equal(state.interactions[0]?.finalReport, "original");
  assert.ok(state.failures.some((failure) => failure.reason === "conflicting-event"));
});

test("keeps unsupported final candidates transient and emits a failed terminal result", () => {
  const state = collectPiInteractions([
    input("session-final", 1, "prompt"),
    prompt("session-final", 2, "interaction-final", "effective"),
    candidate("session-final", 3, "interaction-final", "", "textless", "stop"),
    settled("session-final", 4, "interaction-final"),
  ]);

  assert.deepEqual(state.interactions[0], {
    interactionId: "interaction-final",
    sessionId: "session-final",
    submittedPrompt: "prompt",
    effectivePrompt: "effective",
    finalReport: null,
    status: "failed",
    reason: "textless-final",
  });
});

function input(sessionId: string, sequence: number, submittedPrompt: string) {
  return {
    kind: "inputObserved" as const,
    sessionId,
    sequence,
    submittedPrompt,
    mode: "new" as const,
  };
}

function prompt(
  sessionId: string,
  sequence: number,
  interactionId: string,
  effectivePrompt: string,
) {
  return {
    kind: "promptObserved" as const,
    sessionId,
    sequence,
    interactionId,
    effectivePrompt,
  };
}

function candidate(
  sessionId: string,
  sequence: number,
  interactionId: string,
  text: string,
  eventId: string,
  stopReason = "stop",
) {
  return {
    kind: "assistantCandidate" as const,
    sessionId,
    sequence,
    eventId,
    interactionId,
    role: "assistant",
    stopReason,
    text,
  };
}

function settled(sessionId: string, sequence: number, interactionId: string) {
  return {
    kind: "settled" as const,
    sessionId,
    sequence,
    interactionIds: [interactionId],
    outcome: "success",
  };
}
