import type { CaptureOutcome } from "../capture/orchestrator.ts";
import { runCapture } from "../capture/runner.ts";
import { decodeAgentStatusEvent } from "../events/decode.ts";

export async function runHook(): Promise<number> {
  const event = decodeAgentStatusEvent(process.env.HERDR_PLUGIN_EVENT_JSON);
  if (event.kind === "ignored") {
    return 0;
  }
  if (event.kind === "malformed") {
    process.stderr.write(`${event.reason}\n`);
    return 0;
  }

  const { outcome, warnings } = await runCapture(event.paneId, process.env, {
    workspaceIdHint: event.workspaceId,
    agentKindHint: event.agentKind,
  });
  writeWarnings(warnings);
  writeSummary(event.paneId, outcome);
  return outcome.status === "failed" ? 1 : 0;
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

try {
  process.exitCode = await runHook();
} catch (error) {
  process.stderr.write(`Harvest hook failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
