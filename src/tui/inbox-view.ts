import { Box, Text } from "ink";
import React, { type FC } from "react";

import {
  type AgentSessionHeader,
  buildInboxGrouping,
  type InboxDisplayRow,
  type OrchestrationHeader,
} from "../app/inbox-groups.ts";
import type { InboxItem, InboxMode, InboxScope } from "../app/inbox-service.ts";
import {
  DEFAULT_INBOX_DISPLAY_CONFIG,
  type InboxDisplayConfig,
  type MetadataField,
  type OrchestrationHeaderField,
  type ResultField,
  type SessionHeaderField,
} from "../config/inbox-display-config.ts";
import type { InboxFocus } from "./inbox-focus.ts";
import { itemForFocus } from "./inbox-focus.ts";

const h = React.createElement;

export interface StatusMessage {
  text: string;
  error: boolean;
}

/**
 * Search-session view state. `query` is what the visible list was filtered by,
 * while `text` is what the query line shows: the live draft while editing, the
 * applied query otherwise. They differ exactly while the user is typing.
 */
export interface InboxSearchView {
  /** Applied query; blank before the first draft is applied. */
  query: string;
  /** Query-line text. */
  text: string;
  /** Collection the search covers, including "all". */
  scope: InboxScope;
  /** True while the query line is being edited. */
  editing: boolean;
  /** True when an applied query is filtering the list right now. */
  applied: boolean;
}

export interface InboxViewProps {
  items: readonly InboxItem[];
  /** Display rows derived from the same visible item subset. */
  rows?: readonly InboxDisplayRow[];
  cursor: number;
  width: number;
  mode?: InboxMode;
  offset?: number;
  limit?: number;
  status?: StatusMessage | null;
  search?: InboxSearchView;
  displayConfig?: InboxDisplayConfig;
  focus?: InboxFocus | null;
  collapsedOrchestrations?: ReadonlySet<string>;
  onOpen: () => void;
  onCopy: () => void;
  onArchive: () => void;
}

const DEFAULT_INBOX_WIDTH = 80;
const INBOX_HORIZONTAL_PADDING = 2;
const METADATA_MIN_WIDTH = 24;
const AGENT_MIN_DISPLAY_WIDTH = 12;
const ROW_SEPARATOR = "  ";
const NARROW_SEPARATOR = " ";
const NO_SEPARATOR = "";
const ELLIPSIS = "…";
const SEARCH_CURSOR = "_";
const SEARCH_FOOTER = "/ edit · Tab scope · Esc clear · ↑/↓ move · Enter open · y copy";

const DEFAULT_INBOX_ROWS = 24;
/** Chrome Text nodes use wrap="truncate" so each fixed line stays one physical row. */
const INBOX_FIXED_CHROME_LINES = 3;
interface RowField {
  value: string;
  minimumWidth: number;
}

export function inboxViewportLines(
  rows: number | undefined,
  metadataLines: number,
  hasStatus: boolean,
): number {
  const terminalRows =
    rows === undefined || !Number.isFinite(rows) ? DEFAULT_INBOX_ROWS : Math.floor(rows);
  const metadata = Number.isFinite(metadataLines) ? Math.max(0, Math.floor(metadataLines)) : 0;
  return Math.max(1, terminalRows - INBOX_FIXED_CHROME_LINES - metadata - (hasStatus ? 1 : 0));
}

export function clampListOffset(offset: number, itemCount: number, capacity: number): number {
  const normalizedOffset = Number.isFinite(offset) ? Math.floor(offset) : 0;
  const normalizedItemCount = Number.isFinite(itemCount) ? Math.max(0, Math.floor(itemCount)) : 0;
  const normalizedCapacity = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 1;
  const maxOffset = Math.max(0, normalizedItemCount - normalizedCapacity);
  return Math.min(Math.max(0, normalizedOffset), maxOffset);
}

export function listOffsetForCursor(
  cursor: number,
  currentOffset: number,
  capacity: number,
): number {
  const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
  const normalizedOffset = Number.isFinite(currentOffset)
    ? Math.max(0, Math.floor(currentOffset))
    : 0;
  const normalizedCapacity = Number.isFinite(capacity) ? Math.max(1, Math.floor(capacity)) : 1;
  if (normalizedCursor < normalizedOffset) {
    return normalizedCursor;
  }
  if (normalizedCursor >= normalizedOffset + normalizedCapacity) {
    return normalizedCursor - normalizedCapacity + 1;
  }
  return normalizedOffset;
}

