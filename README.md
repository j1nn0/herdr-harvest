# Harvest

> Harvest the results of your agent herd.

A [Herdr](https://herdr.dev) plugin that captures an AI coding agent's terminal output the moment it finishes, and keeps it in a durable Result Inbox you can read, copy, and archive later.

## What it does

When an agent running in a Herdr pane finishes, Harvest:

1. reads that pane's recent terminal output,
2. stores it in SQLite along with the agent, pane, workspace, and native session identity,
3. and surfaces it in a keyboard-driven inbox.

"Finishes" is less obvious than it sounds. Herdr reports a finished agent as `done`
while its result is still *unseen*; when the completion lands on a pane you are
already looking at, it can arrive as `idle` instead. Harvest recognises both, so a
result is not lost just because you happened to be watching.

It does this without focusing the agent's pane and without marking the agent as seen, so Herdr's own attention model is left exactly as it was.

## Why it exists

When several agents finish while you are looking at something else, their results are stranded. Getting one back means switching to the right tab, finding the right pane, scrolling to the right place, and hand-selecting terminal text — and if the agent has since exited, its scrollback may be gone entirely.

Harvest turns "go back and find it" into "open the inbox".

## Completion snapshot, not a final answer

This is the most important thing to understand about Harvest v0.1.

What Harvest stores is a **completion snapshot**: the last N rendered rows of the pane at the moment the agent finished. It is *not* a parsed final assistant message.

That means a snapshot typically contains the agent's closing output *plus* whatever else was on screen — the agent's own UI chrome, status bars, banners, and part of the preceding conversation. Harvest deliberately does not try to guess where the assistant's final message begins and ends.

This is a design choice, not a limitation to be fixed later by heuristics. Captured raw evidence is verifiable and never silently wrong; an inferred "final response" is neither. Harvest preserves the text exactly as Herdr returns it after Herdr's normal ANSI stripping.

## Requirements

- Herdr **v0.8.2** or newer (release hardening for v0.1.0 was live-tested against Herdr 0.9.0)
- **Node.js 24+** on `PATH` (Harvest runs TypeScript directly via Node's type stripping — there is no build step)

## Installation

Install directly from GitHub:

```bash
herdr plugin install j1nn0/herdr-harvest
```

Herdr fetches the repository, runs the build step the manifest declares, which installs Harvest's runtime dependencies, and then registers the plugin. There is nothing to compile and nothing to install by hand.

Verify it registered:

```bash
herdr plugin list --plugin j1nn0.herdr-harvest --json
```

## Local development

Work from a checkout instead when you are changing Harvest itself:

```bash
git clone https://github.com/j1nn0/herdr-harvest
cd herdr-harvest
npm install
herdr plugin link "$PWD"
```

`herdr plugin link` registers the manifest at its current path and never copies, symlinks, or builds anything, so the plugin runs straight from this working tree. That is why **`npm install` is required before linking** — unlike `herdr plugin install`, nothing runs the build step for you, and a linked plugin must already be runnable.

Edits to `src/` then take effect on the next hook or pane launch with no rebuild and no re-link.

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

Harvest also ships a manual capture path for deterministic testing, so you do not have to wait for an agent to finish on its own:

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
● claude    4fe228   herdr-harvest     ago 1m   2+2 equals 4.
● claude    751178   herdr-harvest     ago 8m   Added the adoption note to the…
  explorer  c76a0f   herdr-plugin-sdk  ago 12m  All 47 tests pass…
Herdr: default
Pane: π - herdr-harvest
↑/↓ or k/j move · Enter open · y copy · a archive · q/Esc quit
```

The six characters after the agent are the **agent session** — the thing that tells
two otherwise identical rows apart. The first two rows above are the same agent in
the same workspace, but different Claude sessions.

It is derived from the native session Herdr already reports, for display only: the
start of the session id where the agent has one, and a stable hash otherwise, so a
session file path never ends up in the row. When Herdr does not report a native agent session, the label starts with `~` and
uses a stable hash derived from the source pane context, so different panes normally remain distinguishable. The `~` marks it as a
fallback rather than a native session id.

The Herdr session and the pane's terminal title sit under the list, for the selected
result only. Terminal titles often carry quota, context size, and branch text, which
says nothing about which result you are looking at, so they no longer compete for row
space.

Rows adapt to the pane width. As it narrows, the preview goes first, then the age,
then the workspace; the agent and its session id are the last things to go, and the
metadata lines disappear once there is no room for them.

**Inbox**

| Key                     | Action                          |
| ----------------------- | ------------------------------- |
| `↑` / `↓`, `k` / `j`    | Move one result                 |
| `PageUp` / `PageDown`   | Move one page                   |
| `Enter`                 | Open the result (marks it read) |
| `y`                     | Copy the result                 |
| `a`                     | Archive the result              |
| `q` / `Esc`             | Close the inbox                 |

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
  → src/bin/hook.ts             process adapter; never crashes Herdr
        └─ SDK readPluginEvent  validate the envelope (throws on a broken payload)
  → src/capture/completion.ts   Harvest policy: is this a completion we capture?
  → src/capture/orchestrator.ts
        ├─ src/herdr/           project SDK agent/pane payloads into capture metadata
        └─ src/persistence/     hash, dedup, insert in one transaction
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

The SDK's `HerdrClient` is the only thing that spawns Herdr, which is what lets the whole test suite run with **no Herdr server** — tests drive `createMockHerdrClient()` from `@j1nn0/herdr-plugin-sdk/testing` instead.

### Built on the plugin SDK

Harvest talks to Herdr through [`@j1nn0/herdr-plugin-sdk`](https://www.npmjs.com/package/@j1nn0/herdr-plugin-sdk), alongside Ink and React. There are three layers, and it is worth keeping them apart:

- **Herdr Plugin v1** is the official API: a command-based contract of manifest entrypoints, environment variables, and CLI commands.
- **`@j1nn0/herdr-plugin-sdk`** is an unofficial typed TypeScript convenience layer over that contract. It validates the Herdr runtime and event payloads, executes Herdr CLI calls, and exposes typed errors.
- **Harvest** is an application built on that layer. It decides which observed lifecycle transitions count as a completion, and owns capture policy, metadata projection, the read fallback, deduplication, storage, clipboard, and the inbox.

So Harvest ships no Herdr subprocess handling and no protocol parsing of its own.

### Deciding what counts as a completion

Harvest tracks the previous agent status per Herdr session and pane, so that it can recognise a `working → idle` transition without treating every `idle` as a completion. That state is persisted rather than held in memory, because each event hook runs as a separate process.

The rules it applies:

| Incoming | Previously observed | Capture? |
| -------- | ------------------- | -------- |
| `done`   | anything but `done` | yes — `done` follows real work |
| `done`   | `done`              | no — duplicate delivery |
| `idle`   | `working`           | yes — a completion you were already watching |
| `idle`   | anything else       | no — startup, pane reuse, or an already-seen result |
| other    | —                   | no, but the status is recorded |

This matters because a bare `idle` proves nothing on its own: starting an agent produces one, and so does starting a replacement agent in a reused pane. Capturing every `idle` would invent results. Reading the previous status and recording the new one happen together in a single transaction, so two hook processes handling the same event cannot both conclude they saw `working` first.

`blocked` is deliberately not treated as work in progress. Herdr uses it for an approval or question prompt, so `blocked → idle` may equally mean you cancelled. Missing that rare completion is better than fabricating a result you never got.

### Deduplication

Herdr gives no event ids and no delivery guarantees, so the same completion can arrive more than once. Harvest therefore derives a deterministic key rather than trusting delivery:

- **With** a native agent session id or path: `sha256(session identity + content hash)`.
- **Without** one: `sha256(workspace + pane + agent kind + content hash)`.

Components are length-prefixed before hashing so a value containing the separator cannot forge a different key. The key carries a `UNIQUE` index, and inserts use `INSERT … ON CONFLICT DO NOTHING` inside a `BEGIN IMMEDIATE` transaction with read-back, so two hook processes finishing simultaneously still produce exactly one row and neither fails.

## Current limitations

- **Snapshots include surrounding screen content.** See [Completion snapshot, not a final answer](#completion-snapshot-not-a-final-answer).
- **Identical output for the same agent session dedupes to one result.** If an agent genuinely produces byte-identical output twice in one session, the second is treated as a redelivery. Content-hash dedup cannot distinguish those cases.
- **Capture is bounded by what Herdr can still see.** Full-screen agents draw in the terminal's alternate screen; Harvest captures while the agent is still alive, but rows already scrolled out of reach are not recoverable.
- **A completion straight out of `blocked` is not captured.** If an agent finishes so quickly after you answer an approval prompt that Herdr never reports `working` in between, that result is missed. See [Deciding what counts as a completion](#deciding-what-counts-as-a-completion) for why that trade is deliberate.
- **OSC 52 delivery cannot be confirmed.** It is reported as unconfirmed rather than as success.
- **No archived-results view.** Archiving hides a result from the inbox; reading it back means querying the database directly.
- **Herdr must be running** for capture to happen at all — there is no offline backfill.

## Non-goals for v0.1

No LLM calls, no AI summaries, no agent-specific final-response parsing, no diff or test-result analysis, no notifications, no cross-agent handoff, no cloud sync, and no web UI.

## License

MIT — see [LICENSE](LICENSE).
