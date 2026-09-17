import assert from "node:assert/strict";
import { test } from "node:test";
import { collectInteractions } from "./contract.mjs";

const sessionId = "33333333-3333-4333-8333-333333333333";
const promptId = "prompt-a";
const knownLimitation =
  "known-limitation: a non-continued Stop is committed before a sibling continuation can settle the turn";

test("[known limitation] sibling continuation must replace the observer's provisional Stop", () => {
  const result = collectInteractions([
    {
      kind: "prompt-submitted",
      session_id: sessionId,
      arrival_order: 1,
      prompt_id: promptId,
      prompt: "Prompt A",
    },
    {
      kind: "final-response",
      session_id: sessionId,
      arrival_order: 2,
      prompt_id: promptId,
      final_response: "Final Report A1",
    },
    {
      kind: "final-response",
      session_id: sessionId,
      arrival_order: 3,
      prompt_id: promptId,
      final_response: "Final Report A1",
      continuation_signals: { continued: true },
    },
    {
      kind: "final-response",
      session_id: sessionId,
      arrival_order: 4,
      prompt_id: promptId,
      final_response: "Final Report A2",
    },
  ]);

  assert.equal(
    result.interactions.some(({ final_response }) => final_response === "Final Report A1"),
    false,
    `${knownLimitation}; observed=${JSON.stringify(result.interactions)}`,
  );
  assert.deepEqual(
    result.interactions.map(({ prompt, final_response }) => ({ prompt, final_response })),
    [{ prompt: "Prompt A", final_response: "Final Report A2" }],
    knownLimitation,
  );
});
