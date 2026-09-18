import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectInteractions, MAX_TEXT_BYTES, normalizeEvent } from "./contract.mjs";

const sessionA = "11111111-1111-4111-8111-111111111111";
const sessionB = "22222222-2222-4222-8222-222222222222";

function prompt(session_id, arrival_order, value, extra = {}) {
  return {
    kind: "prompt-submitted",
    session_id,
    arrival_order,
    prompt: value,
    prompt_id: "turn-1",
    ...extra,
  };
}

function final(session_id, arrival_order, value, extra = {}) {
  return {
    kind: "final-response",
    session_id,
    arrival_order,
    final_response: value,
    prompt_id: "turn-1",
    ...extra,
  };
}

function failure(session_id, arrival_order, reason, extra = {}) {
  return {
    kind: "interaction-failed",
    session_id,
    arrival_order,
    reason,
    prompt_id: "turn-1",
    ...extra,
  };
}

describe("Claude collector pairing contract", () => {
  test("pairs two consecutive turns by session and arrival order", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "first"),
      final(sessionA, 2, "answer one"),
      prompt(sessionA, 3, "second", { prompt_id: "turn-2" }),
      final(sessionA, 4, "answer two", { prompt_id: "turn-2" }),
    ]);

    assert.deepEqual(
      result.interactions.map(({ prompt: text, final_response }) => ({ text, final_response })),
      [
        { text: "first", final_response: "answer one" },
        { text: "second", final_response: "answer two" },
      ],
    );
    assert.deepEqual(result.failures, []);
  });

  test("keeps duplicate and conflicting finals explicit", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "one"),
      final(sessionA, 2, "first final"),
      final(sessionA, 2, "first final"),
      final(sessionA, 3, "conflicting final"),
    ]);

    assert.equal(result.interactions.length, 1);
    assert.deepEqual(
      result.failures.map(({ reason }) => reason),
      ["duplicate-event", "conflicting-final"],
    );
  });

  test("reports a missing final without inventing completion", () => {
    const result = collectInteractions([prompt(sessionA, 1, "never answered")]);

    assert.equal(result.interactions.length, 0);
    assert.deepEqual(result.failures.map(({ reason }) => reason), ["missing-final"]);
  });

  test("does not complete a continued or interrupted turn", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "continue then cancel"),
      final(sessionA, 2, "intermediate", { stop_hook_active: true }),
      failure(sessionA, 3, "interrupted"),
    ]);

    assert.equal(result.interactions.length, 0);
    assert.deepEqual(
      result.failures.map(({ reason }) => reason),
      ["continued-stop", "interrupted"],
    );
  });

  test("sorts reordered delivery by recorded arrival, but rejects causal inversion", () => {
    const reordered = collectInteractions([
      final(sessionA, 2, "answer"),
      prompt(sessionA, 1, "prompt"),
    ]);
    assert.equal(reordered.interactions.length, 1);

    const inverted = collectInteractions([
      final(sessionA, 1, "too early"),
      prompt(sessionA, 2, "too late"),
    ]);
    assert.equal(inverted.interactions.length, 0);
    assert.deepEqual(inverted.failures.map(({ reason }) => reason), ["unmatched-final", "missing-final"]);
  });

  test("never assigns an unmatched final across sessions", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "A"),
      final(sessionB, 2, "B without prompt"),
      final(sessionA, 3, "A answer"),
    ]);

    assert.deepEqual(result.interactions.map(({ session_id }) => session_id), [sessionA]);
    assert.deepEqual(result.failures.map(({ reason }) => reason), ["unmatched-final"]);
  });

  test("preserves multiline Japanese and emoji text exactly", () => {
    const promptText = "見出し\n- 箇条書き 🚀\n最後の行";
    const responseText = "回答です\n絵文字 🧪 と日本語を保持";
    const result = collectInteractions([
      prompt(sessionA, 1, promptText),
      final(sessionA, 2, responseText),
    ]);

    assert.equal(result.interactions[0]?.prompt, promptText);
    assert.equal(result.interactions[0]?.final_response, responseText);
    assert.equal(normalizeEvent(final(sessionA, 2, responseText)).last_assistant_message, responseText);
  });

  test("rejects blocked, malformed, and oversized payloads without throwing", () => {
    const malformed = collectInteractions([
      prompt(sessionA, 1, "blocked", { blocked: true }),
      { kind: "final-response", session_id: sessionA, arrival_order: 2 },
      prompt(sessionA, 3, "x".repeat(MAX_TEXT_BYTES + 1)),
      { kind: "not-a-kind", session_id: sessionA, arrival_order: 4 },
    ]);

    assert.equal(malformed.interactions.length, 0);
    assert.deepEqual(
      malformed.failures.map(({ reason }) => reason).sort(),
      ["prompt-blocked", "malformed-event", "malformed-event", "malformed-event"].sort(),
    );
  });

  test("validates identifiers and signals before pairing", () => {
    assert.throws(
      () => normalizeEvent(prompt("bad\nidentifier", 1, "text")),
      /session_id contains invalid characters/,
    );
    assert.throws(
      () => normalizeEvent(final(sessionA, 1, "text", { continuation_signals: [] })),
      /continuation_signals must be an object/,
    );
  });

  test("requires an exact prompt_id match within the same session", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "first", { prompt_id: "prompt-a" }),
      final(sessionA, 2, "wrong turn", { prompt_id: "prompt-b" }),
      final(sessionA, 3, "right turn", { prompt_id: "prompt-a" }),
    ]);

    assert.deepEqual(result.interactions, [
      {
        kind: "interaction",
        session_id: sessionA,
        prompt_id: "prompt-a",
        prompt: "first",
        final_response: "right turn",
        prompt_arrival_order: 1,
        final_arrival_order: 3,
      },
    ]);
    assert.deepEqual(result.failures.map(({ reason }) => reason), ["prompt-id-mismatch"]);
  });

  test("reports missing prompt_id without falling back to session-only pairing", () => {
    const result = collectInteractions([
      prompt(sessionA, 1, "missing prompt id", { prompt_id: undefined }),
      final(sessionA, 2, "missing prompt id", { prompt_id: undefined }),
      prompt(sessionA, 3, "known prompt", { prompt_id: "known" }),
      final(sessionB, 4, "other session", { prompt_id: "known" }),
    ]);

    assert.equal(result.interactions.length, 0);
    assert.deepEqual(result.failures.map(({ reason }) => reason), [
      "missing-prompt-id",
      "missing-prompt-id",
      "unmatched-final",
      "missing-final",
    ]);
  });

  test("does not pair a final delivered before its prompt even when IDs match", () => {
    const result = collectInteractions([
      final(sessionA, 1, "too early", { prompt_id: "late" }),
      prompt(sessionA, 2, "too late", { prompt_id: "late" }),
    ]);

    assert.equal(result.interactions.length, 0);
    assert.deepEqual(result.failures.map(({ reason }) => reason), ["unmatched-final", "missing-final"]);
  });
});
