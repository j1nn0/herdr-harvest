import { Buffer } from "node:buffer";
import { isAbsolute } from "node:path";

import { normalizeHookPayload } from "./contract.ts";
import type { HookEventName } from "./contract.ts";
import { ingestHookEvent, StoreError } from "./store.ts";

const MAX_HOOK_INPUT_BYTES = 16 * 1024 * 1024;

/** Run one observer-only hook adapter. Invalid or unrelated input is ignored. */
export async function runHookReceiver(expectedEventName: HookEventName): Promise<number> {
  try {
    const raw = await readStdin();
    let payload: unknown;
    try {
      payload = JSON.parse(raw) as unknown;
    } catch {
      return 0;
    }

    const normalized = normalizeHookPayload(payload, expectedEventName);
    if (normalized.event === null) {
      return 0;
    }

    const root = process.env.CODEX_COLLECTOR_DIR;
    if (typeof root !== "string" || !isAbsolute(root)) {
      reportFailure("invalid-store-root");
      return 1;
    }
    await ingestHookEvent(root, normalized.event);
    return 0;
  } catch (error) {
    reportFailure(errorCode(error));
    return 1;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_HOOK_INPUT_BYTES) {
      throw new StoreError("hook-input-too-large", "hook input exceeds collector limit");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reportFailure(code: string): void {
  process.stderr.write(`codex-collector failure code=${code}\n`);
}

function errorCode(error: unknown): string {
  if (error instanceof StoreError) {
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
