import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, appendFile, unlink, writeFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { normalizeEvent } from "./contract.mjs";

export const EVENTS_FILE_NAME = "events.jsonl";

/** Record a validated hook event in an opt-in, owner-readable sidecar. */
export async function recordEvent(event) {
  const root = collectorRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const lockPath = join(root, ".events.lock");
  const eventsPath = join(root, EVENTS_FILE_NAME);
  const counterPath = join(root, ".arrival-counter");
  const release = await acquireLock(lockPath);
  try {
    const previous = await readCounter(counterPath);
    const arrivalOrder = Math.max(previous + 1, Date.now() * 1_000);
    const stored = normalizeEvent({
      ...event,
      arrival_order: arrivalOrder,
      event_id: randomUUID(),
    });
    await writeFile(counterPath, `${arrivalOrder}\n`, { mode: 0o600 });
    await chmod(counterPath, 0o600);
    await appendFile(eventsPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
    await chmod(eventsPath, 0o600);
    return stored;
  } finally {
    await release();
  }
}

export async function readRecordedEvents(root = collectorRoot()) {
  const eventsPath = join(root, EVENTS_FILE_NAME);
  let content;
  try {
    content = await readFile(eventsPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const events = [];
  for (const line of content.split("\n")) {
    if (line.trim().length === 0) {
      continue;
    }
    try {
      events.push(normalizeEvent(JSON.parse(line)));
    } catch {
      // A torn or malicious line cannot crash reporting or contaminate a pair.
    }
  }
  return events;
}

function collectorRoot() {
  const root = process.env.CLAUDE_COLLECTOR_DIR;
  if (typeof root !== "string" || !isAbsolute(root) || root.length > 1_024) {
    throw new Error("CLAUDE_COLLECTOR_DIR is not an absolute path");
  }
  return root;
}

async function readCounter(path) {
  try {
    const value = Number.parseInt(await readFile(path, "utf8"), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (error) {
    return error?.code === "ENOENT" ? 0 : 0;
  }
}

async function acquireLock(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      return async () => {
        await unlink(path).catch(() => undefined);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const details = await stat(path);
        if (Date.now() - details.mtimeMs > 15_000) {
          await unlink(path).catch(() => undefined);
          continue;
        }
      } catch {
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("collector lock timeout");
}
