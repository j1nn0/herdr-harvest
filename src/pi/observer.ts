import { createHash, randomUUID } from "node:crypto";
import { isPiCollectionEnabled } from "../config/config.ts";
import type { PiInteractionInput } from "../domain/pi-interaction.ts";
import {
  applyPiContractEvent,
  createPiContractState,
  type PiContractEvent,
  type PiContractFailure,
  type PiTerminalEmission,
} from "./collector-contract.ts";
import { type PiCollectorDiagnostic, writePiDiagnostic } from "./diagnostics.ts";
import { createPiIngestWriter, type PiInteractionWriter } from "./ingest-writer.ts";

export type { PiCollectorDiagnostic } from "./diagnostics.ts";
export type { PiInteractionWriter } from "./ingest-writer.ts";

interface PiSessionManager {
  getSessionId?: () => unknown;
  getSessionFile?: () => unknown;
}

export interface PiExtensionContext {
  isIdle?: () => unknown;
  sessionManager?: PiSessionManager;
}

export interface PiExtensionApi {
  on: (event: string, handler: (event: unknown, context: PiExtensionContext) => unknown) => void;
}

export interface PiCollectorOptions {
  provenance?: string;
  interactionId?: () => string;
  writeInteraction?: PiInteractionWriter;
  diagnostic?: (entry: PiCollectorDiagnostic) => Promise<void> | void;
  env?: NodeJS.ProcessEnv;
  ingestScriptPath?: string;
}

/** Install the production observer only when the explicit environment opt-in is set. */
export function installProductionPiCollectorExtension(
  pi: PiExtensionApi,
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Omit<PiCollectorOptions, "env"> = {},
): undefined {
  if (!isPiCollectionEnabled(env)) {
    return undefined;
  }
  return installPiCollectorExtension(pi, { ...options, env: { ...env } });
}

const DEFAULT_PROVENANCE = "pi-observer-agent_settled";

/**
 * Register the observer-only Pi extension. Every handler returns undefined:
 * it never transforms input, replaces messages, sends prompts, or registers
 * agent-facing controls.
 */
