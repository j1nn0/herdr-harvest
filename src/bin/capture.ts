import { HerdrEnvError, readPluginContext } from "@j1nn0/herdr-plugin-sdk";
import type { CaptureOutcome } from "../capture/orchestrator.ts";
import type { CaptureRunOptions } from "../capture/runner.ts";
import { runCapture } from "../capture/runner.ts";
import type { OrchestrationClaim } from "../domain/orchestration.ts";
import {
  isOrchestrationId,
  isOrchestrationLabel,
  isOrchestrationRole,
  MAX_ORCHESTRATION_LABEL_CODE_POINTS,
  ORCHESTRATION_ROLES,
} from "../domain/orchestration.ts";

type PaneResolution = { paneId: string } | { error: string };

const USAGE =
  "Usage: node src/bin/capture.ts [--pane <pane-id>] [--orchestration-id <uuid> --orchestration-label <label> --orchestration-role <explorer|fixer>]";

const HELP = `Harvest manual capture

Usage:
  node src/bin/capture.ts [--pane <pane-id>] [--orchestration-id <uuid> --orchestration-label <label> --orchestration-role <explorer|fixer>]
  node src/bin/capture.ts --capabilities
  node src/bin/capture.ts --help

Captures the current output of one Herdr pane into the Result Inbox and writes
one JSON summary line on stdout.

Options:
  --pane <pane-id>              Pane to capture. Defaults to the focused pane from
                                the Herdr plugin context, then to HERDR_PANE_ID.
  --orchestration-id <uuid>     Claim the captured result for an orchestration task.
  --orchestration-label <text>  Human-readable task label, up to ${MAX_ORCHESTRATION_LABEL_CODE_POINTS} code points.
  --orchestration-role <role>   One of: ${ORCHESTRATION_ROLES.join(", ")}.
                                All three orchestration options are required together.
  --capabilities                Print the capture protocol JSON and exit.
  --help                        Print this help and exit.

Exit codes:
  0  captured, duplicate, or no-op
  1  capture or runtime failure
  2  invalid arguments
  3  orchestration conflict: the result is already claimed by another task
`;

const CAPABILITIES = JSON.stringify({
  protocol: "harvest-capture",
  protocolVersion: 1,
  features: ["orchestration-claim"],
  roles: ORCHESTRATION_ROLES,
});

type Invocation =
  | { kind: "capture"; paneId: string | null; orchestration: OrchestrationClaim | null }
  | { kind: "capabilities" }
  | { kind: "help" }
  | { kind: "invalid"; message: string };

/**
 * Parses the manual capture command line.
 *
 * `--help` and `--capabilities` are answered before anything else and never
 * touch the environment, the database, or Herdr. A claim is all-or-nothing: a
 * partial or malformed claim is a usage error rather than a capture without the
 * claim the caller asked for.
 */
function parseInvocation(args: readonly string[]): Invocation {
  if (args.includes("--help")) {
    return { kind: "help" };
  }
  if (args.includes("--capabilities")) {
    return { kind: "capabilities" };
  }

  let paneId: string | null = null;
  let orchestrationId: string | null = null;
  let orchestrationLabel: string | null = null;
  let orchestrationRole: string | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    switch (flag) {
      case "--pane":
        if (!isNonEmptyString(value)) {
          return { kind: "invalid", message: `The --pane option requires a pane id. ${USAGE}` };
        }
        paneId = value;
        index += 1;
        break;
      case "--orchestration-id":
        if (value === undefined) {
          return {
            kind: "invalid",
            message: `The --orchestration-id option requires a value. ${USAGE}`,
          };
        }
        orchestrationId = value;
        index += 1;
        break;
      case "--orchestration-label":
        if (value === undefined) {
          return {
            kind: "invalid",
            message: `The --orchestration-label option requires a value. ${USAGE}`,
          };
        }
        orchestrationLabel = value;
        index += 1;
        break;
      case "--orchestration-role":
        if (value === undefined) {
          return {
            kind: "invalid",
            message: `The --orchestration-role option requires a value. ${USAGE}`,
          };
        }
        orchestrationRole = value;
        index += 1;
        break;
      default:
        return { kind: "invalid", message: `Unknown argument ${String(flag)}. ${USAGE}` };
    }
  }

  if (orchestrationId === null && orchestrationLabel === null && orchestrationRole === null) {
    return { kind: "capture", paneId, orchestration: null };
  }
  if (orchestrationId === null || orchestrationLabel === null || orchestrationRole === null) {
    return {
      kind: "invalid",
      message: `An orchestration claim needs --orchestration-id, --orchestration-label, and --orchestration-role together. ${USAGE}`,
    };
  }
  if (!isOrchestrationId(orchestrationId)) {
    return {
      kind: "invalid",
      message: `--orchestration-id must be a canonical lowercase UUIDv4. ${USAGE}`,
    };
  }
  if (!isOrchestrationRole(orchestrationRole)) {
    return {
      kind: "invalid",
      message: `--orchestration-role must be one of ${ORCHESTRATION_ROLES.join(", ")}. ${USAGE}`,
    };
  }
  if (!isOrchestrationLabel(orchestrationLabel)) {
    return {
      kind: "invalid",
      message: `--orchestration-label must be 1-${MAX_ORCHESTRATION_LABEL_CODE_POINTS} non-blank code points. ${USAGE}`,
    };
  }

  return {
    kind: "capture",
    paneId,
    orchestration: { id: orchestrationId, label: orchestrationLabel, role: orchestrationRole },
  };
}

