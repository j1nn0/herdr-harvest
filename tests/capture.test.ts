import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Agent, HerdrClient } from "@j1nn0/herdr-plugin-sdk";
import { HerdrCliError, HerdrProcessError } from "@j1nn0/herdr-plugin-sdk";
import {
  createAgentFixture,
  createMockHerdrClient,
  createPaneFixture,
  createWorkspaceFixture,
} from "@j1nn0/herdr-plugin-sdk/testing";
import type { CaptureDeps, CaptureOutcome } from "../src/capture/orchestrator.ts";
import { captureCompletion } from "../src/capture/orchestrator.ts";
import type { HarvestConfig } from "../src/config/config.ts";
import type { OrchestrationClaim } from "../src/domain/orchestration.ts";
import type { HarvestResult } from "../src/domain/result.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";

const CONFIG: HarvestConfig = {
  captureLines: 120,
  captureSource: "detection",
  databasePath: ":memory:",
  herdrSessionKey: "/tmp/herdr/sessions/nightly/herdr.sock",
  herdrSessionLabel: "nightly",
};

const AGENT_INFO = createAgentFixture({
  pane_id: "w1G:p1",
  tab_id: "w1G:t1",
  workspace_id: "w1G",
  agent: "pi",
  agent_status: "done",
  name: "explorer",
  terminal_title_stripped: "π - herdr-harvest",
  agent_session: {
    agent: "pi",
    kind: "path",
    source: "test",
    value: "/tmp/native-session.jsonl",
  },
});

const PANE_INFO = createPaneFixture({
  pane_id: "w1G:pane",
  tab_id: "w1G:t2",
  workspace_id: "w1G",
  agent: "claude",
  agent_status: "done",
  terminal_title_stripped: "pane title",
  agent_session: null,
});

const WORKSPACE = createWorkspaceFixture({
  workspace_id: "w1G",
  label: "Harvest Workspace",
});

