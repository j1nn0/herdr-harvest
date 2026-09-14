import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type {
  InboxDetail,
  InboxItem,
  InboxListOptions,
  InboxPort,
  InboxScope,
} from "../src/app/inbox-service.ts";
import { createInboxService } from "../src/app/inbox-service.ts";
import type { CopyReport } from "../src/clipboard/provider.ts";
import { ClipboardError } from "../src/clipboard/provider.ts";
import type { CaptureInput, HarvestResult } from "../src/domain/result.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";
import { createApp, formatBytes } from "../src/tui/app.ts";
import {
  clampListOffset,
  displayWidth,
  formatInboxRow,
  inboxViewportLines,
  listOffsetForCursor,
  selectedMetadataLines,
} from "../src/tui/inbox-view.ts";

const h = React.createElement;

interface FixtureOptions {
  copy?: (id: string) => Promise<CopyReport>;
  details?: Map<string, InboxDetail>;
}

interface Fixture {
  port: InboxPort;
  calls: {
    opened: string[];
    archived: string[];
    restored: string[];
    copied: string[];
  };
}

function makeItem(id: string, unread = true): InboxItem {
  return {
    id,
    agentLabel: `agent-${id}`,
    sessionShortId: `sess-${id}`,
    workspaceLabel: "workspace",
    herdrSessionLabel: "default",
    paneLabel: `pane-${id}`,
    capturedAtMs: 0,
    preview: `preview-${id}`,
    unread,
    archived: false,
  };
}

function makeArchivedItem(id: string, unread = true): InboxItem {
  return { ...makeItem(id, unread), archived: true };
}

function makeDetail(item: InboxItem, rawText = `first-${item.id}\nsecond-${item.id}`): InboxDetail {
  return {
    ...item,
    rawText,
    captureSource: "test",
    captureLineCount: rawText.split("\n").length,
    paneId: `pane-${item.id}`,
  };
}

/** Capture input with the stable defaults the service tests use. */
function makeCaptureInput(overrides: Partial<CaptureInput> = {}): CaptureInput {
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
    herdrSessionKey: "/tmp/herdr/default.sock",
    herdrSessionLabel: "default",
    captureSource: "recent-unwrapped",
    captureLineCount: 3,
    rawText: "captured output",
    ...overrides,
  };
}

function insertResult(store: SqliteResultStore, input: CaptureInput): HarvestResult {
  const outcome = store.insert(input);
  assert.equal(outcome.status, "inserted");
  if (outcome.status !== "inserted") {
    throw new Error("Expected an inserted result.");
  }
  return outcome.result;
}

/**
 * Fixture-only search: a real port filters the stored result, while this one
 * only holds mapped InboxItems, so it matches the identifiers a test can set
 * with the same literal NFC + lowercase semantics as the service matcher.
 */
function fixtureMatches(item: InboxItem, needle: string): boolean {
  return [item.agentLabel, item.preview, item.id].some((field) =>
    field.normalize("NFC").toLowerCase().includes(needle),
  );
}

function fixtureInScope(item: InboxItem, scope: InboxScope): boolean {
  if (scope === "all") {
    return true;
  }
  return scope === "archived" ? item.archived : !item.archived;
}

