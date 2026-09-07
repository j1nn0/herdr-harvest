import type { ClipboardProvider, CopyReport } from "./provider.ts";
import { ClipboardError } from "./provider.ts";

type StreamEvents = {
  once?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

export function createOsc52Clipboard(
  stream: NodeJS.WritableStream & { isTTY?: boolean },
): ClipboardProvider {
  return {
    name: "osc52",
    copy: async (text): Promise<CopyReport> => {
      if (stream.isTTY !== true) {
        throw new ClipboardError("OSC 52 clipboard requires a TTY output stream.", [
          "osc52: stream is not a TTY",
        ]);
      }

      const payload = Buffer.from(text, "utf8").toString("base64");
      const sequence = `\u001b]52;c;${payload}\u0007`;
      try {
        await writeSequence(stream, sequence);
      } catch (error) {
        const reason = errorMessage(error);
        throw new ClipboardError(`OSC 52 clipboard write failed: ${reason}`, [`osc52: ${reason}`]);
      }
      return { provider: "osc52", confirmed: false };
    },
  };
}

function writeSequence(
  stream: NodeJS.WritableStream & { isTTY?: boolean },
  sequence: string,
): Promise<void> {
  const events = stream as StreamEvents;
  const once = events.once;
  const hasEvents = typeof once === "function";
  const supportsCallback = stream.write.length >= 2;
  if (!hasEvents && !supportsCallback) {
    stream.write(sequence);
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let fallback: ReturnType<typeof setImmediate> | undefined;
    const removeErrorListener = (): void => {
      if (hasEvents) {
        events.removeListener?.("error", onError);
      }
    };
    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (fallback !== undefined) {
        clearImmediate(fallback);
      }
      removeErrorListener();
      callback();
    };
    const onError = (error: unknown): void => {
      finish(() => reject(error));
    };
    const onWritten = (error?: Error | null): void => {
      if (error !== undefined && error !== null) {
        finish(() => reject(error));
        return;
      }
      finish(resolve);
    };

    if (hasEvents) {
      once.call(events, "error", onError);
    }
    try {
      stream.write(sequence, onWritten);
      if (!settled && (!hasEvents || !supportsCallback)) {
        fallback = setImmediate(() => finish(resolve));
      }
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}
