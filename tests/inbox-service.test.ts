import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInboxService } from "../src/app/inbox-service.ts";
import type { ClipboardProvider, CopyReport } from "../src/clipboard/provider.ts";
import { ClipboardError } from "../src/clipboard/provider.ts";
import type { CaptureInput, HarvestResult } from "../src/domain/result.ts";
import { openDatabase } from "../src/persistence/database.ts";
import type { ResultStore } from "../src/persistence/result-store.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";

function makeInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    capturedAtMs: 1_000,
    workspaceId: "workspace-id",
    workspaceName: "Workspace name",
    tabId: "tab-id",
    paneId: "pane-id",
    paneName: "Pane name",
    agentName: "Agent name",
    agentKind: "terminal",
    agentSessionKind: "id",
    agentSessionValue: "session-id",
    herdrSessionKey: "/tmp/herdr/sessions/default/herdr.sock",
    herdrSessionLabel: "default",
    captureSource: "recent-unwrapped",
    captureLineCount: 12,
    rawText: "captured output",
    ...overrides,
  };
}

function inserted(store: ResultStore, input: CaptureInput): HarvestResult {
  const outcome = store.insert(input);
  assert.equal(outcome.status, "inserted");
  if (outcome.status !== "inserted") {
    throw new Error("Expected an inserted result.");
  }
  return outcome.result;
}

function makeService(clipboard: ClipboardProvider = successfulClipboard()) {
  const store = new SqliteResultStore(openDatabase(":memory:"));
  const service = createInboxService({
    store,
    clipboard,
    now: () => 9_000,
  });
  return { service, store };
}

function successfulClipboard(
  report: CopyReport = { provider: "fake", confirmed: true },
): ClipboardProvider {
  return {
    name: "fake",
    copy: async () => report,
  };
}

