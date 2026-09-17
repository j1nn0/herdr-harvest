#!/usr/bin/env node
import { recordEvent } from "./record-event.mjs";

const MAX_HOOK_INPUT_BYTES = 128 * 1024;

try {
  const payload = JSON.parse(await readStdin());
  if (payload?.hook_event_name === undefined || payload.hook_event_name === "Stop") {
    if (typeof payload?.session_id === "string") {
      if (typeof payload.last_assistant_message === "string") {
        await recordEvent({
          kind: "final-response",
          session_id: payload.session_id,
          ...(typeof payload.prompt_id === "string" ? { prompt_id: payload.prompt_id } : {}),
          last_assistant_message: payload.last_assistant_message,
          stop_hook_active: payload.stop_hook_active === true,
          continuation_signals: {
            continued: payload.continued === true,
            continue: payload.continue === true,
            ...(typeof payload.decision === "string" ? { decision: payload.decision } : {}),
          },
          interrupted: payload.interrupted === true || payload.cancelled === true,
        });
      } else {
        await recordEvent({
          kind: "interaction-failed",
          session_id: payload.session_id,
          ...(typeof payload.prompt_id === "string" ? { prompt_id: payload.prompt_id } : {}),
          reason: payload.interrupted === true || payload.cancelled === true
            ? "interrupted"
            : "missing-final",
        });
      }
    }
  }
} catch {
  // Observer hooks are fail-open: malformed input cannot block or alter Claude.
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_HOOK_INPUT_BYTES) {
      throw new Error("hook input is oversized");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}
