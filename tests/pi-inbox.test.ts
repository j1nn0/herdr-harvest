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

function makePi(overrides: Partial<PiInteraction> = {}): PiInteraction {
  return {
    interactionId: "pi-1",
    sessionId: "session-1",
    submittedPrompt: "Reply with FIRST_REPORT_7319.",
    effectivePrompt: "Expanded: Reply with FIRST_REPORT_7319.",
    finalReport: "FIRST_REPORT_7319",
    status: "completed",
    reason: null,
    provenance: "pi-observer",
    dedupKey: "dedup-pi-1",
    ...overrides,
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

function makeClipboard(copied: string[]): ClipboardProvider {
  return {
    name: "fake",
    copy: async (text) => {
      copied.push(text);
      return { provider: "fake", confirmed: true };
    },
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

function insertLegacy(store: SqliteResultStore, input = makeCaptureInput()): void {
  const outcome = store.insert(input);
  assert.equal(outcome.status, "inserted");
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

async function sendInput(instance: ReturnType<typeof render>, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

function setTerminalSize(instance: ReturnType<typeof render>, columns: number, rows: number): void {
  Object.defineProperty(instance.stdout, "columns", {
    configurable: true,
    value: columns,
    writable: true,
  });
  Object.defineProperty(instance.stdout, "rows", {
    configurable: true,
    value: rows,
    writable: true,
  });
}

describe("Pi Inbox integration", () => {
  test("lists Pi terminal states separately from Legacy rows", () => {
    const completed = makePi();
    const failed = makePi({
      interactionId: "pi-failed",
      submittedPrompt: "失敗したprompt\nそのまま",
      effectivePrompt: null,
      finalReport: null,
      status: "failed",
      reason: "agent-settled-without-stop",
    });
    const { port, store } = makeService([completed, failed]);
    try {
      insertLegacy(store);
      const items = port.list();
      const legacy = items.find((item) => item.kind === "legacy");
      const completedItem = items.find((item) => item.id === completed.interactionId);
      const failedItem = items.find((item) => item.id === failed.interactionId);

      assert.equal(legacy?.kind, "legacy");
      assert.equal(completedItem?.kind, "pi");
      assert.equal(completedItem?.status, "completed");
      assert.equal(failedItem?.kind, "pi");
      assert.equal(failedItem?.status, "failed");
      assert.ok(completedItem);
      assert.ok(failedItem);
      assert.ok(legacy);
      assert.match(formatInboxRow(completedItem, 120, 9_000), /Pi · Completed/);
      assert.match(formatInboxRow(failedItem, 120, 9_000), /Pi · Failed-incomplete/);
      assert.equal(inboxItemBadge(legacy), "Legacy");
      assert.match(formatInboxRow(legacy, 120, 9_000), /Legacy/);
    } finally {
      store.close();
    }
  });

  test("opens Pi detail with exact submitted and final text and copies each field", async () => {
    const submittedPrompt = "  日本語 prompt\n二行目  \n🚀";
    const finalReport = " FIRST_REPORT_7319\n結果の行  \n";
    const interaction = makePi({ submittedPrompt, finalReport });
    const copied: string[] = [];
    const { port, store } = makeService([interaction], copied);
    try {
      const detail = port.open(interaction.interactionId);
      assert.equal(detail?.kind, "pi");
      assert.equal(detail?.submittedPrompt, submittedPrompt);
      assert.equal(detail?.effectivePrompt, interaction.effectivePrompt);
      assert.equal(detail?.finalReport, finalReport);
      assert.ok(detail);
      assert.deepEqual(detailContentLines(detail), [
        "PROMPT",
        ...submittedPrompt.split("\n"),
        "",
        "FINAL REPORT",
        ...finalReport.split("\n"),
      ]);

      await port.copy(interaction.interactionId, "prompt");
      await port.copy(interaction.interactionId, "finalReport");
      assert.deepEqual(copied, [submittedPrompt, finalReport]);
    } finally {
      store.close();
    }
  });

  test("does not fabricate a failed final report", async () => {
    const interaction = makePi({
      finalReport: null,
      status: "failed",
      reason: "interrupted",
    });
    const { port, store } = makeService([interaction]);
    try {
      const detail = port.open(interaction.interactionId);
      assert.equal(detail?.finalReport, null);
      assert.ok(detail);
      assert.deepEqual(detailContentLines(detail), [
        "PROMPT",
        interaction.submittedPrompt,
        "",
        "FINAL REPORT",
        "UNAVAILABLE: interrupted",
      ]);
      await assert.rejects(port.copy(interaction.interactionId, "finalReport"));
    } finally {
      store.close();
    }
  });

  test("renders and pages both Pi detail sections without changing their text", async () => {
    const submittedPrompt = Array.from({ length: 8 }, (_, index) => `prompt-${index}`).join("\n");
    const finalReport = Array.from({ length: 8 }, (_, index) => `report-${index}`).join("\n");
    const interaction = makePi({ submittedPrompt, finalReport });
    const copied: string[] = [];
    const { port, store } = makeService([interaction], copied);
    const instance = render(h(createApp(port)));
    try {
      setTerminalSize(instance, 80, 10);
      await sendInput(instance, "\r");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /PROMPT/);
      assert.match(frame, /prompt-0/);
      assert.doesNotMatch(frame, /report-7/);

      await sendInput(instance, "\u001b[6~");
      await sendInput(instance, "\u001b[6~");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /FINAL REPORT/);
      assert.match(frame, /report-0|report-1/);
      assert.doesNotMatch(frame, /prompt-0/);

      await sendInput(instance, "\u001b[5~");
      await sendInput(instance, "\u001b[5~");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /PROMPT/);
      assert.match(frame, /prompt-0/);

      await sendInput(instance, "p");
      await sendInput(instance, "f");
      assert.deepEqual(copied, [submittedPrompt, finalReport]);
    } finally {
      instance.unmount();
      store.close();
    }
  });

  test("keeps the Legacy detail presentation separate from Pi sections", async () => {
    const { port, store } = makeService([]);
    try {
      insertLegacy(store, makeCaptureInput({ rawText: "legacy exact\nbody" }));
      const [item] = port.list();
      assert.equal(item?.kind, "legacy");
      const detail = port.open(item?.id ?? "missing");
      assert.equal(detail?.kind, "legacy");
      assert.equal(detail?.rawText, "legacy exact\nbody");
      assert.ok(detail);
      assert.deepEqual(detailContentLines(detail), ["legacy exact", "body"]);
    } finally {
      store.close();
    }
  });
});