export function installPiCollectorExtension(
  pi: PiExtensionApi,
  options: PiCollectorOptions = {},
): undefined {
  if (pi === null || typeof pi !== "object" || typeof pi.on !== "function") {
    return undefined;
  }

  const provenance = options.provenance ?? DEFAULT_PROVENANCE;
  const makeInteractionId = options.interactionId ?? randomUUID;
  const writer =
    options.writeInteraction ??
    createPiIngestWriter({
      env: options.env,
      scriptPath: options.ingestScriptPath,
    });
  const diagnostic =
    options.diagnostic ??
    ((entry: PiCollectorDiagnostic) => {
      return writePiDiagnostic(entry, options.env);
    });

  let state = createPiContractState();
  let sequence = 0;
  const reportedFailures = new Set<string>();
  const persisted = new Map<string, string>();

  const safe = (
    stage: string,
    handler: (event: unknown, context: PiExtensionContext) => Promise<void>,
  ) => {
    return async (event: unknown, context: PiExtensionContext): Promise<undefined> => {
      try {
        await handler(event, context);
      } catch (error) {
        await report({
          code: stage,
          stage,
          errorName: safeErrorName(error),
        });
      }
      return undefined;
    };
  };

  pi.on(
    "input",
    safe("input", async (event, context) => {
      const sessionId = sessionScopeId(context);
      if (sessionId === undefined) {
        await report({ code: "missing-session-identity", stage: "input" });
        return;
      }
      const input = inputEvent(event);
      if (input === undefined) {
        await report({ code: "malformed-input", stage: "input", sessionId });
        return;
      }
      await accept({
        kind: "inputObserved",
        sessionId,
        sequence: nextSequence(),
        submittedPrompt: input.text,
        mode: input.mode,
        handled: input.handled,
      });
    }),
  );

  pi.on(
    "before_agent_start",
    safe("before-agent-start", async (event, context) => {
      const sessionId = sessionScopeId(context);
      if (sessionId === undefined) {
        await report({ code: "missing-session-identity", stage: "before-agent-start" });
        return;
      }
      const before = beforeAgentStartEvent(event);
      if (before === undefined) {
        await report({
          code: "malformed-before-agent-start",
          stage: "before-agent-start",
          sessionId,
        });
        return;
      }
      await accept({
        kind: "promptObserved",
        sessionId,
        sequence: nextSequence(),
        interactionId: makeInteractionId(),
        effectivePrompt: before.prompt,
        ...(before.mode === undefined ? {} : { mode: before.mode }),
        hasAttachments: before.hasAttachments,
      });
    }),
  );

  pi.on(
    "message_end",
    safe("message-end", async (event, context) => {
      const sessionId = sessionScopeId(context);
      if (sessionId === undefined) {
        await report({ code: "missing-session-identity", stage: "message-end" });
        return;
      }
      const message = messageEndEvent(event);
      if (message === undefined) {
        await report({ code: "malformed-message-end", stage: "message-end", sessionId });
        return;
      }
      const active = state.interactions.filter(
        (interaction) => interaction.sessionId === sessionId && interaction.status === "pending",
      );
      if (active.length !== 1) {
        await report({
          code: active.length === 0 ? "unpaired-candidate" : "ambiguous-candidate",
          stage: "message-end",
          sessionId,
        });
        return;
      }
      await accept({
        kind: "assistantCandidate",
        sessionId,
        sequence: nextSequence(),
        ...(message.id === undefined ? {} : { eventId: `message:${message.id}` }),
        interactionId: active[0]?.interactionId ?? "",
        role: message.role,
        stopReason: message.stopReason,
        textBlocks: message.textBlocks,
      });
    }),
  );

  pi.on(
    "agent_settled",
    safe("agent-settled", async (_event, context) => {
      if (typeof context.isIdle !== "function" || context.isIdle() !== true) {
        return;
      }
      const sessionId = sessionScopeId(context);
      if (sessionId === undefined) {
        await report({ code: "missing-session-identity", stage: "agent-settled" });
        return;
      }
      const interactionIds = state.interactions
        .filter(
          (interaction) => interaction.sessionId === sessionId && interaction.status === "pending",
        )
        .map((interaction) => interaction.interactionId);
      if (interactionIds.length === 0) {
        return;
      }
      await accept({
        kind: "settled",
        sessionId,
        sequence: nextSequence(),
        interactionIds,
        outcome: "success",
      });
    }),
  );

  pi.on(
    "session_shutdown",
    safe("session-shutdown", async (_event, context) => {
      const sessionId = sessionScopeId(context);
      if (sessionId === undefined) {
        await report({ code: "missing-session-identity", stage: "session-shutdown" });
        return;
      }
      const hasPending = state.interactions.some(
        (interaction) => interaction.sessionId === sessionId && interaction.status === "pending",
      );
      if (!hasPending) {
        return;
      }
      await accept({
        kind: "sessionEnded",
        sessionId,
        sequence: nextSequence(),
        reason: "session-ended",
      });
    }),
  );

  async function accept(event: PiContractEvent): Promise<void> {
    const result = applyPiContractEvent(state, event);
    state = result.state;
    for (const failure of state.failures) {
      await reportFailure(failure);
    }
    for (const emission of result.emitted) {
      await persist(emission);
    }
  }

  async function reportFailure(failure: PiContractFailure): Promise<void> {
    const key = JSON.stringify(failure);
    if (reportedFailures.has(key)) {
      return;
    }
    reportedFailures.add(key);
    await report({
      code: failure.reason,
      stage: "contract",
      ...(failure.sessionId === undefined ? {} : { sessionId: failure.sessionId }),
      ...(failure.interactionId === undefined ? {} : { interactionId: failure.interactionId }),
      ...(failure.sequence === undefined ? {} : { sequence: failure.sequence }),
    });
  }

  async function report(entry: PiCollectorDiagnostic): Promise<void> {
    try {
      await diagnostic(entry);
    } catch {
      // A diagnostic failure must never become a Pi extension failure.
    }
  }

  async function persist(emission: PiTerminalEmission): Promise<void> {
    const record: PiInteractionInput = {
      interactionId: emission.interactionId,
      sessionId: emission.sessionId,
      submittedPrompt: emission.submittedPrompt,
      effectivePrompt: emission.effectivePrompt,
      finalReport: emission.finalReport,
      status: emission.status,
      reason: emission.reason,
      provenance,
    };
    const key = interactionKey(record.sessionId, record.interactionId);
    const fingerprint = JSON.stringify(record);
    if (persisted.get(key) === fingerprint) {
      return;
    }
    try {
      await writer(record);
      persisted.set(key, fingerprint);
    } catch (error) {
      await report({
        code: "store-write",
        stage: "store-write",
        sessionId: record.sessionId,
        interactionId: record.interactionId,
        errorName: safeErrorName(error),
      });
    }
  }

  function nextSequence(): number {
    sequence += 1;
    return sequence;
  }

  return undefined;
}

