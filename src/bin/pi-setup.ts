import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  installPiCollector,
  PiSetupConflictError,
  statusPiCollector,
  uninstallPiCollector,
} from "../pi/setup.ts";

interface SetupOutput {
  write: (text: string) => void;
}

interface ParsedArguments {
  command: "install" | "uninstall" | "status" | "help";
  homeDirectory?: string;
}

/** Thin process adapter for the explicit one-time Pi extension setup. */
export function runPiSetup(
  argv: readonly string[] = process.argv.slice(2),
  env: Readonly<Record<string, string | undefined>> = process.env,
  stdout: SetupOutput = process.stdout,
  stderr: SetupOutput = process.stderr,
): number {
  let argumentsValue: ParsedArguments;
  try {
    argumentsValue = parseArguments(argv);
  } catch (error) {
    stderr.write(`Harvest Pi setup argument error: ${errorMessage(error)}\n`);
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
      const result = installPiCollector({ homeDir: homeDirectory });
      const message =
        result.status === "already-installed"
          ? "already installed"
          : result.status === "updated"
            ? "updated"
            : "installed";
      stdout.write(`Harvest Pi extension ${message}: ${result.paths.discoveryPath}\n`);
      return 0;
    }
    if (argumentsValue.command === "uninstall") {
      const result = uninstallPiCollector({ homeDir: homeDirectory });
      stdout.write(`Harvest Pi extension ${result.status}: ${result.paths.discoveryPath}\n`);
      return 0;
    }

    const result = statusPiCollector({ homeDir: homeDirectory });
    stdout.write(`Harvest Pi extension status: ${result.status}\n`);
    return 0;
  } catch (error) {
    const prefix = error instanceof PiSetupConflictError ? "conflict" : "failed";
    stderr.write(`Harvest Pi setup ${prefix}: ${errorMessage(error)}\n`);
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
  return "Usage: node src/bin/pi-setup.ts <install|uninstall|status> [--home <path>]";
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : String(error);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  process.exitCode = runPiSetup();
}
