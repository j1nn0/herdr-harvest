import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PLUGIN_ID = "j1nn0.herdr-harvest";
const ENTRYPOINT = "inbox";

export async function runOpen(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const command = env.HERDR_BIN_PATH ?? "herdr";
  try {
    const result = await executeOpen(command, env);
    const errorResponse = parseErrorResponse(result.stdout);
    if (errorResponse !== null) {
      process.stderr.write(`${JSON.stringify(errorResponse)}\n`);
      return 1;
    }
    return 0;
  } catch (error) {
    const details = error as { stderr?: unknown };
    const stderr = typeof details.stderr === "string" ? details.stderr.trim() : "";
    process.stderr.write(`${stderr.length > 0 ? stderr : errorMessage(error)}\n`);
    return 1;
  }
}

function executeOpen(
  command: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    execFile(
      command,
      [
        "plugin",
        "pane",
        "open",
        "--plugin",
        PLUGIN_ID,
        "--entrypoint",
        ENTRYPOINT,
        "--placement",
        "overlay",
        "--focus",
      ],
      { env, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error !== null) {
          const failure = error as Error & { stderr?: string; stdout?: string };
          failure.stderr = String(stderr ?? failure.stderr ?? "");
          failure.stdout = String(stdout ?? failure.stdout ?? "");
          reject(failure);
          return;
        }
        resolveResult({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

function parseErrorResponse(stdout: string): Record<string, unknown> | null {
  if (stdout.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const object = parsed as Record<string, unknown>;
  return "error" in object && "id" in object ? object : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url;
}

if (isMainModule()) {
  void runOpen().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
