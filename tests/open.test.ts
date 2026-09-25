import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  createCliErrorOutputFixture,
  createPluginPaneOpenOutputFixture,
  serializeCliOutput,
} from "@j1nn0/herdr-plugin-sdk/testing";
import { spawnableCommand } from "./helpers/spawnable-command.ts";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PANE_OPEN_ERROR_OUTPUT = serializeCliOutput(
  createCliErrorOutputFixture({ code: "pane_open_failed", message: "Pane open failed." }),
);
const PANE_OPEN_SUCCESS_OUTPUT = serializeCliOutput(createPluginPaneOpenOutputFixture());

const HERDR_STUB_BODY = [
  'const fs = require("node:fs");',
  "fs.writeFileSync(process.env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));",
  'if (process.env.REPORT_ERROR === "1") {',
  '  process.stderr.write(process.env.HERDR_STUB_ERROR_OUTPUT ?? "");',
  "  process.exitCode = 7;",
  '} else if (process.env.REPORT_FAILURE === "1") {',
  '  process.stderr.write("stub command failed");',
  "  process.exitCode = 9;",
  "} else {",
  '  process.stdout.write(process.env.HERDR_STUB_SUCCESS_OUTPUT ?? "");',
  "}",
].join("\n");

interface CommandRun {
  exitCode: number;
  stdout: string;
  stderr: string;
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
      const command = spawnableCommand(directory, "herdr-stub", HERDR_STUB_BODY);
      const result = await runOpen({
        ...process.env,
        ...command.env,
        HERDR_BIN_PATH: command.path,
        ARGS_FILE: argsPath,
        HERDR_STUB_SUCCESS_OUTPUT: PANE_OPEN_SUCCESS_OUTPUT,
        HARVEST_STUB_RUN_BODY: "1",
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.stderr, "");
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

  test("reports a structured Herdr CLI error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-open-"));
    try {
      const command = spawnableCommand(directory, "herdr-stub", HERDR_STUB_BODY);
      const result = await runOpen({
        ...process.env,
        ...command.env,
        HERDR_BIN_PATH: command.path,
        ARGS_FILE: join(directory, "args.json"),
        REPORT_ERROR: "1",
        HERDR_STUB_ERROR_OUTPUT: PANE_OPEN_ERROR_OUTPUT,
      });

      assert.equal(result.exitCode, 1);
      assert.equal(
        result.stderr,
        "pane_open_failed: Herdr CLI error during plugin.pane.open (pane_open_failed): Pane open failed.\n",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("reports a non-zero Herdr process failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-open-"));
    try {
      const command = spawnableCommand(directory, "herdr-stub", HERDR_STUB_BODY);
      const result = await runOpen({
        ...process.env,
        ...command.env,
        HERDR_BIN_PATH: command.path,
        ARGS_FILE: join(directory, "args.json"),
        REPORT_FAILURE: "1",
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.stderr, "stub command failed\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  test("reports an unspawnable Herdr binary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-harvest-open-"));
    try {
      const result = await runOpen({
        ...process.env,
        HERDR_BIN_PATH: join(directory, "missing-herdr"),
      });

      assert.equal(result.exitCode, 1);
      assert.ok(result.stderr.trim().length > 0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
