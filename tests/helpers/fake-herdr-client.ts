import type { HerdrClient, HerdrReadOptions, HerdrTargetInfo } from "../../src/herdr/types.ts";

export type FakeResponse<T> = { kind: "value"; value: T } | { kind: "throw"; error: unknown };

export type FakeHerdrCall =
  | { method: "getAgent"; target: string }
  | { method: "getPane"; paneId: string }
  | { method: "readAgent"; target: string; options: HerdrReadOptions }
  | { method: "readPane"; paneId: string; options: HerdrReadOptions }
  | { method: "getWorkspaceName"; workspaceId: string };

export interface FakeHerdrClientOptions {
  getAgent?: FakeResponse<HerdrTargetInfo | null>;
  getPane?: FakeResponse<HerdrTargetInfo | null>;
  readAgent?: FakeResponse<string>;
  readPane?: FakeResponse<string>;
  getWorkspaceName?: FakeResponse<string | null>;
}

export function value<T>(response: T): FakeResponse<T> {
  return { kind: "value", value: response };
}

export function throwing<T = never>(error: unknown): FakeResponse<T> {
  return { kind: "throw", error };
}

export class FakeHerdrClient implements HerdrClient {
  readonly calls: FakeHerdrCall[] = [];
  getAgentResponse: FakeResponse<HerdrTargetInfo | null>;
  getPaneResponse: FakeResponse<HerdrTargetInfo | null>;
  readAgentResponse: FakeResponse<string>;
  readPaneResponse: FakeResponse<string>;
  getWorkspaceNameResponse: FakeResponse<string | null>;

  constructor(options: FakeHerdrClientOptions = {}) {
    this.getAgentResponse = options.getAgent ?? value(null);
    this.getPaneResponse = options.getPane ?? value(null);
    this.readAgentResponse = options.readAgent ?? value("");
    this.readPaneResponse = options.readPane ?? value("");
    this.getWorkspaceNameResponse = options.getWorkspaceName ?? value(null);
  }

  async getAgent(target: string): Promise<HerdrTargetInfo | null> {
    this.calls.push({ method: "getAgent", target });
    return resolve(this.getAgentResponse);
  }

  async getPane(paneId: string): Promise<HerdrTargetInfo | null> {
    this.calls.push({ method: "getPane", paneId });
    return resolve(this.getPaneResponse);
  }

  async readAgent(target: string, options: HerdrReadOptions): Promise<string> {
    this.calls.push({ method: "readAgent", target, options: { ...options } });
    return resolve(this.readAgentResponse);
  }

  async readPane(paneId: string, options: HerdrReadOptions): Promise<string> {
    this.calls.push({ method: "readPane", paneId, options: { ...options } });
    return resolve(this.readPaneResponse);
  }

  async getWorkspaceName(workspaceId: string): Promise<string | null> {
    this.calls.push({ method: "getWorkspaceName", workspaceId });
    return resolve(this.getWorkspaceNameResponse);
  }
}

async function resolve<T>(response: FakeResponse<T>): Promise<T> {
  if (response.kind === "throw") {
    throw response.error;
  }
  return response.value;
}
