import { Buffer } from "node:buffer";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

export const PI_DIAGNOSTICS_FILE_NAME = "pi-diagnostics.jsonl";
export const PI_DIAGNOSTICS_DIRECTORY_MODE = 0o700;
export const PI_DIAGNOSTICS_FILE_MODE = 0o600;

export interface PiCollectorDiagnostic {
  code: string;
  stage?: string;
  sessionId?: string;
  interactionId?: string;
  sequence?: number;
  errorName?: string;
}

/**
 * Writes only bounded diagnostic metadata. Prompt, response, tool, and error
 * bodies are intentionally excluded from this file.
 */
export async function writePiDiagnostic(
  diagnostic: PiCollectorDiagnostic,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const path = diagnosticPath(env);
  if (path === undefined) {
    return;
  }
  await mkdir(dirname(path), { recursive: true, mode: PI_DIAGNOSTICS_DIRECTORY_MODE });
  const handle = await open(path, "a", PI_DIAGNOSTICS_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(sanitizeDiagnostic(diagnostic))}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
    await chmod(path, PI_DIAGNOSTICS_FILE_MODE);
  }
}

export function diagnosticPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const explicit = env.HARVEST_PI_DIAGNOSTICS_PATH;
  if (explicit !== undefined && isAbsolute(explicit)) {
    return explicit;
  }
  const stateDirectory = env.HARVEST_STATE_DIR ?? env.HERDR_PLUGIN_STATE_DIR;
  if (stateDirectory === undefined || !isAbsolute(stateDirectory)) {
    return undefined;
  }
  return join(stateDirectory, PI_DIAGNOSTICS_FILE_NAME);
}

function sanitizeDiagnostic(diagnostic: PiCollectorDiagnostic): PiCollectorDiagnostic {
  return {
    code: boundedText(diagnostic.code, 128) ?? "unknown",
    ...(boundedText(diagnostic.stage, 128) === undefined
      ? {}
      : { stage: boundedText(diagnostic.stage, 128) }),
    ...(boundedText(diagnostic.sessionId, 128) === undefined
      ? {}
      : { sessionId: boundedText(diagnostic.sessionId, 128) }),
    ...(boundedText(diagnostic.interactionId, 128) === undefined
      ? {}
      : { interactionId: boundedText(diagnostic.interactionId, 128) }),
    ...(Number.isSafeInteger(diagnostic.sequence) ? { sequence: diagnostic.sequence } : {}),
    ...(boundedText(diagnostic.errorName, 128) === undefined
      ? {}
      : { errorName: boundedText(diagnostic.errorName, 128) }),
  };
}

function boundedText(value: string | undefined, maxBytes: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) {
    return value;
  }
  return bytes.subarray(0, maxBytes).toString("utf8");
}