/** Mirrors the service's all-scope order: capture time, then descending id. */
function compareFixtureCapture(left: InboxItem, right: InboxItem): number {
  if (left.capturedAtMs !== right.capturedAtMs) {
    return right.capturedAtMs - left.capturedAtMs;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}

function makeFixture(items: InboxItem[], options: FixtureOptions = {}): Fixture {
  const members = [...items];
  const calls = { opened: [], archived: [], restored: [], copied: [] } as Fixture["calls"];

  const detailFor = (id: string): InboxDetail | null => {
    const member = members.find((candidate) => candidate.id === id);
    if (member === undefined) {
      return null;
    }
    const custom = options.details?.get(id);
    return custom === undefined ? makeDetail(member) : { ...custom, archived: member.archived };
  };

  const port: InboxPort = {
    list: (request?: InboxScope | InboxListOptions) => {
      const options =
        request === undefined || typeof request === "string" ? { mode: request } : request;
      const scope = options.mode ?? "active";
      const needle = (options.query ?? "").normalize("NFC").toLowerCase();
      const scoped = members.filter((item) => fixtureInScope(item, scope));
      const matched =
        needle.trim().length === 0 ? scoped : scoped.filter((item) => fixtureMatches(item, needle));
      return scope === "all" ? [...matched].sort(compareFixtureCapture) : matched;
    },
    open: (id) => {
      calls.opened.push(id);
      return detailFor(id);
    },
    archive: (id) => {
      calls.archived.push(id);
      const member = members.find((candidate) => candidate.id === id);
      if (member === undefined || member.archived) {
        return false;
      }
      member.archived = true;
      return true;
    },
    restore: (id) => {
      calls.restored.push(id);
      const member = members.find((candidate) => candidate.id === id);
      if (member === undefined || !member.archived) {
        return false;
      }
      member.archived = false;
      return true;
    },
    copy: (id) => {
      calls.copied.push(id);
      return options.copy?.(id) ?? Promise.resolve({ provider: "fake", confirmed: true });
    },
  };
  return { port, calls };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function sendInput(instance: ReturnType<typeof render>, input: string): Promise<void> {
  instance.stdin.write(input);
  await tick();
}

function hasAgent(frame: string, id: string): boolean {
  return frame.split("\n").some((line) => line.includes(`agent-${id} `));
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

function agentRows(frame: string): string[] {
  return frame.split("\n").filter((line) => line.includes("agent-"));
}

function resultBodyRows(frame: string): string[] {
  return frame.split("\n").filter((line) => line.includes("body-line-"));
}

describe("inbox TUI", () => {
  test("formats a distinguishable row without pane-title noise", () => {
    const item = makeItem("wide");
    const row = formatInboxRow(
      {
        ...item,
        agentLabel: "claude",
        sessionShortId: "409d97",
        workspaceLabel: "herdr-plugin-sdk",
        paneLabel: "⠿ claude · working · 15m · transient title",
        preview: "completed output preview",
        capturedAtMs: 0,
      },
      120,
      60_000,
    );

    assert.match(row, /claude/);
    assert.match(row, /409d97/);
    assert.match(row, /herdr-plugin-sdk/);
    assert.match(row, /ago 1m/);
    assert.doesNotMatch(row, /transient title/);
    assert.ok(displayWidth(row) <= 120);
  });

  test("keeps the core identity fields at a narrow width", () => {
    const row = formatInboxRow(
      {
        ...makeItem("narrow"),
        agentLabel: "claude",
        sessionShortId: "409d97",
        workspaceLabel: "herdr-plugin-sdk",
        preview: "long preview that should be dropped first",
      },
      20,
      60_000,
    );

    assert.match(row, /claude/);
    assert.match(row, /409d97/);
    assert.ok(displayWidth(row) <= 20);
  });

  test("accounts for Japanese and emoji display width", () => {
    const row = formatInboxRow(
      {
        ...makeItem("unicode"),
        agentLabel: "pi",
        sessionShortId: "a1b2c3",
        workspaceLabel: "workspace",
        preview: "Bun から Node への移行 世界 🚀",
      },
      32,
      60_000,
    );

    assert.ok(displayWidth(row) <= 32);
  });

  test("truncates an over-long field while preserving the native session", () => {
    const row = formatInboxRow(
      {
        ...makeItem("long-agent"),
        agentLabel: "an agent label that is much longer than the available row",
        sessionShortId: "409d97",
      },
      40,
      60_000,
    );

    assert.match(row, /…/);
    assert.match(row, /409d97/);
    assert.ok(displayWidth(row) <= 40);
  });

  test("handles tiny and non-finite row widths", () => {
    const item = makeItem("tiny");
    assert.equal(displayWidth(formatInboxRow(item, 0, 60_000)), 0);
    assert.ok(displayWidth(formatInboxRow(item, 1, 60_000)) <= 1);
    assert.ok(displayWidth(formatInboxRow(item, Number.NaN, 60_000)) <= 80);
    assert.ok(displayWidth(formatInboxRow(item, Number.POSITIVE_INFINITY, 60_000)) <= 80);
  });

  test("formats selected metadata on two truncated lines only when it fits", () => {
    const item = makeItem("metadata");
    const lines = selectedMetadataLines(
      {
        ...item,
        herdrSessionLabel: "default",
        paneLabel: "a very long transient pane title",
      },
      28,
    );

    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /Herdr: default/);
    assert.ok(lines.every((line) => displayWidth(line) <= 28));
    assert.deepEqual(selectedMetadataLines(item, 23), []);
  });

  test("calculates inbox capacity and keeps list offsets valid", () => {
    assert.equal(inboxViewportLines(undefined, 2, false), 19);
    assert.equal(inboxViewportLines(Number.NaN, 2, false), 19);
    assert.equal(inboxViewportLines(30, 2, false), 25);
    assert.equal(inboxViewportLines(4, 0, true), 1);

    assert.equal(clampListOffset(-1, 30, 19), 0);
    assert.equal(clampListOffset(999, 30, 19), 11);
    assert.equal(clampListOffset(999, 5, 19), 0);
    assert.equal(listOffsetForCursor(2, 3, 19), 2);
    assert.equal(listOffsetForCursor(22, 3, 19), 4);
    assert.equal(clampListOffset(listOffsetForCursor(99, 10, 19), 30, 19), 11);
    assert.equal(clampListOffset(11, 29, 19), 10);
  });

  test("renders one row per result with an unread indicator", () => {
    const fixture = makeFixture([makeItem("one", true), makeItem("two", false)]);
    const instance = render(h(createApp(fixture.port)));
    try {
      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /agent-one/);
      assert.match(frame, /agent-two/);
      assert.match(frame, /●\s+agent-one/);
    } finally {
      instance.unmount();
    }
  });

  test("renders an explicit empty state", () => {
    const fixture = makeFixture([]);
    const instance = render(h(createApp(fixture.port)));
    try {
      assert.match(instance.lastFrame() ?? "", /No results yet/);
    } finally {
      instance.unmount();
    }
  });

  test("moves down and opens the second result", async () => {
    const fixture = makeFixture([makeItem("one"), makeItem("two")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("\u001B[B");
      await tick();
      instance.stdin.write("\r");
      await tick();

      assert.deepEqual(fixture.calls.opened, ["two"]);
      assert.match(instance.lastFrame() ?? "", /Harvest Result · agent-two/);
    } finally {
      instance.unmount();
    }
  });

  test("archives the selected inbox row and refreshes the list", async () => {
    const fixture = makeFixture([makeItem("one"), makeItem("two")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("\u001B[B");
      await tick();
      instance.stdin.write("a");
      await tick();

      assert.deepEqual(fixture.calls.archived, ["two"]);
      assert.doesNotMatch(instance.lastFrame() ?? "", /agent-two/);
      assert.match(instance.lastFrame() ?? "", /Archived result two/);
    } finally {
      instance.unmount();
    }
  });

  test("pages the inbox by one viewport and keeps the selected row visible", async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      makeItem(`inbox-${String(index).padStart(2, "0")}`),
    );
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      assert.equal(hasAgent(instance.lastFrame() ?? "", "inbox-00"), true);
      assert.equal(hasAgent(instance.lastFrame() ?? "", "inbox-19"), false);

      await sendInput(instance, "\u001b[6~");
      let frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "inbox-19"), true);
      assert.equal(hasAgent(frame, "inbox-00"), false);

      await sendInput(instance, "\u001b[5~");
      frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "inbox-00"), true);
      assert.equal(hasAgent(frame, "inbox-19"), false);

      await sendInput(instance, "\u001b[6~");
      await sendInput(instance, "\u001b[B");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["inbox-20"]);
      await sendInput(instance, "\u001b");

      await sendInput(instance, "\u001b[6~");
      frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "inbox-29"), true);
      assert.equal(hasAgent(frame, "inbox-10"), false);
      await sendInput(instance, "\u001b[6~");
      assert.equal(hasAgent(instance.lastFrame() ?? "", "inbox-29"), true);

      await sendInput(instance, "\u001b[5~");
      frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "inbox-10"), true);
      assert.equal(hasAgent(frame, "inbox-29"), false);
      await sendInput(instance, "\u001b[5~");
      await sendInput(instance, "\u001b[5~");
      assert.equal(hasAgent(instance.lastFrame() ?? "", "inbox-00"), true);

      await sendInput(instance, "\u001b[6~");
      await sendInput(instance, "\u001b[6~");
      await sendInput(instance, "a");
      frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.archived, ["inbox-29"]);
      assert.equal(hasAgent(frame, "inbox-29"), false);
      assert.equal(hasAgent(frame, "inbox-28"), true);
      assert.match(frame, /Archived result inbox-29/);
    } finally {
      instance.unmount();
    }
  });

  test("truncates inbox chrome to one physical row at narrow terminal widths", async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      makeItem(`narrow-${String(index).padStart(2, "0")}`),
    );
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 80, 24);
      await sendInput(instance, "j");
      let frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 24);
      assert.equal(frame.split("\n").filter((line) => line.includes("↑/↓ or k/j move")).length, 1);
      assert.equal(agentRows(frame).length, 19);
      assert.equal(
        frame.split("\n").filter((line) => /^(?:Herdr:|Pane:)/.test(line.trim())).length,
        2,
      );

      await sendInput(instance, "y");
      frame = instance.lastFrame() ?? "";
      assert.equal(agentRows(frame).length, 18);

      setTerminalSize(instance, 40, 20);
      await sendInput(instance, "j");
      frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 20);
      assert.equal(agentRows(frame).length, 14);
      assert.equal(frame.split("\n").filter((line) => line.includes("↑/↓ or k/j move")).length, 1);
      assert.equal(
        frame.split("\n").filter((line) => /^(?:Herdr:|Pane:)/.test(line.trim())).length,
        2,
      );

      await sendInput(instance, "\u001b[6~");
      frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 20);
      assert.equal(hasAgent(frame, "narrow-16"), true);
      for (let index = 0; index < 4; index += 1) {
        await sendInput(instance, "\u001b[6~");
      }
      frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 20);
      assert.equal(hasAgent(frame, "narrow-29"), true);
    } finally {
      instance.unmount();
    }
  });

  test("truncates result chrome to one physical row at a narrow terminal width", async () => {
    const item = makeItem("result-narrow");
    const rawText = Array.from(
      { length: 30 },
      (_, index) => `result-line-${String(index).padStart(2, "0")}`,
    ).join("\n");
    const fixture = makeFixture([item], {
      details: new Map([[item.id, makeDetail(item, rawText)]]),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 20);
      await sendInput(instance, "\r");
      const frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 20);
      assert.equal(
        frame.split("\n").filter((line) => line.includes("↑/↓ or k/j scroll")).length,
        1,
      );
      assert.equal(frame.split("\n").filter((line) => /^Herdr:/.test(line.trim())).length, 1);
      assert.equal(
        frame.split("\n").filter((line) => /^line 1-15 of 30/.test(line.trim())).length,
        1,
      );
    } finally {
      instance.unmount();
    }
  });

  test("copies the selected row and states that OSC 52 delivery is unconfirmed", async () => {
    const fixture = makeFixture([makeItem("one")], {
      copy: async () => ({ provider: "osc52", confirmed: false }),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("y");
      await tick();

      assert.deepEqual(fixture.calls.copied, ["one"]);
      assert.match(instance.lastFrame() ?? "", /delivery not confirmed/);
      assert.doesNotMatch(instance.lastFrame() ?? "", /^Copied .*osc52/m);
    } finally {
      instance.unmount();
    }
  });

  test("shows confirmed copy status", async () => {
    const fixture = makeFixture([makeItem("one")], {
      copy: async () => ({ provider: "pbcopy", confirmed: true }),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("y");
      await tick();

      assert.match(instance.lastFrame() ?? "", /Copied result to clipboard \(pbcopy\)/);
    } finally {
      instance.unmount();
    }
  });

  test("renders ClipboardError text and attempted providers on copy failure", async () => {
    const fixture = makeFixture([makeItem("one")], {
      copy: async () => {
        throw new ClipboardError("Clipboard copy failed", ["pbcopy: denied", "osc52: not a TTY"]);
      },
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("y");
      await tick();

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Clipboard copy failed/);
      assert.match(frame, /pbcopy: denied/);
      assert.match(frame, /osc52: not a TTY/);
    } finally {
      instance.unmount();
    }
  });

  test("scrolls a long result and clamps at both ends", async () => {
    const item = makeItem("long");
    const rawText = Array.from({ length: 30 }, (_, index) => `line-${index}`).join("\n");
    const fixture = makeFixture([item], {
      details: new Map([[item.id, makeDetail(item, rawText)]]),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("\r");
      await tick();
      assert.match(instance.lastFrame() ?? "", /line-0/);

      instance.stdin.write("\u001B[B");
      await tick();
      assert.match(instance.lastFrame() ?? "", /line-1/);
      assert.doesNotMatch(instance.lastFrame() ?? "", /line-0\n/);

      for (let index = 0; index < 40; index += 1) {
        instance.stdin.write("\u001B[B");
        await tick();
      }
      assert.match(instance.lastFrame() ?? "", /line-29/);
      assert.doesNotMatch(instance.lastFrame() ?? "", /line-0\n/);

      for (let index = 0; index < 40; index += 1) {
        instance.stdin.write("\u001B[A");
        await tick();
      }
      assert.match(instance.lastFrame() ?? "", /line-0/);
    } finally {
      instance.unmount();
    }
  });

  test("pages a long result by one viewport and clamps without changing arrow steps", async () => {
    const item = makeItem("paged");
    const rawText = Array.from({ length: 50 }, (_, index) => `line-${index}`).join("\n");
    const fixture = makeFixture([item], {
      details: new Map([[item.id, makeDetail(item, rawText)]]),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /line 1-20 of 50/);

      await sendInput(instance, "\u001b[6~");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /line 21-40 of 50/);
      assert.doesNotMatch(frame, /line-0\n/);

      await sendInput(instance, "\u001b[5~");
      assert.match(instance.lastFrame() ?? "", /line 1-20 of 50/);
      await sendInput(instance, "\u001b[B");
      assert.match(instance.lastFrame() ?? "", /line 2-21 of 50/);
      await sendInput(instance, "\u001b[A");
      await sendInput(instance, "\u001b[5~");
      assert.match(instance.lastFrame() ?? "", /line 1-20 of 50/);

      await sendInput(instance, "\u001b[6~");
      await sendInput(instance, "\u001b[6~");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /line 31-50 of 50/);
      await sendInput(instance, "\u001b[6~");
      assert.match(instance.lastFrame() ?? "", /line 31-50 of 50/);
      await sendInput(instance, "\u001b[A");
      assert.match(instance.lastFrame() ?? "", /line 30-49 of 50/);
    } finally {
      instance.unmount();
    }
  });

  test("keeps long Result body lines to one row while paging by the logical viewport", async () => {
    const item = makeItem("long-body");
    const rawLines = Array.from(
      { length: 40 },
      (_, index) =>
        `body-line-${String(index).padStart(2, "0")} /workspace/${"nested/".repeat(12)}日本語🚀`,
    );
    const rawText = rawLines.join("\n");
    const details = new Map([[item.id, makeDetail(item, rawText)]]);
    const fixture = makeFixture([item], {
      details,
      copy: async (id) => {
        assert.equal(details.get(id)?.rawText, rawText);
        return { provider: "fake", confirmed: true };
      },
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 20);
      await sendInput(instance, "\r");
      let frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 20);
      assert.equal(resultBodyRows(frame).length, 15);
      assert.match(frame, /line 1-15 of 40/);
      assert.equal(
        frame.split("\n").filter((line) => line.includes("↑/↓ or k/j scroll")).length,
        1,
      );
      assert.equal(frame.split("\n").filter((line) => /^Herdr:/.test(line.trim())).length, 1);

      await sendInput(instance, "\u001b[6~");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /line 16-30 of 40/);
      assert.equal(resultBodyRows(frame).length, 15);
      assert.equal(frame.includes("body-line-15"), true);
      assert.equal(frame.includes("body-line-00"), false);

      await sendInput(instance, "\u001b[5~");
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);
      await sendInput(instance, "\u001b[B");
      assert.match(instance.lastFrame() ?? "", /line 2-16 of 40/);
      await sendInput(instance, "\u001b[A");
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);

      await sendInput(instance, "\u001b[6~");
      await sendInput(instance, "\u001b[6~");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /line 26-40 of 40/);
      assert.equal(resultBodyRows(frame).length, 15);
      await sendInput(instance, "\u001b[6~");
      assert.match(instance.lastFrame() ?? "", /line 26-40 of 40/);
      await sendInput(instance, "\u001b[5~");
      assert.match(instance.lastFrame() ?? "", /line 11-25 of 40/);

      await sendInput(instance, "y");
      assert.deepEqual(fixture.calls.copied, [item.id]);
      assert.equal(details.get(item.id)?.rawText, rawText);
    } finally {
      instance.unmount();
    }
  });

  test("keeps an empty Result body line to one physical row", async () => {
    const item = makeItem("empty-body");
    const rawText = [
      `body-line-00 ${"日本語🚀".repeat(20)}`,
      "",
      `body-line-02 ${"/very/long/path/".repeat(10)}`,
      `body-line-03 ${"/very/long/path/".repeat(10)}`,
      `body-line-04 ${"/very/long/path/".repeat(10)}`,
    ].join("\n");
    const fixture = makeFixture([item], {
      details: new Map([[item.id, makeDetail(item, rawText)]]),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 10);
      await sendInput(instance, "\r");
      const frame = instance.lastFrame() ?? "";
      assert.equal(frame.split("\n").length, 9);
      assert.match(frame, /line 1-5 of 5/);
      assert.equal(resultBodyRows(frame).length, 4);
    } finally {
      instance.unmount();
    }
  });

  test("returns to the inbox on Escape from the result view", async () => {
    const fixture = makeFixture([makeItem("one")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("\r");
      await tick();
      instance.stdin.write("\u001B");
      await tick();

      assert.match(instance.lastFrame() ?? "", /Harvest Result Inbox/);
      assert.doesNotMatch(instance.lastFrame() ?? "", /Harvest Result · agent-one/);
    } finally {
      instance.unmount();
    }
  });

  test("supports vi-style j and k movement without leaving the cursor range", async () => {
    const fixture = makeFixture([makeItem("one"), makeItem("two")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("j");
      await tick();
      instance.stdin.write("j");
      await tick();
      instance.stdin.write("k");
      await tick();
      instance.stdin.write("j");
      await tick();
      instance.stdin.write("\r");
      await tick();

      assert.deepEqual(fixture.calls.opened, ["two"]);
    } finally {
      instance.unmount();
    }
  });
});

