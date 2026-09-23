import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { createInboxService, type InboxPort } from "../src/app/inbox-service.ts";
import type { ClipboardProvider } from "../src/clipboard/provider.ts";
import type { PiInteraction } from "../src/domain/pi-interaction.ts";
import type { CaptureInput } from "../src/domain/result.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";
import { createApp } from "../src/tui/app.ts";
import { formatInboxRow, inboxItemBadge } from "../src/tui/inbox-view.ts";
import { detailContentLines } from "../src/tui/result-view.ts";

const h = React.createElement;

function makeInteraction(overrides: Partial<PiInteraction> = {}): PiInteraction {
  return {
    interactionId: "codex-1",
    sessionId: "codex-session-1",
    submittedPrompt: "  指示\n二行目  \n🚀",
    effectivePrompt: null,
    finalReport: " 結果\n二行目  \n",
    status: "completed",
    reason: null,
    provenance: "codex-native-hooks",
    completedAtMs: null,
    dedupKey: "dedup-codex-1",
    ...overrides,
  };
}

function makePiInteraction(overrides: Partial<PiInteraction> = {}): PiInteraction {
  return makeInteraction({
    interactionId: "pi-1",
    sessionId: "pi-session-1",
    submittedPrompt: "Pi prompt",
    finalReport: "Pi report",
    provenance: "pi-observer",
    dedupKey: "dedup-pi-1",
    ...overrides,
  });
}

function makeClipboard(copied: string[]): ClipboardProvider {
  return {
    name: "fake",
    copy: async (text) => {
      copied.push(text);
      return { provider: "fake", confirmed: true };
    },
  };
}

function makeCaptureInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    capturedAtMs: 1_000,
    workspaceId: "workspace-id",
    workspaceName: "Workspace",
    tabId: "tab-id",
    paneId: "pane-id",
    paneName: "Pane",
    agentName: "legacy-agent",
    agentKind: "terminal",
    agentSessionKind: "id",
    agentSessionValue: "legacy-session",
    herdrSessionKey: "/tmp/herdr.sock",
    herdrSessionLabel: "default",
    captureSource: "test",
    requestedLineCount: 2,
    rawText: "legacy body",
    ...overrides,
  };
}

