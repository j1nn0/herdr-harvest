import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODEX_NATIVE_HOOKS_PROVENANCE,
  codexInteractionId,
} from "../src/codex/collector-contract.ts";
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
import {
  type CodexPendingTurn,
  deleteCodexPending,
  listCodexPending,
  stageCodexPrompt,
  stageCodexReport,
} from "../src/codex/staging.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { PiInteractionStore } from "../src/persistence/pi-interaction-store.ts";

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

test("prune defaults to a metadata-only dry run", () => {
  const value = pruneFixture();
  const result = runCodexSetupProcess(["prune", "--home", value.home], value);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /pending codex turns: 2/);
  for (const candidate of value.pending) {
    assert.match(result.stdout, new RegExp(`interactionId=${candidate.interactionId}`));
    assert.match(result.stdout, new RegExp(`dedupKey=${candidate.dedupKey.slice(0, 16)}`));
  }
  assert.match(result.stdout, /nothing deleted \(dry-run/);
  assert.equal(result.stdout.includes(value.pendingPrompt), false);
  assert.equal(result.stdout.includes(value.pendingReport), false);
  assert.deepEqual(readPending(value), value.pending);
});

test("prune requires both confirmation flags and can restrict deletion by session", () => {
  const value = pruneFixture();
  const missingConfirm = runCodexSetupProcess(["prune", "--home", value.home, "--apply"], value);
  assert.equal(missingConfirm.status, 2);
  assert.match(missingConfirm.stderr, /--confirm/);
  assert.deepEqual(readPending(value), value.pending);

  const applied = runCodexSetupProcess(
    ["prune", "--home", value.home, "--apply", "--confirm", "--session", "codex-session-a"],
    value,
  );
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(applied.stderr, "");
  assert.match(applied.stdout, /deleted codex pending turns: 1/);
  assert.match(applied.stdout, new RegExp(`deleted dedupKey=${value.pending[0]?.dedupKey}`));
  assert.equal(applied.stdout.includes(value.pendingPrompt), false);
  assert.equal(applied.stdout.includes(value.pendingReport), false);
  assert.deepEqual(readPending(value), [value.pending[1]]);

  const noMatch = runCodexSetupProcess(
    ["prune", "--home", value.home, "--apply", "--confirm", "--session", "missing-session"],
    value,
  );
  assert.equal(noMatch.status, 0, noMatch.stderr);
  assert.match(noMatch.stdout, /deleted codex pending turns: 0/);
  assert.deepEqual(readPending(value), [value.pending[1]]);

  const missingApply = runCodexSetupProcess(["prune", "--home", value.home, "--confirm"], value);
  assert.equal(missingApply.status, 2);
  assert.match(missingApply.stderr, /--apply/);

  const emptySession = runCodexSetupProcess(
    ["prune", "--home", value.home, "--session", ""],
    value,
  );
  assert.equal(emptySession.status, 2);
  assert.match(emptySession.stderr, /--session/);

  const db = openDatabase(value.databasePath);
  try {
    const store = new PiInteractionStore(db);
    assert.equal(store.get("pi-session", "pi-interaction")?.status, "completed");
    assert.equal(
      store.get("codex-completed-session", codexInteractionId("codex-completed-session", "turn"))
        ?.status,
      "completed",
    );
    assert.equal(store.get("codex-failed-session", "codex-failed-interaction")?.status, "failed");
  } finally {
    db.close();
  }
});

test("prune helpers list and delete only non-empty Codex pending keys", () => {
  const db = openDatabase(":memory:");
  const store = new PiInteractionStore(db);
  try {
    const sessionId = "helper-session";
    const turnId = "helper-turn";
    stageCodexPrompt(db, {
      kind: "promptObserved",
      sessionId,
      turnId,
      submittedPrompt: "helper pending prompt",
    });
    db.prepare(
      `INSERT INTO pi_interactions (
         interaction_id, session_id, submitted_prompt, effective_prompt,
         final_report, status, failure_reason, provenance, dedup_key
       ) VALUES (?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)`,
    ).run("", "", "ambiguous body", CODEX_NATIVE_HOOKS_PROVENANCE, "ambiguous-key");
    db.prepare(
      `INSERT INTO pi_interactions (
         interaction_id, session_id, submitted_prompt, effective_prompt,
         final_report, status, failure_reason, provenance, dedup_key
       ) VALUES (?, ?, ?, NULL, NULL, 'pending', NULL, ?, ?)`,
    ).run("other-interaction", "other-session", "other body", "pi-observer", "other-key");
    const pending = listCodexPending(db);
    assert.equal(pending.length, 1);
    const first = pending.at(0);
    assert.ok(first);
    assert.equal("submittedPrompt" in first, false);
    assert.deepEqual(deleteCodexPending(db, ["", "unknown-dedup-key"]), { deleted: [] });
    assert.deepEqual(listCodexPending(db), pending);
    assert.deepEqual(deleteCodexPending(db, ["ambiguous-key", "other-key"]), { deleted: [] });
    assert.deepEqual(deleteCodexPending(db, [first.dedupKey, "unknown-dedup-key"]), {
      deleted: [first.dedupKey],
    });
    assert.deepEqual(listCodexPending(db), []);
    assert.equal(store.get(sessionId, codexInteractionId(sessionId, turnId)), null);
    assert.equal(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM pi_interactions WHERE dedup_key IN ('ambiguous-key', 'other-key')",
          )
          .get() as { count: number }
      ).count,
      2,
    );
  } finally {
    db.close();
  }
});