/**
 * The Active and Archived collections share one cursor/offset model and one
 * navigation path; only the action keys and the chrome differ. Tab is the only
 * way to switch, and it is inert while a detail is open, so Esc always returns
 * to the collection the detail came from.
 */
describe("inbox collections", () => {
  test("switches between the active and archived collections with Tab", async () => {
    const fixture = makeFixture([
      makeItem("active-one"),
      makeItem("active-two"),
      makeArchivedItem("archived-one"),
    ]);
    const instance = render(h(createApp(fixture.port)));
    try {
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 2 results/);
      assert.equal(hasAgent(frame, "active-one"), true);
      assert.equal(hasAgent(frame, "archived-one"), false);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Results · 1 result/);
      assert.match(frame, /Newest archived first; select one to inspect it\./);
      assert.equal(hasAgent(frame, "archived-one"), true);
      assert.equal(hasAgent(frame, "active-one"), false);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 2 results/);
      assert.equal(hasAgent(frame, "active-one"), true);
      assert.equal(hasAgent(frame, "archived-one"), false);
    } finally {
      instance.unmount();
    }
  });

  test("shows a distinct empty state for each collection", async () => {
    const fixture = makeFixture([]);
    const instance = render(h(createApp(fixture.port)));
    try {
      assert.match(
        instance.lastFrame() ?? "",
        /No results yet\. Captured agent output will appear here\./,
      );

      await sendInput(instance, "\t");
      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Results · 0 results/);
      assert.match(frame, /No archived results\./);
      assert.doesNotMatch(frame, /No results yet/);
    } finally {
      instance.unmount();
    }
  });

  test("resets the cursor and list offset when the collection switches", async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      makeItem(`item-${String(index).padStart(2, "0")}`),
    );
    const fixture = makeFixture([...items, makeArchivedItem("archived-zero")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 80, 10);
      for (let index = 0; index < 20; index += 1) {
        await sendInput(instance, "j");
      }
      let frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "item-19"), true);
      assert.equal(hasAgent(frame, "item-00"), false);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "archived-zero"), true);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "item-00"), true);
      assert.equal(hasAgent(frame, "item-19"), false);

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["item-00"]);
    } finally {
      instance.unmount();
    }
  });

  test("navigates and opens results inside the archived collection", async () => {
    const archived = Array.from({ length: 25 }, (_, index) =>
      makeArchivedItem(`arch-${String(index).padStart(2, "0")}`),
    );
    const fixture = makeFixture([...archived, makeItem("active-zero")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "\t");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Results · 25 results/);
      assert.equal(hasAgent(frame, "arch-00"), true);
      assert.equal(hasAgent(frame, "active-zero"), false);

      await sendInput(instance, "\u001B[B");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-01/);

      await sendInput(instance, "\u001B");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Results · 25 results/);

      await sendInput(instance, "\u001B[6~");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-20/);

      await sendInput(instance, "\u001B");
      await sendInput(instance, "\u001B[5~");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-01/);

      await sendInput(instance, "\u001B");
      await sendInput(instance, "k");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-00/);
      assert.deepEqual(fixture.calls.opened, ["arch-01", "arch-20", "arch-01", "arch-00"]);
    } finally {
      instance.unmount();
    }
  });

  test("copies the selected archived result with y", async () => {
    const fixture = makeFixture([makeArchivedItem("arch-copy")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "\t");
      await sendInput(instance, "y");

      const frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.copied, ["arch-copy"]);
      assert.match(frame, /Copied result to clipboard \(fake\)/);
      assert.equal(hasAgent(frame, "arch-copy"), true);
    } finally {
      instance.unmount();
    }
  });

  test("restores the selected archived result and removes it from the collection", async () => {
    const fixture = makeFixture([makeArchivedItem("arch-one"), makeArchivedItem("arch-two")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "\t");
      await sendInput(instance, "r");

      const frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.restored, ["arch-one"]);
      assert.match(frame, /Restored result arch-one\./);
      assert.match(frame, /Harvest Archived Results · 1 result/);
      assert.equal(hasAgent(frame, "arch-one"), false);
      assert.equal(hasAgent(frame, "arch-two"), true);
    } finally {
      instance.unmount();
    }
  });

  test("restores the only archived result and shows the empty state", async () => {
    const fixture = makeFixture([makeArchivedItem("arch-only")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "\t");
      await sendInput(instance, "r");

      let frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.restored, ["arch-only"]);
      assert.match(frame, /Restored result arch-only\./);
      assert.match(frame, /No archived results\./);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 1 result/);
      assert.equal(hasAgent(frame, "arch-only"), true);
    } finally {
      instance.unmount();
    }
  });

  test("restores archived rows at the top, middle, and end with the cursor kept visible", async () => {
    const archived = Array.from({ length: 12 }, (_, index) =>
      makeArchivedItem(`arch-${String(index).padStart(2, "0")}`),
    );
    const fixture = makeFixture(archived);
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 80, 10);
      await sendInput(instance, "\t");

      await sendInput(instance, "r");
      let frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.restored, ["arch-00"]);
      assert.equal(hasAgent(frame, "arch-00"), false);
      assert.equal(hasAgent(frame, "arch-01"), true);

      for (let index = 0; index < 5; index += 1) {
        await sendInput(instance, "j");
      }
      await sendInput(instance, "r");
      frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.restored, ["arch-00", "arch-06"]);
      assert.equal(hasAgent(frame, "arch-06"), false);
      assert.equal(hasAgent(frame, "arch-07"), true);

      for (let index = 0; index < 12; index += 1) {
        await sendInput(instance, "j");
      }
      await sendInput(instance, "r");
      frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.restored, ["arch-00", "arch-06", "arch-11"]);
      assert.equal(hasAgent(frame, "arch-11"), false);
      assert.equal(hasAgent(frame, "arch-10"), true);

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened.at(-1), "arch-10");
    } finally {
      instance.unmount();
    }
  });

  test("ignores the other collection's action key", async () => {
    const fixture = makeFixture([makeItem("active-one"), makeArchivedItem("arch-one")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "r");
      assert.deepEqual(fixture.calls.restored, []);
      assert.equal(hasAgent(instance.lastFrame() ?? "", "active-one"), true);

      await sendInput(instance, "\t");
      await sendInput(instance, "a");
      const frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.archived, []);
      assert.match(frame, /Harvest Archived Results · 1 result/);
      assert.equal(hasAgent(frame, "arch-one"), true);
    } finally {
      instance.unmount();
    }
  });

  test("archives the last active result", async () => {
    const fixture = makeFixture([makeItem("only-active")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "a");

      const frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.archived, ["only-active"]);
      assert.match(frame, /Archived result only-active\./);
      assert.match(frame, /No results yet\. Captured agent output will appear here\./);
      assert.equal(hasAgent(frame, "only-active"), false);
    } finally {
      instance.unmount();
    }
  });

  test("swaps archive and restore by collection in the Result view", async () => {
    const fixture = makeFixture([makeArchivedItem("arch-one"), makeItem("active-one")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Result · agent-active-one/);
      assert.match(instance.lastFrame() ?? "", /y copy · a archive · Esc inbox/);

      await sendInput(instance, "r");
      assert.deepEqual(fixture.calls.restored, []);
      assert.match(instance.lastFrame() ?? "", /Harvest Result · agent-active-one/);

      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["active-one"]);
      assert.match(instance.lastFrame() ?? "", /Archived result active-one\./);
      assert.match(instance.lastFrame() ?? "", /Harvest Result Inbox/);

      await sendInput(instance, "\t");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-one/);
      assert.match(instance.lastFrame() ?? "", /y copy · r restore · Esc inbox/);

      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["active-one"]);
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-one/);

      await sendInput(instance, "r");
      const frame = instance.lastFrame() ?? "";
      assert.deepEqual(fixture.calls.restored, ["arch-one"]);
      assert.match(frame, /Restored result arch-one\./);
      assert.match(frame, /Harvest Archived Results · 1 result/);
      assert.equal(hasAgent(frame, "arch-one"), false);
      assert.equal(hasAgent(frame, "active-one"), true);
    } finally {
      instance.unmount();
    }
  });

  test("copies an archived detail, pages it, and returns to the Archived collection", async () => {
    const item = makeArchivedItem("arch");
    const rawText = Array.from(
      { length: 40 },
      (_, index) => `body-line-${String(index).padStart(2, "0")} ${"/nested/".repeat(12)}日本語🚀`,
    ).join("\n");
    const details = new Map([[item.id, makeDetail(item, rawText)]]);
    const copied: string[] = [];
    const fixture = makeFixture([item], {
      details,
      copy: async (id) => {
        copied.push(id);
        assert.equal(details.get(id)?.rawText, rawText);
        return { provider: "fake", confirmed: true };
      },
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 20);
      await sendInput(instance, "\t");
      await sendInput(instance, "\r");

      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Result · agent-arch/);
      assert.match(frame, /line 1-15 of 40/);
      assert.equal(resultBodyRows(frame).length, 15);

      await sendInput(instance, "y");
      assert.deepEqual(copied, ["arch"]);
      const copiedStatus = `Copied ${formatBytes(Buffer.byteLength(rawText, "utf8"))} to clipboard (fake)`;
      const frameAfterCopy = instance.lastFrame() ?? "";
      assert.equal(frameAfterCopy.includes(copiedStatus), true, frameAfterCopy);

      await sendInput(instance, "\u001B[6~");
      assert.match(instance.lastFrame() ?? "", /line 16-30 of 40/);
      await sendInput(instance, "\u001B[5~");
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);
      await sendInput(instance, "\u001B[B");
      assert.match(instance.lastFrame() ?? "", /line 2-16 of 40/);

      await sendInput(instance, "\u001B[<65;1;1M");
      assert.match(instance.lastFrame() ?? "", /line 5-19 of 40/);
      await sendInput(instance, "\u001B[<64;1;1M");
      assert.match(instance.lastFrame() ?? "", /line 2-16 of 40/);

      await sendInput(instance, "\u001B");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Results · 1 result/);
      assert.equal(hasAgent(frame, "arch"), true);
    } finally {
      instance.unmount();
    }
  });

  test("ignores Tab while a detail is open", async () => {
    const fixture = makeFixture([makeItem("active-one"), makeArchivedItem("arch-one")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "\r");
      await sendInput(instance, "\t");
      assert.match(instance.lastFrame() ?? "", /Harvest Result · agent-active-one/);
      assert.doesNotMatch(instance.lastFrame() ?? "", /Archived/);

      await sendInput(instance, "\u001B");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 1 result/);
      assert.equal(hasAgent(frame, "active-one"), true);

      await sendInput(instance, "\t");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-one/);

      await sendInput(instance, "\t");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Result · agent-arch-one/);

      await sendInput(instance, "\u001B");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Results · 1 result/);
      assert.equal(hasAgent(frame, "arch-one"), true);
    } finally {
      instance.unmount();
    }
  });
});

