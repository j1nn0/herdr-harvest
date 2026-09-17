import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PiInteractionInput } from "../src/domain/pi-interaction.ts";
import { MAX_PI_FINAL_REPORT_BYTES, MAX_PI_PROMPT_BYTES } from "../src/domain/pi-interaction.ts";
import {
  createPiCollectorExtension,
  type PiCollectorDiagnostic,
  type PiExtensionContext,
  sessionScopeId,
} from "../src/pi/observer.ts";

describe("Pi observer extension", () => {
  test("pairs the original input with the effective prompt and persists only after settlement", async () => {
    const harness = makeHarness();
    const context = makeContext("session-a", "/sessions/a.json");
    const inputText = "  original 日本語\n";
    const effectiveText = "expanded effective prompt\n";

    await harness.emit(
      "input",
      {
        type: "input",
        text: inputText,
        source: "interactive",
      },
      context,
    );
    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: effectiveText,
        images: [],
      },
      context,
    );
    await harness.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          id: "assistant-final-a",
          role: "assistant",
          stopReason: "stop",
          content: [
            { type: "thinking", thinking: "not persisted" },
            { type: "text", text: "FIRST_REPORT\n" },
            { type: "text", text: "二行目 🚀 " },
          ],
        },
      },
      context,
    );

    assert.deepEqual(harness.records, []);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.deepEqual(harness.records, [
      {
        interactionId: "interaction-1",
        sessionId: sessionScopeId(makeContext("session-a", "/sessions/a.json")) as string,
        submittedPrompt: inputText,
        effectivePrompt: effectiveText,
        finalReport: "FIRST_REPORT\n二行目 🚀 ",
        status: "completed",
        reason: null,
        provenance: "test-observer",
      },
    ]);
    assert.deepEqual(harness.handlers(), [
      "agent_settled",
      "before_agent_start",
      "input",
      "message_end",
      "session_shutdown",
    ]);
  });

  test("does not create an interaction when input is handled without an agent start", async () => {
    const harness = makeHarness();
    const context = makeContext("session-handled", "/sessions/handled.json");

    await harness.emit(
      "input",
      {
        type: "input",
        text: "handled command",
        source: "interactive",
        handled: true,
      },
      context,
    );
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.deepEqual(harness.records, []);
    assert.equal(harness.diagnostics.length, 0);
  });

  test("joins array-form input text with newlines without changing its parts", async () => {
    const harness = makeHarness();
    const context = makeContext("session-array-input", "/sessions/array-input.json");

    await harness.emit(
      "input",
      {
        type: "input",
        text: [
          { type: "text", text: "first" },
          { type: "text", text: "二つ目 " },
        ],
        source: "extension",
      },
      context,
    );
    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "effective array input",
      },
      context,
    );
    await harness.emit("message_end", finalMessage("array-input-message", "report"), context);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.equal(harness.records[0]?.submittedPrompt, "first\n二つ目 ");
  });

  test("fails closed when more than one original input is waiting for one before event", async () => {
    const harness = makeHarness();
    const context = makeContext("session-ambiguous", "/sessions/ambiguous.json");

    await harness.emit("input", { type: "input", text: "first", source: "interactive" }, context);
    await harness.emit("input", { type: "input", text: "second", source: "interactive" }, context);
    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "effective but ambiguous",
      },
      context,
    );
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.deepEqual(harness.records, []);
    assert.ok(hasDiagnostic(harness.diagnostics, "ambiguous-prompt-pairing"));
  });

  test("keeps interleaved sessions separate while refusing same-session ambiguity", async () => {
    const harness = makeHarness();
    const first = makeContext("session-interleave-a", "/sessions/interleave-a.json");
    const second = makeContext("session-interleave-b", "/sessions/interleave-b.json");

    await harness.emit("input", { type: "input", text: "A", source: "interactive" }, first);
    await harness.emit("input", { type: "input", text: "B", source: "interactive" }, second);
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "EA" }, first);
    await harness.emit("before_agent_start", { type: "before_agent_start", prompt: "EB" }, second);
    await harness.emit("message_end", finalMessage("A-message", "RA"), first);
    await harness.emit("message_end", finalMessage("B-message", "RB"), second);
    await harness.emit("agent_settled", { type: "agent_settled" }, first);
    await harness.emit("agent_settled", { type: "agent_settled" }, second);

    assert.deepEqual(
      harness.records.map((record) => [record.submittedPrompt, record.effectivePrompt]),
      [
        ["A", "EA"],
        ["B", "EB"],
      ],
    );
  });

  test("merges an observed steer into the ongoing segment and rejects direct steer/follow-up", async () => {
    const harness = makeHarness();
    const context = makeContext("session-steer", "/sessions/steer.json");

    await harness.emit("input", { type: "input", text: "base", source: "interactive" }, context);
    await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "expanded base" },
      context,
    );
    await harness.emit(
      "input",
      {
        type: "input",
        text: "steer text",
        source: "interactive",
        streamingBehavior: "steer",
      },
      context,
    );
    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "expanded steer",
      },
      context,
    );
    await harness.emit("message_end", finalMessage("steer-message", "steered report"), context);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.equal(harness.records.length, 1);
    assert.equal(harness.records[0]?.submittedPrompt, "base\nsteer text");
    assert.equal(harness.records[0]?.effectivePrompt, "expanded base\nexpanded steer");

    const directHarness = makeHarness();
    const directContext = makeContext("session-direct", "/sessions/direct.json");
    await directHarness.emit(
      "input",
      {
        type: "input",
        text: "direct steer",
        source: "rpc",
        streamingBehavior: "steer",
      },
      directContext,
    );
    await directHarness.emit(
      "input",
      {
        type: "input",
        text: "direct follow-up",
        source: "rpc",
        streamingBehavior: "followUp",
      },
      directContext,
    );
    assert.deepEqual(directHarness.records, []);
    assert.ok(hasDiagnostic(directHarness.diagnostics, "unsupported-direct-steer"));
    assert.ok(hasDiagnostic(directHarness.diagnostics, "unsupported-direct-follow-up"));
  });

  test("fails an image-attached prompt explicitly instead of storing text-only content", async () => {
    const harness = makeHarness();
    const context = makeContext("session-image", "/sessions/image.json");

    await harness.emit(
      "input",
      { type: "input", text: "describe this", source: "interactive" },
      context,
    );
    await harness.emit(
      "before_agent_start",
      {
        type: "before_agent_start",
        prompt: "describe this",
        images: [{ type: "image", data: "not persisted" }],
      },
      context,
    );
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.deepEqual(
      harness.records.map((record) => ({
        submittedPrompt: record.submittedPrompt,
        effectivePrompt: record.effectivePrompt,
        finalReport: record.finalReport,
        status: record.status,
        reason: record.reason,
      })),
      [
        {
          submittedPrompt: "describe this",
          effectivePrompt: "describe this",
          finalReport: null,
          status: "failed",
          reason: "unsupported-attachments",
        },
      ],
    );
  });

  test("does not persist at message_end or agent_end and waits for an idle settlement", async () => {
    const harness = makeHarness();
    const context = makeContext("session-settlement", "/sessions/settlement.json");

    await harness.emit("input", { type: "input", text: "prompt", source: "interactive" }, context);
    await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "effective" },
      context,
    );
    await harness.emit("message_end", finalMessage("settlement-message", "report"), context);
    await harness.emit("agent_end", { type: "agent_end", messages: [] }, context);
    assert.deepEqual(harness.records, []);

    context.idle = false;
    await harness.emit("agent_settled", { type: "agent_settled" }, context);
    assert.deepEqual(harness.records, []);

    context.idle = true;
    await harness.emit("agent_settled", { type: "agent_settled" }, context);
    const record = (harness.records as PiInteractionInput[])[0];
    if (record === undefined) {
      throw new Error("expected a settled interaction");
    }
    assert.equal(record.finalReport, "report");
  });

  test("turns an API error candidate into a failed terminal interaction at settlement", async () => {
    const harness = makeHarness();
    const context = makeContext("session-api-error", "/sessions/api-error.json");

    await harness.emit("input", { type: "input", text: "api error", source: "rpc" }, context);
    await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "api error" },
      context,
    );
    await harness.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          id: "api-error-message",
          role: "assistant",
          stopReason: "error",
          content: [{ type: "text", text: "provider error detail is not a report" }],
        },
      },
      context,
    );
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.equal(harness.records[0]?.status, "failed");
    assert.equal(harness.records[0]?.finalReport, null);
    assert.equal(harness.records[0]?.reason, "error");
  });

  test("reports an unmatched before event without inventing a prompt", async () => {
    const harness = makeHarness();
    const context = makeContext("session-unpaired", "/sessions/unpaired.json");

    await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "no original" },
      context,
    );

    assert.deepEqual(harness.records, []);
    assert.ok(hasDiagnostic(harness.diagnostics, "unpaired-before-agent-start"));
  });

  test("selects the last eligible stop candidate after retries and intermediate messages", async () => {
    const harness = makeHarness();
    const context = makeContext("session-retry", "/sessions/retry.json");

    await harness.emit(
      "input",
      { type: "input", text: "retry prompt", source: "interactive" },
      context,
    );
    await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "retry prompt" },
      context,
    );
    await harness.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          id: "tool-message",
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "text", text: "intermediate" }],
        },
      },
      context,
    );
    await harness.emit("message_end", finalMessage("retry-one", "first stop"), context);
    await harness.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          id: "aborted-message",
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "text", text: "partial" }],
        },
      },
      context,
    );
    await harness.emit("message_end", finalMessage("retry-two", "successful stop"), context);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.equal(harness.records[0]?.finalReport, "successful stop");
  });

  test("turns interrupted shutdown into a failed terminal interaction", async () => {
    const harness = makeHarness();
    const context = makeContext("session-shutdown", "/sessions/shutdown.json");

    await harness.emit(
      "input",
      { type: "input", text: "interrupt me", source: "interactive" },
      context,
    );
    await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "interrupt me" },
      context,
    );
    await harness.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          id: "aborted",
          role: "assistant",
          stopReason: "aborted",
          content: [{ type: "text", text: "partial" }],
        },
      },
      context,
    );
    await harness.emit("session_shutdown", { type: "session_shutdown" }, context);

    assert.deepEqual(
      harness.records.map((record) => ({
        finalReport: record.finalReport,
        status: record.status,
        reason: record.reason,
      })),
      [{ finalReport: null, status: "failed", reason: "session-ended" }],
    );
  });

  test("rejects oversized submitted and candidate text without truncating it", async () => {
    const inputHarness = makeHarness();
    const inputContext = makeContext("session-large-input", "/sessions/large-input.json");
    await inputHarness.emit(
      "input",
      {
        type: "input",
        text: "x".repeat(MAX_PI_PROMPT_BYTES + 1),
        source: "interactive",
      },
      inputContext,
    );
    await inputHarness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "effective" },
      inputContext,
    );
    await inputHarness.emit("agent_settled", { type: "agent_settled" }, inputContext);
    assert.equal(inputHarness.records[0]?.submittedPrompt, "");
    assert.equal(inputHarness.records[0]?.reason, "oversized-submitted-prompt");

    const candidateHarness = makeHarness();
    const candidateContext = makeContext(
      "session-large-candidate",
      "/sessions/large-candidate.json",
    );
    await candidateHarness.emit(
      "input",
      { type: "input", text: "prompt", source: "interactive" },
      candidateContext,
    );
    await candidateHarness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "effective" },
      candidateContext,
    );
    await candidateHarness.emit(
      "message_end",
      finalMessage("large-candidate", "x".repeat(MAX_PI_FINAL_REPORT_BYTES + 1)),
      candidateContext,
    );
    await candidateHarness.emit("agent_settled", { type: "agent_settled" }, candidateContext);
    assert.equal(candidateHarness.records[0]?.finalReport, null);
    assert.equal(candidateHarness.records[0]?.reason, "oversized-candidate");
  });

  test("fails closed for a conflicting replacement, while duplicate delivery is idempotent", async () => {
    const harness = makeHarness();
    const context = makeContext("session-events", "/sessions/events.json");

    await harness.emit("input", { type: "input", text: "prompt", source: "interactive" }, context);
    await harness.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "effective" },
      context,
    );
    const message = finalMessage("same-message", "report");
    await harness.emit("message_end", message, context);
    await harness.emit("message_end", message, context);
    await harness.emit("message_end", finalMessage("same-message", "changed"), context);
    await harness.emit("agent_settled", { type: "agent_settled" }, context);

    assert.equal(harness.records.length, 1);
    assert.equal(harness.records[0]?.finalReport, "report");
    assert.ok(hasDiagnostic(harness.diagnostics, "conflicting-event"));
  });

  test("never lets a writer or diagnostics failure escape into Pi", async () => {
    const diagnostics: PiCollectorDiagnostic[] = [];
    const pi = fakePi();
    createPiCollectorExtension({
      provenance: "test-observer",
      interactionId: () => "interaction-fail-open",
      writeInteraction: async () => {
        throw new Error("writer failure");
      },
      diagnostic: async (entry) => {
        diagnostics.push(entry);
        throw new Error("diagnostics failure");
      },
    })(pi);
    const context = makeContext("session-fail-open", "/sessions/fail-open.json");

    await assert.doesNotReject(async () => {
      await emitComplete(pi, context, "safe prompt", "safe report");
    });
    assert.ok(diagnostics.some((entry) => entry.code === "store-write"));
  });
});

