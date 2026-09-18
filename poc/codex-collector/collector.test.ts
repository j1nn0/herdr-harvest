import { Buffer } from "node:buffer";
import { after, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { interactionId, normalizeHookPayload } from "./contract.ts";
import type { HookEventName, Interaction } from "./contract.ts";
import { ingestHookEvent, readInteractions, readStoredHookEvents } from "./store.ts";

const testRoots: string[] = [];
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

after(async () => {
  await Promise.all(testRoots.map((root) => rm(root, { recursive: true, force: true })));
});

test("success accepts exactly one root prompt and one Stop report", async () => {
  const root = await temporaryRoot();
  const prompt = "Synthetic success prompt";
  const report = "Synthetic success report";

  assert.equal((await addPayload(root, "UserPromptSubmit", promptPayload("session-1", "turn-1", prompt))).outcome, "pending");
  const result = await addPayload(root, "Stop", stopPayload("session-1", "turn-1", report));

  assert.equal(result.outcome, "completed");
  assert.deepEqual(await readInteractions(root), [expectedInteraction("session-1", "turn-1", prompt, report)]);
});

test("consecutive turns are correlated by turn_id, not session_id alone", async () => {
  const root = await temporaryRoot();
  await addPair(root, "session-1", "turn-1", "Synthetic first prompt", "Synthetic first report");
  await addPair(root, "session-1", "turn-2", "Synthetic second prompt", "Synthetic second report");

  const records = await readInteractions(root);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.turnId), ["turn-1", "turn-2"]);
});

test("concurrent sessions do not cross-join", async () => {
  const root = await temporaryRoot();
  await Promise.all([
    addPair(root, "session-a", "turn-a", "Synthetic A prompt", "Synthetic A report"),
    addPair(root, "session-b", "turn-b", "Synthetic B prompt", "Synthetic B report"),
  ]);

  const records = await readInteractions(root);
  assert.equal(records.length, 2);
  assert.deepEqual(
    records.map((record) => [record.sessionId, record.turnId]).sort(),
    [
      ["session-a", "turn-a"],
      ["session-b", "turn-b"],
    ].sort(),
  );
});

test("history-like text is treated as opaque prompt text", async () => {
  const root = await temporaryRoot();
  const prompt = "<history>synthetic prior turn</history>\n\nSynthetic current request";
  await addPair(root, "session-history", "turn-history", prompt, "Synthetic report");

  const [record] = await readInteractions(root);
  assert.equal(record?.submittedPrompt, prompt);
});

test("identical duplicate hook deliveries are idempotent", async () => {
  const root = await temporaryRoot();
  const prompt = promptPayload("session-duplicate", "turn-duplicate", "Synthetic duplicate prompt");
  const stop = stopPayload("session-duplicate", "turn-duplicate", "Synthetic duplicate report");
  await addPayload(root, "UserPromptSubmit", prompt);
  await addPayload(root, "UserPromptSubmit", prompt);
  await addPayload(root, "Stop", stop);
  const duplicate = await addPayload(root, "Stop", stop);

  assert.equal(duplicate.outcome, "completed");
  assert.equal((await readInteractions(root)).length, 1);
  assert.equal((await readStoredHookEvents(root)).length, 2);
});

test("queued same-turn prompt candidates are rejected instead of merged", async () => {
  const root = await temporaryRoot();
  await addPayload(root, "UserPromptSubmit", promptPayload("session-conflict", "turn-conflict", "Synthetic prompt one"));
  await addPayload(root, "UserPromptSubmit", promptPayload("session-conflict", "turn-conflict", "Synthetic prompt two"));
  const result = await addPayload(root, "Stop", stopPayload("session-conflict", "turn-conflict", "Synthetic report"));

  assert.equal(result.outcome, "rejected");
  assert.equal((await readInteractions(root)).length, 0);
});

test("conflicting same-turn reports are rejected", async () => {
  const root = await temporaryRoot();
  await addPayload(root, "Stop", stopPayload("session-report-conflict", "turn-report-conflict", "Synthetic report one"));
  await addPayload(root, "Stop", stopPayload("session-report-conflict", "turn-report-conflict", "Synthetic report two"));
  const result = await addPayload(root, "UserPromptSubmit", promptPayload("session-report-conflict", "turn-report-conflict", "Synthetic prompt"));
  await addPayload(root, "UserPromptSubmit", promptPayload("session-report-conflict", "turn-report-conflict", "Synthetic prompt"));

  assert.equal(result.outcome, "rejected");
  assert.equal((await readInteractions(root)).length, 0);
});

test("out-of-order Stop then submit still correlates", async () => {
  const root = await temporaryRoot();
  await addPayload(root, "Stop", stopPayload("session-order", "turn-order", "Synthetic out-of-order report"));
  const result = await addPayload(root, "UserPromptSubmit", promptPayload("session-order", "turn-order", "Synthetic out-of-order prompt"));

  assert.equal(result.outcome, "completed");
  assert.equal((await readInteractions(root)).length, 1);
});