describe("inbox search", () => {
  test("edits a query with / and cancels the draft with Esc", async () => {
    const fixture = makeFixture([makeItem("alpha"), makeArchivedItem("beta")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active/);
      assert.match(frame, /Search: _/);
      assert.match(frame, /\/ edit · Tab scope · Esc clear/);

      await sendInput(instance, "al");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Search: al_/);
      // Typing does not filter until Enter: the collection is still listed whole.
      assert.equal(hasAgent(frame, "alpha"), true);

      // Terminals send DEL for Backspace.
      await sendInput(instance, "\u007f");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Search: a_/);

      // Esc cancels a draft that was never applied, leaving search entirely.
      await sendInput(instance, "\u001b");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 1 result/);
      assert.doesNotMatch(frame, /Search:/);
      assert.match(frame, /Unread results stay at the top/);
    } finally {
      instance.unmount();
    }
  });

  test("treats action keys as query text while editing", async () => {
    const fixture = makeFixture([makeItem("alpha"), makeArchivedItem("beta")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      for (const chunk of ["q", "a", "r", "y", "j", "k", "/", " "]) {
        await sendInput(instance, chunk);
      }

      const frame = instance.lastFrame() ?? "";
      assert.equal(frame.includes("Search: qaryjk/ _"), true);
      assert.deepEqual(fixture.calls, { opened: [], archived: [], restored: [], copied: [] });
    } finally {
      instance.unmount();
    }
  });

  test("keeps mouse reports out of the query while editing", async () => {
    const fixture = makeFixture([makeItem("alpha")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      // Press, release, and drag reports are not typed text and not actions.
      await sendInput(instance, "\u001B[<0;10;5M");
      await sendInput(instance, "\u001B[<0;10;5m");
      await sendInput(instance, "\u001B[<32;11;5M");

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Search: _/);
      assert.equal(hasAgent(frame, "alpha"), true);
      assert.deepEqual(fixture.calls.archived, []);
      assert.deepEqual(fixture.calls.opened, []);
    } finally {
      instance.unmount();
    }
  });

  test("applies a search with Enter, filters the list, and resets the cursor", async () => {
    const fixture = makeFixture([
      makeItem("alpha-one"),
      makeItem("alpha-two"),
      makeItem("beta-one"),
    ]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "j");
      await sendInput(instance, "/");
      await sendInput(instance, "alpha");
      await sendInput(instance, "\r");

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 2 matches/);
      assert.match(frame, /Search: alpha/);
      assert.equal(hasAgent(frame, "alpha-one"), true);
      assert.equal(hasAgent(frame, "alpha-two"), true);
      assert.equal(hasAgent(frame, "beta-one"), false);

      // The applied search restarted the cursor on the first match.
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["alpha-one"]);
    } finally {
      instance.unmount();
    }
  });

  test("keeps navigation, paging, the wheel, copy, and open working under a search", async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      makeItem(`needle-${String(index).padStart(2, "0")}`),
    );
    const fixture = makeFixture([...items, makeItem("other")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 80, 10);
      await sendInput(instance, "/");
      await sendInput(instance, "needle");
      await sendInput(instance, "\r");

      // 10 terminal rows minus 3 chrome rows and 2 metadata rows leave 5 rows.
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 30 matches/);
      assert.equal(hasAgent(frame, "needle-00"), true);
      assert.equal(hasAgent(frame, "needle-04"), true);
      assert.equal(hasAgent(frame, "needle-05"), false);
      assert.equal(hasAgent(frame, "other"), false);

      // Arrows and vi keys move the selection: down, down, up leaves row 1
      // selected, which opening proves, and returning keeps the search.
      await sendInput(instance, "\u001B[B");
      await sendInput(instance, "j");
      await sendInput(instance, "k");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["needle-01"]);
      await sendInput(instance, "\u001B");
      assert.match(instance.lastFrame() ?? "", /Harvest Result Search · Active · 30 matches/);

      // The arrow-up step returns the selection to the first match.
      await sendInput(instance, "\u001B[A");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["needle-01", "needle-00"]);
      await sendInput(instance, "\u001B");

      await sendInput(instance, "\u001B[6~");
      frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "needle-00"), false);
      assert.equal(hasAgent(frame, "needle-05"), true);
      assert.equal(hasAgent(frame, "needle-06"), false);

      await sendInput(instance, "\u001B[5~");
      frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "needle-00"), true);
      assert.equal(hasAgent(frame, "needle-05"), false);

      await sendInput(instance, "\u001B[<65;10;5M");
      await sendInput(instance, "y");
      assert.deepEqual(fixture.calls.copied, ["needle-03"]);

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["needle-01", "needle-00", "needle-03"]);
    } finally {
      instance.unmount();
    }
  });

  test("cycles the search scope with Tab while preserving the query", async () => {
    const fixture = makeFixture([
      makeItem("alpha-one"),
      makeItem("alpha-two"),
      makeArchivedItem("alpha-archived"),
      makeItem("beta-one"),
    ]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "alpha");
      await sendInput(instance, "\r");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 2 matches/);
      assert.equal(hasAgent(frame, "alpha-archived"), false);

      // Select the second match, then switch scope: the cursor must reset.
      await sendInput(instance, "j");
      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Archived · 1 match/);
      assert.match(frame, /Search: alpha/);
      assert.equal(hasAgent(frame, "alpha-archived"), true);
      assert.equal(hasAgent(frame, "alpha-one"), false);

      // Opening and returning keeps the same search, scope, and results.
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["alpha-archived"]);
      await sendInput(instance, "\u001b");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Archived · 1 match/);
      assert.match(frame, /Search: alpha/);
      assert.equal(hasAgent(frame, "alpha-archived"), true);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · All · 3 matches/);
      assert.equal(hasAgent(frame, "alpha-one"), true);
      assert.equal(hasAgent(frame, "alpha-two"), true);
      assert.equal(hasAgent(frame, "alpha-archived"), true);
      assert.equal(hasAgent(frame, "beta-one"), false);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 2 matches/);
      assert.equal(hasAgent(frame, "alpha-archived"), false);
    } finally {
      instance.unmount();
    }
  });

  test("keeps plain Tab switching collections once the search is cleared", async () => {
    const fixture = makeFixture([makeItem("alpha"), makeArchivedItem("beta")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "alpha");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Result Search · Active · 1 match/);

      await sendInput(instance, "\u001b");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 1 result/);
      assert.doesNotMatch(frame, /Search:/);

      // Plain Tab still toggles the two collections and never reaches "all".
      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Archived Results · 1 result/);
      assert.equal(hasAgent(frame, "beta"), true);

      await sendInput(instance, "\t");
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 1 result/);
      assert.doesNotMatch(frame, /Harvest Result Search/);
      assert.doesNotMatch(frame, /Search:/);
    } finally {
      instance.unmount();
    }
  });

  test("leaves search when Enter applies a blank query", async () => {
    const fixture = makeFixture([makeItem("alpha"), makeArchivedItem("beta")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "   ");
      await sendInput(instance, "\r");

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox · 1 result/);
      assert.doesNotMatch(frame, /Search:/);
      assert.doesNotMatch(frame, /No results match/);
      assert.equal(hasAgent(frame, "alpha"), true);
    } finally {
      instance.unmount();
    }
  });

  test("shows the search empty state for a query with no matches", async () => {
    const fixture = makeFixture([makeItem("alpha")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "zzz");
      await sendInput(instance, "\r");

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 0 matches/);
      assert.match(frame, /No results match "zzz"/);
      assert.doesNotMatch(frame, /No results yet/);
    } finally {
      instance.unmount();
    }
  });

  test("archives matches out of an active search and clamps the cursor", async () => {
    const fixture = makeFixture([
      makeItem("needle-01"),
      makeItem("needle-02"),
      makeItem("needle-03"),
      makeItem("other"),
    ]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "needle");
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /Harvest Result Search · Active · 3 matches/);

      await sendInput(instance, "j");
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-02"]);
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 2 matches/);
      assert.equal(hasAgent(frame, "needle-01"), true);
      assert.equal(hasAgent(frame, "needle-02"), false);
      assert.equal(hasAgent(frame, "needle-03"), true);

      // The cursor clamped onto the row that followed the archived one.
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-02", "needle-03"]);
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 1 match/);
      assert.equal(hasAgent(frame, "needle-01"), true);

      // Archiving the only match empties the search and shows the empty state.
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-02", "needle-03", "needle-01"]);
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 0 matches/);
      assert.match(frame, /No results match "needle"/);
      assert.equal(agentRows(frame).length, 0);
    } finally {
      instance.unmount();
    }
  });

  test("restores matches out of an archived search and clamps the cursor", async () => {
    const fixture = makeFixture([
      makeItem("needle-active"),
      makeArchivedItem("needle-arch-01"),
      makeArchivedItem("needle-arch-02"),
    ]);
    const instance = render(h(createApp(fixture.port)));
    try {
      // The entry scope follows the collection the search starts from.
      await sendInput(instance, "\t");
      assert.match(instance.lastFrame() ?? "", /Harvest Archived Results · 2 results/);
      await sendInput(instance, "/");
      await sendInput(instance, "needle");
      await sendInput(instance, "\r");
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Archived · 2 matches/);
      assert.equal(hasAgent(frame, "needle-active"), false);

      await sendInput(instance, "j");
      await sendInput(instance, "r");
      assert.deepEqual(fixture.calls.restored, ["needle-arch-02"]);
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Archived · 1 match/);
      assert.equal(hasAgent(frame, "needle-arch-01"), true);
      assert.equal(hasAgent(frame, "needle-arch-02"), false);

      await sendInput(instance, "r");
      assert.deepEqual(fixture.calls.restored, ["needle-arch-02", "needle-arch-01"]);
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Archived · 0 matches/);
      assert.match(frame, /No results match "needle"/);
    } finally {
      instance.unmount();
    }
  });

  test("keys archive and restore off the row under the all scope", async () => {
    const fixture = makeFixture([makeItem("needle-active"), makeArchivedItem("needle-arch")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "needle");
      await sendInput(instance, "\r");
      await sendInput(instance, "\t");
      await sendInput(instance, "\t");

      // Equal capture times order by id, so the archived row comes first and
      // the visible list mixes both collections.
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · All · 2 matches/);
      assert.equal(hasAgent(frame, "needle-arch"), true);
      assert.equal(hasAgent(frame, "needle-active"), true);

      // The archived row restores; "a" on it is ignored.
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, []);
      assert.deepEqual(fixture.calls.restored, []);
      await sendInput(instance, "r");
      assert.deepEqual(fixture.calls.restored, ["needle-arch"]);
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · All · 2 matches/);
      assert.equal(hasAgent(frame, "needle-arch"), true);

      // The row stayed in the all scope with its archive state flipped, so now
      // "a" archives it again.
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-arch"]);
      assert.deepEqual(fixture.calls.restored, ["needle-arch"]);
      assert.equal(hasAgent(instance.lastFrame() ?? "", "needle-arch"), true);

      // Same rule on the active row: "r" is ignored and "a" archives it.
      await sendInput(instance, "j");
      await sendInput(instance, "r");
      assert.deepEqual(fixture.calls.restored, ["needle-arch"]);
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-arch", "needle-active"]);
      assert.match(instance.lastFrame() ?? "", /Harvest Result Search · All · 2 matches/);
    } finally {
      instance.unmount();
    }
  });

  test("keeps search chrome to one physical row per line at narrow widths", async () => {
    const items = Array.from({ length: 30 }, (_, index) =>
      makeItem(`search-${String(index).padStart(2, "0")}`),
    );
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 12);
      await sendInput(instance, "/");
      await sendInput(instance, "search");
      await sendInput(instance, "\r");

      const frame = instance.lastFrame() ?? "";
      assert.ok(frame.split("\n").length <= 12);
      const lines = frame.split("\n");
      assert.equal(lines.filter((line) => line.includes("Harvest Result Search")).length, 1);
      assert.equal(lines.filter((line) => line.includes("Search: search")).length, 1);
      assert.equal(lines.filter((line) => line.includes("/ edit · Tab scope")).length, 1);
      // 12 terminal rows minus 3 chrome rows and 2 metadata rows leave 7 rows.
      assert.equal(agentRows(frame).length, 7);
    } finally {
      instance.unmount();
    }
  });

  test("archives the opened match out of an active search", async () => {
    const fixture = makeFixture([
      makeItem("needle-01"),
      makeItem("needle-02"),
      makeItem("needle-03"),
      makeItem("other"),
    ]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "needle");
      await sendInput(instance, "\r");
      await sendInput(instance, "j");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["needle-02"]);
      assert.match(instance.lastFrame() ?? "", /Harvest Result · agent-needle-02/);

      // Archiving from the detail returns to the same search, refreshed.
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-02"]);
      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · Active · 2 matches/);
      assert.match(frame, /Search: needle/);
      assert.match(frame, /Archived result needle-02/);
      assert.equal(hasAgent(frame, "needle-01"), true);
      assert.equal(hasAgent(frame, "needle-02"), false);
      assert.equal(hasAgent(frame, "needle-03"), true);
      assert.equal(hasAgent(frame, "other"), false);

      // The cursor clamped onto the row that followed the archived one.
      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-02", "needle-03"]);
    } finally {
      instance.unmount();
    }
  });

  test("archives the opened active match under the all scope and keeps the row", async () => {
    const fixture = makeFixture([makeItem("needle-active"), makeArchivedItem("needle-arch")]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, "/");
      await sendInput(instance, "needle");
      await sendInput(instance, "\r");
      await sendInput(instance, "\t");
      await sendInput(instance, "\t");
      // The archived row sorts first, so row two is the active match.
      await sendInput(instance, "j");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["needle-active"]);

      await sendInput(instance, "a");
      assert.deepEqual(fixture.calls.archived, ["needle-active"]);
      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Search · All · 2 matches/);
      assert.match(frame, /Search: needle/);
      assert.equal(hasAgent(frame, "needle-active"), true);
      assert.equal(hasAgent(frame, "needle-arch"), true);

      // The row stayed visible with its state flipped, so r restores it now.
      await sendInput(instance, "r");
      assert.deepEqual(fixture.calls.restored, ["needle-active"]);
      assert.deepEqual(fixture.calls.archived, ["needle-active"]);
      assert.match(instance.lastFrame() ?? "", /Harvest Result Search · All · 2 matches/);
    } finally {
      instance.unmount();
    }
  });
});

