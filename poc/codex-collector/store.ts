import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import {
  correlateEvents,
  sameInteraction,
  turnKey,
} from "./contract.ts";
import type { HookEvent, Interaction } from "./contract.ts";

export const EVENTS_FILE_NAME = "hook-events.ndjson";
export const INTERACTIONS_FILE_NAME = "interactions.json";
export const STORE_DIRECTORY_MODE = 0o700;
export const STORE_FILE_MODE = 0o600;

const LOCK_FILE_NAME = ".write.lock";
const MAX_ROOT_BYTES = 4_096;

export type IngestOutcome = "completed" | "pending" | "rejected";

export interface IngestResult {
  eventStatus: "inserted" | "duplicate";
  outcome: IngestOutcome;
  interaction?: Interaction;
  reason?: string;
}

export class StoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}

export async function ensureStoreDirectory(root: string): Promise<void> {
  if (!isAbsolute(root) || Buffer.byteLength(root, "utf8") > MAX_ROOT_BYTES) {
    throw new StoreError("invalid-store-root", "store root must be an absolute path");
  }

  try {
    const current = await stat(root);
    if (!current.isDirectory()) {
      throw new StoreError("store-root-not-directory", "store root is not a directory");
    }
  } catch (error) {
    if (error instanceof StoreError) {
      throw error;
    }
    if (nodeErrorCode(error) !== "ENOENT") {
      throw new StoreError("store-root-failed", "could not inspect store root");
    }
    await mkdir(root, { recursive: true, mode: STORE_DIRECTORY_MODE });
  }

  await chmod(root, STORE_DIRECTORY_MODE);
}

export async function readStoredHookEvents(root: string): Promise<HookEvent[]> {
  await ensureStoreDirectory(root);
  return readEventsFile(root);
}

export async function readInteractions(root: string): Promise<Interaction[]> {
  await ensureStoreDirectory(root);
  let contents: string;
  try {
    contents = await readFile(join(root, INTERACTIONS_FILE_NAME), "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return [];
    }
    throw new StoreError("store-read-failed", "could not read interaction store");
  }

  const parsed: unknown = parseJson(contents);
  if (!Array.isArray(parsed)) {
    throw new StoreError("store-invalid-shape", "interaction store must be an array");
  }

  const records: Interaction[] = [];
  const seen = new Map<string, Interaction>();
  for (const value of parsed) {
    const record = validateInteraction(value);
    const prior = seen.get(record.id);
    if (prior !== undefined) {
      if (!sameInteraction(prior, record)) {
        throw new StoreError("store-conflict", "interaction store contains a conflict");
      }
      continue;
    }
    seen.set(record.id, record);
    records.push(record);
  }
  await chmod(join(root, INTERACTIONS_FILE_NAME), STORE_FILE_MODE);
  return records;
}

/** Insert one normalized hook event and reconcile only its exact turn key. */
export async function ingestHookEvent(root: string, event: HookEvent): Promise<IngestResult> {
  await ensureStoreDirectory(root);
  return withStoreLock(root, async () => {
    const events = await readEventsFile(root);
    const existingById = events.find((candidate) => candidate.id === event.id);
    let eventStatus: IngestResult["eventStatus"] = "duplicate";
    if (existingById === undefined) {
      await appendEvent(root, event);
      events.push(event);
      eventStatus = "inserted";
    } else if (!sameEvent(existingById, event)) {
      throw new StoreError("event-id-conflict", "event id has conflicting content");
    }

    const correlation = correlateEvents(events).find(
      (candidate) => candidate.key === turnKey(event.sessionId, event.turnId),
    );
    if (correlation === undefined || correlation.status === "incomplete") {
      return { eventStatus, outcome: "pending", reason: "awaiting-pair" };
    }
    if (correlation.status === "rejected") {
      return { eventStatus, outcome: "rejected", reason: correlation.reason };
    }

    const interactions = await readInteractions(root);
    const existingInteraction = interactions.find(
      (candidate) => candidate.id === correlation.interaction.id,
    );
    if (existingInteraction !== undefined) {
      if (!sameInteraction(existingInteraction, correlation.interaction)) {
        return { eventStatus, outcome: "rejected", reason: "interaction-conflict" };
      }
      return {
        eventStatus,
        outcome: "completed",
        interaction: { ...existingInteraction },
      };
    }

    const nextInteractions = [...interactions, correlation.interaction];
    await writeJsonAtomically(
      join(root, INTERACTIONS_FILE_NAME),
      JSON.stringify(nextInteractions, null, 2) + "\n",
    );
    return {
      eventStatus,
      outcome: "completed",
      interaction: { ...correlation.interaction },
    };
  });
}

