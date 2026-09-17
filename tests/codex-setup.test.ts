import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CODEX_COLLECTOR_SOURCE_FILES,
  CodexSetupConflictError,
  type CodexSetupPaths,
  CodexSetupValidationError,
  getCodexSetupPaths,
  installCodexCollector,
  statusCodexCollector,
  uninstallCodexCollector,
} from "../src/codex/setup.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const setupBinary = join(repositoryRoot, "src", "bin", "codex-setup.ts");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Codex collector setup", () => {
  test("installs support files and both user-level hook groups", () => {
    const home = fixture();
    const paths = getCodexSetupPaths(home);

    assert.equal(statusCodexCollector({ homeDir: home }).status, "missing");
    const result = installCodexCollector({ homeDir: home });

    assert.equal(result.status, "installed");
    assert.equal(result.files.length, CODEX_COLLECTOR_SOURCE_FILES.length);
    assert.equal(result.notify, "missing");
    assert.equal(result.trust, "unknown");
    assert.equal(existsSync(paths.hooksPath), true);
    assert.equal(existsSync(paths.configPath), false);
    assert.equal(readFileSync(paths.manifestPath, "utf8").endsWith("\n"), true);

    const hooks = JSON.parse(readFileSync(paths.hooksPath, "utf8")) as {
      hooks: Record<string, unknown>;
    };
    assert.deepEqual(hooks.hooks.UserPromptSubmit, [
      expectedGroup(hookCommand(paths, "submit-hook.ts")),
    ]);
    assert.deepEqual(hooks.hooks.Stop, [expectedGroup(hookCommand(paths, "stop-hook.ts"))]);
    for (const relativePath of CODEX_COLLECTOR_SOURCE_FILES) {
      assert.equal(existsSync(join(paths.supportDirectory, relativePath)), true);
    }
    assert.deepEqual(
      statusCodexCollector({ homeDir: home }).hooks.map((item) => [item.event, item.status]),
      [
        ["UserPromptSubmit", "installed"],
        ["Stop", "installed"],
      ],
    );
  });

  test("reinstall is idempotent and detects the manually added notify line", () => {
    const home = fixture();
    const paths = getCodexSetupPaths(home);
    installCodexCollector({ homeDir: home });
    const hooksBefore = readFileSync(paths.hooksPath, "utf8");

    const second = installCodexCollector({ homeDir: home });
    assert.equal(second.status, "already-installed");
    assert.equal(readFileSync(paths.hooksPath, "utf8"), hooksBefore);

    writeFileSync(paths.configPath, `# user config\n${second.notifyLine}\n`);
    const status = statusCodexCollector({ homeDir: home });
    assert.equal(status.status, "installed");
    assert.equal(status.notify, "installed");
    assert.equal(status.trust, "unknown");

    const removed = uninstallCodexCollector({ homeDir: home });
    assert.equal(removed.notify, "installed");
    assert.equal(readFileSync(paths.configPath, "utf8"), `# user config\n${second.notifyLine}\n`);
  });

  test("preserves existing hooks.json bytes outside the inserted groups", () => {
    const home = fixture();
    const paths = getCodexSetupPaths(home);
    mkdirSync(paths.codexDirectory, { recursive: true });
    const existing = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{"type":"command","command":"user command","timeout":7}]
      }
    ]
  },
  "other": {"keep": true}
}
`;
    writeFileSync(paths.hooksPath, existing);

    installCodexCollector({ homeDir: home });
    const inserted = `,"UserPromptSubmit":[${JSON.stringify(expectedGroup(hookCommand(paths, "submit-hook.ts")))}],"Stop":[${JSON.stringify(expectedGroup(hookCommand(paths, "stop-hook.ts")))}]`;
    const installed = readFileSync(paths.hooksPath, "utf8");
    assert.equal(installed.replace(inserted, ""), existing);

    uninstallCodexCollector({ homeDir: home });
    assert.equal(readFileSync(paths.hooksPath, "utf8"), existing);
  });

  test("prevents duplicate registration and rejects a modified Harvest group", () => {
    const home = fixture();
    const paths = getCodexSetupPaths(home);
    installCodexCollector({ homeDir: home });
    const modified = readFileSync(paths.hooksPath, "utf8").replace('"timeout":15', '"timeout":30');
    writeFileSync(paths.hooksPath, modified);

    assert.throws(
      () => installCodexCollector({ homeDir: home }),
      (error: unknown) => error instanceof CodexSetupConflictError,
    );
    assert.equal(readFileSync(paths.hooksPath, "utf8"), modified);
    assert.equal(statusCodexCollector({ homeDir: home }).status, "stale");
  });

  test("rejects malformed hooks.json without changing it", () => {
    const home = fixture();
    const paths = getCodexSetupPaths(home);
    mkdirSync(paths.codexDirectory, { recursive: true });
    const malformed = "{ this is not JSON\n";
    writeFileSync(paths.hooksPath, malformed);

    assert.throws(
      () => installCodexCollector({ homeDir: home }),
      (error: unknown) => error instanceof CodexSetupConflictError,
    );
    assert.equal(readFileSync(paths.hooksPath, "utf8"), malformed);
    assert.equal(statusCodexCollector({ homeDir: home }).status, "stale");
  });

  test("uninstalls only owned files and drops the owned hook groups", () => {
    const home = fixture();
    const paths = getCodexSetupPaths(home);
    mkdirSync(paths.supportDirectory, { recursive: true });
    const unrelated = join(paths.supportDirectory, "keep-me.txt");
    writeFileSync(unrelated, "unrelated support content\n");
    const userConfig = 'notify = ["other-notifier"]\n';
    mkdirSync(paths.codexDirectory, { recursive: true });
    writeFileSync(paths.configPath, userConfig);
    const existingHooks = `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"keep","timeout":5}]}]}}\n`;
    writeFileSync(paths.hooksPath, existingHooks);

    installCodexCollector({ homeDir: home });
    const result = uninstallCodexCollector({ homeDir: home });

    assert.equal(result.status, "uninstalled");
    assert.equal(existsSync(paths.manifestPath), false);
    assert.equal(existsSync(unrelated), true);
    assert.equal(readFileSync(unrelated, "utf8"), "unrelated support content\n");
    assert.equal(readFileSync(paths.configPath, "utf8"), userConfig);
    assert.equal(readFileSync(paths.hooksPath, "utf8"), existingHooks);
    assert.equal(statusCodexCollector({ homeDir: home }).status, "missing");
    assert.equal(uninstallCodexCollector({ homeDir: home }).status, "absent");
  });

  test("reports stale support state and refuses to remove modified support files", () => {
    const home = fixture();
    const paths = getCodexSetupPaths(home);
    installCodexCollector({ homeDir: home });
    const target = join(paths.supportDirectory, CODEX_COLLECTOR_SOURCE_FILES[0]);
    writeFileSync(target, "foreign replacement\n");

    const status = statusCodexCollector({ homeDir: home });
    assert.equal(status.status, "stale");
    assert.equal(status.files.find((file) => file.path === target)?.status, "stale");
    assert.throws(
      () => uninstallCodexCollector({ homeDir: home }),
      (error: unknown) => error instanceof CodexSetupConflictError,
    );
    assert.equal(readFileSync(target, "utf8"), "foreign replacement\n");
  });

  test("supports the thin --home CLI without using HOME", () => {
    const home = fixture();
    const result = spawnSync(process.execPath, [setupBinary, "install", "--home", home], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: join(home, "ignored-home") },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /user-level setup installed/i);
    assert.match(result.stdout, /notify =/);
    assert.equal(
      statusCodexCollector({ homeDir: home }).hooks.every((item) => item.status === "installed"),
      true,
    );
  });

  test("validates a missing home before writing anything", () => {
    const base = mkdtempSync(join(tmpdir(), "herdr-harvest-codex-setup-"));
    temporaryDirectories.push(base);
    const missingHome = join(base, "missing-home");

    assert.throws(
      () => installCodexCollector({ homeDir: missingHome }),
      (error: unknown) => error instanceof CodexSetupValidationError,
    );
  });
});

function fixture(): string {
  const base = mkdtempSync(join(tmpdir(), "herdr-harvest-codex-setup-"));
  temporaryDirectories.push(base);
  const home = join(base, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function hookCommand(paths: CodexSetupPaths, file: "submit-hook.ts" | "stop-hook.ts"): string {
  return `node --experimental-strip-types ${join(paths.supportDirectory, "src", "codex", file)}`;
}

function expectedGroup(command: string): object {
  return { hooks: [{ type: "command", command, timeout: 15 }] };
}
