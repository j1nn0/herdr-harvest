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

export function createApp(port: InboxPort): FC {
  const HarvestApp: FC = () => {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [view, setView] = useState<View>("inbox");
    const [items, setItems] = useState<InboxItem[]>(() => port.list());
    const [cursor, setCursor] = useState(0);
    const [detail, setDetail] = useState<InboxDetail | null>(null);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [listOffset, setListOffset] = useState(0);
    const [status, setStatus] = useState<StatusMessage | null>(null);
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

    const setInboxPosition = (
      nextCursor: number,
      itemCount = items.length,
      capacity = inboxCapacity,
    ): void => {
      const boundedCursor = clampCursor(nextCursor, itemCount);
      setCursor(boundedCursor);
      setListOffset((currentOffset) =>
        clampListOffset(
          listOffsetForCursor(boundedCursor, currentOffset, capacity),
          itemCount,
          capacity,
        ),
      );
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
          setInboxPosition(cursor + step);
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
          setInboxPosition(cursor - 1);
          return;
        }
        if (key.downArrow || input === "j") {
          setInboxPosition(cursor + 1);
          return;
        }
        if (key.pageUp) {
          setInboxPosition(cursor - inboxPageStep);
          return;
        }
        if (key.pageDown) {
          setInboxPosition(cursor + inboxPageStep);
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
