import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CodexContractEvent,
  CodexContractState,
  CodexPromptObservedEvent,
  CodexReportObservedEvent,
  CodexTurnCommittedEvent,
} from "../src/codex/collector-contract.ts";
import {
  applyCodexContractEvent,
  CODEX_NATIVE_HOOKS_PROVENANCE,
  codexInteractionId,
  codexInteractionKey,
  createCodexContractState,
  MAX_CODEX_FINAL_REPORT_BYTES,
  MAX_CODEX_PROMPT_BYTES,
  normalizeNotifyPayload,
  normalizeStopPayload,
  normalizeSubmitPayload,
} from "../src/codex/collector-contract.ts";

test("commits exactly the matching provisional report after notify", () => {
  let state = createCodexContractState();
  state = apply(state, prompt("session-success", "turn-success", "  prompt\n")).state;
  const beforeCommit = apply(state, report("session-success", "turn-success", "report")).state;
  assert.deepEqual(beforeCommit.completed, []);

  const result = apply(beforeCommit, commit("session-success", "turn-success", "report"));
  assert.deepEqual(result.emitted, [
    {
      interactionId: codexInteractionId("session-success", "turn-success"),
      sessionId: "session-success",
      submittedPrompt: "  prompt\n",
      finalReport: "report",
      status: "completed",
      provenance: CODEX_NATIVE_HOOKS_PROVENANCE,
    },
  ]);
  assert.deepEqual(result.state.pending, []);
  assert.equal(result.state.failures.length, 0);
});

test("does not complete until notify and persists the last Stop report", () => {
  let state = createCodexContractState();
  state = apply(state, prompt("session-continuation", "turn-continuation", "prompt")).state;
  state = apply(state, report("session-continuation", "turn-continuation", "A1")).state;
  assert.deepEqual(state.completed, []);
  state = apply(state, report("session-continuation", "turn-continuation", "A2")).state;

  const result = apply(state, commit("session-continuation", "turn-continuation", "A2"));
  assert.equal(result.emitted[0]?.finalReport, "A2");
  assert.equal(result.state.completed[0]?.finalReport, "A2");
});

test("veto without notify remains pending until an explicit stale sweep", () => {
  let state = createCodexContractState();
  state = apply(state, prompt("session-veto", "turn-veto", "prompt")).state;
  state = apply(state, report("session-veto", "turn-veto", "provisional")).state;
  const result = apply(state, { kind: "sweep", nowMs: 10_001, maxAgeMs: 10_000 });

  assert.deepEqual(result.discardedKeys, [codexInteractionKey("session-veto", "turn-veto")]);
  assert.deepEqual(result.state.completed, []);
  assert.deepEqual(result.state.pending, []);
});

test("duplicate prompt, Stop, and notify deliveries are idempotent", () => {
  let state = createCodexContractState();
  const p = prompt("session-duplicates", "turn-duplicates", "prompt");
  const r = report("session-duplicates", "turn-duplicates", "report");
  const c = commit("session-duplicates", "turn-duplicates", "report");
  state = apply(state, p).state;
  state = apply(state, p).state;
  state = apply(state, r).state;
  state = apply(state, r).state;
  const firstCommit = apply(state, c);
  const secondCommit = apply(firstCommit.state, c);

  assert.equal(firstCommit.emitted.length, 1);
  assert.deepEqual(secondCommit.emitted, []);
  assert.equal(secondCommit.state.completed.length, 1);
  assert.deepEqual(secondCommit.state.failures, []);
});

test("rejects a conflicting prompt without overwriting the first prompt", () => {
  let state = createCodexContractState();
  state = apply(state, prompt("session-conflict", "turn-conflict", "first")).state;
  const result = apply(state, prompt("session-conflict", "turn-conflict", "second"));

  assert.equal(result.failure?.reason, "conflicting-prompt");
  assert.equal(result.state.pending[0]?.submittedPrompt, "first");
});

