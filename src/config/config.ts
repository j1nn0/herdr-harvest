import { join } from "node:path";

export interface HarvestConfig {
  captureLines: number;
  captureSource: string;
  databasePath: string;
  herdrSessionKey: string | null;
  herdrSessionLabel: string | null;
}

const DEFAULT_CAPTURE_LINES = 400;
const DEFAULT_CAPTURE_SOURCE = "recent-unwrapped";
const VALID_CAPTURE_SOURCES = new Set(["visible", "recent", "recent-unwrapped", "detection"]);

export function loadConfig(env: Record<string, string | undefined>): {
  config: HarvestConfig;
  warnings: string[];
} {
  const stateDir = env.HARVEST_STATE_DIR ?? env.HERDR_PLUGIN_STATE_DIR;
  if (!stateDir) {
    throw new Error("Missing state directory: set HARVEST_STATE_DIR or HERDR_PLUGIN_STATE_DIR.");
  }

  const warnings: string[] = [];
  const captureLines = parseCaptureLines(env.HARVEST_CAPTURE_LINES, warnings);
  const captureSource = parseCaptureSource(env.HARVEST_CAPTURE_SOURCE, warnings);

  return {
    config: {
      captureLines,
      captureSource,
      databasePath: join(stateDir, "harvest.db"),
      herdrSessionKey: parseHerdrSessionKey(env.HERDR_SOCKET_PATH),
      herdrSessionLabel: parseHerdrSessionLabel(env.HERDR_SOCKET_PATH),
    },
    warnings,
  };
}

function parseCaptureLines(value: string | undefined, warnings: string[]): number {
  if (value === undefined) {
    return DEFAULT_CAPTURE_LINES;
  }

  const trimmed = value.trim();
  const parsed = /^[+-]?\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
    warnings.push(
      `HARVEST_CAPTURE_LINES must be a base-10 integer from 1 to 10000; using ${DEFAULT_CAPTURE_LINES} instead (received ${JSON.stringify(value)}).`,
    );
    return DEFAULT_CAPTURE_LINES;
  }

  return parsed;
}

function parseHerdrSessionKey(value: string | undefined): string | null {
  return value !== undefined && value.trim().length > 0 ? value : null;
}

function parseHerdrSessionLabel(value: string | undefined): string | null {
  if (value === undefined || value.trim().length === 0) {
    return null;
  }

  const segments = value.split(/[\\/]+/);
  if (segments.at(-1) !== "herdr.sock") {
    return null;
  }

  const parent = segments.at(-2);
  if (segments.at(-3) === "sessions") {
    return parent !== undefined && parent.length > 0 ? parent : null;
  }
  if (parent === "sessions") {
    return null;
  }
  return "default";
}

function parseCaptureSource(value: string | undefined, warnings: string[]): string {
  if (value === undefined || VALID_CAPTURE_SOURCES.has(value)) {
    return value ?? DEFAULT_CAPTURE_SOURCE;
  }

  warnings.push(
    `HARVEST_CAPTURE_SOURCE must be one of visible, recent, recent-unwrapped, or detection; using ${DEFAULT_CAPTURE_SOURCE} instead (received ${JSON.stringify(value)}).`,
  );
  return DEFAULT_CAPTURE_SOURCE;
}
