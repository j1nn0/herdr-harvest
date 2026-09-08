import { HerdrEnvError, readPluginEvent } from "@j1nn0/herdr-plugin-sdk";
import { decideCompletion } from "../capture/completion.ts";
import type { CaptureOutcome } from "../capture/orchestrator.ts";
import { runCapture } from "../capture/runner.ts";

export async function runHook(): Promise<number> {
  let event: ReturnType<typeof readPluginEvent>;
  try {
    event = readPluginEvent(process.env);
  } catch (error) {
    if (error instanceof HerdrEnvError) {
      process.stderr.write(`${error.message}\n`);
      return 0;
    }
    throw error;
  }

  if (event === null) {
    process.stderr.write("missing HERDR_PLUGIN_EVENT_JSON\n");
    return 0;
  }

  const decision = decideCompletion(event);
  if (decision.kind === "ignored") {
    return 0;
  }

  const { outcome, warnings } = await runCapture(decision.paneId, process.env, {
    workspaceIdHint: decision.workspaceId,
    agentKindHint: decision.agentKind,
  });
  writeWarnings(warnings);
  writeSummary(decision.paneId, outcome);
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