test("missing prompt is discarded fail-closed", async () => {
  const root = await temporaryRoot();
  const missing = normalizeHookPayload(
    { ...basePayload("session-missing-prompt", "turn-missing-prompt", "UserPromptSubmit"), prompt: "" },
    "UserPromptSubmit",
  );
  assert.equal(missing.event, null);
  await addPayload(root, "Stop", stopPayload("session-missing-prompt", "turn-missing-prompt", "Synthetic report"));

  assert.equal((await readInteractions(root)).length, 0);
});

test("missing final report is discarded fail-closed", async () => {
  const root = await temporaryRoot();
  await addPayload(root, "UserPromptSubmit", promptPayload("session-missing-report", "turn-missing-report", "Synthetic prompt"));
  const missing = normalizeHookPayload(
    { ...basePayload("session-missing-report", "turn-missing-report", "Stop"), last_assistant_message: null },
    "Stop",
  );
  assert.equal(missing.event, null);

  assert.equal((await readInteractions(root)).length, 0);
});

test("failed or interrupted turns never produce partial interactions", async () => {
  const root = await temporaryRoot();
  await addPayload(root, "UserPromptSubmit", promptPayload("session-failed", "turn-failed", "Synthetic failed prompt"));
  const interrupted = normalizeHookPayload(
    { ...basePayload("session-failed", "turn-failed", "Interrupt") },
    "Stop",
  );
  assert.equal(interrupted.event, null);
  const missingReport = normalizeHookPayload(
    stopPayload("session-failed", "turn-failed", null),
    "Stop",
  );
  assert.equal(missingReport.event, null);
  const interruptedWithPartialText = normalizeHookPayload(
    { ...stopPayload("session-failed", "turn-failed", "Synthetic partial report"), interrupted: true },
    "Stop",
  );
  assert.equal(interruptedWithPartialText.event, null);

  assert.equal((await readInteractions(root)).length, 0);
});

test("memory-consolidation or title-generation sources are rejected", async () => {
  const root = await temporaryRoot();
  await addPayload(root, "UserPromptSubmit", promptPayload("session-internal", "turn-internal", "Synthetic visible prompt"));
  const internal = normalizeHookPayload(
    {
      ...stopPayload("session-internal", "turn-internal", "Synthetic internal report"),
      source: "MemoryConsolidation",
    },
    "Stop",
  );
  assert.equal(internal.event, null);
  const titleGeneration = normalizeHookPayload(
    {
      ...stopPayload("session-internal-2", "turn-internal-2", "Synthetic title report"),
      source: "TitleGeneration",
    },
    "Stop",
  );
  assert.equal(titleGeneration.event, null);

  assert.equal((await readInteractions(root)).length, 0);
});

test("SubagentStop and agent-bearing prompts are not root turns", async () => {
  const root = await temporaryRoot();
  const subagentPrompt = normalizeHookPayload(
    { ...promptPayload("session-subagent", "turn-subagent", "Synthetic subagent prompt"), agent_id: "agent-1", agent_type: "worker" },
    "UserPromptSubmit",
  );
  const subagentStop = normalizeHookPayload(
    { ...stopPayload("session-subagent", "turn-subagent", "Synthetic subagent report"), hook_event_name: "SubagentStop" },
    "Stop",
  );
  assert.equal(subagentPrompt.event, null);
  assert.equal(subagentStop.event, null);

  assert.equal((await readInteractions(root)).length, 0);
});

test("resume creates a new turn and suppresses a replay of the old turn", async () => {
  const root = await temporaryRoot();
  await addPair(root, "session-resume", "turn-before-resume", "Synthetic before resume", "Synthetic first report");
  await addPair(root, "session-resume", "turn-after-resume", "Synthetic after resume", "Synthetic resumed report");
  await addPair(root, "session-resume", "turn-before-resume", "Synthetic before resume", "Synthetic first report");

  const records = await readInteractions(root);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.turnId), ["turn-before-resume", "turn-after-resume"]);
});

test("multiline and Unicode text is byte-exact", async () => {
  const root = await temporaryRoot();
  const prompt = "  Synthetic 日本語\n\t絵文字 👩🏽‍💻\n終端  ";
  const report = "\nSynthetic report\n全角空白　and emoji 🧪  ";
  await addPair(root, "session-exact", "turn-exact", prompt, report);

  const [record] = await readInteractions(root);
  assert.ok(record);
  assert.equal(Buffer.from(record.submittedPrompt).equals(Buffer.from(prompt)), true);
  assert.equal(Buffer.from(record.finalReport).equals(Buffer.from(report)), true);
});

