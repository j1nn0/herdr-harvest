# Experimental Pi Harvest integration

Pi collection is an opt-in experimental path. It observes a Pi session and
writes terminal interactions to the same `harvest.db` used by the Harvest
Inbox. It does not change Pi prompts, messages, tools, retries, or compaction,
and it does not send data outside the local machine.

The implementation was verified with Pi **0.85.1**. Other Pi versions are
unverified and must not be treated as supported without a new verification
run.

## Prerequisites

- Node.js 24 or newer, as required by this repository.
- Pi **0.85.1**, the only Pi version verified for this integration. Other Pi
  versions are unverified.
- A working Pi installation and an already-authorized provider/model.
- A built or checked-out Harvest tree with dependencies installed.
- A Harvest state directory. In a Herdr-managed run this is normally supplied
  as `HERDR_PLUGIN_STATE_DIR`; for an explicit local run, set
  `HARVEST_STATE_DIR` to a directory you control.

This is an experimental, local-only integration. It does not edit Pi's global
configuration, copy credentials, change existing security hooks, or transmit
data outside the local machine.

## Activate collection

Activation has two explicit setup steps. The first installs the observer's
user-global discovery file set once. The second is a manual environment
requirement for every shell or launcher that starts a collecting Pi process.

### 1. Install the Harvest discovery file set once

From the Harvest checkout, run:

```bash
node src/bin/pi-setup.ts install
node src/bin/pi-setup.ts status
```

The command defaults to the current user's home directory. It writes only the
Harvest-owned discovery file, its relative-import support tree, and its
ownership manifest under `~/.pi/agent/extensions/`. Hash verification makes a
repeat install idempotent; an unexpected or modified file is refused rather
than overwritten. Unrelated Pi extension files are left untouched. This is a
user-global discovery installation: every Pi process for that user can see the
file set, regardless of project. It is not a project-scoped auto-install.

Do not also pass the in-repository observer with a second `--extension` flag;
the setup-owned discovery path is the one observer installation.

### 2. Export the opt-in and state directory in the launching shell

In each shell, launcher, or pane environment that should collect, enable the
opt-in:

```bash
export HARVEST_PI_COLLECT=1
```

Use the authoritative plugin state directory reported by the installed Herdr
environment:

```bash
herdr plugin config-dir j1nn0.herdr-harvest
```

When the launcher provides `HERDR_PLUGIN_STATE_DIR`, use that value instead.
The Harvest plugin, Pi observer, Codex hooks, and Inbox must all resolve to
this same state directory. Do not globally export an unrelated
`HARVEST_STATE_DIR`. Set `HARVEST_STATE_DIR` explicitly only in a launcher
that does not provide `HERDR_PLUGIN_STATE_DIR`:

```bash
export HARVEST_STATE_DIR="$(herdr plugin config-dir j1nn0.herdr-harvest)"
```

`HARVEST_STATE_DIR` takes precedence when both variables are set. The
environment still has to be present in the launcher that starts the process;
Herdr does not guarantee that `HERDR_PLUGIN_STATE_DIR` is propagated into
every pane. The observer itself is automatic after both setup steps: start a
new Pi process normally, without a per-interaction capture command or a
per-pane extension flag.

If two state directories already contain databases, back up and reconcile the
data before changing the path. Do not delete the old database; Harvest does
not migrate or delete databases automatically.

Changes to the environment or discovery files affect new Pi processes only.
Restart an already-running Pi process after enabling, disabling, or changing
the setup.

## Open and use the Inbox

Start a new Pi process normally after the two activation steps. Open the
existing Harvest Inbox through the normal Harvest/Herdr action:

```bash
herdr plugin action invoke j1nn0.herdr-harvest.open
```

Eligible interactions are collected automatically. The observer is read-only:
it does not transform prompts, replace messages, invoke tools, send prompts,
or trigger retries or compaction. It starts a local `src/bin/ingest-pi.ts`
process for each terminal record. The ingest process writes to
`<state directory>/harvest.db`, the same database opened by the Inbox.

