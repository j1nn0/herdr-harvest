import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openDatabase } from "../src/persistence/database.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";
import { RUNTIME_LOCATOR_FILE_NAME } from "../src/runtime/locator.ts";
import { removeDirectory } from "./helpers/remove-directory.ts";
import { spawnableCommand } from "./helpers/spawnable-command.ts";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("hook entrypoint", () => {
  test("captures one done event and skips an identical rerun", async () => {
    const fixture = makeFixture();

    try {
      const env = {
        ...fixture.env,
        HERDR_PLUGIN_EVENT_JSON: doneEvent(),
      };
      const first = await runHook(env);
      const second = await runHook(env);

      assert.equal(first.exitCode, 0);
      assert.equal(second.exitCode, 0);
      assert.equal(summary(first.stdout).status, "captured");
      assert.equal(summary(second.stdout).status, "skipped");
      assert.equal(summary(second.stdout).reason, "ignored duplicate done after done");
      assert.equal(readRows(fixture.stateDirectory).length, 1);
      assert.equal(readRows(fixture.stateDirectory)[0]?.rawText, "stub output\n\n世界 🚀  \n");
      // The automatic hook never infers an orchestration claim.
      assert.equal(readRows(fixture.stateDirectory)[0]?.orchestrationId, null);
      assert.equal(readRows(fixture.stateDirectory)[0]?.orchestrationLabel, null);
      assert.equal(readRows(fixture.stateDirectory)[0]?.orchestrationRole, null);
    } finally {
      fixture.cleanup();
    }
  });

  test("ignores a working event without writing a row", async () => {
    const fixture = makeFixture();

    try {
      const result = await runHook({
        ...fixture.env,
        HERDR_PLUGIN_EVENT_JSON: eventWithStatus("working"),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
      assert.equal(readRows(fixture.stateDirectory).length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test("captures a foreground completion reported as working then idle exactly once", async () => {
    const fixture = makeFixture();

    try {
      const working = await runHook({
        ...fixture.env,
        HERDR_PLUGIN_EVENT_JSON: eventWithStatus("working"),
      });
      const idle = await runHook({
        ...fixture.env,
        HERDR_PLUGIN_EVENT_JSON: eventWithStatus("idle"),
      });
      const duplicateIdle = await runHook({
        ...fixture.env,
        HERDR_PLUGIN_EVENT_JSON: eventWithStatus("idle"),
      });

      assert.equal(working.exitCode, 0);
      assert.equal(working.stdout, "");
      assert.equal(working.stderr, "");
      assert.equal(idle.exitCode, 0);
      assert.equal(summary(idle.stdout).status, "captured");
      assert.equal(duplicateIdle.exitCode, 0);
      assert.equal(summary(duplicateIdle.stdout).status, "skipped");
      assert.equal(readRows(fixture.stateDirectory).length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test("skips a lone idle event without writing a result", async () => {
    const fixture = makeFixture();

    try {
      const result = await runHook({
        ...fixture.env,
        HERDR_PLUGIN_EVENT_JSON: eventWithStatus("idle"),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(summary(result.stdout).status, "skipped");
      assert.equal(summary(result.stdout).reason, "ignored idle without preceding work");
      assert.equal(result.stderr, "");
      assert.equal(readRows(fixture.stateDirectory).length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test("reports malformed event JSON on stderr and exits zero", async () => {
    const fixture = makeFixture();

    try {
      const result = await runHook({ ...fixture.env, HERDR_PLUGIN_EVENT_JSON: "not json" });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /must contain valid JSON/);
    } finally {
      fixture.cleanup();
    }
  });

  test("reports a missing event without crashing", async () => {
    const fixture = makeFixture();

    try {
      const env = { ...fixture.env };
      delete env.HERDR_PLUGIN_EVENT_JSON;
      const result = await runHook(env);

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /missing HERDR_PLUGIN_EVENT_JSON/);
    } finally {
      fixture.cleanup();
    }
  });

  test("returns exit code one and writes no row when both reads fail", async () => {
    const fixture = makeFixture();

    try {
      const result = await runHook({
        ...fixture.env,
        HERDR_PLUGIN_EVENT_JSON: doneEvent(),
        STUB_FAIL_READ: "1",
      });

      assert.equal(result.exitCode, 1);
      assert.equal(summary(result.stdout).status, "failed");
      assert.equal(readRows(fixture.stateDirectory).length, 0);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("capture entrypoint", () => {
  test("resolves the pane id from plugin context before HERDR_PANE_ID", async () => {
    const fixture = makeFixture();

    try {
      const result = await runCaptureEntrypoint({
        ...fixture.env,
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({ focused_pane_id: "w1G:p1" }),
        HERDR_PANE_ID: "w1G:p2",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(summary(result.stdout).paneId, "w1G:p1");
    } finally {
      fixture.cleanup();
    }
  });

  test("falls back to HERDR_PANE_ID when plugin context is unavailable", async () => {
    const fixture = makeFixture();

    try {
      const env: NodeJS.ProcessEnv = { ...fixture.env, HERDR_PANE_ID: "w1G:p1" };
      delete env.HERDR_PLUGIN_CONTEXT_JSON;
      const result = await runCaptureEntrypoint(env);

      assert.equal(result.exitCode, 0);
      assert.equal(summary(result.stdout).paneId, "w1G:p1");
    } finally {
      fixture.cleanup();
    }
  });

  test("returns the usage error when no pane id is available", async () => {
    const fixture = makeFixture();

    try {
      const env = { ...fixture.env };
      delete env.HERDR_PLUGIN_CONTEXT_JSON;
      delete env.HERDR_PANE_ID;
      const result = await runCaptureEntrypoint(env);

      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /No pane id was provided/);
      assert.match(result.stderr, /Usage: node src\/bin\/capture\.ts/);
    } finally {
      fixture.cleanup();
    }
  });

  test("captures without a claim through the legacy pane option", async () => {
    const fixture = makeFixture();

    try {
      const result = await runCaptureEntrypoint(fixture.env, ["--pane", "w1G:p1"]);

      assert.equal(result.exitCode, 0);
      const summary = summaryOf(result.stdout);
      assert.deepEqual(Object.keys(summary), ["status", "paneId", "id"]);
      assert.equal(summary.status, "captured");
      assert.equal(summary.paneId, "w1G:p1");
      assert.equal(typeof summary.id, "string");

      const rows = readRows(fixture.stateDirectory);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.orchestrationId, null);
      assert.equal(rows[0]?.orchestrationLabel, null);
      assert.equal(rows[0]?.orchestrationRole, null);
    } finally {
      fixture.cleanup();
    }
  });

  test("claims a capture through the orchestration options", async () => {
    const fixture = makeFixture();

    try {
      const result = await runCaptureEntrypoint(fixture.env, claimArgs(CLAIM_ID));

      assert.equal(result.exitCode, 0);
      const summary = summaryOf(result.stdout);
      assert.deepEqual(Object.keys(summary), ["status", "paneId", "id", "orchestration"]);
      assert.equal(summary.status, "captured");
      assert.deepEqual(summary.orchestration, { status: "claimed", id: CLAIM_ID });

      const rows = readRows(fixture.stateDirectory);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.orchestrationId, CLAIM_ID);
      assert.equal(rows[0]?.orchestrationLabel, "探索: fix the parser");
      assert.equal(rows[0]?.orchestrationRole, "explorer");
    } finally {
      fixture.cleanup();
    }
  });

  test("reports an idempotent claim when the same claim runs twice", async () => {
    const fixture = makeFixture();

    try {
      await runCaptureEntrypoint(fixture.env, claimArgs(CLAIM_ID));
      const second = await runCaptureEntrypoint(fixture.env, claimArgs(CLAIM_ID));

      assert.equal(second.exitCode, 0);
      const summary = summaryOf(second.stdout);
      assert.equal(summary.status, "duplicate");
      assert.deepEqual(summary.orchestration, { status: "already_claimed", id: CLAIM_ID });
      assert.equal(readRows(fixture.stateDirectory).length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test("exits three on an orchestration conflict", async () => {
    const fixture = makeFixture();

    try {
      await runCaptureEntrypoint(fixture.env, claimArgs(CLAIM_ID));
      const conflict = await runCaptureEntrypoint(fixture.env, claimArgs(RIVAL_ID));

      assert.equal(conflict.exitCode, 3);
      const summary = summaryOf(conflict.stdout);
      assert.deepEqual(Object.keys(summary), [
        "status",
        "paneId",
        "id",
        "requestedOrchestrationId",
        "existingOrchestrationId",
      ]);
      assert.equal(summary.status, "conflict");
      assert.equal(summary.requestedOrchestrationId, RIVAL_ID);
      assert.equal(summary.existingOrchestrationId, CLAIM_ID);
      assert.doesNotMatch(conflict.stdout, /stub output/);

      const rows = readRows(fixture.stateDirectory);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.orchestrationId, CLAIM_ID);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a partial claim without capturing", async () => {
    const fixture = makeFixture();

    try {
      const result = await runCaptureEntrypoint(fixture.env, [
        "--pane",
        "w1G:p1",
        "--orchestration-id",
        CLAIM_ID,
      ]);

      assert.equal(result.exitCode, 2);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /orchestration claim needs/i);
      assert.equal(readRows(fixture.stateDirectory).length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test("rejects a malformed claim id or role", async () => {
    const fixture = makeFixture();

    try {
      const badId = await runCaptureEntrypoint(fixture.env, claimArgs("orch_7f3a"));
      assert.equal(badId.exitCode, 2);
      assert.match(badId.stderr, /canonical lowercase UUIDv4/);

      const badRole = await runCaptureEntrypoint(fixture.env, [
        "--pane",
        "w1G:p1",
        "--orchestration-id",
        CLAIM_ID,
        "--orchestration-label",
        "Task",
        "--orchestration-role",
        "Explorer",
      ]);
      assert.equal(badRole.exitCode, 2);
      assert.match(badRole.stderr, /must be one of explorer, fixer/);

      assert.equal(readRows(fixture.stateDirectory).length, 0);
    } finally {
      fixture.cleanup();
    }
  });

  test("preserves a Unicode label through the command line", async () => {
    const fixture = makeFixture();

    try {
      const label = "  探索 🔍 — 修正  ";
      const result = await runCaptureEntrypoint(fixture.env, [
        "--pane",
        "w1G:p1",
        "--orchestration-id",
        CLAIM_ID,
        "--orchestration-label",
        label,
        "--orchestration-role",
        "explorer",
      ]);

      assert.equal(result.exitCode, 0);
      const stored = readRows(fixture.stateDirectory)[0]?.orchestrationLabel ?? "";
      assert.equal(stored, label);
      assert.deepEqual([...stored], [...label]);
    } finally {
      fixture.cleanup();
    }
  });

  test("exits one and writes no row when a claimed capture fails", async () => {
    const fixture = makeFixture();

    try {
      const result = await runCaptureEntrypoint(
        { ...fixture.env, STUB_FAIL_READ: "1" },
        claimArgs(CLAIM_ID),
      );

      assert.equal(result.exitCode, 1);
      assert.equal(summaryOf(result.stdout).status, "failed");
      assert.equal(readRows(fixture.stateDirectory).length, 0);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("capture capabilities", () => {
  test("prints help without any environment", async () => {
    const result = await runCaptureEntrypoint({}, ["--help"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /node src\/bin\/capture\.ts --capabilities/);
    assert.match(result.stdout, /--orchestration-id <uuid>/);
    assert.match(result.stdout, /Exit codes:/);
  });

  test("answers a capability probe with one JSON line and no environment", async () => {
    const result = await runCaptureEntrypoint({}, ["--capabilities"]);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.trimEnd().split("\n").length, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      protocol: "harvest-capture",
      protocolVersion: 1,
      features: ["orchestration-claim", "runtime-locator"],
      roles: ["explorer", "fixer"],
    });
  });
});

describe("runtime locator entrypoints", () => {
  test("publishes the locator from the startup entrypoint and exits zero", async () => {
    const fixture = makeFixture();
    const configDirectory = join(fixture.stateDirectory, "plugin-config");
    mkdirSync(configDirectory);

    try {
      const result = await runRegisterRuntime({
        ...process.env,
        HERDR_PLUGIN_CONFIG_DIR: configDirectory,
        HERDR_PLUGIN_STATE_DIR: fixture.stateDirectory,
        HERDR_SOCKET_PATH: "/run/herdr/nightly/herdr.sock",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
      const locatorPath = join(configDirectory, RUNTIME_LOCATOR_FILE_NAME);
      assert.equal(result.stdout, `Harvest runtime locator published: ${locatorPath}\n`);

      const locator = readLocator(configDirectory);
      assert.equal(typeof locator.updatedAtMs, "number");
      assert.deepEqual(locator, {
        protocol: "harvest-runtime-locator",
        protocolVersion: 1,
        pluginId: "j1nn0.herdr-harvest",
        stateDir: fixture.stateDirectory,
        socketPath: "/run/herdr/nightly/herdr.sock",
        updatedAtMs: locator.updatedAtMs,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test("exits zero and reports one line when the startup entrypoint cannot publish", async () => {
    const env = withoutLocatorPrerequisites({ ...process.env });

    const result = await runRegisterRuntime(env);

    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Harvest runtime locator not published: HERDR_PLUGIN_CONFIG_DIR is not set\n",
    );
  });

  test("refreshes the locator on an ignored event and replaces it on the next run", async () => {
    const fixture = makeFixture();
    const configDirectory = join(fixture.stateDirectory, "plugin-config");
    mkdirSync(configDirectory);

    try {
      const env = {
        ...fixture.env,
        HERDR_PLUGIN_CONFIG_DIR: configDirectory,
        HERDR_PLUGIN_STATE_DIR: fixture.stateDirectory,
        HERDR_SOCKET_PATH: "/run/herdr/first.sock",
      };
      const ignored = await runHook({
        ...env,
        HERDR_PLUGIN_EVENT_JSON: eventWithStatus("working"),
      });

      assert.equal(ignored.exitCode, 0);
      assert.equal(ignored.stdout, "");
      assert.equal(ignored.stderr, "");
      assert.equal(readLocator(configDirectory).socketPath, "/run/herdr/first.sock");
      assert.equal(readRows(fixture.stateDirectory).length, 0);

      const captured = await runHook({
        ...env,
        HERDR_SOCKET_PATH: "/run/herdr/second.sock",
        HERDR_PLUGIN_EVENT_JSON: doneEvent(),
      });

      assert.equal(captured.exitCode, 0);
      assert.equal(summary(captured.stdout).status, "captured");
      assert.equal(readLocator(configDirectory).socketPath, "/run/herdr/second.sock");
      assert.equal(readRows(fixture.stateDirectory).length, 1);
    } finally {
      fixture.cleanup();
    }
  });

  test("stays silent when the locator prerequisites are absent", async () => {
    const fixture = makeFixture();

    try {
      const result = await runHook({
        ...withoutLocatorPrerequisites({ ...fixture.env }),
        HERDR_PLUGIN_EVENT_JSON: eventWithStatus("working"),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, "");
    } finally {
      fixture.cleanup();
    }
  });

  test("captures normally and warns once when the locator cannot be written", async () => {
    const fixture = makeFixture();
    const configFile = join(fixture.stateDirectory, "config-is-a-file");
    writeFileSync(configFile, "not a directory\n");

    try {
      const result = await runHook({
        ...fixture.env,
        HERDR_PLUGIN_CONFIG_DIR: configFile,
        HERDR_PLUGIN_STATE_DIR: fixture.stateDirectory,
        HERDR_SOCKET_PATH: "/run/herdr/nightly/herdr.sock",
        HERDR_PLUGIN_EVENT_JSON: doneEvent(),
      });

      assert.equal(result.exitCode, 0);
      assert.equal(summary(result.stdout).status, "captured");
      assert.equal(readRows(fixture.stateDirectory).length, 1);

      const warnings = result.stderr.split("\n").filter((line) => line.length > 0);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0] ?? "", /^Harvest runtime locator not published: failed to write /);
    } finally {
      fixture.cleanup();
    }
  });
});

interface HookRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface HookSummary {
  status: string;
  paneId: string;
  id?: string;
  reason?: string;
  requestedOrchestrationId?: string;
  existingOrchestrationId?: string;
  orchestration?: { status: string; id: string };
}

interface Fixture {
  stateDirectory: string;
  stubPath: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
}

async function runHook(env: NodeJS.ProcessEnv): Promise<HookRun> {
  try {
    const result = await execFileAsync(process.execPath, ["src/bin/hook.ts"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    const details = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
    };
    return {
      exitCode: typeof details.code === "number" ? details.code : 1,
      stdout: typeof details.stdout === "string" ? details.stdout : String(details.stdout ?? ""),
      stderr: typeof details.stderr === "string" ? details.stderr : String(details.stderr ?? ""),
    };
  }
}

async function runCaptureEntrypoint(
  env: NodeJS.ProcessEnv,
  args: readonly string[] = [],
): Promise<HookRun> {
  try {
    const result = await execFileAsync(process.execPath, ["src/bin/capture.ts", ...args], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    return {
      exitCode: processExitCode(error),
      stdout: processOutput(error, "stdout"),
      stderr: processOutput(error, "stderr"),
    };
  }
}

async function runRegisterRuntime(env: NodeJS.ProcessEnv): Promise<HookRun> {
  try {
    const result = await execFileAsync(process.execPath, ["src/bin/register-runtime.ts"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env,
    });
    return {
      exitCode: 0,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  } catch (error) {
    return {
      exitCode: processExitCode(error),
      stdout: processOutput(error, "stdout"),
      stderr: processOutput(error, "stderr"),
    };
  }
}

/** Removes the three variables the runtime locator requires from an environment. */
function withoutLocatorPrerequisites(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const stripped: NodeJS.ProcessEnv = { ...env };
  delete stripped.HERDR_PLUGIN_CONFIG_DIR;
  delete stripped.HERDR_PLUGIN_STATE_DIR;
  delete stripped.HERDR_SOCKET_PATH;
  return stripped;
}

/** Reads and parses the locator published into a plugin config directory. */
function readLocator(configDirectory: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(configDirectory, RUNTIME_LOCATOR_FILE_NAME), "utf8"),
  ) as Record<string, unknown>;
}

function processExitCode(error: unknown): number {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
  ) {
    return error.code;
  }
  return 1;
}

function processOutput(error: unknown, field: "stdout" | "stderr"): string {
  if (typeof error !== "object" || error === null) {
    return "";
  }

  const value =
    field === "stdout"
      ? "stdout" in error
        ? error.stdout
        : undefined
      : "stderr" in error
        ? error.stderr
        : undefined;
  return typeof value === "string" ? value : String(value ?? "");
}

function makeFixture(): Fixture {
  const stateDirectory = mkdtempSync(join(tmpdir(), "herdr-harvest-hook-"));
  const stub = spawnableCommand(stateDirectory, "herdr-stub.cjs", HERDR_STUB);
  const stubPath = stub.path;

  return {
    stateDirectory,
    stubPath,
    env: {
      ...process.env,
      ...stub.env,
      HARVEST_STUB_RUN_BODY: "1",
      HARVEST_STATE_DIR: stateDirectory,
      HARVEST_CAPTURE_LINES: "120",
      HARVEST_CAPTURE_SOURCE: "detection",
      HERDR_BIN_PATH: stubPath,
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    },
    cleanup: () => removeDirectory(stateDirectory),
  };
}

function readRows(stateDirectory: string) {
  const store = new SqliteResultStore(openDatabase(join(stateDirectory, "harvest.db")));
  try {
    return store.list({ includeArchived: true });
  } finally {
    store.close();
  }
}

function summary(stdout: string): HookSummary {
  return JSON.parse(stdout.trim()) as HookSummary;
}

/** Parses one capture entrypoint summary line. */
function summaryOf(stdout: string): HookSummary {
  return summary(stdout);
}

/** The claim options every orchestration entrypoint test uses. */
function claimArgs(orchestrationId: string): string[] {
  return [
    "--pane",
    "w1G:p1",
    "--orchestration-id",
    orchestrationId,
    "--orchestration-label",
    "探索: fix the parser",
    "--orchestration-role",
    "explorer",
  ];
}

const CLAIM_ID = "2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50";
const RIVAL_ID = "7c9e1d2a-3b4c-4d5e-8f90-a1b2c3d4e5f6";

function doneEvent(): string {
  return eventWithStatus("done");
}

function eventWithStatus(status: string): string {
  return JSON.stringify({
    event: "pane_agent_status_changed",
    data: {
      type: "pane_agent_status_changed",
      pane_id: "w1G:p1",
      workspace_id: "w1G",
      agent_status: status,
      agent: "claude",
    },
  });
}

const HERDR_STUB = `const args = process.argv.slice(2);
const [scope, command] = args;

function output(value) {
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
}

if (scope === "agent" && command === "get") {
  output({
    id: "cli:agent:get",
    result: {
      agent: {
        agent: "claude",
        terminal_id: "term-1",
        focused: false,
        agent_session: { kind: "id", value: "stub-session" },
        agent_status: "done",
        revision: 1,
        name: "worker",
        pane_id: "w1G:p1",
        tab_id: "w1G:t1",
        terminal_title_stripped: "stub pane",
        workspace_id: "w1G"
      },
      type: "agent_info"
    }
  });
} else if (scope === "pane" && command === "get") {
  output({
    id: "cli:pane:get",
    result: {
      pane: {
        agent: "claude",
        terminal_id: "term-1",
        focused: false,
        agent_status: "done",
        revision: 1,
        pane_id: "w1G:p1",
        tab_id: "w1G:t1",
        terminal_title_stripped: "stub pane",
        workspace_id: "w1G"
      },
      type: "pane_info"
    }
  });
} else if ((scope === "agent" || scope === "pane") && command === "read") {
  if (process.env.STUB_FAIL_READ === "1") {
    process.stderr.write(
      JSON.stringify({
        error: {
          code: scope === "agent" ? "agent_read_failed" : "pane_read_failed",
          message: "stub read failed"
        },
        id: scope === "agent" ? "cli:agent:read" : "cli:pane:read"
      }),
    );
    process.exitCode = 1;
  } else if (scope === "agent") {
    output("stub output\\n\\n世界 🚀  \\n");
  } else {
    output("pane fallback output\\n");
  }
} else if (scope === "workspace" && command === "list") {
  output({
    id: "cli:workspace:list",
    result: { workspaces: [{ workspace_id: "w1G", label: "Stub Workspace" }] }
  });
} else {
  process.stderr.write("unsupported stub command\\n");
  process.exitCode = 1;
}
`;
