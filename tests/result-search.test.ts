import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isSearchQueryActive, matchesResultSearch } from "../src/app/result-search.ts";
import { sessionShortId } from "../src/app/session-label.ts";
import type { HarvestResult } from "../src/domain/result.ts";

/**
 * Every default field holds a unique "zz" token, so a query asserted against an
 * override cannot match an unrelated field by accident.
 */
function makeResult(overrides: Partial<HarvestResult> = {}): HarvestResult {
  return {
    id: "result-1",
    capturedAtMs: 1_000,
    workspaceId: "zzworkspaceid",
    workspaceName: "zzworkspacename",
    tabId: "zztabid",
    paneId: "zzpaneid",
    paneName: "zzpanename",
    agentName: "zzagentname",
    agentKind: "zzagentkind",
    agentSessionKind: "path",
    agentSessionValue: "zzsessionvalue",
    herdrSessionKey: "zzsessionkey",
    herdrSessionLabel: "zzsessionlabel",
    captureSource: "zzcapturesource",
    requestedLineCount: 3,
    rawText: "zzrawtext",
    contentHash: "zzcontenthash",
    dedupKey: "zzdedupkey",
    readAtMs: null,
    archivedAtMs: null,
    orchestrationId: null,
    orchestrationLabel: null,
    orchestrationRole: null,
    ...overrides,
  };
}

const searchableFieldCases: Array<{
  field: string;
  overrides: Partial<HarvestResult>;
  needle: string;
}> = [
  { field: "captured raw text", overrides: { rawText: "needle in raw" }, needle: "needle in raw" },
  {
    field: "preview derived from captured text",
    overrides: { rawText: "first\n\n   second part" },
    needle: "first second part",
  },
  {
    field: "captured raw text beyond the preview",
    overrides: { rawText: `${"x".repeat(200)} needle-beyond-preview` },
    needle: "needle-beyond-preview",
  },
  {
    field: "agent name",
    overrides: { agentName: "needle-agent-name" },
    needle: "needle-agent-name",
  },
  {
    field: "agent kind",
    overrides: { agentKind: "needle_agent_kind" },
    needle: "needle_agent_kind",
  },
  {
    field: "workspace name",
    overrides: { workspaceName: "needle workspace name" },
    needle: "needle workspace name",
  },
  {
    field: "workspace id",
    overrides: { workspaceId: "workspace-needle-id" },
    needle: "workspace-needle-id",
  },
  { field: "pane name", overrides: { paneName: "needle pane name" }, needle: "needle pane name" },
  { field: "pane id", overrides: { paneId: "pane-needle-id" }, needle: "pane-needle-id" },
  {
    field: "Herdr session label",
    overrides: { herdrSessionLabel: "needle-session-label" },
    needle: "needle-session-label",
  },
  {
    field: "Herdr session key",
    overrides: { herdrSessionKey: "/tmp/needle/herdr.sock" },
    needle: "/tmp/needle/herdr.sock",
  },
  {
    field: "native agent session value",
    overrides: { agentSessionValue: "needle-session-value" },
    needle: "needle-session-value",
  },
  {
    field: "capture source",
    overrides: { captureSource: "needle-capture-source" },
    needle: "needle-capture-source",
  },
  {
    field: "orchestration id",
    overrides: { orchestrationId: "orchestration-needle-id" },
    needle: "orchestration-needle-id",
  },
  {
    field: "orchestration label",
    overrides: { orchestrationLabel: "needle orchestration label" },
    needle: "needle orchestration label",
  },
  {
    field: "orchestration role",
    overrides: { orchestrationRole: "explorer" },
    needle: "explorer",
  },
];

