import { type Key, useApp, useInput, useStdout } from "ink";
import React, { type FC, useEffect, useRef, useState } from "react";
import { buildInboxGrouping, type InboxDisplayRow } from "../app/inbox-groups.ts";
import type {
  InboxCopyField,
  InboxDetail,
  InboxItem,
  InboxMode,
  InboxPort,
  InboxScope,
} from "../app/inbox-service.ts";
import { isSearchQueryActive } from "../app/result-search.ts";
import type { CopyReport } from "../clipboard/provider.ts";
import { ClipboardError } from "../clipboard/provider.ts";
import type { InboxDisplayConfig } from "../config/inbox-display-config.ts";
import { DEFAULT_INBOX_DISPLAY_CONFIG } from "../config/inbox-display-config.ts";
import {
  cursorForFocus,
  displayRowIndexForFocus,
  focusAfterVisualMove,
  type InboxFocus,
  itemForFocus,
  reconcileInboxFocus,
  visibleInboxRows,
} from "./inbox-focus.ts";
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
import { detailContentLines, ResultView, resultViewportLines } from "./result-view.ts";

const h = React.createElement;
const STATUS_DURATION_MS = 4_000;

type View = "inbox" | "result";

/**
 * Cursor and list offset are one value so every update can derive both from the
 * latest queued position instead of the closure of the last committed render.
 */
