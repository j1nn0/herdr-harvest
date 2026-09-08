import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CaptureDeps, CaptureOutcome } from "../src/capture/orchestrator.ts";
import { captureCompletion } from "../src/capture/orchestrator.ts";
import type { HarvestConfig } from "../src/config/config.ts";
import type { HarvestResult } from "../src/domain/result.ts";
import type { HerdrTargetInfo } from "../src/herdr/types.ts";
import { HerdrCliError } from "../src/herdr/types.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";
import { FakeHerdrClient, throwing, value } from "./helpers/fake-herdr-client.ts";

const CONFIG: HarvestConfig = {
  captureLines: 120,
  captureSource: "detection",
  databasePath: ":memory:",
  herdrSessionKey: "/tmp/herdr/sessions/nightly/herdr.sock",
  herdrSessionLabel: "nightly",
};

const AGENT_INFO: HerdrTargetInfo = {
  paneId: "w1G:p1",
  tabId: "w1G:t1",
  workspaceId: "w1G",
  agentName: "explorer",
  agentKind: "pi",
  agentStatus: "done",
  paneName: "π - herdr-harvest",
  session: { kind: "path", value: "/tmp/native-session.jsonl" },
};

describe("captureCompletion", () => {
  test("stores the captured text and maps all metadata fields", async () => {
    const rawText = "first line  \n\n世界 🚀\ntrailing\t  ";
    const client = new FakeHerdrClient({
      getAgent: value(AGENT_INFO),
      readAgent: value(rawText),
      getWorkspaceName: value("Harvest Workspace"),
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);
      const result = capturedResult(outcome);

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
          captureLineCount: result.captureLineCount,
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
          captureLineCount: 120,
          rawText,
        },
      );

      const readCall = client.calls.find((call) => call.method === "readAgent");
      assert.deepEqual(readCall, {
        method: "readAgent",
        target: "w1G:p1",
        options: { source: "detection", lines: 120 },
      });
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("returns duplicate on a repeated capture and leaves one row", async () => {
    const client = new FakeHerdrClient({
      getAgent: value(AGENT_INFO),
      readAgent: value("same completion"),
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

  test("falls back to pane metadata when the agent is absent", async () => {
    const paneInfo: HerdrTargetInfo = {
      ...AGENT_INFO,
      paneId: "w1G:pane",
      tabId: "w1G:t2",
      agentName: null,
      agentKind: "claude",
      paneName: "pane title",
      session: null,
    };
    const client = new FakeHerdrClient({
      getAgent: value(null),
      getPane: value(paneInfo),
      readAgent: value("pane capture"),
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
    } finally {
      close();
    }
  });

  test("skips a pane that is absent from both lookups", async () => {
    const client = new FakeHerdrClient();
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.deepEqual(outcome, { status: "skipped", reason: "pane no longer exists" });
      assert.equal(store.list({ includeArchived: true }).length, 0);
      assert.deepEqual(client.calls, [
        { method: "getAgent", target: "w1G:p1" },
        { method: "getPane", paneId: "w1G:p1" },
      ]);
    } finally {
      close();
    }
  });

  test("returns failed when metadata lookup raises a non-not-found error", async () => {
    const client = new FakeHerdrClient({
      getAgent: throwing(new HerdrCliError("ui_busy", "interface is busy")),
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") {
        assert.match(outcome.reason, /ui_busy/);
      }
      assert.equal(store.list({ includeArchived: true }).length, 0);
      assert.equal(
        client.calls.some((call) => call.method === "getPane"),
        false,
      );
    } finally {
      close();
    }
  });

  test("uses pane read fallback when agent read fails", async () => {
    const client = new FakeHerdrClient({
      getAgent: value(AGENT_INFO),
      readAgent: throwing(new HerdrCliError("agent_not_live", "agent exited")),
      readPane: value("pane fallback output"),
    });
    const { store, close } = makeStore();

    try {
      const outcome = await runCapture(client, store);

      assert.equal(outcome.status, "captured");
      assert.deepEqual(
        client.calls.filter((call) => call.method === "readAgent" || call.method === "readPane"),
        [
          {
            method: "readAgent",
            target: "w1G:p1",
            options: { source: "detection", lines: 120 },
          },
          {
            method: "readPane",
            paneId: "w1G:p1",
            options: { source: "detection", lines: 120 },
          },
        ],
      );
      assert.equal(store.list({ includeArchived: true }).length, 1);
    } finally {
      close();
    }
  });

  test("fails without writing when both reads fail and names both error codes", async () => {
    const client = new FakeHerdrClient({
      getAgent: value(AGENT_INFO),
      readAgent: throwing(new HerdrCliError("agent_read_failed", "agent read failed")),
      readPane: throwing(new HerdrCliError("pane_read_failed", "pane read failed")),
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
      const client = new FakeHerdrClient({
        getAgent: value(AGENT_INFO),
        readAgent: value(rawText),
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

  test("keeps a workspace lookup failure best effort", async () => {
    const client = new FakeHerdrClient({
      getAgent: value(AGENT_INFO),
      readAgent: value("workspace lookup failure is harmless"),
      getWorkspaceName: throwing(new HerdrCliError("workspace_busy", "workspace list failed")),
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

  test("deduplicates identical content for the same native session", async () => {
    const client = new FakeHerdrClient({
      getAgent: value(AGENT_INFO),
      readAgent: value("native session output"),
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
    const client = new FakeHerdrClient({
      getAgent: value(noSessionInfo("w1G:p1")),
      readAgent: value("pane-scoped output"),
    });
    const { store, close } = makeStore();

    try {
      const first = await runCapture(client, store, "w1G:p1");
      client.getAgentResponse = value(noSessionInfo("w1G:p2"));
      const second = await runCapture(client, store, "w1G:p2");
      client.getAgentResponse = value(noSessionInfo("w1G:p1"));
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
    const client = new FakeHerdrClient({
      getAgent: value(AGENT_INFO),
      readAgent: value("racing output"),
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
});

async function runCapture(
  client: FakeHerdrClient,
  store: SqliteResultStore,
  paneId = "w1G:p1",
): Promise<CaptureOutcome> {
  const deps: CaptureDeps = {
    client,
    store,
    config: CONFIG,
    now: () => 1_700_000_000_000,
  };
  return captureCompletion(deps, { paneId });
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

function noSessionInfo(paneId: string): HerdrTargetInfo {
  return {
    ...AGENT_INFO,
    paneId,
    session: null,
  };
}
