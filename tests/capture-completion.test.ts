import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readPluginEvent } from "@j1nn0/herdr-plugin-sdk";
import { createPluginEventFixture } from "@j1nn0/herdr-plugin-sdk/testing";
import { decideCompletion, shouldCaptureCompletion } from "../src/capture/completion.ts";

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
      agentStatus: "done",
    });
  });

  test("ignores a working event", () => {
    const decision = decideCompletion(eventFromFixture({ data: { agent_status: "working" } }));

    assert.deepEqual(decision, {
      kind: "ignored",
      reason: "ignored agent status working",
    });
  });

  test("returns an idle event as a completion candidate with its status", () => {
    assert.deepEqual(
      decideCompletion(eventFromFixture({ data: { agent_status: "idle", agent: undefined } })),
      {
        kind: "completion",
        paneId: "w1G:p4",
        workspaceId: "w1G",
        agentKind: null,
        agentStatus: "idle",
      },
    );
  });

  test("classifies every non-completion status without making it a candidate", () => {
    for (const agentStatus of ["working", "blocked", "unknown"]) {
      assert.deepEqual(
        decideCompletion(eventFromFixture({ data: { agent_status: agentStatus } })),
        { kind: "ignored", reason: `ignored agent status ${agentStatus}` },
      );
    }
  });

  test("applies the persisted lifecycle decision rule", () => {
    const cases: Array<{
      name: string;
      candidateStatus: string;
      previousStatus: string | null;
      capture: boolean;
    }> = [
      {
        name: "startup idle with no previous state",
        candidateStatus: "idle",
        previousStatus: null,
        capture: false,
      },
      {
        name: "startup idle after unknown",
        candidateStatus: "idle",
        previousStatus: "unknown",
        capture: false,
      },
      {
        name: "working then idle",
        candidateStatus: "idle",
        previousStatus: "working",
        capture: true,
      },
      {
        name: "working then done",
        candidateStatus: "done",
        previousStatus: "working",
        capture: true,
      },
      { name: "done duplicate", candidateStatus: "done", previousStatus: "done", capture: false },
      {
        name: "blocked then idle",
        candidateStatus: "idle",
        previousStatus: "blocked",
        capture: false,
      },
      {
        name: "working incoming",
        candidateStatus: "working",
        previousStatus: null,
        capture: false,
      },
      {
        name: "blocked incoming",
        candidateStatus: "blocked",
        previousStatus: "working",
        capture: false,
      },
      {
        name: "unknown incoming",
        candidateStatus: "unknown",
        previousStatus: "idle",
        capture: false,
      },
    ];

    for (const lifecycleCase of cases) {
      assert.equal(
        shouldCaptureCompletion(lifecycleCase.candidateStatus, lifecycleCase.previousStatus),
        lifecycleCase.capture,
        lifecycleCase.name,
      );
    }
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
      agentStatus: "done",
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
