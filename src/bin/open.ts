import { createHerdrClient, HerdrProcessError, isHerdrCliError } from "@j1nn0/herdr-plugin-sdk";
import { isMainModule as isMainModulePath } from "../runtime/is-main-module.ts";

const PLUGIN_ID = "j1nn0.herdr-harvest";
const ENTRYPOINT = "inbox";

export async function runOpen(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const client = createHerdrClient({ env });
    // Use the SDK's default 10-second timeout for this short-lived pane-open call.
    await client.plugin.pane.open({
      pluginId: PLUGIN_ID,
      entrypoint: ENTRYPOINT,
      placement: "overlay",
      focus: true,
    });
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
  return isMainModulePath(import.meta.url, process.argv[1]);
}

if (isMainModule()) {
  void runOpen().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