Pi rows are shown as `Pi · Completed` or `Pi · Failed-incomplete`; pre-existing
Harvest rows remain `Legacy`. A completed Pi detail has separate `PROMPT` and
`FINAL REPORT` sections. In the detail view, `p` copies the exact submitted
prompt and `f` copies the exact final report. `f` is unavailable when a failed
interaction has no final report; `y` uses the existing default copy behavior.
Copies preserve the stored bytes, including whitespace, newlines, and Unicode.

## Disable and uninstall

To stop future collection, unset the opt-in or set it to any value other than
the exact string `1` in the launching environment:

```bash
unset HARVEST_PI_COLLECT
# Or: export HARVEST_PI_COLLECT=0
```

The production observer becomes a no-op when the opt-in is unset, `0`, or
invalid. `src/bin/ingest-pi.ts` also refuses to write while the opt-in is
disabled. Restart already-running Pi processes after changing the variable.
Existing database rows are not removed by disabling collection and remain
readable in the Inbox.

To remove the user-global Harvest discovery file set as well, run:

```bash
node src/bin/pi-setup.ts uninstall
node src/bin/pi-setup.ts status
```

Uninstall removes only files whose ownership hashes still match and refuses a
modified or foreign file. It leaves unrelated Pi extensions and all existing
Harvest rows untouched. Restart Pi processes after uninstalling. For state
backup and migration guidance, see [Upgrade an existing Harvest state safely](#upgrade-an-existing-harvest-state-safely).

## Upgrade an existing Harvest state safely

For a v0.7.0 state, the new code adds `pi_interactions` to the existing
database; it does not create a second database or perform a destructive down
migration. Before an upgrade:

1. Locate the state directory from the same configuration used by Harvest.
   `HARVEST_STATE_DIR` takes precedence over `HERDR_PLUGIN_STATE_DIR`, and the
   database is `<state directory>/harvest.db`:

   ```bash
   STATE_DIR="${HARVEST_STATE_DIR:-${HERDR_PLUGIN_STATE_DIR:-}}"
   test -n "$STATE_DIR"
   DB="$STATE_DIR/harvest.db"
   ```
2. Stop Harvest, Pi, Herdr, and any other process that can read or write this
   database. Do not copy a live WAL database. Create a new owner-only backup
   directory, copy `harvest.db`, and copy its `-wal` and `-shm` sidecars when
   present. Verify every copied file with `cmp` or a SHA-256 hash before
   continuing; keep the original files unchanged.
3. Open the database once with the new code. The following metadata-only check
   constructs the production `PiInteractionStore`, which runs the migration,
   and prints no prompt or report content:

   ```bash
   HARVEST_STATE_DIR="$STATE_DIR" node --input-type=module <<'NODE'
   import { loadConfig } from "./src/config/config.ts";
   import { PiInteractionStore } from "./src/persistence/pi-interaction-store.ts";
   import { openDatabase } from "./src/persistence/database.ts";

   const { config } = loadConfig(process.env);
   const db = openDatabase(config.databasePath);
   new PiInteractionStore(db);
   const userVersion = db.prepare("PRAGMA user_version").get().user_version;
   const legacyRows = db.prepare("SELECT COUNT(*) AS count FROM results").get().count;
   const piRows = db.prepare("SELECT COUNT(*) AS count FROM pi_interactions").get().count;
   console.log(JSON.stringify({ userVersion, legacyRows, piRows }));
   db.close();
   NODE
   ```

4. Verify `userVersion` is `5`, the legacy row count and legacy identifiers
   are unchanged, and every legacy `rawText` and orchestration claim still has
   the same UTF-8 byte length and SHA-256 hash recorded before the upgrade.
   Verify that `pi_interactions` is present. Reopen the database and repeat the
   metadata check to confirm the migration is idempotent.
5. If recovery is needed, stop all writers again and restore the verified
   backup file set. Preserve the failed current database under a new name for
   investigation; do not delete user data and do not attempt a down migration.

## Collection contract

The observer pairs one original `input` event with the next
`before_agent_start` event only when the pairing is unambiguous. The original
submitted text is stored as `submittedPrompt`; the effective post-expansion
text is stored separately as `effectivePrompt` when Pi provides it. Finality
is decided only by an `agent_settled` event guarded by `ctx.isIdle()`. The last
eligible assistant `stop` text blocks are concatenated in order without
trimming. Provisional candidates never reach the database.

Eligible input paths are ordinary direct prompts and other input paths that
produce the same observed `input` and `before_agent_start` lifecycle. The
following paths are intentionally unsupported or never successful:

- direct `steer` or `followUp` calls with no observed prompt segment;
- image-attached prompts;
- ambiguous or unpaired input/before-agent-start events;
- error, aborted, length, or deferred assistant outcomes;
- assistant messages with no text blocks;
- oversized prompt, effective-prompt, final-report, or ingest JSON payloads;
- missing finality, interrupted runs, and session shutdown before a valid
  final response.

These cases produce a truthful failed-incomplete diagnostic or no emitted
interaction when there is no attributable segment. The observer does not parse
transcripts or terminal output, guess from silence, summarize with a model, or
turn an intermediate message into a final report. Herdr-mediated submissions
were verified through the production path with the observer loaded and the
same explicit opt-in. This does not add automatic Herdr plugin lifecycle
support; the per-process/per-pane environment step above still applies.

## Privacy and failure behavior

Only the submitted prompt, optional effective prompt, terminal final report
or failure status/reason, and minimal provenance/identifiers are persisted.
Tool input/output, terminal text, transcripts, status bars, token counts,
intermediate messages, credentials, and reasoning traces are not product data
and are not persisted. The state directory is created with mode `0700` and
database files with mode `0600` where the platform permits. Ingest stdout and
diagnostics contain metadata only, never prompt or report bodies. The
user-global discovery file is visible to every Pi process for that user, but
the exact opt-in gate keeps collection disabled for processes that do not
inherit `HARVEST_PI_COLLECT=1`.

Collection and ingest failures are fail-open to Pi: the agent session is not
blocked or modified. The failure is retained as a collector diagnostic when
possible. Duplicate terminal delivery is idempotent; conflicting content for
one interaction identity is rejected without overwriting the existing row.

## Known limitations

- There is no fully automatic environment propagation from Harvest or Herdr to
  Pi. Each shell, launcher, or pane that starts a collecting Pi process must
  provide the opt-in and state directory, and a running process must be
  restarted after changes.
- Setup is user-global rather than project-scoped. There is no project-local
  automatic install, and no Herdr plugin lifecycle hook installs or removes
  the Pi discovery file for you.
- Pi **0.85.1** and macOS are the verified combination. Other Pi versions and
  Linux/Windows runtime behavior are unverified.
- Group-toggle and page-key behavior were covered by unit tests; the live TUI
  driver could not inject those keys. System-clipboard delivery was not
  exercised; only the exact OSC 52 payload path was verified.
- A syntactically broken discovery file makes Pi refuse to start (verified:
  Pi exits non-zero before running the prompt and writes no Harvest row).
  Setup writes atomically and hash-verifies, so reinstall with
  `pi-setup.ts install` or remove with `uninstall` to recover; never
  hand-edit the installed copy.

## Tests and verification

Focused production checks:

```bash
node --test tests/config.test.ts tests/pi-opt-in.test.ts \
  tests/pi-observer.test.ts tests/bin-ingest-pi.test.ts tests/pi-setup.test.ts
node --test tests/pi-inbox.test.ts tests/pi-observer-ingest.test.ts
```

Repository checks:

```bash
npm run check
git diff --check
```

For a disposable direct E2E run, use a fresh `0700` state directory and an
isolated Pi session directory. For the tool case, create a harmless local
`TOOL_E2E_INPUT.txt` containing no private data and enable only the read tool.
With the one-time discovery setup installed and the two activation environment
variables present, start Pi normally; do not supply a second observer
`--extension` path. Submit these short synthetic prompts and do not print
their bodies or the model responses:

```text
Reply with FIRST_REPORT_7319.
Reply with SECOND_REPORT_8246.
Read TOOL_E2E_INPUT.txt and reply with TOOL_REPORT_5931.
```

Verify the production `harvest.db` and the Inbox service independently. The
evidence should include interaction count, distinct IDs, status, UTF-8 byte
lengths, and SHA-256 hashes of the independently observed submitted prompts,
final reports, and copy results. Do not record the private contents. A
procedure alone is not E2E success: success requires real Pi execution and
matching collected evidence. Remove the temporary session and state
directories after recording metadata-only evidence.

## Direct and mediated E2E evidence

Verified on 2026-09-17 with Pi 0.85.1, an already-authorized provider, fresh
disposable state/session directories, the production observer, and the local
ingest binary writing to the production `harvest.db`. The observed values
below are metadata only; no prompt or response bodies are recorded.

### Direct Pi runs

Three direct interactions were collected with distinct IDs. All completed.
The submitted prompt and final report bytes were compared with the values
observed from each run, not inferred from the requested prompt:

| Run | Submitted prompt | Final report |
| --- | --- | --- |
| Direct 1 | 29 bytes; SHA-256 `1cfbbd23aca36ee467e867c8e2549b369589039456031d7179db3dc930979628` | 17 bytes; SHA-256 `e9c3efff2cb6302c1636afe9296ee08de878dc06d6006bf5852a15f0d0065d67` |
| Direct 2 | 30 bytes; SHA-256 `0dc6afceb7229394fbb3f6c5bf12076454773418d70676b2b987ed7c409db15d` | 18 bytes; SHA-256 `079b11b83008e22763a2436787615ae6199485a2354f886d3eea256fe90749f4` |
| Direct tool run | 56 bytes; SHA-256 `f522ca92daee65f4be9a64a7a413cfd05f7909a089556dda416518d6d11d` | 16 bytes; SHA-256 `120680b2b8e72098a41b664822f7a413cfd05f7909a089556dda416518d6d11d` |

The tool run used only the harmless local read-tool fixture. Tool input/output
was not persisted as product data.

### Herdr-mediated submissions

Two Herdr-mediated interactions were collected in one session. Their IDs were
distinct, both were completed, and each submitted prompt was byte-exact at
26/26 bytes. Each final report was byte-exact at 14/14 bytes. The agent
received no Harvest instructions and the harness performed no manual payload
forwarding.

### Production Inbox and lifecycle checks

- The live database contained five Pi items. The Inbox service listed all five
  as `kind=pi`; each detail matched its stored row, and prompt/final-report
  copy returned the exact stored bytes for every item.
- The copy verification used real OSC52 payload bytes. The system clipboard
  was unreachable, so this is not a system-clipboard E2E claim.
- With `HARVEST_PI_COLLECT` unset and with `HARVEST_PI_COLLECT=0`, agents ran
  normally and zero new rows were written. Existing rows remained intact.
- A genuine v4 database containing two legacy rows, including one
  orchestration claim, migrated to `user_version=5`. Legacy rows remained
  byte-identical, `pi_interactions` was available, and reopening the database
  was idempotent.

### Interactive Inbox check

A real interactive TUI run used seeded data containing two completed Pi rows
with multiline/Unicode/long content, one failed Pi row, and one legacy row. It
verified list badges, `PROMPT`/`FINAL REPORT` sections, scrolling and clamping
to the first and last lines, per-key `p`/`f`/`y` copy with byte-exact OSC52
payloads, failed-row safe messaging, legacy `rawText` presentation, narrow
width rendering without corruption, and the empty-Inbox message. Space,
PageDown, group-toggle, and page-key injection were unavailable in the driver;
those behaviors remain covered by unit tests rather than live verification.
