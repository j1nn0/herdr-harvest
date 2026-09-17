#!/usr/bin/env -S node --experimental-strip-types
import { homedir } from "node:os";

import {
  CodexSetupConflictError,
  installCodexCollector,
  statusCodexCollector,
  uninstallCodexCollector,
} from "../codex/setup.ts";
import { isMainModule as isMainModulePath } from "../runtime/is-main-module.ts";

interface SetupOutput {
  write: (text: string) => void;
}

interface ParsedArguments {
  command: "install" | "uninstall" | "status" | "help";
  homeDirectory?: string;
}

/** Thin process adapter for the explicit one-time user-level Codex setup. */
export function runCodexSetup(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  stdout: SetupOutput = process.stdout,
  stderr: SetupOutput = process.stderr,
): number {
  let argumentsValue: ParsedArguments;
  try {
    argumentsValue = parseArguments(argv);
  } catch (error) {
    stderr.write(`Harvest Codex setup argument error: ${errorMessage(error)}\n`);
    stderr.write(`${usage()}\n`);
    return 2;
  }

  if (argumentsValue.command === "help") {
    stdout.write(`${usage()}\n`);
    return 0;
  }

  const homeDirectory = argumentsValue.homeDirectory ?? env.HOME ?? env.USERPROFILE ?? homedir();
  try {
    if (argumentsValue.command === "install") {
      const result = installCodexCollector({ homeDir: homeDirectory });
      const message =
        result.status === "already-installed"
          ? "already installed"
          : result.status === "updated"
            ? "updated"
            : "installed";
      stdout.write(`Harvest Codex user-level setup ${message}: ${result.paths.hooksPath}\n`);
      stdout.write(
        "Harvest Codex UserPromptSubmit and Stop trust status is unknown; review and trust them in the Codex /hooks UI.\n",
      );
      if (result.notify === "installed") {
        stdout.write(`Harvest Codex notify is present in ${result.paths.configPath}.\n`);
      } else {
        stdout.write(
          `Merge this top-level notify line into ${result.paths.configPath} (do not create a duplicate key): ${result.notifyLine}\n`,
        );
      }
      return 0;
    }
    if (argumentsValue.command === "uninstall") {
      const result = uninstallCodexCollector({ homeDir: homeDirectory });
      stdout.write(`Harvest Codex user-level setup ${result.status}: ${result.paths.hooksPath}\n`);
      if (result.notify === "installed") {
        stdout.write(
          `Harvest Codex notify was left in ${result.paths.configPath}; remove this top-level line manually if desired: ${result.notifyLine}\n`,
        );
      }
      return 0;
    }

    const result = statusCodexCollector({ homeDir: homeDirectory });
    stdout.write(`Harvest Codex user-level setup status: ${result.status}\n`);
    for (const hook of result.hooks) {
      stdout.write(`${hook.event} hook: ${hook.status}\n`);
    }
    for (const file of result.files) {
      stdout.write(`support ${file.path}: ${file.status}\n`);
    }
    stdout.write(`notify: ${result.notify}\n`);
    stdout.write(
      "trust: unknown (review and trust UserPromptSubmit and Stop in the Codex /hooks UI)\n",
    );
    if (result.notify === "missing") {
      stdout.write(
        `Merge this top-level notify line into ${result.paths.configPath} (do not create a duplicate key): ${result.notifyLine}\n`,
      );
    }
    if (result.reason !== undefined) {
      stdout.write(`reason: ${result.reason}\n`);
    }
    return 0;
  } catch (error) {
    const prefix = error instanceof CodexSetupConflictError ? "conflict" : "failed";
    stderr.write(`Harvest Codex setup ${prefix}: ${errorMessage(error)}\n`);
    return 1;
  }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const command = argv[0];
  if (command === undefined || command === "--help" || command === "-h") {
    return { command: "help" };
  }
  if (command !== "install" && command !== "uninstall" && command !== "status") {
    throw new Error(`unknown command ${JSON.stringify(command)}`);
  }

  let homeDirectory: string | undefined;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--home") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--home requires a path");
      }
      homeDirectory = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    throw new Error(`unknown option ${JSON.stringify(argument)}`);
  }
  return { command, ...(homeDirectory === undefined ? {} : { homeDirectory }) };
}

function usage(): string {
  return "Usage: node src/bin/codex-setup.ts <install|uninstall|status> [--home <path>]";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function isMainModule(): boolean {
  return isMainModulePath(import.meta.url, process.argv[1]);
}

if (isMainModule()) {
  process.exitCode = runCodexSetup();
}
