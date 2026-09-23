import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";

export type OrchestrationHeaderField = "label" | "id" | "count";
export type SessionHeaderField = "role" | "agent" | "session" | "count";
export type ResultField =
  | "unread"
  | "agent"
  | "session"
  | "context"
  | "age"
  | "workspace"
  | "preview";
export type MetadataField =
  | "context"
  | "agent"
  | "session"
  | "workspace"
  | "pane"
  | "herdrSession"
  | "preview";

export interface InboxDisplayConfig {
  readonly orchestrationHeaderFields: readonly OrchestrationHeaderField[];
  readonly sessionHeaderFields: readonly SessionHeaderField[];
  readonly standaloneFields: readonly ResultField[];
  readonly groupedFields: readonly ResultField[];
  readonly metadataFields: readonly MetadataField[];
}

export const DEFAULT_INBOX_DISPLAY_CONFIG: InboxDisplayConfig = {
  orchestrationHeaderFields: ["label"],
  sessionHeaderFields: ["role", "agent", "session"],
  standaloneFields: ["unread", "agent", "session", "context", "preview", "age"],
  groupedFields: ["unread", "context", "preview", "age"],
  metadataFields: [],
};

const DEFAULT_CONFIG_FILE_NAME = "harvest.inbox.json";
const MAX_CONFIG_BYTES = 64 * 1024;
const CONFIG_KEYS = [
  "orchestrationHeaderFields",
  "sessionHeaderFields",
  "standaloneFields",
  "groupedFields",
  "metadataFields",
] as const;

const FIELD_CATALOGS = {
  orchestrationHeaderFields: ["label", "id", "count"],
  sessionHeaderFields: ["role", "agent", "session", "count"],
  standaloneFields: ["unread", "agent", "session", "context", "age", "workspace", "preview"],
  groupedFields: ["unread", "agent", "session", "context", "age", "workspace", "preview"],
  metadataFields: ["context", "agent", "session", "workspace", "pane", "herdrSession", "preview"],
} as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

export function inboxDisplayConfigPath(env: Record<string, string | undefined>): string | null {
  const explicitPath = env.HARVEST_CONFIG_PATH;
  if (explicitPath !== undefined && explicitPath.length > 0) {
    return explicitPath;
  }
  const configDirectory = env.HERDR_PLUGIN_CONFIG_DIR;
  return configDirectory === undefined || configDirectory.length === 0
    ? null
    : join(configDirectory, DEFAULT_CONFIG_FILE_NAME);
}

export function loadInboxDisplayConfig(env: Record<string, string | undefined>): {
  config: InboxDisplayConfig;
  warnings: string[];
} {
  const path = inboxDisplayConfigPath(env);
  if (path === null) {
    return { config: DEFAULT_INBOX_DISPLAY_CONFIG, warnings: [] };
  }

  let document: unknown;
  try {
    document = readJsonFile(path);
  } catch (error) {
    if (isMissingFile(error)) {
      return { config: DEFAULT_INBOX_DISPLAY_CONFIG, warnings: [] };
    }
    return {
      config: DEFAULT_INBOX_DISPLAY_CONFIG,
      warnings: [warning(path, readErrorReason(error))],
    };
  }

  const parsed = parseDisplayConfig(document);
  return parsed.config === null
    ? {
        config: DEFAULT_INBOX_DISPLAY_CONFIG,
        warnings: [warning(path, parsed.reason)],
      }
    : { config: parsed.config, warnings: [] };
}

function readJsonFile(path: string): unknown {
  const fileDescriptor = openSync(path, "r");
  try {
    const size = fstatSync(fileDescriptor).size;
    if (size > MAX_CONFIG_BYTES) {
      throw new Error(`file exceeds ${MAX_CONFIG_BYTES} bytes`);
    }

    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) {
      throw new Error(`file exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    return JSON.parse(buffer.toString("utf8", 0, bytesRead)) as unknown;
  } finally {
    closeSync(fileDescriptor);
  }
}

function parseDisplayConfig(
  document: unknown,
): { config: InboxDisplayConfig; reason?: never } | { config: null; reason: string } {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { config: null, reason: "top-level value must be an object" };
  }

  const input = document as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!CONFIG_KEYS.includes(key as ConfigKey)) {
      return { config: null, reason: `unknown property ${shortValue(key)}` };
    }
  }

  const parsed = { ...DEFAULT_INBOX_DISPLAY_CONFIG } as Record<ConfigKey, readonly string[]>;
  for (const key of CONFIG_KEYS) {
    const value = input[key];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      return { config: null, reason: `${key} must be an array` };
    }
    if (value.some((field) => typeof field !== "string")) {
      return { config: null, reason: `${key} must contain field ids` };
    }

    const catalog = FIELD_CATALOGS[key] as readonly string[];
    const fields = value as string[];
    if (
      fields.some((field) => !catalog.includes(field)) ||
      new Set(fields).size !== fields.length
    ) {
      const unknownField = fields.find((field) => !catalog.includes(field));
      return {
        config: null,
        reason:
          unknownField === undefined
            ? `${key} contains duplicate field ids`
            : `${key} contains unknown field ${shortValue(unknownField)}`,
      };
    }
    if (key !== "metadataFields" && fields.length === 0) {
      return { config: null, reason: `${key} must not be empty` };
    }
    parsed[key] = fields;
  }

  return { config: parsed as InboxDisplayConfig };
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function readErrorReason(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message.split("\n", 1)[0]?.slice(0, 160) ?? "could not read file";
  }
  return "could not read or parse file";
}

function warning(path: string, reason: string): string {
  return `Invalid inbox display config at ${path}: ${reason}; using defaults.`;
}

function shortValue(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}
