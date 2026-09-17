import type { DatabaseSync } from "node:sqlite";

import { isPiCollectionEnabled, loadConfig } from "../config/config.ts";
import type { PiInteractionInput } from "../domain/pi-interaction.ts";
import { openDatabase } from "../persistence/database.ts";
import {
  PiInteractionConflictError,
  PiInteractionStore,
  PiInteractionValidationError,
} from "../persistence/pi-interaction-store.ts";
import { PiIngestInputError, parsePiInteractionInput } from "../pi/ingest.ts";
import { isMainModule as isMainModulePath } from "../runtime/is-main-module.ts";

/** Read one terminal interaction from stdin and insert it into harvest.db. */
export async function runIngestPi(): Promise<number> {
  if (!isPiCollectionEnabled(process.env)) {
    process.stderr.write(
      "Pi ingest disabled: set HARVEST_PI_COLLECT=1 to enable local Pi collection.\n",
    );
    return 2;
  }

  let json: string;
  try {
    json = await readStdin();
  } catch {
    process.stderr.write("Pi ingest could not read stdin.\n");
    return 2;
  }

  let input: PiInteractionInput;
  try {
    input = parsePiInteractionInput(json);
  } catch (error) {
    process.stderr.write(`Pi ingest rejected stdin: ${safeCode(error)}.\n`);
    return 2;
  }

  let databasePath: string;
  try {
    databasePath = loadConfig(process.env).config.databasePath;
  } catch {
    process.stderr.write("Pi ingest requires HARVEST_STATE_DIR or HERDR_PLUGIN_STATE_DIR.\n");
    return 2;
  }

  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(databasePath);
    const store = new PiInteractionStore(db);
    const outcome = store.insert(input);
    process.stdout.write(
      `${JSON.stringify({
        status: outcome.status,
        interactionId: outcome.interaction.interactionId,
        sessionId: outcome.interaction.sessionId,
      })}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof PiInteractionConflictError) {
      process.stderr.write("Pi ingest rejected a conflicting duplicate.\n");
      return 1;
    }
    if (error instanceof PiInteractionValidationError) {
      process.stderr.write(`Pi ingest rejected the interaction: ${error.code}.\n`);
      return 2;
    }
    process.stderr.write("Pi ingest failed while writing the local database.\n");
    return 1;
  } finally {
    db?.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

function safeCode(error: unknown): string {
  if (error instanceof PiIngestInputError) {
    return error.code;
  }
  return "invalid-input";
}

function isMainModule(): boolean {
  return isMainModulePath(import.meta.url, process.argv[1]);
}

if (isMainModule()) {
  process.exitCode = await runIngestPi();
}
