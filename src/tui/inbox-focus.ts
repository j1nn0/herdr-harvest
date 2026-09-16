import type { InboxDisplayRow, OrchestrationHeader, ResultRow } from "../app/inbox-groups.ts";
import type { InboxItem } from "../app/inbox-service.ts";

export type InboxFocus =
  | { kind: "result"; resultId: string }
  | { kind: "orchestration"; orchestrationId: string };

export function visibleInboxRows(
  rows: readonly InboxDisplayRow[],
  collapsedOrchestrations: ReadonlySet<string>,
  searchApplied: boolean,
): InboxDisplayRow[] {
  if (searchApplied || collapsedOrchestrations.size === 0) {
    return rows.slice();
  }

  const visible: InboxDisplayRow[] = [];
  let collapsed = false;
  for (const row of rows) {
    if (row.kind === "orchestration") {
      collapsed = collapsedOrchestrations.has(row.orchestrationId);
      visible.push(row);
      continue;
    }
    if (row.kind === "agent-session") {
      visible.push(row);
      continue;
    }
    if (row.item.orchestrationId === null || !collapsed) {
      visible.push(row);
    }
  }
  return visible;
}

export function focusAfterVisualMove(
  items: readonly InboxItem[],
  rows: readonly InboxDisplayRow[],
  focus: InboxFocus | null,
  cursor: number,
  delta: number,
): InboxFocus | null {
  const focusable = focusableRows(rows);
  if (focusable.length === 0) {
    return null;
  }

  const current = reconcileInboxFocus(items, rows, focus, cursor);
  const currentIndex = current === null ? 0 : focusIndex(focusable, current);
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0;
  const destinationIndex = Math.min(Math.max(0, currentIndex + step), focusable.length - 1);
  return focusFromRow(focusable[destinationIndex]);
}

export function reconcileInboxFocus(
  items: readonly InboxItem[],
  rows: readonly InboxDisplayRow[],
  focus: InboxFocus | null,
  cursor: number,
): InboxFocus | null {
  const focusable = focusableRows(rows);
  if (focusable.length === 0) {
    return null;
  }

  if (focus === null) {
    const firstResult = focusable.find((row) => row.kind === "result");
    return focusFromRow(firstResult ?? focusable[0]);
  }

  if (focusIndex(focusable, focus) >= 0) {
    return focus;
  }

  if (focus?.kind === "result") {
    const item = items.find((candidate) => candidate.id === focus.resultId);
    if (item?.orchestrationId !== null && item?.orchestrationId !== undefined) {
      const groupFocus: InboxFocus = {
        kind: "orchestration",
        orchestrationId: item.orchestrationId,
      };
      if (focusIndex(focusable, groupFocus) >= 0) {
        return groupFocus;
      }
    }
  }

  const anchor = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
  let nearest: InboxFocus | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of focusable) {
    const candidateFocus = focusFromRow(candidate);
    if (candidateFocus === null) {
      continue;
    }
    const candidateIndex = itemIndexForFocus(items, candidateFocus);
    const distance = Math.abs(candidateIndex - anchor);
    if (distance < nearestDistance) {
      nearest = candidateFocus;
      nearestDistance = distance;
    }
  }
  return nearest ?? focusFromRow(focusable[0]);
}

export function cursorForFocus(
  items: readonly InboxItem[],
  focus: InboxFocus | null,
  fallbackCursor = 0,
): number {
  if (focus?.kind === "result") {
    const index = items.findIndex((item) => item.id === focus.resultId);
    if (index >= 0) {
      return index;
    }
  }
  if (items.length === 0) {
    return 0;
  }
  return Math.min(Math.max(0, Math.trunc(fallbackCursor)), items.length - 1);
}

export function itemForFocus(
  items: readonly InboxItem[],
  focus: InboxFocus | null,
): InboxItem | undefined {
  return focus?.kind === "result" ? items.find((item) => item.id === focus.resultId) : undefined;
}

export function displayRowIndexForFocus(
  rows: readonly InboxDisplayRow[],
  focus: InboxFocus | null,
): number {
  if (focus !== null) {
    const index = rows.findIndex((row) =>
      focus.kind === "result"
        ? row.kind === "result" && row.item.id === focus.resultId
        : row.kind === "orchestration" && row.orchestrationId === focus.orchestrationId,
    );
    if (index >= 0) {
      return index;
    }
  }
  return rows.findIndex((row) => row.kind === "result");
}

function focusableRows(rows: readonly InboxDisplayRow[]): (OrchestrationHeader | ResultRow)[] {
  return rows.filter(
    (row): row is OrchestrationHeader | ResultRow =>
      row.kind === "orchestration" || row.kind === "result",
  );
}

function focusFromRow(row: OrchestrationHeader | ResultRow | undefined): InboxFocus | null {
  if (row === undefined) {
    return null;
  }
  return row.kind === "orchestration"
    ? { kind: "orchestration", orchestrationId: row.orchestrationId }
    : { kind: "result", resultId: row.item.id };
}

function focusIndex(rows: readonly (OrchestrationHeader | ResultRow)[], focus: InboxFocus): number {
  return rows.findIndex((row) =>
    focus.kind === "result"
      ? row.kind === "result" && row.item.id === focus.resultId
      : row.kind === "orchestration" && row.orchestrationId === focus.orchestrationId,
  );
}

function itemIndexForFocus(items: readonly InboxItem[], focus: InboxFocus): number {
  if (focus.kind === "result") {
    const index = items.findIndex((item) => item.id === focus.resultId);
    return index >= 0 ? index : items.length;
  }
  const index = items.findIndex((item) => item.orchestrationId === focus.orchestrationId);
  return index >= 0 ? index : items.length;
}
