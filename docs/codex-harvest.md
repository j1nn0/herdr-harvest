# Experimental Codex Harvest integration

Codex collection is an opt-in experimental path. It observes the native Codex
hook lifecycle and writes completed interactions to the same `harvest.db` used
by the Harvest Inbox. It does not change Codex prompts, messages, tools,
retries, or continuation behavior, and it does not send data outside the local
machine.

This integration is verified for **codex-cli 0.154.0 only**. Other Codex
versions are unverified and must not be treated as supported without a new
verification run. macOS is the verified runtime platform; Linux and Windows
live hook behavior is unverified.

## Prerequisites

- Node.js 24 or newer, as required by this repository.
- Codex **0.154.0**, the only Codex version verified for this integration.
- A working, already-authorized Codex installation. Harvest never copies or
  modifies Codex credentials.
- A checked-out Harvest tree with dependencies installed.
- A state directory. In a Herdr-managed run this is normally supplied as
  `HERDR_PLUGIN_STATE_DIR`; for an explicit local run, set
  `HARVEST_STATE_DIR` to a directory you control.

This is a user-global setup. The user-level Codex hooks can affect standalone
Codex processes for that user, not only Herdr-launched processes. It does not
replace `CODEX_HOME`, edit project configuration, or transmit data outside the
local machine.

## Activate collection

Activation has one setup step, one manual notify configuration step, and one
launching-environment requirement. Setup is additive and preserves unrelated
Codex hook groups and handlers.

### 1. Install the Harvest hook set once

From the Harvest checkout, run:

```bash
node src/bin/codex-setup.ts install
node src/bin/codex-setup.ts status
```

The command defaults to the current user's home directory. It writes only the
Harvest-owned groups in `~/.codex/hooks.json`, copies the required runtime
files under `~/.codex/herdr-harvest/`, and records ownership hashes in its
manifest. Hook command paths are absolute because Codex runs hooks with the
session directory as its working directory. Reinstall is idempotent; modified
Harvest-owned or foreign content is refused rather than overwritten. Existing
Codex hook groups and handlers remain in place.

The setup command does **not** edit `~/.codex/config.toml`. It prints the exact
top-level `notify = [...]` line for the installed support directory. Merge
that line into the top-level `notify` array in `config.toml`, preserving any
existing notify entries. Do not create a second top-level `notify` key. The
`status` command detects the exact Harvest entry, and `uninstall` leaves this
user configuration untouched so the line can be removed deliberately.

The notify command is the user-level legacy `agent-turn-complete` adapter. It
does not require a trust review. `UserPromptSubmit` and `Stop` command hooks do
require review and trust in Codex's `/hooks` UI. Setup cannot grant that trust;
after installation, review the two Harvest command groups there and confirm
that their status is trusted before collecting.

### 2. Export the opt-in and state directory in the launching environment

In each shell, launcher, or pane environment that should collect, set:

```bash
export HARVEST_CODEX_COLLECT=1
export HARVEST_STATE_DIR="$HOME/.local/state/herdr-harvest"
```

Alternatively, set `HERDR_PLUGIN_STATE_DIR`; `HARVEST_STATE_DIR` takes
precedence when both are set. The exact opt-in value is `1`. A new Codex pane
or standalone Codex process automatically sees the user-level hook setup after
this one-time installation and environment setup; there is no per-pane hook
configuration or forwarding step. The environment still has to be present in
the launcher that starts the process.

Changes to hooks, trust, notify configuration, or the environment affect new
Codex processes only. Restart already-running Codex processes after enabling,
changing, or uninstalling the setup.

Symlinked setup paths are supported: entrypoints compare the real module path,
so stow- or dotfiles-managed ancestor directories do not cause silent no-ops.

## Open and use the Inbox

Start a new Codex process normally after the activation steps. Open the
existing Harvest Inbox through the normal Harvest/Herdr action:

```bash
herdr plugin action invoke j1nn0.herdr-harvest.open
```

