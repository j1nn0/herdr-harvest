import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_PI_FINAL_REPORT_BYTES, MAX_PI_PROMPT_BYTES } from "../src/domain/pi-interaction.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { PiInteractionStore } from "../src/persistence/pi-interaction-store.ts";

const repositoryRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const ingestBinary = join(repositoryRoot, "src", "bin", "ingest-pi.ts");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ingest-pi entrypoint", () => {
  test("inserts exact terminal text and reports only non-content metadata", async () => {
    const stateDirectory = await temporaryDirectory();
    const input = {
      interactionId: "ingest-1",
      sessionId: "session-ingest",
      submittedPrompt: "  提出\nした prompt  ",
      effectivePrompt: "expanded prompt",
      finalReport: " report\n結果 🚀 ",
      status: "completed",
      reason: null,
      provenance: "pi-observer-test",
    };

    const result = await runIngest(stateDirectory, JSON.stringify(input));
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "inserted",
      interactionId: "ingest-1",
      sessionId: "session-ingest",
    });
    assert.equal(result.stdout.includes(input.submittedPrompt), false);
    assert.equal(result.stdout.includes(input.finalReport), false);

    const db = openDatabase(join(stateDirectory, "harvest.db"));
    try {
      const store = new PiInteractionStore(db);
      const stored = store.get("session-ingest", "ingest-1");
      assert.ok(stored);
      assert.equal(typeof stored.completedAtMs, "number");
      assert.deepEqual(stored, {
        ...input,
        completedAtMs: stored.completedAtMs,
        dedupKey: stored.dedupKey,
      });
    } finally {
      db.close();
    }
  });

  test("refuses ingestion when the production opt-in is disabled", async () => {
    const stateDirectory = await temporaryDirectory();
    const result = await runIngest(stateDirectory, JSON.stringify(terminalInput()), {
      HARVEST_PI_COLLECT: "0",
    });

    assert.equal(result.code, 2);
    assert.match(result.stderr, /Pi ingest disabled/);
    assert.equal(await exists(join(stateDirectory, "harvest.db")), false);
  });

  test("uses dedup read-back and rejects conflicting content without overwriting", async () => {
    const stateDirectory = await temporaryDirectory();
    const input = terminalInput();
    const first = await runIngest(stateDirectory, JSON.stringify(input));
    const duplicate = await runIngest(stateDirectory, JSON.stringify(input));
    const conflict = await runIngest(
      stateDirectory,
      JSON.stringify({ ...input, finalReport: "different" }),
    );

    assert.equal(first.code, 0);
    assert.equal(duplicate.code, 0);
    assert.equal(JSON.parse(duplicate.stdout).status, "duplicate");
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, /conflicting duplicate/);

    const db = openDatabase(join(stateDirectory, "harvest.db"));
    try {
      const store = new PiInteractionStore(db);
      assert.equal(store.list()[0]?.finalReport, input.finalReport);
      assert.equal(store.list().length, 1);
    } finally {
      db.close();
    }
  });

  test("rejects malformed, unsupported, pending, and oversized stdin before opening the database", async () => {
    const malformedDirectory = await temporaryDirectory();
    const malformed = await runIngest(malformedDirectory, "not-json");
    assert.equal(malformed.code, 2);
    assert.equal(await exists(join(malformedDirectory, "harvest.db")), false);

    const unsupportedDirectory = await temporaryDirectory();
    const unsupported = await runIngest(
      unsupportedDirectory,
      JSON.stringify({ ...terminalInput(), terminalOutput: "never stored" }),
    );
    assert.equal(unsupported.code, 2);
    assert.equal(await exists(join(unsupportedDirectory, "harvest.db")), false);

    const pendingDirectory = await temporaryDirectory();
    const pending = await runIngest(
      pendingDirectory,
      JSON.stringify({ ...terminalInput(), status: "pending", finalReport: null, reason: null }),
    );
    assert.equal(pending.code, 2);
    assert.equal(await exists(join(pendingDirectory, "harvest.db")), false);

    const oversizedPromptDirectory = await temporaryDirectory();
    const oversizedPrompt = await runIngest(
      oversizedPromptDirectory,
      JSON.stringify({ ...terminalInput(), submittedPrompt: "x".repeat(MAX_PI_PROMPT_BYTES + 1) }),
    );
    assert.equal(oversizedPrompt.code, 2);
    assert.equal(await exists(join(oversizedPromptDirectory, "harvest.db")), false);

    const oversizedReportDirectory = await temporaryDirectory();
    const oversizedReport = await runIngest(
      oversizedReportDirectory,
      JSON.stringify({
        ...terminalInput(),
        finalReport: "x".repeat(MAX_PI_FINAL_REPORT_BYTES + 1),
      }),
    );
    assert.equal(oversizedReport.code, 2);
    assert.equal(await exists(join(oversizedReportDirectory, "harvest.db")), false);
  });

  test("does not echo prompt or report bodies on input or store failure", async () => {
    const privatePrompt = "private prompt body that must not be echoed";
    const privateReport = "private report body that must not be echoed";
    const rejectedDirectory = await temporaryDirectory();
    const rejected = await runIngest(
      rejectedDirectory,
      JSON.stringify({
        ...terminalInput(),
        submittedPrompt: privatePrompt,
        finalReport: privateReport,
        status: "pending",
      }),
    );

    assert.equal(rejected.code, 2);
    assert.equal(rejected.stdout.includes(privatePrompt), false);
    assert.equal(rejected.stdout.includes(privateReport), false);
    assert.equal(rejected.stderr.includes(privatePrompt), false);
    assert.equal(rejected.stderr.includes(privateReport), false);

    const stateDirectory = await temporaryDirectory();
    const stateFile = join(stateDirectory, "state-file");
    await writeFile(stateFile, "not a directory", "utf8");
    const failedStore = await runIngest(
      stateFile,
      JSON.stringify({
        ...terminalInput(),
        submittedPrompt: privatePrompt,
        finalReport: privateReport,
      }),
    );

    assert.equal(failedStore.code, 1);
    assert.equal(failedStore.stdout.includes(privatePrompt), false);
    assert.equal(failedStore.stdout.includes(privateReport), false);
    assert.equal(failedStore.stderr.includes(privatePrompt), false);
    assert.equal(failedStore.stderr.includes(privateReport), false);
  });
});

function terminalInput() {
  return {
    interactionId: "ingest-duplicate",
    sessionId: "session-ingest",
    submittedPrompt: "prompt",
    effectivePrompt: "effective",
    finalReport: "report",
    status: "completed",
    reason: null,
    provenance: "pi-observer-test",
  };
}

async function runIngest(
  stateDirectory: string,
  input: string,
  overrides: Record<string, string> = {},
) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [ingestBinary], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HARVEST_STATE_DIR: stateDirectory,
        HARVEST_PI_COLLECT: "1",
        ...overrides,
      },
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
    child.stdin.end(input);
  });
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "herdr-harvest-pi-ingest-"));
  directories.push(directory);
  return directory;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
