# Pi collector PoC

This directory is an experimental, isolated proof of collection for Pi 0.85.1.
It is not Harvest production code and is not production-ready. It does not
modify Harvest, the database, the Inbox UI, global Pi settings, or credentials.

The PoC has two layers:

- `contract.mjs` is the pure event-sourced interaction contract from Unit 1.
- `extension.mjs`, `store.mjs`, and `live-harness.mjs` are Unit 2. They observe
  Pi, persist only accepted terminal interactions, and provide an opt-in direct
  live check.

## Tested runtime

The direct check was designed for Pi `0.85.1`. The extension uses only the
Pi extension events and context methods described below. A different Pi version
must be treated as unverified until the event shape and finality behavior have
been checked again.

## Event contract and correlation

The observer registers only `before_agent_start`, `message_end`,
`agent_settled`, and `session_shutdown`. It registers no tools and never
returns an input transform, message replacement, prompt, retry, or compaction
action.

| Pi observation | Contract event | Collection rule |
| --- | --- | --- |
| `before_agent_start` | `promptObserved` | Store the effective `event.prompt` exactly. The observer does not use an `input` field or count raw input events. |
| assistant `message_end` | `assistantCandidate` | Retain only text blocks, concatenated in their original order without trimming. Candidates remain in memory until settlement. |
| idle `agent_settled` | `settled` | Require `ctx.isIdle() === true`, then select the last assistant candidate with `stopReason === "stop"` and non-empty text. |
| `session_shutdown` | `sessionEnded` | Fail any still-pending interaction without inventing a final report. |

Pi has no native prompt ID. The observer hashes the session file and session
ID into an opaque bounded session identifier, then mints one random interaction
ID per observed `before_agent_start`. Assistant messages are attached to the
current observed interaction. Multiple observed prompt calls can therefore be
finalized by one idle settlement; a prompt with no deterministic observed
segment is dropped rather than guessed.

`message_end` is not a finality boundary. Retries, compaction restarts, queued
follow-ups, and same-role message replacement remain provisional until the
idle-guarded `agent_settled` event. A final report is the last eligible
assistant stop message's text blocks. Error, aborted, length, deferred,
non-assistant, textless, oversized, and otherwise unpaired candidates cannot
complete an interaction.

The contract preserves text exactly. The only synthetic text is the contract's
documented newline when a caller explicitly supplies a `mode: "steer"` event
for an ongoing interaction. The runtime observer does not infer steer mode from
arrival timing or raw input counts.

## Store and privacy boundary

`store.mjs` writes `interactions.json` below the caller-provided absolute
`PI_COLLECTOR_DIR`. The directory is forced to mode `0700`; the JSON file and
collector-owned diagnostics are forced to mode `0600`. Writes use a temporary
same-directory file followed by an atomic rename.

Only terminal interaction records are stored:

```text
id, sessionId, prompt, finalReport, status, reason, provenance
```

`finalReport` is `null` for a failed interaction. Provisional assistant
candidates, transcripts, tool calls and results, thinking, status bars, token
indicators, terminal output, intermediate messages, and reasoning traces are
never persisted. Oversized prompt or report text is rejected; it is never
truncated. Duplicate records are idempotent and conflicting records fail
closed.

The extension does not log bodies. If collection or writing fails, the
optional diagnostics file contains only a bounded stage, error name, and error
code. The live harness discards Pi stdout and stderr and prints only status,
hashes, byte lengths, and other non-content evidence.

## Deterministic tests

From the repository root:

```sh
node --test poc/pi-collector/contract.test.mjs
node --test poc/pi-collector/contract.test.mjs poc/pi-collector/store.test.mjs poc/pi-collector/extension.test.mjs
npm run check
git diff --check
```

The contract tests cover exact Unicode and multiline text, retries,
compaction, queued prompt pairings, steering, replacement, interrupted and
failed runs, rejected input, duplicate/conflicting/out-of-order events,
session changes, and oversized payload rejection. The extension tests verify
effective-prompt capture, idle finality, session separation, shutdown failure,
and the absence of agent-facing controls.

## Opt-in direct live check

The harness creates a private temporary project, session directory, and
collector directory. It loads only the PoC extension for those Pi processes:

```sh
node poc/pi-collector/live-harness.mjs
```

The harness submits exactly these short synthetic prompts as ordinary Pi
prompts:

```text
Reply with FIRST_REPORT_7319.
Reply with SECOND_REPORT_8246.
```