test("correlates a Stop observed before its prompt", () => {
  let state = createCodexContractState();
  state = apply(state, report("session-order", "turn-order", "report")).state;
  state = apply(state, prompt("session-order", "turn-order", "prompt")).state;
  const result = apply(state, commit("session-order", "turn-order", "report"));

  assert.equal(result.emitted.length, 1);
  assert.equal(result.emitted[0]?.submittedPrompt, "prompt");
});

test("rejects notify with no prompt, no provisional, or no pending key", () => {
  let state = createCodexContractState();
  state = apply(state, report("session-missing-prompt", "turn-missing-prompt", "report")).state;
  const missingPrompt = apply(
    state,
    commit("session-missing-prompt", "turn-missing-prompt", "report"),
  );
  assert.equal(missingPrompt.failure?.reason, "missing-prompt");
  assert.deepEqual(missingPrompt.emitted, []);

  state = createCodexContractState();
  state = apply(state, prompt("session-missing-report", "turn-missing-report", "prompt")).state;
  const missingReport = apply(
    state,
    commit("session-missing-report", "turn-missing-report", "report"),
  );
  assert.equal(missingReport.failure?.reason, "missing-provisional");

  const orphan = apply(
    createCodexContractState(),
    commit("session-orphan", "turn-orphan", "report"),
  );
  assert.equal(orphan.failure?.reason, "orphan-notify");
});

test("rejects a notify report that differs from the latest Stop report", () => {
  let state = createCodexContractState();
  state = apply(state, prompt("session-mismatch", "turn-mismatch", "prompt")).state;
  state = apply(state, report("session-mismatch", "turn-mismatch", "Stop report")).state;
  const result = apply(state, commit("session-mismatch", "turn-mismatch", "different report"));

  assert.equal(result.failure?.reason, "report-mismatch");
  assert.deepEqual(result.emitted, []);
  assert.deepEqual(result.state.completed, []);
});

test("normalizers reject subagent, agent-bearing, and failed Stop payloads", () => {
  const subagent = normalizeSubmitPayload({
    hook_event_name: "SubagentStop",
    session_id: "session-normalize",
    turn_id: "turn-normalize",
    prompt: "prompt",
  });
  assert.equal(subagent.ok, false);
  if (!subagent.ok) {
    assert.equal(subagent.failure.reason, "subagent-event");
  }

  const agentBearing = normalizeSubmitPayload({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-normalize",
    turn_id: "turn-normalize",
    prompt: "prompt",
    agent_id: "child",
  });
  assert.equal(agentBearing.ok, false);
  if (!agentBearing.ok) {
    assert.equal(agentBearing.failure.reason, "agent-event");
  }

  const failedStop = normalizeStopPayload({
    hook_event_name: "Stop",
    session_id: "session-normalize",
    turn_id: "turn-normalize",
    last_assistant_message: "report",
    failed: true,
  });
  assert.equal(failedStop.ok, false);
  if (!failedStop.ok) {
    assert.equal(failedStop.failure.reason, "failed");
  }
});

test("normalizers preserve exact prompt/report text and accept an empty Stop report", () => {
  const submittedPrompt = "  \nこんにちは 🌊\t\n";
  const submit = normalizeSubmitPayload({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-exact",
    turn_id: "turn-exact",
    prompt: submittedPrompt,
  });
  assert.equal(submit.ok, true);
  if (submit.ok) {
    assert.equal(submit.event.submittedPrompt, submittedPrompt);
  }

  const stop = normalizeStopPayload({
    hook_event_name: "Stop",
    session_id: "session-exact",
    turn_id: "turn-exact",
    last_assistant_message: "",
  });
  assert.equal(stop.ok, true);
  if (stop.ok) {
    assert.equal(stop.event.provisionalReport, "");
  }

  const notify = normalizeNotifyPayload(
    {
      type: "agent-turn-complete",
      "turn-id": "turn-exact",
      "last-assistant-message": "  report\nこんにちは 🌊",
    },
    "session-exact",
  );
  assert.equal(notify.ok, true);
  if (notify.ok) {
    assert.equal(notify.event.sessionId, "session-exact");
    assert.equal(notify.event.finalReport, "  report\nこんにちは 🌊");
  }
});

