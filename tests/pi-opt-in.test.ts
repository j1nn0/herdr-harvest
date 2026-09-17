import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { PiInteractionInput } from "../src/domain/pi-interaction.ts";
import {
  installProductionPiCollectorExtension,
  type PiExtensionApi,
  type PiExtensionContext,
} from "../src/pi/observer.ts";

describe("Pi production opt-in", () => {
  for (const value of [undefined, "0", "invalid"]) {
    test(`does not install or transform when HARVEST_PI_COLLECT=${String(value)}`, () => {
      const pi = fakePi();
      const env: Record<string, string | undefined> = {
        HARVEST_STATE_DIR: "/private/not-used",
      };
      if (value !== undefined) {
        env.HARVEST_PI_COLLECT = value;
      }

      const result = installProductionPiCollectorExtension(pi, env);

      assert.equal(result, undefined);
      assert.deepEqual(pi.events, []);
    });
  }

  test("installs the observer when the explicit opt-in is enabled", () => {
    const pi = fakePi();

    installProductionPiCollectorExtension(
      pi,
      { HARVEST_PI_COLLECT: "1", HARVEST_STATE_DIR: "/private/not-used" },
      {
        writeInteraction: async () => undefined,
        diagnostic: async () => undefined,
      },
    );

    assert.deepEqual([...pi.events].sort(), [
      "agent_settled",
      "before_agent_start",
      "input",
      "message_end",
      "session_shutdown",
    ]);
  });

  test("enabled production installation reaches the terminal emission path", async () => {
    const pi = fakePi();
    const records: PiInteractionInput[] = [];
    installProductionPiCollectorExtension(
      pi,
      { HARVEST_PI_COLLECT: "1", HARVEST_STATE_DIR: "/private/not-used" },
      {
        interactionId: () => "opt-in-emission-id",
        writeInteraction: async (record) => {
          records.push(record);
        },
        diagnostic: async () => undefined,
      },
    );
    const context = makeContext();

    await pi.emit("input", { type: "input", text: "enabled prompt" }, context);
    await pi.emit(
      "before_agent_start",
      { type: "before_agent_start", prompt: "enabled effective" },
      context,
    );
    await pi.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          id: "opt-in-message",
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "enabled report" }],
        },
      },
      context,
    );
    await pi.emit("agent_settled", { type: "agent_settled" }, context);

    assert.equal(records.length, 1);
    assert.equal(records[0]?.submittedPrompt, "enabled prompt");
    assert.equal(records[0]?.finalReport, "enabled report");
  });
});

function fakePi(): PiExtensionApi & {
  events: string[];
  emit: (event: string, payload: unknown, context: PiExtensionContext) => Promise<unknown>;
} {
  const events: string[] = [];
  const handlers = new Map<string, (event: unknown, context: PiExtensionContext) => unknown>();
  return {
    events,
    on(event: string, handler: (event: unknown, context: PiExtensionContext) => unknown) {
      events.push(event);
      handlers.set(event, handler);
    },
    async emit(event: string, payload: unknown, context: PiExtensionContext) {
      return handlers.get(event)?.(payload, context);
    },
  };
}

function makeContext(): PiExtensionContext {
  return {
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "opt-in-session",
      getSessionFile: () => "/sessions/opt-in.json",
    },
  };
}
