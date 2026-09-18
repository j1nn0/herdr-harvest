import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Returns whether argv1 names this module, including through a symlink. */
export function isMainModule(importMetaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }

  let modulePath: string;
  try {
    modulePath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }

  try {
    return realpathSync(argv1) === modulePath;
  } catch {
    try {
      return resolve(argv1) === resolve(modulePath);
    } catch {
      return false;
    }
  }
}