It runs the two prompts sequentially, sends no payloads to the extension by
hand, and verifies the resulting store. It reports whether the observed
effective prompts match exactly, whether two opaque IDs are distinct, whether
both records completed, and for each record the prompt/report SHA-256 hashes
and UTF-8 byte lengths. `finalReportExact` is reported separately for each
record; it is a measurement of what the model actually returned, not an
assumption that it followed the prompt.

The harness passes `--no-extensions`, `--no-skills`,
`--no-prompt-templates`, `--no-context-files`, a temporary `--session-dir`,
and the explicit extension path. It does not write global Pi settings, copy
credentials, print model output, or collect terminal output as product data.
Provider and model can be selected without exposing credentials:

```sh
PI_LIVE_PROVIDER=<authorized-provider> \
PI_LIVE_MODEL=<authorized-model> \
node poc/pi-collector/live-harness.mjs
```

The default keeps the private artifact directory so its permissions and JSON
file can be inspected locally. Add `--cleanup` to remove only the harness
directory after metadata has been computed:

```sh
node poc/pi-collector/live-harness.mjs --cleanup
```

An E2E procedure is not itself an E2E success. Success requires real Pi
execution, two completed records, exact observed prompt text, distinct
interaction/session identities, and the reported final-response evidence.
If the model is unavailable or authentication is not already authorized, the
harness reports a non-success status without attempting login, logout, or
credential recovery.

### Direct live evidence

The following metadata-only evidence came from a real direct run on the
tested Pi version. Prompt and response bodies were not printed or recorded
in this document:

```text
command: node poc/pi-collector/live-harness.mjs --provider openai-codex --cleanup
status: success
piVersionExpected: 0.85.1
processExitCodes: [0, 0]
storeFileBytes: 593
interactionCount: 2
promptsExact: true
idsDistinct: true
sessionIdsDistinct: true
privateContentsPrinted: false
globalConfigChanged: false
credentialsCopied: false
cleanedUp: true
interaction[0]: idHash=35950fe1523bd76eed6421816d23e1244c083f20df4ec0113cfd9a9df447390a, sessionIdHash=b2d7dd7cc0b0be4e344cd400b3a35acbe3e70c6d4006d2315cc0c69679214aa7, promptBytes=29, promptHash=1cfbbd23aca36ee467e867c8e2549b369589039456031d7179db3dc930979628, finalReportBytes=17, finalReportHash=e9c3efff2cb6302c1636afe9296ee08de878dc06d6006bf5852a15f0d0065d67, status=completed, finalReportExact=true
interaction[1]: idHash=9b1624467c5d66337603c5db9ef8e2f31d99fca5cbd68ec00a55821eff886fd3, sessionIdHash=41175631f8cba60850e28dca5e681b65565548bc9f4190b7eff02d402d745519, promptBytes=30, promptHash=0dc6afceb7229394fbb3f6c5bf12076454773418d70676b2b987ed7c409db15d, finalReportBytes=18, finalReportHash=079b11b83008e22763a2436787615ae6199485a2354f886d3eea256fe90749f4, status=completed, finalReportExact=true
```

## Install and remove

No package install and no global extension registration are required. Load the
extension for one process with an absolute store directory:

```sh
PI_COLLECTOR_DIR=/absolute/private/collector \
pi --no-extensions \
  --extension /absolute/path/to/poc/pi-collector/extension.mjs \
  --session-dir /absolute/private/sessions
```

The extension has no persistent install state. Stop using the explicit
`--extension` option to remove it from future runs. Delete only the private
temporary directories created for the PoC after checking that no evidence is
needed. Do not edit `~/.pi`, copy auth files, or change global settings.

## Supported and unsupported paths

Supported by design:

- direct Pi runs when this extension is explicitly loaded;
- all Pi prompt entry paths that reach the in-process observer's
  `before_agent_start` lifecycle;
- effective post-expansion prompt text;
- assistant text-block reports after an idle-guarded settlement;
- retries, compaction continuations, queued prompt calls, and same-role
  replacement when the runtime emits attributable observer events;
- Herdr-mediated execution in principle, because it uses the same in-process
  Pi lifecycle.

Not claimed or not verified:

- production Harvest integration;
- a native Pi prompt ID or a timestamp/FIFO fallback;
- transcript parsing or reconstruction of missing observer events;
- LLM-based report extraction;
- completion at `message_end`, `turn_end`, or `agent_end`;
- treating a non-idle `agent_settled` callback as final;
- error, aborted, length, deferred, textless, oversized, or ambiguous reports
  as successful;
- a tool-using live scenario in the default two-prompt check;
- the Herdr-mediated path. The harness is ready for the orchestrator to run
  there, but that path is unverified by this fixer.
