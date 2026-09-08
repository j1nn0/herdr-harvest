import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHerdrClient, HerdrProcessError, isHerdrCliError } from "@j1nn0/herdr-plugin-sdk";

const PLUGIN_ID = "j1nn0.herdr-harvest";
const ENTRYPOINT = "inbox";

export async function runOpen(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const client = createHerdrClient({ env });
    await client.run([
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
    ]);
    return 0;
  } catch (error) {
    process.stderr.write(`${errorDiagnostic(error)}\n`);
    return 1;
  }
}

function errorDiagnostic(error: unknown): string {
  if (isHerdrCliError(error)) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof HerdrProcessError) {
    const stderr = error.stderr.trim();
    return stderr.length > 0 ? stderr : error.message;
  }
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