describe("inbox service", () => {
  test("delegates list ordering and excludes archived results", () => {
    const { service, store } = makeService();
    try {
      const unreadOld = inserted(store, makeInput({ capturedAtMs: 100, rawText: "unread old" }));
      const unreadNew = inserted(store, makeInput({ capturedAtMs: 300, rawText: "unread new" }));
      const readOld = inserted(store, makeInput({ capturedAtMs: 200, rawText: "read old" }));
      const readNew = inserted(store, makeInput({ capturedAtMs: 500, rawText: "read new" }));
      store.markRead(readOld.id, 1_000);
      store.markRead(readNew.id, 1_001);
      store.archive(unreadOld.id, 1_002);

      assert.deepEqual(
        service.list().map((item) => item.id),
        [unreadNew.id, readNew.id, readOld.id],
      );
    } finally {
      store.close();
    }
  });

  test("maps preferred agent and workspace names", () => {
    const { service, store } = makeService();
    try {
      inserted(
        store,
        makeInput({
          agentName: "Named agent",
          agentKind: "fallback kind",
          workspaceName: "Named workspace",
          workspaceId: "fallback workspace",
          paneName: "Named pane",
        }),
      );

      const [item] = service.list();
      assert.equal(item?.agentLabel, "Named agent");
      assert.equal(item?.contextLabel, "Named workspace / Named pane");
    } finally {
      store.close();
    }
  });

  test("uses agent kind, workspace id, and pane id fallbacks", () => {
    const { service, store } = makeService();
    try {
      inserted(
        store,
        makeInput({
          agentName: null,
          agentKind: "shell",
          workspaceName: null,
          workspaceId: "workspace-fallback",
          paneName: null,
          paneId: "pane-fallback",
        }),
      );

      const [item] = service.list();
      assert.equal(item?.agentLabel, "shell");
      assert.equal(item?.contextLabel, "workspace-fallback / pane-fallback");
    } finally {
      store.close();
    }
  });

  test("uses explicit unknown and dash fallbacks when all optional labels are null", () => {
    const { service, store } = makeService();
    try {
      inserted(
        store,
        makeInput({
          agentName: null,
          agentKind: null,
          workspaceName: null,
          workspaceId: null,
          paneName: null,
          paneId: "pane-only",
        }),
      );

      const [item] = service.list();
      assert.equal(item?.agentLabel, "unknown agent");
      assert.equal(item?.contextLabel, "- / pane-only");
    } finally {
      store.close();
    }
  });

  test("keeps context labels unprefixed for one Herdr session", () => {
    const { service, store } = makeService();
    try {
      const result = inserted(store, makeInput());
      assert.equal(service.list()[0]?.contextLabel, "Workspace name / Pane name");
      assert.equal(service.open(result.id)?.contextLabel, "Workspace name / Pane name");
    } finally {
      store.close();
    }
  });

  test("prefixes list and detail context labels when sessions differ", () => {
    const { service, store } = makeService();
    try {
      const first = inserted(
        store,
        makeInput({
          herdrSessionKey: "socket-a",
          herdrSessionLabel: "alpha",
          rawText: "same output",
        }),
      );
      const second = inserted(
        store,
        makeInput({
          herdrSessionKey: "socket-b",
          herdrSessionLabel: "beta",
          rawText: "same output",
        }),
      );

      const items = service.list();
      assert.equal(
        items.find((item) => item.id === first.id)?.contextLabel,
        "alpha · Workspace name / Pane name",
      );
      assert.equal(
        items.find((item) => item.id === second.id)?.contextLabel,
        "beta · Workspace name / Pane name",
      );
      assert.equal(service.open(first.id)?.contextLabel, "alpha · Workspace name / Pane name");
      assert.equal(
        service.list().find((item) => item.id === first.id)?.contextLabel,
        "alpha · Workspace name / Pane name",
      );
    } finally {
      store.close();
    }
  });

  test("displays unknown session for a null Herdr session key", () => {
    const { service, store } = makeService();
    try {
      const unknown = inserted(
        store,
        makeInput({
          herdrSessionKey: null,
          herdrSessionLabel: null,
          rawText: "unknown session output",
        }),
      );
      inserted(
        store,
        makeInput({
          herdrSessionKey: "socket-known",
          herdrSessionLabel: "known",
          rawText: "known session output",
        }),
      );

      assert.equal(
        service.list().find((item) => item.id === unknown.id)?.contextLabel,
        "unknown session · Workspace name / Pane name",
      );
      assert.equal(
        service.open(unknown.id)?.contextLabel,
        "unknown session · Workspace name / Pane name",
      );
    } finally {
      store.close();
    }
  });

  test("open marks the result read and returns the complete raw snapshot", () => {
    const { service, store } = makeService();
    try {
      const input = makeInput({ rawText: "first\nsecond\n世界 🚀" });
      const result = inserted(store, input);
      assert.equal(service.list()[0]?.unread, true);

      const detail = service.open(result.id);

      assert.equal(detail?.id, result.id);
      assert.equal(detail?.rawText, input.rawText);
      assert.equal(detail?.captureSource, input.captureSource);
      assert.equal(detail?.captureLineCount, input.captureLineCount);
      assert.equal(detail?.paneId, input.paneId);
      assert.equal(detail?.unread, false);
      assert.equal(service.list()[0]?.unread, false);
      assert.equal(store.get(result.id)?.readAtMs, 9_000);
    } finally {
      store.close();
    }
  });

  test("opening an already-read result preserves its original read timestamp", () => {
    let now = 2_000;
    const store = new SqliteResultStore(openDatabase(":memory:"));
    const service = createInboxService({ store, clipboard: successfulClipboard(), now: () => now });
    try {
      const result = inserted(store, makeInput());
      assert.equal(service.open(result.id)?.unread, false);
      now = 3_000;
      assert.equal(service.open(result.id)?.unread, false);
      assert.equal(store.get(result.id)?.readAtMs, 2_000);
    } finally {
      store.close();
    }
  });

  test("returns null for an unknown result without marking anything", () => {
    const { service, store } = makeService();
    try {
      assert.equal(service.open("missing"), null);
      assert.equal(store.get("missing"), null);
    } finally {
      store.close();
    }
  });

  test("archives a result, then reports no second application", () => {
    const { service, store } = makeService();
    try {
      const result = inserted(store, makeInput());

      assert.equal(service.archive(result.id), true);
      assert.deepEqual(service.list(), []);
      assert.equal(service.archive(result.id), false);
      assert.equal(service.archive("missing"), false);
      assert.equal(store.get(result.id)?.archivedAtMs, 9_000);
    } finally {
      store.close();
    }
  });

  test("copies raw text verbatim and returns the clipboard report", async () => {
    const copied: string[] = [];
    const clipboard: ClipboardProvider = {
      name: "fake",
      copy: async (text) => {
        copied.push(text);
        return { provider: "fake", confirmed: false };
      },
    };
    const { service, store } = makeService(clipboard);
    try {
      const rawText = "leading\n\ntrailing  \n世界";
      const result = inserted(store, makeInput({ rawText }));

      const report = await service.copy(result.id);

      assert.deepEqual(report, { provider: "fake", confirmed: false });
      assert.deepEqual(copied, [rawText]);
    } finally {
      store.close();
    }
  });

  test("propagates clipboard failures", async () => {
    const expected = new ClipboardError("clipboard unavailable", ["fake: unavailable"]);
    const clipboard: ClipboardProvider = {
      name: "fake",
      copy: async () => {
        throw expected;
      },
    };
    const { service, store } = makeService(clipboard);
    try {
      const result = inserted(store, makeInput());

      await assert.rejects(service.copy(result.id), (error: unknown) => {
        assert.equal(error, expected);
        return true;
      });
    } finally {
      store.close();
    }
  });

  test("rejects copying an unknown result with ClipboardError", async () => {
    const { service, store } = makeService();
    try {
      await assert.rejects(service.copy("missing"), (error: unknown) => {
        assert.ok(error instanceof ClipboardError);
        assert.match(error.message, /missing/);
        assert.match(error.attempts[0] ?? "", /not found/);
        return true;
      });
    } finally {
      store.close();
    }
  });
});
