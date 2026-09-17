#!/usr/bin/env -S node --experimental-strip-types
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeStopPayload } from "./collector-contract.ts";
import { readHookStdin, runCodexHookEvent, writeFailure } from "./hook-runtime.ts";

export async function runStopHook(): Promise<number> {
  let json: string;
  try {
    json = await readHookStdin();
  } catch {
    writeFailure("read-failed");
    return 1;
  }

  const normalized = normalizeStopPayload(parseJson(json));
  if (!normalized.ok) {
    return 0;
  }
  return runCodexHookEvent(normalized.event);
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  process.exitCode = await runStopHook();
}
