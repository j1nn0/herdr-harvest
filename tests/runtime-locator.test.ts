import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  publishRuntimeLocator,
  RUNTIME_LOCATOR_FILE_NAME,
  RUNTIME_LOCATOR_PLUGIN_ID,
  RUNTIME_LOCATOR_PROTOCOL,
  RUNTIME_LOCATOR_PROTOCOL_VERSION,
} from "../src/runtime/locator.ts";

describe("publishRuntimeLocator", () => {
  test("publishes the locator with the environment values copied verbatim", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-harvest-locator-"));

    try {
      const configDir = join(base, "plugin config dir");
      mkdirSync(configDir);
      // Deliberately unnormalized values: nothing may be resolved, trimmed, or
      // rewritten on the way into the document.
      const stateDir = `${base}/state/./../state/`;
      const socketPath = "/run/herdr/sessions/nightly/herdr.sock";

      const publication = publishRuntimeLocator({
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_SOCKET_PATH: socketPath,
      });

      assert.equal(publication.published, true);
      assert.equal(publication.path, join(configDir, RUNTIME_LOCATOR_FILE_NAME));
      assert.equal(publication.reason, undefined);
      assert.equal(publication.writeFailure, undefined);

      const text = readFileSync(join(configDir, RUNTIME_LOCATOR_FILE_NAME), "utf8");
      const document = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(document), [
        "protocol",
        "protocolVersion",
        "pluginId",
        "stateDir",
        "socketPath",
        "updatedAtMs",
      ]);
      assert.deepEqual(document, {
        protocol: RUNTIME_LOCATOR_PROTOCOL,
        protocolVersion: RUNTIME_LOCATOR_PROTOCOL_VERSION,
        pluginId: RUNTIME_LOCATOR_PLUGIN_ID,
        stateDir,
        socketPath,
        updatedAtMs: document.updatedAtMs,
      });
      assert.equal(typeof document.updatedAtMs, "number");
      // The file is exactly the JSON document: nothing else is appended.
      assert.equal(text, JSON.stringify(document));
      assert.deepEqual(readdirSync(configDir), [RUNTIME_LOCATOR_FILE_NAME]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("replaces an existing locator atomically and leaves no temporary file", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-harvest-locator-"));

    try {
      const configDir = join(base, "config");
      mkdirSync(configDir);
      const first = publishRuntimeLocator({
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: "/state/one",
        HERDR_SOCKET_PATH: "/run/herdr/first.sock",
      });
      assert.equal(first.published, true);

      const locatorPath = join(configDir, RUNTIME_LOCATOR_FILE_NAME);
      const firstInode = statSync(locatorPath).ino;

      const second = publishRuntimeLocator({
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: "/state/two",
        HERDR_SOCKET_PATH: "/run/herdr/second.sock",
      });

      assert.equal(second.published, true);
      const document = JSON.parse(readFileSync(locatorPath, "utf8")) as Record<string, unknown>;
      assert.equal(document.stateDir, "/state/two");
      assert.equal(document.socketPath, "/run/herdr/second.sock");
      assert.deepEqual(readdirSync(configDir), [RUNTIME_LOCATOR_FILE_NAME]);
      if (process.platform !== "win32" && firstInode !== 0) {
        // A rename installs a new directory entry instead of truncating the old
        // one in place, so a concurrent reader sees one complete document or the
        // other and never a half-written file.
        assert.notEqual(statSync(locatorPath).ino, firstInode);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("restricts the locator file to the owner where the platform supports modes", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-harvest-locator-"));

    try {
      const configDir = join(base, "config");
      mkdirSync(configDir);
      const publication = publishRuntimeLocator({
        HERDR_PLUGIN_CONFIG_DIR: configDir,
        HERDR_PLUGIN_STATE_DIR: join(base, "state"),
        HERDR_SOCKET_PATH: join(base, "herdr.sock"),
      });

      assert.equal(publication.published, true);
      if (process.platform !== "win32") {
        assert.equal(statSync(join(configDir, RUNTIME_LOCATOR_FILE_NAME)).mode & 0o777, 0o600);
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("does not publish and does not throw when a prerequisite is missing", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-harvest-locator-"));

    try {
      const configDir = join(base, "config");
      mkdirSync(configDir);
      const cases: Array<{ env: NodeJS.ProcessEnv; missing: string }> = [
        { env: {}, missing: "HERDR_PLUGIN_CONFIG_DIR" },
        { env: { HERDR_PLUGIN_CONFIG_DIR: configDir }, missing: "HERDR_PLUGIN_STATE_DIR" },
        {
          env: { HERDR_PLUGIN_CONFIG_DIR: configDir, HERDR_PLUGIN_STATE_DIR: "/state" },
          missing: "HERDR_SOCKET_PATH",
        },
        {
          env: {
            HERDR_PLUGIN_CONFIG_DIR: configDir,
            HERDR_PLUGIN_STATE_DIR: "/state",
            HERDR_SOCKET_PATH: "  ",
          },
          missing: "HERDR_SOCKET_PATH",
        },
        {
          env: {
            HERDR_PLUGIN_CONFIG_DIR: "   ",
            HERDR_PLUGIN_STATE_DIR: "/state",
            HERDR_SOCKET_PATH: "/run/herdr/herdr.sock",
          },
          missing: "HERDR_PLUGIN_CONFIG_DIR",
        },
      ];

      for (const { env, missing } of cases) {
        const publication = publishRuntimeLocator(env);
        assert.equal(publication.published, false);
        assert.equal(publication.path, undefined);
        assert.equal(publication.writeFailure, undefined);
        assert.match(String(publication.reason), new RegExp(missing));
      }

      // No partial publication and no leftover temporary file anywhere.
      assert.deepEqual(readdirSync(configDir), []);
      assert.deepEqual(readdirSync(base), ["config"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("reports a write failure without throwing and removes the temporary file", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-harvest-locator-"));

    try {
      const configPath = join(base, "config-as-a-file");
      writeFileSync(configPath, "not a directory\n");

      const publication = publishRuntimeLocator({
        HERDR_PLUGIN_CONFIG_DIR: configPath,
        HERDR_PLUGIN_STATE_DIR: join(base, "state"),
        HERDR_SOCKET_PATH: join(base, "herdr.sock"),
      });

      assert.equal(publication.published, false);
      assert.equal(publication.path, undefined);
      assert.equal(publication.writeFailure, true);
      assert.match(String(publication.reason), /failed to write/);
      assert.deepEqual(readdirSync(base), ["config-as-a-file"]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