describe("inbox search with a real store", () => {
  test("searches and cycles scope through the real service", async () => {
    const store = new SqliteResultStore(openDatabase(":memory:"));
    try {
      const service = createInboxService({
        store,
        clipboard: { name: "fake", copy: async () => ({ provider: "fake", confirmed: true }) },
        now: () => 9_000,
      });

      insertResult(
        store,
        makeCaptureInput({
          capturedAtMs: 400,
          agentName: "agent-build-jp",
          workspaceName: "api",
          paneId: "pane-jp",
          rawText: "ビルド完了 世界 🚀",
        }),
      );
      insertResult(
        store,
        makeCaptureInput({
          capturedAtMs: 300,
          agentName: "agent-coverage-pct",
          workspaceName: "web",
          paneId: "pane-pct",
          rawText: "coverage 100% done_with_underscores",
        }),
      );
      insertResult(
        store,
        makeCaptureInput({
          capturedAtMs: 200,
          agentName: "agent-release-active",
          workspaceName: "web",
          paneId: "pane-rel-active",
          rawText: "RELEASE notes",
        }),
      );
      const archived = insertResult(
        store,
        makeCaptureInput({
          capturedAtMs: 100,
          agentName: "agent-release-archived",
          workspaceName: "api",
          paneId: "pane-rel-archived",
          rawText: "release archive",
        }),
      );
      assert.notEqual(store.archive(archived.id, 5_000), null);

      const instance = render(h(createApp(service)));
      try {
        // Active search matches the mixed-case row and excludes the archived one.
        await sendInput(instance, "/");
        await sendInput(instance, "release");
        await sendInput(instance, "\r");
        let frame = instance.lastFrame() ?? "";
        assert.match(frame, /Harvest Result Search · Active · 1 match/);
        assert.match(frame, /Search: release/);
        assert.equal(hasAgent(frame, "release-active"), true);
        assert.equal(hasAgent(frame, "release-archived"), false);
        assert.equal(hasAgent(frame, "build-jp"), false);

        // Archived scope keeps the query and finds the archived row only.
        await sendInput(instance, "\t");
        frame = instance.lastFrame() ?? "";
        assert.match(frame, /Harvest Result Search · Archived · 1 match/);
        assert.match(frame, /Search: release/);
        assert.equal(hasAgent(frame, "release-archived"), true);
        assert.equal(hasAgent(frame, "release-active"), false);

        // All scope shows both, newest capture first.
        await sendInput(instance, "\t");
        frame = instance.lastFrame() ?? "";
        assert.match(frame, /Harvest Result Search · All · 2 matches/);
        const rows = agentRows(frame);
        assert.equal(rows[0]?.includes("release-active"), true);
        assert.equal(rows[1]?.includes("release-archived"), true);

        // Esc clears back to the collection the search started from.
        await sendInput(instance, "\u001b");
        frame = instance.lastFrame() ?? "";
        assert.match(frame, /Harvest Result Inbox · 3 results/);
        assert.doesNotMatch(frame, /Search:/);

        // A literal % and a Japanese query both match the real stored text.
        await sendInput(instance, "/");
        await sendInput(instance, "100%");
        await sendInput(instance, "\r");
        frame = instance.lastFrame() ?? "";
        assert.match(frame, /Harvest Result Search · Active · 1 match/);
        assert.equal(hasAgent(frame, "coverage-pct"), true);
        assert.equal(hasAgent(frame, "release-active"), false);

        await sendInput(instance, "\u001b");
        await sendInput(instance, "/");
        await sendInput(instance, "完了");
        await sendInput(instance, "\r");
        frame = instance.lastFrame() ?? "";
        assert.match(frame, /Harvest Result Search · Active · 1 match/);
        assert.match(frame, /Search: 完了/);
        assert.equal(hasAgent(frame, "build-jp"), true);
        assert.equal(hasAgent(frame, "coverage-pct"), false);

        // Archiving through the list refreshes through the real service, so the
        // applied query (not the plain collection) drives the re-list.
        await sendInput(instance, "a");
        frame = instance.lastFrame() ?? "";
        assert.match(frame, /Harvest Result Search · Active · 0 matches/);
        assert.match(frame, /No results match "完了"/);
        assert.equal(hasAgent(frame, "build-jp"), false);
      } finally {
        instance.unmount();
      }
    } finally {
      store.close();
    }
  });
});
