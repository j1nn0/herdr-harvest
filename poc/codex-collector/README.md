# Codex native-hook collector PoC

This isolated PoC captures one visible Codex root turn from the native
`UserPromptSubmit` and `Stop` lifecycle hooks. It does not modify production
code, the production database, global Codex configuration, or any existing
collector PoC.

## Contract

The collector accepts a turn only when all of the following are true:

1. Exactly one agent-field-less `UserPromptSubmit` and exactly one `Stop` have
   the same `session_id` and `turn_id`.
2. The submit `prompt` is present and non-empty after empty-capture detection.
   The original string is retained without trimming.
3. `last_assistant_message` is a string and is not JSON `null`.
4. The event is a root event. `SubagentStop`, agent-bearing submit events, and
   explicitly non-user sources are rejected.

Duplicate delivery of the same normalized event is idempotent. Distinct
prompt/report candidates for one turn are rejected. Out-of-order arrival is
safe; a turn is exposed only after the pair is complete. Failed, interrupted,
or orphaned turns never produce a partial interaction. No hook body is
executed, forwarded, scraped, transcript-parsed, or sent to an LLM.

The optional notify/triple-join path is intentionally not included in this
minimal PoC. It is not required for the two-hook contract.

## Codex 0.154.0 wire boundary

The version-matched upstream schema defines these relevant fields:

- `UserPromptSubmit`: `session_id`, `turn_id`, optional `agent_id` and
  `agent_type`, `hook_event_name`, and `prompt`.
- `Stop`: `session_id`, `turn_id`, `hook_event_name`,
  `stop_hook_active`, and nullable `last_assistant_message`.
- `SubagentStop`: the agent identity fields and a different event name.

Codex 0.154.0 does not put `MemoryConsolidation` source metadata in this hook
stdin wire payload. Upstream dispatch treats memory consolidation as a
separate stop target and excludes user/project handlers for it. The PoC does
not invent a live `source` field; its normalizer rejects an explicitly supplied
non-user `source`, `thread_source`, or `session_source` as defense in depth for
adapter-enriched or synthetic events. This keeps the memory-consolidation
filter fail-closed without claiming that an absent wire field is authoritative.

The source references checked for this PoC are the installed `codex-cli
0.154.0` help output and the `rust-v0.154.0` upstream hook schema/runtime.

## Files and storage

- `prompt-hook.ts` and `stop-hook.ts` are thin stdin adapters.
- `receiver.ts` parses one structured payload and records only normalized hook
  data. Malformed or unrelated input exits successfully without output.
- `contract.ts` owns root-event validation, exact-text preservation, and the
  pair correlator.
- `store.ts` owns a private JSON sidecar: `hook-events.ndjson` is the minimal
  correlation spool and `interactions.json` contains only the accepted prompt,
  final report, identity, status, and provenance fields.
- `collector.test.ts` contains synthetic-only tests for the required scenarios.
- `live-e2e.ts` is an opt-in harness; it creates a temporary project and
  `CODEX_HOME` with hook configuration plus a read-only copy of `auth.json`,
  runs two direct Codex turns, and prints only lengths, hashes, and IDs. It
  never edits the real Codex home and never prints model output.

Set `CODEX_COLLECTOR_DIR` to an absolute, collector-owned directory when
registering the two hook commands. The hook commands should invoke Node with
`--experimental-strip-types`, for example:

```toml
[features]
hooks = true

[[hooks.UserPromptSubmit]]
[[hooks.UserPromptSubmit.hooks]]
type = "command"
command = "node --experimental-strip-types /absolute/path/to/prompt-hook.ts"
timeout = 15

[[hooks.Stop]]
[[hooks.Stop.hooks]]
type = "command"
command = "node --experimental-strip-types /absolute/path/to/stop-hook.ts"
timeout = 15
```

For live verification, use the harness's temporary `CODEX_HOME` config and
`--dangerously-bypass-hook-trust`; do not add these hooks to the user's global
configuration.

## Verification

Synthetic tests:

```sh
node --experimental-strip-types --test poc/codex-collector/collector.test.ts
```

The live harness is intentionally not run by the PoC tests:

```sh
node --experimental-strip-types poc/codex-collector/live-e2e.ts
```

The live harness requires an already authenticated Codex installation and may
consume model quota. It should be run only by the orchestrator after the
read-only CLI checks.
