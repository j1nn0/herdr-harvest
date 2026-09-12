import { useApp, useInput, useStdout } from "ink";
import React, { type FC, useEffect, useState } from "react";
import type { InboxDetail, InboxItem, InboxPort } from "../app/inbox-service.ts";
import type { CopyReport } from "../clipboard/provider.ts";
import { ClipboardError } from "../clipboard/provider.ts";
import {
  clampListOffset,
  InboxView,
  inboxViewportLines,
  listOffsetForCursor,
  type StatusMessage,
  selectedMetadataLines,
} from "./inbox-view.ts";
import { parseWheelEvent, WHEEL_STEP } from "./mouse.ts";
import { ResultView, resultViewportLines } from "./result-view.ts";

const h = React.createElement;
const STATUS_DURATION_MS = 4_000;

type View = "inbox" | "result";

/**
 * Cursor and list offset are one value so every update can derive both from the
 * latest queued position instead of the closure of the last committed render.
 */
interface InboxPosition {
  cursor: number;
  listOffset: number;
}

export function createApp(port: InboxPort): FC {
  const HarvestApp: FC = () => {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [view, setView] = useState<View>("inbox");
    const [items, setItems] = useState<InboxItem[]>(() => port.list());
    const [position, setPosition] = useState<InboxPosition>({ cursor: 0, listOffset: 0 });
    const [detail, setDetail] = useState<InboxDetail | null>(null);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const { cursor, listOffset } = position;
    const viewport = resultViewportLines(stdout.rows);
    const columns = stdout.columns;
    const inboxWidth =
      columns !== undefined && Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 80;
    const inboxContentWidth = Math.max(0, inboxWidth - 2);
    const inboxMetadataLines = selectedMetadataLines(items[cursor], inboxContentWidth).length;
    const inboxCapacity = inboxViewportLines(stdout.rows, inboxMetadataLines, status !== null);
    const inboxPageStep = Math.max(1, inboxCapacity);

    useEffect(() => {
      if (status === null) {
        return;
      }
      const timeout = setTimeout(() => setStatus(null), STATUS_DURATION_MS);
      timeout.unref();
      return () => clearTimeout(timeout);
    }, [status]);

    /**
     * Relative moves (keys and mouse wheel) derive the next cursor from the
     * latest queued position, so every report in a batch still applies even
     * though React has not committed a render in between.
     */
    const moveInboxPosition = (delta: number): void => {
      setPosition((current) =>
        nextInboxPosition(current, current.cursor + delta, items.length, inboxCapacity),
      );
    };

    /**
     * Absolute placement for refresh paths that already know the next item count
     * and capacity. Cursor and list offset are still computed together from one
     * queued state, so the two can never drift apart.
     */
    const setInboxPosition = (
      nextCursor: number,
      itemCount = items.length,
      capacity = inboxCapacity,
    ): void => {
      setPosition((current) => nextInboxPosition(current, nextCursor, itemCount, capacity));
    };

    const refreshItems = (hasStatus = status !== null): InboxItem[] => {
      const nextItems = port.list();
      const nextCursor = clampCursor(cursor, nextItems.length);
      const nextCapacity = inboxViewportLines(
        stdout.rows,
        selectedMetadataLines(nextItems[nextCursor], inboxContentWidth).length,
        hasStatus,
      );
      setItems(nextItems);
      setInboxPosition(nextCursor, nextItems.length, nextCapacity);
      return nextItems;
    };

    const showError = (error: unknown): void => {
      setStatus({ text: copyFailureMessage(error), error: true });
    };

    const copy = (id: string, bytes: number | undefined): void => {
      void Promise.resolve()
        .then(() => port.copy(id))
        .then(
          (report) => setStatus({ text: copySuccessMessage(report, bytes), error: false }),
          (error: unknown) => showError(error),
        );
    };

    const openSelected = (): void => {
      const item = items[cursor];
      if (item === undefined) {
        setStatus({ text: "There are no results to open.", error: true });
        return;
      }

      try {
        const opened = port.open(item.id);
        if (opened === null) {
          refreshItems(true);
          setStatus({ text: `Result ${item.id} is no longer available.`, error: true });
          return;
        }
        setDetail(opened);
        setScrollOffset(0);
        setStatus(null);
        setView("result");
      } catch (error) {
        showError(error);
      }
    };

    const archive = (id: string, returnToInbox: boolean): void => {
      try {
        const applied = port.archive(id);
        refreshItems(true);
        if (returnToInbox) {
          setDetail(null);
          setView("inbox");
        }
        setStatus({
          text: applied ? `Archived result ${id}.` : `Result ${id} is already archived.`,
          error: false,
        });
      } catch (error) {
        showError(error);
      }
    };

    const backToInbox = (): void => {
      try {
        refreshItems();
        setDetail(null);
        setView("inbox");
      } catch (error) {
        showError(error);
      }
    };

    useInput((input, key) => {
      // Wheel reports are the one mouse input the inbox acts on. Everything
      // else that is not a wheel report returns null and keeps falling through
      // to the regular key handling below, where it matches nothing.
      const wheel = parseWheelEvent(input);
      if (wheel !== null) {
        const step = wheel === "up" ? -WHEEL_STEP : WHEEL_STEP;
        if (view === "inbox") {
          moveInboxPosition(step);
        } else if (detail !== null) {
          setScrollOffset((current) =>
            clampScroll(current + step, detail.rawText.split("\n").length, viewport),
          );
        }
        return;
      }

      if (view === "inbox") {
        if (input === "q" || key.escape || input === "\u001b") {
          exit();
          return;
        }
        if (key.upArrow || input === "k") {
          moveInboxPosition(-1);
          return;
        }
        if (key.downArrow || input === "j") {
          moveInboxPosition(1);
          return;
        }
        if (key.pageUp) {
          moveInboxPosition(-inboxPageStep);
          return;
        }
        if (key.pageDown) {
          moveInboxPosition(inboxPageStep);
          return;
        }
        if (key.return || input === "\r") {
          openSelected();
          return;
        }
        if (input === "y") {
          const item = items[cursor];
          if (item === undefined) {
            setStatus({ text: "There are no results to copy.", error: true });
          } else {
            copy(item.id, undefined);
          }
          return;
        }
        if (input === "a") {
          const item = items[cursor];
          if (item === undefined) {
            setStatus({ text: "There are no results to archive.", error: true });
          } else {
            archive(item.id, false);
          }
        }
        return;
      }

      if (key.escape || input === "\u001b") {
        backToInbox();
        return;
      }
      if (detail === null) {
        return;
      }
      if (key.upArrow || input === "k") {
        setScrollOffset((current) =>
          clampScroll(current - 1, detail.rawText.split("\n").length, viewport),
        );
        return;
      }
      if (key.downArrow || input === "j") {
        setScrollOffset((current) =>
          clampScroll(current + 1, detail.rawText.split("\n").length, viewport),
        );
        return;
      }
      if (key.pageUp) {
        setScrollOffset((current) =>
          clampScroll(current - viewport, detail.rawText.split("\n").length, viewport),
        );
        return;
      }
      if (key.pageDown) {
        setScrollOffset((current) =>
          clampScroll(current + viewport, detail.rawText.split("\n").length, viewport),
        );
        return;
      }
      if (input === "y") {
        copy(detail.id, Buffer.byteLength(detail.rawText, "utf8"));
        return;
      }
      if (input === "a") {
        archive(detail.id, true);
      }
    });

    if (view === "result" && detail !== null) {
      return h(ResultView, {
        detail,
        scrollOffset,
        status,
        onCopy: () => copy(detail.id, Buffer.byteLength(detail.rawText, "utf8")),
        onArchive: () => archive(detail.id, true),
        onBack: backToInbox,
      });
    }

    return h(InboxView, {
      items,
      cursor,
      width: inboxWidth,
      status,
      offset: listOffset,
      limit: inboxCapacity,
      onOpen: openSelected,
      onCopy: () => {
        const item = items[cursor];
        if (item !== undefined) {
          copy(item.id, undefined);
        }
      },
      onArchive: () => {
        const item = items[cursor];
        if (item !== undefined) {
          archive(item.id, false);
        }
      },
    });
  };

  return HarvestApp;
}