test("notify uses an optional opaque thread-id when no adapter session id is supplied", () => {
  const notify = normalizeNotifyPayload({
    type: "agent-turn-complete",
    "thread-id": "opaque-thread",
    "turn-id": "turn-thread",
    "last-assistant-message": "report",
  });

  assert.equal(notify.ok, true);
  if (notify.ok) {
    assert.equal(notify.event.sessionId, "opaque-thread");
  }
});

test("sweep discards stale prompt-only and report-only pending records by key", () => {
  let state = createCodexContractState();
  state = apply(state, prompt("session-stale", "turn-prompt", "prompt")).state;
  state = apply(state, report("session-stale", "turn-report", "report")).state;
  const result = apply(state, { kind: "sweep", nowMs: 101, maxAgeMs: 100 });

  assert.deepEqual(
    result.discardedKeys,
    [
      codexInteractionKey("session-stale", "turn-prompt"),
      codexInteractionKey("session-stale", "turn-report"),
    ].sort(),
  );
  assert.deepEqual(result.state.pending, []);
  assert.deepEqual(result.state.completed, []);
});

test("rejects oversized prompt and report payloads without retaining bodies", () => {
  const oversizedPrompt = normalizeSubmitPayload({
    hook_event_name: "UserPromptSubmit",
    session_id: "session-large",
    turn_id: "turn-large",
    prompt: "x".repeat(MAX_CODEX_PROMPT_BYTES + 1),
  });
  assert.equal(oversizedPrompt.ok, false);
  if (!oversizedPrompt.ok) {
    assert.deepEqual(oversizedPrompt.failure, {
      reason: "oversized-prompt",
      sessionId: "session-large",
      turnId: "turn-large",
    });
  }

  const oversizedReport = normalizeStopPayload({
    hook_event_name: "Stop",
    session_id: "session-large",
    turn_id: "turn-large",
    last_assistant_message: "x".repeat(MAX_CODEX_FINAL_REPORT_BYTES + 1),
  });
  assert.equal(oversizedReport.ok, false);
  if (!oversizedReport.ok) {
    assert.deepEqual(oversizedReport.failure, {
      reason: "oversized-report",
      sessionId: "session-large",
      turnId: "turn-large",
    });
  }
});

test("keeps sessions isolated when turn ids are reused", () => {
  let state = createCodexContractState();
  state = apply(state, prompt("session-a", "same-turn", "prompt-a")).state;
  state = apply(state, prompt("session-b", "same-turn", "prompt-b")).state;
  state = apply(state, report("session-a", "same-turn", "report-a")).state;
  state = apply(state, report("session-b", "same-turn", "report-b")).state;
  state = apply(state, commit("session-b", "same-turn", "report-b")).state;
  const result = apply(state, commit("session-a", "same-turn", "report-a"));

  assert.deepEqual(result.state.completed.map((item) => item.submittedPrompt).sort(), [
    "prompt-a",
    "prompt-b",
  ]);
  assert.equal(result.state.failures.length, 0);
});

function apply(state: CodexContractState, event: CodexContractEvent) {
  return applyCodexContractEvent(state, event);
}

function prompt(
  sessionId: string,
  turnId: string,
  submittedPrompt: string,
): CodexPromptObservedEvent {
  return { kind: "promptObserved", sessionId, turnId, submittedPrompt };
}

function report(
  sessionId: string,
  turnId: string,
  provisionalReport: string,
): CodexReportObservedEvent {
  return { kind: "reportObserved", sessionId, turnId, provisionalReport };
}

function commit(sessionId: string, turnId: string, finalReport: string): CodexTurnCommittedEvent {
  return { kind: "turnCommitted", sessionId, turnId, finalReport };
}
