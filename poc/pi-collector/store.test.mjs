import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  MAX_CANDIDATE_TEXT_BYTES,
  MAX_PROMPT_BYTES,
} from "./contract.mjs";
import {
  STORE_FILE_MODE,
  STORE_FILE_NAME,
  STORE_DIRECTORY_MODE,
  StoreError,
  readInteractions,
  writeInteraction,
} from "./store.mjs";

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("store writes terminal records atomically with exact text and private modes", async () => {
  const root = await temporaryRoot();
  const interaction = {
    id: "interaction-1",
    sessionId: "session-1",
    prompt: "  日本語 prompt\nwith whitespace  ",
    finalReport: " report\n二行目 ",
    status: "completed",
  };

  const result = await writeInteraction(root, interaction, "pi-observer");
  assert.equal(result.status, "inserted");
  assert.deepEqual(await readInteractions(root), [{ ...interaction, provenance: "pi-observer" }]);

  const directoryMode = (await stat(root)).mode & 0o777;
  const filePath = join(root, STORE_FILE_NAME);
  const fileMode = (await stat(filePath)).mode & 0o777;
  assert.equal(directoryMode, STORE_DIRECTORY_MODE);
  assert.equal(fileMode, STORE_FILE_MODE);
  assert.deepEqual(await readdir(root), [STORE_FILE_NAME]);
});

test("duplicate delivery is idempotent and conflicting content fails closed", async () => {
  const root = await temporaryRoot();
  const interaction = {
    id: "same-id",
    sessionId: "same-session",
    prompt: "prompt",
    finalReport: "report",
    status: "completed",
  };

  assert.equal((await writeInteraction(root, interaction)).status, "inserted");
  assert.equal((await writeInteraction(root, interaction)).status, "duplicate");
  await assert.rejects(
    writeInteraction(root, { ...interaction, finalReport: "different" }),
    (error) => error instanceof StoreError && error.code === "store-conflict",
  );
  assert.equal((await readInteractions(root)).length, 1);
});

test("failed records retain the prompt and reason but never a final report", async () => {
  const root = await temporaryRoot();
  await writeInteraction(root, {
    id: "failed-id",
    sessionId: "failed-session",
    prompt: "prompt",
    finalReport: null,
    status: "failed",
    reason: "interrupted",
  });

  assert.deepEqual(await readInteractions(root), [{
    id: "failed-id",
    sessionId: "failed-session",
    prompt: "prompt",
    finalReport: null,
    status: "failed",
    reason: "interrupted",
    provenance: "pi-observer",
  }]);
});

test("pending, oversized, and extra product fields are rejected before any write", async () => {
  const root = await temporaryRoot();
  const base = {
    id: "rejected-id",
    sessionId: "rejected-session",
    prompt: "prompt",
    finalReport: "report",
    status: "completed",
  };

  await assert.rejects(
    writeInteraction(root, { ...base, status: "pending", finalReport: null }),
    (error) => error instanceof StoreError && error.code === "invalid-record",
  );
  await assert.rejects(
    writeInteraction(root, { ...base, prompt: "x".repeat(MAX_PROMPT_BYTES + 1) }),
    (error) => error instanceof StoreError && error.code === "invalid-record",
  );
  await assert.rejects(
    writeInteraction(root, { ...base, finalReport: "x".repeat(MAX_CANDIDATE_TEXT_BYTES + 1) }),
    (error) => error instanceof StoreError && error.code === "invalid-record",
  );
  await assert.rejects(
    writeInteraction(root, { ...base, terminalOutput: "must never be stored" }),
    (error) => error instanceof StoreError && error.code === "invalid-record",
  );
  assert.deepEqual(await readInteractions(root), []);
});

test("a relative store root is rejected", async () => {
  await assert.rejects(
    readInteractions("relative-store"),
    (error) => error instanceof StoreError && error.code === "invalid-store-root",
  );
});

async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-collector-store-test-"));
  roots.push(root);
  return root;
}
