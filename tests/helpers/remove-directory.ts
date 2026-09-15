import { rmSync } from "node:fs";

export function removeDirectory(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
