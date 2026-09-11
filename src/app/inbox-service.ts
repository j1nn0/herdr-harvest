import type { ClipboardProvider, CopyReport } from "../clipboard/provider.ts";
import { ClipboardError } from "../clipboard/provider.ts";
import type { HarvestResult } from "../domain/result.ts";
import { preview as makePreview } from "../domain/result.ts";
import type { ResultStore } from "../persistence/result-store.ts";
import { sessionShortId } from "./session-label.ts";

export interface InboxItem {
  id: string;
  agentLabel: string;
  sessionShortId: string;
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
  captureLineCount: number;
  paneId: string;
}

export interface InboxPort {
  list(): InboxItem[];
  open(id: string): InboxDetail | null;
  archive(id: string): boolean;
  copy(id: string): Promise<CopyReport>;
}

export function createInboxService(deps: {
  store: ResultStore;
  clipboard: ClipboardProvider;
  now: () => number;
}): InboxPort {
  return {
    list: () => deps.store.list().map(toItem),
    open: (id) => openResult(deps.store, id, deps.now),
    archive: (id) => archiveResult(deps.store, id, deps.now),
    copy: (id) => copyResult(deps.store, deps.clipboard, id),
  };
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
    captureLineCount: result.captureLineCount,
    paneId: result.paneId,
  };
}