test("status reports pending Codex count without changing setup state", () => {
  const value = pruneFixture();
  const result = runCodexSetupProcess(["status", "--home", value.home], value);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pending codex turns: 2/);
  assert.equal(result.stdout.includes(value.pendingPrompt), false);
  assert.equal(result.stdout.includes(value.pendingReport), false);
  assert.equal(statusCodexCollector({ homeDir: value.home }, 2).pendingCodexTurns, 2);
});

test("installs a self-contained support tree and runs the installed submit hook", () => {
  const home = fixture();
  const paths = getCodexSetupPaths(home);
  installCodexCollector({ homeDir: home });

  for (const relativePath of CODEX_COLLECTOR_SOURCE_FILES) {
    const installedPath = join(paths.supportDirectory, relativePath);
    assert.equal(existsSync(installedPath), true, relativePath);
    const source = readFileSync(installedPath, "utf8");
    for (const specifier of relativeImportSpecifiers(source)) {
      const importedPath = join(installedPath, "..", specifier);
      assert.equal(
        existsSync(importedPath),
        true,
        `${relativePath} has no installed target for ${specifier}`,
      );
    }
  }

  const stateDirectory = join(home, "state");
  mkdirSync(stateDirectory, { recursive: true });
  const sessionId = "installed-submit-session";
  const turnId = "installed-submit-turn";
  const submittedPrompt = "  installed prompt\n二行目🚀  ";
  const result = spawnSync(
    process.execPath,
    [join(paths.supportDirectory, "src", "codex", "submit-hook.ts")],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: home,
        HARVEST_CODEX_COLLECT: "1",
        HARVEST_STATE_DIR: stateDirectory,
      },
      input: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: sessionId,
        turn_id: turnId,
        prompt: submittedPrompt,
      }),
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  const db = openDatabase(join(stateDirectory, "harvest.db"));
  try {
    const store = new PiInteractionStore(db);
    const interaction = store.get(sessionId, codexInteractionId(sessionId, turnId));
    assert.ok(interaction);
    assert.equal(interaction.status, "pending");
    assert.equal(interaction.submittedPrompt, submittedPrompt);
    assert.equal(interaction.finalReport, null);
    assert.equal(interaction.provenance, CODEX_NATIVE_HOOKS_PROVENANCE);
  } finally {
    db.close();
  }
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

interface PruneFixture {
  home: string;
  stateDirectory: string;
  databasePath: string;
  pending: CodexPendingTurn[];
  pendingPrompt: string;
  pendingReport: string;
}

function pruneFixture(): PruneFixture {
  const base = mkdtempSync(join(tmpdir(), "herdr-harvest-codex-prune-"));
  temporaryDirectories.push(base);
  const home = join(base, "home");
  const stateDirectory = join(base, "state");
  mkdirSync(home, { recursive: true });
  mkdirSync(stateDirectory, { recursive: true });
  const databasePath = join(stateDirectory, "harvest.db");
  const pendingPrompt = "pending prompt α\n  ";
  const pendingReport = "pending report β\n";

  const db = openDatabase(databasePath);
  try {
    const store = new PiInteractionStore(db);
    store.insert({
      interactionId: "pi-interaction",
      sessionId: "pi-session",
      submittedPrompt: "pi prompt",
      effectivePrompt: null,
      finalReport: "pi report",
      status: "completed",
      reason: null,
      provenance: "pi-observer",
    });
    store.insert({
      interactionId: codexInteractionId("codex-completed-session", "turn"),
      sessionId: "codex-completed-session",
      submittedPrompt: "completed codex prompt",
      effectivePrompt: null,
      finalReport: "completed codex report",
      status: "completed",
      reason: null,
      provenance: CODEX_NATIVE_HOOKS_PROVENANCE,
    });
    store.insert({
      interactionId: "codex-failed-interaction",
      sessionId: "codex-failed-session",
      submittedPrompt: "failed codex prompt",
      effectivePrompt: null,
      finalReport: null,
      status: "failed",
      reason: "cancelled",
      provenance: CODEX_NATIVE_HOOKS_PROVENANCE,
    });
    stageCodexPrompt(db, {
      kind: "promptObserved",
      sessionId: "codex-session-a",
      turnId: "turn-a",
      submittedPrompt: pendingPrompt,
    });
    stageCodexReport(db, {
      kind: "reportObserved",
      sessionId: "codex-session-a",
      turnId: "turn-a",
      provisionalReport: pendingReport,
    });
    stageCodexPrompt(db, {
      kind: "promptObserved",
      sessionId: "codex-session-b",
      turnId: "turn-b",
      submittedPrompt: "second pending prompt",
    });
    stageCodexReport(db, {
      kind: "reportObserved",
      sessionId: "codex-session-b",
      turnId: "turn-b",
      provisionalReport: "second pending report",
    });
    return {
      home,
      stateDirectory,
      databasePath,
      pending: listCodexPending(db),
      pendingPrompt,
      pendingReport,
    };
  } finally {
    db.close();
  }
}

function readPending(value: PruneFixture): CodexPendingTurn[] {
  const db = openDatabase(value.databasePath);
  try {
    return listCodexPending(db);
  } finally {
    db.close();
  }
}

function runCodexSetupProcess(args: readonly string[], value: PruneFixture) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: value.home,
    HARVEST_STATE_DIR: value.stateDirectory,
  };
  delete env.HERDR_PLUGIN_STATE_DIR;
  return spawnSync(process.execPath, [setupBinary, ...args], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  });
}

function relativeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const pattern = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}