Completed Codex interactions appear as `Codex · Completed`. A detail has
separate `PROMPT` and `FINAL REPORT` sections. In the detail view, `p` copies
the exact submitted prompt and `f` copies the exact final report; `y` uses the
default Codex copy behavior. Copies preserve the stored bytes, including
whitespace, newlines, and Unicode. Codex rows are searchable by prompt and
report text and are not archivable.

## Disable and uninstall

To stop future collection without removing existing rows, unset the opt-in or
set it to any value other than the exact string `1` in the launching
environment:

```bash
unset HARVEST_CODEX_COLLECT
# Or: export HARVEST_CODEX_COLLECT=0
```

The hooks become no-ops when the opt-in is disabled. Existing database rows
remain readable in the Inbox. Restart already-running Codex processes after
changing the variable.

To remove the user-global Harvest hook and support-file installation, run:

```bash
node src/bin/codex-setup.ts uninstall
node src/bin/codex-setup.ts status
```

Uninstall removes only Harvest-owned groups and files whose ownership hashes
still match. It refuses modified or foreign content, leaves unrelated Codex
hooks untouched, and does not remove database rows. Because setup does not
edit `config.toml`, remove the exact Harvest notify entry there manually when
you no longer want it. Restart Codex after uninstalling.

## Database and upgrade safety

Codex completed rows reuse the existing `pi_interactions` table in
`<state directory>/harvest.db`. There is **no new table and no migration**;
`PRAGMA user_version` remains **5**. Codex staging uses pending rows in that
existing table until the notify commit trigger arrives. Do not delete or
rewrite the table to enable this integration.

## Collection contract

The collector uses only the native Codex lifecycle:

1. `UserPromptSubmit` receives the original prompt on hook stdin and records
   it exactly as `submittedPrompt`.
2. `Stop` receives `last_assistant_message` on hook stdin. It records a
   provisional report, with the last Stop winning when a continuation fires;
   this is not finality.
3. The user-level legacy `agent-turn-complete` notify receives its JSON payload
   as the final command-line argument. It is the only commit trigger.

The submit, Stop, and notify events must share the same `session_id` and
`turn_id`. A completed row is committed only when a prompt and provisional
report exist and the provisional report is byte-identical to the notify's
`last-assistant-message`. The persisted completed fields are:

| Field | Codex value |
| --- | --- |
| `submittedPrompt` | Exact original `UserPromptSubmit.prompt` text |
| `effectivePrompt` | `null` for Codex native-hook collection |
| `finalReport` | Exact final assistant message confirmed by notify |
| `sessionId` | Native Codex session identifier |
| `interactionId` | Stable hash of the Codex-native session/turn identity |
| `status` | `completed` |
| `reason` | `null` for a completed row |
| `provenance` | `codex-native-hooks` |

Intermediate responses, transcripts, tool output, and unrelated messages are
never used as reports. Duplicate deliveries are idempotent. Conflicting
prompts, reports, or notify content are rejected without overwriting stored
content. Subagent and internal-turn notifies without a matching pending turn
are discarded.

Veto, error, interruption, or crash paths do not emit the commit notify. They
therefore remain incomplete and are intentionally under-captured rather than
misidentified as completed interactions. Pending rows currently have no time
column, so automatic stale-pending sweep/prune is not implemented; an
explicit future prune operation is required before stale cleanup can be added.

## Privacy and failure behavior

Only the submitted prompt, final report, and minimal identity, status, and
provenance metadata are persisted. Tool input/output, terminal text,
transcripts, status bars, token counts, intermediate messages, credentials,
and reasoning traces are not product data and are not persisted. State
directories are created with mode `0700` and files with mode `0600` where the
platform permits. Hook success is silent; diagnostics contain only codes,
lengths, hashes, or identifiers, never prompt or report bodies.

The hook is observer-only and fail-closed for attribution. A collector failure
does not instruct, block, or forward work to the Codex agent; it can result in
under-capture. No terminal scraping, transcript parsing, or model extraction
fallback is used.

## Known limitations

- Codex **0.154.0** is the only supported/verified version. Other versions
  may change hook fields or lifecycle timing and are unverified.
- macOS is the tested live platform. Linux and Windows live hook behavior is
  unverified; automated tests are not a substitute for live platform evidence.
