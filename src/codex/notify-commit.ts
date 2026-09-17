#!/usr/bin/env -S node --experimental-strip-types
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  process.exitCode = runNotifyCommit();
}
