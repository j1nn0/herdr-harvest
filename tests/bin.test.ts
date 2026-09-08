import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { openDatabase } from "../src/persistence/database.ts";
import { SqliteResultStore } from "../src/persistence/result-store.ts";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("hook entrypoint", () => {
  test("captures one done event and deduplicates an identical rerun", async () => {
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
      assert.equal(summary(second.stdout).status, "duplicate");
      assert.equal(readRows(fixture.stateDirectory).length, 1);
      assert.equal(readRows(fixture.stateDirectory)[0]?.rawText, "stub output\n\n世界 🚀  \n");
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

async function runCaptureEntrypoint(env: NodeJS.ProcessEnv): Promise<HookRun> {
  try {
    const result = await execFileAsync(process.execPath, ["src/bin/capture.ts"], {
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
  const stubPath = join(stateDirectory, "herdr-stub.cjs");
  writeFileSync(stubPath, HERDR_STUB, { mode: 0o755 });
  chmodSync(stubPath, 0o755);

  return {
    stateDirectory,
    stubPath,
    env: {
      ...process.env,
      HARVEST_STATE_DIR: stateDirectory,
      HARVEST_CAPTURE_LINES: "120",
      HARVEST_CAPTURE_SOURCE: "detection",
      HERDR_BIN_PATH: stubPath,
      HERDR_PLUGIN_EVENT: "pane.agent_status_changed",
    },
    cleanup: () => rmSync(stateDirectory, { recursive: true, force: true }),
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

const HERDR_STUB = `#!/usr/bin/env node
const args = process.argv.slice(2);
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
