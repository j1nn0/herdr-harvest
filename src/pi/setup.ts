import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Files copied below the fixed Harvest-owned support directory. */
export const PI_COLLECTOR_SOURCE_FILES = [
  "src/pi/observer.ts",
  "src/pi/collector-contract.ts",
  "src/pi/diagnostics.ts",
  "src/pi/ingest-writer.ts",
  "src/pi/ingest.ts",
  "src/bin/ingest-pi.ts",
  "src/runtime/is-main-module.ts",
  "src/config/config.ts",
  "src/domain/pi-interaction.ts",
  "src/persistence/database.ts",
  "src/persistence/migrations.ts",
  "src/persistence/pi-interaction-store.ts",
] as const;

export const HARVEST_PI_DISCOVERY_FILE_NAME = "herdr-harvest.ts";
export const HARVEST_PI_SUPPORT_DIRECTORY_NAME = "herdr-harvest";
export const HARVEST_PI_MANIFEST_FILE_NAME = ".harvest-manifest.json";

const MANIFEST_FORMAT = 1;
const DISCOVERY_MODULE = 'export { default } from "./herdr-harvest/src/pi/observer.ts";\n';
const DEFAULT_SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

export interface PiSetupPaths {
  homeDirectory: string;
  extensionsDirectory: string;
  discoveryPath: string;
  supportDirectory: string;
  manifestPath: string;
}

export interface PiSetupOptions {
  homeDir: string;
  sourceRoot?: string;
}

export type PiSetupStatus = "installed" | "missing" | "stale";

export interface PiSetupFileStatus {
  path: string;
  status: "installed" | "missing" | "stale";
}

export interface PiSetupStatusResult {
  status: PiSetupStatus;
  paths: PiSetupPaths;
  files: PiSetupFileStatus[];
  reason?: string;
}

export interface PiSetupInstallResult {
  status: "installed" | "updated" | "already-installed";
  paths: PiSetupPaths;
  files: string[];
}

export interface PiSetupUninstallResult {
  status: "uninstalled" | "absent";
  paths: PiSetupPaths;
  removed: string[];
}

/** A target path is occupied by content that this installer cannot prove it owns. */
export class PiSetupConflictError extends Error {
  readonly paths: string[];

  constructor(message: string, paths: string[] = []) {
    super(message);
    this.name = "PiSetupConflictError";
    this.paths = paths;
  }
}

/** A setup input or source tree is invalid before any target write is attempted. */
export class PiSetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSetupValidationError";
  }
}

export function getPiSetupPaths(homeDir: string): PiSetupPaths {
  const homeDirectory = resolveRequiredPath(homeDir, "home directory");
  const extensionsDirectory = join(homeDirectory, ".pi", "agent", "extensions");
  const supportDirectory = join(extensionsDirectory, HARVEST_PI_SUPPORT_DIRECTORY_NAME);
  return {
    homeDirectory,
    extensionsDirectory,
    discoveryPath: join(extensionsDirectory, HARVEST_PI_DISCOVERY_FILE_NAME),
    supportDirectory,
    manifestPath: join(supportDirectory, HARVEST_PI_MANIFEST_FILE_NAME),
  };
}

/** Install or refresh the observer and its relative-import support tree. */
export function installPiCollector(options: PiSetupOptions): PiSetupInstallResult {
  const paths = getPiSetupPaths(options.homeDir);
  assertSafeHome(paths.homeDirectory);
  const plan = buildFilePlan(paths, options.sourceRoot);
  assertSafeAncestors(paths);

  const manifest = readManifest(paths);
  if (manifest.kind === "invalid") {
    throw new PiSetupConflictError(
      `Harvest Pi setup found an invalid ownership manifest; refusing to overwrite: ${paths.manifestPath}`,
      [paths.manifestPath],
    );
  }

  const targetConflicts =
    manifest.kind === "missing"
      ? plan
          .filter((file) => pathKind(file.targetPath) !== "missing")
          .map((file) => file.targetPath)
      : plan
          .filter(
            (file) =>
              pathKind(file.targetPath) !== "missing" &&
              !isOwnedTarget(file.targetPath, manifestHash(manifest.manifest, file.relativePath)),
          )
          .map((file) => file.targetPath);
  if (targetConflicts.length > 0) {
    throw new PiSetupConflictError(
      `Harvest Pi setup found a foreign file and is refusing to overwrite: ${targetConflicts.join(", ")}`,
      targetConflicts,
    );
  }

  ensureDirectoryPath(paths.extensionsDirectory);
  for (const file of plan) {
    ensureDirectoryPath(dirname(file.targetPath));
  }

  const currentManifest = manifest.kind === "valid" ? manifest.manifest : undefined;
  const alreadyCurrent =
    currentManifest !== undefined &&
    plan.every((file) => pathKind(file.targetPath) === "file" && fileMatches(file)) &&
    manifestMatchesPlan(currentManifest, plan);
  if (alreadyCurrent) {
    return { status: "already-installed", paths, files: plan.map((file) => file.targetPath) };
  }

  for (const file of plan) {
    if (pathKind(file.targetPath) !== "file" || !fileMatches(file)) {
      writeOwnedFile(file.targetPath, file.content, file.hash);
    }
  }

  const manifestText = encodeManifest(plan);
  writeOwnedFile(paths.manifestPath, Buffer.from(manifestText, "utf8"), sha256(manifestText));
  verifyPlan(plan);
  verifyManifest(paths, plan);

  return {
    status: currentManifest === undefined ? "installed" : "updated",
    paths,
    files: plan.map((file) => file.targetPath),
  };
}