/** Map the result cursor onto the physical display row that represents it. */
export function displayRowIndexForCursor(
  rows: readonly InboxDisplayRow[],
  cursor: number,
  items?: readonly InboxItem[],
): number {
  const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0;
  const selectedId = items?.[normalizedCursor]?.id;
  let resultIndex = 0;
  let lastResultRow = 0;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.kind !== "result") {
      continue;
    }
    lastResultRow = rowIndex;
    if (
      (selectedId !== undefined && row.item.id === selectedId) ||
      (selectedId === undefined && resultIndex === normalizedCursor)
    ) {
      return rowIndex;
    }
    resultIndex += 1;
  }
  return lastResultRow;
}

export const InboxView: FC<InboxViewProps> = ({
  items,
  rows: groupingRows,
  cursor,
  width,
  mode = "active",
  offset = 0,
  limit,
  status = null,
  search,
  displayConfig = DEFAULT_INBOX_DISPLAY_CONFIG,
  focus,
  collapsedOrchestrations = new Set<string>(),
}) => {
  const contentWidth = contentWidthFor(width);
  const displayRows = groupingRows ?? buildInboxGrouping(items);
  const effectiveFocus: InboxFocus | null =
    focus === undefined
      ? items[cursor] === undefined
        ? null
        : { kind: "result", resultId: items[cursor].id }
      : focus;
  const rowOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const rowLimit =
    limit === undefined ? undefined : Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  let currentOrchestrationRole: OrchestrationHeader["orchestrationRole"] = null;
  let currentOrchestrationId: string | null = null;
  const annotatedRows = displayRows.map((row, displayIndex) => {
    if (row.kind === "orchestration") {
      currentOrchestrationRole = row.orchestrationRole;
      currentOrchestrationId = row.orchestrationId;
    }
    return { row, displayIndex, currentOrchestrationRole, currentOrchestrationId };
  });
  const visibleRows =
    rowLimit === undefined
      ? annotatedRows.slice(rowOffset)
      : annotatedRows.slice(rowOffset, rowOffset + rowLimit);
  const renderedRows = visibleRows.map(
    ({ row, displayIndex, currentOrchestrationRole, currentOrchestrationId }) => {
      if (row.kind === "orchestration") {
        return h(
          Text,
          {
            key: `orchestration-${row.orchestrationId}-${displayIndex}`,
            dimColor: true,
            inverse:
              effectiveFocus?.kind === "orchestration" &&
              row.orchestrationId === effectiveFocus.orchestrationId,
            wrap: "truncate",
          },
          formatOrchestrationHeader(
            row,
            contentWidth,
            displayConfig,
            collapsedOrchestrations.has(row.orchestrationId),
          ),
        );
      }
      if (row.kind === "agent-session") {
        const firstChild = displayRows[displayIndex + 1];
        const sessionItem = items.find(
          (item) =>
            item.orchestrationId === currentOrchestrationId &&
            item.agentSessionKind === row.agentSessionKind &&
            item.agentSessionValue === row.agentSessionValue,
        );
        const agentLabel =
          sessionItem?.agentLabel ??
          (firstChild?.kind === "result" ? firstChild.item.agentLabel : "unknown agent");
        const role = sessionRole(
          displayRows,
          displayIndex,
          sessionItem?.orchestrationRole ?? currentOrchestrationRole,
        );
        return h(
          Text,
          { key: `agent-session-${displayIndex}`, dimColor: true, wrap: "truncate" },
          formatAgentSessionHeader(row, agentLabel, role, contentWidth, displayConfig),
        );
      }

      const rowText =
        row.item.orchestrationId === null
          ? formatInboxRow(row.item, contentWidth, Date.now(), displayConfig)
          : formatGroupedInboxRow(row.item, contentWidth, Date.now(), displayConfig);
      return h(
        Text,
        {
          key: `result-${row.item.id}`,
          inverse: effectiveFocus?.kind === "result" && row.item.id === effectiveFocus.resultId,
          wrap: "truncate",
        },
        rowText,
      );
    },
  );
  const metadataLines = selectedMetadataLines(
    itemForFocus(items, effectiveFocus),
    contentWidth,
    displayConfig,
  );
  const metadata =
    metadataLines.length === 0
      ? null
      : h(
          Box,
          { flexDirection: "column" },
          metadataLines.map((line, index) =>
            h(Text, { key: `metadata-${index}`, dimColor: true, wrap: "truncate" }, line),
          ),
        );

  const title = inboxTitle(mode, search, items.length);
  const subtitle = inboxSubtitle(mode, search);
  const emptyState = inboxEmptyState(mode, search);
  const footer = inboxFooter(mode, search);

  return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(Text, { bold: true, wrap: "truncate" }, title),
    h(Text, { dimColor: true, wrap: "truncate" }, subtitle),
    items.length > 0 ? renderedRows : h(Text, { dimColor: true, wrap: "truncate" }, emptyState),
    metadata,
    statusElement(status),
    h(Text, { dimColor: true, wrap: "truncate" }, footer),
  );
};