- Stop is provisional and notify is the only commit trigger. Veto, error,
  interruption, crash, or a missing notify can leave an incomplete pending
  row; this is deliberate under-capture.
- Automatic stale pending cleanup is not implemented because the reused table
  has no staging timestamp. An explicit prune operation is future work.
- The setup command does not modify `config.toml`; the printed top-level
  notify entry must be merged manually and must not be duplicated.
- Hook entrypoints resolve their real module path, so user-level setup remains
  usable when a stow- or dotfiles-managed ancestor directory is symlinked.
- System-clipboard delivery was not live-verified for Codex. Automated
  service-level copy tests verify exact text using a fake clipboard provider.
- No Herdr-mediated live Codex run is claimed by the automated checks. A
  service-level Inbox test is not a real TTY interaction.

## Tests and verification

Focused Codex checks:

```bash
node --test tests/codex-collector-contract.test.ts
node --test tests/codex-staging.test.ts
node --test tests/codex-inbox.test.ts
node --test tests/codex-setup.test.ts
```

Repository checks:

```bash
npm run check
git diff --check
```

The production-path synthetic E2E should invoke the three production adapters
with synthetic 0.154.0-shaped hook payloads in a disposable state directory,
then independently check `harvest.db` and the Inbox service. Assert exact
prompt/report bytes, IDs, statuses, and copy results, but report only byte
lengths and hashes. This is `AUTOMATED_TEST_ONLY`, not proof of a live Codex
turn. A real direct Codex run is `LIVE_VERIFIED` only when Codex actually runs
with the verified version and the persisted fields are independently matched.

## Direct and mediated E2E evidence

The repository tests cover the production hook, staging, commit, persistence,
Inbox, and setup boundaries with synthetic content. The following live evidence
was verified by the orchestrator on 2026-09-17 with codex-cli **0.154.0** on
macOS, an already-authorized ChatGPT login, disposable non-symlinked state
roots, the production `codex-setup.ts` support files, and synthetic prompts.
No prompt or response bodies are recorded here beyond the short single-line
markers the synthetic prompts requested; byte lengths and hashes were compared
independently during the runs.

### Direct production runs (`LIVE_VERIFIED`)

Three consecutive turns in one session through `codex exec` / `exec resume
--last` with the production adapters (`submit-hook.ts`, `stop-hook.ts`,
`notify-commit.ts`) and `HARVEST_CODEX_COLLECT=1`:

- All three submitted prompts matched byte-for-byte; all three final reports
  matched byte-for-byte (`PROD1-OK`, `PROD2-OK`, `PROD3-OK`), including the
  read-tool turn with no tool-output contamination.
- One Codex session, three distinct turn identities, three `completed` rows,
  no duplicates, `user_version` stayed `5`, no pending rows for these turns.
- A fourth `pending` row held an internal memory-consolidation prompt
  (`## Memory Writing Agent ...`, 52,406 bytes) with no provisional and no
  commit: persistence failed closed as designed. The Inbox fix in this branch
  keeps pending rows out of listing, open, copy, archive, and search.
- Production `harvest.db` and the production Inbox service were checked
  independently; prompt/report copy returned the exact stored bytes.

### Herdr-mediated production runs (`LIVE_VERIFIED`)

Two consecutive prompts in one Herdr-launched interactive Codex pane using
the same production adapters, with no Harvest instructions to the working
agent and no orchestrator forwarding:

- Both submitted prompts matched byte-for-byte; both final reports matched
  byte-for-byte (`HPROD1-OK`, `HPROD2-OK`).
- Same session, two distinct turn identities, two `completed` rows, no
  duplicates, no cross-pane association. The Inbox listed five completed
  Codex rows across the two live sessions.

### Not live-verified (`UNVERIFIED`)

- Real-TTY interactive Inbox driving and system-clipboard delivery (service
  level is `AUTOMATED_TEST_ONLY` via a fake clipboard provider).
- Linux/Windows live hook behavior; other Codex versions.
- A procedure alone is not live E2E success; record future runs in these
  same categories.
