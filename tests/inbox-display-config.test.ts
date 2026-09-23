import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
  DEFAULT_INBOX_DISPLAY_CONFIG,
  inboxDisplayConfigPath,
  loadInboxDisplayConfig,
} from "../src/config/inbox-display-config.ts";
import { removeDirectory } from "./helpers/remove-directory.ts";

function withConfigDirectory<T>(callback: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "harvest-inbox-display-"));
  try {
    return callback(directory);
  } finally {
    removeDirectory(directory);
  }
}

describe("inbox display config", () => {
  test("includes previews in the default standalone and grouped fields", () => {
    assert.deepEqual(DEFAULT_INBOX_DISPLAY_CONFIG.standaloneFields, [
      "unread",
      "agent",
      "session",
      "context",
      "preview",
      "age",
    ]);
    assert.deepEqual(DEFAULT_INBOX_DISPLAY_CONFIG.groupedFields, [
      "unread",
      "context",
      "preview",
      "age",
    ]);
  });

  test("uses defaults silently when the default file is missing", () => {
    withConfigDirectory((directory) => {
      const loaded = loadInboxDisplayConfig({ HERDR_PLUGIN_CONFIG_DIR: directory });
      assert.deepEqual(loaded.config, DEFAULT_INBOX_DISPLAY_CONFIG);
      assert.deepEqual(loaded.warnings, []);
      assert.equal(
        inboxDisplayConfigPath({ HERDR_PLUGIN_CONFIG_DIR: directory }),
        join(directory, "harvest.inbox.json"),
      );
    });
  });

  test("loads valid ordered field lists and allows empty metadata", () => {
    withConfigDirectory((directory) => {
      writeFileSync(
        join(directory, "harvest.inbox.json"),
        JSON.stringify({
          standaloneFields: ["context", "agent"],
          groupedFields: ["age"],
          metadataFields: [],
        }),
      );
      const loaded = loadInboxDisplayConfig({ HERDR_PLUGIN_CONFIG_DIR: directory });
      assert.deepEqual(loaded.config, {
        ...DEFAULT_INBOX_DISPLAY_CONFIG,
        standaloneFields: ["context", "agent"],
        groupedFields: ["age"],
        metadataFields: [],
      });
      assert.deepEqual(loaded.warnings, []);
    });
  });

  test("uses the explicit path before the Herdr config directory", () => {
    withConfigDirectory((directory) => {
      const explicitPath = join(directory, "custom path", "display.json");
      const defaultPath = join(directory, "harvest.inbox.json");
      writeFileSync(defaultPath, JSON.stringify({ standaloneFields: ["preview"] }));
      const customDirectory = join(directory, "custom path");
      requireDirectory(customDirectory);
      writeFileSync(explicitPath, JSON.stringify({ standaloneFields: ["context"] }));

      const loaded = loadInboxDisplayConfig({
        HARVEST_CONFIG_PATH: explicitPath,
        HERDR_PLUGIN_CONFIG_DIR: directory,
      });
      assert.deepEqual(loaded.config.standaloneFields, ["context"]);
      assert.equal(inboxDisplayConfigPath({ HARVEST_CONFIG_PATH: explicitPath }), explicitPath);
    });
  });

  for (const [name, content, reason] of [
    ["invalid JSON", "{", "JSON"],
    ["a bad shape", "[]", "top-level value must be an object"],
    ["an unknown field", JSON.stringify({ standaloneFields: ["unknown"] }), "unknown field"],
    ["a duplicate field", JSON.stringify({ standaloneFields: ["agent", "agent"] }), "duplicate"],
    ["an empty required list", JSON.stringify({ groupedFields: [] }), "must not be empty"],
  ] as const) {
    test(`falls back completely for ${name}`, () => {
      withConfigDirectory((directory) => {
        const path = join(directory, "harvest.inbox.json");
        writeFileSync(path, content);
        const loaded = loadInboxDisplayConfig({ HERDR_PLUGIN_CONFIG_DIR: directory });
        assert.deepEqual(loaded.config, DEFAULT_INBOX_DISPLAY_CONFIG);
        assert.equal(loaded.warnings.length, 1);
        assert.match(
          loaded.warnings[0] ?? "",
          new RegExp(`${escapeRegExp(path)}.*${escapeRegExp(reason)}`),
        );
      });
    });
  }

  test("rejects a non-array field list with a concise warning", () => {
    withConfigDirectory((directory) => {
      const path = join(directory, "harvest.inbox.json");
      writeFileSync(path, JSON.stringify({ standaloneFields: "agent" }));
      const loaded = loadInboxDisplayConfig({ HERDR_PLUGIN_CONFIG_DIR: directory });
      assert.deepEqual(loaded.config, DEFAULT_INBOX_DISPLAY_CONFIG);
      assert.match(loaded.warnings[0] ?? "", /standaloneFields must be an array/);
      assert.doesNotMatch(loaded.warnings[0] ?? "", /agent/);
    });
  });

  test("rejects an oversized file before parsing it", () => {
    withConfigDirectory((directory) => {
      const path = join(directory, "harvest.inbox.json");
      writeFileSync(path, `{"standaloneFields":["agent"],"padding":"${"x".repeat(70_000)}"}`);
      const loaded = loadInboxDisplayConfig({ HERDR_PLUGIN_CONFIG_DIR: directory });
      assert.deepEqual(loaded.config, DEFAULT_INBOX_DISPLAY_CONFIG);
      assert.match(loaded.warnings[0] ?? "", /exceeds/);
    });
  });

  test("does not read a config file when no config directory is available", () => {
    const loaded = loadInboxDisplayConfig({});
    assert.deepEqual(loaded.config, DEFAULT_INBOX_DISPLAY_CONFIG);
    assert.deepEqual(loaded.warnings, []);
    assert.equal(inboxDisplayConfigPath({}), null);
  });
});

function requireDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
