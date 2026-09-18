#!/usr/bin/env -S node --experimental-strip-types
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { sha256 } from "./contract.ts";
import { readInteractions, readStoredHookEvents } from "./store.ts";
import type { HookEvent, Interaction } from "./contract.ts";

const collectorDirectoryName = "collector-store";
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const firstPrompt = "Synthetic live E2E prompt one: report a bounded marker.";
const secondPrompt = "Synthetic live E2E prompt two: report a second bounded marker.";

async function main(): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), "codex-collector-live-e2e-"));
  try {
    const project = join(root, "project");
    const codexHome = join(root, "codex-home");
    const collectorRoot = join(root, collectorDirectoryName);
    const realCodexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
    await mkdir(project, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    await writeFile(join(project, "synthetic-content.txt"), "synthetic E2E fixture\n", "utf8");
    await copyFile(join(realCodexHome, "auth.json"), join(codexHome, "auth.json"));
    await writeFile(join(codexHome, "config.toml"), configToml(), { mode: 0o600 });

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_COLLECTOR_DIR: collectorRoot,
    };
    const firstRun = await runCodex(
      [
        "exec",
        "--dangerously-bypass-hook-trust",
        "--skip-git-repo-check",
        "--sandbox",
        "read-only",
        "--strict-config",
        firstPrompt,
      ],
      project,
      env,
    );
    assertRunSucceeded("first", firstRun);

    const secondRun = await runCodex(
      [
        "exec",
        "resume",
        "--last",
        "--dangerously-bypass-hook-trust",
        "--skip-git-repo-check",
        secondPrompt,
      ],
      project,
      env,
    );
    assertRunSucceeded("second", secondRun);

    const interactions = await readInteractions(collectorRoot);
    const events = await readStoredHookEvents(collectorRoot);
    if (interactions.length !== 2) {
      throw new HarnessError(`expected-two-interactions-${interactions.length}`);
    }
    verifyByteExactness(interactions, events);
    verifyExpectedPrompts(interactions);

    const summary = {
      interactionCount: interactions.length,
      interactions: interactions.map(summarizeInteraction),
      runs: [summarizeRun(firstRun), summarizeRun(secondRun)],
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`codex-collector live-e2e failure code=${errorCode(error)}\n`);
    return 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function configToml(): string {
  const promptCommand = commandFor(join(moduleDirectory, "prompt-hook.ts"));
  const stopCommand = commandFor(join(moduleDirectory, "stop-hook.ts"));
  return [
    "[features]",
    "hooks = true",
    "",
    "[[hooks.UserPromptSubmit]]",
    "[[hooks.UserPromptSubmit.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(promptCommand)}`,
    "timeout = 15",
    "",
    "[[hooks.Stop]]",
    "[[hooks.Stop.hooks]]",
    'type = "command"',
    `command = ${JSON.stringify(stopCommand)}`,
    "timeout = 15",
    "",
  ].join("\n");
}

function commandFor(scriptPath: string): string {
  return `node --experimental-strip-types ${shellQuote(scriptPath)}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function verifyByteExactness(interactions: Interaction[], events: HookEvent[]): void {
  for (const interaction of interactions) {
    const promptEvent = events.find(
      (event) =>
        event.kind === "prompt" &&
        event.sessionId === interaction.sessionId &&
        event.turnId === interaction.turnId,
    );
    const stopEvent = events.find(
      (event) =>
        event.kind === "stop" &&
        event.sessionId === interaction.sessionId &&
        event.turnId === interaction.turnId,
    );
    if (promptEvent === undefined || stopEvent === undefined) {
      throw new HarnessError("missing-wire-event");
    }
    if (
      !Buffer.from(promptEvent.text, "utf8").equals(Buffer.from(interaction.submittedPrompt, "utf8")) ||
      !Buffer.from(stopEvent.text, "utf8").equals(Buffer.from(interaction.finalReport, "utf8"))
    ) {
      throw new HarnessError("wire-store-byte-mismatch");
    }
  }
}

function verifyExpectedPrompts(interactions: Interaction[]): void {
  const actual = interactions.map((interaction) => sha256(interaction.submittedPrompt)).sort();
  const expected = [sha256(firstPrompt), sha256(secondPrompt)].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new HarnessError("submitted-prompt-set-mismatch");
  }
}

interface RunSummary {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdoutByteLength: number;
  stdoutSha256: string;
  stderrByteLength: number;
  stderrSha256: string;
}

function runCodex(args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<RunSummary> {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => child.kill("SIGTERM"), 30 * 60 * 1_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolve({
        code,
        signal,
        stdoutByteLength: stdoutBuffer.byteLength,
        stdoutSha256: hashBuffer(stdoutBuffer),
        stderrByteLength: stderrBuffer.byteLength,
        stderrSha256: hashBuffer(stderrBuffer),
      });
    });
  });
}

function assertRunSucceeded(label: string, run: RunSummary): void {
  if (run.code !== 0) {
    throw new HarnessError(`${label}-codex-exit-${run.code ?? "signal"}`);
  }
}

function summarizeInteraction(interaction: Interaction): Record<string, string | number> {
  return {
    id: interaction.id,
    sessionId: interaction.sessionId,
    turnId: interaction.turnId,
    promptByteLength: Buffer.byteLength(interaction.submittedPrompt, "utf8"),
    promptSha256: sha256(interaction.submittedPrompt),
    reportByteLength: Buffer.byteLength(interaction.finalReport, "utf8"),
    reportSha256: sha256(interaction.finalReport),
  };
}

function summarizeRun(run: RunSummary): RunSummary {
  return { ...run };
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

class HarnessError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

function errorCode(error: unknown): string {
  if (error instanceof HarnessError) {
    return error.code;
  }
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    if (typeof code === "string") {
      return code;
    }
  }
  return "unexpected-error";
}

process.exitCode = await main();
