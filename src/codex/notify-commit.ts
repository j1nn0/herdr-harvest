#!/usr/bin/env -S node --experimental-strip-types
import { isMainModule as isMainModulePath } from "../runtime/is-main-module.ts";
import { normalizeNotifyPayload } from "./collector-contract.ts";
import { runCodexHookEvent } from "./hook-runtime.ts";

export function runNotifyCommit(argv: readonly string[] = process.argv): number {
  const json = argv.at(-1);
  if (json === undefined) {
    return 0;
  }

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return 0;
  }
  const normalized = normalizeNotifyPayload(value);
  if (!normalized.ok) {
    return 0;
  }
  return runCodexHookEvent(normalized.event);
}

function isMainModule(): boolean {
  return isMainModulePath(import.meta.url, process.argv[1]);
}

if (isMainModule()) {
  process.exitCode = runNotifyCommit();
}
