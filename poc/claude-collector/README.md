# Claude Code hook collector PoC

This directory is an isolated feasibility proof, not Harvest production code.
The two observer hooks accept Claude Code JSON on stdin, write validated event
records to `CLAUDE_COLLECTOR_DIR/events.jsonl`, and always exit successfully.
They never emit hook control JSON, so they cannot block, continue, or modify a
Claude turn. The sidecar directory is created with mode `0700`; event and
configuration files are mode `0600`.

Run the deterministic contract tests with:

```sh
node --test poc/claude-collector/contract.test.mjs
```

The optional live attempt uses only a temporary `--settings` file,
`--setting-sources ""`, a temporary working directory, and synthetic prompts.
It deliberately preserves the already-authorized authentication context rather
than setting `CLAUDE_CONFIG_DIR`; it never changes auth state or global settings:

```sh
node poc/claude-collector/live-e2e.mjs
```

The collector pairs only an unblocked `UserPromptSubmit` followed by a
non-continued `Stop` with the same `session_id` and exact `prompt_id`. Events
missing either identifier are not session-only paired. Continued stops,
interruption, missing finals, duplicates, conflicts, malformed events, and
unmatched finals are reported as `interaction-failed`; no final is assigned
across sessions or turns. Reports contain counts and hashes, not prompt or
response bodies.
