import type { PluginEvent } from "@j1nn0/herdr-plugin-sdk";
import { isPaneAgentStatusChanged } from "@j1nn0/herdr-plugin-sdk";

export type CompletionDecision =
  | {
      kind: "completion";
      paneId: string;
      workspaceId: string;
      agentKind: string | null;
      agentStatus: string;
    }
  | { kind: "ignored"; reason: string };

export function decideCompletion(event: PluginEvent): CompletionDecision {
  if (!isPaneAgentStatusChanged(event)) {
    return { kind: "ignored", reason: `ignored event ${event.event}` };
  }

  if (event.data.agent_status !== "done" && event.data.agent_status !== "idle") {
    return { kind: "ignored", reason: `ignored agent status ${event.data.agent_status}` };
  }

  return {
    kind: "completion",
    paneId: event.data.pane_id,
    workspaceId: event.data.workspace_id,
    agentKind: event.data.agent ?? null,
    agentStatus: event.data.agent_status,
  };
}

export function shouldCaptureCompletion(
  candidateStatus: string,
  previousStatus: string | null,
): boolean {
  if (candidateStatus === "done") {
    return previousStatus !== "done";
  }
  if (candidateStatus === "idle") {
    // Do not treat blocked -> idle as completion: a blocked agent may have been cancelled at an approval prompt, and a false Result is worse than missing a rare completion.
    return previousStatus === "working";
  }
  return false;
}
