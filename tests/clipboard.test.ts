import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  createClipboard,
  createOsc52Clipboard,
  createSystemClipboard,
} from "../src/clipboard/index.ts";
import { ClipboardError } from "../src/clipboard/provider.ts";

type ClipboardStream = NodeJS.WritableStream & { isTTY?: boolean };

function fakeStream(isTTY: boolean, onWrite: (text: string) => void): ClipboardStream {
  return {
    isTTY,
    write: (text: string) => {
      onWrite(text);
      return true;
    },
  } as unknown as ClipboardStream;
}

function commandPath(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

function noOpCommand(directory: string, name: string): void {
  commandPath(directory, name, 'process.stdin.resume(); process.stdin.on("end", () => {});');
}

describe("OSC 52 clipboard", () => {
  test("writes the exact escape sequence for ASCII text and reports unconfirmed delivery", async () => {
    const writes: string[] = [];
    const clipboard = createOsc52Clipboard(fakeStream(true, (text) => writes.push(text)));

    const report = await clipboard.copy("hello");

    assert.deepEqual(writes, ["\u001b]52;c;aGVsbG8=\u0007"]);
    assert.deepEqual(report, { provider: "osc52", confirmed: false });
  });

  test("base64-encodes multi-byte UTF-8 text exactly", async () => {
    const writes: string[] = [];
    const clipboard = createOsc52Clipboard(fakeStream(true, (text) => writes.push(text)));

    await clipboard.copy("世界 🚀");

    assert.deepEqual(writes, ["\u001b]52;c;5LiW55WMIPCfmoA=\u0007"]);
  });

  test("rejects when the output stream is not a TTY", async () => {
    let writes = 0;
    const clipboard = createOsc52Clipboard(
      fakeStream(false, () => {
        writes += 1;
      }),
    );

    await assert.rejects(clipboard.copy("hello"), (error: unknown) => {
      assert.ok(error instanceof ClipboardError);
      assert.match(error.message, /TTY/);
      assert.deepEqual(error.attempts, ["osc52: stream is not a TTY"]);
      return true;
    });
    assert.equal(writes, 0);
  });

  test("turns a synchronous stream write failure into ClipboardError", async () => {
    const clipboard = createOsc52Clipboard(
      fakeStream(true, () => {
        throw new Error("terminal is closed");
      }),
    );

    await assert.rejects(clipboard.copy("hello"), (error: unknown) => {
      assert.ok(error instanceof ClipboardError);
      assert.match(error.message, /terminal is closed/);
      assert.deepEqual(error.attempts, ["osc52: terminal is closed"]);
      return true;
    });
  });
});

describe("system clipboard", () => {
  test("copies through a PATH executable and confirms a zero exit", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    const capturePath = join(directory, "captured.bin");
    try {
      commandPath(
        directory,
        "pbcopy",
        [
          'const fs = require("node:fs");',
          "const chunks = [];",
          'process.stdin.on("data", (chunk) => chunks.push(chunk));',
          'process.stdin.on("end", () => fs.writeFileSync(process.env.CAPTURE_FILE, Buffer.concat(chunks)));',
        ].join("\n"),
      );
      const env = { PATH: directory, CAPTURE_FILE: capturePath };
      const clipboard = createSystemClipboard("darwin", env);
      assert.ok(clipboard !== null);

      const report = await clipboard.copy("exact 世界");

      assert.deepEqual(report, { provider: "pbcopy", confirmed: true });
      assert.equal(readFileSync(capturePath, "utf8"), "exact 世界");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("rejects a non-zero executable exit with the provider and reason", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    try {
      commandPath(
        directory,
        "xclip",
        'process.stdin.resume(); process.stdin.on("end", () => { process.stderr.write("stub failed"); process.exitCode = 7; });',
      );
      const clipboard = createSystemClipboard("linux", { PATH: directory });
      assert.ok(clipboard !== null);

      await assert.rejects(clipboard.copy("hello"), (error: unknown) => {
        assert.ok(error instanceof ClipboardError);
        assert.match(error.message, /xclip/);
        assert.match(error.message, /stub failed/);
        assert.equal(error.attempts.length, 1);
        assert.match(error.attempts[0] ?? "", /xclip/);
        assert.match(error.attempts[0] ?? "", /stub failed/);
        return true;
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("selects pbcopy on macOS", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    try {
      noOpCommand(directory, "pbcopy");
      const clipboard = createSystemClipboard("darwin", { PATH: directory });
      assert.equal(clipboard?.name, "pbcopy");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("selects clip.exe then falls back to clip on Windows", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    try {
      noOpCommand(directory, "clip.exe");
      noOpCommand(directory, "clip");
      assert.equal(createSystemClipboard("win32", { PATH: directory })?.name, "clip.exe");
      rmSync(join(directory, "clip.exe"));
      assert.equal(createSystemClipboard("win32", { PATH: directory })?.name, "clip");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("prefers wl-copy on Wayland and xclip otherwise", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    try {
      noOpCommand(directory, "wl-copy");
      noOpCommand(directory, "xclip");
      noOpCommand(directory, "xsel");
      assert.equal(
        createSystemClipboard("linux", { PATH: directory, WAYLAND_DISPLAY: "wayland-1" })?.name,
        "wl-copy",
      );
      assert.equal(createSystemClipboard("linux", { PATH: directory })?.name, "xclip");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses xsel when xclip is unavailable and returns null without candidates", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    try {
      noOpCommand(directory, "xsel");
      assert.equal(createSystemClipboard("linux", { PATH: directory })?.name, "xsel");
      rmSync(join(directory, "xsel"));
      assert.equal(createSystemClipboard("linux", { PATH: directory }), null);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("clipboard chain", () => {
  test("falls back to OSC 52 after a system provider failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    const writes: string[] = [];
    try {
      commandPath(directory, "xclip", "process.exitCode = 3;");
      const clipboard = createClipboard({
        platform: "linux",
        env: { PATH: directory },
        stream: fakeStream(true, (text) => writes.push(text)),
      });

      const report = await clipboard.copy("fallback");

      assert.deepEqual(report, { provider: "osc52", confirmed: false });
      assert.deepEqual(writes, ["\u001b]52;c;ZmFsbGJhY2s=\u0007"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports every failed provider when the chain is exhausted", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-clipboard-"));
    try {
      commandPath(
        directory,
        "xclip",
        'process.stderr.write("xclip unavailable"); process.exitCode = 4;',
      );
      const clipboard = createClipboard({
        platform: "linux",
        env: { PATH: directory },
        stream: fakeStream(true, () => {
          throw new Error("terminal write failed");
        }),
      });

      await assert.rejects(clipboard.copy("failure"), (error: unknown) => {
        assert.ok(error instanceof ClipboardError);
        assert.equal(error.attempts.length, 2);
        assert.ok(error.attempts.some((attempt) => attempt.includes("xclip")));
        assert.ok(error.attempts.some((attempt) => attempt.includes("osc52")));
        assert.match(error.message, /xclip/);
        assert.match(error.message, /terminal write failed/);
        return true;
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("uses OSC 52 directly when no system candidate exists", async () => {
    const writes: string[] = [];
    const clipboard = createClipboard({
      platform: "linux",
      env: { PATH: "/path/that/does/not/exist" },
      stream: fakeStream(true, (text) => writes.push(text)),
    });

    const report = await clipboard.copy("direct");

    assert.equal(clipboard.name, "chain");
    assert.deepEqual(report, { provider: "osc52", confirmed: false });
    assert.equal(writes.length, 1);
  });
});
