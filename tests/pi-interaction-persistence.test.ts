import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_PI_FINAL_REPORT_BYTES,
  MAX_PI_PROMPT_BYTES,
  type PiInteractionInput,
} from "../src/domain/pi-interaction.ts";
import { openDatabase } from "../src/persistence/database.ts";
import { MIGRATIONS, runMigrations } from "../src/persistence/migrations.ts";
import {
  PiInteractionConflictError,
  PiInteractionStore,
  PiInteractionValidationError,
} from "../src/persistence/pi-interaction-store.ts";

function makeInteraction(overrides: Partial<PiInteractionInput> = {}): PiInteractionInput {
  return {
    interactionId: "interaction-a",
    sessionId: "session-a",
    submittedPrompt: "Prompt A  日本語\n",
    effectivePrompt: "Effective Prompt A  \n",
    finalReport: "Final Report A\n世界 🚀",
    status: "completed",
    reason: null,
    provenance: "pi-observer-v1",
    ...overrides,
  };
}

describe("Pi interaction persistence", () => {
  test("v4 databases retain legacy rows and receive the Pi table at v5", () => {
    const db = openDatabase(":memory:");
    try {
      for (const migration of MIGRATIONS.slice(0, 4)) {
        migration.up(db);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      const legacyText = "  legacy raw text  \n日本語 🚀\n";
      db.prepare(`
        INSERT INTO results (
          id,
          captured_at_ms,
          pane_id,
          capture_source,
          capture_line_count,
          raw_text,
          content_hash,
          dedup_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        "legacy-result",
        123,
        "legacy-pane",
        "recent-unwrapped",
        40,
        legacyText,
        "legacy-content-hash",
        "legacy-dedup-key",
      );
      const legacyBefore = Object.fromEntries(
        Object.entries(
          db.prepare("SELECT * FROM results WHERE id = ?").get("legacy-result") as Record<
            string,
            unknown
          >,
        ),
      );

      assert.deepEqual(runMigrations(db), {
        from: 4,
        to: 5,
        applied: ["create-pi-interactions"],
      });
      assert.equal(
        (db.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version,
        5,
      );
      assert.deepEqual(
        (db.prepare("PRAGMA table_info(pi_interactions)").all() as Array<{ name?: string }>).map(
          (column) => column.name,
        ),
        [
          "interaction_id",
          "session_id",
          "submitted_prompt",
          "effective_prompt",
          "final_report",
          "status",
          "failure_reason",
          "provenance",
          "dedup_key",
        ],
      );
      assert.ok(
        (db.prepare("PRAGMA index_list(pi_interactions)").all() as Array<{ name?: string }>).some(
          (index) => index.name === "pi_interactions_dedup_key",
        ),
      );

      const legacyAfter = Object.fromEntries(
        Object.entries(
          db.prepare("SELECT * FROM results WHERE id = ?").get("legacy-result") as Record<
            string,
            unknown
          >,
        ),
      );
      assert.deepEqual(legacyAfter, legacyBefore);

      const store = new PiInteractionStore(db);
      assert.equal(store.insert(makeInteraction()).status, "inserted");
      assert.equal(
        (db.prepare("SELECT COUNT(*) AS count FROM results").get() as { count?: number }).count,
        1,
      );
    } finally {
      db.close();
    }
  });

  test("inserts terminal text exactly and reads back an identical duplicate", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      const input = makeInteraction();
      const first = store.insert(input);
      assert.equal(first.status, "inserted");
      if (first.status !== "inserted") {
        throw new Error("Expected the first Pi interaction to be inserted.");
      }
      assert.deepEqual(store.get(input.sessionId, input.interactionId), first.interaction);

      const duplicate = store.insert({ ...input, effectivePrompt: input.effectivePrompt });
      assert.equal(duplicate.status, "duplicate");
      assert.deepEqual(duplicate.interaction, first.interaction);
      assert.equal(store.list().length, 1);
    } finally {
      db.close();
    }
  });

  test("fails closed when one dedup key carries different content", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      store.insert(makeInteraction());
      assert.throws(
        () => store.insert(makeInteraction({ finalReport: "A different report" })),
        (error) => error instanceof PiInteractionConflictError,
      );
      assert.equal(store.list().length, 1);
      assert.equal(store.get("session-a", "interaction-a")?.finalReport, "Final Report A\n世界 🚀");
    } finally {
      db.close();
    }
  });

  test("persists a failed terminal interaction without a partial report", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      const outcome = store.insert(
        makeInteraction({
          interactionId: "interrupted",
          status: "failed",
          finalReport: null,
          reason: "interrupted",
        }),
      );
      assert.equal(outcome.status, "inserted");
      assert.deepEqual(outcome.interaction, {
        interactionId: "interrupted",
        sessionId: "session-a",
        submittedPrompt: "Prompt A  日本語\n",
        effectivePrompt: "Effective Prompt A  \n",
        finalReport: null,
        status: "failed",
        reason: "interrupted",
        provenance: "pi-observer-v1",
        dedupKey: outcome.interaction.dedupKey,
      });
    } finally {
      db.close();
    }
  });

  test("rejects pending and oversized text without writing a row", () => {
    const db = openDatabase(":memory:");
    const store = new PiInteractionStore(db);
    try {
      assert.throws(
        () => store.insert(makeInteraction({ status: "pending", finalReport: null })),
        (error) =>
          error instanceof PiInteractionValidationError && error.code === "pending-not-persisted",
      );
      assert.throws(
        () =>
          store.insert(makeInteraction({ submittedPrompt: "x".repeat(MAX_PI_PROMPT_BYTES + 1) })),
        (error) =>
          error instanceof PiInteractionValidationError &&
          error.code === "oversized-submittedPrompt",
      );
      assert.throws(
        () =>
          store.insert(makeInteraction({ finalReport: "x".repeat(MAX_PI_FINAL_REPORT_BYTES + 1) })),
        (error) =>
          error instanceof PiInteractionValidationError && error.code === "oversized-finalReport",
      );
      assert.equal(store.list().length, 0);
    } finally {
      db.close();
    }
  });
});