function makeHarness() {
  const records: PiInteractionInput[] = [];
  const diagnostics: PiCollectorDiagnostic[] = [];
  const pi = fakePi();
  createPiCollectorExtension({
    provenance: "test-observer",
    interactionId: () => "interaction-1",
    writeInteraction: async (record) => {
      records.push({ ...record });
    },
    diagnostic: async (entry) => {
      diagnostics.push(entry);
    },
  })(pi);
  return {
    pi,
    records,
    diagnostics,
    emit: pi.emit,
    handlers: () => [...pi.handlers.keys()].sort(),
  };
}

function fakePi() {
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => unknown>();
  return {
    handlers,
    on(event: string, handler: (event: unknown, context: PiExtensionContext) => unknown) {
      handlers.set(event, handler);
    },
    async emit(event: string, payload: unknown, context: PiExtensionContext) {
      const handler = handlers.get(event);
      if (handler === undefined) {
        return undefined;
      }
      return handler(payload, context);
    },
  };
}

function makeContext(sessionId: string, sessionFile: string) {
  return {
    idle: true,
    isIdle() {
      return this.idle;
    },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getSessionFile() {
        return sessionFile;
      },
    },
  };
}

function finalMessage(id: string, text: string) {
  return {
    type: "message_end",
    message: {
      id,
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text }],
    },
  };
}

async function emitComplete(
  pi: ReturnType<typeof fakePi>,
  context: ReturnType<typeof makeContext>,
  prompt: string,
  report: string,
) {
  await pi.emit("input", { type: "input", text: prompt, source: "interactive" }, context);
  await pi.emit("before_agent_start", { type: "before_agent_start", prompt }, context);
  await pi.emit("message_end", finalMessage("complete-message", report), context);
  await pi.emit("agent_settled", { type: "agent_settled" }, context);
}

function hasDiagnostic(diagnostics: readonly PiCollectorDiagnostic[], code: string): boolean {
  return diagnostics.some((entry) => entry.code === code);
}
