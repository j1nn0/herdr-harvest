#!/usr/bin/env node
import { recordEvent } from "./record-event.mjs";

const MAX_HOOK_INPUT_BYTES = 128 * 1024;

try {
  const payload = JSON.parse(await readStdin());
  if (payload?.hook_event_name === undefined || payload.hook_event_name === "UserPromptSubmit") {
    if (typeof payload?.session_id === "string" && typeof payload?.prompt === "string") {
      await recordEvent({
        kind: "prompt-submitted",
        session_id: payload.session_id,
        ...(typeof payload.prompt_id === "string" ? { prompt_id: payload.prompt_id } : {}),
        prompt: payload.prompt,
        blocked: payload.decision === "block" || payload.blocked === true,
      });
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
