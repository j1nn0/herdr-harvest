import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  type AgentSessionHeader,
  buildInboxGrouping,
  type InboxDisplayRow,
  type OrchestrationHeader,
  type ResultRow,
} from "../src/app/inbox-groups.ts";
import type { InboxItem } from "../src/app/inbox-service.ts";

const ORCHESTRATION_A = "2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50";
const ORCHESTRATION_B = "3f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50";

function makeItem(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id,
    agentLabel: `agent-${id}`,
    sessionShortId: `short-${id}`,
    agentSessionKind: "id",
    agentSessionValue: `native-${id}`,
    orchestrationId: null,
    orchestrationLabel: null,
    orchestrationRole: null,
    workspaceLabel: "workspace",
    herdrSessionLabel: "default",
    paneLabel: `pane-${id}`,
    capturedAtMs: 1_000,
    preview: `preview-${id}`,
    unread: true,
    archived: false,
    ...overrides,
  };
}

function orchestrationHeaders(rows: readonly InboxDisplayRow[]): OrchestrationHeader[] {
  return rows.filter((row): row is OrchestrationHeader => row.kind === "orchestration");
}

function sessionHeaders(rows: readonly InboxDisplayRow[]): AgentSessionHeader[] {
  return rows.filter((row): row is AgentSessionHeader => row.kind === "agent-session");
}

function resultRows(rows: readonly InboxDisplayRow[]): ResultRow[] {
  return rows.filter((row): row is ResultRow => row.kind === "result");
}

