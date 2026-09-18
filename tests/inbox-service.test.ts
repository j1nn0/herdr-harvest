import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createInboxService } from "../src/app/inbox-service.ts";
import type { ClipboardProvider, CopyReport } from "../src/clipboard/provider.ts";
import { ClipboardError } from "../src/clipboard/provider.ts";
import type { OrchestrationClaim } from "../src/domain/orchestration.ts";
import type { PiInteraction } from "../src/domain/pi-interaction.ts";
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
    requestedLineCount: 12,
    rawText: "captured output",
    ...overrides,
  };
}

function inserted(
  store: ResultStore,
  input: CaptureInput,
  claim?: OrchestrationClaim,
): HarvestResult {
  const outcome = store.insert(input, claim);
  assert.equal(outcome.status, "inserted");
  if (outcome.status !== "inserted") {
    throw new Error("Expected an inserted result.");
  }
  return outcome.result;
}

function makeInteraction(overrides: Partial<PiInteraction> = {}): PiInteraction {
  return {
    interactionId: "pi-interaction",
    sessionId: "pi-session",
    submittedPrompt: "pi prompt needle",
    effectivePrompt: null,
    finalReport: "pi report needle",
    status: "completed",
    reason: null,
    provenance: "pi-observer",
    completedAtMs: 1_000,
    dedupKey: "pi-dedup",
    ...overrides,
  };
}

