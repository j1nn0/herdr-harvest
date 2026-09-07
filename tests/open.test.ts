import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));

interface CommandRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function commandPath(directory: string): string {
  const path = join(directory, "herdr-stub");
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
if (process.env.REPORT_ERROR === "1") {
  process.stdout.write(JSON.stringify({ error: { code: "pane_open_failed" }, id: "cli:open" }));
} else if (process.env.REPORT_FAILURE === "1") {
  process.stderr.write("stub command failed");
  process.exitCode = 9;
} else {
  process.stdout.write(JSON.stringify({ id: "cli:open", result: { type: "pane_info" } }));
}
`,
    { mode: 0o755 },
  );
  chmodSync(path, 0o755);
  return path;
}

async function runOpen(env: NodeJS.ProcessEnv): Promise<CommandRun> {
  try {
    const result = await execFileAsync(process.execPath, ["src/bin/open.ts"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env,
    });
    return { exitCode: 0, stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const details = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    return {
      exitCode: typeof details.code === "number" ? details.code : 1,
      stdout: typeof details.stdout === "string" ? details.stdout : String(details.stdout ?? ""),
      stderr: typeof details.stderr === "string" ? details.stderr : String(details.stderr ?? ""),
    };
  }
}

describe("open entrypoint", () => {
  test("passes the exact pane-open argv and exits zero on a successful Herdr response", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-open-"));
    const argsPath = join(directory, "args.json");
    try {
      const result = await runOpen({
        ...process.env,
        HERDR_BIN_PATH: commandPath(directory),
        ARGS_FILE: argsPath,
      });

      assert.equal(result.exitCode, 0);
      assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
        "plugin",
        "pane",
        "open",
        "--plugin",
        "j1nn0.herdr-harvest",
        "--entrypoint",
        "inbox",
        "--placement",
        "overlay",
        "--focus",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("treats a zero-exit JSON error envelope as failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-open-"));
    try {
      const result = await runOpen({
        ...process.env,
        HERDR_BIN_PATH: commandPath(directory),
        ARGS_FILE: join(directory, "args.json"),
        REPORT_ERROR: "1",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /pane_open_failed/);
      assert.match(result.stderr, /cli:open/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports a non-zero Herdr process failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-open-"));
    try {
      const result = await runOpen({
        ...process.env,
        HERDR_BIN_PATH: commandPath(directory),
        ARGS_FILE: join(directory, "args.json"),
        REPORT_FAILURE: "1",
      });

      assert.equal(result.exitCode, 1);
      assert.match(result.stderr, /stub command failed/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