export function resultViewport(rows: number | undefined): number {
  return resultViewportLines(rows);
}

export function formatBytes(byteCount: number): string {
  if (!Number.isFinite(byteCount) || byteCount < 1_024) {
    return `${Math.max(0, Math.floor(byteCount))} B`;
  }

  const units = ["KB", "MB", "GB"] as const;
  let value = byteCount;
  let unitIndex = -1;
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024;
    unitIndex += 1;
  }
  const rounded = value >= 10 ? value.toFixed(1) : value.toFixed(2);
  return `${rounded.replace(/\.0+$|(?<=\.\d)0+$/, "")} ${units[unitIndex] ?? "GB"}`;
}

function clampCursor(cursor: number, itemCount: number): number {
  if (itemCount === 0) {
    return 0;
  }
  return Math.min(Math.max(0, cursor), itemCount - 1);
}

/**
 * Bounded cursor plus the list offset that keeps it visible, both derived from
 * the same queued position. Returning the current value when nothing moved lets
 * React skip a re-render, as the previous pair of state setters did.
 */
function nextInboxPosition(
  current: InboxPosition,
  nextCursor: number,
  itemCount: number,
  capacity: number,
): InboxPosition {
  const cursor = clampCursor(nextCursor, itemCount);
  const listOffset = clampListOffset(
    listOffsetForCursor(cursor, current.listOffset, capacity),
    itemCount,
    capacity,
  );
  if (cursor === current.cursor && listOffset === current.listOffset) {
    return current;
  }
  return { cursor, listOffset };
}

function clampScroll(offset: number, lineCount: number, viewport: number): number {
  const maxOffset = Math.max(0, lineCount - Math.max(1, viewport));
  return Math.min(Math.max(0, offset), maxOffset);
}

function copySuccessMessage(report: CopyReport, bytes: number | undefined): string {
  const size = bytes === undefined ? "result" : formatBytes(bytes);
  if (report.confirmed) {
    return `Copied ${size} to clipboard (${report.provider})`;
  }
  return `Sent ${size} via ${report.provider} — delivery not confirmed by the terminal`;
}

function copyFailureMessage(error: unknown): string {
  if (error instanceof ClipboardError) {
    const attempts = error.attempts.join("; ");
    return attempts.length > 0 ? `${error.message} Attempts: ${attempts}` : error.message;
  }
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
