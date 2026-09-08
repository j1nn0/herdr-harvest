import { createHerdrClient } from "@j1nn0/herdr-plugin-sdk";
import type { HarvestConfig } from "../config/config.ts";
import { loadConfig } from "../config/config.ts";
import { openDatabase } from "../persistence/database.ts";
import type { ResultStore } from "../persistence/result-store.ts";
import { SqliteResultStore } from "../persistence/result-store.ts";
import { shouldCaptureCompletion } from "./completion.ts";
import type { CaptureOutcome } from "./orchestrator.ts";
import { captureCompletion } from "./orchestrator.ts";

export interface CaptureRunOptions {
  workspaceIdHint?: string | null;
  agentKindHint?: string | null;
  now?: () => number;
  lifecycle?: {
    agentStatus: string;
  };
}

export async function runCapture(
  paneId: string,
  env: NodeJS.ProcessEnv,
  extra: CaptureRunOptions = {},
): Promise<{ outcome: CaptureOutcome; warnings: string[] }> {
  let warnings: string[] = [];
  let store: ResultStore | null = null;
  let database: ReturnType<typeof openDatabase> | null = null;
  const now = extra.now ?? Date.now;

  try {
    const loaded = loadConfig(env);
    warnings = loaded.warnings;
    const config: HarvestConfig = loaded.config;
    database = openDatabase(config.databasePath);
    store = new SqliteResultStore(database);
    if (extra.lifecycle !== undefined) {
      const observed = store.observePaneStatus({
        herdrSessionKey: config.herdrSessionKey,
        paneId,
        agentStatus: extra.lifecycle.agentStatus,
        atMs: now(),
      });
      if (!shouldCaptureCompletion(extra.lifecycle.agentStatus, observed.previousStatus)) {
        return {
          outcome: {
            status: "skipped",
            reason: lifecycleSkipReason(extra.lifecycle.agentStatus, observed.previousStatus),
          },
          warnings,
        };
      }
    }
    const client = createHerdrClient({ env });
    const outcome = await captureCompletion(
      {
        client,
        store,
        config,
        now,
      },
      {
        paneId,
        workspaceIdHint: extra.workspaceIdHint,
        agentKindHint: extra.agentKindHint,
      },
    );
    return { outcome, warnings };
  } catch (error) {
    return {
      outcome: { status: "failed", reason: `capture setup failed: ${errorMessage(error)}` },
      warnings,
    };
  } finally {
    if (store !== null) {
      try {
        store.close();
      } catch (error) {
        void error;
      }
    } else if (database !== null) {
      try {
        database.close();
      } catch (error) {
        void error;
      }
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

function lifecycleSkipReason(agentStatus: string, previousStatus: string | null): string {
  if (agentStatus === "idle") {
    return previousStatus === null
      ? "ignored idle without preceding work"
      : `ignored idle after ${previousStatus}`;
  }
  if (agentStatus === "done") {
    return "ignored duplicate done after done";
  }
  return `ignored agent status ${agentStatus}`;
}
