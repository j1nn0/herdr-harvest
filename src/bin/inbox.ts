import { render } from "ink";
import React from "react";
import { createInboxService } from "../app/inbox-service.ts";
import { createClipboard } from "../clipboard/index.ts";
import { loadConfig } from "../config/config.ts";
import { loadInboxDisplayConfig } from "../config/inbox-display-config.ts";
import { openDatabase } from "../persistence/database.ts";
import { PiInteractionStore } from "../persistence/pi-interaction-store.ts";
import { SqliteResultStore } from "../persistence/result-store.ts";
import { isMainModule as isMainModulePath } from "../runtime/is-main-module.ts";
import { createApp } from "../tui/app.ts";
import { disableWheelReporting, enableWheelReporting } from "../tui/mouse.ts";

const h = React.createElement;

export async function runInbox(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let loaded: ReturnType<typeof loadConfig>;
  try {
    loaded = loadConfig(env);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    return 2;
  }

  for (const warning of loaded.warnings) {
    process.stderr.write(`${warning}\n`);
  }
  const displayConfig = loadInboxDisplayConfig(env);
  for (const warning of displayConfig.warnings) {
    process.stderr.write(`${warning}\n`);
  }

  const db = openDatabase(loaded.config.databasePath);
  let store: SqliteResultStore | null = null;
  try {
    store = new SqliteResultStore(db);
    const piStore = new PiInteractionStore(db);
    const clipboard = createClipboard({ env });
    const port = createInboxService({
      store,
      piStore,
      clipboard,
      now: () => Date.now(),
    });
    // The inbox owns the mouse-reporting lifecycle: enabled before the TUI
    // renders, disabled in the single `finally` below so every exit path
    // (quit, unmount, render error) restores the terminal.
    enableWheelReporting(process.stdout);
    const instance = render(h(createApp(port, displayConfig.config)));
    await instance.waitUntilExit();
    return 0;
  } finally {
    disableWheelReporting(process.stdout);
    if (store === null) {
      db.close();
    } else {
      store.close();
    }
  }
}

function isMainModule(): boolean {
  return isMainModulePath(import.meta.url, process.argv[1]);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

if (isMainModule()) {
  void runInbox().then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      process.stderr.write(`Harvest inbox failed: ${errorMessage(error)}\n`);
      process.exitCode = 1;
    },
  );
}
