import type { HerdrClient, ReadOptions } from "@j1nn0/herdr-plugin-sdk";
import { isHerdrCliError } from "@j1nn0/herdr-plugin-sdk";
import type { HarvestConfig } from "../config/config.ts";
import type { OrchestrationClaim } from "../domain/orchestration.ts";
import type { CaptureInput, HarvestResult } from "../domain/result.ts";
import { getAgentInfo, getPaneInfo } from "../herdr/lookup.ts";
import type { HerdrTargetInfo } from "../herdr/types.ts";
import type { InsertClaimOutcome, ResultStore } from "../persistence/result-store.ts";
import { CaptureReadError } from "./errors.ts";

export type CaptureOutcome =
  | { status: "captured"; result: HarvestResult; orchestration?: OrchestrationCaptureReport }
  | { status: "duplicate"; result: HarvestResult; orchestration?: OrchestrationCaptureReport }
  | {
      status: "conflict";
      result: HarvestResult;
      requestedOrchestrationId: string;
      existingOrchestrationId: string;
    }
  | { status: "skipped"; reason: string }
  | { status: "failed"; reason: string };

/** How an explicitly requested orchestration claim landed on the stored result. */
export type OrchestrationCaptureReport = {
  status: "claimed" | "already_claimed";
  id: string;
};

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
  /**
   * The explicit orchestration claim for this capture. Automatic hooks never
   * set it, so an automatic capture can never invent or overwrite a claim.
   */
  orchestration?: OrchestrationClaim;
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
    const readOptions: ReadOptions = {
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
        const workspaces = await deps.client.workspace.list();
        const workspace = workspaces.find((candidate) => candidate.workspace_id === workspaceId);
        workspaceName = workspace?.label ?? null;
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
      requestedLineCount: deps.config.captureLines,
      rawText,
    };
    const inserted = deps.store.insert(input, request.orchestration);

    if (inserted.status === "inserted") {
      return outcomeFor("captured", inserted.result, inserted.claim);
    }
    return outcomeFor("duplicate", inserted.result, inserted.claim);
  } catch (error) {
    return { status: "failed", reason: `capture failed: ${errorMessage(error)}` };
  }
}

/**
 * Attaches the claim result to a successful capture. A lost race is reported as
 * a conflict instead of a capture, because the stored row now belongs to
 * another orchestration task and this capture must not pretend otherwise.
 */
function outcomeFor(
  kind: "captured" | "duplicate",
  result: HarvestResult,
  claim: InsertClaimOutcome | undefined,
): CaptureOutcome {
  if (claim?.status === "conflict") {
    return {
      status: "conflict",
      result,
      requestedOrchestrationId: claim.requestedOrchestrationId,
      existingOrchestrationId: claim.existingOrchestrationId,
    };
  }

  const orchestration: OrchestrationCaptureReport | undefined =
    claim === undefined ? undefined : { status: claim.status, id: claim.orchestrationId };

  if (kind === "captured") {
    return orchestration === undefined
      ? { status: "captured", result }
      : { status: "captured", result, orchestration };
  }
  return orchestration === undefined
    ? { status: "duplicate", result }
    : { status: "duplicate", result, orchestration };
}

async function resolveMetadata(
  client: HerdrClient,
  request: CaptureRequest,
): Promise<HerdrTargetInfo | null> {
  const agent = await getAgentInfo(client, request.paneId);
  if (agent !== null) {
    return agent;
  }
  return getPaneInfo(client, request.paneId);
}

async function readOutput(
  client: HerdrClient,
  paneId: string,
  options: ReadOptions,
): Promise<string> {
  try {
    return await client.agent.read(paneId, options);
  } catch (agentError) {
    try {
      return await client.pane.read(paneId, options);
    } catch (paneError) {
      throw new CaptureReadError(
        `agent read failed with ${errorMessage(agentError)}; pane read failed with ${errorMessage(paneError)}`,
        { agentError, paneError },
      );
    }
  }
}

function errorMessage(error: unknown): string {
  if (isHerdrCliError(error)) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message.length > 0 ? `${error.name}: ${error.message}` : error.name;
  }
  return String(error);
}