describe("captureCompletion", () => {
  test("prefers agent metadata, resolves the workspace, and preserves captured text", async () => {
    const rawText = "first line  \n\n世界 🚀\ntrailing\t  ";
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": rawText },
      workspaces: [WORKSPACE],
    });
    const { store, close } = makeStore();

    try {
      const result = capturedResult(await runCapture(client, store));

      assert.deepEqual(
        {
          paneId: result.paneId,
          tabId: result.tabId,
          workspaceId: result.workspaceId,
          workspaceName: result.workspaceName,
          agentName: result.agentName,
          agentKind: result.agentKind,
          paneName: result.paneName,
          agentSessionKind: result.agentSessionKind,
          agentSessionValue: result.agentSessionValue,
          herdrSessionKey: result.herdrSessionKey,
          herdrSessionLabel: result.herdrSessionLabel,
          captureSource: result.captureSource,
          requestedLineCount: result.requestedLineCount,
          rawText: result.rawText,
        },
        {
          paneId: "w1G:p1",
          tabId: "w1G:t1",
          workspaceId: "w1G",
          workspaceName: "Harvest Workspace",
          agentName: "explorer",
          agentKind: "pi",
          paneName: "π - herdr-harvest",
          agentSessionKind: "path",
          agentSessionValue: "/tmp/native-session.jsonl",
          herdrSessionKey: "/tmp/herdr/sessions/nightly/herdr.sock",
          herdrSessionLabel: "nightly",
          captureSource: "detection",
          requestedLineCount: 120,
          rawText,
        },
      );
      assert.deepEqual(client.calls, [
        { operation: "agent.get", target: "w1G:p1", options: null },
        {
          operation: "agent.read",
          target: "w1G:p1",
          options: { source: "detection", lines: 120 },
        },
        { operation: "workspace.list", target: null, options: null },
      ]);
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("passes a high requested line count through to Herdr unchanged", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "small capture" },
    });
    const { store, close } = makeStore();

    try {
      const result = capturedResult(
        await runCapture(client, store, "w1G:p1", undefined, {
          ...CONFIG,
          captureLines: 5000,
        }),
      );

      assert.equal(result.requestedLineCount, 5000);
      assert.deepEqual(
        client.calls.filter((call) => call.operation === "agent.read"),
        [
          {
            operation: "agent.read",
            target: "w1G:p1",
            options: { source: "detection", lines: 5000 },
          },
        ],
      );
    } finally {
      close();
    }
  });

  test("returns duplicate on a repeated capture and leaves one row", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "same completion" },
    });
    const { store, close } = makeStore();

    try {
      const first = await runCapture(client, store);
      const second = await runCapture(client, store);

      assert.equal(first.status, "captured");
      assert.equal(second.status, "duplicate");
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("falls back to pane metadata when agent.get reports agent_not_found", async () => {
    const client = createMockHerdrClient({
      panes: { "w1G:pane": PANE_INFO },
      agentReads: { "w1G:pane": "pane capture" },
    });
    const { store, close } = makeStore();

    try {
      const result = capturedResult(await runCapture(client, store, "w1G:pane"));

      assert.equal(result.paneId, "w1G:pane");
      assert.equal(result.tabId, "w1G:t2");
      assert.equal(result.agentName, null);
      assert.equal(result.agentKind, "claude");
      assert.equal(result.paneName, "pane title");
      assert.equal(result.agentSessionKind, null);
      assert.equal(result.agentSessionValue, null);
      assert.deepEqual(client.calls.slice(0, 2), [
        { operation: "agent.get", target: "w1G:pane", options: null },
        { operation: "pane.get", target: "w1G:pane", options: null },
      ]);
    } finally {
      close();
    }
  });

  test("skips a pane that is absent from both lookups", async () => {
    const client = createMockHerdrClient();
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.deepEqual(outcome, { status: "skipped", reason: "pane no longer exists" });
      assert.equal(store.list({ includeArchived: true }).length, 0);
      assert.deepEqual(client.calls, [
        { operation: "agent.get", target: "w1G:p1", options: null },
        { operation: "pane.get", target: "w1G:p1", options: null },
      ]);
    } finally {
      close();
    }
  });

  test("surfaces an unexpected agent lookup error instead of treating it as not-found", async () => {
    const client = createMockHerdrClient({
      agents: {
        "w1G:p1": processError("agent.get", ["agent", "get", "w1G:p1"], "Herdr is unavailable"),
      },
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") {
        assert.match(outcome.reason, /HerdrProcessError/);
      }
      assert.equal(store.list({ includeArchived: true }).length, 0);
      assert.deepEqual(client.calls, [{ operation: "agent.get", target: "w1G:p1", options: null }]);
    } finally {
      close();
    }
  });

  test("does not call pane.read after a successful agent.read", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "agent output" },
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.equal(outcome.status, "captured");
      assert.equal(
        client.calls.some((call) => call.operation === "pane.read"),
        false,
      );
      assert.deepEqual(
        client.calls.filter(
          (call) => call.operation === "agent.read" || call.operation === "pane.read",
        ),
        [
          {
            operation: "agent.read",
            target: "w1G:p1",
            options: { source: "detection", lines: 120 },
          },
        ],
      );
    } finally {
      close();
    }
  });

  test("falls back to pane.read when agent.read fails and forwards exact options", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: {
        "w1G:p1": cliError("agent_read_failed", "agent output unavailable", "agent.read", [
          "agent",
          "read",
          "w1G:p1",
        ]),
      },
      paneReads: { "w1G:p1": "pane fallback output" },
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.equal(outcome.status, "captured");
      assert.deepEqual(
        client.calls.filter(
          (call) => call.operation === "agent.read" || call.operation === "pane.read",
        ),
        [
          {
            operation: "agent.read",
            target: "w1G:p1",
            options: { source: "detection", lines: 120 },
          },
          {
            operation: "pane.read",
            target: "w1G:p1",
            options: { source: "detection", lines: 120 },
          },
        ],
      );
      assert.equal(store.list({ includeArchived: true })[0]?.rawText, "pane fallback output");
    } finally {
      close();
    }
  });

  test("fails without writing when both reads fail and names both causes", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: {
        "w1G:p1": cliError("agent_read_failed", "agent read failed", "agent.read", [
          "agent",
          "read",
          "w1G:p1",
        ]),
      },
      paneReads: {
        "w1G:p1": cliError("pane_read_failed", "pane read failed", "pane.read", [
          "pane",
          "read",
          "w1G:p1",
        ]),
      },
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") {
        assert.match(outcome.reason, /agent_read_failed/);
        assert.match(outcome.reason, /pane_read_failed/);
      }
      assert.equal(store.list({ includeArchived: true }).length, 0);
    } finally {
      close();
    }
  });

  for (const rawText of ["", " \t\n\r\n  "]) {
    test(`skips an ${rawText.length === 0 ? "empty" : "whitespace-only"} capture`, async () => {
      const client = createMockHerdrClient({
        agents: { "w1G:p1": AGENT_INFO },
        agentReads: { "w1G:p1": rawText },
      });
      const { store, close } = makeStore();

      try {
        const outcome = await runCapture(client, store);

        assert.deepEqual(outcome, { status: "skipped", reason: "empty capture" });
        assert.equal(store.list({ includeArchived: true }).length, 0);
      } finally {
        close();
      }
    });
  }

  test("keeps a workspace list failure best effort", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "workspace lookup failure is harmless" },
      workspaces: processError("workspace.list", ["workspace", "list"], "workspace list failed"),
    });
    const { store, close } = makeStore();

    try {
      const result = capturedResult(await runCapture(client, store));

      assert.equal(result.workspaceName, null);
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("preserves a large raw payload byte-for-byte", async () => {
    const rawText = `${"日本語 🚀\n".repeat(8_000)}終端\t  `;
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": rawText },
    });
    const { store, close } = makeStore();

    try {
      const result = capturedResult(await runCapture(client, store));

      assert.equal(result.rawText, rawText);
    } finally {
      close();
    }
  });

  test("deduplicates identical content for the same native session", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "native session output" },
    });
    const { store, close } = makeStore();

    try {
      const first = await runCapture(client, store);
      const second = await runCapture(client, store);

      assert.equal(first.status, "captured");
      assert.equal(second.status, "duplicate");
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("uses pane identity when native session identity is absent", async () => {
    const client = createMockHerdrClient({
      agents: {
        "w1G:p1": noSessionInfo("w1G:p1"),
        "w1G:p2": noSessionInfo("w1G:p2"),
      },
      agentReads: {
        "w1G:p1": "pane-scoped output",
        "w1G:p2": "pane-scoped output",
      },
    });
    const { store, close } = makeStore();

    try {
      const first = await runCapture(client, store, "w1G:p1");
      const second = await runCapture(client, store, "w1G:p2");
      const third = await runCapture(client, store, "w1G:p1");

      assert.equal(first.status, "captured");
      assert.equal(second.status, "captured");
      assert.equal(third.status, "duplicate");
      assert.equal(store.list({ includeArchived: true }).length, 2);
    } finally {
      close();
    }
  });

  test("deduplicates concurrent captures against one store", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "racing output" },
    });
    const { store, close } = makeStore();

    try {
      const outcomes = await Promise.all([runCapture(client, store), runCapture(client, store)]);

      assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["captured", "duplicate"]);
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("claims a fresh capture for an orchestration task", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "claimed output" },
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store, "w1G:p1", CLAIM);
      assert.equal(outcome.status, "captured");
      if (outcome.status !== "captured") {
        throw new Error("Expected a captured outcome.");
      }
      assert.deepEqual(outcome.orchestration, { status: "claimed", id: CLAIM.id });
      assert.equal(outcome.result.orchestrationId, CLAIM.id);
      assert.equal(outcome.result.orchestrationLabel, CLAIM.label);
      assert.equal(outcome.result.orchestrationRole, CLAIM.role);
    } finally {
      close();
    }
  });

  test("reports an idempotent claim when the same capture repeats", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "claimed output" },
    });
    const { store, close } = makeStore();

    try {
      const first = await runCapture(client, store, "w1G:p1", CLAIM);
      const second = await runCapture(client, store, "w1G:p1", CLAIM);

      assert.equal(first.status, "captured");
      assert.equal(second.status, "duplicate");
      if (second.status !== "duplicate") {
        throw new Error("Expected a duplicate outcome.");
      }
      assert.deepEqual(second.orchestration, { status: "already_claimed", id: CLAIM.id });
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("reports a conflict when another task already claimed the content", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "claimed output" },
    });
    const { store, close } = makeStore();

    try {
      await runCapture(client, store, "w1G:p1", CLAIM);
      const lost = await runCapture(client, store, "w1G:p1", RIVAL);

      assert.equal(lost.status, "conflict");
      if (lost.status !== "conflict") {
        throw new Error("Expected a conflict outcome.");
      }
      assert.equal(lost.requestedOrchestrationId, RIVAL.id);
      assert.equal(lost.existingOrchestrationId, CLAIM.id);
      assert.equal(lost.result.orchestrationId, CLAIM.id);
      assert.equal(lost.result.orchestrationLabel, CLAIM.label);
    } finally {
      close();
    }
  });

  test("claims a result that an automatic capture stored first", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "claimed output" },
    });
    const { store, close } = makeStore();

    try {
      const automatic = await runCapture(client, store);
      assert.equal(automatic.status, "captured");
      assert.equal(automatic.orchestration, undefined);

      const claimed = await runCapture(client, store, "w1G:p1", CLAIM);
      assert.equal(claimed.status, "duplicate");
      if (claimed.status !== "duplicate") {
        throw new Error("Expected a duplicate outcome.");
      }
      assert.deepEqual(claimed.orchestration, { status: "claimed", id: CLAIM.id });
      assert.equal(store.get(claimed.result.id)?.orchestrationRole, "explorer");
    } finally {
      close();
    }
  });

  test("leaves an explicit claim alone when only automatic captures follow", async () => {
    const client = createMockHerdrClient({
      agents: { "w1G:p1": AGENT_INFO },
      agentReads: { "w1G:p1": "claimed output" },
    });
    const { store, close } = makeStore();

    try {
      const claimed = await runCapture(client, store, "w1G:p1", CLAIM);
      assert.equal(claimed.status, "captured");
      if (claimed.status !== "captured") {
        throw new Error("Expected a captured outcome.");
      }

      const automatic = await runCapture(client, store);
      assert.equal(automatic.status, "duplicate");
      assert.equal(automatic.orchestration, undefined);
      assert.equal(store.get(claimed.result.id)?.orchestrationId, CLAIM.id);
      assert.equal(store.get(claimed.result.id)?.orchestrationLabel, CLAIM.label);
    } finally {
      close();
    }
  });
});

