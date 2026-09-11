import { Box, Text } from "ink";
import React, { type FC } from "react";

import type { InboxItem } from "../app/inbox-service.ts";

const h = React.createElement;

export interface StatusMessage {
  text: string;
  error: boolean;
}

export interface InboxViewProps {
  items: readonly InboxItem[];
  cursor: number;
  width: number;
  status?: StatusMessage | null;
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

interface RowField {
  value: string;
  minimumWidth: number;
}

export const InboxView: FC<InboxViewProps> = ({ items, cursor, width, status = null }) => {
  const contentWidth = contentWidthFor(width);
  const rows = items.map((item, index) => {
    const row = formatInboxRow(item, contentWidth);
    return h(Text, { key: item.id, inverse: index === cursor }, row);
  });
  const metadataLines = selectedMetadataLines(items[cursor], contentWidth);
  const metadata =
    metadataLines.length === 0
      ? null
      : h(
          Box,
          { flexDirection: "column" },
          metadataLines.map((line, index) =>
            h(Text, { key: `metadata-${index}`, dimColor: true }, line),
          ),
        );

  return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(
      Text,
      { bold: true },
      `Harvest Result Inbox · ${items.length} result${items.length === 1 ? "" : "s"}`,
    ),
    h(Text, { dimColor: true }, "Unread results stay at the top; select one to inspect it."),
    items.length > 0
      ? rows
      : h(Text, { dimColor: true }, "No results yet. Captured agent output will appear here."),
    metadata,
    statusElement(status),
    h(Text, { dimColor: true }, "↑/↓ or k/j move · Enter open · y copy · a archive · q/Esc quit"),
  );
};

export function formatInboxRow(item: InboxItem, width: number, nowMs = Date.now()): string {
  const limit = normalizedWidth(width);
  if (limit === 0) {
    return "";
  }

  const age = formatTimestamp(item.capturedAtMs, nowMs);
  const preview = item.preview || "(empty)";
  const fields: RowField[] = [
    { value: item.unread ? "●" : " ", minimumWidth: 1 },
    {
      value: item.agentLabel,
      minimumWidth: Math.min(AGENT_MIN_DISPLAY_WIDTH, displayWidth(item.agentLabel)),
    },
    { value: item.sessionShortId, minimumWidth: displayWidth(item.sessionShortId) },
    { value: item.workspaceLabel, minimumWidth: Math.min(2, displayWidth(item.workspaceLabel)) },
    { value: age, minimumWidth: Math.min(5, displayWidth(age)) },
    { value: preview, minimumWidth: Math.min(4, displayWidth(preview)) },
  ];

  const { visibleFields, separator } = chooseVisibleFields(fields, limit);
  return fitFields(visibleFields, limit, separator);
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
export function selectedMetadataLines(item: InboxItem | undefined, width: number): string[] {
  const limit = normalizedWidth(width);
  if (item === undefined || limit < METADATA_MIN_WIDTH) {
    return [];
  }

  return [
    truncateDisplay(`Herdr: ${item.herdrSessionLabel ?? "unknown session"}`, limit),
    truncateDisplay(`Pane: ${item.paneLabel}`, limit),
  ];
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
  if (displayWidth(text) <= limit) {
    return text;
  }
  if (limit <= displayWidth(ELLIPSIS)) {
    return ELLIPSIS;
  }

  const budget = limit - displayWidth(ELLIPSIS);
  let used = 0;
  let result = "";
  for (const character of text) {
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
  return h(Text, { color: status.error ? "red" : "green" }, status.text);
}

export default InboxView;