describe("inbox grouping", () => {
  test("groups one orchestration by native session and counts the visible subset", () => {
    const items = [
      makeItem("a1", {
        orchestrationId: ORCHESTRATION_A,
        orchestrationLabel: "Explore parser",
        orchestrationRole: "explorer",
        agentSessionKind: "id",
        agentSessionValue: "session-a",
      }),
      makeItem("a2", {
        orchestrationId: ORCHESTRATION_A,
        orchestrationLabel: "Explore parser",
        orchestrationRole: "explorer",
        agentSessionKind: "id",
        agentSessionValue: "session-a",
      }),
      makeItem("a3", {
        orchestrationId: ORCHESTRATION_A,
        orchestrationLabel: "Explore parser",
        orchestrationRole: "explorer",
        agentSessionKind: "path",
        agentSessionValue: "/tmp/session-b.jsonl",
      }),
    ];

    const rows = buildInboxGrouping(items);

    assert.deepEqual(
      rows.map((row) => row.kind),
      ["orchestration", "agent-session", "result", "result", "agent-session", "result"],
    );
    assert.deepEqual(orchestrationHeaders(rows)[0], {
      kind: "orchestration",
      orchestrationId: ORCHESTRATION_A,
      orchestrationLabel: "Explore parser",
      orchestrationRole: "explorer",
      count: 3,
    });
    assert.deepEqual(
      sessionHeaders(rows).map(({ agentSessionKind, agentSessionValue, count }) => ({
        agentSessionKind,
        agentSessionValue,
        count,
      })),
      [
        { agentSessionKind: "id", agentSessionValue: "session-a", count: 2 },
        { agentSessionKind: "path", agentSessionValue: "/tmp/session-b.jsonl", count: 1 },
      ],
    );
    assert.deepEqual(
      resultRows(rows).map((row) => row.item.id),
      ["a1", "a2", "a3"],
    );
  });

  test("keeps orchestration groups separate and stable across interleaved input", () => {
    const rows = buildInboxGrouping([
      makeItem("standalone-first"),
      makeItem("b1", {
        orchestrationId: ORCHESTRATION_B,
        orchestrationLabel: "same label",
        orchestrationRole: "fixer",
        agentSessionValue: "session-b",
      }),
      makeItem("a1", {
        orchestrationId: ORCHESTRATION_A,
        orchestrationLabel: "same label",
        orchestrationRole: "explorer",
        agentSessionValue: "session-a",
      }),
      makeItem("b2", {
        orchestrationId: ORCHESTRATION_B,
        orchestrationLabel: "same label",
        orchestrationRole: "fixer",
        agentSessionValue: "session-b",
      }),
      makeItem("standalone-last"),
      makeItem("a2", {
        orchestrationId: ORCHESTRATION_A,
        orchestrationLabel: "same label",
        orchestrationRole: "explorer",
        agentSessionValue: "session-a",
      }),
    ]);

    assert.deepEqual(
      rows.map((row) => row.kind),
      [
        "result",
        "orchestration",
        "agent-session",
        "result",
        "result",
        "orchestration",
        "agent-session",
        "result",
        "result",
        "result",
      ],
    );
    assert.deepEqual(
      orchestrationHeaders(rows).map(({ orchestrationId, orchestrationLabel, count }) => ({
        orchestrationId,
        orchestrationLabel,
        count,
      })),
      [
        { orchestrationId: ORCHESTRATION_B, orchestrationLabel: "same label", count: 2 },
        { orchestrationId: ORCHESTRATION_A, orchestrationLabel: "same label", count: 2 },
      ],
    );
    assert.deepEqual(
      resultRows(rows).map((row) => row.item.id),
      ["standalone-first", "b1", "b2", "a1", "a2", "standalone-last"],
    );
  });

  test("uses the full native session key and keeps missing sessions separate", () => {
    const rows = buildInboxGrouping([
      makeItem("id-session", {
        orchestrationId: ORCHESTRATION_A,
        sessionShortId: "same-id",
        agentSessionKind: "id",
        agentSessionValue: "same-native-value",
      }),
      makeItem("path-session", {
        orchestrationId: ORCHESTRATION_A,
        sessionShortId: "same-id",
        agentSessionKind: "path",
        agentSessionValue: "same-native-value",
      }),
      makeItem("missing-one", {
        orchestrationId: ORCHESTRATION_A,
        sessionShortId: "same-id",
        agentSessionKind: null,
        agentSessionValue: null,
      }),
      makeItem("missing-two", {
        orchestrationId: ORCHESTRATION_A,
        sessionShortId: "same-id",
        agentSessionKind: null,
        agentSessionValue: null,
      }),
      makeItem("empty-value", {
        orchestrationId: ORCHESTRATION_A,
        agentSessionKind: "id",
        agentSessionValue: "",
      }),
    ]);

    assert.deepEqual(
      sessionHeaders(rows).map(
        ({ agentSessionKind, agentSessionValue, sessionShortId, count }) => ({
          agentSessionKind,
          agentSessionValue,
          sessionShortId,
          count,
        }),
      ),
      [
        {
          agentSessionKind: "id",
          agentSessionValue: "same-native-value",
          sessionShortId: "same-id",
          count: 1,
        },
        {
          agentSessionKind: "path",
          agentSessionValue: "same-native-value",
          sessionShortId: "same-id",
          count: 1,
        },
        { agentSessionKind: null, agentSessionValue: null, sessionShortId: "same-id", count: 1 },
        { agentSessionKind: null, agentSessionValue: null, sessionShortId: "same-id", count: 1 },
        {
          agentSessionKind: "id",
          agentSessionValue: "",
          sessionShortId: "short-empty-value",
          count: 1,
        },
      ],
    );
    assert.deepEqual(
      resultRows(rows).map((row) => row.item.id),
      ["id-session", "path-session", "missing-one", "missing-two", "empty-value"],
    );
  });

  test("renders the first available role without throwing on mixed roles", () => {
    const rows = buildInboxGrouping([
      makeItem("first", {
        orchestrationId: ORCHESTRATION_A,
        orchestrationLabel: "mixed role task",
        orchestrationRole: "explorer",
      }),
      makeItem("second", {
        orchestrationId: ORCHESTRATION_A,
        orchestrationLabel: "mixed role task",
        orchestrationRole: "fixer",
      }),
    ]);

    assert.equal(orchestrationHeaders(rows)[0]?.orchestrationRole, "explorer");
    assert.equal(orchestrationHeaders(rows)[0]?.count, 2);
  });

  test("leaves ungrouped results as standalone rows", () => {
    const items = [makeItem("one"), makeItem("two", { agentSessionValue: "same-session" })];

    const rows = buildInboxGrouping(items);

    assert.deepEqual(
      rows,
      items.map((item): ResultRow => ({ kind: "result", item })),
    );
  });
});
