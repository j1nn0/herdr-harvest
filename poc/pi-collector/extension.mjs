import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { chmod, open } from "node:fs/promises";
import { join } from "node:path";

import {
  applyEvent,
  createContractState,
} from "./contract.mjs";
import {
  ensureStoreDirectory,
  writeInteraction,
} from "./store.mjs";

const DEFAULT_PROVENANCE = "pi-observer-agent_settled";
const DEFAULT_DIAGNOSTICS_FILE = "diagnostics.jsonl";
const MAX_DIAGNOSTIC_CODE_BYTES = 64;

/**
 * Install the observer-only Pi extension. No event handler returns a control
 * object, changes a message, sends a prompt, or registers an agent-facing tool.
 */
export function installPiCollector(pi, options = {}) {
  if (pi === null || typeof pi !== "object" || typeof pi.on !== "function") {
    return undefined;
  }

  const root = options.root ?? process.env.PI_COLLECTOR_DIR;
  if (typeof root !== "string" || root.length === 0) {
    return undefined;
  }

  const provenance = options.provenance ?? DEFAULT_PROVENANCE;
  const writer = options.writeInteraction ?? writeInteraction;
  const diagnosticWriter = options.writeDiagnostic ?? ((stage, error) => {
    return writeDiagnostic(root, options.diagnosticsPath, stage, error);
  });
  let contractState = createContractState();
  let sequence = 0;
  const sessions = new Map();
  const persisted = new Set();

  const safe = (stage, handler) => async (event, context) => {
    try {
      await handler(event, context);
    } catch (error) {
      await safeDiagnostic(diagnosticWriter, stage, error);
    }
    return undefined;
  };

  pi.on("before_agent_start", safe("before-agent-start", async (event, context) => {
    const sessionId = sessionIdentity(context);
    if (sessionId === undefined || typeof event?.prompt !== "string") {
      return;
    }
    const session = getSession(sessions, sessionId);
    const steering = event.mode === "steer" && session.currentInteractionId !== undefined;
    const interactionId = steering ? session.currentInteractionId : "pi-" + randomUUID();
    const result = accept({
      kind: "promptObserved",
      sessionId,
      sequence: nextSequence(),
      eventId: randomUUID(),
      interactionId,
      mode: steering ? "steer" : "new",
      prompt: event.prompt,
    });
    session.currentInteractionId = interactionId;
    await persistEmitted(result.emitted);
  }));

  pi.on("message_end", safe("message-end", async (event, context) => {
    const sessionId = sessionIdentity(context);
    const message = event?.message;
    if (sessionId === undefined || message?.role !== "assistant") {
      return;
    }
    const session = sessions.get(sessionId);
    if (session?.currentInteractionId === undefined) {
      return;
    }
    const result = accept({
      kind: "assistantCandidate",
      sessionId,
      sequence: nextSequence(),
      eventId: randomUUID(),
      interactionId: session.currentInteractionId,
      role: "assistant",
      stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
      textBlocks: textBlocks(message.content),
    });
    await persistEmitted(result.emitted);
  }));

  pi.on("agent_settled", safe("agent-settled", async (_event, context) => {
    if (typeof context?.isIdle !== "function" || context.isIdle() !== true) {
      return;
    }
    const sessionId = sessionIdentity(context);
    if (sessionId === undefined) {
      return;
    }
    const pendingIds = contractState.interactions
      .filter((interaction) => interaction.sessionId === sessionId && interaction.status === "pending")
      .map((interaction) => interaction.id);
    if (pendingIds.length === 0) {
      return;
    }
    const result = accept({
      kind: "settled",
      sessionId,
      sequence: nextSequence(),
      eventId: randomUUID(),
      interactionIds: pendingIds,
      outcome: "success",
    });
    await persistEmitted(result.emitted);
  }));

  pi.on("session_shutdown", safe("session-shutdown", async (_event, context) => {
    const sessionId = sessionIdentity(context);
    if (sessionId === undefined) {
      return;
    }
    const pendingIds = contractState.interactions
      .filter((interaction) => interaction.sessionId === sessionId && interaction.status === "pending")
      .map((interaction) => interaction.id);
    if (pendingIds.length === 0) {
      return;
    }
    const result = accept({
      kind: "sessionEnded",
      sessionId,
      sequence: nextSequence(),
      eventId: randomUUID(),
      reason: "session-ended",
    });
    await persistEmitted(result.emitted);
  }));

  function accept(event) {
    const result = applyEvent(contractState, event);
    contractState = result.state;
    return result;
  }

  function nextSequence() {
    sequence += 1;
    return sequence;
  }

  async function persistEmitted(interactions) {
    for (const interaction of interactions) {
      const key = interaction.sessionId.length + ":" + interaction.sessionId +
        interaction.id.length + ":" + interaction.id;
      if (persisted.has(key)) {
        continue;
      }
      try {
        await writer(root, interaction, provenance);
        persisted.add(key);
      } catch (error) {
        await safeDiagnostic(diagnosticWriter, "store-write", error);
      }
    }
  }

  return undefined;
}

/** Factory used by deterministic tests without importing Pi's runtime. */
export function createPiCollectorExtension(options = {}) {
  return (pi) => installPiCollector(pi, options);
}

export default function piCollectorExtension(pi) {
  return installPiCollector(pi);
}

function getSession(sessions, sessionId) {
  let session = sessions.get(sessionId);
  if (session === undefined) {
    session = { currentInteractionId: undefined };
    sessions.set(sessionId, session);
  }
  return session;
}

function sessionIdentity(context) {
  const manager = context?.sessionManager;
  if (manager === null || typeof manager !== "object") {
    return undefined;
  }
  let sessionId;
  let sessionFile;
  try {
    sessionId = typeof manager.getSessionId === "function" ? manager.getSessionId() : undefined;
    sessionFile = typeof manager.getSessionFile === "function" ? manager.getSessionFile() : undefined;
  } catch {
    return undefined;
  }
  if (typeof sessionId !== "string" && typeof sessionFile !== "string") {
    return undefined;
  }
  const scope = (typeof sessionFile === "string" ? sessionFile : "") +
    "\u0000" +
    (typeof sessionId === "string" ? sessionId : "");
  return "pi-" + createHash("sha256").update(scope, "utf8").digest("hex").slice(0, 48);
}

function textBlocks(content) {
  if (!Array.isArray(content)) {
    return [];
  }
  return content
    .filter((block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text);
}

async function safeDiagnostic(writer, stage, error) {
  try {
    await writer(stage, error);
  } catch {
    // Collection diagnostics must never disrupt the Pi agent.
  }
}

async function writeDiagnostic(root, diagnosticsPath, stage, error) {
  await ensureStoreDirectory(root);
  const file = diagnosticsPath ?? join(root, DEFAULT_DIAGNOSTICS_FILE);
  const entry = JSON.stringify({
    kind: "collector-error",
    stage,
    errorName: boundedCode(error?.name),
    errorCode: boundedCode(error?.code),
  }) + "\n";
  const handle = await open(file, "a", 0o600);
  try {
    await handle.writeFile(entry, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
    await chmod(file, 0o600);
  }
}

function boundedCode(value) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return Buffer.from(value, "utf8").subarray(0, MAX_DIAGNOSTIC_CODE_BYTES).toString("utf8");
}
