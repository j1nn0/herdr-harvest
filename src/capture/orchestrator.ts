import type { HerdrClient, ReadOptions } from "@j1nn0/herdr-plugin-sdk";
import { isHerdrCliError } from "@j1nn0/herdr-plugin-sdk";
import type { HarvestConfig } from "../config/config.ts";
import type { CaptureInput, HarvestResult } from "../domain/result.ts";
import { getAgentInfo, getPaneInfo } from "../herdr/lookup.ts";
import type { HerdrTargetInfo } from "../herdr/types.ts";
import type { ResultStore } from "../persistence/result-store.ts";
import { CaptureReadError } from "./errors.ts";

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
