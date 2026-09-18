#!/usr/bin/env node
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { collectInteractions } from "./contract.mjs";
import { readRecordedEvents } from "./record-event.mjs";

const claudePath = "/opt/homebrew/bin/claude";
const promptHook = join(import.meta.dirname, "prompt-hook.mjs");
const stopHook = join(import.meta.dirname, "stop-hook.mjs");
const prompts = [
  "Reply with exactly this text and nothing else:\n\nPOC-FINAL-ONE 🚀\n日本語の応答です。",
  "Reply with exactly this text and nothing else:\n\nPOC-FINAL-TWO 🧪\n日本語の二つ目の応答です。",
];
const expectedFinals = ["POC-FINAL-ONE 🚀\n日本語の応答です。", "POC-FINAL-TWO 🧪\n日本語の二つ目の応答です。"];

async function main() {
  const diagnosticsRoot = await mkdtemp(join(tmpdir(), "claude-collector-diagnostics-"));
  const diagnosticsPath = join(diagnosticsRoot, "claude-output.jsonl");
  await chmod(diagnosticsRoot, 0o700);
  await writeFile(diagnosticsPath, "", { mode: 0o600 });
  await chmod(diagnosticsPath, 0o600);

  const root = await mkdtemp(join(tmpdir(), "claude-collector-poc-"));
  const settingsPath = join(root, "settings.json");
  const collectorPath = join(root, "collector");
  const interruptedCollectorPath = join(root, "interrupted-collector");
  await chmod(root, 0o700);
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            { matcher: "*", hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(promptHook)}` }] },
          ],
          Stop: [
            { matcher: "*", hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(stopHook)}` }] },
          ],
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await chmod(settingsPath, 0o600);

  console.warn(`LIVE_E2E_DIAGNOSTICS file=${diagnosticsPath}`);
  console.warn(
    'LIVE_E2E_WARNING --setting-sources "" drops existing file-based security hooks; hook merging with other hook sources is unverified.',
  );

