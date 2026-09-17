#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureStoreDirectory, readInteractions } from "./store.mjs";

const PI_VERSION_EXPECTED = "0.85.1";
const PROMPTS = [
  "Reply with FIRST_REPORT_7319.",
  "Reply with SECOND_REPORT_8246.",
];
const EXPECTED_REPORTS = [
  "FIRST_REPORT_7319",
  "SECOND_REPORT_8246",
];
const DEFAULT_TIMEOUT_MS = 180_000;

const options = parseOptions(process.argv.slice(2));

try {
  const result = await runLiveVerification(options);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.status !== "success") {
    process.exitCode = 1;
  }
} catch (error) {
  process.stdout.write(JSON.stringify({
    status: "harness-error",
    reason: safeErrorCode(error),
  }) + "\n");
  process.exitCode = 1;
}

async function runLiveVerification(runOptions) {
  const base = await mkdtemp(join(tmpdir(), "pi-collector-live-"));
  await chmod(base, 0o700);
  const projectDir = join(base, "project");
  const sessionDir = join(base, "sessions");
  const storeDir = join(base, "collector");
  await createPrivateDirectory(projectDir);
  await createPrivateDirectory(sessionDir);
  await ensureStoreDirectory(storeDir);

  const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "extension.mjs");
  const processResults = [];
  let status = "success";
  let reason;
  try {
    for (const prompt of PROMPTS) {
      const processResult = await runPi({
        piBinary: runOptions.piBinary,
        extensionPath,
        projectDir,
        sessionDir,
        storeDir,
        prompt,
        provider: runOptions.provider,
        model: runOptions.model,
        timeoutMs: runOptions.timeoutMs,
      });
      processResults.push(processResult);
      if (processResult.exitCode !== 0) {
        status = "pi-process-failed";
        reason = processResult.errorCode ?? "non-zero-exit";
        break;
      }
    }

    const records = await readInteractions(storeDir);
    const evidence = records.map((record) => ({
      idHash: digest(record.id),
      sessionIdHash: digest(record.sessionId),
      promptBytes: byteLength(record.prompt),
      promptHash: digest(record.prompt),
      finalReportBytes: typeof record.finalReport === "string" ? byteLength(record.finalReport) : null,
      finalReportHash: typeof record.finalReport === "string" ? digest(record.finalReport) : null,
      status: record.status,
      finalReportExact: typeof record.finalReport === "string"
        ? EXPECTED_REPORTS.includes(record.finalReport)
        : false,
    }));
    const promptsExact = records.length === PROMPTS.length &&
      records.every((record, index) => record.prompt === PROMPTS[index]);
    const terminalCompleted = records.length === PROMPTS.length &&
      records.every((record) => record.status === "completed" &&
        typeof record.finalReport === "string" &&
        record.finalReport.length > 0);
    const idsDistinct = new Set(records.map((record) => record.id)).size === records.length;
    const sessionIdsDistinct = new Set(records.map((record) => record.sessionId)).size === records.length;
    const fileBytes = await storeByteLength(storeDir);

    if (status === "success" && (!promptsExact || !terminalCompleted || !idsDistinct || !sessionIdsDistinct)) {
      status = "verification-failed";
      reason = !promptsExact
        ? "observed-prompts-differ"
        : !terminalCompleted
          ? "missing-completed-reports"
          : !idsDistinct
            ? "duplicate-interaction-ids"
            : "session-identities-not-distinct";
    }

    const result = {
      status,
      reason,
      piVersionExpected: PI_VERSION_EXPECTED,
      artifactDir: base,
      storeFileBytes: fileBytes,
      promptsExact,
      interactionCount: records.length,
      idsDistinct,
      sessionIdsDistinct,
      processResults,
      interactions: evidence,
      privateContentsPrinted: false,
      globalConfigChanged: false,
      credentialsCopied: false,
    };
    if (runOptions.cleanup) {
      await rm(base, { recursive: true, force: true });
      result.cleanedUp = true;
      delete result.artifactDir;
    } else {
      result.cleanedUp = false;
    }
    return result;
  } catch (error) {
    if (runOptions.cleanup) {
      await rm(base, { recursive: true, force: true });
    }
    throw error;
  }
}

async function runPi({
  piBinary,
  extensionPath,
  projectDir,
  sessionDir,
  storeDir,
  prompt,
  provider,
  model,
  timeoutMs,
}) {
  const args = [
    "--no-extensions",
    "--extension",
    extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--session-dir",
    sessionDir,
    "--mode",
    "text",
    "--print",
    prompt,
  ];
  if (provider !== undefined) {
    args.push("--provider", provider);
  }
  if (model !== undefined) {
    args.push("--model", model);
  }

  const environment = {
    ...process.env,
    PI_COLLECTOR_DIR: storeDir,
  };
  return new Promise((resolveResult) => {
    let settled = false;
    const child = spawn(piBinary, args, {
      cwd: projectDir,
      env: environment,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      finish({ exitCode: null, signal: "SIGTERM", errorCode: "timeout" });
    }, timeoutMs);
    child.once("error", (error) => {
      finish({ exitCode: null, signal: null, errorCode: safeErrorCode(error) });
    });
    child.once("exit", (exitCode, signal) => {
      finish({ exitCode, signal, errorCode: exitCode === 0 ? undefined : "non-zero-exit" });
    });

    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    }
  });
}

async function createPrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function storeByteLength(storeDir) {
  try {
    return (await stat(join(storeDir, "interactions.json"))).size;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

function parseOptions(argv) {
  const options = {
    piBinary: process.env.PI_BIN ?? "pi",
    provider: optionalValue(process.env.PI_LIVE_PROVIDER),
    model: optionalValue(process.env.PI_LIVE_MODEL),
    timeoutMs: parseTimeout(process.env.PI_LIVE_TIMEOUT_MS),
    cleanup: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--cleanup") {
      options.cleanup = true;
    } else if (argument === "--pi") {
      options.piBinary = requiredArgument(argv, ++index, "--pi");
    } else if (argument === "--provider") {
      options.provider = requiredArgument(argv, ++index, "--provider");
    } else if (argument === "--model") {
      options.model = requiredArgument(argv, ++index, "--model");
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = parseTimeout(requiredArgument(argv, ++index, "--timeout-ms"));
    } else {
      throw new Error("unknown harness option");
    }
  }
  return options;
}

function requiredArgument(argv, index, option) {
  const value = argv[index];
  if (value === undefined || value.length === 0) {
    throw new Error(option + " requires a value");
  }
  return value;
}

function parseTimeout(value) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 600_000) {
    throw new Error("timeout must be between 1000 and 600000 milliseconds");
  }
  return parsed;
}

function optionalValue(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function byteLength(value) {
  return typeof value === "number" ? value : Buffer.byteLength(value, "utf8");
}

function safeErrorCode(error) {
  if (typeof error?.code === "string" && error.code.length > 0) {
    return error.code.slice(0, 64);
  }
  return error?.name === "Error" ? "error" : "harness-error";
}
