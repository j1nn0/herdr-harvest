import type { CaptureOutcome } from "../capture/orchestrator.ts";
import { runCapture } from "../capture/runner.ts";

type JsonObject = Record<string, unknown>;
type PaneResolution = { paneId: string } | { error: string };

const USAGE = "Usage: node src/bin/capture.ts [--pane <pane-id>]";

export function resolvePaneId(args: readonly string[], env: NodeJS.ProcessEnv): PaneResolution {
  if (args.length > 0) {
    if (args[0] !== "--pane" || args.length !== 2) {
      return { error: `Invalid arguments. ${USAGE}` };
    }

    const paneId = args[1];
    if (!isNonEmptyString(paneId)) {
      return { error: `The --pane option requires a pane id. ${USAGE}` };
    }
    return { paneId };
  }

  const contextPaneId = focusedPaneId(env.HERDR_PLUGIN_CONTEXT_JSON);
  if (contextPaneId !== null) {
    return { paneId: contextPaneId };
  }

  const environmentPaneId = env.HERDR_PANE_ID;
  if (isNonEmptyString(environmentPaneId)) {
    return { paneId: environmentPaneId };
  }

  return { error: `No pane id was provided. ${USAGE}` };
}

export async function runManualCapture(): Promise<number> {
  const resolution = resolvePaneId(process.argv.slice(2), process.env);
  if ("error" in resolution) {
    process.stderr.write(`${resolution.error}\n`);
    return 2;
  }

  const { outcome, warnings } = await runCapture(resolution.paneId, process.env);
  writeWarnings(warnings);
  writeSummary(resolution.paneId, outcome);
  return outcome.status === "failed" ? 1 : 0;
}

function focusedPaneId(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isObject(parsed) || !isNonEmptyString(parsed.focused_pane_id)) {
    return null;
  }
  return parsed.focused_pane_id;
}

function writeWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }
}

function writeSummary(paneId: string, outcome: CaptureOutcome): void {
  const summary: {
    status: CaptureOutcome["status"];
    paneId: string;
    id?: string;
    reason?: string;
  } = {
    status: outcome.status,
    paneId,
  };

  if ("result" in outcome) {
    summary.id = outcome.result.id;
  } else {
    summary.reason = outcome.reason;
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

try {
  process.exitCode = await runManualCapture();
} catch (error) {
  process.stderr.write(`Harvest capture failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