function makeService(
  clipboard: ClipboardProvider = successfulClipboard(),
  interactions: PiInteraction[] = [],
) {
  const store = new SqliteResultStore(openDatabase(":memory:"));
  const service = createInboxService({
    store,
    clipboard,
    now: () => 9_000,
    piStore: interactions.length === 0 ? undefined : { list: () => interactions },
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

  test("orders mixed sources by unread state, known time, and deterministic unknown time", () => {
    const piItems = [
      makeInteraction({
        interactionId: "pi-tie-z",
        completedAtMs: 600,
        dedupKey: "pi-tie-z",
      }),
      makeInteraction({
        interactionId: "pi-historical",
        completedAtMs: null,
        dedupKey: "pi-historical",
      }),
      makeInteraction({
        interactionId: "codex-recent",
        completedAtMs: 800,
        provenance: "codex-native-hooks",
        dedupKey: "codex-recent",
      }),
      makeInteraction({
        interactionId: "pi-newest",
        completedAtMs: 1_000,
        dedupKey: "pi-newest",
      }),
      makeInteraction({
        interactionId: "pi-tie-a",
        completedAtMs: 600,
        dedupKey: "pi-tie-a",
      }),
      {
        ...makeInteraction({
          interactionId: "codex-pending",
          completedAtMs: null,
          dedupKey: "codex-pending",
        }),
        status: "pending",
        finalReport: null,
      } as unknown as PiInteraction,
    ];
    const { service, store } = makeService(successfulClipboard(), piItems);
    try {
      const legacyUnread = inserted(
        store,
        makeInput({ capturedAtMs: 900, rawText: "legacy unread needle" }),
      );
      const legacyRead = inserted(
        store,
        makeInput({ capturedAtMs: 700, rawText: "legacy read needle" }),
      );
      const legacyArchived = inserted(
        store,
        makeInput({ capturedAtMs: 50, rawText: "legacy archived needle" }),
      );
      store.markRead(legacyRead.id, 2_000);
      store.archive(legacyArchived.id, 2_001);

      const expectedActive = [
        legacyUnread.id,
        "pi-newest",
        "codex-recent",
        legacyRead.id,
        "pi-tie-z",
        "pi-tie-a",
        "pi-historical",
      ];
      const expectedAll = [
        "pi-newest",
        legacyUnread.id,
        "codex-recent",
        legacyRead.id,
        "pi-tie-z",
        "pi-tie-a",
        legacyArchived.id,
        "pi-historical",
      ];

      assert.deepEqual(
        service.list().map((item) => item.id),
        expectedActive,
      );
      assert.deepEqual(
        service.list({ mode: "active", query: "   " }).map((item) => item.id),
        expectedActive,
      );
      assert.deepEqual(
        service.list({ query: "needle" }).map((item) => item.id),
        expectedActive,
      );
      assert.deepEqual(
        service.list({ mode: "all", query: "needle" }).map((item) => item.id),
        expectedAll,
      );
      assert.deepEqual(
        service.list("all").map((item) => item.id),
        expectedAll,
      );
      assert.deepEqual(
        service.list("archived").map((item) => item.id),
        [legacyArchived.id],
      );
      assert.equal(
        service.list().some((item) => item.id === "codex-pending"),
        false,
      );
      assert.equal(service.list().find((item) => item.id === "pi-historical")?.capturedAtMs, null);
      assert.equal(service.list().find((item) => item.id === "pi-newest")?.capturedAtMs, 1_000);
      assert.equal(new Set(expectedActive).size, expectedActive.length);
      assert.deepEqual(
        service.list().map((item) => item.id),
        expectedActive,
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
      assert.equal(item?.workspaceLabel, "Named workspace");
      assert.equal(item?.paneLabel, "Named pane");
      assert.equal(item?.herdrSessionLabel, "default");
      assert.equal(item?.sessionShortId, "sessio");
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
      assert.equal(item?.workspaceLabel, "workspace-fallback");
      assert.equal(item?.paneLabel, "pane-fallback");
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
      assert.equal(item?.workspaceLabel, "-");
      assert.equal(item?.paneLabel, "pane-only");
    } finally {
      store.close();
    }
  });

  test("keeps Herdr session labels available for one Herdr session", () => {
    const { service, store } = makeService();
    try {
      const result = inserted(store, makeInput());
      assert.equal(service.list()[0]?.herdrSessionLabel, "default");
      assert.equal(service.open(result.id)?.herdrSessionLabel, "default");
    } finally {
      store.close();
    }
  });

  test("passes orchestration and native session metadata through list and detail", () => {
    const { service, store } = makeService();
    try {
      const result = inserted(
        store,
        makeInput({
          agentSessionKind: "path",
          agentSessionValue: "/tmp/native-session.jsonl",
        }),
        {
          id: "2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50",
          label: "  Explore parser  ",
          role: "explorer",
        },
      );

      const item = service.list()[0];
      assert.deepEqual(
        {
          orchestrationId: item?.orchestrationId,
          orchestrationLabel: item?.orchestrationLabel,
          orchestrationRole: item?.orchestrationRole,
          agentSessionKind: item?.agentSessionKind,
          agentSessionValue: item?.agentSessionValue,
        },
        {
          orchestrationId: result.orchestrationId,
          orchestrationLabel: result.orchestrationLabel,
          orchestrationRole: result.orchestrationRole,
          agentSessionKind: result.agentSessionKind,
          agentSessionValue: result.agentSessionValue,
        },
      );

      const detail = service.open(result.id);
      assert.equal(detail?.orchestrationId, result.orchestrationId);
      assert.equal(detail?.orchestrationLabel, result.orchestrationLabel);
      assert.equal(detail?.orchestrationRole, result.orchestrationRole);
      assert.equal(detail?.agentSessionKind, result.agentSessionKind);
      assert.equal(detail?.agentSessionValue, result.agentSessionValue);
    } finally {
      store.close();
    }
  });

  test("keeps discrete Herdr and workspace fields when sessions differ", () => {
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
      assert.equal(items.find((item) => item.id === first.id)?.herdrSessionLabel, "alpha");
      assert.equal(items.find((item) => item.id === second.id)?.herdrSessionLabel, "beta");
      assert.equal(items.find((item) => item.id === first.id)?.workspaceLabel, "Workspace name");
      assert.equal(service.open(first.id)?.herdrSessionLabel, "alpha");
    } finally {
      store.close();
    }
  });

  test("keeps null Herdr session metadata separate from native session identity", () => {
    const { service, store } = makeService();
    try {
      const unknown = inserted(
        store,
        makeInput({
          herdrSessionKey: null,
          herdrSessionLabel: null,
          agentSessionKind: null,
          agentSessionValue: null,
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

      assert.equal(service.list().find((item) => item.id === unknown.id)?.herdrSessionLabel, null);
      assert.equal(service.open(unknown.id)?.herdrSessionLabel, null);
      assert.match(
        service.list().find((item) => item.id === unknown.id)?.sessionShortId ?? "",
        /^~/,
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
      assert.equal(detail?.requestedLineCount, input.requestedLineCount);
      assert.equal(detail?.paneId, input.paneId);
      assert.equal(detail?.unread, false);
      assert.equal(service.list()[0]?.unread, false);
      assert.equal(store.get(result.id)?.readAtMs, 9_000);
    } finally {
      store.close();
    }
  });

  test("derives the preview from raw text without changing the stored content", () => {
    const { service, store } = makeService();
    try {
      const rawText = " leading\n\nBun から Node への移行 世界 🚀  ";
      const result = inserted(store, makeInput({ rawText }));

      assert.equal(service.list()[0]?.preview, "leading Bun から Node への移行 世界 🚀");
      assert.equal(store.get(result.id)?.rawText, rawText);
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

  test("lists active results by default and archived results on request", () => {
    const { service, store } = makeService();
    try {
      const active = inserted(store, makeInput({ rawText: "active result" }));
      const archived = inserted(store, makeInput({ rawText: "archived result" }));
      assert.equal(service.archive(archived.id), true);

      assert.deepEqual(
        service.list().map((item) => item.id),
        [active.id],
      );
      assert.deepEqual(
        service.list("active").map((item) => item.id),
        [active.id],
      );
      assert.deepEqual(
        service.list("archived").map((item) => item.id),
        [archived.id],
      );
      assert.equal(service.list()[0]?.archived, false);
      assert.equal(service.list("archived")[0]?.archived, true);
    } finally {
      store.close();
    }
  });

  test("orders archived results newest first", () => {
    let now = 1_000;
    const store = new SqliteResultStore(openDatabase(":memory:"));
    const service = createInboxService({ store, clipboard: successfulClipboard(), now: () => now });
    try {
      const first = inserted(store, makeInput({ capturedAtMs: 10, rawText: "first archived" }));
      const second = inserted(store, makeInput({ capturedAtMs: 20, rawText: "second archived" }));
      now = 5_000;
      assert.equal(service.archive(first.id), true);
      now = 6_000;
      assert.equal(service.archive(second.id), true);

      assert.deepEqual(
        service.list("archived").map((item) => item.id),
        [second.id, first.id],
      );
    } finally {
      store.close();
    }
  });

  test("restores an archived result back into the active list", () => {
    const { service, store } = makeService();
    try {
      const result = inserted(store, makeInput());

      assert.equal(service.restore(result.id), false);
      assert.equal(service.restore("missing"), false);
      assert.equal(service.archive(result.id), true);
      assert.deepEqual(
        service.list("archived").map((item) => item.id),
        [result.id],
      );

      assert.equal(service.restore(result.id), true);
      assert.deepEqual(service.list("archived"), []);
      assert.deepEqual(
        service.list().map((item) => item.id),
        [result.id],
      );
      assert.equal(store.get(result.id)?.archivedAtMs, null);
      assert.equal(service.restore(result.id), false);
    } finally {
      store.close();
    }
  });

  test("opens and copies an archived result without restoring it", async () => {
    const copied: string[] = [];
    const clipboard: ClipboardProvider = {
      name: "fake",
      copy: async (text) => {
        copied.push(text);
        return { provider: "fake", confirmed: true };
      },
    };
    const { service, store } = makeService(clipboard);
    try {
      const rawText = "archived body 世界 🚀\nsecond line";
      const result = inserted(store, makeInput({ rawText }));
      assert.equal(service.archive(result.id), true);

      const detail = service.open(result.id);
      assert.equal(detail?.id, result.id);
      assert.equal(detail?.rawText, rawText);
      assert.equal(detail?.archived, true);
      assert.equal(detail?.unread, false);
      assert.equal(store.get(result.id)?.readAtMs, 9_000);
      assert.equal(store.get(result.id)?.archivedAtMs, 9_000);

      const report = await service.copy(result.id);
      assert.deepEqual(report, { provider: "fake", confirmed: true });
      assert.deepEqual(copied, [rawText]);

      assert.deepEqual(service.list(), []);
      assert.deepEqual(
        service.list("archived").map((item) => item.id),
        [result.id],
      );
    } finally {
      store.close();
    }
  });
});

describe("inbox service search", () => {
  test("searches active results, excludes archived, and preserves active order", () => {
    const { service, store } = makeService();
    try {
      const unreadOld = inserted(
        store,
        makeInput({ capturedAtMs: 100, rawText: "needle unread old" }),
      );
      const unreadNew = inserted(
        store,
        makeInput({ capturedAtMs: 300, rawText: "needle unread new" }),
      );
      const readOld = inserted(store, makeInput({ capturedAtMs: 200, rawText: "needle read old" }));
      const readNew = inserted(store, makeInput({ capturedAtMs: 500, rawText: "needle read new" }));
      const archived = inserted(
        store,
        makeInput({ capturedAtMs: 400, rawText: "needle archived" }),
      );
      store.markRead(readOld.id, 1_000);
      store.markRead(readNew.id, 1_001);
      store.archive(archived.id, 1_002);

      assert.deepEqual(
        service.list({ query: "needle" }).map((item) => item.id),
        [unreadNew.id, unreadOld.id, readNew.id, readOld.id],
      );
      assert.deepEqual(
        service.list({ mode: "active", query: "needle" }).map((item) => item.id),
        [unreadNew.id, unreadOld.id, readNew.id, readOld.id],
      );
      assert.equal(
        service.list({ query: "needle" }).some((item) => item.id === archived.id),
        false,
      );
      assert.deepEqual(
        service.list({ query: "needle" }).map((item) => item.archived),
        [false, false, false, false],
      );
    } finally {
      store.close();
    }
  });

  test("searches archived results, excludes active, and preserves archived order", () => {
    let now = 1_000;
    const store = new SqliteResultStore(openDatabase(":memory:"));
    const service = createInboxService({ store, clipboard: successfulClipboard(), now: () => now });
    try {
      const first = inserted(store, makeInput({ capturedAtMs: 10, rawText: "needle first" }));
      const second = inserted(store, makeInput({ capturedAtMs: 20, rawText: "needle second" }));
      const active = inserted(store, makeInput({ capturedAtMs: 30, rawText: "needle active" }));
      now = 5_000;
      service.archive(first.id);
      now = 6_000;
      service.archive(second.id);

      const archived = service.list({ mode: "archived", query: "needle" });
      assert.deepEqual(
        archived.map((item) => item.id),
        [second.id, first.id],
      );
      assert.deepEqual(
        archived.map((item) => item.archived),
        [true, true],
      );
      assert.equal(
        archived.some((item) => item.id === active.id),
        false,
      );
      assert.deepEqual(
        service.list({ mode: "archived", query: "needle" }).map((item) => item.id),
        service.list("archived").map((item) => item.id),
      );
    } finally {
      store.close();
    }
  });

  test("searches both collections in global capture order for the all scope", () => {
    const { service, store } = makeService();
    try {
      const oldest = inserted(store, makeInput({ capturedAtMs: 100, rawText: "needle alpha" }));
      const archivedOlder = inserted(
        store,
        makeInput({ capturedAtMs: 200, rawText: "needle beta" }),
      );
      const archivedNewer = inserted(
        store,
        makeInput({ capturedAtMs: 300, rawText: "needle gamma" }),
      );
      const newest = inserted(store, makeInput({ capturedAtMs: 400, rawText: "needle delta" }));
      store.markRead(newest.id, 1_000);
      store.archive(archivedOlder.id, 1_001);
      store.archive(archivedNewer.id, 1_002);

      assert.deepEqual(
        service.list({ mode: "all", query: "needle" }).map((item) => item.id),
        [newest.id, archivedNewer.id, archivedOlder.id, oldest.id],
      );
      assert.deepEqual(
        service.list({ mode: "all", query: "needle" }).map((item) => item.archived),
        [false, true, true, false],
      );
      // The active collection keeps its unread-first order, unlike the all scope.
      assert.deepEqual(
        service.list("active").map((item) => item.id),
        [oldest.id, newest.id],
      );
    } finally {
      store.close();
    }
  });

  test("orders the all scope by descending capture time and id", () => {
    const { service, store } = makeService();
    try {
      const capturedAtMs = 777;
      const [first, second, third] = [
        inserted(store, makeInput({ capturedAtMs, rawText: "tie one" })),
        inserted(store, makeInput({ capturedAtMs, rawText: "tie two" })),
        inserted(store, makeInput({ capturedAtMs, rawText: "tie three" })),
      ];
      const rows = [first, second, third];
      store.archive(second.id, 1_000);

      const expected = rows
        .map((row) => row.id)
        .sort()
        .reverse();
      assert.deepEqual(
        service.list("all").map((item) => item.id),
        expected,
      );
      assert.deepEqual(
        service.list({ mode: "all", query: "tie" }).map((item) => item.id),
        expected,
      );
    } finally {
      store.close();
    }
  });

  test("treats blank queries as no filter in every scope", () => {
    const { service, store } = makeService();
    try {
      const active = inserted(store, makeInput({ rawText: "active" }));
      const archived = inserted(store, makeInput({ rawText: "archived" }));
      service.archive(archived.id);

      assert.deepEqual(
        service.list({ mode: "active", query: "   " }).map((item) => item.id),
        [active.id],
      );
      assert.deepEqual(
        service.list({ mode: "archived", query: "" }).map((item) => item.id),
        [archived.id],
      );
      assert.deepEqual(
        service
          .list({ mode: "all", query: "\t\n" })
          .map((item) => item.id)
          .sort(),
        [active.id, archived.id].sort(),
      );
      assert.deepEqual(
        service.list({ query: "" }).map((item) => item.id),
        service.list().map((item) => item.id),
      );
    } finally {
      store.close();
    }
  });

  test("returns nothing when no result matches the query", () => {
    const { service, store } = makeService();
    try {
      inserted(store, makeInput({ rawText: "unrelated" }));

      assert.deepEqual(service.list({ query: "missing" }), []);
      assert.deepEqual(service.list({ mode: "all", query: "missing" }), []);
      assert.deepEqual(service.list({ mode: "archived", query: "missing" }), []);
    } finally {
      store.close();
    }
  });

  test("searches metadata fields and the derived session short id", () => {
    const { service, store } = makeService();
    try {
      const named = inserted(
        store,
        makeInput({ workspaceName: "workspace-needle", rawText: "unrelated" }),
      );
      const compact = inserted(
        store,
        makeInput({
          agentSessionKind: "id",
          agentSessionValue: "p-q-r-s-t-u",
          rawText: "unrelated too",
        }),
      );

      assert.deepEqual(
        service.list({ query: "workspace-needle" }).map((item) => item.id),
        [named.id],
      );
      assert.deepEqual(
        service.list({ query: "pqrstu" }).map((item) => item.id),
        [compact.id],
      );
      assert.deepEqual(
        service.list({ query: "p-q-r-s-t-u" }).map((item) => item.id),
        [compact.id],
      );
    } finally {
      store.close();
    }
  });

  test("keeps stored raw text byte-identical across a search", () => {
    const { service, store } = makeService();
    try {
      const rawText = "cafe\u0301\n\n  Release 候補  \n";
      const result = inserted(store, makeInput({ rawText }));

      assert.deepEqual(
        service.list({ query: "CAFÉ" }).map((item) => item.id),
        [result.id],
      );
      assert.deepEqual(
        service.list({ query: "候補" }).map((item) => item.id),
        [result.id],
      );
      assert.equal(store.get(result.id)?.rawText, rawText);
      assert.equal(service.open(result.id)?.rawText, rawText);
    } finally {
      store.close();
    }
  });
});
