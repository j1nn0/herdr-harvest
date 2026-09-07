export type DecodedEvent =
  | { kind: "completion"; paneId: string; workspaceId: string | null; agentKind: string | null }
  | { kind: "ignored"; reason: string }
  | { kind: "malformed"; reason: string };

type JsonObject = Record<string, unknown>;

export function decodeAgentStatusEvent(raw: string | undefined): DecodedEvent {
  if (raw === undefined || raw.trim().length === 0) {
    return { kind: "malformed", reason: "missing HERDR_PLUGIN_EVENT_JSON" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "malformed", reason: "HERDR_PLUGIN_EVENT_JSON is not valid JSON" };
  }

  if (!isObject(parsed)) {
    return { kind: "malformed", reason: "event payload must be a JSON object" };
  }

  const data = parsed.data;
  if (!isObject(data)) {
    return { kind: "malformed", reason: "event payload is missing an object-valued data field" };
  }

  if (hasOwn(data, "type") && data.type !== "pane_agent_status_changed") {
    return { kind: "ignored", reason: `ignored event type ${String(data.type)}` };
  }

  if (typeof data.agent_status !== "string") {
    return { kind: "malformed", reason: "event data is missing a string agent_status" };
  }

  if (data.agent_status !== "done") {
    return { kind: "ignored", reason: `ignored agent status ${data.agent_status}` };
  }

  if (typeof data.pane_id !== "string" || data.pane_id.length === 0) {
    return { kind: "malformed", reason: "event data is missing a non-empty string pane_id" };
  }

  return {
    kind: "completion",
    paneId: data.pane_id,
    workspaceId: typeof data.workspace_id === "string" ? data.workspace_id : null,
    agentKind: typeof data.agent === "string" ? data.agent : null,
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.hasOwn(object, key);
}
