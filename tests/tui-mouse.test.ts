import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { render } from "ink-testing-library";
import React from "react";
import type { InboxDetail, InboxItem, InboxPort } from "../src/app/inbox-service.ts";
import type { CopyReport } from "../src/clipboard/provider.ts";
import { createApp } from "../src/tui/app.ts";
import {
  disableWheelReporting,
  enableWheelReporting,
  parseWheelEvent,
  parseWheelReport,
  WHEEL_STEP,
  type WheelOutput,
} from "../src/tui/mouse.ts";

const h = React.createElement;

/** Complete reports as the terminal sends them (ESC still attached). */
const WHEEL_DOWN = "\u001B[<65;1;1M";
const WHEEL_UP = "\u001B[<64;1;1M";

const WHEEL_UP_BUTTONS = [64, 68, 72, 76, 80, 84, 88, 92];
const WHEEL_DOWN_BUTTONS = [65, 69, 73, 77, 81, 85, 89, 93];

interface FakeStdout extends WheelOutput {
  readonly writes: string[];
}

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

function makeItems(count: number, prefix = "item"): InboxItem[] {
  return Array.from({ length: count }, (_, index) =>
    makeItem(`${prefix}-${String(index).padStart(2, "0")}`),
  );
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

function makeFakeStdout(options: { isTTY?: boolean; failure?: Error } = {}): FakeStdout {
  const writes: string[] = [];
  return {
    writes,
    isTTY: options.isTTY,
    write: (chunk: string): boolean => {
      if (options.failure !== undefined) {
        throw options.failure;
      }
      writes.push(chunk);
      return true;
    },
  };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
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

function hasAgent(frame: string, id: string): boolean {
  return frame.split("\n").some((line) => line.includes(`agent-${id} `));
}

function resultBodyRows(frame: string): string[] {
  return frame.split("\n").filter((line) => line.includes("body-line-"));
}

describe("wheel report parsing", () => {
  test("classifies complete wheel reports with and without the stripped escape", () => {
    assert.equal(WHEEL_STEP, 3);
    assert.equal(parseWheelEvent("\u001B[<64;31;11M"), "up");
    assert.equal(parseWheelEvent("[<64;31;11M"), "up");
    assert.equal(parseWheelEvent("\u001B[<65;31;11M"), "down");
    assert.equal(parseWheelEvent("[<65;31;11M"), "down");
    assert.equal(parseWheelReport("\u001B[<64;31;11M"), "up");
    assert.equal(parseWheelReport("[<64;31;11M"), "up");
    assert.equal(parseWheelReport("\u001B[<65;5;9M"), "down");
  });

  test("classifies every modifier variant in both directions", () => {
    for (const button of WHEEL_UP_BUTTONS) {
      assert.equal(parseWheelEvent(`[<${button};7;3M`), "up", `button ${button}`);
      assert.equal(parseWheelEvent(`\u001B[<${button};1;1M`), "up", `escaped button ${button}`);
    }
    for (const button of WHEEL_DOWN_BUTTONS) {
      assert.equal(parseWheelEvent(`[<${button};7;3M`), "down", `button ${button}`);
      assert.equal(parseWheelEvent(`\u001B[<${button};1;1M`), "down", `escaped button ${button}`);
    }
  });

  test("classifies each report of a burst on its own", () => {
    const burst = ["[<65;1;1M", "[<65;2;1M", "[<64;3;1M", "\u001B[<69;4;5M"];

    assert.deepEqual(
      burst.map((report) => parseWheelEvent(report)),
      ["down", "down", "up", "down"],
    );
    // A chunk that holds several reports is not one report; Ink splits those before useInput.
    assert.equal(parseWheelEvent(burst.join("")), null);
  });

  test("ignores presses, releases, motion, horizontal wheels, and extra buttons", () => {
    for (const button of [0, 1, 2, 3]) {
      assert.equal(parseWheelEvent(`[<${button};10;20M`), null, `press ${button}`);
      assert.equal(parseWheelEvent(`[<${button};10;20m`), null, `release ${button}`);
    }
    for (const button of [64, 65, 66, 67]) {
      assert.equal(parseWheelEvent(`[<${button};10;20m`), null, `release ${button}`);
    }
    for (const button of [96, 97, 100, 101, 104, 105]) {
      assert.equal(parseWheelEvent(`[<${button};10;20M`), null, `motion ${button}`);
    }
    for (const button of [66, 67, 70, 71, 74, 75]) {
      assert.equal(parseWheelEvent(`[<${button};10;20M`), null, `horizontal ${button}`);
    }
    for (const button of [128, 129, 192]) {
      assert.equal(parseWheelEvent(`[<${button};10;20M`), null, `extra button ${button}`);
    }
  });

  test("ignores malformed and empty input", () => {
    const ignored = [
      "",
      " ",
      "\n",
      "[<",
      "\u001B[<",
      "[<M",
      "[<;1;1M",
      "[<65;;1M",
      "[<65;1;M",
      "[<65;1M",
      "[<65;1;1",
      "[<65;1;1;1M",
      "[<65;1;1MX",
      "[<65;1;1Z",
      "[<a;1;1M",
      "[<65;a;bM",
      "[<-1;1;1M",
      "65;1;1M",
      "[65;1;1M",
      "j",
    ];
    for (const input of ignored) {
      assert.equal(parseWheelEvent(input), null, JSON.stringify(input));
    }
  });
});

describe("wheel reporting lifecycle", () => {
  test("enable writes the mouse-reporting sequences in order", () => {
    const stdout = makeFakeStdout();

    enableWheelReporting(stdout);

    assert.deepEqual(stdout.writes, ["\u001B[?1000h", "\u001B[?1006h"]);
  });

  test("disable writes the disable sequences in order", () => {
    const stdout = makeFakeStdout();

    disableWheelReporting(stdout);

    assert.deepEqual(stdout.writes, ["\u001B[?1006l", "\u001B[?1000l"]);
  });

  test("enable then disable restores the terminal state", () => {
    const stdout = makeFakeStdout();

    enableWheelReporting(stdout);
    disableWheelReporting(stdout);

    assert.deepEqual(stdout.writes, [
      "\u001B[?1000h",
      "\u001B[?1006h",
      "\u001B[?1006l",
      "\u001B[?1000l",
    ]);
  });

  test("disable is safe to call twice", () => {
    const stdout = makeFakeStdout();

    disableWheelReporting(stdout);
    disableWheelReporting(stdout);

    assert.deepEqual(stdout.writes, [
      "\u001B[?1006l",
      "\u001B[?1000l",
      "\u001B[?1006l",
      "\u001B[?1000l",
    ]);
  });

  test("skips writes when stdout is not a TTY", () => {
    const stdout = makeFakeStdout({ isTTY: false });

    enableWheelReporting(stdout);
    disableWheelReporting(stdout);

    assert.deepEqual(stdout.writes, []);
  });

  test("treats an unknown isTTY as a TTY", () => {
    const stdout = makeFakeStdout();

    assert.equal(stdout.isTTY, undefined);
    enableWheelReporting(stdout);

    assert.deepEqual(stdout.writes, ["\u001B[?1000h", "\u001B[?1006h"]);
  });

  test("never throws when the stream rejects writes", () => {
    const stdout = makeFakeStdout({ failure: new Error("write EPIPE") });

    assert.doesNotThrow(() => enableWheelReporting(stdout));
    assert.doesNotThrow(() => disableWheelReporting(stdout));
    assert.deepEqual(stdout.writes, []);
  });
});

describe("wheel navigation in the TUI", () => {
  test("moves the inbox selection three results per wheel report and clamps at both ends", async () => {
    const items = makeItems(10);
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, WHEEL_DOWN);
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, [items[3]?.id]);

      await sendInput(instance, "\u001B");
      await sendInput(instance, WHEEL_UP);
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, [items[3]?.id, items[0]?.id]);

      await sendInput(instance, "\u001B");
      await sendInput(instance, WHEEL_UP);
      await sendInput(instance, WHEEL_UP);
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened.at(-1), items[0]?.id);

      await sendInput(instance, "\u001B");
      for (let index = 0; index < 10; index += 1) {
        await sendInput(instance, WHEEL_DOWN);
      }
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened.at(-1), items.at(-1)?.id);
    } finally {
      instance.unmount();
    }
  });

  test("keeps the selected result visible while the wheel scrolls a long list", async () => {
    const items = makeItems(30);
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 80, 10);
      for (let index = 0; index < 3; index += 1) {
        await sendInput(instance, WHEEL_DOWN);
      }

      const frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "item-09"), true);
      assert.equal(hasAgent(frame, "item-00"), false);

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["item-09"]);
    } finally {
      instance.unmount();
    }
  });

  test("keeps j/k, arrows, and page keys unchanged after wheel reports", async () => {
    const items = makeItems(30);
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, WHEEL_DOWN);
      await sendInput(instance, "j");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, [items[4]?.id]);

      await sendInput(instance, "\u001B");
      await sendInput(instance, "k");
      await sendInput(instance, "\u001B[B");
      await sendInput(instance, "\u001B[6~");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened.at(-1), items[23]?.id);

      await sendInput(instance, "\u001B");
      await sendInput(instance, "\u001B[A");
      await sendInput(instance, "\u001B[5~");
      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened.at(-1), items[3]?.id);
    } finally {
      instance.unmount();
    }
  });

  test("ignores clicks, releases, motion, horizontal, malformed, and truncated mouse input", async () => {
    const items = [makeItem("one"), makeItem("two")];
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      const ignored = [
        "\u001B[<0;1;1M", // left press
        "\u001B[<0;1;1m", // left release
        "\u001B[<2;1;1M", // right press, which Herdr handles before the pane sees it
        "\u001B[<32;1;1M", // drag motion
        "\u001B[<64;1;1m", // wheel release
        "\u001B[<66;1;1M", // horizontal wheel
        "\u001B[<67;1;1M", // horizontal wheel
        "\u001B[<96;1;1M", // motion plus wheel
        "\u001B[<;1;1M", // malformed
        "\u001B[<65;1;1", // missing terminator
        "",
      ];
      for (const input of ignored) {
        await sendInput(instance, input);
      }

      // A truncated sequence is flushed as literal input after Ink's pending-escape delay.
      instance.stdin.write("\u001B[<");
      await tick();
      await tick();

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /Harvest Result Inbox/);
      assert.equal(hasAgent(frame, "one"), true);
      assert.deepEqual(fixture.calls, { opened: [], archived: [], copied: [] });

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["one"]);
    } finally {
      instance.unmount();
    }
  });

  test("ignores wheel reports in an empty inbox", async () => {
    const fixture = makeFixture([]);
    const instance = render(h(createApp(fixture.port)));
    try {
      await sendInput(instance, WHEEL_DOWN);
      await sendInput(instance, WHEEL_UP);

      assert.match(instance.lastFrame() ?? "", /No results yet/);
      assert.deepEqual(fixture.calls.opened, []);
    } finally {
      instance.unmount();
    }
  });

  test("scrolls the Result body three lines per wheel report and clamps at both ends", async () => {
    const item = makeItem("wheeled");
    const rawText = Array.from(
      { length: 40 },
      (_, index) => `body-line-${String(index).padStart(2, "0")} ${"/nested/".repeat(12)}日本語🚀`,
    ).join("\n");
    const fixture = makeFixture([item], {
      details: new Map([[item.id, makeDetail(item, rawText)]]),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 20);
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);

      await sendInput(instance, WHEEL_DOWN);
      let frame = instance.lastFrame() ?? "";
      assert.match(frame, /line 4-18 of 40/);
      assert.equal(resultBodyRows(frame).length, 15);
      assert.equal(frame.includes("body-line-03"), true);
      assert.equal(frame.includes("body-line-00"), false);

      await sendInput(instance, WHEEL_DOWN);
      assert.match(instance.lastFrame() ?? "", /line 7-21 of 40/);

      await sendInput(instance, WHEEL_UP);
      assert.match(instance.lastFrame() ?? "", /line 4-18 of 40/);

      await sendInput(instance, WHEEL_UP);
      await sendInput(instance, WHEEL_UP);
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);
      await sendInput(instance, WHEEL_UP);
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);

      for (let index = 0; index < 20; index += 1) {
        await sendInput(instance, WHEEL_DOWN);
      }
      frame = instance.lastFrame() ?? "";
      assert.match(frame, /line 26-40 of 40/);
      assert.equal(resultBodyRows(frame).length, 15);
      await sendInput(instance, WHEEL_DOWN);
      assert.match(instance.lastFrame() ?? "", /line 26-40 of 40/);

      assert.deepEqual(fixture.calls.copied, []);
      assert.deepEqual(fixture.calls.archived, []);
    } finally {
      instance.unmount();
    }
  });

  test("keeps arrows and page keys unchanged after wheel reports in the Result view", async () => {
    const item = makeItem("wheeled-keys");
    const rawText = Array.from(
      { length: 40 },
      (_, index) => `body-line-${String(index).padStart(2, "0")}`,
    ).join("\n");
    const fixture = makeFixture([item], {
      details: new Map([[item.id, makeDetail(item, rawText)]]),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 20);
      await sendInput(instance, "\r");

      await sendInput(instance, "\u001B[6~");
      assert.match(instance.lastFrame() ?? "", /line 16-30 of 40/);

      await sendInput(instance, "\u001B[B");
      assert.match(instance.lastFrame() ?? "", /line 17-31 of 40/);
      await sendInput(instance, "\u001B[A");
      assert.match(instance.lastFrame() ?? "", /line 16-30 of 40/);

      await sendInput(instance, WHEEL_DOWN);
      assert.match(instance.lastFrame() ?? "", /line 19-33 of 40/);

      await sendInput(instance, "\u001B[5~");
      assert.match(instance.lastFrame() ?? "", /line 4-18 of 40/);

      await sendInput(instance, "\u001B[A");
      await sendInput(instance, "\u001B[A");
      await sendInput(instance, "\u001B[A");
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);
      await sendInput(instance, "\u001B[6~");
      assert.match(instance.lastFrame() ?? "", /line 16-30 of 40/);
    } finally {
      instance.unmount();
    }
  });
});

