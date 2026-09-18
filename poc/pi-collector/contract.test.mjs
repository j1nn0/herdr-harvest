import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  collectInteractions,
  MAX_CANDIDATE_TEXT_BYTES,
  MAX_PROMPT_BYTES,
} from "./contract.mjs";

const sessionA = "pi-session-a";
const sessionB = "pi-session-b";

function prompt(sessionId, sequence, interactionId, text, extra = {}) {
  return {
    kind: "promptObserved",
    sessionId,
    sequence,
    interactionId,
    prompt: text,
    ...extra,
  };
}

function candidate(sessionId, sequence, interactionId, text, extra = {}) {
  return {
    kind: "assistantCandidate",
    sessionId,
    sequence,
    interactionId,
    role: "assistant",
    stopReason: "stop",
    text,
    ...extra,
  };
}

function candidateBlocks(sessionId, sequence, interactionId, textBlocks, extra = {}) {
  return {
    kind: "assistantCandidate",
    sessionId,
    sequence,
    interactionId,
    role: "assistant",
    stopReason: "stop",
    textBlocks,
    ...extra,
  };
}

function settled(sessionId, sequence, extra = {}) {
  return {
    kind: "settled",
    sessionId,
    sequence,
    ...extra,
  };
}

function interaction(result, id) {
  return result.interactions.find((value) => value.id === id);
}

