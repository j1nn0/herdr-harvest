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
    writeFileSync(
      preloadPath,
      `if (process.argv[1] === undefined) {
  const fs = require("node:fs");
  const env = process.env;
  if (env.ARGS_FILE !== undefined) {
    fs.writeFileSync(env.ARGS_FILE, JSON.stringify(process.argv.slice(2)));
  }
  if (env.REPORT_ERROR === "1") {
    process.stderr.write(
      JSON.stringify({
        error: { code: "pane_open_failed", message: "Pane open failed." },
      }),
    );
    process.exit(7);
  }
  if (env.REPORT_FAILURE === "1") {
    process.stderr.write("stub command failed");
    process.exit(9);
  }
  if (env.CAPTURE_FILE !== undefined) {
    fs.writeFileSync(env.CAPTURE_FILE, fs.readFileSync(0, "utf8"));
    process.exitCode = Number(env.STUB_EXIT || 0);
    return;
  }
  if (env.STUB_STDERR !== undefined) {
    // Drain stdin to EOF first, mirroring the POSIX body. Exiting before the parent
    // finishes writing would race its stdin.end() into an EPIPE, and the caller would
    // then observe that write error instead of this stub's exit code and stderr.
    try {
      fs.readFileSync(0);
    } catch {}
    process.stderr.write(env.STUB_STDERR);
    process.exit(Number(env.STUB_EXIT || 0));
  }
  process.stdout.write("accepted");
  process.exit(0);
}
`,
    );
    copyFileSync(process.execPath, path);
    const normalizedPreloadPath = preloadPath.replaceAll("\\", "/");
    return {
      path,
      env: { NODE_OPTIONS: `--require="${normalizedPreloadPath}"` },
    };
  }

  const path = join(dir, name);
  writeFileSync(path, `#!${process.execPath}\n${posixBody}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
  return { path, env: {} };
}
