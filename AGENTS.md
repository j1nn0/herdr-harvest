# Repository guidance

## Communication

- Use Japanese only for user-facing communication.
- Use English for all non-user-facing communication and generated artifacts unless the repository, task, or existing content requires another language.
- Use English for agent-to-agent communication, delegation prompts, plans, findings, summaries, intermediate reports, tool-related annotations, code comments, documentation, and commit messages.
- Keep non-user-facing communication concise and information-dense. Do not restate context already available to the receiving agent.
- Preserve the language of existing content when editing it unless the task explicitly requires changing it.

## Project Rules

- Treat captured output as opaque text: preserve `rawText` exactly through CLI reads,
  persistence, detail views, and clipboard copies. Trimming is only for empty-capture
  detection and derived previews.
- Keep the hook non-disruptive and idempotent. Ignore unrelated events silently, report
  malformed event payloads without failing the hook, and return a non-zero status only for an
  actual capture failure or an uncaught setup error.
- Keep native ESM imports explicit (`.ts` suffixes) and use type-only imports where required by
  `verbatimModuleSyntax`.

## Architecture

- Keep `src/bin/*` as thin process adapters. Event parsing belongs in `src/events`, capture
  policy in `src/capture`, Herdr protocol handling in `src/herdr`, storage in `src/persistence`,
  and presentation-independent inbox behavior in `src/app`.
- The capture fallback order is intentional: resolve agent metadata before pane metadata, then
  read agent output before pane output. Workspace-label lookup is best effort; capture and
  persistence are not.
- Deduplication prefers native agent-session identity and falls back to workspace, pane, and
  agent identity. In both cases the exact content hash participates in the key; keep component
  framing collision-safe.
- SQLite writes may race across hook processes. Preserve `busy_timeout` before WAL setup,
  `BEGIN IMMEDIATE`, the unique `dedup_key` index, and conflict-ignore plus read-back semantics.
- Keep the TUI behind `InboxPort`. Opening marks a result read once, archiving is idempotent,
  archived results stay out of the default list, and unread results sort before read results.

## Commands

- Use `npm test -- tests/<area>.test.ts` for focused iteration.

## Testing

- Test behavior at the narrowest owning boundary, then retain an entrypoint test for process
  contracts such as environment variables, stdout/stderr, exit codes, and exact CLI arguments.
- Capture or persistence changes must retain duplicate-event and concurrent cross-process
  coverage; a single-store unit test is not sufficient for SQLite locking behavior.
- Assert exact text for capture and clipboard paths, including whitespace, Unicode, and large
  payloads. Do not weaken these checks to trimmed or normalized comparisons.

## Coupled Changes

- Database schema → append a numbered migration, update `PRAGMA user_version` in the same
  transaction, and extend migration plus persistence tests. Existing migrations remain
  immutable.
- Herdr CLI response or command shape → update the parser, fake client or executable fixtures,
  and the relevant bin-level test together.
- Plugin event, pane, or action entrypoints → keep `herdr-plugin.toml`, `src/bin/*`, and
  entrypoint tests aligned.

- Release → bump `version` in both `package.json` and `herdr-plugin.toml`; the two must not
  drift. There is no CHANGELOG or release workflow yet.
- Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `ci:`, `test:`,
  `chore:`; `feat!:` for breaking changes).

## Validation

- Run `npm run check` after code changes.