interface InboxPosition {
  cursor: number;
  focus: InboxFocus | null;
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

export function createApp(
  port: InboxPort,
  displayConfig: InboxDisplayConfig = DEFAULT_INBOX_DISPLAY_CONFIG,
): FC {
  const HarvestApp: FC = () => {
    const { exit } = useApp();
    const { stdout } = useStdout();
    const [view, setView] = useState<View>("inbox");
    const [mode, setMode] = useState<InboxMode>("active");
    const [search, setSearch] = useState<SearchState | null>(null);
    const [items, setItems] = useState<InboxItem[]>(() => port.list("active"));
    const [position, setPosition] = useState<InboxPosition>({
      cursor: 0,
      focus: null,
      listOffset: 0,
    });
    const [collapsedOrchestrations, setCollapsedOrchestrations] = useState<ReadonlySet<string>>(
      () => new Set(),
    );
    const collapsedRef = useRef<ReadonlySet<string>>(new Set());
    collapsedRef.current = collapsedOrchestrations;
    const [detail, setDetail] = useState<InboxDetail | null>(null);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [status, setStatus] = useState<StatusMessage | null>(null);
    const { cursor, focus, listOffset } = position;
    const hasOrchestrationContext = detail !== null && detail.orchestrationId !== null;
    const viewport = resultViewportLines(stdout.rows, hasOrchestrationContext);
    const columns = stdout.columns;
    const inboxWidth =
      columns !== undefined && Number.isFinite(columns) ? Math.max(0, Math.floor(columns)) : 80;
    const inboxContentWidth = Math.max(0, inboxWidth - 2);
    const allInboxRows = buildInboxGrouping(items);
    const searchApplied = isSearchQueryActive(search?.query ?? "");
    const inboxRows = visibleInboxRows(allInboxRows, collapsedOrchestrations, searchApplied);
    const effectiveFocus = reconcileInboxFocus(items, inboxRows, focus, cursor);
    const effectiveCursor = cursorForFocus(items, effectiveFocus, cursor);
    const inboxMetadataLines = selectedMetadataLines(
      itemForFocus(items, effectiveFocus),
      inboxContentWidth,
      displayConfig,
    ).length;
    const inboxCapacity = inboxViewportLines(stdout.rows, inboxMetadataLines, status !== null);
    const inboxPageStep = Math.max(1, inboxCapacity);
    const selectedDisplayRow = Math.max(0, displayRowIndexForFocus(inboxRows, effectiveFocus));
    const visibleListOffset = clampListOffset(
      listOffsetForCursor(selectedDisplayRow, listOffset, inboxCapacity),
      inboxRows.length,
      inboxCapacity,
    );

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
      setPosition((current) => {
        const rows = visibleInboxRows(
          buildInboxGrouping(items),
          collapsedRef.current,
          isSearchQueryActive(searchRef.current?.query ?? ""),
        );
        const nextFocus = focusAfterVisualMove(items, rows, current.focus, current.cursor, delta);
        return nextInboxPosition(current, nextFocus, items, rows, inboxCapacity);
      });
    };

    /**
     * The collection that last became effective, mirrored outside React so a
     * burst of input events inside one render cannot list the wrong collection.
     */
    const modeRef = useRef<InboxMode>("active");

    /**
     * The effective search session. `updateSearch` is its only writer: syncing
     * it from the render body would clobber updates that are queued but not
     * committed yet, which is exactly what a burst of input events produces.
     */
    const searchRef = useRef<SearchState | null>(null);

    /**
     * The one listing call: a search session lists its scope and applied query,
     * a plain inbox lists the collection that became effective last.
     */
    const listForSearch = (active: SearchState | null): InboxItem[] =>
      active === null
        ? port.list(modeRef.current)
        : port.list({ mode: active.scope, query: active.query });

    /**
     * The single owner of the search session. `update` always runs against the
     * latest effective state rather than the render closure, the result is
     * published synchronously so the next input event sees it, and `relist`
     * derives the rows from that same result, so the header and the list cannot
     * disagree. The render follows afterwards.
     */
    const updateSearch = (
      update: (current: SearchState | null) => SearchState | null,
      options: { relist?: boolean } = {},
    ): SearchState | null => {
      const next = update(searchRef.current);
      searchRef.current = next;
      setSearch(next);
      if (options.relist === true) {
        setItems(listForSearch(next));
        setPosition({ cursor: 0, focus: null, listOffset: 0 });
        setStatus(null);
      }
      return next;
    };

    /**
     * Collection switches replace the whole list, so the cursor and the list
     * offset are reset together in one atomic position update, and a status from
     * the previous collection is cleared.
     */
    const switchMode = (next: InboxMode): void => {
      modeRef.current = next;
      setMode(next);
      setItems(listForSearch(null));
      setPosition({ cursor: 0, focus: null, listOffset: 0 });
      setStatus(null);
    };

    /**
     * Search-session switches replace the whole list like a collection switch,
     * so the cursor and list offset reset together and a stale status is
     * cleared. Passing null leaves search entirely and shows the normal
     * collection, which Esc must always be able to restore.
     */
    const showSearch = (next: SearchState | null): void => {
      updateSearch(() => next, { relist: true });
    };

    /** The first entry opens on the collection in view; later ones keep the applied query. */
    const beginSearchEdit = (): void => {
      updateSearch((current) => {
        const base = current ?? { query: "", draft: "", scope: modeRef.current, editing: false };
        return { ...base, editing: true, draft: base.query };
      });
    };

    /** Draft edits go through the ref updater so batched keys still apply in order. */
    const editDraft = (update: (draft: string) => string): void => {
      updateSearch((current) =>
        current?.editing === true ? { ...current, draft: update(current.draft) } : current,
      );
    };

    /** Enter applies the draft. A blank draft is not a filter, so it leaves search. */
    const applySearchEdit = (): void => {
      updateSearch(
        (current) => {
          if (current === null || !isSearchQueryActive(current.draft)) {
            return null;
          }
          return { ...current, query: current.draft, draft: current.draft, editing: false };
        },
        { relist: true },
      );
    };

    /** Esc reverts the draft to the applied query, or leaves search when none was applied. */
    const cancelSearchEdit = (): void => {
      const current = searchRef.current;
      if (current === null) {
        return;
      }
      if (!isSearchQueryActive(current.query)) {
        showSearch(null);
        return;
      }
      updateSearch((state) =>
        state === null ? null : { ...state, editing: false, draft: state.query },
      );
    };

    /** Esc from an applied search returns to the collection the search started from. */
    const clearSearch = (): void => {
      showSearch(null);
    };

    /**
     * Tab cycles the search scope while keeping the query, the draft, and
     * whether the draft is open. The re-list uses the applied query only, so a
     * draft that has never been applied still shows the whole target scope.
     */
    const cycleSearchScope = (): void => {
      updateSearch(
        (current) =>
          current === null ? null : { ...current, scope: nextSearchScope(current.scope) },
        { relist: true },
      );
    };

    const refreshItems = (hasStatus = status !== null): InboxItem[] => {
      // The ref, not the render closure: a refresh inside a burst of input
      // events must list the session the last event left behind.
      const nextItems = listForSearch(searchRef.current);
      const nextRows = visibleInboxRows(
        buildInboxGrouping(nextItems),
        collapsedRef.current,
        isSearchQueryActive(searchRef.current?.query ?? ""),
      );
      setItems(nextItems);
      setPosition((current) => {
        const nextFocus = reconcileInboxFocus(nextItems, nextRows, current.focus, current.cursor);
        const nextCapacity = inboxViewportLines(
          stdout.rows,
          selectedMetadataLines(
            itemForFocus(nextItems, nextFocus),
            inboxContentWidth,
            displayConfig,
          ).length,
          hasStatus,
        );
        return nextInboxPosition(current, nextFocus, nextItems, nextRows, nextCapacity);
      });
      return nextItems;
    };

    const showError = (error: unknown): void => {
      setStatus({ text: copyFailureMessage(error), error: true });
    };

    const copy = (id: string, bytes: number | undefined, field?: InboxCopyField): void => {
      void Promise.resolve()
        .then(() => port.copy(id, field))
        .then(
          (report) => setStatus({ text: copySuccessMessage(report, bytes), error: false }),
          (error: unknown) => showError(error),
        );
    };

    const openSelected = (): void => {
      if (effectiveFocus?.kind !== "result") {
        return;
      }
      const item = itemForFocus(items, effectiveFocus);
      if (item === undefined) {
        refreshItems(true);
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
        const item = items.find((candidate) => candidate.id === id);
        setStatus({
          text: applied
            ? `Archived result ${id}.`
            : item?.kind === "pi"
              ? `Pi interaction ${id} cannot be archived.`
              : `Result ${id} is already archived.`,
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
        const item = items.find((candidate) => candidate.id === id);
        setStatus({
          text: applied
            ? `Restored result ${id}.`
            : item?.kind === "pi"
              ? `Pi interaction ${id} cannot be restored.`
              : `Result ${id} is already active.`,
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
            clampScroll(current + step, detailContentLines(detail).length, viewport),
          );
        }
        return;
      }

      if (view === "inbox") {
        if (searchRef.current?.editing === true) {
          // Query editing owns the keyboard: printable input becomes text, so
          // q, a, r, y, j, k, space, and / never reach the action keys below.
          // Each event is split into ordered steps first, because Ink only
          // splits backspace bytes: one event can carry text plus Enter or Tab.
          // Steps run one after another against the state the previous step
          // left behind, and the gate reads the ref for the same reason.
          for (const command of queryCommands(input, key)) {
            switch (command.kind) {
              case "append":
                editDraft((draft) => draft + command.text);
                break;
              case "backspace":
                editDraft(draftWithoutLastCodePoint);
                break;
              case "apply":
                applySearchEdit();
                break;
              case "cycle-scope":
                cycleSearchScope();
                break;
              case "cancel":
                cancelSearchEdit();
                break;
            }
          }
          return;
        }

        // Tab only toggles collections from the inbox, so a detail always
        // returns to the collection it was opened from. An applied search
        // cycles its own scope instead, because "all" is not a collection the
        // plain inbox can show.
        if (key.tab && !key.shift) {
          if (searchRef.current === null) {
            switchMode(modeRef.current === "active" ? "archived" : "active");
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
          if (searchRef.current !== null) {
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
        if (key.leftArrow || key.rightArrow || input === " ") {
          if (searchRef.current !== null && isSearchQueryActive(searchRef.current.query)) {
            return;
          }
          if (effectiveFocus?.kind !== "orchestration") {
            return;
          }
          const orchestrationId = effectiveFocus.orchestrationId;
          const isCollapsed = collapsedRef.current.has(orchestrationId);
          const toggles = input === " ";
          const shouldCollapse = key.leftArrow || (toggles && !isCollapsed);
          const shouldExpand = key.rightArrow || (toggles && isCollapsed);
          if (
            (!shouldCollapse && !shouldExpand) ||
            (key.leftArrow && isCollapsed) ||
            (key.rightArrow && !isCollapsed)
          ) {
            return;
          }
          const nextCollapsed = new Set(collapsedRef.current);
          if (shouldCollapse) {
            nextCollapsed.add(orchestrationId);
          } else {
            nextCollapsed.delete(orchestrationId);
          }
          collapsedRef.current = nextCollapsed;
          setCollapsedOrchestrations(nextCollapsed);
          const nextRows = visibleInboxRows(buildInboxGrouping(items), nextCollapsed, false);
          setPosition((current) =>
            nextInboxPosition(current, effectiveFocus, items, nextRows, inboxCapacity),
          );
          return;
        }
        if (key.return || input === "\r") {
          openSelected();
          return;
        }
        const selected = itemForFocus(items, effectiveFocus);
        if (effectiveFocus?.kind !== "result") {
          return;
        }
        if (input === "y") {
          if (selected === undefined) {
            setStatus({ text: "There are no results to copy.", error: true });
          } else {
            const field = defaultPiCopyField(selected);
            copy(selected.id, copyByteLength(selected, field), field);
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
          clampScroll(current - 1, detailContentLines(detail).length, viewport),
        );
        return;
      }
      if (key.downArrow || input === "j") {
        setScrollOffset((current) =>
          clampScroll(current + 1, detailContentLines(detail).length, viewport),
        );
        return;
      }
      if (key.pageUp) {
        setScrollOffset((current) =>
          clampScroll(current - viewport, detailContentLines(detail).length, viewport),
        );
        return;
      }
      if (key.pageDown) {
        setScrollOffset((current) =>
          clampScroll(current + viewport, detailContentLines(detail).length, viewport),
        );
        return;
      }
      if (detail.kind === "pi" && input === "p") {
        copy(detail.id, copyByteLength(detail, "prompt"), "prompt");
        return;
      }
      if (detail.kind === "pi" && input === "f") {
        if (typeof detail.finalReport !== "string") {
          setStatus({ text: "This Pi interaction has no final report to copy.", error: true });
        } else {
          copy(detail.id, copyByteLength(detail, "finalReport"), "finalReport");
        }
        return;
      }
      if (input === "y") {
        const field = defaultPiCopyField(detail);
        copy(detail.id, copyByteLength(detail, field), field);
        return;
      }
      if (input === "a" && !detail.archived) {
        if (detail.kind === "pi") {
          setStatus({ text: `Pi interaction ${detail.id} cannot be archived.`, error: true });
          return;
        }
        archive(detail.id, true);
        return;
      }
      if (input === "r" && detail.archived) {
        if (detail.kind === "pi") {
          setStatus({ text: `Pi interaction ${detail.id} cannot be restored.`, error: true });
          return;
        }
        restore(detail.id, true);
      }
    });

    if (view === "result" && detail !== null) {
      return h(ResultView, {
        detail,
        scrollOffset,
        status,
        onCopy: () => {
          const field = defaultPiCopyField(detail);
          copy(detail.id, copyByteLength(detail, field), field);
        },
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
      rows: inboxRows,
      cursor: effectiveCursor,
      focus: effectiveFocus,
      collapsedOrchestrations,
      width: inboxWidth,
      mode,
      status,
      search: searchView,
      displayConfig,
      offset: visibleListOffset,
      limit: inboxCapacity,
      onOpen: openSelected,
      onCopy: () => {
        const item = itemForFocus(items, effectiveFocus);
        if (item !== undefined) {
          copy(item.id, undefined);
        }
      },
      onArchive: () => {
        const item = itemForFocus(items, effectiveFocus);
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

/** One ordered step the query line performs while it owns the keyboard. */
type QueryCommand =
  | { kind: "append"; text: string }
  | { kind: "backspace" }
  | { kind: "apply" }
  | { kind: "cycle-scope" }
  | { kind: "cancel" };

/**
 * Split one Ink input event into the ordered steps the query line acts on.
 *
 * Ink splits only backspace bytes out of a chunk, so one event can carry text
 * plus Enter or Tab, and its key flags describe the whole event: `key.return` is
 * false for `"alpha\r"` and true only for the bare key. Embedded control
 * characters therefore drive the same steps as the bare keys, and the flags are
 * trusted only when the event carries no text of its own. Japanese and emoji
 * survive because the printable run is consumed by code point.
 */
function queryCommands(input: string, key: Key): QueryCommand[] {
  if (isMouseReport(input) || key.ctrl || key.meta) {
    return [];
  }
  // Escape never applies half an event: it cancels the whole thing.
  if (input.includes("\u001b") || (input.length === 0 && key.escape)) {
    return [{ kind: "cancel" }];
  }

  if (input.length === 0) {
    if (key.return) {
      return [{ kind: "apply" }];
    }
    if (key.tab && !key.shift) {
      return [{ kind: "cycle-scope" }];
    }
    return key.backspace || key.delete ? [{ kind: "backspace" }] : [];
  }

  const commands: QueryCommand[] = [];
  let rest = input;
  while (rest.length > 0) {
    const character = rest[0];
    if (character === "\r") {
      commands.push({ kind: "apply" });
      rest = rest.slice(1);
      continue;
    }
    if (character === "\t") {
      commands.push({ kind: "cycle-scope" });
      rest = rest.slice(1);
      continue;
    }
    if (character === "\u007f" || character === "\u0008") {
      commands.push({ kind: "backspace" });
      rest = rest.slice(1);
      continue;
    }

    const run = printableRun(rest);
    if (run.text.length === 0) {
      // A control byte with no query meaning: drop the rest of the event.
      break;
    }
    commands.push({ kind: "append", text: run.text });
    rest = run.rest;
  }

  return commands;
}

/** Longest leading printable run, consumed by code point so pastes stay whole. */
function printableRun(input: string): { text: string; rest: string } {
  let text = "";
  let consumed = 0;
  for (const character of input) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      break;
    }
    text += character;
    consumed += character.length;
  }
  return { text, rest: input.slice(consumed) };
}

/** Remove one code point, so a pasted surrogate pair is never cut in half. */
function draftWithoutLastCodePoint(draft: string): string {
  const characters = [...draft];
  characters.pop();
  return characters.join("");
}

function nextSearchScope(scope: InboxScope): InboxScope {
  if (scope === "active") {
    return "archived";
  }
  return scope === "archived" ? "all" : "active";
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
  nextFocus: InboxFocus | null,
  items: readonly InboxItem[],
  rows: readonly InboxDisplayRow[],
  capacity: number,
): InboxPosition {
  const focus = reconcileInboxFocus(items, rows, nextFocus, current.cursor);
  const cursor = cursorForFocus(items, focus, current.cursor);
  const selectedRow = Math.max(0, displayRowIndexForFocus(rows, focus));
  const listOffset = clampListOffset(
    listOffsetForCursor(selectedRow, current.listOffset, capacity),
    rows.length,
    capacity,
  );
  if (
    cursor === current.cursor &&
    focusEqual(focus, current.focus) &&
    listOffset === current.listOffset
  ) {
    return current;
  }
  return { cursor, focus, listOffset };
}

function focusEqual(left: InboxFocus | null, right: InboxFocus | null): boolean {
  return (
    left?.kind === right?.kind &&
    (left === null ||
      right === null ||
      (left.kind === "result" && right.kind === "result"
        ? left.resultId === right.resultId
        : left.kind === "orchestration" &&
          right.kind === "orchestration" &&
          left.orchestrationId === right.orchestrationId))
  );
}

function clampScroll(offset: number, lineCount: number, viewport: number): number {
  const maxOffset = Math.max(0, lineCount - Math.max(1, viewport));
  return Math.min(Math.max(0, offset), maxOffset);
}

function defaultPiCopyField(item: InboxItem): InboxCopyField | undefined {
  if (item.kind !== "pi") {
    return undefined;
  }
  return typeof item.finalReport === "string" ? "finalReport" : "prompt";
}

function copyByteLength(
  item: InboxItem | InboxDetail,
  field: InboxCopyField | undefined,
): number | undefined {
  if (field === "prompt") {
    return Buffer.byteLength(item.submittedPrompt ?? "", "utf8");
  }
  if (field === "finalReport") {
    return typeof item.finalReport === "string"
      ? Buffer.byteLength(item.finalReport, "utf8")
      : undefined;
  }
  return "rawText" in item ? Buffer.byteLength(item.rawText, "utf8") : undefined;
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
