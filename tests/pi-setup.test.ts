import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openDatabase } from "../src/persistence/database.ts";
import { PiInteractionStore } from "../src/persistence/pi-interaction-store.ts";
import {
  getPiSetupPaths,
  HARVEST_PI_DISCOVERY_FILE_NAME,
  HARVEST_PI_SUPPORT_DIRECTORY_NAME,
  installPiCollector,
  PI_COLLECTOR_SOURCE_FILES,
  PiSetupConflictError,
  statusPiCollector,
  uninstallPiCollector,
} from "../src/pi/setup.ts";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const setupBinary = join(repositoryRoot, "src", "bin", "pi-setup.ts");
const LEGACY_PI_COLLECTOR_SOURCE_FILES = [
  "src/pi/observer.ts",
  "src/pi/collector-contract.ts",
  "src/pi/diagnostics.ts",
  "src/pi/ingest-writer.ts",
  "src/pi/ingest.ts",
  "src/bin/ingest-pi.ts",
  "src/config/config.ts",
  "src/domain/pi-interaction.ts",
  "src/persistence/database.ts",
  "src/persistence/migrations.ts",
  "src/persistence/pi-interaction-store.ts",
] as const;
const LEGACY_DISCOVERY_MODULE = 'export { default } from "./herdr-harvest/src/pi/observer.ts";\n';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Pi collector setup", () => {
  test("installs the declared tree and reports an installed status", () => {
    const { home, sourceRoot } = fixture();
    assert.equal(statusPiCollector({ homeDir: home, sourceRoot }).status, "missing");
    const result = installPiCollector({ homeDir: home, sourceRoot });
    const paths = getPiSetupPaths(home);

    assert.equal(result.status, "installed");
    assert.equal(result.files.length, PI_COLLECTOR_SOURCE_FILES.length + 1);
    assert.equal(statusPiCollector({ homeDir: home, sourceRoot }).status, "installed");
    assert.match(readFileSync(paths.discoveryPath, "utf8"), /herdr-harvest\/src\/pi\/observer\.ts/);
    for (const relativePath of PI_COLLECTOR_SOURCE_FILES) {
      assert.equal(existsSync(join(paths.supportDirectory, relativePath)), true);
    }
  });

  test("updates an owned installation from the previous support-file plan", () => {
    const { home, sourceRoot } = fixture(
      "legacy home",
      "legacy source",
      LEGACY_PI_COLLECTOR_SOURCE_FILES,
    );
    writeLegacyPiInstallation(home, sourceRoot);
    const paths = getPiSetupPaths(home);

    assert.equal(
      statusPiCollector({ homeDir: home, sourceRoot: repositoryRoot }).status,
      "missing",
    );

    const result = installPiCollector({ homeDir: home, sourceRoot: repositoryRoot });

    assert.equal(result.status, "updated");
    assert.equal(
      existsSync(join(paths.supportDirectory, "src", "runtime", "is-main-module.ts")),
      true,
    );
    assert.equal(
      statusPiCollector({ homeDir: home, sourceRoot: repositoryRoot }).status,
      "installed",
    );
  });

  test("refuses to update an installation with a modified legacy file", () => {
    const { home, sourceRoot } = fixture(
      "modified legacy home",
      "modified legacy source",
      LEGACY_PI_COLLECTOR_SOURCE_FILES,
    );
    writeLegacyPiInstallation(home, sourceRoot);
    const paths = getPiSetupPaths(home);
    const trackedPath = join(paths.supportDirectory, "src", "pi", "observer.ts");
    const modifiedContent = "foreign replacement\n";
    writeFileSync(trackedPath, modifiedContent);

    assert.throws(
      () => installPiCollector({ homeDir: home, sourceRoot: repositoryRoot }),
      (error: unknown) => {
        assert.ok(error instanceof PiSetupConflictError);
        assert.match(error.message, /foreign file/i);
        assert.deepEqual(error.paths, [trackedPath]);
        return true;
      },
    );
    assert.equal(readFileSync(trackedPath, "utf8"), modifiedContent);
    assert.equal(
      existsSync(join(paths.supportDirectory, "src", "runtime", "is-main-module.ts")),
      false,
    );
  });

  test("executes the installed ingest entrypoint with its copied support tree", () => {
    const { home, sourceRoot } = fixture();
    const stateDirectory = join(home, "state");
    mkdirSync(stateDirectory, { recursive: true });
    installPiCollector({ homeDir: home, sourceRoot });

    const input = {
      interactionId: "installed-ingest-1",
      sessionId: "installed-session",
      submittedPrompt: "installed prompt",
      effectivePrompt: "installed effective prompt",
      finalReport: "installed report",
      status: "completed",
      reason: null,
      provenance: "pi-setup-test",
    };
    const installedIngest = join(
      getPiSetupPaths(home).supportDirectory,
      "src",
      "bin",
      "ingest-pi.ts",
    );
    const result = spawnSync(process.execPath, [installedIngest], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        HOME: join(home, "ignored-home-variable"),
        HARVEST_PI_COLLECT: "1",
        HARVEST_STATE_DIR: stateDirectory,
      },
      input: `${JSON.stringify(input)}\n`,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "inserted",
      interactionId: input.interactionId,
      sessionId: input.sessionId,
    });

    const db = openDatabase(join(stateDirectory, "harvest.db"));
    try {
      const store = new PiInteractionStore(db);
      const stored = store.get(input.sessionId, input.interactionId);
      assert.deepEqual(stored, {
        ...input,
        dedupKey: stored?.dedupKey,
      });
    } finally {
      db.close();
    }
  });

  test("reinstall is idempotent and does not rewrite installed files", () => {
    const { home, sourceRoot } = fixture();
    installPiCollector({ homeDir: home, sourceRoot });
    const paths = getPiSetupPaths(home);
    const before = new Map(
      [
        paths.discoveryPath,
        ...PI_COLLECTOR_SOURCE_FILES.map((file) => join(paths.supportDirectory, file)),
      ].map((filePath) => [filePath, statSync(filePath).mtimeMs]),
    );

    const result = installPiCollector({ homeDir: home, sourceRoot });

    assert.equal(result.status, "already-installed");
    for (const [filePath, mtimeMs] of before) {
      assert.equal(statSync(filePath).mtimeMs, mtimeMs);
    }
  });

  test("refreshes an owned installation when the source hash changes", () => {
    const { home, sourceRoot } = fixture();
    installPiCollector({ homeDir: home, sourceRoot });
    const sourcePath = join(sourceRoot, "src", "pi", "observer.ts");
    const targetPath = join(getPiSetupPaths(home).supportDirectory, "src", "pi", "observer.ts");
    const changedSource = `${readFileSync(sourcePath, "utf8")}\n// disposable source refresh\n`;
    writeFileSync(sourcePath, changedSource);

    const result = installPiCollector({ homeDir: home, sourceRoot });

    assert.equal(result.status, "updated");
    assert.equal(readFileSync(targetPath, "utf8"), changedSource);
    assert.equal(statusPiCollector({ homeDir: home, sourceRoot }).status, "installed");
  });

  test("refuses a foreign or unimportable file at the Harvest-owned discovery path", () => {
    const { home, sourceRoot } = fixture();
    const paths = getPiSetupPaths(home);
    mkdirSync(dirname(paths.discoveryPath), { recursive: true });
    const brokenDiscovery = "export default ???\n";
    writeFileSync(paths.discoveryPath, brokenDiscovery);

    assert.equal(statusPiCollector({ homeDir: home, sourceRoot }).status, "stale");

    assert.throws(
      () => installPiCollector({ homeDir: home, sourceRoot }),
      (error: unknown) => {
        assert.ok(error instanceof PiSetupConflictError);
        assert.match(error.message, /refusing to overwrite/i);
        return true;
      },
    );
    assert.equal(readFileSync(paths.discoveryPath, "utf8"), brokenDiscovery);
  });

  test("uninstalls only owned files and succeeds when repeated or absent", () => {
    const { home, sourceRoot } = fixture();
    const paths = getPiSetupPaths(home);
    const unrelatedRootFile = join(paths.extensionsDirectory, "keep-me.txt");
    const unrelatedSupportFile = join(paths.supportDirectory, "keep-me-too.txt");
    mkdirSync(paths.supportDirectory, { recursive: true });
    writeFileSync(unrelatedRootFile, "unrelated root content\n");
    writeFileSync(unrelatedSupportFile, "unrelated support content\n");
    installPiCollector({ homeDir: home, sourceRoot });

    const removed = uninstallPiCollector({ homeDir: home, sourceRoot });
    const absent = uninstallPiCollector({ homeDir: home, sourceRoot });

    assert.equal(removed.status, "uninstalled");
    assert.equal(removed.removed.length, PI_COLLECTOR_SOURCE_FILES.length + 2);
    assert.equal(absent.status, "absent");
    assert.equal(existsSync(paths.discoveryPath), false);
    assert.equal(existsSync(paths.manifestPath), false);
    assert.equal(readFileSync(unrelatedRootFile, "utf8"), "unrelated root content\n");
    assert.equal(readFileSync(unrelatedSupportFile, "utf8"), "unrelated support content\n");
    assert.equal(statusPiCollector({ homeDir: home, sourceRoot }).status, "missing");
  });

  test("handles home and source paths containing spaces", () => {
    const { home, sourceRoot } = fixture("home with spaces", "source tree with spaces");

    const result = installPiCollector({ homeDir: home, sourceRoot });

    assert.equal(result.status, "installed");
    assert.equal(statusPiCollector({ homeDir: home, sourceRoot }).status, "installed");
    assert.equal(uninstallPiCollector({ homeDir: home, sourceRoot }).status, "uninstalled");
  });

  test("reports a stale status without changing a modified target", () => {
    const { home, sourceRoot } = fixture();
    installPiCollector({ homeDir: home, sourceRoot });
    const targetPath = join(getPiSetupPaths(home).supportDirectory, "src", "pi", "observer.ts");
    writeFileSync(targetPath, "foreign replacement\n");

    const result = statusPiCollector({ homeDir: home, sourceRoot });

    assert.equal(result.status, "stale");
    assert.equal(readFileSync(targetPath, "utf8"), "foreign replacement\n");
  });

  test("does not remove an owned file after it has been modified", () => {
    const { home, sourceRoot } = fixture();
    installPiCollector({ homeDir: home, sourceRoot });
    const targetPath = join(getPiSetupPaths(home).supportDirectory, "src", "pi", "observer.ts");
    writeFileSync(targetPath, "foreign replacement\n");

    assert.throws(
      () => uninstallPiCollector({ homeDir: home, sourceRoot }),
      (error: unknown) => error instanceof PiSetupConflictError,
    );
    assert.equal(readFileSync(targetPath, "utf8"), "foreign replacement\n");
  });

  test("loads the installed observer through its preserved relative layout", async () => {
    const { home } = fixture();
    installPiCollector({ homeDir: home, sourceRoot: repositoryRoot });
    const discoveryPath = getPiSetupPaths(home).discoveryPath;

    const installedModule = await import(pathToFileURL(discoveryPath).href);
    const sourceModule = await import(
      pathToFileURL(join(repositoryRoot, "src", "pi", "observer.ts")).href
    );

    assert.equal(typeof installedModule.default, "function");
    assert.equal(typeof sourceModule.default, typeof installedModule.default);
  });

  test("supports the thin CLI adapter without using the real home directory", () => {
    const { home } = fixture("cli home with spaces");
    const result = spawnSync(process.execPath, [setupBinary, "install", "--home", home], {
      cwd: repositoryRoot,
      env: { ...process.env, HOME: join(home, "ignored-home-variable") },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /installed/i);
    assert.equal(statusPiCollector({ homeDir: home }).status, "installed");
  });
});