export async function runManualCapture(): Promise<number> {
  const invocation = parseInvocation(process.argv.slice(2));
  if (invocation.kind === "invalid") {
    process.stderr.write(`${invocation.message}\n`);
    return 2;
  }
  if (invocation.kind === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (invocation.kind === "capabilities") {
    process.stdout.write(`${CAPABILITIES}\n`);
    return 0;
  }

  const resolution = resolvePaneId(invocation.paneId, process.env);
  if ("error" in resolution) {
    process.stderr.write(`${resolution.error}\n`);
    return 2;
  }

  const extra: CaptureRunOptions =
    invocation.orchestration === null ? {} : { orchestration: invocation.orchestration };
  const { outcome, warnings } = await runCapture(resolution.paneId, process.env, extra);
  writeWarnings(warnings);
  writeSummary(resolution.paneId, outcome);

  if (outcome.status === "failed") {
    return 1;
  }
  if (outcome.status === "conflict") {
    return 3;
  }
  return 0;
}

function resolvePaneId(paneId: string | null, env: NodeJS.ProcessEnv): PaneResolution {
  if (paneId !== null) {
    return { paneId };
  }

  const contextPaneId = focusedPaneId(env);
  if (contextPaneId !== null) {
    return { paneId: contextPaneId };
  }

  const environmentPaneId = env.HERDR_PANE_ID;
  if (isNonEmptyString(environmentPaneId)) {
    return { paneId: environmentPaneId };
  }

  return { error: `No pane id was provided. ${USAGE}` };
}

function focusedPaneId(env: NodeJS.ProcessEnv): string | null {
  try {
    const paneId = readPluginContext(env).focused_pane_id;
    return isNonEmptyString(paneId) ? paneId : null;
  } catch (error) {
    if (error instanceof HerdrEnvError) {
      return null;
    }
    throw error;
  }
}

function writeWarnings(warnings: readonly string[]): void {
  for (const warning of warnings) {
    process.stderr.write(`${warning}\n`);
  }
}

interface CaptureSummary {
  status: CaptureOutcome["status"];
  paneId: string;
  id?: string;
  reason?: string;
  requestedOrchestrationId?: string;
  existingOrchestrationId?: string;
  orchestration?: { status: string; id: string };
}

function writeSummary(paneId: string, outcome: CaptureOutcome): void {
  const summary: CaptureSummary = {
    status: outcome.status,
    paneId,
  };

  if ("result" in outcome) {
    summary.id = outcome.result.id;
  } else {
    summary.reason = outcome.reason;
  }

  if (outcome.status === "conflict") {
    summary.requestedOrchestrationId = outcome.requestedOrchestrationId;
    summary.existingOrchestrationId = outcome.existingOrchestrationId;
  }

  if (
    (outcome.status === "captured" || outcome.status === "duplicate") &&
    outcome.orchestration !== undefined
  ) {
    summary.orchestration = outcome.orchestration;
  }

  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
