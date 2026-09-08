import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readPluginEvent } from "@j1nn0/herdr-plugin-sdk";
import { createPluginEventFixture } from "@j1nn0/herdr-plugin-sdk/testing";
import { decideCompletion } from "../src/capture/completion.ts";

describe("decideCompletion", () => {
  test("returns a completion for a done pane-agent-status event", () => {
    const decision = decideCompletion(
      eventFromFixture({
        data: {
          pane_id: "w1G:p1",
          workspace_id: "w1G",
          agent_status: "done",
          agent: "claude",
        },
      }),
    );

    assert.deepEqual(decision, {
      kind: "completion",
      paneId: "w1G:p1",
      workspaceId: "w1G",
      agentKind: "claude",
    });
  });

  test("ignores a working event", () => {
    const decision = decideCompletion(eventFromFixture({ data: { agent_status: "working" } }));

    assert.deepEqual(decision, {
      kind: "ignored",
      reason: "ignored agent status working",
    });
  });

  test("ignores an event of a different kind", () => {
    const decision = decideCompletion(
      eventFromFixture({
        event: "pane_title_changed",
        data: { type: "pane_title_changed" },
      }),
    );

    assert.deepEqual(decision, {
      kind: "ignored",
      reason: "ignored event pane_title_changed",
    });
  });

  test("uses null when the agent field is absent", () => {
    const decision = decideCompletion(eventFromFixture({ data: { agent: undefined } }));

    assert.deepEqual(decision, {
      kind: "completion",
      paneId: "w1G:p4",
      workspaceId: "w1G",
      agentKind: null,
    });
  });
});

function eventFromFixture(overrides: Parameters<typeof createPluginEventFixture>[0] = {}) {
  const event = readPluginEvent({
    HERDR_PLUGIN_EVENT_JSON: JSON.stringify(createPluginEventFixture(overrides)),
  });
  if (event === null) {
    throw new Error("Expected the event fixture to produce an event.");
  }
  return event;
}
