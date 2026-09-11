# Changelog

All notable user-facing changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-11

### Changed

- Improved Result Inbox rows to identify the originating agent session, prioritize useful identity metadata, and adapt cleanly to narrow panes.
- Added one-page PageUp/PageDown navigation to the Result Inbox.
- Kept Result pages stable in narrow panes by preventing long captured lines from consuming multiple display rows.

## [0.1.0] - 2026-09-11

First public release.

### Added

- Automatic capture of an agent's terminal output when it finishes, into a durable Result Inbox.
- Completion detection that covers both background and foreground finishes. Herdr reports a finished agent as `done` while its result is unseen and can report `idle` when you are already looking at the pane; Harvest tracks the previous status per Herdr session and pane so it recognises the second case without treating every `idle` as a completion.
- Completion snapshots stored as exact text: the captured output is preserved byte for byte, including Unicode and large payloads.
- Result metadata for the agent, pane, workspace, and the agent's own native session identity.
- Deduplication that is aware of the Herdr session, so repeated delivery of one completion stores a single result while identical output from two different Herdr sessions stays distinct.
- Agent-level output reads with an automatic fall back to a pane read.
- A keyboard-driven Result Inbox listing unread results first, with a detail view for reading a full snapshot.
- Copying a result to the system clipboard via `pbcopy`, `clip.exe`, `wl-copy`, `xclip`, or `xsel`, falling back to OSC 52. The status line always reports which path was used, and an OSC 52 send is reported as unconfirmed rather than as success.
- Archiving a result to remove it from the inbox.
- A manual capture command for development and diagnostics, so a capture can be triggered without waiting for an agent to finish.
- Configuration through `HARVEST_CAPTURE_LINES`, `HARVEST_CAPTURE_SOURCE`, and `HARVEST_STATE_DIR`, where an invalid value falls back to the default and reports a warning rather than being ignored.
- Storage in a SQLite database inside Herdr's per-plugin state directory, so results survive Herdr restarts. Concurrent hook processes safely share that database.
- Installation directly from GitHub with `herdr plugin install j1nn0/herdr-harvest`; Herdr runs the declared build step and installs the runtime dependencies.
- Support for Linux, macOS, and Windows on Node.js 24 or newer, against Herdr 0.8.2 or newer.
- Herdr integration built on the published [`@j1nn0/herdr-plugin-sdk`](https://www.npmjs.com/package/@j1nn0/herdr-plugin-sdk).

### Known limitations

- A completion snapshot is recent rendered terminal output, not a parsed final assistant message, so it can include agent UI, status bars, and earlier output.
- A completion inferred only from `blocked → idle` is not captured, because that transition can equally mean an approval prompt was cancelled.
- Archived results stay in the database but cannot yet be browsed or restored from the inbox.

[Unreleased]: https://github.com/j1nn0/herdr-harvest/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/j1nn0/herdr-harvest/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/j1nn0/herdr-harvest/releases/tag/v0.1.0
