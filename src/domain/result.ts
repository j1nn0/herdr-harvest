export type AgentSessionKind = "id" | "path";

import type { OrchestrationRole } from "./orchestration.ts";

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
  herdrSessionKey: string | null;
  herdrSessionLabel: string | null;
  captureSource: string;
  /** Number of terminal rows Harvest requested from Herdr, not rows returned. */
  requestedLineCount: number;
  rawText: string;
}

/** A persisted completion snapshot. */
export interface HarvestResult extends CaptureInput {
  id: string;
  contentHash: string;
  dedupKey: string;
  readAtMs: number | null;
  archivedAtMs: number | null;
  /**
   * The explicit orchestration claim recorded with the capture, or null when
   * the result was captured without one. Automatic hooks never infer a claim
   * from pane metadata, so an unclaimed result stays null until an explicit
   * claim arrives, and a recorded claim is never overwritten.
   */
  orchestrationId: string | null;
  orchestrationLabel: string | null;
  orchestrationRole: OrchestrationRole | null;
}

export function preview(rawText: string, maxChars = 120): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (limit === 0) {
    return "";
  }

  const lines = stripTerminalSequences(rawText)
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

    const lengthWithSeparator =
      tail.length === 0 ? codePointLength(line) : codePointLength(line) + 1;
    if (tailLength + lengthWithSeparator > limit) {
      break;
    }

    tail.unshift(line);
    tailLength += lengthWithSeparator;
  }

  const ellipsis = "…";
  const bodyLength = Math.max(0, limit - codePointLength(ellipsis));
  if (tail.length === 0) {
    const lastLine = lines[lines.length - 1] ?? "";
    return `${sliceCodePoints(lastLine, bodyLength)}${ellipsis}`;
  }

  const text = tail.join(" ");
  if (tail.length === lines.length && codePointLength(text) <= limit) {
    return text;
  }

  return `${sliceCodePoints(text, bodyLength)}${ellipsis}`;
}

// biome-ignore lint/complexity/useRegexLiterals: escaped ANSI patterns stay readable as strings.
const ANSI_OSC_SEQUENCE = new RegExp(
  String.raw`(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C|$)|\u009D[\s\S]*?(?:\u0007|\u001B\\|\u009C|$))`,
  "g",
);
// biome-ignore lint/complexity/useRegexLiterals: escaped ANSI patterns stay readable as strings.
const ANSI_CSI_SEQUENCE = new RegExp(String.raw`(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]`, "g");

function stripTerminalSequences(rawText: string): string {
  const withoutAnsi = rawText.replace(ANSI_OSC_SEQUENCE, "").replace(ANSI_CSI_SEQUENCE, "");
  return Array.from(withoutAnsi)
    .filter((character) => !isTerminalControlCharacter(character.codePointAt(0) ?? 0))
    .join("");
}

function isTerminalControlCharacter(codePoint: number): boolean {
  return (
    codePoint <= 0x08 ||
    codePoint === 0x0b ||
    codePoint === 0x0c ||
    (codePoint >= 0x0e && codePoint <= 0x1f) ||
    (codePoint >= 0x7f && codePoint <= 0x9f)
  );
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, end: number): string {
  return Array.from(value).slice(0, end).join("");
}
