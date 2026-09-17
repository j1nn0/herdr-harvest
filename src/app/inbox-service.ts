import type { ClipboardProvider, CopyReport } from "../clipboard/provider.ts";
import { ClipboardError } from "../clipboard/provider.ts";
import type { OrchestrationRole } from "../domain/orchestration.ts";
import type { PiInteraction, PiInteractionStatus } from "../domain/pi-interaction.ts";
import type { AgentSessionKind, HarvestResult } from "../domain/result.ts";
import { preview as makePreview } from "../domain/result.ts";
import type { ResultStore } from "../persistence/result-store.ts";
import { isSearchQueryActive, matchesResultSearch } from "./result-search.ts";
import { sessionShortId } from "./session-label.ts";

export interface InboxItem {
  id: string;
  /** Legacy rows predate Pi collection; omitted fixture values are treated as legacy. */
  kind?: "legacy" | "pi" | "codex";
  /** Pi/Codex lifecycle state. Legacy rows do not have an interaction state. */
  status?: PiInteractionStatus;
  /** Failure reason for an incomplete Pi/Codex interaction, when supplied. */
  reason?: string | null;
  submittedPrompt?: string;
  effectivePrompt?: string | null;
  finalReport?: string | null;
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

export type InboxCopyField = "prompt" | "finalReport";

/** Read-only source used by the inbox; persistence remains owned by C1. */
export interface PiInteractionSource {
  list(): PiInteraction[];
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
  copy(id: string, field?: InboxCopyField): Promise<CopyReport>;
}

export function createInboxService(deps: {
  store: ResultStore;
  clipboard: ClipboardProvider;
  now: () => number;
  piStore?: PiInteractionSource;
}): InboxPort {
  return {
    list: (request?: InboxScope | InboxListOptions) =>
      listResults(deps.store, deps.piStore, request),
    open: (id) => openResult(deps.store, deps.piStore, id, deps.now),
    archive: (id) => archiveResult(deps.store, deps.piStore, id, deps.now),
    restore: (id) => restoreResult(deps.store, deps.piStore, id),
    copy: (id, field) => copyResult(deps.store, deps.piStore, deps.clipboard, id, field),
  };
}

function listResults(
  store: ResultStore,
  piStore: PiInteractionSource | undefined,
  request: InboxScope | InboxListOptions | undefined,
): InboxItem[] {
  const { scope, query } = resolveListRequest(request);
  const legacyResults = orderedResults(store, scope);
  const legacyItems = isSearchQueryActive(query)
    ? legacyResults.filter((result) => matchesResultSearch(result, query)).map(toItem)
    : legacyResults.map(toItem);
  const piItems = (scope === "archived" ? [] : (piStore?.list() ?? []))
    .filter(isTerminalInteraction)
    .map(toInteractionItem)
    .filter((item) => !isSearchQueryActive(query) || matchesInboxSearch(item, query));
  const items =
    scope === "all" ? orderAllItems([...legacyItems, ...piItems]) : [...legacyItems, ...piItems];
  return items;
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

function orderAllItems(items: InboxItem[]): InboxItem[] {
  return items.sort((left, right) => {
    if (left.capturedAtMs !== right.capturedAtMs) {
      return right.capturedAtMs - left.capturedAtMs;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? 1 : -1;
  });
}

function openResult(
  store: ResultStore,
  piStore: PiInteractionSource | undefined,
  id: string,
  now: () => number,
): InboxDetail | null {
  const piInteraction = findPiInteraction(piStore, id);
  if (piInteraction !== null) {
    return toInteractionDetail(piInteraction);
  }

  const result = store.get(id);
  if (result === null) {
    return null;
  }

  const markedRead = store.markRead(id, now());
  return toDetail(markedRead ?? result);
}

function archiveResult(
  store: ResultStore,
  piStore: PiInteractionSource | undefined,
  id: string,
  now: () => number,
): boolean {
  if (findPiInteraction(piStore, id) !== null) {
    return false;
  }
  const result = store.get(id);
  if (result === null || result.archivedAtMs !== null) {
    return false;
  }
  return store.archive(id, now()) !== null;
}

function restoreResult(
  store: ResultStore,
  piStore: PiInteractionSource | undefined,
  id: string,
): boolean {
  if (findPiInteraction(piStore, id) !== null) {
    return false;
  }
  const result = store.get(id);
  if (result === null || result.archivedAtMs === null) {
    return false;
  }
  return store.restore(id) !== null;
}

function copyResult(
  store: ResultStore,
  piStore: PiInteractionSource | undefined,
  clipboard: ClipboardProvider,
  id: string,
  field: InboxCopyField | undefined,
): Promise<CopyReport> {
  const piInteraction = findPiInteraction(piStore, id);
  if (piInteraction !== null) {
    return isCodexInteraction(piInteraction)
      ? copyCodexInteraction(clipboard, piInteraction, field)
      : copyPiInteraction(clipboard, piInteraction, field);
  }

  if (field !== undefined) {
    return Promise.reject(
      new ClipboardError(`Cannot copy ${field} from legacy result ${id}.`, [
        `result ${id}: Pi fields are unavailable for legacy results`,
      ]),
    );
  }

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
    kind: "legacy",
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

function toPiItem(interaction: PiInteraction): InboxItem {
  const previewSource = interaction.finalReport ?? interaction.submittedPrompt;
  return {
    id: interaction.interactionId,
    kind: "pi",
    status: interaction.status,
    reason: interaction.reason,
    submittedPrompt: interaction.submittedPrompt,
    effectivePrompt: interaction.effectivePrompt,
    finalReport: interaction.finalReport,
    agentLabel: "Pi",
    sessionShortId: shortSessionId(interaction.sessionId),
    agentSessionKind: "id",
    agentSessionValue: interaction.sessionId,
    orchestrationId: null,
    orchestrationLabel: null,
    orchestrationRole: null,
    workspaceLabel: "Pi",
    herdrSessionLabel: null,
    paneLabel: "Pi interaction",
    capturedAtMs: 0,
    preview: makePreview(previewSource),
    unread: false,
    archived: false,
  };
}

function toPiDetail(interaction: PiInteraction): InboxDetail {
  return {
    ...toPiItem(interaction),
    rawText: "",
    captureSource: interaction.provenance,
    requestedLineCount: 0,
    paneId: "pi",
  };
}

function toCodexItem(interaction: PiInteraction): InboxItem {
  const previewSource = interaction.finalReport ?? interaction.submittedPrompt;
  return {
    id: interaction.interactionId,
    kind: "codex",
    status: interaction.status,
    reason: interaction.reason,
    submittedPrompt: interaction.submittedPrompt,
    effectivePrompt: interaction.effectivePrompt,
    finalReport: interaction.finalReport,
    agentLabel: "Codex",
    sessionShortId: shortSessionId(interaction.sessionId),
    agentSessionKind: "id",
    agentSessionValue: interaction.sessionId,
    orchestrationId: null,
    orchestrationLabel: null,
    orchestrationRole: null,
    workspaceLabel: "Codex",
    herdrSessionLabel: null,
    paneLabel: "Codex interaction",
    capturedAtMs: 0,
    preview: makePreview(previewSource),
    unread: false,
    archived: false,
  };
}

function toCodexDetail(interaction: PiInteraction): InboxDetail {
  return {
    ...toCodexItem(interaction),
    rawText: "",
    captureSource: interaction.provenance,
    requestedLineCount: 0,
    paneId: "codex",
  };
}

function toInteractionItem(interaction: PiInteraction): InboxItem {
  return isCodexInteraction(interaction) ? toCodexItem(interaction) : toPiItem(interaction);
}

function toInteractionDetail(interaction: PiInteraction): InboxDetail {
  return isCodexInteraction(interaction) ? toCodexDetail(interaction) : toPiDetail(interaction);
}

function isCodexInteraction(interaction: PiInteraction): boolean {
  return interaction.provenance === "codex-native-hooks";
}

function isTerminalInteraction(interaction: PiInteraction): boolean {
  return interaction.status === "completed" || interaction.status === "failed";
}

function findPiInteraction(
  piStore: PiInteractionSource | undefined,
  id: string,
): PiInteraction | null {
  return (
    piStore
      ?.list()
      .find(
        (interaction) => isTerminalInteraction(interaction) && interaction.interactionId === id,
      ) ?? null
  );
}

function copyPiInteraction(
  clipboard: ClipboardProvider,
  interaction: PiInteraction,
  field: InboxCopyField | undefined,
): Promise<CopyReport> {
  const selectedField = field ?? (interaction.finalReport === null ? "prompt" : "finalReport");
  if (selectedField === "prompt") {
    return clipboard.copy(interaction.submittedPrompt);
  }
  if (interaction.finalReport === null) {
    return Promise.reject(
      new ClipboardError(`Pi interaction ${interaction.interactionId} has no final report.`, [
        `interaction ${interaction.interactionId}: final report unavailable`,
      ]),
    );
  }
  return clipboard.copy(interaction.finalReport);
}

function copyCodexInteraction(
  clipboard: ClipboardProvider,
  interaction: PiInteraction,
  field: InboxCopyField | undefined,
): Promise<CopyReport> {
  const selectedField = field ?? (interaction.finalReport === null ? "prompt" : "finalReport");
  if (selectedField === "prompt") {
    return clipboard.copy(interaction.submittedPrompt);
  }
  if (interaction.finalReport === null) {
    return Promise.reject(
      new ClipboardError(`Codex interaction ${interaction.interactionId} has no final report.`, [
        `interaction ${interaction.interactionId}: final report unavailable`,
      ]),
    );
  }
  return clipboard.copy(interaction.finalReport);
}

function matchesInboxSearch(item: InboxItem, query: string): boolean {
  const needle = query.normalize("NFC").toLowerCase();
  return [
    item.id,
    item.sessionShortId,
    item.submittedPrompt,
    item.effectivePrompt,
    item.finalReport,
    item.reason,
    item.status,
  ]
    .filter((value): value is string => value !== null && value !== undefined)
    .some((value) => value.normalize("NFC").toLowerCase().includes(needle));
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 6);
}