/** Title line for the current collection or search session. */
function inboxTitle(
  mode: InboxMode,
  search: InboxSearchView | undefined,
  itemCount: number,
): string {
  if (search !== undefined) {
    const scope = searchScopeLabel(search.scope);
    if (!search.applied) {
      return `Harvest Result Search · ${scope}`;
    }
    return `Harvest Result Search · ${scope} · ${itemCount} match${itemCount === 1 ? "" : "es"}`;
  }

  const resultCount = `${itemCount} result${itemCount === 1 ? "" : "s"}`;
  return mode === "archived"
    ? `Harvest Archived Results · ${resultCount}`
    : `Harvest Result Inbox · ${resultCount}`;
}

/** Subtitle line: the query line while searching, the collection hint otherwise. */
function inboxSubtitle(mode: InboxMode, search: InboxSearchView | undefined): string {
  if (search !== undefined) {
    return `Search: ${search.text}${search.editing ? SEARCH_CURSOR : ""}`;
  }

  return mode === "archived"
    ? "Newest archived first; select one to inspect it."
    : "Unread results stay at the top; select one to inspect it.";
}

function inboxEmptyState(mode: InboxMode, search: InboxSearchView | undefined): string {
  if (search?.applied) {
    return `No results match "${search.query}"`;
  }

  return mode === "archived"
    ? "No archived results."
    : "No results yet. Captured agent output will appear here.";
}

function inboxFooter(mode: InboxMode, search: InboxSearchView | undefined): string {
  if (search !== undefined) {
    return SEARCH_FOOTER;
  }

  return mode === "archived"
    ? "↑/↓ or k/j move · PageUp/PageDown page · Space toggle group · <- collapse · -> expand · Enter open · y copy · r restore · Tab active · q/Esc quit"
    : "↑/↓ or k/j move · PageUp/PageDown page · Space toggle group · <- collapse · -> expand · Enter open · y copy · a archive · Tab archived · q/Esc quit";
}

function searchScopeLabel(scope: InboxScope): string {
  switch (scope) {
    case "active":
      return "Active";
    case "archived":
      return "Archived";
    case "all":
      return "All";
  }
}

export function formatInboxRow(
  item: InboxItem,
  width: number,
  nowMs = Date.now(),
  displayConfig: InboxDisplayConfig = DEFAULT_INBOX_DISPLAY_CONFIG,
): string {
  const limit = normalizedWidth(width);
  if (limit === 0) {
    return "";
  }

  const fields = resultFields(item, displayConfig.standaloneFields, nowMs);

  const { visibleFields, separator } = chooseVisibleFields(fields, limit);
  return appendItemBadge(fitFields(visibleFields, limit, separator), item, limit);
}

export function formatOrchestrationHeader(
  header: OrchestrationHeader,
  width: number,
  displayConfig: InboxDisplayConfig = DEFAULT_INBOX_DISPLAY_CONFIG,
  collapsed = false,
): string {
  const fields = displayConfig.orchestrationHeaderFields
    .map((field) => orchestrationHeaderFieldValue(header, field))
    .filter((value): value is string => value !== null);
  const body = fields.length === 0 ? "" : ` ${fields.join(" · ")}`;
  return truncateDisplay(`${collapsed ? "▸" : "▾"}${body}`, normalizedWidth(width));
}

export function formatAgentSessionHeader(
  header: AgentSessionHeader,
  agentLabel: string,
  role: string | null,
  width: number,
  displayConfig: InboxDisplayConfig = DEFAULT_INBOX_DISPLAY_CONFIG,
): string {
  const fields = displayConfig.sessionHeaderFields
    .map((field) => sessionHeaderFieldValue(header, agentLabel, role, field))
    .filter((value): value is string => value !== null);
  const body = fields.length === 0 ? "" : ` ${fields.join(" · ")}`;
  return truncateDisplay(`  ${body}`, normalizedWidth(width));
}

