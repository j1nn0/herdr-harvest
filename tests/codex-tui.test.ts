import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import { createInboxService, type InboxPort } from "../src/app/inbox-service.ts";
import type { ClipboardProvider } from "../src/clipboard/provider.ts";
import { codexInteractionId } from "../src/codex/collector-contract.ts";
import { stageCodexPrompt } from "../src/codex/staging.ts";
import type { PiInteraction, PiInteractionInput } from "../src/domain/pi-interaction.ts";
import type { CaptureInput } from "../src/domain/result.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { PiInteractionStore } from "../src/persistence/pi-interaction-store.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";
import { createApp } from "../src/tui/app.ts";
import { inboxItemBadge } from "../src/tui/inbox-view.ts";

const h = React.createElement;
const PAGE_DOWN = "\u001b[6~";
const PAGE_UP = "\u001b[5~";

interface TuiFixture {
  port: InboxPort;
  store: SqliteResultStore;
  root: string;
  ids: {
    codex: string;
    longCodex: string;
    pi: string;
    legacy: string;
    pending: string;
  };
  texts: {
    codexPrompt: string;
    codexReport: string;
    longPrompt: string;
    longReport: string;
    pendingPrompt: string;
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

function makeCaptureInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
  return {
    capturedAtMs: 1_000,
    workspaceId: "legacy-workspace",
    workspaceName: "Legacy workspace",
    tabId: "legacy-tab",
    paneId: "legacy-pane",
    paneName: "Legacy pane",
    agentName: "legacy-agent",
    agentKind: "terminal",
    agentSessionKind: "id",
    agentSessionValue: "legacy-session",
    herdrSessionKey: "/tmp/herdr-codex-tui.sock",
    herdrSessionLabel: "codex-tui",
    captureSource: "synthetic-test",
    requestedLineCount: 2,
    rawText: "legacy output",
    ...overrides,
  };
}

function insertInteraction(store: PiInteractionStore, input: PiInteractionInput): PiInteraction {
  const outcome = store.insert(input);
  assert.equal(outcome.status, "inserted");
  if (outcome.status !== "inserted") {
    throw new Error("Expected a newly seeded interaction.");
  }
  return outcome.interaction;
}

function seedFixture(copied: string[] = []): TuiFixture {
  const root = mkdtempSync(join(tmpdir(), "herdr-harvest-codex-tui-"));
  const db = openDatabase(join(root, "harvest.db"));
  const piStore = new PiInteractionStore(db);
  const codexPrompt = "  Codex prompt\n二行目  \n🚀\n";
  const codexReport = " Codex report\n最終行  \n";
  const longPrompt = "long codex prompt";
  const longReport = Array.from({ length: 55 }, (_, index) => `codex-tail-${index}`).join("\n");
  const pendingSessionId = "codex-tui-pending-session";
  const pendingTurnId = "codex-tui-pending-turn";
  const pendingPrompt = "## Memory Writing Agent\ninternal pending prompt";

  const codex = insertInteraction(piStore, {
    interactionId: "codex-tui-completed",
    sessionId: "codex-tui-session",
    submittedPrompt: codexPrompt,
    effectivePrompt: null,
    finalReport: codexReport,
    status: "completed",
    reason: null,
    provenance: "codex-native-hooks",
  });
  const longCodex = insertInteraction(piStore, {
    interactionId: "codex-tui-long",
    sessionId: "codex-tui-long-session",
    submittedPrompt: longPrompt,
    effectivePrompt: null,
    finalReport: longReport,
    status: "completed",
    reason: null,
    provenance: "codex-native-hooks",
  });
  const pi = insertInteraction(piStore, {
    interactionId: "pi-tui-completed",
    sessionId: "pi-tui-session",
    submittedPrompt: "Pi prompt",
    effectivePrompt: null,
    finalReport: "Pi report",
    status: "completed",
    reason: null,
    provenance: "pi-observer",
  });
  const pending = stageCodexPrompt(db, {
    kind: "promptObserved",
    sessionId: pendingSessionId,
    turnId: pendingTurnId,
    submittedPrompt: pendingPrompt,
  });
  assert.equal(pending.status, "accepted");

  const resultStore = new SqliteResultStore(db);
  const legacy = resultStore.insert(makeCaptureInput());
  assert.equal(legacy.status, "inserted");
  if (legacy.status !== "inserted") {
    throw new Error("Expected a newly seeded legacy result.");
  }

  return {
    port: createInboxService({
      store: resultStore,
      piStore,
      clipboard: makeClipboard(copied),
      now: () => 9_000,
    }),
    store: resultStore,
    root,
    ids: {
      codex: codex.interactionId,
      longCodex: longCodex.interactionId,
      pi: pi.interactionId,
      legacy: legacy.result.id,
      pending:
        pending.status === "accepted" ? codexInteractionId(pendingSessionId, pendingTurnId) : "",
    },
    texts: { codexPrompt, codexReport, longPrompt, longReport, pendingPrompt },
  };
}

function disposeFixture(fixture: TuiFixture): void {
  fixture.store.close();
  rmSync(fixture.root, { recursive: true, force: true });
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

async function openItem(
  instance: ReturnType<typeof render>,
  port: InboxPort,
  id: string,
): Promise<void> {
  const index = port.list("active").findIndex((item) => item.id === id);
  assert.notEqual(index, -1);
  for (let move = 0; move < index; move += 1) {
    await sendInput(instance, "j");
  }
  await sendInput(instance, "\r");
}

function assertBytesEqual(actual: string | undefined, expected: string): void {
  assert.ok(actual !== undefined);
  assert.equal(Buffer.compare(Buffer.from(actual), Buffer.from(expected)), 0);
}

describe("Codex production TUI", () => {
  test("lists Codex, Pi, and Legacy badges while omitting pending Codex rows", () => {
    const fixture = seedFixture();
    const instance = render(h(createApp(fixture.port)));
    try {
      const items = fixture.port.list("active");
      assert.deepEqual(
        items.map((item) => item.id).sort(),
        [fixture.ids.codex, fixture.ids.longCodex, fixture.ids.pi, fixture.ids.legacy].sort(),
      );
      assert.equal(
        fixture.port.list("all").some((item) => item.id === fixture.ids.pending),
        false,
      );
      assert.deepEqual(fixture.port.list({ mode: "all", query: fixture.texts.pendingPrompt }), []);

      const frame = instance.lastFrame() ?? "";
      assert.equal(
        frame.split("\n").filter((line) => line.includes("Codex · Completed")).length,
        2,
      );
      assert.equal(frame.split("\n").filter((line) => line.includes("Pi · Completed")).length, 1);
      assert.equal(frame.split("\n").filter((line) => line.includes(" · Legacy")).length, 1);
      assert.equal(frame.includes(fixture.texts.pendingPrompt), false);
      assert.equal(frame.includes(fixture.ids.pending), false);
      for (const item of items) {
        if (item.kind === "codex" || item.kind === "pi") {
          assert.match(inboxItemBadge(item), /^(Codex|Pi) · Completed$/);
        }
      }
    } finally {
      instance.unmount();
      disposeFixture(fixture);
    }
  });

  test("opens a Codex detail with exact multiline Unicode and whitespace", async () => {
    const fixture = seedFixture();
    const instance = render(h(createApp(fixture.port)));
    try {
      await openItem(instance, fixture.port, fixture.ids.codex);
      const detail = fixture.port.open(fixture.ids.codex);
      assert.ok(detail);
      assert.equal(detail.kind, "codex");
      assert.equal(detail.submittedPrompt, fixture.texts.codexPrompt);
      assert.equal(detail.finalReport, fixture.texts.codexReport);

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Codex Interaction · Completed/);
      assert.match(frame, /Codex session/);
      assert.match(frame, /PROMPT/);
      assert.match(frame, /FINAL REPORT/);
      const bodyLines = [
        ...fixture.texts.codexPrompt.split("\n"),
        ...fixture.texts.codexReport.split("\n"),
      ];
      for (const [index, line] of bodyLines.entries()) {
        if (line.length > 0) {
          assert.ok(
            frame.split("\n").some((frameLine) => frameLine.trimEnd().endsWith(line.trimEnd())),
            `rendered Codex body line ${index} was not retained`,
          );
        }
      }
      assert.doesNotMatch(frame, /Pi Interaction|Pi session/);
    } finally {
      instance.unmount();
      disposeFixture(fixture);
    }
  });

  test("pages a long Codex detail to its tail and returns to the head", async () => {
    const fixture = seedFixture();
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 60, 10);
      await openItem(instance, fixture.port, fixture.ids.longCodex);
      assert.match(instance.lastFrame() ?? "", /long codex prompt/);

      for (let page = 0; page < 20; page += 1) {
        await sendInput(instance, PAGE_DOWN);
      }
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /codex-tail-54/);
      assert.doesNotMatch(frame, /codex-tail-0\n/);

      for (let page = 0; page < 20; page += 1) {
        await sendInput(instance, PAGE_UP);
      }
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /PROMPT/);
      assert.match(frame, /long codex prompt/);
      assert.doesNotMatch(frame, /codex-tail-54/);
    } finally {
      instance.unmount();
      disposeFixture(fixture);
    }
  });

  test("copies exact Codex prompt, final report, and default report through the TUI", async () => {
    const copied: string[] = [];
    const fixture = seedFixture(copied);
    const instance = render(h(createApp(fixture.port)));
    try {
      await openItem(instance, fixture.port, fixture.ids.codex);
      await sendInput(instance, "p");
      await sendInput(instance, "f");
      await sendInput(instance, "y");

      assert.equal(copied.length, 3);
      assertBytesEqual(copied[0], fixture.texts.codexPrompt);
      assertBytesEqual(copied[1], fixture.texts.codexReport);
      assertBytesEqual(copied[2], fixture.texts.codexReport);
    } finally {
      instance.unmount();
      disposeFixture(fixture);
    }
  });

  test("renders the Codex inbox safely at a narrow terminal and keeps pending absent", async () => {
    const fixture = seedFixture();
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 10);
      await sendInput(instance, "j");
      const frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 10);
      assert.match(frame, /Codex/);
      assert.doesNotMatch(frame, /Pending|Memory Writing Agent|codex-tui-pending/);
    } finally {
      instance.unmount();
      disposeFixture(fixture);
    }
  });

  test("filters a Codex prompt through the interactive search without exposing pending text", async () => {
    const fixture = seedFixture();
    const instance = render(h(createApp(fixture.port)));
    try {
      const searchNeedle = "  Codex prompt";
      await sendInput(instance, "/");
      await sendInput(instance, searchNeedle);
      await sendInput(instance, "\r");

      const matches = fixture.port.list({ mode: "active", query: searchNeedle });
      assert.deepEqual(
        matches.map((item) => item.id),
        [fixture.ids.codex],
      );
      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /1 match/);
      assert.match(frame, /Codex · Completed/);
      assert.doesNotMatch(frame, /Pi · Completed| · Legacy|Pending|Memory Writing Agent/);
      assert.equal(frame.includes(fixture.ids.pending), false);
    } finally {
      instance.unmount();
      disposeFixture(fixture);
    }
  });
});
