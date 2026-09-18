#!/usr/bin/env -S node --experimental-strip-types
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import {
  CodexSetupConflictError,
  installCodexCollector,
  statusCodexCollector,
  uninstallCodexCollector,
} from "../codex/setup.ts";
import { type CodexPendingTurn, deleteCodexPending, listCodexPending } from "../codex/staging.ts";
import { loadConfig } from "../config/config.ts";
import { openDatabase } from "../persistence/database.ts";
import { isMainModule as isMainModulePath } from "../runtime/is-main-module.ts";

interface SetupOutput {
  write: (text: string) => void;
}

interface ParsedArguments {
  command: "install" | "uninstall" | "status" | "prune" | "help";
  homeDirectory?: string;
  apply?: boolean;
  confirm?: boolean;
  sessionId?: string;
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
    if (argumentsValue.command === "prune") {
      return runPrune(argumentsValue, env, stdout);
    }
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

    const pendingCodexTurns = readPendingCodexTurns(env).length;
    const result = statusCodexCollector({ homeDir: homeDirectory }, pendingCodexTurns);
    stdout.write(`Harvest Codex user-level setup status: ${result.status}\n`);
    for (const hook of result.hooks) {
      stdout.write(`${hook.event} hook: ${hook.status}\n`);
    }
    for (const file of result.files) {
      stdout.write(`support ${file.path}: ${file.status}\n`);
    }
    stdout.write(`notify: ${result.notify}\n`);
    stdout.write(`pending codex turns: ${result.pendingCodexTurns}\n`);
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
  if (
    command !== "install" &&
    command !== "uninstall" &&
    command !== "status" &&
    command !== "prune"
  ) {
    throw new Error(`unknown command ${JSON.stringify(command)}`);
  }

  let homeDirectory: string | undefined;
  let apply = false;
  let confirm = false;
  let sessionId: string | undefined;
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
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--confirm") {
      confirm = true;
      continue;
    }
    if (argument === "--session") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--session requires a non-empty id");
      }
      sessionId = value;
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      return { command: "help" };
    }
    throw new Error(`unknown option ${JSON.stringify(argument)}`);
  }
  if (command !== "prune" && (apply || confirm || sessionId !== undefined)) {
    throw new Error("--apply, --confirm, and --session are only valid with prune");
  }
  if (command === "prune") {
    if (apply && !confirm) {
      throw new Error("prune --apply requires --confirm");
    }
    if (confirm && !apply) {
      throw new Error("prune --confirm requires --apply");
    }
  }
  return {
    command,
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
    ...(apply ? { apply: true } : {}),
    ...(confirm ? { confirm: true } : {}),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function usage(): string {
  return [
    "Usage: node src/bin/codex-setup.ts <install|uninstall|status> [--home <path>]",
    "       node src/bin/codex-setup.ts prune [--home <path>] [--apply --confirm] [--session <id>]",
  ].join("\n");
}

function runPrune(
  argumentsValue: ParsedArguments,
  env: Readonly<Record<string, string | undefined>>,
  stdout: SetupOutput,
): number {
  const databasePath = loadConfig({ ...env }).config.databasePath;
  if (!existsSync(databasePath)) {
    if (argumentsValue.apply === true && argumentsValue.confirm === true) {
      writeDeleted(stdout, []);
    } else {
      writeDryRun(stdout, []);
    }
    return 0;
  }

  const db = openDatabase(databasePath);
  try {
    if (!hasPiInteractionsTable(db)) {
      if (argumentsValue.apply === true && argumentsValue.confirm === true) {
        writeDeleted(stdout, []);
      } else {
        writeDryRun(stdout, []);
      }
      return 0;
    }
    const candidates = listCodexPending(db, argumentsValue.sessionId);
    if (argumentsValue.apply !== true || argumentsValue.confirm !== true) {
      writeDryRun(stdout, candidates);
      return 0;
    }

    const deleted = deleteCodexPending(
      db,
      candidates.map((candidate) => candidate.dedupKey),
      argumentsValue.sessionId,
    );
    writeDeleted(stdout, deleted.deleted);
    return 0;
  } finally {
    db.close();
  }
}

function writeDryRun(stdout: SetupOutput, candidates: CodexPendingTurn[]): void {
  stdout.write(`pending codex turns: ${candidates.length}\n`);
  for (const candidate of candidates) {
    stdout.write(
      `pending sessionId=${JSON.stringify(candidate.sessionId)} interactionId=${candidate.interactionId} dedupKey=${candidate.dedupKey.slice(0, 16)}\n`,
    );
  }
  stdout.write("nothing deleted (dry-run; use --apply --confirm to delete)\n");
}

function writeDeleted(stdout: SetupOutput, deleted: string[]): void {
  stdout.write(`deleted codex pending turns: ${deleted.length}\n`);
  for (const dedupKey of deleted) {
    stdout.write(`deleted dedupKey=${dedupKey}\n`);
  }
}

function readPendingCodexTurns(
  env: Readonly<Record<string, string | undefined>>,
): CodexPendingTurn[] {
  const stateDirectory = env.HARVEST_STATE_DIR ?? env.HERDR_PLUGIN_STATE_DIR;
  if (stateDirectory === undefined) {
    return [];
  }
  const databasePath = loadConfig({ ...env }).config.databasePath;
  if (!existsSync(databasePath)) {
    return [];
  }
  const db = openDatabase(databasePath);
  try {
    if (!hasPiInteractionsTable(db)) {
      return [];
    }
    return listCodexPending(db);
  } finally {
    db.close();
  }
}

function hasPiInteractionsTable(db: ReturnType<typeof openDatabase>): boolean {
  const row = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'pi_interactions'",
    )
    .get() as { present?: number } | undefined;
  return row?.present === 1;
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
