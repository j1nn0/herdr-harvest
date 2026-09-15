import type { HarvestResult } from "../domain/result.ts";
import { preview as makePreview } from "../domain/result.ts";
import { sessionShortId } from "./session-label.ts";

/**
 * Result search is a literal substring match: `%`, `_`, `*`, `[`, and `\` are
 * ordinary characters, and a query is never ranked. Nothing here reaches SQL, so
 * no `LIKE` escaping is involved.
 *
 * Comparison runs over Unicode NFC forms with ASCII case folding (`toLowerCase`).
 * That keeps Japanese text and easy ASCII queries working without claiming
 * locale-aware case folding, width folding, or kana folding. Normalized text
 * exists only for comparison: stored content is never rewritten.
 */

/** True when a query carries something to match. Blank queries filter nothing. */
export function isSearchQueryActive(query: string): boolean {
  return query.trim().length > 0;
}

/** Whether any searchable field of one result contains the query literally. */
export function matchesResultSearch(result: HarvestResult, query: string): boolean {
  if (!isSearchQueryActive(query)) {
    return true;
  }

  const needle = comparisonForm(query);
  return searchableFields(result).some((field) => comparisonForm(field).includes(needle));
}

/**
 * Fields a query can match: the captured text, the preview the inbox shows, and
 * the identifiers a row exposes. Derived labels are covered through the values
 * they are derived from, and display-only fallbacks ("unknown agent", "-") are
 * deliberately absent so a missing field cannot match every sparse result.
 */
function searchableFields(result: HarvestResult): string[] {
  return [
    result.rawText,
    makePreview(result.rawText),
    result.agentName,
    result.agentKind,
    result.workspaceName,
    result.workspaceId,
    result.paneName,
    result.paneId,
    result.herdrSessionLabel,
    result.herdrSessionKey,
    result.agentSessionValue,
    sessionShortId(result),
    result.captureSource,
    result.orchestrationId,
    result.orchestrationLabel,
    result.orchestrationRole,
  ].filter((field): field is string => field !== null);
}

function comparisonForm(value: string): string {
  return value.normalize("NFC").toLowerCase();
}
