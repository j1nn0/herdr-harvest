import { Box, Text, useStdout } from "ink";
import React, { type FC } from "react";

import type { InboxDetail } from "../app/inbox-service.ts";
import type { StatusMessage } from "./inbox-view.ts";

const h = React.createElement;

/** Base chrome reserves one status line even when no status is currently shown. */
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
  const isInteraction = detail.kind === "pi" || detail.kind === "codex";
  const interactionLabel = detail.kind === "codex" ? "Codex" : "Pi";
  const lines = detailContentLines(detail);
  const hasOrchestrationContext = detail.orchestrationId !== null;
  const viewport = resultViewportLines(stdout.rows, hasOrchestrationContext);
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

  const title = isInteraction
    ? `${interactionLabel} Interaction · ${piStatusLabel(detail.status)}`
    : detail.archived
      ? `Harvest Archived Result · ${detail.agentLabel}`
      : `Harvest Result · ${detail.agentLabel}`;
  const footer = isInteraction
    ? (detail.finalReport ?? null) === null
      ? "↑/↓ or k/j scroll · PageUp/PageDown page · p copy prompt · f unavailable · y copy prompt · Esc inbox"
      : "↑/↓ or k/j scroll · PageUp/PageDown page · p copy prompt · f copy final report · y copy final report · Esc inbox"
    : detail.archived
      ? "↑/↓ or k/j scroll · PageUp/PageDown page · y copy · r restore · Esc inbox"
      : "↑/↓ or k/j scroll · PageUp/PageDown page · y copy · a archive · Esc inbox";
  const subtitle = isInteraction
    ? `${interactionLabel} session ${detail.sessionShortId} · ${detail.status === "failed" ? `failure: ${detail.reason ?? "unknown failure"}` : "terminal interaction"}`
    : `Herdr: ${detail.herdrSessionLabel ?? "unknown session"} · session ${detail.sessionShortId} · workspace ${detail.workspaceLabel} · pane ${detail.paneLabel} · ${detail.captureSource}`;
  const orchestrationContext =
    detail.orchestrationId === null
      ? null
      : h(
          Text,
          { dimColor: true, wrap: "truncate" },
          `Orchestration: ${singleLineDisplay(detail.orchestrationLabel ?? "unknown orchestration")} · ${detail.orchestrationRole ?? "unknown role"} · ${detail.orchestrationId.slice(0, 8)}`,
        );

  return h(
    Box,
    { flexDirection: "column", paddingX: 1 },
    h(Text, { bold: true, wrap: "truncate" }, title),
    h(Text, { dimColor: true, wrap: "truncate" }, subtitle),
    orchestrationContext,
    h(Text, { dimColor: true, wrap: "truncate" }, `line ${start + 1}-${end} of ${lines.length}`),
    h(Box, { flexDirection: "column" }, visibleLines),
    statusElement(status),
    h(Text, { dimColor: true, wrap: "truncate" }, footer),
  );
};

/**
 * Logical body lines for the detail view. Pi and Codex fields are delimited by labels;
 * their source strings are split only for viewport rendering and remain
 * available verbatim through the app copy actions.
 */
export function detailContentLines(detail: InboxDetail): string[] {
  if (detail.kind !== "pi" && detail.kind !== "codex") {
    return detail.rawText.split("\n");
  }

  const promptLines = (detail.submittedPrompt ?? "").split("\n");
  const reportLines =
    typeof detail.finalReport !== "string"
      ? [`UNAVAILABLE: ${detail.reason ?? "interaction failed"}`]
      : detail.finalReport.split("\n");
  return ["PROMPT", ...promptLines, "", "FINAL REPORT", ...reportLines];
}

function piStatusLabel(status: InboxDetail["status"]): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "failed":
      return "Failed-incomplete";
    case "pending":
      return "Pending";
    default:
      return "Unknown";
  }
}

export function resultViewportLines(
  rows: number | undefined,
  hasOrchestrationContext = false,
): number {
  const terminalRows =
    rows === undefined || !Number.isFinite(rows)
      ? DEFAULT_VIEWPORT_LINES + RESULT_CHROME_LINES
      : Math.floor(rows);
  const dynamicChromeLines = RESULT_CHROME_LINES + (hasOrchestrationContext ? 1 : 0);
  return Math.max(1, terminalRows - dynamicChromeLines);
}

function statusElement(status: StatusMessage | null): React.ReactElement | null {
  if (status === null) {
    return null;
  }
  return h(Text, { color: status.error ? "red" : "green", wrap: "truncate" }, status.text);
}

function singleLineDisplay(text: string): string {
  return text.replace(/\r\n?|\n|\u2028|\u2029/g, " ");
}

export default ResultView;