/** Remove only files whose hashes are attested by the Harvest ownership manifest. */
export function uninstallPiCollector(options: PiSetupOptions): PiSetupUninstallResult {
  const paths = getPiSetupPaths(options.homeDir);
  assertSafeHome(paths.homeDirectory);
  assertSafeAncestors(paths);
  const manifest = readManifest(paths);
  const plan = declaredTargetPaths(paths);

  if (manifest.kind === "missing") {
    const occupied = plan
      .filter((file) => pathKind(file.targetPath) !== "missing")
      .map((file) => file.targetPath);
    if (occupied.length > 0) {
      throw new PiSetupConflictError(
        `Harvest Pi setup has no ownership manifest; refusing to remove foreign files: ${occupied.join(", ")}`,
        occupied,
      );
    }
    return { status: "absent", paths, removed: [] };
  }
  if (manifest.kind === "invalid") {
    throw new PiSetupConflictError(
      `Harvest Pi setup found an invalid ownership manifest; refusing to remove files: ${paths.manifestPath}`,
      [paths.manifestPath],
    );
  }

  const conflicts = plan
    .filter(
      (file) =>
        pathKind(file.targetPath) !== "missing" &&
        !isOwnedTarget(file.targetPath, manifestHash(manifest.manifest, file.relativePath)),
    )
    .map((file) => file.targetPath);
  if (conflicts.length > 0) {
    throw new PiSetupConflictError(
      `Harvest Pi setup found modified files; refusing to remove them: ${conflicts.join(", ")}`,
      conflicts,
    );
  }

  const removed: string[] = [];
  for (const file of plan) {
    if (pathKind(file.targetPath) === "file") {
      unlinkSync(file.targetPath);
      removed.push(file.targetPath);
    }
  }
  if (pathKind(paths.manifestPath) === "file") {
    unlinkSync(paths.manifestPath);
    removed.push(paths.manifestPath);
  }
  return { status: "uninstalled", paths, removed };
}

/** Report installation state without creating directories or changing files. */
export function statusPiCollector(options: PiSetupOptions): PiSetupStatusResult {
  const paths = getPiSetupPaths(options.homeDir);
  const plan = buildFilePlan(paths, options.sourceRoot);
  const files = plan.map((file) => ({
    path: file.targetPath,
    status: "missing" as PiSetupFileStatus["status"],
  }));
  const unsafePath = findUnsafeAncestor(paths);
  if (unsafePath !== undefined) {
    return {
      status: "stale",
      paths,
      files: files.map((file) => ({ ...file, status: "stale" })),
      reason: `unsafe setup path: ${unsafePath}`,
    };
  }
  const manifest = readManifest(paths);
  if (manifest.kind === "invalid") {
    return {
      status: "stale",
      paths,
      files: files.map((file) => ({ ...file, status: "stale" })),
      reason: "invalid ownership manifest",
    };
  }

  let hasMissing = false;
  let hasStale = false;
  for (const [index, file] of plan.entries()) {
    const kind = pathKind(file.targetPath);
    if (kind === "missing") {
      hasMissing = true;
      continue;
    }
    if (
      kind !== "file" ||
      manifest.kind === "missing" ||
      !isOwnedTarget(file.targetPath, manifestHash(manifest.manifest, file.relativePath))
    ) {
      const fileStatus = files[index];
      if (fileStatus === undefined) {
        throw new Error("Harvest Pi setup status lost a declared file.");
      }
      fileStatus.status = "stale";
      hasStale = true;
      continue;
    }
    const fileStatus = files[index];
    if (fileStatus === undefined) {
      throw new Error("Harvest Pi setup status lost a declared file.");
    }
    fileStatus.status = fileMatches(file) ? "installed" : "stale";
    hasStale ||= fileStatus.status === "stale";
  }

  if (manifest.kind === "missing") {
    return {
      status: hasStale ? "stale" : "missing",
      paths,
      files,
      reason: hasStale ? "managed files exist without an ownership manifest" : undefined,
    };
  }
  if (hasStale) {
    return { status: "stale", paths, files, reason: "content hash mismatch" };
  }
  if (hasMissing) {
    return { status: "missing", paths, files, reason: "one or more managed files are missing" };
  }
  return { status: "installed", paths, files };
}