test("large payloads remain exact and are not truncated", async () => {
  const root = await temporaryRoot();
  const prompt = `${"Synthetic prompt ".repeat(65_000)}終端`;
  const report = `${"Synthetic report ".repeat(65_000)}完了`;
  await addPair(root, "session-large", "turn-large", prompt, report);

  const [record] = await readInteractions(root);
  assert.ok(record);
  assert.equal(Buffer.byteLength(record.submittedPrompt), Buffer.byteLength(prompt));
  assert.equal(Buffer.byteLength(record.finalReport), Buffer.byteLength(report));
  assert.equal(record.submittedPrompt.endsWith("終端"), true);
  assert.equal(record.finalReport.endsWith("完了"), true);
});

test("collector process failure returns non-zero without logging bodies", async () => {
  const parent = await temporaryRoot();
  const invalidRoot = join(parent, "not-a-directory");
  await writeFile(invalidRoot, "synthetic marker", "utf8");
  const prompt = "Synthetic process failure prompt";
  const result = await runHookProcess("prompt-hook.ts", JSON.stringify(promptPayload("session-process", "turn-process", prompt)), {
    ...process.env,
    CODEX_COLLECTOR_DIR: invalidRoot,
  });

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(prompt), false);
  assert.match(result.stderr, /code=store-root-not-directory/);
});

test("hook entrypoints persist a structured pair without printing bodies", async () => {
  const root = await temporaryRoot();
  const prompt = "  Synthetic entrypoint prompt\n日本語  ";
  const report = "Synthetic entrypoint report\n絵文字 🧪";
  const env = { ...process.env, CODEX_COLLECTOR_DIR: root };
  const promptResult = await runHookProcess(
    "prompt-hook.ts",
    JSON.stringify(promptPayload("session-entrypoint", "turn-entrypoint", prompt)),
    env,
  );
  const stopResult = await runHookProcess(
    "stop-hook.ts",
    JSON.stringify(stopPayload("session-entrypoint", "turn-entrypoint", report)),
    env,
  );

  assert.equal(promptResult.code, 0);
  assert.equal(stopResult.code, 0);
  assert.equal(promptResult.stdout, "");
  assert.equal(stopResult.stdout, "");
  assert.equal(promptResult.stderr.includes(prompt), false);
  assert.equal(stopResult.stderr.includes(report), false);
  const [record] = await readInteractions(root);
  assert.ok(record);
  assert.equal(Buffer.from(record.submittedPrompt).equals(Buffer.from(prompt)), true);
  assert.equal(Buffer.from(record.finalReport).equals(Buffer.from(report)), true);
});

async function addPair(
  root: string,
  sessionId: string,
  turnId: string,
  prompt: string,
  report: string,
): Promise<void> {
  await addPayload(root, "UserPromptSubmit", promptPayload(sessionId, turnId, prompt));
  await addPayload(root, "Stop", stopPayload(sessionId, turnId, report));
}

async function addPayload(
  root: string,
  eventName: HookEventName,
  payload: Record<string, unknown>,
) {
  const normalized = normalizeHookPayload(payload, eventName);
  if (normalized.event === null) {
    throw new Error(`synthetic fixture rejected: ${normalized.reason ?? "unknown"}`);
  }
  return ingestHookEvent(root, normalized.event);
}

function promptPayload(sessionId: string, turnId: string, prompt: string): Record<string, unknown> {
  return { ...basePayload(sessionId, turnId, "UserPromptSubmit"), prompt };
}

function stopPayload(
  sessionId: string,
  turnId: string,
  report: string | null,
): Record<string, unknown> {
  return { ...basePayload(sessionId, turnId, "Stop"), last_assistant_message: report };
}

function basePayload(sessionId: string, turnId: string, hookEventName: string): Record<string, unknown> {
  return {
    session_id: sessionId,
    turn_id: turnId,
    transcript_path: null,
    cwd: "/tmp/synthetic-codex-project",
    hook_event_name: hookEventName,
    model: "synthetic-model",
    permission_mode: "read-only",
  };
}

function expectedInteraction(
  sessionId: string,
  turnId: string,
  submittedPrompt: string,
  finalReport: string,
): Interaction {
  const normalizedPrompt = normalizeHookPayload(
    promptPayload(sessionId, turnId, submittedPrompt),
    "UserPromptSubmit",
  );
  const normalizedStop = normalizeHookPayload(
    stopPayload(sessionId, turnId, finalReport),
    "Stop",
  );
  assert.ok(normalizedPrompt.event);
  assert.ok(normalizedStop.event);
  return {
    id: interactionId(sessionId, turnId),
    sessionId,
    turnId,
    submittedPrompt,
    finalReport,
    status: "completed",
    provenance: "codex-native-hooks",
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-collector-test-"));
  testRoots.push(root);
  return root;
}

async function runHookProcess(
  scriptName: string,
  input: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const scriptPath = join(moduleDirectory, scriptName);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
    child.stdin.end(input);
  });
}
