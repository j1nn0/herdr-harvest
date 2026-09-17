import type { CodexIngestEvent, CodexIngestOutcome } from "./ingest.ts";
import { ingestCodexEvent } from "./ingest.ts";

/** Complete one observer hook without writing stdout or exposing captured text. */
export function runCodexHookEvent(
  event: CodexIngestEvent,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  try {
    const outcome = ingestCodexEvent(event, env);
    if (outcome.status === "rejected") {
      writeFailure(outcome.failure.reason);
      return 1;
    }
    return 0;
  } catch (error) {
    writeFailure(safeCode(error));
    return 1;
  }
}

export function writeFailure(code: string): void {
  process.stderr.write(`codex-collector:${code}\n`);
}

export function safeCode(error: unknown): string {
  if (isCodeError(error)) {
    return error.code;
  }
  return "write-failed";
}

export async function readHookStdin(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
  }
  return chunks.join("");
}

function isCodeError(error: unknown): error is { code: string } {
  return (
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
  );
}

export function isAcceptedOutcome(outcome: CodexIngestOutcome): boolean {
  return (
    outcome.status === "disabled" ||
    outcome.status === "staged" ||
    outcome.status === "inserted" ||
    outcome.status === "duplicate"
  );
}
