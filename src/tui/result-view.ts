import { Box, Text, useStdout } from "ink";
import React, { type FC } from "react";

import type { InboxDetail } from "../app/inbox-service.ts";
import type { StatusMessage } from "./inbox-view.ts";

const h = React.createElement;

export const RESULT_CHROME_LINES = 5;
/** Chrome Text nodes use wrap="truncate" so each fixed line stays one physical row. */
export const DEFAULT_VIEWPORT_LINES = 20;

export interface ResultViewProps {
  detail: InboxDetail;
  scrollOffset: number;
  status?: StatusMessage | null;
  onCopy: () => void;
  onArchive: () => void;
  onBack: () => void;
}

export const ResultView: FC<ResultViewProps> = ({ detail, scrollOffset, status = null }) => {
  const { stdout } = useStdout();
  const lines = detail.rawText.split("\n");
  const viewport = resultViewportLines(stdout.rows);
  const maxOffset = Math.max(0, lines.length - viewport);
  const start = Math.min(Math.max(0, Math.floor(scrollOffset)), maxOffset);
  const end = Math.min(lines.length, start + viewport);
  const visibleLines = lines
    .slice(start, end)
    .map((line, index) =>
      h(
        Text,
        { key: `${start + index}-${line}`, wrap: "truncate" },
        line.length === 0 ? " " : line,
      ),
    );

  return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(Text, { bold: true, wrap: "truncate" }, `Harvest Result · ${detail.agentLabel}`),
    h(
      Text,
      { dimColor: true, wrap: "truncate" },
      `Herdr: ${detail.herdrSessionLabel ?? "unknown session"} · session ${detail.sessionShortId} · workspace ${detail.workspaceLabel} · pane ${detail.paneLabel} · ${detail.captureSource}`,
    ),
    h(Text, { dimColor: true, wrap: "truncate" }, `line ${start + 1}-${end} of ${lines.length}`),
    h(Box, { flexDirection: "column" }, visibleLines),
    statusElement(status),
    h(
      Text,
      { dimColor: true, wrap: "truncate" },
      "↑/↓ or k/j scroll · PageUp/PageDown page · y copy · a archive · Esc inbox",
    ),
  );
};

export function resultViewportLines(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows)) {
    return DEFAULT_VIEWPORT_LINES;
  }
  return Math.max(1, Math.floor(rows) - RESULT_CHROME_LINES);
}

function statusElement(status: StatusMessage | null): React.ReactElement | null {
  if (status === null) {
    return null;
  }
  return h(Text, { color: status.error ? "red" : "green", wrap: "truncate" }, status.text);
}

export default ResultView;
