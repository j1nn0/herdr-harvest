import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  installProductionPiCollectorExtension,
  type PiExtensionApi,
  type PiExtensionContext,
} from "../src/pi/observer.ts";

describe("Pi production opt-in", () => {
  test("does not install any observer handlers when collection is disabled", () => {
    const pi = fakePi();

    installProductionPiCollectorExtension(pi, {
      HARVEST_PI_COLLECT: "0",
      HARVEST_STATE_DIR: "/private/not-used",
    });

    assert.deepEqual(pi.events, []);
  });

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
});

function fakePi(): PiExtensionApi & { events: string[] } {
  const events: string[] = [];
  return {
    events,
    on(event: string, _handler: (event: unknown, context: PiExtensionContext) => unknown) {
      events.push(event);
    },
  };
}
