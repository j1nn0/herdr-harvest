import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentSessionRef, HerdrClient, HerdrReadOptions, HerdrTargetInfo } from "./types.ts";
import { HerdrCliError } from "./types.ts";

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 10_000;
const CLI_MAX_BUFFER = 32 * 1024 * 1024;

type JsonObject = Record<string, unknown>;

type CliClientOptions = {
  binPath?: string;
  env?: NodeJS.ProcessEnv;
};

export function parseTargetInfo(stdout: string, key: "agent" | "pane"): HerdrTargetInfo | null {
  const payload = parseJsonObject(stdout, `${key} get`);
  const cliError = parseCliError(payload);
  if (cliError !== null) {
    if (cliError.code === `${key}_not_found`) {
      return null;
    }
    throw cliError;
  }

  const result = payload.result;
  if (!isObject(result) || !isObject(result[key])) {
    throw invalidResponse(`${key} get`, `missing result.${key}`);
  }

  const target = result[key];
  const paneId = stringValue(target.pane_id);
  if (paneId === null || paneId.length === 0) {
    throw invalidResponse(`${key} get`, "missing result pane_id");
  }

  return {
    paneId,
    tabId: stringValue(target.tab_id),
    workspaceId: stringValue(target.workspace_id),
    agentName: key === "agent" ? stringValue(target.name) : null,
    agentKind: stringValue(target.agent),
    agentStatus: stringValue(target.agent_status),
    paneName: stringValue(target.terminal_title_stripped),
    session: parseSession(target.agent_session),
  };
}

export function parseReadOutput(stdout: string): string {
  const parsed = tryParseJson(stdout);
  if (isObject(parsed) && hasOwn(parsed, "error") && hasOwn(parsed, "id")) {
    const cliError = parseCliError(parsed);
    throw cliError ?? invalidResponse("read", "invalid error response");
  }

  return stdout;
}

export function parseWorkspaceLabel(stdout: string, workspaceId: string): string | null {
  const payload = parseJsonObject(stdout, "workspace list");
  const cliError = parseCliError(payload);
  if (cliError !== null) {
    throw cliError;
  }

  const result = payload.result;
  if (!isObject(result) || !Array.isArray(result.workspaces)) {
    throw invalidResponse("workspace list", "missing result.workspaces");
  }

  for (const workspace of result.workspaces) {
    if (!isObject(workspace) || workspace.workspace_id !== workspaceId) {
      continue;
    }
    return stringValue(workspace.label);
  }

  return null;
}

export function createCliHerdrClient(options: CliClientOptions = {}): HerdrClient {
  const env = options.env ?? process.env;
  const binPath = options.binPath ?? env.HERDR_BIN_PATH ?? "herdr";

  const run = (args: readonly string[]): Promise<string> => runCli(binPath, args, env);

  return {
    async getAgent(target) {
      return parseTargetInfo(await run(["agent", "get", target]), "agent");
    },
    async getPane(paneId) {
      return parseTargetInfo(await run(["pane", "get", paneId]), "pane");
    },
    async readAgent(target, readOptions) {
      return parseReadOutput(await runRead(run, ["agent", "read", target], readOptions));
    },
    async readPane(paneId, readOptions) {
      return parseReadOutput(await runRead(run, ["pane", "read", paneId], readOptions));
    },
    async getWorkspaceName(workspaceId) {
      return parseWorkspaceLabel(await run(["workspace", "list"]), workspaceId);
    },
  };
}

async function runRead(
  run: (args: readonly string[]) => Promise<string>,
  command: readonly string[],
  options: HerdrReadOptions,
): Promise<string> {
  return run([...command, "--source", options.source, "--lines", String(options.lines)]);
}

async function runCli(
  binPath: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binPath, [...args], {
      env,
      encoding: "utf8",
      maxBuffer: CLI_MAX_BUFFER,
      timeout: CLI_TIMEOUT_MS,
    });

    if (typeof stdout === "string") {
      return stdout;
    }
    return String(stdout ?? "");
  } catch (error) {
    if (error instanceof HerdrCliError) {
      throw error;
    }

    const code = errorCode(error);
    throw new HerdrCliError(code, errorMessage(error));
  }
}

function parseJsonObject(stdout: string, operation: string): JsonObject {
  const parsed = tryParseJson(stdout);
  if (!isObject(parsed)) {
    throw invalidResponse(operation, "expected a JSON object");
  }
  return parsed;
}

function tryParseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return undefined;
  }
}

function parseCliError(payload: JsonObject): HerdrCliError | null {
  if (!hasOwn(payload, "error") || !hasOwn(payload, "id")) {
    return null;
  }

  if (!isObject(payload.error)) {
    return new HerdrCliError("cli_error", "Herdr returned an invalid error response.");
  }

  const code = stringValue(payload.error.code) ?? "cli_error";
  const message = stringValue(payload.error.message) ?? `Herdr returned ${code}.`;
  return new HerdrCliError(code, message);
}

function parseSession(value: unknown): AgentSessionRef | null {
  if (!isObject(value)) {
    return null;
  }

  const kind = value.kind;
  const sessionValue = stringValue(value.value);
  if ((kind !== "id" && kind !== "path") || sessionValue === null) {
    return null;
  }

  return { kind, value: sessionValue };
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function invalidResponse(operation: string, detail: string): HerdrCliError {
  return new HerdrCliError("invalid_response", `Invalid ${operation} response: ${detail}.`);
}

function errorCode(error: unknown): string {
  if (isObject(error) && typeof error.code === "string" && error.code.length > 0) {
    return error.code;
  }
  if (isObject(error) && typeof error.code === "number") {
    return `exit_${error.code}`;
  }
  return "cli_error";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return "Herdr CLI command failed.";
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}
