import { randomUUID } from "node:crypto";
import { chmodSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Protocol marker that identifies a runtime locator document. */
export const RUNTIME_LOCATOR_PROTOCOL = "harvest-runtime-locator";

/** Locator document shape version; increased only for an incompatible change. */
export const RUNTIME_LOCATOR_PROTOCOL_VERSION = 1;

/** The plugin whose runtime the locator describes. */
export const RUNTIME_LOCATOR_PLUGIN_ID = "j1nn0.herdr-harvest";

/** File name the locator is published under inside Herdr's plugin config directory. */
export const RUNTIME_LOCATOR_FILE_NAME = "orchestration-capture-runtime.json";

export interface RuntimeLocatorDocument {
  protocol: typeof RUNTIME_LOCATOR_PROTOCOL;
  protocolVersion: typeof RUNTIME_LOCATOR_PROTOCOL_VERSION;
  pluginId: typeof RUNTIME_LOCATOR_PLUGIN_ID;
  stateDir: string;
  socketPath: string;
  updatedAtMs: number;
}

export interface RuntimeLocatorPublication {
  published: boolean;
  /** Absolute path of the locator file; set only when published. */
  path?: string;
  /** Why publication was skipped or failed; set only when not published. */
  reason?: string;
  /**
   * True only when a write was attempted and failed. A skip caused by a missing
   * prerequisite leaves this unset, so callers can warn about real failures
   * without warning on every invocation that runs outside a plugin environment.
   */
  writeFailure?: boolean;
}

/**
 * Publishes the runtime locator that lets an external orchestrator discover this
 * plugin's state directory and live Herdr socket without knowing Herdr's
 * internal layout.
 *
 * The document contains only paths Herdr handed to this process plus a
 * timestamp: no credentials, prompts, captured output, or agent identity. Every
 * value is copied verbatim, and the file is written to
 * `<HERDR_PLUGIN_CONFIG_DIR>/orchestration-capture-runtime.json`.
 *
 * Publication requires all three prerequisites, including a non-empty
 * `HERDR_SOCKET_PATH`. The socket path identifies which Herdr server these
 * captures belong to; without it the locator could not tell an orchestrator
 * whether the plugin is attached to the session the orchestrator is talking to,
 * and a published locator pointing at the wrong session would make captures
 * fail. Herdr omits the socket path for plugin commands that are not attached to
 * a running session, so this skip is a normal state rather than an error.
 *
 * A `false` result is never a capture failure: the hook keeps capturing, and the
 * caller decides whether to warn. This function never throws.
 */
export function publishRuntimeLocator(env: NodeJS.ProcessEnv): RuntimeLocatorPublication {
  try {
    return publish(env);
  } catch (error) {
    return {
      published: false,
      reason: `failed to publish the runtime locator: ${errorMessage(error)}`,
      writeFailure: true,
    };
  }
}

function publish(env: NodeJS.ProcessEnv): RuntimeLocatorPublication {
  const configDir = env.HERDR_PLUGIN_CONFIG_DIR;
  if (!isNonEmpty(configDir)) {
    return { published: false, reason: "HERDR_PLUGIN_CONFIG_DIR is not set" };
  }

  const stateDir = env.HERDR_PLUGIN_STATE_DIR;
  if (!isNonEmpty(stateDir)) {
    return { published: false, reason: "HERDR_PLUGIN_STATE_DIR is not set" };
  }

  const socketPath = env.HERDR_SOCKET_PATH;
  if (!isNonEmpty(socketPath)) {
    return { published: false, reason: "HERDR_SOCKET_PATH is not set" };
  }

  const document: RuntimeLocatorDocument = {
    protocol: RUNTIME_LOCATOR_PROTOCOL,
    protocolVersion: RUNTIME_LOCATOR_PROTOCOL_VERSION,
    pluginId: RUNTIME_LOCATOR_PLUGIN_ID,
    stateDir,
    socketPath,
    updatedAtMs: Date.now(),
  };
  const path = join(configDir, RUNTIME_LOCATOR_FILE_NAME);
  const temporaryPath = join(
    configDir,
    `.${RUNTIME_LOCATOR_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    // The temporary file is created next to the target so the rename stays
    // atomic, and it is the temp file whose mode ends up on the target: a
    // reader sees either the previous complete document or the new one.
    writeFileSync(temporaryPath, JSON.stringify(document), { mode: 0o600 });
    try {
      chmodSync(temporaryPath, 0o600);
    } catch (error) {
      // Best effort: some platforms do not implement POSIX modes.
      void error;
    }
    renameSync(temporaryPath, path);
    return { published: true, path };
  } catch (error) {
    removeQuietly(temporaryPath);
    return {
      published: false,
      reason: `failed to write ${path}: ${errorMessage(error)}`,
      writeFailure: true,
    };
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    void error;
  }
}

function isNonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