function makeService(
  interactions: PiInteraction[],
  copied: string[] = [],
): { port: InboxPort; store: SqliteResultStore } {
  const store = new SqliteResultStore(openDatabase(":memory:"));
  return {
    store,
    port: createInboxService({
      store,
      piStore: { list: () => [...interactions] },
      clipboard: makeClipboard(copied),
      now: () => 9_000,
    }),
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function sendInput(instance: ReturnType<typeof render>, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

describe("Codex Inbox integration", () => {
  test("lists completed Codex rows with Codex identity, badge, preview, and search", () => {
    const interaction = makeInteraction();
    const { port, store } = makeService([interaction]);
    try {
      const [item] = port.list();
      assert.ok(item);
      assert.equal(item.kind, "codex");
      assert.equal(item.agentLabel, "Codex");
      assert.equal(item.workspaceLabel, "Codex");
      assert.equal(item.paneLabel, "Codex interaction");
      assert.equal(item.preview, "結果 二行目");
      assert.equal(item.unread, false);
      assert.equal(item.archived, false);
      assert.equal(inboxItemBadge(item), "Codex · Completed");
      assert.match(formatInboxRow(item, 120, 9_000), /Codex · Completed/);
      assert.deepEqual(
        port.list({ mode: "active", query: "指示" }).map((candidate) => candidate.id),
        [interaction.interactionId],
      );
    } finally {
      store.close();
    }
  });

  test("shows isolated completed, failed, and empty Codex previews safely", () => {
    const completed = makeInteraction({
      interactionId: "codex-preview-completed",
      finalReport: "\u001b[36m completed 日本語 \u001b[0m\nsecond",
    });
    const failed = makeInteraction({
      interactionId: "codex-preview-failed",
      submittedPrompt: "  Codex failed prompt\nsecond",
      finalReport: null,
      status: "failed",
      reason: "synthetic-failure",
    });
    const empty = makeInteraction({
      interactionId: "codex-preview-empty",
      submittedPrompt: "prompt must not replace an empty report",
      finalReport: "\u001b]8;;https://example.test\u0007\u001b]8;;\u0007\n\t",
    });
    const { port, store } = makeService([completed, failed, empty]);
    try {
      const items = port.list();
      const itemFor = (id: string) => {
        const item = items.find((candidate) => candidate.id === id);
        assert.ok(item);
        return item;
      };
      const completedItem = itemFor(completed.interactionId);
      const failedItem = itemFor(failed.interactionId);
      const emptyItem = itemFor(empty.interactionId);

      assert.equal(completedItem.preview, "completed 日本語 second");
      assert.equal(failedItem.preview, "Codex failed prompt second");
      assert.equal(emptyItem.preview, "");

      const completedRow = formatInboxRow(completedItem, 200, 9_000);
      const failedRow = formatInboxRow(failedItem, 200, 9_000);
      const emptyRow = formatInboxRow(emptyItem, 200, 9_000);
      assert.match(completedRow, /completed 日本語 second/);
      assert.match(failedRow, /Codex failed prompt second/);
      assert.match(emptyRow, /\(empty\)/);
      assert.doesNotMatch(completedRow, /Codex failed|prompt must not/);
      assert.doesNotMatch(failedRow, /completed 日本語|prompt must not/);
      assert.doesNotMatch(emptyRow, /prompt must not/);
      assert.equal(completedRow.includes("\u001b"), false);
    } finally {
      store.close();
    }
  });

  test("opens exact prompt/report, copies each field independently, and cannot archive", async () => {
    const interaction = makeInteraction();
    const finalReport = interaction.finalReport;
    if (typeof finalReport !== "string") {
      throw new Error("Expected a completed Codex interaction in the fixture.");
    }
    const copied: string[] = [];
    const { port, store } = makeService([interaction], copied);
    try {
      const detail = port.open(interaction.interactionId);
      assert.ok(detail);
      assert.equal(detail.kind, "codex");
      assert.equal(detail.agentLabel, "Codex");
      assert.equal(detail.captureSource, "codex-native-hooks");
      assert.equal(detail.paneId, "codex");
      assert.equal(detail.submittedPrompt, interaction.submittedPrompt);
      assert.equal(detail.finalReport, interaction.finalReport);
      assert.deepEqual(detailContentLines(detail), [
        "PROMPT",
        ...interaction.submittedPrompt.split("\n"),
        "",
        "FINAL REPORT",
        ...finalReport.split("\n"),
      ]);

      await port.copy(interaction.interactionId, "prompt");
      await port.copy(interaction.interactionId, "finalReport");
      assert.deepEqual(copied, [interaction.submittedPrompt, finalReport]);
      assert.equal(port.archive(interaction.interactionId), false);
      assert.equal(port.restore(interaction.interactionId), false);
    } finally {
      store.close();
    }
  });

  test("renders Codex title and session subtitle and reports the Codex archive message", async () => {
    const interaction = makeInteraction();
    const { port, store } = makeService([interaction]);
    const instance = render(h(createApp(port)));
    try {
      await sendInput(instance, "\r");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Codex Interaction · Completed/);
      assert.match(frame, /Codex session codex-/);
      assert.doesNotMatch(frame, /Pi Interaction|Pi session/);

      await sendInput(instance, "a");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Codex interaction codex-1 cannot be archived/);
    } finally {
      instance.unmount();
      store.close();
    }
  });

  test("keeps Pi rows and legacy rows on their existing paths", () => {
    const pi = makePiInteraction();
    const { port, store } = makeService([makeInteraction(), pi]);
    try {
      const inserted = store.insert(makeCaptureInput({ rawText: "legacy exact" }));
      assert.equal(inserted.status, "inserted");
      const items = port.list();
      const piItem = items.find((item) => item.id === pi.interactionId);
      assert.ok(piItem);
      assert.equal(piItem.kind, "pi");
      assert.equal(piItem.agentLabel, "Pi");
      assert.equal(inboxItemBadge(piItem), "Pi · Completed");

      const legacyItem = items.find((item) => item.kind === "legacy");
      assert.ok(legacyItem);
      assert.equal(legacyItem.preview, "legacy exact");
      assert.deepEqual(
        port.list({ mode: "active", query: "Pi prompt" }).map((item) => item.id),
        [pi.interactionId],
      );
    } finally {
      store.close();
    }
  });

  test("excludes Codex rows from archived scope", () => {
    const interaction = makeInteraction();
    const { port, store } = makeService([interaction]);
    try {
      assert.deepEqual(port.list("archived"), []);
      assert.deepEqual(
        port.list("all").map((item) => item.id),
        [interaction.interactionId],
      );
    } finally {
      store.close();
    }
  });

  test("treats pending Codex staging rows as absent while listing terminal failures", async () => {
    const { PiInteractionStore } = await import("../src/persistence/pi-interaction-store.ts");
    const { codexInteractionId } = await import("../src/codex/collector-contract.ts");
    const { stageCodexPrompt } = await import("../src/codex/staging.ts");

    const db = openDatabase(":memory:");
    const piStore = new PiInteractionStore(db);
    const pendingSessionId = "memory-session";
    const pendingTurnId = "memory-turn";
    const pendingId = codexInteractionId(pendingSessionId, pendingTurnId);
    const pendingPrompt = "## Memory Writing Agent\ninternal memory prompt";
    stageCodexPrompt(db, {
      kind: "promptObserved",
      sessionId: pendingSessionId,
      turnId: pendingTurnId,
      submittedPrompt: pendingPrompt,
    });

    const completed = makeInteraction({
      interactionId: "codex-completed-terminal",
      sessionId: "completed-session",
      submittedPrompt: "completed prompt",
      finalReport: "completed report",
    });
    piStore.insert({
      interactionId: completed.interactionId,
      sessionId: completed.sessionId,
      submittedPrompt: completed.submittedPrompt,
      effectivePrompt: completed.effectivePrompt,
      finalReport: completed.finalReport,
      status: "completed",
      reason: null,
      provenance: completed.provenance,
    });

    const failed = makeInteraction({
      interactionId: "codex-failed-terminal",
      sessionId: "failed-session",
      submittedPrompt: "failed prompt",
      finalReport: null,
      status: "failed",
      reason: "synthetic-failure",
    });
    piStore.insert({
      interactionId: failed.interactionId,
      sessionId: failed.sessionId,
      submittedPrompt: failed.submittedPrompt,
      effectivePrompt: failed.effectivePrompt,
      finalReport: null,
      status: "failed",
      reason: failed.reason,
      provenance: failed.provenance,
    });

    const store = new SqliteResultStore(db);
    const port = createInboxService({
      store,
      piStore,
      clipboard: makeClipboard([]),
      now: () => 9_000,
    });
    try {
      assert.deepEqual(
        port
          .list()
          .map((item) => item.id)
          .sort(),
        [completed.interactionId, failed.interactionId].sort(),
      );
      assert.deepEqual(port.list("archived"), []);
      assert.deepEqual(
        port
          .list("all")
          .map((item) => item.id)
          .sort(),
        [completed.interactionId, failed.interactionId].sort(),
      );
      assert.deepEqual(port.list({ mode: "active", query: "Memory Writing Agent" }), []);
      assert.deepEqual(port.list({ mode: "all", query: "Memory Writing Agent" }), []);
      assert.equal(port.open(pendingId), null);
      await assert.rejects(() => port.copy(pendingId));
      assert.equal(port.archive(pendingId), false);
      assert.equal(port.restore(pendingId), false);

      const failedItem = port.list().find((item) => item.id === failed.interactionId);
      assert.ok(failedItem);
      assert.equal(failedItem.kind, "codex");
      assert.equal(failedItem.status, "failed");
      assert.equal(failedItem.reason, "synthetic-failure");
    } finally {
      store.close();
    }
  });
});
