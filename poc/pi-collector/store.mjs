import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  MAX_CANDIDATE_TEXT_BYTES,
  MAX_INTERACTION_ID_BYTES,
  MAX_PROMPT_BYTES,
  MAX_SESSION_ID_BYTES,
} from "./contract.mjs";

export const STORE_FILE_NAME = "interactions.json";
export const STORE_DIRECTORY_MODE = 0o700;
export const STORE_FILE_MODE = 0o600;
export const MAX_REASON_BYTES = 128;
export const MAX_PROVENANCE_BYTES = 128;

const TERMINAL_STATUSES = new Set(["completed", "failed"]);
const RECORD_FIELDS = new Set([
  "id",
  "sessionId",
  "prompt",
  "finalReport",
  "status",
  "reason",
  "provenance",
]);

/**
 * Create or validate the collector-owned directory without changing any
 * global Pi configuration. The caller must provide an absolute path.
 */
export async function ensureStoreDirectory(root) {
  validateRoot(root);
  await mkdir(root, { recursive: true, mode: STORE_DIRECTORY_MODE });
  const directory = await stat(root);
  if (!directory.isDirectory()) {
    throw new StoreError("store-root-not-directory", "store root is not a directory");
  }
  await chmod(root, STORE_DIRECTORY_MODE);
  return root;
}

/** Read the complete terminal interaction snapshot, or an empty snapshot. */
export async function readInteractions(root) {
  await ensureStoreDirectory(root);
  const file = storeFile(root);
  let contents;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw new StoreError("store-read-failed", "could not read interaction store", error);
  }

  await chmod(file, STORE_FILE_MODE);
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new StoreError("store-invalid-json", "interaction store is not valid JSON", error);
  }
  if (!Array.isArray(parsed)) {
    throw new StoreError("store-invalid-shape", "interaction store must be an array");
  }

  const records = [];
  const seen = new Map();
  for (const value of parsed) {
    const record = validateRecord(value);
    const key = recordKey(record);
    const prior = seen.get(key);
    if (prior !== undefined) {
      if (!sameRecord(prior, record)) {
        throw new StoreError("store-conflict", "interaction store contains conflicting records");
      }
      continue;
    }
    seen.set(key, record);
    records.push(record);
  }
  return records;
}

/**
 * Atomically insert one terminal interaction. Re-delivery of the same record
 * is idempotent; a different record with the same session/id fails closed.
 */
export async function writeInteraction(root, interaction, provenance = "pi-observer") {
  await ensureStoreDirectory(root);
  const record = validateRecord({ ...interaction, provenance });
  const records = await readInteractions(root);
  const key = recordKey(record);
  const existing = records.find((candidate) => recordKey(candidate) === key);
  if (existing !== undefined) {
    if (sameRecord(existing, record)) {
      return { status: "duplicate", record: { ...existing } };
    }
    throw new StoreError("store-conflict", "interaction id already has a different record");
  }

  const next = [...records, record];
  await atomicWrite(root, JSON.stringify(next, null, 2) + "\n");
  return { status: "inserted", record: { ...record } };
}

export class StoreError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "StoreError";
    this.code = code;
  }
}

function validateRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError("invalid-record", "interaction record must be an object");
  }
  for (const key of Object.keys(value)) {
    if (!RECORD_FIELDS.has(key)) {
      throw new StoreError("invalid-record", "interaction record contains an unsupported field");
    }
  }

  const id = validateIdentifier(value.id, "id", MAX_INTERACTION_ID_BYTES);
  const sessionId = validateIdentifier(value.sessionId, "sessionId", MAX_SESSION_ID_BYTES);
  const prompt = validateText(value.prompt, "prompt", MAX_PROMPT_BYTES);
  if (!TERMINAL_STATUSES.has(value.status)) {
    throw new StoreError("invalid-record", "only terminal interaction statuses may be stored");
  }

  const provenance = value.provenance === undefined
    ? "pi-observer"
    : validateText(value.provenance, "provenance", MAX_PROVENANCE_BYTES);
  if (value.status === "completed") {
    if (typeof value.finalReport !== "string" || value.finalReport.length === 0) {
      throw new StoreError("invalid-record", "completed interaction must have non-empty finalReport");
    }
    validateText(value.finalReport, "finalReport", MAX_CANDIDATE_TEXT_BYTES);
  } else if (value.finalReport !== null) {
    throw new StoreError("invalid-record", "failed interaction must have a null finalReport");
  }

  const reason = value.reason === undefined
    ? undefined
    : validateText(value.reason, "reason", MAX_REASON_BYTES);
  return {
    id,
    sessionId,
    prompt,
    finalReport: value.status === "completed" ? value.finalReport : null,
    status: value.status,
    ...(reason === undefined ? {} : { reason }),
    provenance,
  };
}

function validateRoot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) {
    throw new StoreError("invalid-store-root", "store root must be an absolute path");
  }
}

function validateIdentifier(value, name, maxBytes) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new StoreError("invalid-record", `${name} is invalid`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new StoreError("invalid-record", `${name} is invalid`);
  }
  return value;
}

function validateText(value, name, maxBytes) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new StoreError("invalid-record", `${name} is invalid or oversized`);
  }
  return value;
}

function recordKey(record) {
  return `${record.sessionId.length}:${record.sessionId}${record.id.length}:${record.id}`;
}

function sameRecord(left, right) {
  return left.id === right.id &&
    left.sessionId === right.sessionId &&
    left.prompt === right.prompt &&
    left.finalReport === right.finalReport &&
    left.status === right.status &&
    left.reason === right.reason &&
    left.provenance === right.provenance;
}

function storeFile(root) {
  return join(root, STORE_FILE_NAME);
}

async function atomicWrite(root, contents) {
  const target = storeFile(root);
  const temporary = join(root, `.${STORE_FILE_NAME}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", STORE_FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, STORE_FILE_MODE);
    await rename(temporary, target);
    await chmod(target, STORE_FILE_MODE);
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => {});
    }
    await rm(temporary, { force: true }).catch(() => {});
    throw new StoreError("store-write-failed", "could not atomically write interaction store", error);
  }
}
