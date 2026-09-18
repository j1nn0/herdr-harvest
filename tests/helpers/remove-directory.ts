import { rmSync } from "node:fs";

export function removeDirectory(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
