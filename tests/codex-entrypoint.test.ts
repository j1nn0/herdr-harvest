import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openDatabase } from "../src/persistence/database.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

interface ChildResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

test("ingest-codex executes through a symlinked directory", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "herdr-codex-entrypoint-"));
  try {
    const linkedRoot = join(temporaryRoot, "repo-link");
    symlinkSync(repositoryRoot, linkedRoot, "dir");
    const directState = mkdtempSync(join(temporaryRoot, "direct-state-"));
    const linkedState = mkdtempSync(join(temporaryRoot, "linked-state-"));
    const payload = JSON.stringify({
      kind: "promptObserved",
      sessionId: "entrypoint-ingest-session",
      turnId: "entrypoint-ingest-turn",
      submittedPrompt: "  synthetic ingest prompt\n日本語 🚀\n",
    });

    const direct = runNode(
      join(repositoryRoot, "src/bin/ingest-codex.ts"),
      [],
      payload,
      collectionEnv(directState),
    );
    const linked = runNode(
      join(linkedRoot, "src/bin/ingest-codex.ts"),
      [],
      payload,
      collectionEnv(linkedState),
    );

    assert.deepEqual(direct, {
      status: 0,
      stdout:
        '{"status":"pending","sessionId":"entrypoint-ingest-session","turnId":"entrypoint-ingest-turn"}\n',
      stderr: "",
    });
    assert.deepEqual(linked, direct);
    assertPendingRow(directState, "  synthetic ingest prompt\n日本語 🚀\n");
    assertPendingRow(linkedState, "  synthetic ingest prompt\n日本語 🚀\n");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("submit-hook stages the same event through a symlinked directory", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "herdr-codex-entrypoint-"));
  try {
    const linkedRoot = join(temporaryRoot, "repo-link");
    symlinkSync(repositoryRoot, linkedRoot, "dir");
    const directState = mkdtempSync(join(temporaryRoot, "direct-state-"));
    const linkedState = mkdtempSync(join(temporaryRoot, "linked-state-"));
    const payload = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "entrypoint-submit-session",
      turn_id: "entrypoint-submit-turn",
      prompt: "  synthetic submit prompt\nUnicode: 日本語 🌊\n",
    });

    const direct = runNode(
      join(repositoryRoot, "src/codex/submit-hook.ts"),
      [],
      payload,
      collectionEnv(directState),
    );
    const linked = runNode(
      join(linkedRoot, "src/codex/submit-hook.ts"),
      [],
      payload,
      collectionEnv(linkedState),
    );

    assert.deepEqual(direct, { status: 0, stdout: "", stderr: "" });
    assert.deepEqual(linked, direct);
    assertPendingRow(directState, "  synthetic submit prompt\nUnicode: 日本語 🌊\n");
    assertPendingRow(linkedState, "  synthetic submit prompt\nUnicode: 日本語 🌊\n");
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("pi-setup install executes identically through a symlinked directory", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "herdr-codex-entrypoint-"));
  try {
    const linkedRoot = join(temporaryRoot, "repo-link");
    symlinkSync(repositoryRoot, linkedRoot, "dir");
    const directHome = mkdtempSync(join(temporaryRoot, "direct-home-"));
    const linkedHome = mkdtempSync(join(temporaryRoot, "linked-home-"));
    const direct = runNode(
      join(repositoryRoot, "src/bin/pi-setup.ts"),
      ["install", "--home", directHome],
      "",
      { ...process.env, HOME: directHome },
    );
    const linked = runNode(
      join(linkedRoot, "src/bin/pi-setup.ts"),
      ["install", "--home", linkedHome],
      "",
      { ...process.env, HOME: linkedHome },
    );

    assert.equal(direct.status, 0);
    assert.equal(linked.status, 0);
    assert.equal(direct.stderr, "");
    assert.equal(linked.stderr, "");
    assert.equal(existsSync(join(directHome, ".pi/agent/extensions/herdr-harvest.ts")), true);
    assert.equal(existsSync(join(linkedHome, ".pi/agent/extensions/herdr-harvest.ts")), true);
    assert.deepEqual(
      normalizeHomeResult(direct, directHome),
      normalizeHomeResult(linked, linkedHome),
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("guarded entrypoints remain inert when imported as libraries", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "herdr-codex-entrypoint-"));
  try {
    const stateDirectory = mkdtempSync(join(temporaryRoot, "library-state-"));
    const moduleUrl = pathToFileURL(join(repositoryRoot, "src/bin/ingest-codex.ts")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(moduleUrl)})`,
      ],
      {
        cwd: repositoryRoot,
        env: collectionEnv(stateDirectory),
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(existsSync(join(stateDirectory, "harvest.db")), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function collectionEnv(stateDirectory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HARVEST_CODEX_COLLECT: "1",
    HARVEST_STATE_DIR: stateDirectory,
  };
}

function runNode(
  script: string,
  args: readonly string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): ChildResult {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", script, ...args], {
    cwd: repositoryRoot,
    env,
    input: stdin,
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

function assertPendingRow(stateDirectory: string, submittedPrompt: string): void {
  const db = openDatabase(join(stateDirectory, "harvest.db"));
  try {
    const row = db
      .prepare("SELECT status, submitted_prompt, final_report, provenance FROM pi_interactions")
      .get() as Record<string, unknown>;
    assert.deepEqual(Object.fromEntries(Object.entries(row)), {
      status: "pending",
      submitted_prompt: submittedPrompt,
      final_report: null,
      provenance: "codex-native-hooks",
    });
  } finally {
    db.close();
  }
}

function normalizeHomeResult(result: ChildResult, homeDirectory: string): ChildResult {
  return {
    ...result,
    stdout: result.stdout.replaceAll(homeDirectory, "<temporary-home>"),
    stderr: result.stderr.replaceAll(homeDirectory, "<temporary-home>"),
  };
}