describe("Pi collector interaction contract", () => {
  test("completes one prompt with the selected final report", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "Final A"),
      settled(sessionA, 3),
    ]);

    assert.deepEqual(result.interactions, [
      {
        id: "a-1",
        sessionId: sessionA,
        prompt: "Prompt A",
        finalReport: "Final A",
        status: "completed",
      },
    ]);
    assert.deepEqual(result.failures, []);
  });

  test("keeps a provisional candidate pending until agent settlement", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "Provisional A"),
    ]);

    assert.deepEqual(result.interactions, [
      {
        id: "a-1",
        sessionId: sessionA,
        prompt: "Prompt A",
        finalReport: null,
        status: "pending",
      },
    ]);
    assert.deepEqual(Object.keys(result.interactions[0]).sort(), [
      "finalReport",
      "id",
      "prompt",
      "sessionId",
      "status",
    ]);
  });

  test("pairs two consecutive prompts in one session", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      prompt(sessionA, 2, "a-2", "Prompt B"),
      candidate(sessionA, 3, "a-1", "Final A"),
      candidate(sessionA, 4, "a-2", "Final B"),
      settled(sessionA, 5),
    ]);

    assert.deepEqual(result.interactions.map(({ id, prompt: text, finalReport }) => ({ id, prompt: text, finalReport })), [
      { id: "a-1", prompt: "Prompt A", finalReport: "Final A" },
      { id: "a-2", prompt: "Prompt B", finalReport: "Final B" },
    ]);
    assert.ok(result.interactions.every(({ status }) => status === "completed"));
  });

  test("keeps two sessions isolated", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      prompt(sessionB, 2, "b-1", "Prompt B"),
      candidate(sessionA, 3, "a-1", "Final A"),
      candidate(sessionB, 4, "b-1", "Final B"),
      settled(sessionA, 5),
      settled(sessionB, 6),
    ]);

    assert.equal(interaction(result, "a-1")?.finalReport, "Final A");
    assert.equal(interaction(result, "b-1")?.finalReport, "Final B");
    assert.deepEqual(result.failures, []);
  });

  test("ignores tool and intermediate candidates before the final stop message", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "tool request", { stopReason: "toolUse" }),
      candidate(sessionA, 3, "a-1", "tool output", { role: "tool", stopReason: "tool" }),
      candidate(sessionA, 4, "a-1", "compaction marker", { stopReason: "compaction" }),
      candidate(sessionA, 5, "a-1", "Final A"),
      settled(sessionA, 6),
    ]);

    assert.equal(interaction(result, "a-1")?.finalReport, "Final A");
    assert.equal(interaction(result, "a-1")?.status, "completed");
    assert.deepEqual(result.failures, []);
  });

  test("selects the retry that succeeds immediately before settlement", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "Retry one"),
      candidate(sessionA, 3, "a-1", "Retry success"),
      settled(sessionA, 4),
    ]);

    assert.equal(interaction(result, "a-1")?.finalReport, "Retry success");
  });

  test("selects the final stop after a compaction continuation", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "Before compaction", { stopReason: "compaction" }),
      candidate(sessionA, 3, "a-1", "After compaction"),
      settled(sessionA, 4),
    ]);

    assert.equal(interaction(result, "a-1")?.finalReport, "After compaction");
  });

  test("pairs queued follow-ups from one settlement independently", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      prompt(sessionA, 2, "a-2", "Queued follow-up"),
      candidate(sessionA, 3, "a-1", "Final A"),
      candidate(sessionA, 4, "a-2", "Final follow-up"),
      settled(sessionA, 5),
    ]);

    assert.deepEqual(result.interactions.map(({ id, finalReport }) => ({ id, finalReport })), [
      { id: "a-1", finalReport: "Final A" },
      { id: "a-2", finalReport: "Final follow-up" },
    ]);
  });

  test("merges steering into the ongoing prompt segment without trimming", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Initial instruction", { input: "Original input" }),
      prompt(sessionA, 2, "a-1", "Steer text", { mode: "steer", input: "Ignored input" }),
      candidate(sessionA, 3, "a-1", "Final A"),
      settled(sessionA, 4),
    ]);

    assert.equal(interaction(result, "a-1")?.prompt, "Initial instruction\nSteer text");
    assert.equal(interaction(result, "a-1")?.finalReport, "Final A");
  });

  test("marks interrupted execution as failed", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "Partial answer"),
      { kind: "sessionEnded", sessionId: sessionA, sequence: 3, reason: "interrupted" },
    ]);

    assert.deepEqual(interaction(result, "a-1"), {
      id: "a-1",
      sessionId: sessionA,
      prompt: "Prompt A",
      finalReport: null,
      status: "failed",
      reason: "interrupted",
    });
  });

  test("marks an API failure as failed", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      { kind: "sessionEnded", sessionId: sessionA, sequence: 2, reason: "api-failure" },
    ]);

    assert.equal(interaction(result, "a-1")?.status, "failed");
    assert.equal(interaction(result, "a-1")?.reason, "api-failure");
    assert.equal(interaction(result, "a-1")?.finalReport, null);
  });

  test("does not complete a textless final", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidateBlocks(sessionA, 2, "a-1", []),
      settled(sessionA, 3),
    ]);

    assert.equal(interaction(result, "a-1")?.status, "failed");
    assert.equal(interaction(result, "a-1")?.reason, "textless-final");
    assert.equal(interaction(result, "a-1")?.finalReport, null);
  });

  for (const stopReason of ["error", "aborted", "length", "deferred"]) {
    test(`does not complete an unsupported ${stopReason} candidate`, () => {
      const result = collectInteractions([
        prompt(sessionA, 1, "a-1", "Prompt A"),
        candidate(sessionA, 2, "a-1", "Unsupported", { stopReason }),
        settled(sessionA, 3),
      ]);

      assert.equal(interaction(result, "a-1")?.status, "failed");
      assert.equal(interaction(result, "a-1")?.reason, stopReason);
    });
  }

  test("deduplicates repeated prompt, candidate, and settlement events", () => {
    const events = [
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "Final A"),
      settled(sessionA, 3),
    ];
    const result = collectInteractions([...events, ...events]);

    assert.equal(result.interactions.length, 1);
    assert.equal(interaction(result, "a-1")?.finalReport, "Final A");
    assert.deepEqual(result.failures, []);
  });

  test("reports conflicting settled outcomes without overwriting the first result", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", "Final A"),
      settled(sessionA, 3),
      settled(sessionA, 4, { outcome: "api-failure", interactionId: "a-1" }),
    ]);

    assert.equal(interaction(result, "a-1")?.status, "completed");
    assert.equal(interaction(result, "a-1")?.finalReport, "Final A");
    assert.ok(result.failures.some(({ reason }) => reason === "conflicting-settlement"));
  });

  test("reorders events by sequence and rejects events without a deterministic key", () => {
    const reordered = collectInteractions([
      settled(sessionA, 3),
      candidate(sessionA, 2, "a-1", "Final A"),
      prompt(sessionA, 1, "a-1", "Prompt A"),
    ]);
    assert.equal(interaction(reordered, "a-1")?.finalReport, "Final A");

    const missingSequence = collectInteractions([
      { kind: "promptObserved", sessionId: sessionA, interactionId: "a-1", prompt: "Prompt A" },
    ]);
    assert.deepEqual(missingSequence.interactions, []);
    assert.equal(missingSequence.failures[0]?.reason, "malformed-event");
  });

  test("supports a session switch and later resumption", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      prompt(sessionB, 2, "b-1", "Prompt B"),
      candidate(sessionB, 3, "b-1", "Final B"),
      settled(sessionB, 4),
      candidate(sessionA, 5, "a-1", "Final A after resume"),
      settled(sessionA, 6),
    ]);

    assert.equal(interaction(result, "a-1")?.finalReport, "Final A after resume");
    assert.equal(interaction(result, "b-1")?.finalReport, "Final B");
  });

  test("preserves multiline Japanese, Unicode, spaces, and final newlines exactly", () => {
    const promptText = "見出し\n- 継続 🚀\n末尾  ";
    const finalText = "回答です\n絵文字 🧪\n最後の行\n";
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", promptText),
      candidateBlocks(sessionA, 2, "a-1", ["回答です\n", "絵文字 🧪\n", "最後の行\n"]),
      settled(sessionA, 3),
    ]);

    assert.equal(interaction(result, "a-1")?.prompt, promptText);
    assert.equal(interaction(result, "a-1")?.finalReport, finalText);
  });

  test("stores the effective prompt after another extension transforms it", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Expanded effective prompt", {
        input: "Original pre-expansion prompt",
      }),
      candidate(sessionA, 2, "a-1", "Final A"),
      settled(sessionA, 3),
    ]);

    assert.equal(interaction(result, "a-1")?.prompt, "Expanded effective prompt");
    assert.equal(interaction(result, "a-1")?.prompt.includes("Original"), false);
  });

  test("stores the final text after another extension replaces the message", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidateBlocks(sessionA, 2, "a-1", ["Replacement final"], {
        originalTextBlocks: ["Original final"],
      }),
      settled(sessionA, 3),
    ]);

    assert.equal(interaction(result, "a-1")?.finalReport, "Replacement final");
  });

  test("does not pair rejected or handled input when no agent starts", () => {
    assert.deepEqual(collectInteractions([]).interactions, []);
    const handled = collectInteractions([
      { kind: "sessionEnded", sessionId: sessionA, sequence: 1, reason: "handled-input" },
    ]);
    assert.deepEqual(handled.interactions, []);
    assert.deepEqual(handled.failures, []);
  });

  test("rejects an oversized prompt without truncating or completing it", () => {
    const oversized = "p".repeat(MAX_PROMPT_BYTES + 1);
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", oversized),
      candidate(sessionA, 2, "a-1", "Should not complete"),
      settled(sessionA, 3),
    ]);

    assert.deepEqual(interaction(result, "a-1"), {
      id: "a-1",
      sessionId: sessionA,
      prompt: "",
      finalReport: null,
      status: "failed",
      reason: "oversized-prompt",
    });
    assert.equal(result.interactions.some(({ finalReport }) => finalReport === "Should not complete"), false);
  });

  test("rejects an oversized candidate without truncating or completing it", () => {
    const oversized = "c".repeat(MAX_CANDIDATE_TEXT_BYTES + 1);
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      candidate(sessionA, 2, "a-1", oversized),
      settled(sessionA, 3),
    ]);

    assert.equal(interaction(result, "a-1")?.status, "failed");
    assert.equal(interaction(result, "a-1")?.reason, "oversized-candidate");
    assert.equal(interaction(result, "a-1")?.finalReport, null);
  });

  test("marks a persistence write failure without inventing a final report", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "a-1", "Prompt A"),
      { kind: "writeFailed", sessionId: sessionA, sequence: 2, interactionId: "a-1", reason: "disk-full" },
    ]);

    assert.equal(interaction(result, "a-1")?.status, "failed");
    assert.equal(interaction(result, "a-1")?.reason, "write-failed");
    assert.equal(interaction(result, "a-1")?.finalReport, null);
  });
});
