import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type { InboxDetail, InboxItem, InboxPort } from "../src/app/inbox-service.ts";
import type { CopyReport } from "../src/clipboard/provider.ts";
import { ClipboardError } from "../src/clipboard/provider.ts";
import { createApp } from "../src/tui/app.ts";
import { displayWidth, formatInboxRow, selectedMetadataLines } from "../src/tui/inbox-view.ts";

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

function makeDetail(item: InboxItem, rawText = `first-${item.id}\nsecond-${item.id}`): InboxDetail {
  return {
    ...item,
    rawText,
    captureSource: "test",
    captureLineCount: rawText.split("\n").length,
    paneId: `pane-${item.id}`,
  };
}

function makeFixture(items: InboxItem[], options: FixtureOptions = {}): Fixture {
  let activeItems = [...items];
  const details = options.details ?? new Map(items.map((item) => [item.id, makeDetail(item)]));
  const calls = { opened: [], archived: [], copied: [] } as Fixture["calls"];
  const port: InboxPort = {
    list: () => activeItems,
    open: (id) => {
      calls.opened.push(id);
      return details.get(id) ?? null;
    },
    archive: (id) => {
      calls.archived.push(id);
      const before = activeItems.length;
      activeItems = activeItems.filter((item) => item.id !== id);
      return activeItems.length !== before;
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
