import { chmodSync, copyFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function spawnableCommand(
  dir: string,
  name: string,
  posixBody: string,
): { path: string; env: NodeJS.ProcessEnv } {
  // Keep the POSIX body and the Windows preload semantically in sync; their pairing is the maintenance hazard here.
  if (process.platform === "win32") {
    const commandName = name.endsWith(".exe") ? name : `${name}.exe`;
    const path = join(dir, commandName);
    const preloadPath = join(dir, "__stub.cjs");
    const bodyPath = join(dir, "__stub-body.cjs");
    writeFileSync(bodyPath, posixBody);
    writeFileSync(
      preloadPath,
      `if (process.execPath === process.env.HARVEST_STUB_BINARY) {
  const fs = require("node:fs");
  const env = process.env;
  if (env.ARGS_FILE !== undefined) {
    fs.writeFileSync(env.ARGS_FILE, JSON.stringify(process.argv.slice(1)));
  }
  if (env.REPORT_ERROR === "1") {
    fs.writeSync(
      2,
      JSON.stringify({
        error: { code: "pane_open_failed", message: "Pane open failed." },
      }),
    );
    process.exit(7);
  }
  if (env.REPORT_FAILURE === "1") {
    fs.writeSync(2, "stub command failed");
    process.exit(9);
  }
  if (env.CAPTURE_FILE !== undefined) {
    fs.writeFileSync(env.CAPTURE_FILE, fs.readFileSync(0, "utf8"));
    process.exit(Number(env.STUB_EXIT || 0));
  }
  if (env.STUB_STDERR !== undefined) {
    // Drain stdin before exiting so the parent's stdin.end() cannot race into EPIPE.
    try {
      fs.readFileSync(0);
    } catch {}
    fs.writeSync(2, env.STUB_STDERR);
    process.exit(Number(env.STUB_EXIT || 0));
  }
  if (env.HARVEST_STUB_RUN_BODY === "1" && env.HARVEST_STUB_BODY !== undefined) {
    process.argv.splice(1, 0, env.HARVEST_STUB_BODY);
    process.stdout.write = (text) => {
      fs.writeSync(1, text);
      return true;
    };
    process.stderr.write = (text) => {
      fs.writeSync(2, text);
      return true;
    };
    require(env.HARVEST_STUB_BODY);
    process.exit(Number(process.exitCode ?? 0));
  }
  fs.writeSync(1, "accepted");
  process.exit(0);
}`,
    );
    copyFileSync(process.execPath, path);
    const normalizedPreloadPath = preloadPath.replaceAll("\\", "/");
    return {
      path,
      env: {
        NODE_OPTIONS: `--require="${normalizedPreloadPath}"`,
        HARVEST_STUB_BINARY: path,
        HARVEST_STUB_BODY: bodyPath,
      },
    };
  }

  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${posixBody}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { path, env: {} };
}
