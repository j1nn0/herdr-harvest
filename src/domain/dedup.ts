import { createHash } from "node:crypto";

import type { CaptureInput } from "./result.ts";

export function contentHash(rawText: string): string {
  return createHash("sha256").update(rawText, "utf8").digest("hex");
}

export function dedupKey(
  input: Pick<
    CaptureInput,
    | "agentSessionKind"
    | "agentSessionValue"
    | "workspaceId"
    | "paneId"
    | "agentKind"
    | "herdrSessionKey"
  >,
  rawContentHash: string,
): string {
  if (input.agentSessionValue !== null && input.agentSessionValue.length > 0) {
    return hashComponents([
      "v2",
      "session",
      input.herdrSessionKey ?? "",
      input.agentSessionKind ?? "",
      input.agentSessionValue,
      rawContentHash,
    ]);
  }

  return hashComponents([
    "v2",
    "pane",
    input.herdrSessionKey ?? "",
    input.workspaceId ?? "",
    input.paneId,
    input.agentKind ?? "",
    rawContentHash,
  ]);
}

function hashComponents(components: readonly string[]): string {
  // Prefix each component with its UTF-8 byte length so embedded separators cannot forge boundaries.
  const encoded = components
    .map((component) => `${new TextEncoder().encode(component).byteLength}:${component}`)
    .join("");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}
