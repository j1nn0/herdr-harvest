import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { createPiCollectorExtension } from "./extension.mjs";
import { readInteractions } from "./store.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("observer stores the effective prompt and the last stop text without registering controls", async () => {
  const root = await temporaryRoot();
  const pi = fakePi();
  createPiCollectorExtension({ root })(pi);
  const context = fakeContext("session-a", "/isolated/a.json");

  assert.deepEqual([...pi.handlers.keys()].sort(), [
    "agent_settled",
    "before_agent_start",
    "message_end",
    "session_shutdown",
  ]);

  await pi.emit("before_agent_start", {
    prompt: "  effective 日本語\n",
    input: "original input must not be used",
  }, context);
  await pi.emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", name: "not-persisted" }],
    },
  }, context);
  await pi.emit("message_end", {
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "not-persisted" },
        { type: "text", text: "FIRST" },
        { type: "text", text: "\n二行目 " },
      ],
    },
  }, context);
  await pi.emit("agent_settled", { type: "agent_settled" }, context);

  const records = await readInteractions(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].prompt, "  effective 日本語\n");
  assert.equal(records[0].finalReport, "FIRST\n二行目 ");
  assert.equal(records[0].status, "completed");
  assert.match(records[0].provenance, /^pi-observer/);
});

test("non-idle settlement remains provisional until an idle settlement", async () => {
  const root = await temporaryRoot();
  const pi = fakePi();
  createPiCollectorExtension({ root })(pi);
  const context = fakeContext("session-b", "/isolated/b.json");

  await pi.emit("before_agent_start", { prompt: "pending prompt" }, context);
  await pi.emit("message_end", {
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "pending report" }] },
  }, context);
  context.idle = false;
  await pi.emit("agent_settled", { type: "agent_settled" }, context);
  assert.deepEqual(await readInteractions(root), []);

  context.idle = true;
  await pi.emit("agent_settled", { type: "agent_settled" }, context);
  assert.equal((await readInteractions(root)).length, 1);
});

test("two sessions receive distinct opaque session and interaction identities", async () => {
  const root = await temporaryRoot();
  const pi = fakePi();
  createPiCollectorExtension({ root })(pi);
  const first = fakeContext("session-c", "/isolated/c.json");
  const second = fakeContext("session-d", "/isolated/d.json");

  await complete(pi, first, "prompt c", "report c");
  await complete(pi, second, "prompt d", "report d");
  await pi.emit("agent_settled", { type: "agent_settled" }, first);

  const records = await readInteractions(root);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].id, records[1].id);
  assert.notEqual(records[0].sessionId, records[1].sessionId);
  assert.deepEqual(records.map((record) => record.prompt), ["prompt c", "prompt d"]);
});

test("session shutdown fails an interrupted interaction without a report", async () => {
  const root = await temporaryRoot();
  const pi = fakePi();
  createPiCollectorExtension({ root })(pi);
  const context = fakeContext("session-e", "/isolated/e.json");

  await pi.emit("before_agent_start", { prompt: "interrupted" }, context);
  await pi.emit("message_end", {
    message: { role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "partial" }] },
  }, context);
  await pi.emit("session_shutdown", { type: "session_shutdown" }, context);

  assert.deepEqual((await readInteractions(root)).map((record) => ({
    prompt: record.prompt,
    finalReport: record.finalReport,
    status: record.status,
    reason: record.reason,
  })), [{
    prompt: "interrupted",
    finalReport: null,
    status: "failed",
    reason: "session-ended",
  }]);
});

async function complete(pi, context, prompt, report) {
  await pi.emit("before_agent_start", { prompt }, context);
  await pi.emit("message_end", {
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: report }] },
  }, context);
  await pi.emit("agent_settled", { type: "agent_settled" }, context);
}

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    async emit(event, payload, context) {
      const handler = handlers.get(event);
      assert.notEqual(handler, undefined, `missing handler for ${event}`);
      return handler(payload, context);
    },
  };
}

function fakeContext(sessionId, sessionFile) {
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

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-collector-extension-test-"));
  roots.push(root);
  return root;
}
