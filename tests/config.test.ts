import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { isPiCollectionEnabled, loadConfig } from "../src/config/config.ts";
import { removeDirectory } from "./helpers/remove-directory.ts";

describe("loadConfig", () => {
  test("uses the default capture settings", () => {
    const loaded = loadConfig({ HARVEST_STATE_DIR: "/tmp/harvest" });

    assert.deepEqual(loaded.config, {
      captureLines: 400,
      captureSource: "recent-unwrapped",
      piCollectionEnabled: false,
      databasePath: join("/tmp/harvest", "harvest.db"),
      herdrSessionKey: null,
      herdrSessionLabel: null,
    });
    assert.deepEqual(loaded.warnings, []);
  });

  test("leaves the Herdr session identity unknown when the socket path is missing", () => {
    const loaded = loadConfig({ HARVEST_STATE_DIR: "/tmp/harvest" });

    assert.equal(loaded.config.herdrSessionKey, null);
    assert.equal(loaded.config.herdrSessionLabel, null);
    assert.deepEqual(loaded.warnings, []);
  });

  test("honors valid capture settings", () => {
    const loaded = loadConfig({
      HERDR_PLUGIN_STATE_DIR: "/tmp/plugin-state",
      HARVEST_CAPTURE_LINES: "5000",
      HARVEST_CAPTURE_SOURCE: "detection",
    });

    assert.equal(loaded.config.captureLines, 5000);
    assert.equal(loaded.config.captureSource, "detection");
    assert.equal(loaded.config.databasePath, join("/tmp/plugin-state", "harvest.db"));
    assert.equal(loaded.config.herdrSessionKey, null);
    assert.equal(loaded.config.herdrSessionLabel, null);
    assert.deepEqual(loaded.warnings, []);
  });

  test("enables Pi collection only for the explicit opt-in value", () => {
    const loaded = loadConfig({
      HARVEST_STATE_DIR: "/tmp/harvest",
      HARVEST_PI_COLLECT: "1",
    });

    assert.equal(loaded.config.piCollectionEnabled, true);
    assert.equal(isPiCollectionEnabled({ HARVEST_PI_COLLECT: "1" }), true);
    assert.deepEqual(loaded.warnings, []);
  });

  test("keeps Pi collection disabled for removal and invalid values", () => {
    assert.equal(isPiCollectionEnabled({}), false);
    assert.equal(isPiCollectionEnabled({ HARVEST_PI_COLLECT: "0" }), false);
    assert.equal(isPiCollectionEnabled({ HARVEST_PI_COLLECT: "yes" }), false);

    const loaded = loadConfig({
      HARVEST_STATE_DIR: "/tmp/harvest",
      HARVEST_PI_COLLECT: "yes",
    });
    assert.equal(loaded.config.piCollectionEnabled, false);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? "", /HARVEST_PI_COLLECT/);
  });

  test("derives the default Herdr session identity from the socket path", () => {
    const socketPath = "/tmp/herdr/herdr.sock";
    const loaded = loadConfig({
      HARVEST_STATE_DIR: "/tmp/harvest",
      HERDR_SOCKET_PATH: socketPath,
    });

    assert.equal(loaded.config.herdrSessionKey, socketPath);
    assert.equal(loaded.config.herdrSessionLabel, "default");
  });

  test("derives a named Herdr session identity with Windows separators", () => {
    const socketPath = "C:\\herdr\\sessions\\nightly\\herdr.sock";
    const loaded = loadConfig({
      HARVEST_STATE_DIR: "/tmp/harvest",
      HERDR_SOCKET_PATH: socketPath,
    });

    assert.equal(loaded.config.herdrSessionKey, socketPath);
    assert.equal(loaded.config.herdrSessionLabel, "nightly");
  });

  test("keeps a non-standard socket key without inventing a label", () => {
    const socketPath = "/tmp/herdr/custom.sock";
    const loaded = loadConfig({
      HARVEST_STATE_DIR: "/tmp/harvest",
      HERDR_SOCKET_PATH: socketPath,
    });

    assert.equal(loaded.config.herdrSessionKey, socketPath);
    assert.equal(loaded.config.herdrSessionLabel, null);
  });

  for (const value of ["not-a-number", "0", "-1", "10001"]) {
    test(`falls back for invalid capture line value ${value}`, () => {
      const loaded = loadConfig({
        HARVEST_STATE_DIR: "/tmp/harvest",
        HARVEST_CAPTURE_LINES: value,
      });

      assert.equal(loaded.config.captureLines, 400);
      assert.equal(loaded.warnings.length, 1);
      assert.match(loaded.warnings[0] ?? "", /HARVEST_CAPTURE_LINES/);
    });
  }

  test("falls back with a warning for an invalid capture source", () => {
    const loaded = loadConfig({
      HARVEST_STATE_DIR: "/tmp/harvest",
      HARVEST_CAPTURE_SOURCE: "unknown",
    });

    assert.equal(loaded.config.captureSource, "recent-unwrapped");
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0] ?? "", /HARVEST_CAPTURE_SOURCE/);
  });

  test("requires an explicit state directory", () => {
    assert.throws(() => loadConfig({}), /HARVEST_STATE_DIR.*HERDR_PLUGIN_STATE_DIR/);
  });

  test("does not read the separate inbox display config", () => {
    const directory = mkdtempSync(join(tmpdir(), "harvest-capture-config-"));
    try {
      const displayPath = join(directory, "harvest.inbox.json");
      writeFileSync(displayPath, "not JSON");
      const loaded = loadConfig({
        HARVEST_STATE_DIR: directory,
        HARVEST_CONFIG_PATH: displayPath,
      });

      assert.equal(loaded.config.captureLines, 400);
      assert.deepEqual(loaded.warnings, []);
    } finally {
      removeDirectory(directory);
    }
  });
});
