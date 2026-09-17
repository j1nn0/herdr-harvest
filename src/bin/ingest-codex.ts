#!/usr/bin/env -S node --experimental-strip-types
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHookStdin, safeCode } from "../codex/hook-runtime.ts";
import {
  type CodexIngestEvent,
  CodexIngestInputError,
  ingestCodexEvent,
  parseCodexIngestInput,
} from "../codex/ingest.ts";
import { isCodexCollectionEnabled } from "../config/config.ts";

export async function runIngestCodex(): Promise<number> {
  if (!isCodexCollectionEnabled(process.env)) {
    process.stderr.write(
      "Codex ingest disabled: set HARVEST_CODEX_COLLECT=1 to enable local Codex collection.\n",
    );
    return 2;
  }

  let json: string;
  try {
    json = await readHookStdin();
  } catch {
    process.stderr.write("Codex ingest could not read stdin.\n");
    return 2;
  }

  let event: CodexIngestEvent;
  try {
    event = parseCodexIngestInput(json);
  } catch (error) {
    process.stderr.write(`Codex ingest rejected stdin: ${safeCode(error)}.\n`);
    return 2;
  }

  try {
    const outcome = ingestCodexEvent(event, process.env);
    if (outcome.status === "disabled") {
      process.stderr.write(
        "Codex ingest disabled: set HARVEST_CODEX_COLLECT=1 to enable local Codex collection.\n",
      );
      return 2;
    }
    if (outcome.status === "rejected") {
      process.stderr.write(`Codex ingest rejected event: ${outcome.failure.reason}.\n`);
      return 1;
    }
    if (outcome.status === "staged") {
      process.stdout.write(
        `${JSON.stringify({
          status: "pending",
          sessionId: outcome.sessionId,
          turnId: outcome.turnId,
        })}\n`,
      );
      return 0;
    }
    process.stdout.write(
      `${JSON.stringify({
        status: outcome.status,
        interactionId: outcome.interaction.interactionId,
        sessionId: outcome.interaction.sessionId,
      })}\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `Codex ingest failed while writing the local database: ${safeCode(error)}.\n`,
    );
    return 1;
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  process.exitCode = await runIngestCodex();
}

export { CodexIngestInputError };
