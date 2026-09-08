import type { Agent, Pane } from "@j1nn0/herdr-plugin-sdk";
import type { AgentSessionRef, HerdrTargetInfo } from "./types.ts";

export function agentTargetInfo(agent: Agent): HerdrTargetInfo {
  return {
    paneId: agent.pane_id,
    tabId: agent.tab_id,
    workspaceId: agent.workspace_id,
    agentName: agent.name ?? null,
    agentKind: agent.agent ?? null,
    agentStatus: agent.agent_status,
    paneName: agent.terminal_title_stripped ?? null,
    session: agentSessionRef(agent.agent_session),
  };
}

export function paneTargetInfo(pane: Pane): HerdrTargetInfo {
  return {
    paneId: pane.pane_id,
    tabId: pane.tab_id,
    workspaceId: pane.workspace_id,
    agentName: null,
    agentKind: pane.agent ?? null,
    agentStatus: pane.agent_status,
    paneName: pane.terminal_title_stripped ?? null,
    session: agentSessionRef(pane.agent_session),
  };
}

function agentSessionRef(agentSession: Agent["agent_session"]): AgentSessionRef | null {
  if (
    agentSession === null ||
    agentSession === undefined ||
    (agentSession.kind !== "id" && agentSession.kind !== "path") ||
    typeof agentSession.value !== "string"
  ) {
    return null;
  }

  return { kind: agentSession.kind, value: agentSession.value };
}
