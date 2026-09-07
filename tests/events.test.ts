import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decodeAgentStatusEvent } from "../src/events/decode.ts";

describe("decodeAgentStatusEvent", () => {
  test("decodes a done payload as a completion", () => {
    const decoded = decodeAgentStatusEvent(
      JSON.stringify({
        event: "pane.agent_status_changed",
        data: {
          type: "pane_agent_status_changed",
          pane_id: "w1G:p1",
          workspace_id: "w1G",
          agent_status: "done",
          agent: "claude",
        },
      }),
    );

    assert.deepEqual(decoded, {
      kind: "completion",
      paneId: "w1G:p1",
      workspaceId: "w1G",
      agentKind: "claude",
    });
  });

  for (const status of ["working", "idle", "blocked", "unknown"]) {
    test(`ignores the ${status} status`, () => {
      const decoded = decodeAgentStatusEvent(eventFor({ agent_status: status }));
      assert.equal(decoded.kind, "ignored");
      if (decoded.kind === "ignored") {
        assert.match(decoded.reason, new RegExp(status));
      }
    });
  }

  test("ignores a different event type", () => {
    const decoded = decodeAgentStatusEvent(
      eventFor({ type: "pane_title_changed", agent_status: "done" }),
    );
    assert.equal(decoded.kind, "ignored");
  });

  test("rejects malformed payloads without throwing", () => {
    const malformed: Array<string | undefined> = [
      undefined,
      "",
      "   ",
      "not json",
      "[]",
      "{}",
      JSON.stringify({ data: {} }),
      eventFor({ agent_status: "done", pane_id: undefined }),
    ];

    for (const raw of malformed) {
      let decoded: ReturnType<typeof decodeAgentStatusEvent> | undefined;
      assert.doesNotThrow(() => {
        decoded = decodeAgentStatusEvent(raw);
      });
      assert.equal(decoded?.kind, "malformed", `expected malformed result for ${String(raw)}`);
    }
  });

  test("uses null for absent workspace and agent fields", () => {
    const decoded = decodeAgentStatusEvent(
      JSON.stringify({ data: { agent_status: "done", pane_id: "w1G:p1" } }),
    );

    assert.deepEqual(decoded, {
      kind: "completion",
      paneId: "w1G:p1",
      workspaceId: null,
      agentKind: null,
    });
  });
});

function eventFor(data: Record<string, unknown>): string {
  return JSON.stringify({
    event: "pane.agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: "w1G:p1",
      workspace_id: "w1G",
      agent_status: "done",
      agent: "claude",
      ...data,
    },
  });
}