const CLAIM: OrchestrationClaim = {
  id: "2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50",
  label: "探索: fix the parser",
  role: "explorer",
};

const RIVAL: OrchestrationClaim = {
  id: "7c9e1d2a-3b4c-4d5e-8f90-a1b2c3d4e5f6",
  label: "Repair the parser",
  role: "fixer",
};

async function runCapture(
  client: HerdrClient,
  store: SqliteResultStore,
  paneId = "w1G:p1",
  orchestration?: OrchestrationClaim,
  config: HarvestConfig = CONFIG,
): Promise<CaptureOutcome> {
  const deps: CaptureDeps = {
    client,
    store,
    config,
    now: () => 1_700_000_000_000,
  };
  return captureCompletion(deps, { paneId, orchestration });
}

function makeStore(): { store: SqliteResultStore; close: () => void } {
  const database = openDatabase(":memory:");
  const store = new SqliteResultStore(database);
  return { store, close: () => store.close() };
}

function capturedResult(outcome: CaptureOutcome): HarvestResult {
  if (outcome.status === "captured") {
    return outcome.result;
  }
  throw new Error(`Expected captured outcome, got ${outcome.status}.`);
}

function noSessionInfo(paneId: string): Agent {
  return createAgentFixture({
    ...AGENT_INFO,
    pane_id: paneId,
    agent_session: null,
  });
}

function cliError(
  code: string,
  message: string,
  operation: string,
  argv: readonly string[],
): HerdrCliError {
  return new HerdrCliError({ code, message, operation, argv, exitCode: 1 });
}

function processError(
  operation: string,
  argv: readonly string[],
  stderr: string,
): HerdrProcessError {
  return new HerdrProcessError({
    operation,
    argv,
    exitCode: 1,
    signal: null,
    stderr,
  });
}
