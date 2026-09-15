import type { ClipboardProvider, CopyReport } from "../clipboard/provider.ts";
import { ClipboardError } from "../clipboard/provider.ts";
import type { OrchestrationRole } from "../domain/orchestration.ts";
import type { AgentSessionKind, HarvestResult } from "../domain/result.ts";
import { preview as makePreview } from "../domain/result.ts";
import type { ResultStore } from "../persistence/result-store.ts";
import { isSearchQueryActive, matchesResultSearch } from "./result-search.ts";
import { sessionShortId } from "./session-label.ts";

export interface InboxItem {
  id: string;
  agentLabel: string;
  sessionShortId: string;
  agentSessionKind: AgentSessionKind | null;
  agentSessionValue: string | null;
  orchestrationId: string | null;
  orchestrationLabel: string | null;
  orchestrationRole: OrchestrationRole | null;
  workspaceLabel: string;
  herdrSessionLabel: string | null;
  paneLabel: string;
  capturedAtMs: number;
  preview: string;
  unread: boolean;
  archived: boolean;
}

export interface InboxDetail extends InboxItem {
  rawText: string;
  captureSource: string;
  requestedLineCount: number;
  paneId: string;
}

/** Which collection the inbox lists. Active is the default. */
export type InboxMode = "active" | "archived";

/**
 * What a listing covers. "all" spans both collections in one global order,
 * which the two-collection inbox toggle cannot represent on its own.
 */
export type InboxScope = InboxMode | "all";

/** A scoped, optionally text-filtered inbox listing. */
export interface InboxListOptions {
  /** Collection to list; defaults to "active". */
  mode?: InboxScope;
  /** Literal text filter; blank or omitted lists the whole scope. */
  query?: string;
}

export interface InboxPort {
  /** `list("archived")` is shorthand for `list({ mode: "archived" })`. */
  list(mode?: InboxScope): InboxItem[];
  list(options: InboxListOptions): InboxItem[];
  open(id: string): InboxDetail | null;
  archive(id: string): boolean;
  restore(id: string): boolean;
  copy(id: string): Promise<CopyReport>;
}

export function createInboxService(deps: {
  store: ResultStore;
  clipboard: ClipboardProvider;
  now: () => number;
}): InboxPort {
  return {
    list: (request?: InboxScope | InboxListOptions) => listResults(deps.store, request),
    open: (id) => openResult(deps.store, id, deps.now),
    archive: (id) => archiveResult(deps.store, id, deps.now),
    restore: (id) => restoreResult(deps.store, id),
    copy: (id) => copyResult(deps.store, deps.clipboard, id),
  };
}

function listResults(
  store: ResultStore,
  request: InboxScope | InboxListOptions | undefined,
): InboxItem[] {
  const { scope, query } = resolveListRequest(request);
  const ordered = orderedResults(store, scope);
  const matched = isSearchQueryActive(query)
    ? ordered.filter((result) => matchesResultSearch(result, query))
    : ordered;
  return matched.map(toItem);
}

/** `list("archived")` and `list({ mode: "archived" })` describe the same request. */
function resolveListRequest(request: InboxScope | InboxListOptions | undefined): {
  scope: InboxScope;
  query: string;
} {
  if (request === undefined || typeof request === "string") {
    return { scope: request ?? "active", query: "" };
  }
  return { scope: request.mode ?? "active", query: request.query ?? "" };
}

function orderedResults(store: ResultStore, scope: InboxScope): HarvestResult[] {
  switch (scope) {
    case "active":
      return store.list();
    case "archived":
      return store.listArchived();
    case "all":
      return [...store.list({ includeArchived: true })].sort(compareByCaptureDesc);
  }
}

/**
 * Global order for the "all" scope: newest capture first, then descending id.
 * It is intentionally independent of the unread-first order the active
 * collection uses.
 */
function compareByCaptureDesc(left: HarvestResult, right: HarvestResult): number {
  if (left.capturedAtMs !== right.capturedAtMs) {
    return right.capturedAtMs - left.capturedAtMs;
  }
  if (left.id === right.id) {
    return 0;
  }
  return left.id < right.id ? 1 : -1;
}

function openResult(store: ResultStore, id: string, now: () => number): InboxDetail | null {
  const result = store.get(id);
  if (result === null) {
    return null;
  }

  const markedRead = store.markRead(id, now());
  return toDetail(markedRead ?? result);
}

function archiveResult(store: ResultStore, id: string, now: () => number): boolean {
  const result = store.get(id);
  if (result === null || result.archivedAtMs !== null) {
    return false;
  }
  return store.archive(id, now()) !== null;
}

function restoreResult(store: ResultStore, id: string): boolean {
  const result = store.get(id);
  if (result === null || result.archivedAtMs === null) {
    return false;
  }
  return store.restore(id) !== null;
}

function copyResult(
  store: ResultStore,
  clipboard: ClipboardProvider,
  id: string,
): Promise<CopyReport> {
  const result = store.get(id);
  if (result === null) {
    return Promise.reject(
      new ClipboardError(`Cannot copy unknown result ${id}.`, [`result ${id}: not found`]),
    );
  }
  return clipboard.copy(result.rawText);
}

function toItem(result: HarvestResult): InboxItem {
  return {
    id: result.id,
    agentLabel: result.agentName ?? result.agentKind ?? "unknown agent",
    sessionShortId: sessionShortId(result),
    agentSessionKind: result.agentSessionKind,
    agentSessionValue: result.agentSessionValue,
    orchestrationId: result.orchestrationId,
    orchestrationLabel: result.orchestrationLabel,
    orchestrationRole: result.orchestrationRole,
    workspaceLabel: result.workspaceName ?? result.workspaceId ?? "-",
    herdrSessionLabel: result.herdrSessionLabel ?? result.herdrSessionKey ?? null,
    paneLabel: result.paneName ?? result.paneId,
    capturedAtMs: result.capturedAtMs,
    preview: makePreview(result.rawText),
    unread: result.readAtMs === null,
    archived: result.archivedAtMs !== null,
  };
}

function toDetail(result: HarvestResult): InboxDetail {
  return {
    ...toItem(result),
    rawText: result.rawText,
    captureSource: result.captureSource,
    requestedLineCount: result.requestedLineCount,
    paneId: result.paneId,
  };
}
