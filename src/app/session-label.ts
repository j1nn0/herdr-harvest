import { createHash } from "node:crypto";

import type { HarvestResult } from "../domain/result.ts";

const SESSION_SHORT_ID_LENGTH = 6;

/**
 * Derive a compact label for displaying the native agent session in the inbox.
 * This is presentation-only: it is not a result identity and must not affect
 * capture, persistence, or deduplication.
 */
export function sessionShortId(result: HarvestResult): string {
  const { agentSessionKind: kind, agentSessionValue: value } = result;
  if (value !== null && value.length > 0) {
    if (kind === "id") {
      const compact = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
      if (compact.length >= SESSION_SHORT_ID_LENGTH) {
        return compact.slice(0, SESSION_SHORT_ID_LENGTH);
      }
    }

    return hashPrefix(`${kind ?? ""}${value}`);
  }

  return `~${hashComponents([
    result.herdrSessionKey ?? "",
    result.workspaceId ?? "",
    result.paneId,
    result.agentKind ?? "",
  ])}`;
}

function hashPrefix(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, SESSION_SHORT_ID_LENGTH);
}

function hashComponents(components: readonly string[]): string {
  const encoded = components
    .map((component) => `${new TextEncoder().encode(component).byteLength}:${component}`)
    .join("");
  return hashPrefix(encoded);
}
