# Orchestration capture

Harvest can attribute a captured result to an orchestration task. The attribution
is a **claim**: an explicit, synchronous statement an orchestrator makes in the
same call that captures the result. Nothing about the claim is inferred.

This document is the integration surface for orchestrators that start explorer or
fixer agents. The rest of Harvest, including the Result Inbox, is unaffected.

## Discovery

An orchestrator discovers Harvest in four steps, and every path it uses comes
from Herdr or from Harvest itself. No step derives a path from Herdr's internal
plugin layout.

### 1. Find the plugin root

```bash
herdr plugin list --plugin j1nn0.herdr-harvest --json   # read plugin_root
```

The capture entrypoint is a plain script inside the plugin directory, not a
declared plugin action, so it needs no Herdr session and no UI.

### 2. Negotiate capabilities

```bash
cd <plugin root>
node src/bin/capture.ts --capabilities
```

The script uses only Harvest's runtime dependencies and the Herdr plugin
environment, so it runs from an installed or linked checkout without a build
step. `--capabilities` reads nothing: no environment, no database, no Herdr.

### 3. Read the runtime locator

```bash
herdr plugin config-dir j1nn0.herdr-harvest              # the config directory
cat "<config dir>/orchestration-capture-runtime.json"    # the locator
```

`herdr plugin config-dir` prints the directory Herdr hands the plugin as
`HERDR_PLUGIN_CONFIG_DIR`, and Harvest publishes the runtime locator there. See
[Runtime locator](#runtime-locator) for the document and its staleness rules.

### 4. Capture with the located state directory

```bash
cd <plugin root>
HERDR_PLUGIN_STATE_DIR="<locator.stateDir>" node src/bin/capture.ts \
  --pane <pane-id> \
  --orchestration-id 2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50 \
  --orchestration-label "探索: fix the parser" \
  --orchestration-role explorer
```

Passing the located `stateDir` explicitly points the capture at the same
database the plugin's own hook writes to. `HARVEST_STATE_DIR` takes precedence
over `HERDR_PLUGIN_STATE_DIR`, so unset it in the orchestrator's environment.
Never derive the state directory from Herdr's internal plugin layout: the
locator is the only supported source for it.

## Capability negotiation

Before claiming anything, probe the entrypoint and check the protocol:

```console
$ node src/bin/capture.ts --capabilities
{"protocol":"harvest-capture","protocolVersion":1,"features":["orchestration-claim","runtime-locator"],"roles":["explorer","fixer"]}
```

The probe writes exactly one JSON line on stdout and exits `0`. It is answered
before any other argument handling and works with an empty environment.

| Field             | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `protocol`        | Always `harvest-capture`.                                            |
| `protocolVersion` | `1` for the shape described here.                                    |
| `features`        | Capabilities of this entrypoint: `orchestration-claim` and `runtime-locator`. |
| `roles`           | Accepted `--orchestration-role` values, currently `explorer`, `fixer`. |

Treat an unknown `protocolVersion` as incompatible, and require `features` to
contain `orchestration-claim` before sending a claim. `runtime-locator` means
the plugin publishes the discovery document described next.

## Runtime locator

Harvest publishes a small discovery document so an orchestrator can find the
plugin's state directory and the Herdr socket the plugin is attached to:

```console
$ cat "$(herdr plugin config-dir j1nn0.herdr-harvest)/orchestration-capture-runtime.json"
{"protocol":"harvest-runtime-locator","protocolVersion":1,"pluginId":"j1nn0.herdr-harvest","stateDir":"/…/state/j1nn0.herdr-harvest","socketPath":"/…/herdr.sock","updatedAtMs":1750000000000}
```

| Field             | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `protocol`        | Always `harvest-runtime-locator`.                                    |
| `protocolVersion` | `1` for the shape described here.                                    |
| `pluginId`        | Always `j1nn0.herdr-harvest`.                                        |
| `stateDir`        | Exactly the directory Herdr gave Harvest as `HERDR_PLUGIN_STATE_DIR`; the database is `<stateDir>/harvest.db`. Copied verbatim, never normalized. |
| `socketPath`      | Exactly the Herdr socket Harvest observed as `HERDR_SOCKET_PATH`.    |
| `updatedAtMs`     | Publication time in Unix milliseconds.                               |

The document holds only those paths and a timestamp: no credentials, prompts,
captured output, or agent identity.

Harvest publishes the locator from its plugin `[[startup]]` command and refreshes
it on every hook run. Each publication writes a temporary file next to the target
and renames it over the previous document, so a reader sees either the previous
complete document or the new one. Publication is skipped when Herdr did not
provide a socket path, because a locator that cannot identify the live session
would point captures at the wrong one.

Treat the locator as a hint with an expiry check, never as a guarantee:

- A missing locator, an unknown `protocolVersion`, or a `socketPath` that does not
  match the Herdr server you are talking to means **integration unavailable** for
  that server, not a capture failure. Harvest may simply not have run in this
  session yet; retry after the next agent completion, or fall back to manual
  capture.
- A socket mismatch must never fail a capture. Pass `stateDir` explicitly to the
  capture command and let it report its own status; the capture entrypoint never
  reads the locator itself.
- The state directory must come from the locator, or from the orchestrator's own
  recorded configuration. It is never inferred from Herdr's internal layout.
- An orchestration claim is still only ever the CLI options below. There are no
  `HARVEST_ORCHESTRATION_*` environment variables, and the locator carries no
  claim.

## Capturing and claiming

```bash
node src/bin/capture.ts \
  --pane <pane-id> \
  --orchestration-id 2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50 \
  --orchestration-label "探索: fix the parser" \
  --orchestration-role explorer
```

| Option                    | Rules                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| `--pane`                  | Pane to capture. Defaults to the focused pane from the Herdr plugin context, then `HERDR_PANE_ID`. |
| `--orchestration-id`      | Canonical lowercase UUIDv4. Prefix-style tokens such as `orch_7f3a` are rejected.              |
| `--orchestration-label`   | Non-blank after trimming, at most 256 code points, stored exactly as given (Unicode and spacing preserved). |
| `--orchestration-role`    | `explorer` or `fixer`, case-sensitive.                                                        |

The three orchestration options are required together. A partial or malformed
claim exits `2` and captures nothing, so a claim is never silently dropped.

`--capabilities` and `--help` are answered first and exit `0`; `--help` documents
the same options.

## Output and exit codes

Every run writes one JSON summary line on stdout.

```console
$ node src/bin/capture.ts --pane w1G:p1 --orchestration-id 2f6a3c1e-... --orchestration-label "探索: fix the parser" --orchestration-role explorer
{"status":"captured","paneId":"w1G:p1","id":"1b2e...","orchestration":{"status":"claimed","id":"2f6a3c1e-..."}}
```

| Situation                                          | `status`     | JSON                                                                     | Exit |
| -------------------------------------------------- | ------------ | ------------------------------------------------------------------------ | ---- |
| New capture, claim applied                         | `captured`   | `status`, `paneId`, `id`, `orchestration:{status:"claimed",id}`           | `0`  |
| New capture, no claim requested                    | `captured`   | `status`, `paneId`, `id`                                                  | `0`  |
| Same content and same claim again                  | `duplicate`  | `status`, `paneId`, `id`, `orchestration:{status:"already_claimed",id}`   | `0`  |
| Same content, claim already held by another task   | `conflict`   | `status`, `paneId`, `id`, `requestedOrchestrationId`, `existingOrchestrationId` | `3`  |
| Nothing to capture (empty or absent pane)          | `skipped`    | `status`, `paneId`, `reason`                                              | `0`  |
| Capture or runtime failure                         | `failed`     | `status`, `paneId`, `reason`                                              | `1`  |
| Invalid arguments or an invalid claim              | —            | usage message on stderr                                                   | `2`  |

The summary never contains captured text, so it is safe to log. A conflict
reports both ids and nothing else about the losing claim.

## Claim semantics

- **First writer wins.** The claim is written with a single NULL-guarded update
  (`SET orchestration_* WHERE id = ? AND orchestration_id IS NULL`) inside the
  same transaction as the insert, so two orchestrators racing for the same
  content cannot both win.
- **Claims attach to the row that owns the content.** When the capture
  deduplicates, the claim is applied to the existing row rather than to the id
  generated for this attempt. An explicit claim can therefore follow an earlier
  automatic capture, and a later automatic capture cannot clear it.
- **`already_claimed` is idempotent.** The same id, label, and role claim the
  same row as many times as the orchestrator retries.
- **`conflict` changes nothing.** If the requested id, label, or role differs in
  any way from the stored claim, the stored claim stays exactly as it was, and
  the caller gets the existing id to resolve the collision. Harvest never
  overwrites a recorded claim.
- **A conflict is not a lost capture.** The captured result is stored and is
  visible in the inbox either way; only the attribution is refused.

## What is never identity

A claim is the only orchestration identity Harvest accepts. These are never used
as a claim source, and no claim is ever derived from them:

- pane titles, state labels, or any token an orchestrator writes into pane metadata
- workspace, tab, or pane ids
- native agent session ids or session paths
- capture timestamps or ordering
- prompt or output text parsed out of the captured content
- environment variables, including any `HARVEST_ORCHESTRATION_*` name: a claim is
  only ever the three CLI options, and the runtime locator carries no claim

Automatic captures (`src/bin/hook.ts`) always record a NULL claim, and a NULL
claim never blocks a capture: unclaimed results keep working exactly as they did
before this feature, and no migration backfills a claim onto existing rows.

## Entrypoint stability

`node src/bin/capture.ts` is the integration surface, and the keys `status`,
`paneId`, and `id` are stable. New capabilities are advertised through
`--capabilities` and the `features` list; `protocolVersion` increases only for an
incompatible change to this documented shape. Additive options and JSON fields
can appear without a version bump, so parse the payload instead of the exact
text.