/** Factory form used by Pi's extension loader and deterministic tests. */
export function createPiCollectorExtension(options: PiCollectorOptions = {}) {
  return (pi: PiExtensionApi): undefined => installPiCollectorExtension(pi, options);
}

export default function piCollectorExtension(pi: PiExtensionApi): undefined {
  return installProductionPiCollectorExtension(pi);
}

/** Hash the session file/id pair so paths and provider identities never persist. */
export function sessionScopeId(context: PiExtensionContext): string | undefined {
  const manager = context.sessionManager;
  if (manager === undefined || manager === null || typeof manager !== "object") {
    return undefined;
  }
  let sessionId: unknown;
  let sessionFile: unknown;
  try {
    sessionId = manager.getSessionId?.();
    sessionFile = manager.getSessionFile?.();
  } catch {
    return undefined;
  }
  if (typeof sessionId !== "string" && typeof sessionFile !== "string") {
    return undefined;
  }
  const scope = `${typeof sessionFile === "string" ? sessionFile : ""}\u0000${typeof sessionId === "string" ? sessionId : ""}`;
  return `pi-${createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 48)}`;
}

interface InputAdapterResult {
  text: string;
  mode: "new" | "steer" | "followUp";
  handled: boolean;
}

function inputEvent(value: unknown): InputAdapterResult | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = inputText(value.text);
  if (text === undefined) {
    return undefined;
  }
  const streamingBehavior = value.streamingBehavior;
  const mode =
    streamingBehavior === "steer" || streamingBehavior === "followUp" ? streamingBehavior : "new";
  return { text, mode, handled: value.handled === true };
}

interface BeforeAdapterResult {
  prompt: string;
  hasAttachments: boolean;
  mode?: "new" | "steer";
}

function beforeAgentStartEvent(value: unknown): BeforeAdapterResult | undefined {
  if (!isRecord(value) || typeof value.prompt !== "string") {
    return undefined;
  }
  const mode = value.mode === "steer" || value.mode === "new" ? value.mode : undefined;
  return {
    prompt: value.prompt,
    hasAttachments: Array.isArray(value.images) && value.images.length > 0,
    ...(mode === undefined ? {} : { mode }),
  };
}

interface MessageAdapterResult {
  id?: string;
  role: string;
  stopReason: string;
  textBlocks: string[];
}

function messageEndEvent(value: unknown): MessageAdapterResult | undefined {
  if (!isRecord(value) || !isRecord(value.message) || typeof value.message.role !== "string") {
    return undefined;
  }
  const message = value.message;
  const role = message.role;
  if (typeof role !== "string") {
    return undefined;
  }
  const textBlocks = Array.isArray(message.content)
    ? message.content
        .filter(
          (block): block is Record<string, unknown> =>
            isRecord(block) && block.type === "text" && typeof block.text === "string",
        )
        .map((block) => block.text as string)
    : [];
  return {
    ...(typeof message.id === "string" ? { id: message.id } : {}),
    role,
    stopReason: typeof message.stopReason === "string" ? message.stopReason : "unknown",
    textBlocks,
  };
}

function inputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
    } else if (isRecord(part) && typeof part.text === "string") {
      parts.push(part.text);
    } else {
      return undefined;
    }
  }
  return parts.join("\n");
}

function interactionKey(sessionId: string, interactionId: string): string {
  return `${sessionId.length}:${sessionId}${interactionId.length}:${interactionId}`;
}

function safeErrorName(error: unknown): string | undefined {
  return error instanceof Error && error.name.length > 0 ? error.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
