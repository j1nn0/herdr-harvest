# Orchestration capture

Harvest can attribute a captured result to an orchestration task. The attribution
is a **claim**: an explicit, synchronous statement an orchestrator makes in the
same call that captures the result. Nothing about the claim is inferred.

This document is the integration surface for orchestrators that start explorer or
fixer agents. The rest of Harvest, including the Result Inbox, is unaffected.

## Discovery

The capture entrypoint is a plain script inside the plugin directory, not a
declared plugin action, so it needs no Herdr session and no UI:

```bash
herdr plugin list --plugin j1nn0.herdr-harvest --json   # find the plugin root
cd <plugin root>
node src/bin/capture.ts --capabilities
```

The script uses only Harvest's runtime dependencies and the Herdr plugin
environment, so it runs from an installed or linked checkout without a build
step. `--capabilities` reads nothing: no environment, no database, no Herdr.

## Capability negotiation

Before claiming anything, probe the entrypoint and check the protocol:

```console
$ node src/bin/capture.ts --capabilities
{"protocol":"harvest-capture","protocolVersion":1,"features":["orchestration-claim"],"roles":["explorer","fixer"]}
```

The probe writes exactly one JSON line on stdout and exits `0`. It is answered
before any other argument handling and works with an empty environment.

| Field             | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `protocol`        | Always `harvest-capture`.                                            |
| `protocolVersion` | `1` for the shape described here.                                    |
| `features`        | `orchestration-claim` when claims are supported.                     |
| `roles`           | Accepted `--orchestration-role` values, currently `explorer`, `fixer`. |

Treat an unknown `protocolVersion` as incompatible, and require
`features` to contain `orchestration-claim` before sending a claim.

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