try {
  const firstRun = await runClaude(collectorPath, [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--settings",
    settingsPath,
    "--setting-sources",
    "",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "",
    "--no-session-persistence",
  ], prompts.map((prompt) => JSON.stringify({ type: "user", message: { role: "user", content: prompt } })).join("\n") + "\n", {
    cwd: root,
  });
  await appendDiagnostics(diagnosticsPath, "initial", firstRun);

  if (firstRun.error !== undefined || firstRun.code !== 0) {
    const diagnosis = classifyFailure(firstRun);
    console.log(
      `LIVE_E2E_BLOCKED step=claude-invocation cause=${diagnosis.cause} diagnostic_file=${diagnosticsPath} reason=${safeReason(firstRun.error ?? diagnostic(firstRun.stderr) ?? diagnostic(firstRun.stdout) ?? `exit-${firstRun.code ?? firstRun.signal}`)}`,
    );
    process.exitCode = 1;
    return;
  }

  const firstEvents = await readRecordedEvents(collectorPath);
  const firstResult = collectInteractions(firstEvents);
  const paired = firstResult.interactions
    .slice()
    .sort((left, right) => left.prompt_arrival_order - right.prompt_arrival_order);
  const promptExact = paired.length === prompts.length && paired.every((event, index) => event.prompt === prompts[index]);
  const finalExact = paired.length === expectedFinals.length && paired.every((event, index) => event.final_response === expectedFinals[index]);
  const promptIdsPresent = paired.every((event) => typeof event.prompt_id === "string");
  const promptIdsDistinct = new Set(paired.map((event) => event.prompt_id)).size === paired.length;
  const exactProof = promptExact && finalExact && promptIdsPresent && promptIdsDistinct;
  console.log(
    JSON.stringify({
      LIVE_E2E: exactProof ? "success" : "not_verified",
      paired: paired.length,
      prompt_exact: promptExact,
      final_exact: finalExact,
      prompt_ids_present: promptIdsPresent,
      prompt_ids_distinct: promptIdsDistinct,
      prompt_hashes: paired.map((event) => sha256(event.prompt)),
      final_hashes: paired.map((event) => sha256(event.final_response)),
      failures: firstResult.failures.length,
      diagnostic_file: diagnosticsPath,
      stop_finality: "unverified",
    }),
  );
  if (!exactProof) {
    process.exitCode = 1;
    return;
  }

  const interrupted = await runClaude(
    interruptedCollectorPath,
    [
      "--print",
      "--settings",
      settingsPath,
      "--setting-sources",
      "",
      "--permission-mode",
      "dontAsk",
      "--tools",
      "",
      "--no-session-persistence",
    ],
    "Write a very long fictional monologue of at least 10000 words, and do not stop early.",
    { interruptAfterMs: 500, cwd: root },
  );
  await appendDiagnostics(diagnosticsPath, "interruption", interrupted);
  const interruptedResult = collectInteractions(await readRecordedEvents(interruptedCollectorPath));
  const observedInterruption =
    interrupted.code !== 0 &&
    interruptedResult.interactions.length === 0 &&
    interruptedResult.failures.some((failure) => failure.reason === "missing-final");
  console.log(
    JSON.stringify({
      interruption_case: observedInterruption ? "verified" : "not_observed",
      process_signal: interrupted.signal,
      process_exit: interrupted.code,
      failures: interruptedResult.failures.map((failure) => failure.reason),
      diagnostic_file: diagnosticsPath,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
}

await main().catch((error) => {
  console.log(`LIVE_E2E_BLOCKED step=collector reason=${safeReason(error)}`);
  process.exitCode = 1;
});

async function runClaude(collector, args, input, options = {}) {
  const env = {
    ...process.env,
    CLAUDE_COLLECTOR_DIR: collector,
  };
  delete env.CLAUDECODE;
  return new Promise((resolve) => {
    const child = spawn(claudePath, args, {
      cwd: options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let interruptTimer;
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (interruptTimer !== undefined) {
        clearTimeout(interruptTimer);
      }
      resolve({ ...result, stderr, stdout });
    };
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    if (options.interruptAfterMs !== undefined) {
      interruptTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGINT");
        }
      }, options.interruptAfterMs);
    }
    child.on("error", (error) => finish({ error: error.message }));
    child.on("close", (code, signal) => {
      finish({ code, signal });
    });
    child.stdin.end(input);
  });
}

function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeReason(value) {
  return redactDiagnostic(value).replaceAll(/\s+/gu, "_").slice(0, 160);
}

async function appendDiagnostics(path, step, result) {
  await appendFile(
    path,
    `${JSON.stringify({
      step,
      code: result.code ?? null,
      signal: result.signal ?? null,
      ...(result.error === undefined ? {} : { error: redactDiagnostic(result.error) }),
      stdout: redactDiagnostic(result.stdout),
      stderr: redactDiagnostic(result.stderr),
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(path, 0o600);
}

function classifyFailure(result) {
  const text = [result.error, result.stderr, result.stdout]
    .filter((value) => typeof value === "string")
    .join("\n")
    .toLowerCase();
  if (/(?:setting[- ]sources?|settings?)[^\n]*(?:invalid|error|failed|not found)|(?:invalid|failed|error)[^\n]*(?:settings?|hook)/u.test(text)) {
    return { cause: "settings-source" };
  }
  if (/(?:authentication|auth)[^\n]*(?:failed|error|invalid)|unauthori[sz]ed|invalid[^\n]*(?:api key|token|credential)|(?:api key|token|credential)[^\n]*(?:invalid|expired)|\b(?:401|403)\b/u.test(text)) {
    return { cause: "authentication_failed" };
  }
  if (/(?:not|never|no)\s+(?:logged|signed)\s+in|login\s+required|please\s+(?:run|use)\s+\/?login|authentication\s+required|credentials?[^\n]*(?:missing|not found|required)/u.test(text)) {
    return { cause: "missing-login" };
  }
  return { cause: "unknown" };
}

function redactDiagnostic(value) {
  if (value === undefined || value === null) {
    return "";
  }
  const text = value instanceof Error ? value.message : String(value);
  return text
    .replaceAll(/(authorization\s*[:=]\s*bearer\s+)[^\s,}"']+/giu, "$1[REDACTED]")
    .replaceAll(/((?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|password|secret)\s*[:=]\s*)["']?[^\s,}&"']+/giu, "$1[REDACTED]")
    .replaceAll(/([?&](?:api[_-]?key|access_token|refresh_token|auth_token|token)=)[^&\s]+/giu, "$1[REDACTED]")
    .replaceAll(/\b(?:sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/gu, "[REDACTED]");
}

function diagnostic(value) {
  let fallback;
  for (const part of String(value).split("\n")) {
    const line = part.trim();
    if (line.length === 0) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      if (record.is_error === true) {
        return record.error ?? record.subtype ?? "claude-error";
      }
      if (typeof record.error === "string") {
        return record.error;
      }
      if (typeof record.subtype === "string") {
        fallback = record.subtype;
      }
    } catch {
      return line;
    }
  }
  return fallback;
}
