export type AgentSessionKind = "id" | "path";

/** Everything known about a completion at capture time, before persistence. */
export interface CaptureInput {
  capturedAtMs: number;
  workspaceId: string | null;
  workspaceName: string | null;
  tabId: string | null;
  paneId: string;
  paneName: string | null;
  agentName: string | null;
  agentKind: string | null;
  agentSessionKind: AgentSessionKind | null;
  agentSessionValue: string | null;
  captureSource: string;
  captureLineCount: number;
  rawText: string;
}

/** A persisted completion snapshot. */
export interface HarvestResult extends CaptureInput {
  id: string;
  contentHash: string;
  dedupKey: string;
  readAtMs: number | null;
  archivedAtMs: number | null;
}

export function preview(rawText: string, maxChars = 120): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (limit === 0) {
    return "";
  }

  const lines = rawText
    .split(/\r\n?|\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return "";
  }

  const tail: string[] = [];
  let tailLength = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }

    const lengthWithSeparator = tail.length === 0 ? line.length : line.length + 1;
    if (tailLength + lengthWithSeparator > limit) {
      break;
    }

    tail.unshift(line);
    tailLength += lengthWithSeparator;
  }

  const ellipsis = "…";
  const bodyLength = Math.max(0, limit - ellipsis.length);
  if (tail.length === 0) {
    const lastLine = lines[lines.length - 1] ?? "";
    return `${lastLine.slice(0, bodyLength)}${ellipsis}`;
  }

  const text = tail.join(" ");
  if (tail.length === lines.length && text.length <= limit) {
    return text;
  }

  return `${text.slice(0, bodyLength)}${ellipsis}`;
}
