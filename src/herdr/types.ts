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

export interface HerdrReadOptions {
  source: string;
  lines: number;
}

export interface HerdrClient {
  getAgent(target: string): Promise<HerdrTargetInfo | null>;
  getPane(paneId: string): Promise<HerdrTargetInfo | null>;
  readAgent(target: string, options: HerdrReadOptions): Promise<string>;
  readPane(paneId: string, options: HerdrReadOptions): Promise<string>;
  getWorkspaceName(workspaceId: string): Promise<string | null>;
}

export class HerdrCliError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "HerdrCliError";
  }
}
