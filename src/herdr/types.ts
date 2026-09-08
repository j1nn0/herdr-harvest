import type { AgentSessionKind } from "../domain/result.ts";

export interface AgentSessionRef {
  kind: AgentSessionKind;
  value: string;
}

export interface HerdrTargetInfo {
  paneId: string;
  tabId: string | null;
  workspaceId: string | null;
  agentName: string | null;
  agentKind: string | null;
  agentStatus: string | null;
  paneName: string | null;
  session: AgentSessionRef | null;
}
