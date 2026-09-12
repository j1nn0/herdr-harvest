/**
 * Mouse-wheel reporting for the Result Inbox.
 *
 * The inbox turns on the terminal's mouse reporting (DECSET 1000) with SGR
 * coordinates (DECSET 1006), so wheel gestures arrive in the pane as
 * `ESC[<Cb;x;yM` reports instead of being swallowed by the terminal. Ink's
 * `useInput` channel hands each report to the app as a string with the leading
 * escape already stripped (`[<65;1;1M`), which is what `parseWheelEvent`
 * classifies.
 *
 * Reporting is deliberately narrow: only vertical wheel reports navigate the
 * inbox. Presses, releases, drags, and horizontal wheels are ignored, so a
 * click or drag inside the pane stays inert and cannot quit, copy, archive, or
 * move the selection.
 */

/** Results or lines moved by a single wheel report. */
export const WHEEL_STEP = 3;

export type WheelDirection = "up" | "down";

/**
 * The bytes sink the lifecycle helpers write to. `isTTY` is optional because
 * plain objects (tests) and some streams do not expose it.
 */
export interface WheelOutput {
  write(chunk: string): unknown;
  isTTY?: boolean;
}

const ESCAPE = "\u001B";

/** Enable mouse reporting first, then SGR coordinates. */
export const WHEEL_ENABLE_SEQUENCES: readonly string[] = [`${ESCAPE}[?1000h`, `${ESCAPE}[?1006h`];

/** Disable in the reverse order of `WHEEL_ENABLE_SEQUENCES`. */
export const WHEEL_DISABLE_SEQUENCES: readonly string[] = [`${ESCAPE}[?1006l`, `${ESCAPE}[?1000l`];

/**
 * A wheel `Cb` is `64` (up) or `65` (down) plus the Shift (4), Meta (8), and
 * Control (16) bit. Anything else — base buttons, the motion bit (32), the
 * horizontal wheels (66/67), extra buttons (128+) — is not a vertical wheel.
 */
const WHEEL_UP_BUTTONS: ReadonlySet<number> = new Set([64, 68, 72, 76, 80, 84, 88, 92]);
const WHEEL_DOWN_BUTTONS: ReadonlySet<number> = new Set([65, 69, 73, 77, 81, 85, 89, 93]);

/** One complete SGR report, escape already stripped: `[<Cb;x;yM`. */
const WHEEL_REPORT_PATTERN = /^\[<(\d+);(\d+);(\d+)M$/;

/**
 * Classify one complete SGR mouse report at the byte level, e.g. the raw
 * `ESC[<64;31;11M` sequence. The leading escape is optional so both the raw
 * sequence and Ink's already-stripped string are accepted.
 */
export function parseWheelReport(report: string): WheelDirection | null {
  return classifyStrippedReport(stripEscape(report));
}

/**
 * Classify one `useInput` string. Ink strips a single leading escape from the
 * report, so the common shape is `"[<64;31;11M"`; the unstripped form is
 * accepted too. Anything that is not exactly one wheel report returns `null`
 * and must fall through to the normal key handling.
 */
export function parseWheelEvent(input: string): WheelDirection | null {
  return classifyStrippedReport(stripEscape(input));
}

function stripEscape(sequence: string): string {
  return sequence.startsWith(ESCAPE) ? sequence.slice(1) : sequence;
}

function classifyStrippedReport(report: string): WheelDirection | null {
  const button = WHEEL_REPORT_PATTERN.exec(report)?.[1];
  if (button === undefined) {
    return null;
  }
  return wheelDirectionForButton(Number(button));
}

/**
 * Start reporting mouse events, wheel reports included. Best effort: a
 * non-TTY stdout or a failing write never stops the inbox from opening.
 */
export function enableWheelReporting(stdout: WheelOutput): void {
  writeSequences(stdout, WHEEL_ENABLE_SEQUENCES);
}

/**
 * Stop reporting. Safe to call more than once, which is why it belongs in the
 * single `finally` that owns the inbox lifecycle.
 */
export function disableWheelReporting(stdout: WheelOutput): void {
  writeSequences(stdout, WHEEL_DISABLE_SEQUENCES);
}

function wheelDirectionForButton(button: number): WheelDirection | null {
  if (WHEEL_UP_BUTTONS.has(button)) {
    return "up";
  }
  if (WHEEL_DOWN_BUTTONS.has(button)) {
    return "down";
  }
  return null;
}

function writeSequences(stdout: WheelOutput, sequences: readonly string[]): void {
  if (stdout.isTTY === false) {
    return;
  }
  for (const sequence of sequences) {
    try {
      stdout.write(sequence);
    } catch {
      // Best effort: keep going so one failing write cannot leave reporting
      // half-enabled, and never let a terminal error escape the lifecycle.
    }
  }
}
