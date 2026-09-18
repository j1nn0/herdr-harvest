#!/usr/bin/env -S node --experimental-strip-types
import { isMainModule as isMainModulePath } from "../runtime/is-main-module.ts";
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
  return isMainModulePath(import.meta.url, process.argv[1]);
}

if (isMainModule()) {
  process.exitCode = await runStopHook();
}
