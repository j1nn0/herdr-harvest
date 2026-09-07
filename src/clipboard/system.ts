import { execFile } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import type { ClipboardProvider, CopyReport } from "./provider.ts";
import { ClipboardError } from "./provider.ts";

const COPY_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 1_048_576;

type PathPlatform = "darwin" | "win32" | string;

type ErrorDetails = {
  code?: unknown;
  killed?: unknown;
  signal?: unknown;
};

export function createSystemClipboard(
  platform: PathPlatform,
  env: NodeJS.ProcessEnv,
): ClipboardProvider | null {
  const command = selectCommand(platform, env);
  if (command === null) {
    return null;
  }

  return {
    name: command.name,
    copy: (text) => copyWithSystemCommand(command.path, command.name, command.args, env, text),
  };
}

function selectCommand(
  platform: PathPlatform,
  env: NodeJS.ProcessEnv,
): { name: string; path: string; args: readonly string[] } | null {
  const candidates = clipboardCandidates(platform, env);
  for (const candidate of candidates) {
    const path = findOnPath(candidate, platform, env);
    if (path !== null) {
      return { name: candidate, path, args: commandArguments(candidate) };
    }
  }
  return null;
}

function clipboardCandidates(platform: PathPlatform, env: NodeJS.ProcessEnv): readonly string[] {
  if (platform === "darwin") {
    return ["pbcopy"];
  }
  if (platform === "win32") {
    return ["clip.exe", "clip"];
  }
  if (env.WAYLAND_DISPLAY !== undefined && env.WAYLAND_DISPLAY.length > 0) {
    return ["wl-copy", "xclip", "xsel"];
  }
  return ["xclip", "xsel"];
}

function commandArguments(command: string): readonly string[] {
  if (command === "xclip") {
    return ["-selection", "clipboard"];
  }
  if (command === "xsel") {
    return ["--clipboard", "--input"];
  }
  return [];
}

function findOnPath(
  command: string,
  platform: PathPlatform,
  env: NodeJS.ProcessEnv,
): string | null {
  const pathValue = env.PATH ?? env.Path;
  if (pathValue === undefined || pathValue.length === 0) {
    return null;
  }

  for (const directory of pathEntries(pathValue, platform)) {
    const candidate = join(directory, command);
    if (isExecutable(candidate, platform)) {
      return candidate;
    }
  }
  return null;
}

function pathEntries(pathValue: string, platform: PathPlatform): readonly string[] {
  if (platform === "win32" && /^[A-Za-z]:[\\/]/.test(pathValue) && !pathValue.includes(";")) {
    return [pathValue];
  }

  const separator = pathValue.includes(";") ? ";" : delimiter;
  return pathValue.split(separator).filter((entry) => entry.length > 0);
}

function isExecutable(path: string, platform: PathPlatform): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    if (platform !== "win32") {
      return false;
    }
    try {
      accessSync(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  }
}

function copyWithSystemCommand(
  commandPath: string,
  provider: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  text: string,
): Promise<CopyReport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let child: ReturnType<typeof execFile>;

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (child !== undefined) {
        child.removeListener("error", onChildError);
        child.stdin?.removeListener("error", onStdinError);
      }
      callback();
    };

    const fail = (error: unknown, stderr?: unknown): void => {
      const reason = clipboardFailureReason(error, stderr);
      finish(() => {
        reject(
          new ClipboardError(`Clipboard provider ${provider} failed: ${reason}`, [
            `${provider}: ${reason}`,
          ]),
        );
      });
    };

    const onChildError = (error: Error): void => {
      fail(error);
    };
    const onStdinError = (error: Error): void => {
      fail(error);
    };

    try {
      child = execFile(
        commandPath,
        args,
        {
          env,
          encoding: "utf8",
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: COPY_TIMEOUT_MS,
          windowsHide: true,
        },
        (error, _stdout, stderr) => {
          if (error !== null) {
            fail(error, stderr);
            return;
          }
          finish(() => resolve({ provider, confirmed: true }));
        },
      );
      child.once("error", onChildError);
      child.stdin?.once("error", onStdinError);

      if (child.stdin === null) {
        fail(new Error("clipboard process has no writable stdin"));
        return;
      }
      child.stdin.end(text, "utf8");
    } catch (error) {
      fail(error);
    }
  });
}

function clipboardFailureReason(error: unknown, stderr?: unknown): string {
  let reason: string;
  if (error !== null && typeof error === "object") {
    const details = error as ErrorDetails;
    if (details.code === "ETIMEDOUT" || (details.killed === true && details.signal === "SIGTERM")) {
      reason = `timed out after ${COPY_TIMEOUT_MS} ms`;
    } else if (error instanceof Error && error.message.length > 0) {
      reason = error.message;
    } else {
      reason = String(error);
    }
  } else {
    reason = String(error);
  }

  const output = typeof stderr === "string" ? stderr.trim() : "";
  return output.length > 0 && !reason.includes(output) ? `${reason}: ${output}` : reason;
}