interface PlannedFile {
  relativePath: string;
  targetPath: string;
  content: Buffer;
  hash: string;
}

interface ManifestEntry {
  path: string;
  sha256: string;
}

interface Manifest {
  format: number;
  files: ManifestEntry[];
  manifestSha256: string;
}

type ManifestRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; manifest: Manifest };

type PathKind = "missing" | "file" | "directory" | "symlink" | "other";

function buildFilePlan(paths: PiSetupPaths, sourceRootOption?: string): PlannedFile[] {
  const sourceRoot = resolveRequiredPath(
    sourceRootOption ?? DEFAULT_SOURCE_ROOT,
    "Harvest source root",
  );
  const plan: PlannedFile[] = [
    plannedFile(
      HARVEST_PI_DISCOVERY_FILE_NAME,
      paths.discoveryPath,
      Buffer.from(DISCOVERY_MODULE, "utf8"),
    ),
  ];
  for (const relativePath of PI_COLLECTOR_SOURCE_FILES) {
    const sourcePath = join(sourceRoot, relativePath);
    let content: Buffer;
    try {
      content = readFileSync(sourcePath);
    } catch {
      throw new PiSetupValidationError(`Harvest source file is unavailable: ${sourcePath}`);
    }
    plan.push(
      plannedFile(
        `${HARVEST_PI_SUPPORT_DIRECTORY_NAME}/${relativePath}`,
        join(paths.supportDirectory, relativePath),
        content,
      ),
    );
  }
  return plan;
}

function declaredTargetPaths(paths: PiSetupPaths): PlannedFile[] {
  return [
    {
      relativePath: HARVEST_PI_DISCOVERY_FILE_NAME,
      targetPath: paths.discoveryPath,
      content: Buffer.alloc(0),
      hash: "",
    },
    ...PI_COLLECTOR_SOURCE_FILES.map((relativePath) => ({
      relativePath: `${HARVEST_PI_SUPPORT_DIRECTORY_NAME}/${relativePath}`,
      targetPath: join(paths.supportDirectory, relativePath),
      content: Buffer.alloc(0),
      hash: "",
    })),
  ];
}

function plannedFile(relativePath: string, targetPath: string, content: Buffer): PlannedFile {
  return { relativePath, targetPath, content, hash: sha256(content) };
}

function readManifest(paths: PiSetupPaths): ManifestRead {
  const kind = pathKind(paths.manifestPath);
  if (kind === "missing") {
    return { kind: "missing" };
  }
  if (kind !== "file") {
    return { kind: "invalid" };
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(paths.manifestPath, "utf8"));
  } catch {
    return { kind: "invalid" };
  }
  if (!isRecord(value) || value.format !== MANIFEST_FORMAT) {
    return { kind: "invalid" };
  }
  const files = value.files;
  const manifestSha256 = value.manifestSha256;
  if (
    !Array.isArray(files) ||
    typeof manifestSha256 !== "string" ||
    files.length !== PI_COLLECTOR_SOURCE_FILES.length + 1
  ) {
    return { kind: "invalid" };
  }
  const expectedPaths = declaredRelativePaths();
  const entries: ManifestEntry[] = [];
  for (const [index, entry] of files.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path !== expectedPaths[index] ||
      !isSha256(entry.sha256)
    ) {
      return { kind: "invalid" };
    }
    entries.push({ path: entry.path, sha256: entry.sha256 });
  }
  const expectedManifestHash = sha256(manifestPayload(entries));
  if (manifestSha256 !== expectedManifestHash) {
    return { kind: "invalid" };
  }
  return { kind: "valid", manifest: { format: MANIFEST_FORMAT, files: entries, manifestSha256 } };
}

function encodeManifest(plan: PlannedFile[]): string {
  const files = plan.map(({ relativePath, hash }) => ({ path: relativePath, sha256: hash }));
  return `${JSON.stringify({
    format: MANIFEST_FORMAT,
    files,
    manifestSha256: sha256(manifestPayload(files)),
  })}\n`;
}