/**
 * Ink owns byte chunking: `useInput` never sees half a report, because Ink's
 * input parser buffers a CSI sequence until its final byte arrives. These tests
 * pin that reassembly through the real Ink 7.1.1 parser, including a split that
 * lands immediately after ESC. The two halves are written with no tick between
 * them, so Ink's 20 ms pending-escape flush cannot fire mid-report.
 */
describe("wheel reports split across stdin writes", () => {
  test("reassembles a report when the split lands immediately after ESC", async () => {
    const items = makeItems(10);
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("\u001B");
      instance.stdin.write("[<65;1;1M");
      await tick();

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, [items[3]?.id]);
    } finally {
      instance.unmount();
    }
  });

  test("reassembles a report split before the SGR terminator", async () => {
    const items = makeItems(10);
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      instance.stdin.write("\u001B[<65;1;1");
      instance.stdin.write("M");
      await tick();

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, [items[3]?.id]);
    } finally {
      instance.unmount();
    }
  });

  test("reassembles a split wheel report in the Result view", async () => {
    const item = makeItem("split-result");
    const rawText = Array.from(
      { length: 40 },
      (_, index) => `body-line-${String(index).padStart(2, "0")}`,
    ).join("\n");
    const fixture = makeFixture([item], {
      details: new Map([[item.id, makeDetail(item, rawText)]]),
    });
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 40, 20);
      await sendInput(instance, "\r");
      assert.match(instance.lastFrame() ?? "", /line 1-15 of 40/);

      instance.stdin.write("\u001B[<65;1;1");
      instance.stdin.write("M");
      await tick();

      const frame = instance.lastFrame() ?? "";
      assert.match(frame, /line 4-18 of 40/);
      assert.equal(resultBodyRows(frame).length, 15);
      assert.equal(frame.includes("body-line-03"), true);
    } finally {
      instance.unmount();
    }
  });
});

