import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseReadOutput, parseTargetInfo, parseWorkspaceLabel } from "../src/herdr/cli-client.ts";
import { HerdrCliError } from "../src/herdr/types.ts";

describe("Herdr CLI parsers", () => {
  test("maps the agent get response, including native session identity", () => {
    const parsed = parseTargetInfo(agentGetJson(), "agent");

    assert.deepEqual(parsed, {
      paneId: "w1G:p2",
      tabId: "w1G:t1",
      workspaceId: "w1G",
      agentName: "explorer",
      agentKind: "pi",
      agentStatus: "idle",
      paneName: "π - herdr-harvest",
      session: {
        kind: "path",
        value: "/Users/jinno/.pi/agent/sessions/01a07a0d.jsonl",
      },
    });
  });

  test("maps pane get responses without an agent name", () => {
    const parsed = parseTargetInfo(paneGetJson(), "pane");

    assert.deepEqual(parsed, {
      paneId: "w1G:p1",
      tabId: "w1G:t1",
      workspaceId: "w1G",
      agentName: null,
      agentKind: "claude",
      agentStatus: "done",
      paneName: "terminal title",
      session: null,
    });
  });

  for (const [key, code, id] of [
    ["agent", "agent_not_found", "cli:agent:get"],
    ["pane", "pane_not_found", "cli:pane:get"],
  ] as const) {
    test(`returns null for ${code}`, () => {
      assert.equal(
        parseTargetInfo(JSON.stringify({ error: { code, message: "gone" }, id }), key),
        null,
      );
    });
  }

  test("throws a HerdrCliError with a non-not-found error code", () => {
    assert.throws(
      () =>
        parseTargetInfo(
          JSON.stringify({ error: { code: "ui_busy", message: "try again" }, id: "cli:agent:get" }),
          "agent",
        ),
      (error: unknown) => error instanceof HerdrCliError && error.code === "ui_busy",
    );
  });

  test("preserves raw read output that begins with a brace", () => {
    const raw = "{capture output}\n\n世界 🚀  \n";
    assert.equal(parseReadOutput(raw), raw);
  });

  test("preserves valid JSON read output without error and id keys", () => {
    const raw = JSON.stringify({ message: "terminal output", lines: ["one", "two"] });
    assert.equal(parseReadOutput(raw), raw);
  });

  test("throws a HerdrCliError for a read error envelope", () => {
    assert.throws(
      () =>
        parseReadOutput(
          JSON.stringify({
            error: { code: "pane_not_found", message: "pane is gone" },
            id: "cli:pane:read",
          }),
        ),
      (error: unknown) => error instanceof HerdrCliError && error.code === "pane_not_found",
    );
  });

  test("finds workspace labels and returns null for unknown ids", () => {
    const stdout = JSON.stringify({
      id: "cli:workspace:list",
      result: {
        workspaces: [
          { workspace_id: "w1G", label: "herdr-harvest" },
          { workspace_id: "w2G", label: "other" },
        ],
      },
    });

    assert.equal(parseWorkspaceLabel(stdout, "w1G"), "herdr-harvest");
    assert.equal(parseWorkspaceLabel(stdout, "missing"), null);
  });
});

function agentGetJson(): string {
  return JSON.stringify({
    id: "cli:agent:get",
    result: {
      agent: {
        agent: "pi",
        agent_session: {
          agent: "pi",
          kind: "path",
          source: "herdr:pi",
          value: "/Users/jinno/.pi/agent/sessions/01a07a0d.jsonl",
        },
        agent_status: "idle",
        cwd: "/Users/jinno/Repos/herdr-harvest",
        focused: false,
        name: "explorer",
        pane_id: "w1G:p2",
        revision: 1,
        state_change_seq: 66,
        tab_id: "w1G:t1",
        terminal_id: "term_65adcc33752f7e",
        terminal_title: "π - herdr-harvest",
        terminal_title_stripped: "π - herdr-harvest",
        workspace_id: "w1G",
      },
      type: "agent_info",
    },
  });
}

function paneGetJson(): string {
  return JSON.stringify({
    id: "cli:pane:get",
    result: {
      pane: {
        agent: "claude",
        agent_status: "done",
        agent_session: null,
        pane_id: "w1G:p1",
        tab_id: "w1G:t1",
        terminal_title_stripped: "terminal title",
        workspace_id: "w1G",
        scroll: { offset: 0 },
      },
      type: "pane_info",
    },
  });
}
