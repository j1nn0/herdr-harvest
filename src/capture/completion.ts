import type { PluginEvent } from "@j1nn0/herdr-plugin-sdk";
import { isPaneAgentStatusChanged } from "@j1nn0/herdr-plugin-sdk";

export type CompletionDecision =
  | { kind: "completion"; paneId: string; workspaceId: string; agentKind: string | null }
  | { kind: "ignored"; reason: string };

export function decideCompletion(event: PluginEvent): CompletionDecision {
  if (!isPaneAgentStatusChanged(event)) {
    return { kind: "ignored", reason: `ignored event ${event.event}` };
  }

  if (event.data.agent_status !== "done") {
    return { kind: "ignored", reason: `ignored agent status ${event.data.agent_status}` };
  }

  return {
    kind: "completion",
    paneId: event.data.pane_id,
    workspaceId: event.data.workspace_id,
    agentKind: event.data.agent ?? null,
  };
}