/**
 * Queue every input in one synchronous block (no tick between writes), so Ink
 * delivers them to `useInput` before React commits a render, then open the
 * selected result and report which row it was.
 */
async function openedAfterQueuedInputs(
  items: InboxItem[],
  inputs: readonly string[],
): Promise<string | undefined> {
  const fixture = makeFixture(items);
  const instance = render(h(createApp(fixture.port)));
  try {
    for (const input of inputs) {
      instance.stdin.write(input);
    }
    await tick();
    await sendInput(instance, "\r");
    return fixture.calls.opened[0];
  } finally {
    instance.unmount();
  }
}

/**
 * Several reports can reach `useInput` before React commits a render: whenever
 * two or more land in one stdin chunk, and whenever the terminal delivers a
 * burst faster than React flushes. Each queued report still has to move the
 * selection once, which means the position must derive from the latest queued
 * state rather than from the closure of the last render.
 */
describe("inbox position batching", () => {
  test("applies every queued wheel report once", async () => {
    const items = makeItems(12);

    assert.equal(await openedAfterQueuedInputs(items, [WHEEL_DOWN, WHEEL_DOWN]), items[6]?.id);
    assert.equal(
      await openedAfterQueuedInputs(items, [WHEEL_DOWN, WHEEL_DOWN, WHEEL_DOWN]),
      items[9]?.id,
    );
  });

  test("lets a queued wheel-down and wheel-up cancel out", async () => {
    const items = makeItems(12);

    assert.equal(await openedAfterQueuedInputs(items, [WHEEL_DOWN, WHEEL_UP]), items[0]?.id);
  });

  test("composes queued wheel and arrow-key moves", async () => {
    const items = makeItems(12);

    assert.equal(
      await openedAfterQueuedInputs(items, [WHEEL_DOWN, "\u001B[B"]),
      items[4]?.id,
      "wheel-down then arrow-down",
    );
    assert.equal(
      await openedAfterQueuedInputs(items, ["\u001B[B", WHEEL_DOWN]),
      items[4]?.id,
      "arrow-down then wheel-down",
    );
    assert.equal(
      await openedAfterQueuedInputs(items, ["j", "j"]),
      items[2]?.id,
      "two vi-style moves",
    );
  });

  test("clamps a queued burst at both ends", async () => {
    const items = makeItems(12);

    assert.equal(
      await openedAfterQueuedInputs(
        items,
        Array.from({ length: 5 }, () => WHEEL_DOWN),
      ),
      items[11]?.id,
      "clamped at the last result",
    );
    assert.equal(
      await openedAfterQueuedInputs(items, [WHEEL_UP, WHEEL_UP, WHEEL_UP]),
      items[0]?.id,
      "clamped at the first result",
    );
  });

  test("applies a concatenated single-write burst report by report", async () => {
    const items = makeItems(12);

    // Ink's input parser splits concatenated SGR reports into separate keypresses.
    assert.equal(await openedAfterQueuedInputs(items, [WHEEL_DOWN + WHEEL_DOWN]), items[6]?.id);
    assert.equal(
      await openedAfterQueuedInputs(items, [WHEEL_DOWN + WHEEL_DOWN + WHEEL_DOWN + WHEEL_DOWN]),
      items[11]?.id,
      "four reports clamp at the last result",
    );
  });

  test("keeps the selected row visible after a queued jump in a small terminal", async () => {
    const items = makeItems(30);
    const fixture = makeFixture(items);
    const instance = render(h(createApp(fixture.port)));
    try {
      setTerminalSize(instance, 80, 10);
      // One committed move lets the app adopt the smaller viewport before the burst.
      await sendInput(instance, "j");
      instance.stdin.write(WHEEL_DOWN);
      instance.stdin.write(WHEEL_DOWN);
      instance.stdin.write(WHEEL_DOWN);
      instance.stdin.write(WHEEL_DOWN);
      await tick();

      const frame = instance.lastFrame() ?? "";
      assert.equal(hasAgent(frame, "item-13"), true);
      assert.equal(hasAgent(frame, "item-00"), false);

      await sendInput(instance, "\r");
      assert.deepEqual(fixture.calls.opened, ["item-13"]);
    } finally {
      instance.unmount();
    }
  });
});