async function readEventsFile(root: string): Promise<HookEvent[]> {
  let contents: string;
  try {
    contents = await readFile(join(root, EVENTS_FILE_NAME), "utf8");
  } catch (error) {
    if (nodeErrorCode(error) === "ENOENT") {
      return [];
    }
    throw new StoreError("event-read-failed", "could not read hook event store");
  }

  const events: HookEvent[] = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      const event = validateEvent(JSON.parse(line) as unknown);
      events.push(event);
    } catch {
      // A torn or malformed event line cannot contaminate a valid pair.
    }
  }
  await chmod(join(root, EVENTS_FILE_NAME), STORE_FILE_MODE);
  return events;
}

async function appendEvent(root: string, event: HookEvent): Promise<void> {
  const path = join(root, EVENTS_FILE_NAME);
  await appendFile(path, `${JSON.stringify(event)}\n`, {
    encoding: "utf8",
    mode: STORE_FILE_MODE,
  });
  await chmod(path, STORE_FILE_MODE);
}

async function writeJsonAtomically(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx", STORE_FILE_MODE);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, STORE_FILE_MODE);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function withStoreLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const lockPath = join(root, LOCK_FILE_NAME);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, "wx", STORE_FILE_MODE);
      await handle.close();
      handle = undefined;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (nodeErrorCode(error) !== "EEXIST") {
        throw new StoreError("store-lock-failed", "could not acquire store lock");
      }
      try {
        const details = await stat(lockPath);
        if (Date.now() - details.mtimeMs > 30_000) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      await delay(10);
      continue;
    }

    try {
      return await action();
    } finally {
      await unlink(lockPath).catch(() => undefined);
    }
  }
  throw new StoreError("store-lock-timeout", "store lock timed out");
}

function validateEvent(value: unknown): HookEvent {
  if (!isRecord(value)) {
    throw new StoreError("invalid-event", "stored event is not an object");
  }
  const kind = value.kind;
  const sessionId = value.sessionId;
  const turnId = value.turnId;
  const text = value.text;
  const textSha256 = value.textSha256;
  const textByteLength = value.textByteLength;
  if (
    (kind !== "prompt" && kind !== "stop") ||
    typeof value.id !== "string" ||
    typeof sessionId !== "string" ||
    typeof turnId !== "string" ||
    typeof text !== "string" ||
    typeof textSha256 !== "string" ||
    typeof textByteLength !== "number" ||
    !Number.isSafeInteger(textByteLength) ||
    textByteLength !== Buffer.byteLength(text, "utf8")
  ) {
    throw new StoreError("invalid-event", "stored event has an invalid shape");
  }
  if (value.source !== undefined && typeof value.source !== "string") {
    throw new StoreError("invalid-event", "stored event has an invalid source");
  }
  return {
    id: value.id,
    kind,
    sessionId,
    turnId,
    text,
    textSha256,
    textByteLength,
    ...(value.source === undefined ? {} : { source: value.source }),
  };
}

function validateInteraction(value: unknown): Interaction {
  if (!isRecord(value)) {
    throw new StoreError("invalid-record", "stored interaction is not an object");
  }
  const expected = new Set([
    "id",
    "sessionId",
    "turnId",
    "submittedPrompt",
    "finalReport",
    "status",
    "provenance",
  ]);
  if (Object.keys(value).some((key) => !expected.has(key))) {
    throw new StoreError("invalid-record", "stored interaction has unexpected fields");
  }
  if (
    typeof value.id !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.turnId !== "string" ||
    typeof value.submittedPrompt !== "string" ||
    typeof value.finalReport !== "string" ||
    value.status !== "completed" ||
    value.provenance !== "codex-native-hooks"
  ) {
    throw new StoreError("invalid-record", "stored interaction has an invalid shape");
  }
  return {
    id: value.id,
    sessionId: value.sessionId,
    turnId: value.turnId,
    submittedPrompt: value.submittedPrompt,
    finalReport: value.finalReport,
    status: "completed",
    provenance: "codex-native-hooks",
  };
}

function sameEvent(left: HookEvent, right: HookEvent): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.text === right.text &&
    left.textSha256 === right.textSha256 &&
    left.textByteLength === right.textByteLength &&
    left.source === right.source
  );
}

function parseJson(contents: string): unknown {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new StoreError("store-invalid-json", "store is not valid JSON");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
