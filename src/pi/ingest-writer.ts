import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import type { PiInteractionInput } from "../domain/pi-interaction.ts";

export type PiInteractionWriter = (record: PiInteractionInput) => Promise<void>;

export interface PiIngestWriterOptions {
  scriptPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Send one terminal record to the package-local ingest adapter. The child
 * process receives only the terminal JSON record and its output is discarded;
 * diagnostic details stay collector-owned and never echo record bodies.
 */
export function createPiIngestWriter(options: PiIngestWriterOptions = {}): PiInteractionWriter {
  const scriptPath =
    options.scriptPath ?? fileURLToPath(new URL("../bin/ingest-pi.ts", import.meta.url));
  const environment = options.env ?? process.env;
  return (record) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [scriptPath], {
        env: environment,
        stdio: ["pipe", "ignore", "ignore"],
      });
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      child.once("error", (error) => finish(error));
      child.stdin.once("error", (error) => finish(error));
      child.once("close", (code, signal) => {
        if (code === 0) {
          finish();
        } else {
          finish(
            new Error(`Pi ingest exited unsuccessfully (${code ?? `signal:${String(signal)}`})`),
          );
        }
      });
      child.stdin.end(JSON.stringify(record));
    });
}