describe("result search", () => {
  for (const { field, overrides, needle } of searchableFieldCases) {
    test(`matches the ${field}`, () => {
      assert.equal(matchesResultSearch(makeResult(overrides), needle), true);
      assert.equal(matchesResultSearch(makeResult(), needle), false);
    });
  }

  test("matches a compact id-kind display session id", () => {
    const result = makeResult({ agentSessionKind: "id", agentSessionValue: "n-e-e-d-l-e" });

    assert.equal(sessionShortId(result), "needle");
    // The display id is compacted, so it is not a substring of the native value.
    assert.equal((result.agentSessionValue ?? "").includes("needle"), false);
    assert.equal(matchesResultSearch(result, "needle"), true);
    assert.equal(matchesResultSearch(makeResult(), "needle"), false);
  });

  test("matches a hashed display session id", () => {
    const result = makeResult({ agentSessionKind: "path", agentSessionValue: "/home/needle/x" });
    const shortId = sessionShortId(result);

    assert.match(shortId, /^[0-9a-f]{6}$/);
    assert.equal((result.agentSessionValue ?? "").includes(shortId), false);
    assert.equal(matchesResultSearch(result, shortId), true);
    assert.equal(matchesResultSearch(makeResult(), shortId), false);
  });

  test("matches the tilde-hash display session id of an unknown session", () => {
    const result = makeResult({ agentSessionKind: null, agentSessionValue: null });
    const shortId = sessionShortId(result);

    assert.match(shortId, /^~[0-9a-f]{6}$/);
    assert.equal(matchesResultSearch(result, shortId), true);
  });

  test("does not index display-only fallbacks", () => {
    const sparse = makeResult({
      agentName: null,
      agentKind: null,
      workspaceName: null,
      workspaceId: null,
      paneName: null,
      paneId: "paneplain",
      herdrSessionLabel: null,
      herdrSessionKey: null,
      agentSessionKind: null,
      agentSessionValue: null,
      captureSource: "hook",
      rawText: "plain output",
    });

    assert.equal(matchesResultSearch(sparse, "unknown agent"), false);
    // The row id contains a dash, so this also proves identity fields stay out.
    assert.equal(matchesResultSearch(sparse, "-"), false);
  });

  test("matches ASCII case-insensitively", () => {
    assert.equal(matchesResultSearch(makeResult({ rawText: "Release notes" }), "RELEASE"), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: "release notes" }), "ReLeAsE"), true);
    assert.equal(
      matchesResultSearch(makeResult({ agentName: "Claude-Code" }), "claude-code"),
      true,
    );
  });

  test("matches Japanese text literally", () => {
    assert.equal(matchesResultSearch(makeResult({ rawText: "世界 🚀 完了" }), "完了"), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: "世界 🚀 完了" }), "未完了"), false);
  });

  test("matches through NFC normalization on both sides", () => {
    const composed = "café";
    const decomposed = "cafe\u0301";
    assert.notEqual(composed, decomposed);

    assert.equal(matchesResultSearch(makeResult({ rawText: composed }), decomposed), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: decomposed }), composed), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: composed }), "CAFE\u0301"), true);
  });

  test("matches orchestration metadata with the existing normalization", () => {
    const orchestrationId = "2f6a3c1e-8b1d-4a30-9a4f-5b1c2d3e4f50";
    const result = makeResult({
      orchestrationId,
      orchestrationLabel: "Café parser",
      orchestrationRole: "fixer",
    });

    assert.equal(matchesResultSearch(result, orchestrationId.toUpperCase()), true);
    assert.equal(matchesResultSearch(result, "cafe\u0301 parser"), true);
    assert.equal(matchesResultSearch(result, "FIXER"), true);
  });

  test("matches kana voiced marks across NFC forms without unvoicing", () => {
    const composed = "が";
    const decomposed = "か\u3099";
    assert.notEqual(composed, decomposed);

    assert.equal(matchesResultSearch(makeResult({ rawText: composed }), decomposed), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: decomposed }), composed), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: composed }), "か"), false);
  });

  test("does not normalize width or kana script", () => {
    assert.equal(matchesResultSearch(makeResult({ rawText: "おはよう" }), "ｵﾊﾖｳ"), false);
    assert.equal(matchesResultSearch(makeResult({ rawText: "かたかな" }), "カタカナ"), false);
  });

  test("does not rewrite the raw text it searches", () => {
    const rawText = "cafe\u0301\n\n  世界 🚀  \n";
    const result = makeResult({ rawText });
    const before = structuredClone(result);

    // The query only matches because both sides are normalized for comparison.
    assert.equal(matchesResultSearch(result, "CAFÉ"), true);
    assert.deepEqual(result, before);
    assert.equal(result.rawText, rawText);
    assert.deepEqual([...result.rawText], [...rawText]);
  });

  test("treats % and _ as literal characters", () => {
    const result = makeResult({ rawText: "100% done_with_underscores" });

    assert.equal(matchesResultSearch(result, "100%"), true);
    assert.equal(matchesResultSearch(result, "done_with"), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: "1000 done" }), "100%"), false);
    assert.equal(matchesResultSearch(makeResult({ rawText: "doneXwith" }), "done_with"), false);
  });

  test("treats backslash, star, question mark, and brackets literally", () => {
    const result = makeResult({ rawText: "path C:\\Users\\dev*a?b [tag]" });

    assert.equal(matchesResultSearch(result, "C:\\Users"), true);
    assert.equal(matchesResultSearch(result, "dev*a?b"), true);
    assert.equal(matchesResultSearch(result, "[tag]"), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: "devXaYb" }), "dev*a?b"), false);
    assert.equal(matchesResultSearch(makeResult({ rawText: "a" }), "[abc]"), false);
  });

  test("treats blank queries as no filter and keeps other spacing literal", () => {
    const result = makeResult();

    for (const blank of ["", " ", "   ", "\t\n", "　"]) {
      assert.equal(isSearchQueryActive(blank), false);
      assert.equal(matchesResultSearch(result, blank), true);
    }

    assert.equal(isSearchQueryActive(" needle "), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: "abc def" }), " def"), true);
    assert.equal(matchesResultSearch(makeResult({ rawText: "abcdef" }), " def"), false);
  });

  test("reports no match for unrelated queries", () => {
    assert.equal(matchesResultSearch(makeResult(), "not-present-anywhere"), false);
  });
});