export function formatGroupedInboxRow(
  item: InboxItem,
  width: number,
  nowMs = Date.now(),
  displayConfig: InboxDisplayConfig = DEFAULT_INBOX_DISPLAY_CONFIG,
): string {
  const limit = normalizedWidth(width);
  if (limit === 0) {
    return "";
  }

  const indent = "    ";
  const availableWidth = Math.max(0, limit - displayWidth(indent));
  const fields = resultFields(item, displayConfig.groupedFields, nowMs);
  const { visibleFields, separator } = chooseVisibleFields(fields, availableWidth);
  const row = `${indent}${fitFields(visibleFields, availableWidth, separator)}`;
  const labeledRow = appendItemBadge(row, item, limit);
  return displayWidth(labeledRow) <= limit ? labeledRow : truncateDisplay(labeledRow, limit);
}

function resultCountLabel(count: number): string {
  const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return `${normalizedCount} result${normalizedCount === 1 ? "" : "s"}`;
}

function sessionRole(
  rows: readonly InboxDisplayRow[],
  headerIndex: number,
  fallback: OrchestrationHeader["orchestrationRole"],
): string | null {
  const roles: string[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row?.kind !== "result") {
      break;
    }
    const role = row.item.orchestrationRole;
    if (role !== null && !roles.includes(role)) {
      roles.push(role);
    }
  }
  return roles.length > 0 ? roles.join("/") : fallback;
}

/**
 * Measure terminal columns using a deliberately small wide-character table.
 * This does not attempt full grapheme clustering; each code point is measured
 * independently, which is sufficient for the common Japanese and emoji data
 * shown in the inbox.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    width += codePoint !== undefined && isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

/**
 * Format metadata for the currently selected inbox item. This is pure so
 * width-dependent behavior can be tested without relying on Ink's terminal.
 */
export function selectedMetadataLines(
  item: InboxItem | undefined,
  width: number,
  displayConfig: InboxDisplayConfig = DEFAULT_INBOX_DISPLAY_CONFIG,
): string[] {
  const limit = normalizedWidth(width);
  if (
    item === undefined ||
    limit < METADATA_MIN_WIDTH ||
    displayConfig.metadataFields.length === 0
  ) {
    return [];
  }

  const rowFields =
    item.orchestrationId === null ? displayConfig.standaloneFields : displayConfig.groupedFields;
  return displayConfig.metadataFields
    .filter((field) => field !== "context" || !rowFields.includes("context"))
    .map((field) => metadataFieldValue(item, field))
    .filter((value): value is string => value !== null)
    .map((value) => truncateDisplay(value, limit));
}

function resultFields(item: InboxItem, fields: readonly ResultField[], nowMs: number): RowField[] {
  return fields
    .map((field) => {
      const value = resultFieldValue(item, field, nowMs);
      return value === null ? null : { value, minimumWidth: resultFieldMinimumWidth(field, value) };
    })
    .filter((field): field is RowField => field !== null);
}

function resultFieldValue(item: InboxItem, field: ResultField, nowMs: number): string | null {
  switch (field) {
    case "unread":
      return item.unread ? "●" : " ";
    case "agent":
      return meaningfulLabel(item.agentLabel) ?? "unknown agent";
    case "session":
      return meaningfulLabel(item.sessionShortId) ?? "unknown session";
    case "context":
      return resultContextLabel(item);
    case "age":
      return formatTimestamp(item.capturedAtMs, nowMs);
    case "workspace":
      return meaningfulLabel(item.workspaceLabel) ?? "unknown workspace";
    case "preview":
      return item.preview || "(empty)";
  }
}

/** Short, always-visible kind/status marker carried by the inbox row. */
export function inboxItemBadge(item: InboxItem): string {
  if (item.kind !== "pi") {
    return "Legacy";
  }
  switch (item.status) {
    case "completed":
      return "Pi · Completed";
    case "failed":
      return "Pi · Failed-incomplete";
    case "pending":
      return "Pi · Pending";
    default:
      return "Pi · Unknown";
  }
}

function appendItemBadge(row: string, item: InboxItem, width: number): string {
  if (row.length === 0) {
    return row;
  }
  return truncateDisplay(`${row} · ${inboxItemBadge(item)}`, width);
}

