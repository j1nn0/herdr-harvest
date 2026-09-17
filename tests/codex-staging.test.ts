import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type {
  CodexPromptObservedEvent,
  CodexReportObservedEvent,
  CodexTurnCommittedEvent,
} from "../src/codex/collector-contract.ts";
import {
  CODEX_NATIVE_HOOKS_PROVENANCE,
  codexInteractionId,
} from "../src/codex/collector-contract.ts";
import { commitCodexTurn, stageCodexPrompt, stageCodexReport } from "../src/codex/staging.ts";
import { isCodexCollectionEnabled, loadConfig } from "../src/config/config.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { PiInteractionStore } from "../src/persistence/pi-interaction-store.ts";

const repositoryRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const submitHook = join(repositoryRoot, "src", "codex", "submit-hook.ts");
const stopHook = join(repositoryRoot, "src", "codex", "stop-hook.ts");
const notifyCommit = join(repositoryRoot, "src", "codex", "notify-commit.ts");
const ingestCodex = join(repositoryRoot, "src", "bin", "ingest-codex.ts");

describe("Codex SQLite staging", () => {
  test("writes a prompt pending row and keeps the last provisional report", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      const promptEvent = prompt("session-stage", "turn-stage", "  prompt\n日本語 🚀");
      assert.equal(stageCodexPrompt(db, promptEvent).status, "accepted");
      assert.equal(
        stageCodexReport(db, report("session-stage", "turn-stage", "A1")).status,
        "accepted",
      );
      const last = stageCodexReport(db, report("session-stage", "turn-stage", "A2"));
      assert.deepEqual(last, {
        status: "accepted",
        action: "updated",
        sessionId: "session-stage",
        turnId: "turn-stage",
      });
      assert.deepEqual(
        Object.fromEntries(
          Object.entries(
            db
              .prepare(
                "SELECT submitted_prompt, effective_prompt, final_report, status, provenance FROM pi_interactions",
              )
              .get() as Record<string, unknown>,
          ),
        ),
        {
          submitted_prompt: "  prompt\n日本語 🚀",
          effective_prompt: "A2",
          final_report: null,
          status: "pending",
          provenance: CODEX_NATIVE_HOOKS_PROVENANCE,
        },
      );
      assert.equal(store.list().length, 1);
    } finally {
      db.close();
    }
  });

  test("commits through PiInteractionStore and reads back exact completed text", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      const sessionId = "session-commit";
      const turnId = "turn-commit";
      stageCodexPrompt(db, prompt(sessionId, turnId, "prompt\n日本語"));
      stageCodexReport(db, report(sessionId, turnId, "report\n世界 🌊"));
      const outcome = commitCodexTurn(db, store, commit(sessionId, turnId, "report\n世界 🌊"));

      assert.equal(outcome.status, "inserted");
      if (outcome.status !== "inserted") {
        throw new Error("Expected a completed Codex interaction.");
      }
      assert.deepEqual(
        store.get(sessionId, codexInteractionId(sessionId, turnId)),
        outcome.interaction,
      );
      assert.equal(outcome.interaction.submittedPrompt, "prompt\n日本語");
      assert.equal(outcome.interaction.finalReport, "report\n世界 🌊");
      assert.equal(outcome.interaction.provenance, CODEX_NATIVE_HOOKS_PROVENANCE);
      assert.equal(
        (
          db
            .prepare("SELECT COUNT(*) AS count FROM pi_interactions WHERE status = 'pending'")
            .get() as { count: number }
        ).count,
        0,
      );
    } finally {
      db.close();
    }
  });

  test("uses A2 after continuation, deduplicates notify, and exposes conflicts", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      const sessionId = "session-continuation";
      const turnId = "turn-continuation";
      stageCodexPrompt(db, prompt(sessionId, turnId, "prompt"));
      stageCodexReport(db, report(sessionId, turnId, "A1"));
      stageCodexReport(db, report(sessionId, turnId, "A2"));

      const first = commitCodexTurn(db, store, commit(sessionId, turnId, "A2"));
      assert.equal(first.status, "inserted");
      const duplicate = commitCodexTurn(db, store, commit(sessionId, turnId, "A2"));
      assert.equal(duplicate.status, "duplicate");
      const conflict = commitCodexTurn(db, store, commit(sessionId, turnId, "different"));
      assert.equal(conflict.status, "rejected");
      if (conflict.status === "rejected") {
        assert.equal(conflict.failure.reason, "conflicting-commit");
      }
      assert.equal(store.get(sessionId, codexInteractionId(sessionId, turnId))?.finalReport, "A2");
    } finally {
      db.close();
    }
  });

  test("handles stop-before-submit, veto/no-notify, orphan notify, and mismatch fail-closed", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      stageCodexReport(db, report("session-order", "turn-order", "report"));
      stageCodexPrompt(db, prompt("session-order", "turn-order", "prompt"));
      const ordered = commitCodexTurn(db, store, commit("session-order", "turn-order", "report"));
      assert.equal(ordered.status, "inserted");

      stageCodexPrompt(db, prompt("session-veto", "turn-veto", "prompt"));
      stageCodexReport(db, report("session-veto", "turn-veto", "provisional"));
      assert.equal(store.list().filter((item) => item.status === "completed").length, 1);

      const orphan = commitCodexTurn(db, store, commit("session-orphan", "turn-orphan", "report"));
      assert.equal(orphan.status, "rejected");
      if (orphan.status === "rejected") {
        assert.equal(orphan.failure.reason, "orphan-notify");
      }

      stageCodexPrompt(db, prompt("session-mismatch", "turn-mismatch", "prompt"));
      stageCodexReport(db, report("session-mismatch", "turn-mismatch", "provisional"));
      const mismatch = commitCodexTurn(
        db,
        store,
        commit("session-mismatch", "turn-mismatch", "notify report"),
      );
      assert.equal(mismatch.status, "rejected");
      if (mismatch.status === "rejected") {
        assert.equal(mismatch.failure.reason, "report-mismatch");
      }
      assert.equal(
        store.get("session-mismatch", codexInteractionId("session-mismatch", "turn-mismatch"))
          ?.status,
        "pending",
      );
    } finally {
      db.close();
    }
  });

  test("rejects conflicting prompt without overwriting and survives collector restart", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      stageCodexPrompt(db, prompt("session-prompt-conflict", "turn-prompt-conflict", "first"));
      const conflict = stageCodexPrompt(
        db,
        prompt("session-prompt-conflict", "turn-prompt-conflict", "second"),
      );
      assert.equal(conflict.status, "rejected");
      if (conflict.status === "rejected") {
        assert.equal(conflict.failure.reason, "conflicting-prompt");
      }
      assert.equal(
        (
          db
            .prepare("SELECT submitted_prompt FROM pi_interactions WHERE status = 'pending'")
            .get() as { submitted_prompt: string }
        ).submitted_prompt,
        "first",
      );

      stageCodexReport(db, report("session-restart", "turn-restart", "report"));
      const laterPrompt = stageCodexPrompt(db, prompt("session-restart", "turn-restart", "prompt"));
      assert.equal(laterPrompt.status, "accepted");
      const later = commitCodexTurn(db, store, commit("session-restart", "turn-restart", "report"));
      assert.equal(later.status, "inserted");
    } finally {
      db.close();
    }
  });
});

