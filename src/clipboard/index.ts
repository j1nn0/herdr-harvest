import { createOsc52Clipboard } from "./osc52.ts";
import type { ClipboardProvider, CopyReport } from "./provider.ts";
import { ClipboardError } from "./provider.ts";
import { createSystemClipboard } from "./system.ts";

export { createOsc52Clipboard } from "./osc52.ts";
export type { ClipboardProvider, CopyReport } from "./provider.ts";
export { ClipboardError } from "./provider.ts";
export { createSystemClipboard } from "./system.ts";

export function createClipboard(
  options: {
    platform?: string;
    env?: NodeJS.ProcessEnv;
    stream?: NodeJS.WritableStream & { isTTY?: boolean };
  } = {},
): ClipboardProvider {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const stream = options.stream ?? process.stdout;
  const system = createSystemClipboard(platform, env);
  const providers =
    system === null ? [createOsc52Clipboard(stream)] : [system, createOsc52Clipboard(stream)];

  return {
    name: "chain",
    copy: async (text): Promise<CopyReport> => {
      const attempts: string[] = [];
      for (const provider of providers) {
        try {
          return await provider.copy(text);
        } catch (error) {
          if (error instanceof ClipboardError && error.attempts.length > 0) {
            attempts.push(...error.attempts);
          } else {
            attempts.push(`${provider.name}: ${errorMessage(error)}`);
          }
        }
      }

      const detail = attempts.length > 0 ? ` ${attempts.join("; ")}` : "";
      throw new ClipboardError(`Clipboard copy failed.${detail}`, attempts);
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
