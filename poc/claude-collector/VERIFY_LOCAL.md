# Opt-in local verification

This procedure is an experimental check for the isolated Claude collector PoC.
It does not establish production readiness. The Stop hook has no authoritative
turn-settled signal, so a non-continued Stop remains provisional and can be
followed by a sibling hook continuation.

## Prerequisites

- Node.js 24 or newer.
- The deterministic repository dependencies are installed.
- Claude Code is installed at `/opt/homebrew/bin/claude`, which is the path
  currently used by `live-e2e.mjs`.
- An already-authorized Claude authentication context is available. Do not run
  login or logout as part of this procedure.

The procedure never sets `CLAUDE_CONFIG_DIR`, never edits global Claude
settings, never disables security hooks, and never copies credentials.

## Deterministic contract configuration

The contract suite uses synthetic events only and does not contact Claude:

```sh
node --test poc/claude-collector/contract.test.mjs
```

The expected result is 12 passing tests.

The continuation regression is intentionally kept outside Node's default test
discovery so the repository gate remains green while the limitation is
explicitly tracked:

```sh
node --test poc/claude-collector/continuation-regression.mjs
```

With the current contract, this command is expected to fail. Its assertion is
the documented known limitation: `Final Report A1` is finalized before the
sibling continuation and `Final Report A2` is reported as conflicting. A
passing result is required before claiming that sibling continuation is
handled.

## Live E2E test configuration

`live-e2e.mjs` creates a temporary settings file containing only the two
observer hooks, uses `--settings <temporary-file>` and
`--setting-sources ""`, and uses a temporary collector directory. The latter
setting-source override drops existing file-based security hooks; hook merging
with other hook sources is unverified. The script warns about this on every
run. It does not use a blocking Harvest Stop hook.

The diagnostic artifact contains untruncated, locally redacted Claude stdout
and stderr. It is written under a mode-0700 temporary directory with a
mode-0600 file, and its path is printed without printing its contents:

```sh
node poc/claude-collector/live-e2e.mjs
```

The output `LIVE_E2E: "success"` is meaningful only when the command actually
executes Claude and verifies exact synthetic prompt/response hashes. Reading
this procedure, running only the deterministic tests, or seeing a prepared
configuration is not E2E success. Even a live success does not resolve the
Stop-continuation limitation or prove safe authentication/configuration
composition.

## Evidence collection

Copy the diagnostic path printed by the live command into `DIAGNOSTIC_FILE`.
Collect only its byte length and hash; do not print, paste, upload, or commit
the file contents:

```sh
DIAGNOSTIC_FILE=/private/path/printed/by/live-e2e
wc -c < "$DIAGNOSTIC_FILE"
shasum -a 256 "$DIAGNOSTIC_FILE"
```

These commands do not expose prompt text, response text, terminal output, or
credentials. Preserve only the path, byte count, and hash in a local test note
if needed.

## Cleanup

The collector and settings directories created for a run are removed by the
script. Remove the retained diagnostic artifact after evidence collection,
using the exact path printed by that run:

```sh
DIAGNOSTIC_FILE=/private/path/printed/by/live-e2e
DIAGNOSTIC_DIR=$(dirname "$DIAGNOSTIC_FILE")
rm -f -- "$DIAGNOSTIC_FILE"
rmdir -- "$DIAGNOSTIC_DIR"
```

Do not remove or alter any global Claude configuration or authentication data.