function resultFieldMinimumWidth(field: ResultField, value: string): number {
  switch (field) {
    case "unread":
      return 1;
    case "agent":
      return Math.min(AGENT_MIN_DISPLAY_WIDTH, displayWidth(value));
    case "session":
      return displayWidth(value);
    case "context":
      return Math.min(4, displayWidth(value));
    case "age":
      return Math.min(5, displayWidth(value));
    case "workspace":
      return Math.min(2, displayWidth(value));
    case "preview":
      return Math.min(4, displayWidth(value));
  }
}

function orchestrationHeaderFieldValue(
  header: OrchestrationHeader,
  field: OrchestrationHeaderField,
): string | null {
  switch (field) {
    case "label":
      return meaningfulLabel(header.orchestrationLabel) ?? "unknown orchestration";
    case "id":
      return header.orchestrationId.slice(0, 8);
    case "count":
      return resultCountLabel(header.count);
  }
}

function sessionHeaderFieldValue(
  header: AgentSessionHeader,
  agentLabel: string,
  role: string | null,
  field: SessionHeaderField,
): string | null {
  switch (field) {
    case "role":
      return meaningfulLabel(role) ?? "unknown role";
    case "agent":
      return meaningfulLabel(agentLabel) ?? "unknown agent";
    case "session":
      return meaningfulLabel(header.sessionShortId) ?? "unknown session";
    case "count":
      return resultCountLabel(header.count);
  }
}

function metadataFieldValue(item: InboxItem, field: MetadataField): string | null {
  switch (field) {
    case "context": {
      const context = resultContextLabel(item);
      return context === null ? null : `Context: ${context}`;
    }
    case "agent":
      return `Agent: ${meaningfulLabel(item.agentLabel) ?? "unknown agent"}`;
    case "session":
      return `Session: ${meaningfulLabel(item.sessionShortId) ?? "unknown session"}`;
    case "workspace":
      return `Workspace: ${meaningfulLabel(item.workspaceLabel) ?? "unknown workspace"}`;
    case "pane":
      return `Pane: ${meaningfulLabel(item.paneLabel) ?? "unknown pane"}`;
    case "herdrSession":
      return `Herdr: ${meaningfulLabel(item.herdrSessionLabel) ?? "unknown session"}`;
    case "preview":
      return `Preview: ${item.preview || "(empty)"}`;
  }
}

function resultContextLabel(item: InboxItem): string | null {
  const paneLabel = meaningfulLabel(item.paneLabel);
  const orchestrationLabel = meaningfulLabel(item.orchestrationLabel);
  if (paneLabel !== null && orchestrationLabel !== null && paneLabel !== orchestrationLabel) {
    return `${orchestrationLabel} · ${paneLabel}`;
  }
  return paneLabel ?? orchestrationLabel;
}

function meaningfulLabel(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function formatTimestamp(timestampMs: number, nowMs = Date.now()): string {
  if (!Number.isFinite(timestampMs)) {
    return "unknown time";
  }

  const differenceMs = nowMs - timestampMs;
  const absoluteSeconds = Math.floor(Math.abs(differenceMs) / 1_000);
  const direction = differenceMs < 0 ? "in" : "ago";
  if (absoluteSeconds < 60) {
    return differenceMs < 0 ? "in <1m" : "just now";
  }
  if (absoluteSeconds < 3_600) {
    return `${direction} ${Math.floor(absoluteSeconds / 60)}m`;
  }
  if (absoluteSeconds < 86_400) {
    return `${direction} ${Math.floor(absoluteSeconds / 3_600)}h`;
  }

  const date = new Date(timestampMs);
  if (Number.isNaN(date.getTime())) {
    return "unknown time";
  }
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function contentWidthFor(width: number): number {
  return Math.max(0, normalizedWidth(width) - INBOX_HORIZONTAL_PADDING);
}

function normalizedWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return DEFAULT_INBOX_WIDTH;
  }
  return Math.max(0, Math.floor(width));
}

function chooseVisibleFields(
  fields: readonly RowField[],
  width: number,
): { visibleFields: RowField[]; separator: string } {
  let separator = ROW_SEPARATOR;
  if (minimumRowWidth(fields.slice(0, 3), separator) > width) {
    separator = NARROW_SEPARATOR;
    if (minimumRowWidth(fields.slice(0, 3), separator) > width) {
      separator = NO_SEPARATOR;
    }
  }
  const visibleFields = fields.slice();
  while (visibleFields.length > 3 && minimumRowWidth(visibleFields, separator) > width) {
    visibleFields.pop();
  }
  return { visibleFields, separator };
}

