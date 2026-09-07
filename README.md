# Harvest

> Harvest the results of your agent herd.

A [Herdr](https://herdr.dev) plugin that captures an AI coding agent's terminal output the moment it finishes, and keeps it in a durable Result Inbox you can read, copy, and archive later.

## What it does

When an agent running in a Herdr pane transitions to `done`, Harvest:

1. reads that pane's recent terminal output,
2. stores it in SQLite along with the agent, pane, workspace, and native session identity,
3. and surfaces it in a keyboard-driven inbox.

It does this without focusing the agent's pane and without marking the agent as seen, so Herdr's own attention model is left exactly as it was.

## Why it exists

When several agents finish while you are looking at something else, their results are stranded. Getting one back means switching to the right tab, finding the right pane, scrolling to the right place, and hand-selecting terminal text — and if the agent has since exited, its scrollback may be gone entirely.

Harvest turns "go back and find it" into "open the inbox".

## Completion snapshot, not a final answer

This is the most important thing to understand about Harvest v0.1.

What Harvest stores is a **completion snapshot**: the last N rendered rows of the pane at the moment the agent reached `done`. It is *not* a parsed final assistant message.

That means a snapshot typically contains the agent's closing output *plus* whatever else was on screen — the agent's own UI chrome, status bars, banners, and part of the preceding conversation. Harvest deliberately does not try to guess where the assistant's final message begins and ends.

This is a design choice, not a limitation to be fixed later by heuristics. Captured raw evidence is verifiable and never silently wrong; an inferred "final response" is neither. Harvest preserves the text exactly as Herdr returns it after Herdr's normal ANSI stripping.

## Requirements

- Herdr **v0.8.2** or newer
- **Node.js 24+** on `PATH` (Harvest runs TypeScript directly via Node's type stripping — there is no build step)

## Installation

```bash
git clone https://github.com/j1nn0/herdr-harvest
cd herdr-harvest
npm install
herdr plugin link "$PWD"
```

`herdr plugin link` registers the manifest at its current path and never copies, symlinks, or builds anything, so the plugin runs straight from this working tree. That also means **`npm install` is required before linking** — a linked plugin must already be runnable.

Verify it registered:

```bash
herdr plugin list --plugin j1nn0.herdr-harvest --json
```

## Local development

The linked plugin runs from your checkout, so edits to `src/` take effect on the next hook or pane launch with no rebuild and no re-link.

```bash
npm run check      # typecheck + lint + tests
npm run typecheck
npm run lint
npm run format
npm test
```

Re-link only after editing `herdr-plugin.toml` itself:

```bash
herdr plugin unlink j1nn0.herdr-harvest && herdr plugin link "$PWD"
```

Because event hooks only fire inside a running Herdr server, the fastest way to see what a hook did is:

```bash
herdr plugin log list --plugin j1nn0.herdr-harvest --limit 5
```

Harvest also ships a manual capture path for deterministic testing, so you do not have to wait for a real `done`:

```bash
node src/bin/capture.ts --pane <pane-id>
```

It is intentionally a plain script rather than a declared plugin action, so it adds no user-facing surface.

## Opening the inbox

Via the plugin action:

```bash
herdr plugin action invoke j1nn0.herdr-harvest.open
```

Or bind a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+h"
type = "plugin_action"
command = "j1nn0.herdr-harvest.open"
description = "Open Harvest inbox"
```

Apply it with `herdr server reload-config`.

## Using the Result Inbox

The inbox opens as a Herdr overlay, listing unread results first and newest first.

```
Harvest Result Inbox · 3 results
Unread results stay at the top; select one to inspect it.
● smoketest   herdr-harvest / π - herdr-harvest   ago 1m   2+2 equals 4.
  claude      api / server                        ago 12m  All 47 tests pass…
↑/↓ or k/j move · Enter open · y copy · a archive · q/Esc quit
```

**Inbox**

| Key            | Action                          |
| -------------- | ------------------------------- |
| `↑`/`↓`, `k`/`j` | Move the selection            |
| `Enter`        | Open the result (marks it read) |
| `y`            | Copy the result                 |
| `a`            | Archive the result              |
| `q` / `Esc`    | Close the inbox                 |

**Result view**

| Key                     | Action                |
| ----------------------- | --------------------- |
| `↑`/`↓`, `k`/`j`        | Scroll a line         |
| `PageUp` / `PageDown`   | Scroll a page         |
| `y`                     | Copy                  |
| `a`                     | Archive               |
| `Esc`                   | Back to the inbox     |

### Copying is fail-visible

Harvest tries a real system clipboard tool first (`pbcopy`, `clip.exe`, `wl-copy`, `xclip`, or `xsel`), then falls back to OSC 52.

The status line always tells you which path was used, because the two are not equally trustworthy:

- `Copied 8.56 KB to clipboard (pbcopy)` — the tool exited successfully.
- `Sent 8.56 KB via OSC 52 — delivery not confirmed by the terminal` — the escape sequence was written, but OSC 52 has no acknowledgement, so nothing proves the terminal accepted it.
- On total failure you get the error and every provider that was attempted.

A copy is never reported as a plain success unless it was actually confirmed.

## Data location

Harvest stores everything in one SQLite database inside Herdr's per-plugin state directory:

```
$HERDR_PLUGIN_STATE_DIR/harvest.db
```

which on macOS and Linux is:

```
~/.local/state/herdr/plugins/j1nn0.herdr-harvest/harvest.db
```

Nothing is written to the plugin checkout, and nothing leaves your machine. The database is a plain file independent of the Herdr process, so results survive Herdr restarts. Schema changes are applied by numbered migrations tracked in `PRAGMA user_version`.

### Configuration

| Variable                 | Default            | Meaning                                                        |
| ------------------------ | ------------------ | -------------------------------------------------------------- |
| `HARVEST_CAPTURE_LINES`  | `400`              | Terminal rows to capture (1–10000)                              |
| `HARVEST_CAPTURE_SOURCE` | `recent-unwrapped` | Herdr read source: `visible`, `recent`, `recent-unwrapped`, `detection` |
| `HARVEST_STATE_DIR`      | —                  | Overrides `HERDR_PLUGIN_STATE_DIR`, mainly for tests            |

An invalid value falls back to the default *and* reports a warning on stderr rather than being silently ignored.

## Architecture

The capture pipeline is a straight line, and each stage is replaceable in isolation:

```
Herdr `pane.agent_status_changed`
  → src/bin/hook.ts          process adapter; never crashes Herdr
  → src/events/decode.ts     decode + filter to agent_status == "done"
  → src/capture/orchestrator.ts
        ├─ src/herdr/        agent get → metadata; agent read → text (pane read fallback)
        └─ src/persistence/  hash, dedup, insert in one transaction
  → SQLite
```

and the read path is separate:

```
src/bin/inbox.ts → src/tui/ (Ink) → src/app/inbox-service.ts (InboxPort)
                                        ├─ src/persistence/  ResultStore
                                        └─ src/clipboard/    ClipboardProvider
```

Two boundaries are enforced deliberately:

- **The capture pipeline never imports Ink or React.** Capture works headlessly and is fully testable without a UI.
- **The TUI never imports SQLite or the Herdr client.** It talks only to `InboxPort`, so the entire inbox can be tested against a fake port, and storage or clipboard strategies can change without touching presentation.

The `HerdrClient` interface is the only place that knows Herdr exists, which is what lets the whole test suite run with **no Herdr server**.

### Deduplication

Herdr gives no event ids and no delivery guarantees, so the same completion can arrive more than once. Harvest therefore derives a deterministic key rather than trusting delivery:

- **With** a native agent session id or path: `sha256(session identity + content hash)`.
- **Without** one: `sha256(workspace + pane + agent kind + content hash)`.

Components are length-prefixed before hashing so a value containing the separator cannot forge a different key. The key carries a `UNIQUE` index, and inserts use `INSERT … ON CONFLICT DO NOTHING` inside a `BEGIN IMMEDIATE` transaction with read-back, so two hook processes finishing simultaneously still produce exactly one row and neither fails.

## Current limitations

- **Snapshots include surrounding screen content.** See [Completion snapshot, not a final answer](#completion-snapshot-not-a-final-answer).
- **Identical output for the same agent session dedupes to one result.** If an agent genuinely produces byte-identical output twice in one session, the second is treated as a redelivery. Content-hash dedup cannot distinguish those cases.
- **Capture is bounded by what Herdr can still see.** Full-screen agents draw in the terminal's alternate screen; Harvest captures at `done` while the agent is alive, but rows already scrolled out of reach are not recoverable.
- **OSC 52 delivery cannot be confirmed.** It is reported as unconfirmed rather than as success.
- **No archived-results view.** Archiving hides a result from the inbox; reading it back means querying the database directly.
- **Herdr must be running** for capture to happen at all — there is no offline backfill.

## Non-goals for v0.1

No LLM calls, no AI summaries, no agent-specific final-response parsing, no diff or test-result analysis, no notifications, no cross-agent handoff, no cloud sync, and no web UI.

## License

MIT — see [LICENSE](LICENSE).