function fixture(
  homeName = "home",
  sourceName = "source",
  sourceFiles: readonly string[] = PI_COLLECTOR_SOURCE_FILES,
): {
  home: string;
  sourceRoot: string;
} {
  const base = mkdtempSync(join(tmpdir(), "herdr-harvest-pi-setup-"));
  temporaryDirectories.push(base);
  const home = join(base, homeName);
  const sourceRoot = join(base, sourceName);
  mkdirSync(home, { recursive: true });
  mkdirSync(sourceRoot, { recursive: true });
  for (const relativePath of sourceFiles) {
    const target = join(sourceRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(repositoryRoot, relativePath), target);
  }
  return { home, sourceRoot };
}

function writeLegacyPiInstallation(home: string, sourceRoot: string): void {
  const paths = getPiSetupPaths(home);
  mkdirSync(paths.extensionsDirectory, { recursive: true });
  writeFileSync(paths.discoveryPath, LEGACY_DISCOVERY_MODULE);

  const files = [
    {
      path: HARVEST_PI_DISCOVERY_FILE_NAME,
      sha256: sha256(LEGACY_DISCOVERY_MODULE),
    },
  ];
  for (const relativePath of LEGACY_PI_COLLECTOR_SOURCE_FILES) {
    const sourcePath = join(sourceRoot, relativePath);
    const targetPath = join(paths.supportDirectory, relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    cpSync(sourcePath, targetPath);
    files.push({
      path: `${HARVEST_PI_SUPPORT_DIRECTORY_NAME}/${relativePath}`,
      sha256: sha256(readFileSync(sourcePath)),
    });
  }

  const payload = JSON.stringify({ format: 1, files });
  writeFileSync(
    paths.manifestPath,
    `${JSON.stringify({ format: 1, files, manifestSha256: sha256(payload) })}\n`,
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
