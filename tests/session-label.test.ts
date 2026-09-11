import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { sessionShortId } from "../src/app/session-label.ts";
import type { HarvestResult } from "../src/domain/result.ts";
import { formatInboxRow } from "../src/tui/inbox-view.ts";

function makeResult(overrides: Partial<HarvestResult> = {}): HarvestResult {
  return {
    id: "result-id",
    contentHash: "content-hash",
    dedupKey: "dedup-key",
    capturedAtMs: 1_000,
    workspaceId: "workspace-id",
    workspaceName: "workspace",
    tabId: "tab-id",
    paneId: "pane-id",
    paneName: "pane",
    agentName: null,
    agentKind: "claude",
    agentSessionKind: "id",
    agentSessionValue: "409d9702-e983-47c7-9feb-7cf7372b4077",
    herdrSessionKey: "socket",
    herdrSessionLabel: "default",
    captureSource: "test",
    captureLineCount: 1,
    rawText: "output",
    readAtMs: null,
    archivedAtMs: null,
    ...overrides,
  };
}

describe("session short id", () => {
  test("derives a stable six-character id from an id-kind UUID", () => {
    const result = makeResult();

    assert.equal(sessionShortId(result), "409d97");
    assert.equal(sessionShortId(result), sessionShortId({ ...result, id: "another-result" }));
  });

  test("distinguishes different native sessions", () => {
    const first = sessionShortId(makeResult());
    const second = sessionShortId(
      makeResult({ agentSessionValue: "7abc1234-de56-7890-ab12-cd34567890ef" }),
    );

    assert.notEqual(first, second);
  });

  test("hashes path-kind values without exposing the full path", () => {
    const path =
      "/Users/jinno/.pi/agent/sessions/--Users-jinno-Repos-j1nn0.github-herdr-harvest--/2026-09-07T06-13-02-895Z_01a07a7f-1234-4567-89ab-0123456789ab.jsonl";
    const result = makeResult({ agentSessionKind: "path", agentSessionValue: path });
    const shortId = sessionShortId(result);

    assert.match(shortId, /^[0-9a-f]{6}$/);
    assert.equal(shortId, sessionShortId(result));
    const row = formatInboxRow(
      {
        id: "row-id",
        agentLabel: "pi",
        sessionShortId: shortId,
        workspaceLabel: "workspace",
        herdrSessionLabel: "default",
        paneLabel: path,
        capturedAtMs: 1_000,
        preview: "output",
        unread: true,
        archived: false,
      },
      80,
      60_000,
    );
    assert.ok(!row.includes(path));
  });

  test("uses a marked pane-derived fallback when native metadata is missing", () => {
    const first = sessionShortId(
      makeResult({ agentSessionKind: null, agentSessionValue: null, paneId: "pane-a" }),
    );
    const second = sessionShortId(
      makeResult({ agentSessionKind: null, agentSessionValue: null, paneId: "pane-b" }),
    );

    assert.match(first, /^~[0-9a-f]{6}$/);
    assert.notEqual(first, second);
    assert.equal(
      first,
      sessionShortId(
        makeResult({ agentSessionKind: null, agentSessionValue: "", paneId: "pane-a" }),
      ),
    );
  });

  test("hashes an id value that is too short for a six-character display id", () => {
    const shortId = sessionShortId(
      makeResult({ agentSessionKind: "id", agentSessionValue: "abc" }),
    );

    assert.match(shortId, /^[0-9a-f]{6}$/);
  });
});
