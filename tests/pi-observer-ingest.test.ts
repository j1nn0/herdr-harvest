import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { openDatabase } from "../src/persistence/database.ts";
import { PiInteractionStore } from "../src/persistence/pi-interaction-store.ts";
import { createPiCollectorExtension, sessionScopeId } from "../src/pi/observer.ts";

test("the default observer writer sends terminal records through the local ingest binary", async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), "herdr-harvest-pi-observer-ingest-"));
  try {
    const pi = fakePi();
    createPiCollectorExtension({
      env: { ...process.env, HARVEST_STATE_DIR: stateDirectory, HARVEST_PI_COLLECT: "1" },
      interactionId: () => "observer-ingest-id",
      provenance: "observer-ingest-test",
    })(pi);
    const context = makeContext();

    await pi.emit("input", { type: "input", text: "submitted", source: "interactive" }, context);
    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "effective" },
      context,
    );
    await pi.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          id: "observer-ingest-message",
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "observed report" }],
        },
      },
      context,
    );
    await pi.emit("agent_settled", { type: "agent_settled" }, context);

    const db = openDatabase(join(stateDirectory, "harvest.db"));
    try {
      const store = new PiInteractionStore(db);
      const record = store.getByDedupKey(store.list()[0]?.dedupKey ?? "missing");
      assert.ok(record);
      assert.deepEqual(
        record && {
          interactionId: record.interactionId,
          sessionId: record.sessionId,
          submittedPrompt: record.submittedPrompt,
          effectivePrompt: record.effectivePrompt,
          finalReport: record.finalReport,
          status: record.status,
          reason: record.reason,
          provenance: record.provenance,
        },
        {
          interactionId: "observer-ingest-id",
          sessionId: sessionScopeId(context),
          submittedPrompt: "submitted",
          effectivePrompt: "effective",
          finalReport: "observed report",
          status: "completed",
          reason: null,
          provenance: "observer-ingest-test",
        },
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

function fakePi() {
  const handlers = new Map<
    string,
    (event: unknown, context: ReturnType<typeof makeContext>) => unknown
  >();
  return {
    on(
      event: string,
      handler: (event: unknown, context: ReturnType<typeof makeContext>) => unknown,
    ) {
      handlers.set(event, handler);
    },
    async emit(event: string, payload: unknown, context: ReturnType<typeof makeContext>) {
      return handlers.get(event)?.(payload, context);
    },
  };
}

function makeContext() {
  return {
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "observer-ingest-session",
      getSessionFile: () => "/sessions/observer-ingest.json",
    },
  };
}
