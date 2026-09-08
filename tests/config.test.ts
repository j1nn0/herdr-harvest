import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";

import { loadConfig } from "../src/config/config.ts";

describe("loadConfig", () => {
  test("uses the default capture settings", () => {
    const loaded = loadConfig({ HARVEST_STATE_DIR: "/tmp/harvest" });

    assert.deepEqual(loaded.config, {
      captureLines: 400,
      captureSource: "recent-unwrapped",
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
      HARVEST_CAPTURE_LINES: "1234",
      HARVEST_CAPTURE_SOURCE: "detection",
    });

    assert.equal(loaded.config.captureLines, 1234);
    assert.equal(loaded.config.captureSource, "detection");
    assert.equal(loaded.config.databasePath, join("/tmp/plugin-state", "harvest.db"));
    assert.equal(loaded.config.herdrSessionKey, null);
    assert.equal(loaded.config.herdrSessionLabel, null);
    assert.deepEqual(loaded.warnings, []);
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
});