function manifestPayload(files: ManifestEntry[]): string {
  return JSON.stringify({ format: MANIFEST_FORMAT, files });
}

function declaredRelativePaths(): string[] {
  return [
    HARVEST_PI_DISCOVERY_FILE_NAME,
    ...PI_COLLECTOR_SOURCE_FILES.map(
      (relativePath) => `${HARVEST_PI_SUPPORT_DIRECTORY_NAME}/${relativePath}`,
    ),
  ];
}

function manifestMatchesPlan(manifest: Manifest, plan: PlannedFile[]): boolean {
  return manifest.files.every(
    (entry, index) =>
      entry.path === plan[index]?.relativePath && entry.sha256 === plan[index]?.hash,
  );
}

function manifestHash(manifest: Manifest, relativePath: string): string | undefined {
  return manifest.files.find((entry) => entry.path === relativePath)?.sha256;
}

function isOwnedTarget(targetPath: string, expectedHash: string | undefined): boolean {
  return (
    expectedHash !== undefined &&
    pathKind(targetPath) === "file" &&
    sha256(readFileSync(targetPath)) === expectedHash
  );
}

function fileMatches(file: PlannedFile): boolean {
  return (
    pathKind(file.targetPath) === "file" && sha256(readFileSync(file.targetPath)) === file.hash
  );
}

function verifyPlan(plan: PlannedFile[]): void {
  for (const file of plan) {
    if (!fileMatches(file)) {
      throw new Error(`Harvest Pi setup failed to verify ${file.targetPath}.`);
    }
  }
}

function verifyManifest(paths: PiSetupPaths, plan: PlannedFile[]): void {
  const manifest = readManifest(paths);
  if (manifest.kind !== "valid" || !manifestMatchesPlan(manifest.manifest, plan)) {
    throw new Error(`Harvest Pi setup failed to verify ${paths.manifestPath}.`);
  }
}

function writeOwnedFile(targetPath: string, content: Buffer, expectedHash: string): void {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, targetPath);
    if (sha256(readFileSync(targetPath)) !== expectedHash) {
      throw new Error(`Harvest Pi setup failed to verify ${targetPath}.`);
    }
  } finally {
    if (pathKind(temporaryPath) === "file") {
      unlinkSync(temporaryPath);
    }
  }
}

function assertSafeHome(homeDirectory: string): void {
  if (pathKind(homeDirectory) !== "directory") {
    throw new PiSetupValidationError(
      `Target home directory is not an existing directory: ${homeDirectory}`,
    );
  }
}

function assertSafeAncestors(paths: PiSetupPaths): void {
  const unsafePath = findUnsafeAncestor(paths);
  if (unsafePath !== undefined) {
    throw new PiSetupConflictError(`Harvest Pi setup path is not a safe directory: ${unsafePath}`, [
      unsafePath,
    ]);
  }
}

function findUnsafeAncestor(paths: PiSetupPaths): string | undefined {
  const homeKind = pathKind(paths.homeDirectory);
  if (homeKind !== "missing" && homeKind !== "directory") {
    return paths.homeDirectory;
  }
  for (const targetPath of [
    ...declaredTargetPaths(paths).map((file) => file.targetPath),
    paths.manifestPath,
  ]) {
    let current = dirname(targetPath);
    while (current !== paths.homeDirectory && current !== dirname(current)) {
      const kind = pathKind(current);
      if (kind !== "missing" && kind !== "directory") {
        return current;
      }
      current = dirname(current);
    }
  }
  return undefined;
}

function ensureDirectoryPath(directoryPath: string): void {
  const missing: string[] = [];
  let current = directoryPath;
  while (true) {
    const kind = pathKind(current);
    if (kind === "missing") {
      missing.push(current);
      current = dirname(current);
      continue;
    }
    if (kind !== "directory") {
      throw new PiSetupConflictError(`Harvest Pi setup path is not a directory: ${current}`, [
        current,
      ]);
    }
    break;
  }
  for (const path of missing.reverse()) {
    mkdirSync(path, { mode: 0o700 });
  }
}

function pathKind(path: string): PathKind {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      return "symlink";
    }
    if (stats.isFile()) {
      return "file";
    }
    if (stats.isDirectory()) {
      return "directory";
    }
    return "other";
  } catch (error) {
    if (isMissingError(error)) {
      return "missing";
    }
    throw error;
  }
}

function resolveRequiredPath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PiSetupValidationError(`${label} must be a non-empty path.`);
  }
  return resolve(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
