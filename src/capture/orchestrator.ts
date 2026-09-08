import type { HarvestConfig } from "../config/config.ts";
import type { CaptureInput, HarvestResult } from "../domain/result.ts";
import type { HerdrClient, HerdrTargetInfo } from "../herdr/types.ts";
import { HerdrCliError } from "../herdr/types.ts";
import type { ResultStore } from "../persistence/result-store.ts";

export type CaptureOutcome =
  | { status: "captured"; result: HarvestResult }
  | { status: "duplicate"; result: HarvestResult }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

export interface CaptureDeps {
  client: HerdrClient;
  store: ResultStore;
  config: HarvestConfig;
  now: () => number;
}

export interface CaptureRequest {
  paneId: string;
  workspaceIdHint?: string | null;
  agentKindHint?: string | null;
}

export async function captureCompletion(
  deps: CaptureDeps,
  request: CaptureRequest,
): Promise<CaptureOutcome> {
  try {
    const metadata = await resolveMetadata(deps.client, request);
    if (metadata === null) {
      return { status: "skipped", reason: "pane no longer exists" };
    }

    const workspaceId = metadata.workspaceId ?? request.workspaceIdHint ?? null;
    const agentKind = metadata.agentKind ?? request.agentKindHint ?? null;
    const readOptions = {
      source: deps.config.captureSource,
      lines: deps.config.captureLines,
    };
    const rawText = await readOutput(deps.client, request.paneId, readOptions);
    if (rawText.trim().length === 0) {
      return { status: "skipped", reason: "empty capture" };
    }

    let workspaceName: string | null = null;
    if (workspaceId !== null) {
      try {
        const resolvedName = await deps.client.getWorkspaceName(workspaceId);
        workspaceName = typeof resolvedName === "string" ? resolvedName : null;
      } catch {
        workspaceName = null;
      }
    }

    const input: CaptureInput = {
      capturedAtMs: deps.now(),
      workspaceId,
      workspaceName,
      tabId: metadata.tabId,
      paneId: metadata.paneId,
      paneName: metadata.paneName,
      agentName: metadata.agentName,
      agentKind,
      agentSessionKind: metadata.session?.kind ?? null,
      agentSessionValue: metadata.session?.value ?? null,
      herdrSessionKey: deps.config.herdrSessionKey,
      herdrSessionLabel: deps.config.herdrSessionLabel,
      captureSource: deps.config.captureSource,
      captureLineCount: deps.config.captureLines,
      rawText,
    };
    const inserted = deps.store.insert(input);

    if (inserted.status === "inserted") {
      return { status: "captured", result: inserted.result };
    }
    return { status: "duplicate", result: inserted.result };
  } catch (error) {
    return { status: "failed", reason: `capture failed: ${errorMessage(error)}` };
  }
}

async function resolveMetadata(
  client: HerdrClient,
  request: CaptureRequest,
): Promise<HerdrTargetInfo | null> {
  const agent = await client.getAgent(request.paneId);
  if (agent !== null) {
    return agent;
  }
  return client.getPane(request.paneId);
}

async function readOutput(
  client: HerdrClient,
  paneId: string,
  options: { source: string; lines: number },
): Promise<string> {
  try {
    return await client.readAgent(paneId, options);
  } catch (agentError) {
    const agentCode = errorCode(agentError);
    try {
      return await client.readPane(paneId, options);
    } catch (paneError) {
      throw new HerdrCliError(
        "capture_read_failed",
        `agent read failed with ${agentCode}; pane read failed with ${errorCode(paneError)}`,
      );
    }
  }
}

function errorCode(error: unknown): string {
  if (error instanceof HerdrCliError) {
    return error.code;
  }
  if (error instanceof Error && error.name.length > 0) {
    return error.name;
  }
  return "unknown_error";
}

function errorMessage(error: unknown): string {
  if (error instanceof HerdrCliError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