describe("Codex process adapters", () => {
  test("adds an opt-in flag without changing legacy enumerable config fields", () => {
    const disabled = loadConfig({ HARVEST_STATE_DIR: "/tmp/codex", HARVEST_CODEX_COLLECT: "0" });
    const enabled = loadConfig({ HARVEST_STATE_DIR: "/tmp/codex", HARVEST_CODEX_COLLECT: "1" });
    assert.equal(disabled.config.codexCollectionEnabled, false);
    assert.equal(enabled.config.codexCollectionEnabled, true);
    assert.equal(isCodexCollectionEnabled({ HARVEST_CODEX_COLLECT: "1" }), true);
    assert.equal(isCodexCollectionEnabled({ HARVEST_CODEX_COLLECT: "yes" }), false);
    assert.equal(Object.keys(disabled.config).includes("codexCollectionEnabled"), false);
  });

  test("hooks are silent on malformed input and stage through stdin without printing bodies", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codex-hook-test-"));
    try {
      const env = collectionEnv(stateDirectory);
      const malformed = await runNode(submitHook, [], "not-json", env);
      assert.deepEqual(malformed, { code: 0, stdout: "", stderr: "" });

      const promptResult = await runNode(
        submitHook,
        [],
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "session-hook",
          turn_id: "turn-hook",
          prompt: "  exact prompt\n日本語 🚀",
        }),
        env,
      );
      assert.deepEqual(promptResult, { code: 0, stdout: "", stderr: "" });

      const stopResult = await runNode(
        stopHook,
        [],
        JSON.stringify({
          hook_event_name: "Stop",
          session_id: "session-hook",
          turn_id: "turn-hook",
          last_assistant_message: "final report\n世界 🌊",
        }),
        env,
      );
      assert.deepEqual(stopResult, { code: 0, stdout: "", stderr: "" });

      const notifyResult = await runNode(
        notifyCommit,
        [
          JSON.stringify({
            type: "agent-turn-complete",
            "thread-id": "session-hook",
            "turn-id": "turn-hook",
            "last-assistant-message": "final report\n世界 🌊",
          }),
        ],
        "",
        env,
      );
      assert.deepEqual(notifyResult, { code: 0, stdout: "", stderr: "" });

      const db = openDatabase(join(stateDirectory, "harvest.db"));
      try {
        const store = new PiInteractionStore(db);
        const interaction = store.get(
          "session-hook",
          codexInteractionId("session-hook", "turn-hook"),
        );
        assert.equal(interaction?.submittedPrompt, "  exact prompt\n日本語 🚀");
        assert.equal(interaction?.finalReport, "final report\n世界 🌊");
        assert.equal(interaction?.status, "completed");
      } finally {
        db.close();
      }
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("rejects subagent input, oversized input, and storage setup failure with safe codes", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codex-rejection-test-"));
    try {
      const env = collectionEnv(stateDirectory);
      const subagent = await runNode(
        submitHook,
        [],
        JSON.stringify({
          hook_event_name: "SubagentStop",
          session_id: "session-subagent",
          turn_id: "turn-subagent",
          prompt: "not a root prompt",
        }),
        env,
      );
      assert.deepEqual(subagent, { code: 0, stdout: "", stderr: "" });

      const oversized = await runNode(
        ingestCodex,
        [],
        JSON.stringify({
          kind: "promptObserved",
          sessionId: "session-large",
          turnId: "turn-large",
          submittedPrompt: "x".repeat(64 * 1024 + 1),
        }),
        env,
      );
      assert.equal(oversized.code, 2);
      assert.match(oversized.stderr, /oversized-prompt/);
      assert.equal(oversized.stdout, "");
      assert.equal(oversized.stderr.includes("x".repeat(32)), false);

      const noState = { ...env };
      delete noState.HARVEST_STATE_DIR;
      const failed = await runNode(
        submitHook,
        [],
        JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "session-failure",
          turn_id: "turn-failure",
          prompt: "prompt",
        }),
        noState,
      );
      assert.equal(failed.code, 1);
      assert.equal(failed.stdout, "");
      assert.match(failed.stderr, /^codex-collector:[^\n]+\n$/);
      assert.equal(failed.stderr.includes("prompt"), false);
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  test("two separate processes contend on one DB and a later notify completes the staged turn", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "codex-process-test-"));
    try {
      const env = collectionEnv(stateDirectory);
      const events = [
        prompt("session-race-a", "turn-race-a", "prompt-a"),
        prompt("session-race-b", "turn-race-b", "prompt-b"),
      ];
      const results = await Promise.all(
        events.map((event) => runNode(ingestCodex, [], JSON.stringify(event), env)),
      );
      assert.deepEqual(results.map((result) => result.code).sort(), [0, 0]);
      assert.equal(
        results.every((result) => result.stderr === ""),
        true,
      );

      const reportResult = await runNode(
        ingestCodex,
        [],
        JSON.stringify(report("session-race-a", "turn-race-a", "report-a")),
        env,
      );
      assert.equal(reportResult.code, 0);
      const notifyResult = await runNode(
        notifyCommit,
        [
          JSON.stringify({
            type: "agent-turn-complete",
            "thread-id": "session-race-a",
            "turn-id": "turn-race-a",
            "last-assistant-message": "report-a",
          }),
        ],
        "",
        env,
      );
      assert.deepEqual(notifyResult, { code: 0, stdout: "", stderr: "" });

      const db = openDatabase(join(stateDirectory, "harvest.db"));
      try {
        const store = new PiInteractionStore(db);
        assert.equal(
          store.get("session-race-a", codexInteractionId("session-race-a", "turn-race-a"))?.status,
          "completed",
        );
        assert.equal(
          store.get("session-race-b", codexInteractionId("session-race-b", "turn-race-b"))?.status,
          "pending",
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});

function prompt(
  sessionId: string,
  turnId: string,
  submittedPrompt: string,
): CodexPromptObservedEvent {
  return { kind: "promptObserved", sessionId, turnId, submittedPrompt };
}

function report(
  sessionId: string,
  turnId: string,
  provisionalReport: string,
): CodexReportObservedEvent {
  return { kind: "reportObserved", sessionId, turnId, provisionalReport };
}

function commit(sessionId: string, turnId: string, finalReport: string): CodexTurnCommittedEvent {
  return { kind: "turnCommitted", sessionId, turnId, finalReport };
}

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
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", script, ...args], {
      cwd: repositoryRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(stdin);
  });
}
