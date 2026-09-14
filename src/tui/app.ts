import { useApp, useInput, useStdout } from "ink";
import React, { type FC, useEffect, useState } from "react";
import type {
  InboxDetail,
  InboxItem,
  InboxMode,
  InboxPort,
  InboxScope,
} from "../app/inbox-service.ts";
import { isSearchQueryActive } from "../app/result-search.ts";
import type { CopyReport } from "../clipboard/provider.ts";
import { ClipboardError } from "../clipboard/provider.ts";
import {
  clampListOffset,
  type InboxSearchView,
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

/**
 * One search session. `query` is the applied filter, while `draft` is only what
 * the query line shows while editing, so typing never changes the visible
 * results until Enter applies the draft. Keeping both in one value means
 * entering, applying, cancelling, and scope cycling can never disagree about
 * which of the two is current.
 *
 * `scope` is the search's own collection and deliberately does not touch
 * `mode`, so Esc can always return to the collection the search started from.
 */
interface SearchState {
  query: string;
  draft: string;
  scope: InboxScope;
  editing: boolean;
}

export function createApp(port: InboxPort): FC {
  const HarvestApp: FC = () => {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [view, setView] = useState<View>("inbox");
    const [mode, setMode] = useState<InboxMode>("active");
    const [search, setSearch] = useState<SearchState | null>(null);
    const [items, setItems] = useState<InboxItem[]>(() => port.list("active"));
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

    /**
     * Collection switches replace the whole list, so the cursor and the list
     * offset are reset together in one atomic position update, and a status from
     * the previous collection is cleared.
     */
    const switchMode = (next: InboxMode): void => {
      setMode(next);
      setItems(port.list(next));
      setPosition({ cursor: 0, listOffset: 0 });
      setStatus(null);
    };

    /**
     * The port call behind every refresh: a search session lists its own scope
     * and applied query, while the plain inbox lists the current collection.
     */
    const listFromPort = (): InboxItem[] =>
      search === null ? port.list(mode) : port.list({ mode: search.scope, query: search.query });

    /**
     * Search-session switches replace the whole list like a collection switch,
     * so the cursor and list offset reset together and a stale status is
     * cleared. Passing null leaves search entirely and shows the normal
     * collection, which Esc must always be able to restore.
     */
    const showSearch = (next: SearchState | null): void => {
      setSearch(next);
      setItems(
        next === null ? port.list(mode) : port.list({ mode: next.scope, query: next.query }),
      );
      setPosition({ cursor: 0, listOffset: 0 });
      setStatus(null);
    };

    /** The first entry opens on the collection in view; later ones keep the applied query. */
    const beginSearchEdit = (): void => {
      const current = search ?? { query: "", draft: "", scope: mode, editing: false };
      setSearch({ ...current, editing: true, draft: current.query });
    };

    /** Draft edits go through one queued updater so batched keys still apply in order. */
    const editDraft = (update: (draft: string) => string): void => {
      setSearch((current) =>
        current === null || !current.editing
          ? current
          : { ...current, draft: update(current.draft) },
      );
    };

    /** Enter applies the draft. A blank draft is not a filter, so it leaves search. */
    const applySearchEdit = (): void => {
      if (search === null) {
        return;
      }
      if (!isSearchQueryActive(search.draft)) {
        showSearch(null);
        return;
      }
      showSearch({ ...search, query: search.draft, draft: search.draft, editing: false });
    };

    /** Esc reverts the draft to the applied query, or leaves search when none was applied. */
    const cancelSearchEdit = (): void => {
      if (search === null) {
        return;
      }
      if (!isSearchQueryActive(search.query)) {
        showSearch(null);
        return;
      }
      setSearch({ ...search, editing: false, draft: search.query });
    };

    /** Esc from an applied search returns to the collection the search started from. */
    const clearSearch = (): void => {
      showSearch(null);
    };

    const cycleSearchScope = (): void => {
      if (search === null) {
        return;
      }
      const scope: InboxScope =
        search.scope === "active" ? "archived" : search.scope === "archived" ? "all" : "active";
      showSearch({ ...search, scope });
    };

    const refreshItems = (hasStatus = status !== null): InboxItem[] => {
      const nextItems = listFromPort();
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

    const restore = (id: string, returnToInbox: boolean): void => {
      try {
        const applied = port.restore(id);
        refreshItems(true);
        if (returnToInbox) {
          setDetail(null);
          setView("inbox");
        }
        setStatus({
          text: applied ? `Restored result ${id}.` : `Result ${id} is already active.`,
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
        if (search?.editing) {
          // Query editing owns the keyboard: printable input becomes text, so
          // q, a, r, y, j, k, space, and / never reach the action keys below.
          // Enter applies the draft and Esc cancels it. Tab stays out of the
          // way here — the scope cycle belongs to the applied search, because
          // a draft cannot know which collection it will run against yet.
          if (key.return || input === "\r") {
            applySearchEdit();
            return;
          }
          if (key.escape || input === "\u001b") {
            cancelSearchEdit();
            return;
          }
          if (key.backspace || key.delete || input === "\u007f") {
            editDraft((draft) => draft.slice(0, -1));
            return;
          }
          if (!key.ctrl && !key.meta && isPrintableText(input) && !isMouseReport(input)) {
            editDraft((draft) => draft + input);
          }
          return;
        }

        // Tab only toggles collections from the inbox, so a detail always
        // returns to the collection it was opened from. An applied search
        // cycles its own scope instead, because "all" is not a collection the
        // plain inbox can show.
        if (key.tab && !key.shift) {
          if (search === null) {
            switchMode(mode === "active" ? "archived" : "active");
          } else {
            cycleSearchScope();
          }
          return;
        }
        if (input === "/") {
          beginSearchEdit();
          return;
        }
        if (input === "q") {
          exit();
          return;
        }
        if (key.escape || input === "\u001b") {
          // The first Esc clears an applied search; once the inbox is plain
          // again it quits exactly as it did before search existed.
          if (search !== null) {
            clearSearch();
            return;
          }
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
        const selected = items[cursor];
        if (input === "y") {
          if (selected === undefined) {
            setStatus({ text: "There are no results to copy.", error: true });
          } else {
            copy(selected.id, undefined);
          }
          return;
        }

        // A search can show active and archived rows together, so the selected
        // row decides which action applies. Without a search the collection
        // already guarantees the same answer, which keeps v0.2.0 key behavior.
        const archiveAllowed = search === null ? mode === "active" : selected?.archived === false;
        const restoreAllowed = search === null ? mode === "archived" : selected?.archived === true;

        if (input === "a" && archiveAllowed) {
          if (selected === undefined) {
            setStatus({ text: "There are no results to archive.", error: true });
          } else {
            archive(selected.id, false);
          }
        }

        if (input === "r" && restoreAllowed) {
          if (selected === undefined) {
            setStatus({ text: "There are no results to restore.", error: true });
          } else {
            restore(selected.id, false);
          }
        }
        return;
      }

      // Tab is deliberately inert while a detail is open, so Esc is always the
      // way back to the collection the detail came from.
      if (key.tab) {
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
      if (input === "a" && !detail.archived) {
        archive(detail.id, true);
        return;
      }
      if (input === "r" && detail.archived) {
        restore(detail.id, true);
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

    const searchView: InboxSearchView | undefined =
      search === null
        ? undefined
        : {
            query: search.query,
            text: search.editing ? search.draft : search.query,
            scope: search.scope,
            editing: search.editing,
            applied: isSearchQueryActive(search.query),
          };

    return h(InboxView, {
      items,
      cursor,
      width: inboxWidth,
      mode,
      status,
      search: searchView,
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
 * Text that can be typed into the query line. Control bytes carry meaning (Tab,
 * Enter, Esc, DEL, Ctrl+letter) and never become query text, while space and
 * multi-character pastes are kept whole.
 */
function isPrintableText(input: string): boolean {
  if (input.length === 0) {
    return false;
  }

  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return false;
    }
  }

  return true;
}

/**
 * SGR mouse reports reach `useInput` as `[<Cb;x;yM` and are already classified
 * for wheels before key handling. Any other report (press, release, drag) is
 * still not typed text, so it must never enter the query line; see mouse.ts for
 * the reporting encoding.
 */
function isMouseReport(input: string): boolean {
  return /^\[<\d+;\d+;\d+[Mm]$/.test(input);
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
