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
  status?: StatusMessage | null;
  onOpen: () => void;
  onCopy: () => void;
  onArchive: () => void;
}

export const InboxView: FC<InboxViewProps> = ({ items, cursor, status = null }) => {
  const rows = items.map((item, index) => {
    const marker = item.unread ? "●" : " ";
    const row = `${marker} ${item.agentLabel}  ${item.contextLabel}  ${formatTimestamp(item.capturedAtMs)}  ${item.preview || "(empty)"}`;
    return h(Text, { key: item.id, inverse: index === cursor }, row);
  });

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
    statusElement(status),
    h(Text, { dimColor: true }, "↑/↓ or k/j move · Enter open · y copy · a archive · q/Esc quit"),
  );
};

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

function statusElement(status: StatusMessage | null): React.ReactElement | null {
  if (status === null) {
    return null;
  }
  return h(Text, { color: status.error ? "red" : "green" }, status.text);
}

export default InboxView;
