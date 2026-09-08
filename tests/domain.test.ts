import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { contentHash, dedupKey } from "../src/domain/dedup.ts";
import type { CaptureInput } from "../src/domain/result.ts";
import { preview } from "../src/domain/result.ts";

describe("preview", () => {
  test("uses the tail and collapses whitespace", () => {
    const rawText = "old line\n\n middle   line \n last\tline \n newest line";

    assert.equal(preview(rawText, 22), "last line newest line…");
  });

  test("returns normalized non-blank content when it fits", () => {
    assert.equal(preview(" \n alpha\t beta \r\n\n gamma  "), "alpha beta gamma");
  });

  test("truncates with a trailing ellipsis", () => {
    assert.equal(preview("0123456789", 6), "01234…");
  });

  test("returns an empty string for blank input", () => {
    assert.equal(preview(" \n\t\r\n  "), "");
  });
});

const sessionIdentity: Pick<
  CaptureInput,
  | "agentSessionKind"
  | "agentSessionValue"
  | "workspaceId"
  | "paneId"
  | "agentKind"
  | "herdrSessionKey"
> = {
  agentSessionKind: "id",
  agentSessionValue: "session-a",
  workspaceId: "workspace-a",
  paneId: "pane-a",
  agentKind: "terminal",
  herdrSessionKey: "/tmp/herdr-a.sock",
};

describe("dedupKey", () => {
  const hash = contentHash("same content");

  test("is stable for the same session and content", () => {
    assert.equal(dedupKey(sessionIdentity, hash), dedupKey(sessionIdentity, hash));
  });

  test("separates content and native sessions", () => {
    assert.notEqual(
      dedupKey(sessionIdentity, hash),
      dedupKey(sessionIdentity, contentHash("different content")),
    );
    assert.notEqual(
      dedupKey({ ...sessionIdentity, agentSessionValue: "session-b" }, hash),
      dedupKey(sessionIdentity, hash),
    );
  });

  test("uses pane identity when there is no native session", () => {
    const noSession = {
      ...sessionIdentity,
      agentSessionKind: null,
      agentSessionValue: null,
    };

    assert.equal(dedupKey(noSession, hash), dedupKey(noSession, hash));
    assert.notEqual(dedupKey({ ...noSession, paneId: "pane-b" }, hash), dedupKey(noSession, hash));
  });

  test("does not let separator characters forge component boundaries", () => {
    const first = {
      ...sessionIdentity,
      agentSessionKind: null,
      agentSessionValue: null,
      workspaceId: "workspace|pane",
      paneId: "kind",
    };
    const second = {
      ...first,
      workspaceId: "workspace",
      paneId: "pane|kind",
    };

    assert.notEqual(dedupKey(first, hash), dedupKey(second, hash));
  });
});