function minimumRowWidth(fields: readonly RowField[], separator: string): number {
  const fieldsWidth = fields.reduce((total, field) => total + field.minimumWidth, 0);
  return fieldsWidth + separatorDisplayWidth(fields.length, separator);
}

function fitFields(fields: readonly RowField[], width: number, separator: string): string {
  if (fields.length === 0 || width === 0) {
    return "";
  }
  if (minimumRowWidth(fields, separator) > width) {
    return fitTinyFields(fields, width);
  }

  const separatorWidth = separatorDisplayWidth(fields.length, separator);
  let remainingTextWidth = Math.max(0, width - separatorWidth);
  const fitted: string[] = [];

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined) {
      continue;
    }

    const remainingMinimumWidth = fields
      .slice(index + 1)
      .reduce((total, nextField) => total + nextField.minimumWidth, 0);
    const available = Math.max(0, remainingTextWidth - remainingMinimumWidth);
    const fieldWidth = Math.min(displayWidth(field.value), available);
    fitted.push(truncateDisplay(field.value, fieldWidth));
    remainingTextWidth = Math.max(0, remainingTextWidth - fieldWidth);
  }

  const row = joinFields(fitted, separator);
  return displayWidth(row) <= width ? row : truncateDisplay(row, width);
}

function separatorDisplayWidth(fieldCount: number, separator: string): number {
  return separatorsFor(fieldCount, separator).reduce(
    (total, current) => total + displayWidth(current),
    0,
  );
}

function separatorsFor(fieldCount: number, separator: string): string[] {
  const separators: string[] = [];
  for (let index = 0; index < Math.max(0, fieldCount - 1); index += 1) {
    separators.push(index === 0 && separator === ROW_SEPARATOR ? NARROW_SEPARATOR : separator);
  }
  return separators;
}

function joinFields(fields: readonly string[], separator: string): string {
  const separators = separatorsFor(fields.length, separator);
  let row = fields[0] ?? "";
  for (let index = 1; index < fields.length; index += 1) {
    row += `${separators[index - 1] ?? separator}${fields[index] ?? ""}`;
  }
  return row;
}

function fitTinyFields(fields: readonly RowField[], width: number): string {
  const marker = fields[0];
  const agent = fields[1];
  const session = fields[2];
  if (marker !== undefined && agent !== undefined && session !== undefined) {
    const markerWidth = Math.min(displayWidth(marker.value), width);
    const remainingAfterMarker = Math.max(0, width - markerWidth);
    const sessionWidth = Math.min(displayWidth(session.value), remainingAfterMarker);
    const agentWidth = Math.max(0, remainingAfterMarker - sessionWidth);
    return [
      truncateDisplay(marker.value, markerWidth),
      truncateDisplay(agent.value, agentWidth),
      truncateDisplay(session.value, sessionWidth),
    ].join("");
  }

  let remainingWidth = width;
  const fitted: string[] = [];
  for (const field of fields) {
    const fieldWidth = Math.min(displayWidth(field.value), remainingWidth);
    fitted.push(truncateDisplay(field.value, fieldWidth));
    remainingWidth -= fieldWidth;
  }
  return fitted.join("");
}

function truncateDisplay(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  if (limit === 0) {
    return "";
  }
  const singleLine = text.replace(/\r\n?|\n|\u2028|\u2029/g, " ");
  if (displayWidth(singleLine) <= limit) {
    return singleLine;
  }
  if (limit <= displayWidth(ELLIPSIS)) {
    return ELLIPSIS;
  }

  const budget = limit - displayWidth(ELLIPSIS);
  let used = 0;
  let result = "";
  for (const character of singleLine) {
    const characterWidth = displayWidth(character);
    if (used + characterWidth > budget) {
      break;
    }
    result += character;
    used += characterWidth;
  }
  return `${result}${ELLIPSIS}`;
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    codePoint === 0x2329 ||
    codePoint === 0x232a ||
    (codePoint >= 0x2e80 && codePoint <= 0x303e) ||
    (codePoint >= 0x3040 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f000 && codePoint <= 0x1faff)
  );
}

function statusElement(status: StatusMessage | null): React.ReactElement | null {
  if (status === null) {
    return null;
  }
  return h(Text, { color: status.error ? "red" : "green", wrap: "truncate" }, status.text);
}

export default InboxView;
