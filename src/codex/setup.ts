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

/** Runtime files copied below the fixed Harvest-owned Codex support directory. */
export const CODEX_COLLECTOR_SOURCE_FILES = [
  "src/codex/submit-hook.ts",
  "src/codex/stop-hook.ts",
  "src/codex/notify-commit.ts",
  "src/codex/hook-runtime.ts",
  "src/codex/ingest.ts",
  "src/codex/staging.ts",
  "src/codex/collector-contract.ts",
  "src/config/config.ts",
  "src/domain/pi-interaction.ts",
  "src/persistence/database.ts",
  "src/persistence/migrations.ts",
  "src/persistence/pi-interaction-store.ts",
  "src/bin/ingest-codex.ts",
] as const;

export const HARVEST_CODEX_SUPPORT_DIRECTORY_NAME = "herdr-harvest";
export const HARVEST_CODEX_MANIFEST_FILE_NAME = ".harvest-manifest.json";
export const HARVEST_CODEX_HOOKS_FILE_NAME = "hooks.json";
export const HARVEST_CODEX_CONFIG_FILE_NAME = "config.toml";

const MANIFEST_FORMAT = 1;
const HOOK_TIMEOUT_SECONDS = 15;
const DEFAULT_SOURCE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CODEX_HOOK_EVENTS = ["UserPromptSubmit", "Stop"] as const;

type CodexHookEvent = (typeof CODEX_HOOK_EVENTS)[number];
export type CodexSetupStatus = "installed" | "missing" | "stale";
export type CodexNotifyStatus = CodexSetupStatus;

export interface CodexSetupPaths {
  homeDirectory: string;
  codexDirectory: string;
  hooksPath: string;
  configPath: string;
  supportDirectory: string;
  manifestPath: string;
}

export interface CodexSetupOptions {
  homeDir: string;
  sourceRoot?: string;
}

export interface CodexSetupFileStatus {
  path: string;
  status: CodexSetupStatus;
}

export interface CodexSetupHookStatus {
  event: CodexHookEvent;
  status: CodexSetupStatus;
  path: string;
}

export interface CodexSetupStatusResult {
  status: CodexSetupStatus;
  paths: CodexSetupPaths;
  files: CodexSetupFileStatus[];
  hooks: CodexSetupHookStatus[];
  notify: CodexNotifyStatus;
  notifyLine: string;
  trust: "unknown";
  pendingCodexTurns: number;
  reason?: string;
}

export interface CodexSetupInstallResult {
  status: "installed" | "updated" | "already-installed";
  paths: CodexSetupPaths;
  files: string[];
  hooks: CodexHookEvent[];
  notify: CodexNotifyStatus;
  notifyLine: string;
  trust: "unknown";
}

export interface CodexSetupUninstallResult {
  status: "uninstalled" | "absent";
  paths: CodexSetupPaths;
  removed: string[];
  notify: CodexNotifyStatus;
  notifyLine: string;
}

/** A target is occupied by content that Harvest cannot prove it owns. */
export class CodexSetupConflictError extends Error {
  readonly paths: string[];

  constructor(message: string, paths: string[] = []) {
    super(message);
    this.name = "CodexSetupConflictError";
    this.paths = paths;
  }
}

/** A setup input or source tree is invalid before any target write is attempted. */
export class CodexSetupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSetupValidationError";
  }
}

export function getCodexSetupPaths(homeDir: string): CodexSetupPaths {
  const homeDirectory = resolveRequiredPath(homeDir, "home directory");
  const codexDirectory = join(homeDirectory, ".codex");
  const supportDirectory = join(codexDirectory, HARVEST_CODEX_SUPPORT_DIRECTORY_NAME);
  return {
    homeDirectory,
    codexDirectory,
    hooksPath: join(codexDirectory, HARVEST_CODEX_HOOKS_FILE_NAME),
    configPath: join(codexDirectory, HARVEST_CODEX_CONFIG_FILE_NAME),
    supportDirectory,
    manifestPath: join(supportDirectory, HARVEST_CODEX_MANIFEST_FILE_NAME),
  };
}

/** Install or refresh the user-level Codex hook support and hook groups. */
export function installCodexCollector(options: CodexSetupOptions): CodexSetupInstallResult {
  const paths = getCodexSetupPaths(options.homeDir);
  assertSafeHome(paths.homeDirectory);
  const plan = buildFilePlan(paths, options.sourceRoot);
  assertSafeAncestors(paths);

  const manifest = readManifest(paths);
  if (manifest.kind === "invalid") {
    throw new CodexSetupConflictError(
      `Harvest Codex setup found an invalid ownership manifest; refusing to overwrite: ${paths.manifestPath}`,
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
    throw new CodexSetupConflictError(
      `Harvest Codex setup found a foreign support file and is refusing to overwrite: ${targetConflicts.join(", ")}`,
      targetConflicts,
    );
  }

  const expectedHooks = expectedHookGroups(paths);
  const hooks = readHooksDocument(paths.hooksPath);
  const hookStatuses = inspectHookGroups(hooks, expectedHooks, paths.hooksPath);
  const hookConflicts =
    manifest.kind === "valid"
      ? hookStatuses.filter((item) => item.status === "stale")
      : hookStatuses.filter((item) => item.status !== "missing");
  if (hookConflicts.length > 0) {
    throw new CodexSetupConflictError(
      `Harvest Codex setup found foreign or modified hook content and is refusing to overwrite: ${paths.hooksPath}`,
      [paths.hooksPath],
    );
  }

  const notify = inspectNotify(paths.configPath, expectedNotifyArgv(paths));
  if (notify.status === "stale") {
    throw new CodexSetupConflictError(
      `Harvest Codex setup found a conflicting notify entry and will not edit ${paths.configPath}.`,
      [paths.configPath],
    );
  }

  const hooksText = addMissingHookGroups(hooks, expectedHooks, hookStatuses);
  const currentManifest = manifest.kind === "valid" ? manifest.manifest : undefined;
  const alreadyCurrent =
    currentManifest !== undefined &&
    plan.every((file) => pathKind(file.targetPath) === "file" && fileMatches(file)) &&
    manifestMatchesPlan(currentManifest, plan, paths) &&
    hooksText === hooks.source;
  if (alreadyCurrent) {
    return {
      status: "already-installed",
      paths,
      files: plan.map((file) => file.targetPath),
      hooks: [...CODEX_HOOK_EVENTS],
      notify: notify.status,
      notifyLine: notifyLine(paths),
      trust: "unknown",
    };
  }

  ensureDirectoryPath(paths.codexDirectory);
  ensureDirectoryPath(paths.supportDirectory);
  for (const file of plan) {
    ensureDirectoryPath(dirname(file.targetPath));
  }

  for (const file of plan) {
    if (pathKind(file.targetPath) !== "file" || !fileMatches(file)) {
      writeOwnedFile(file.targetPath, file.content, file.hash);
    }
  }

  const nextManifest = createManifest(plan, paths);
  const manifestText = encodeManifest(nextManifest);
  writeOwnedFile(paths.manifestPath, Buffer.from(manifestText, "utf8"), sha256(manifestText));
  if (hooksText !== hooks.source) {
    writeOwnedFile(paths.hooksPath, Buffer.from(hooksText, "utf8"), sha256(hooksText));
  }

  verifyPlan(plan);
  verifyManifest(paths, plan);
  verifyHookRegistration(paths.hooksPath, expectedHooks);

  return {
    status: currentManifest === undefined ? "installed" : "updated",
    paths,
    files: plan.map((file) => file.targetPath),
    hooks: [...CODEX_HOOK_EVENTS],
    notify: notify.status,
    notifyLine: notifyLine(paths),
    trust: "unknown",
  };
}

/** Remove only manifest-attested support files and exact Harvest hook groups. */
export function uninstallCodexCollector(options: CodexSetupOptions): CodexSetupUninstallResult {
  const paths = getCodexSetupPaths(options.homeDir);
  assertSafeHome(paths.homeDirectory);
  const plan = buildFilePlan(paths, options.sourceRoot);
  assertSafeAncestors(paths);

  const manifest = readManifest(paths);
  const expectedHooks = expectedHookGroups(paths);
  const hooks = readHooksDocument(paths.hooksPath);
  const hookStatuses = inspectHookGroups(hooks, expectedHooks, paths.hooksPath);
  const notify = inspectNotify(paths.configPath, expectedNotifyArgv(paths));
  if (notify.status === "stale") {
    throw new CodexSetupConflictError(
      `Harvest Codex setup found a conflicting notify entry and will not remove support files: ${paths.configPath}`,
      [paths.configPath],
    );
  }

  if (manifest.kind === "invalid") {
    throw new CodexSetupConflictError(
      `Harvest Codex setup found an invalid ownership manifest; refusing to remove files: ${paths.manifestPath}`,
      [paths.manifestPath],
    );
  }

  if (manifest.kind === "missing") {
    const occupied = plan
      .filter((file) => pathKind(file.targetPath) !== "missing")
      .map((file) => file.targetPath);
    const hookOccupied = hookStatuses.some((item) => item.status !== "missing");
    if (occupied.length > 0 || hookOccupied) {
      const conflicts = [...occupied];
      if (hookOccupied) {
        conflicts.push(paths.hooksPath);
      }
      throw new CodexSetupConflictError(
        `Harvest Codex setup has no ownership manifest; refusing to remove unverified content: ${conflicts.join(", ")}`,
        conflicts,
      );
    }
    return {
      status: "absent",
      paths,
      removed: [],
      notify: notify.status,
      notifyLine: notifyLine(paths),
    };
  }

  const conflicts = plan
    .filter(
      (file) =>
        pathKind(file.targetPath) !== "missing" &&
        !isOwnedTarget(file.targetPath, manifestHash(manifest.manifest, file.relativePath)),
    )
    .map((file) => file.targetPath);
  if (conflicts.length > 0) {
    throw new CodexSetupConflictError(
      `Harvest Codex setup found modified support files; refusing to remove them: ${conflicts.join(", ")}`,
      conflicts,
    );
  }

  if (hookStatuses.some((item) => item.status === "stale")) {
    throw new CodexSetupConflictError(
      `Harvest Codex setup found modified hook content; refusing to remove it: ${paths.hooksPath}`,
      [paths.hooksPath],
    );
  }

  const removed: string[] = [];
  if (hooks.kind === "valid") {
    const nextHooks = removeOwnedHookGroups(hooks, expectedHooks, hookStatuses);
    if (nextHooks !== hooks.source) {
      writeOwnedFile(paths.hooksPath, Buffer.from(nextHooks, "utf8"), sha256(nextHooks));
      removed.push(paths.hooksPath);
    }
  }
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
  return {
    status: "uninstalled",
    paths,
    removed,
    notify: notify.status,
    notifyLine: notifyLine(paths),
  };
}

/** Report setup state without creating directories or modifying user config. */
export function statusCodexCollector(
  options: CodexSetupOptions,
  pendingCodexTurns = 0,
): CodexSetupStatusResult {
  const paths = getCodexSetupPaths(options.homeDir);
  assertSafeHome(paths.homeDirectory);
  const plan = buildFilePlan(paths, options.sourceRoot);
  const files = plan.map((file) => ({
    path: file.targetPath,
    status: "missing" as CodexSetupStatus,
  }));
  const unsafePath = findUnsafeAncestor(paths);
  if (unsafePath !== undefined) {
    return {
      status: "stale",
      paths,
      files: files.map((file) => ({ ...file, status: "stale" })),
      hooks: CODEX_HOOK_EVENTS.map((event) => ({ event, status: "stale", path: paths.hooksPath })),
      notify: "stale",
      notifyLine: notifyLine(paths),
      trust: "unknown",
      pendingCodexTurns,
      reason: `unsafe setup path: ${unsafePath}`,
    };
  }

  const manifest = readManifest(paths);
  const expectedHooks = expectedHookGroups(paths);
  const hooks = readHooksDocument(paths.hooksPath);
  const inspectedHooks = inspectHookGroups(hooks, expectedHooks, paths.hooksPath);
  const hookStatuses =
    manifest.kind === "valid"
      ? inspectedHooks
      : inspectedHooks.map((item) => ({
          ...item,
          status: item.status === "installed" ? ("stale" as const) : item.status,
        }));
  const notify = inspectNotify(paths.configPath, expectedNotifyArgv(paths));

  if (manifest.kind === "invalid") {
    return {
      status: "stale",
      paths,
      files: files.map((file) => ({ ...file, status: "stale" })),
      hooks: hookStatuses.map((item) => ({ ...item, status: "stale" })),
      notify: notify.status,
      notifyLine: notifyLine(paths),
      trust: "unknown",
      pendingCodexTurns,
      reason: "invalid ownership manifest",
    };
  }

  let hasMissing = false;
  let hasStale = false;
  for (const [index, file] of plan.entries()) {
    const fileStatus = files[index];
    if (fileStatus === undefined) {
      throw new Error("Harvest Codex setup status lost a declared file.");
    }
    const kind = pathKind(file.targetPath);
    if (kind === "missing") {
      hasMissing = true;
      continue;
    }
    if (
      kind !== "file" ||
      manifest.kind !== "valid" ||
      !isOwnedTarget(file.targetPath, manifestHash(manifest.manifest, file.relativePath))
    ) {
      fileStatus.status = "stale";
      hasStale = true;
      continue;
    }
    fileStatus.status = fileMatches(file) ? "installed" : "stale";
    hasStale ||= fileStatus.status === "stale";
  }

  for (const item of hookStatuses) {
    hasMissing ||= item.status === "missing";
    hasStale ||= item.status === "stale";
  }
  hasMissing ||= notify.status === "missing";
  hasStale ||= notify.status === "stale";

  const status: CodexSetupStatus = hasStale ? "stale" : hasMissing ? "missing" : "installed";
  const reasons: string[] = [];
  if (manifest.kind === "missing") {
    reasons.push("ownership manifest is missing");
  }
  if (notify.status === "missing") {
    reasons.push("notify is not configured; merge the printed top-level line into config.toml");
  } else if (notify.status === "stale") {
    reasons.push("notify configuration is malformed or conflicts with Harvest");
  }
  return {
    status,
    paths,
    files,
    hooks: hookStatuses,
    notify: notify.status,
    notifyLine: notifyLine(paths),
    trust: "unknown",
    pendingCodexTurns,
    reason: reasons.length > 0 ? reasons.join("; ") : undefined,
  };
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

interface ManifestHookEntry {
  event: CodexHookEvent;
  command: string;
  sha256: string;
}

interface CodexManifest {
  format: number;
  files: ManifestEntry[];
  hooks: ManifestHookEntry[];
  notifyArgv: string[];
  manifestSha256: string;
}

type ManifestRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; manifest: CodexManifest };

type PathKind = "missing" | "file" | "directory" | "symlink" | "other";

interface HookSpec {
  event: CodexHookEvent;
  command: string;
  group: HookGroup;
}

interface HookGroup {
  hooks: [{ type: "command"; command: string; timeout: number }];
}

type HookRead =
  | {
      kind: "missing";
      source: string;
    }
  | {
      kind: "invalid";
      source: string;
    }
  | {
      kind: "valid";
      source: string;
      document: JsonDocument;
    };

interface HookInspection {
  event: CodexHookEvent;
  status: CodexSetupStatus;
  path: string;
  array?: JsonArrayNode;
  exactIndex?: number;
}

interface NotifyRead {
  status: CodexNotifyStatus;
  argv?: string[];
}

function buildFilePlan(paths: CodexSetupPaths, sourceRootOption?: string): PlannedFile[] {
  const sourceRoot = resolveRequiredPath(
    sourceRootOption ?? DEFAULT_SOURCE_ROOT,
    "Harvest source root",
  );
  return CODEX_COLLECTOR_SOURCE_FILES.map((relativePath) => {
    const sourcePath = join(sourceRoot, relativePath);
    let content: Buffer;
    try {
      content = readFileSync(sourcePath);
    } catch {
      throw new CodexSetupValidationError(`Harvest source file is unavailable: ${sourcePath}`);
    }
    return plannedFile(
      `${HARVEST_CODEX_SUPPORT_DIRECTORY_NAME}/${relativePath}`,
      join(paths.supportDirectory, relativePath),
      content,
    );
  });
}

function plannedFile(relativePath: string, targetPath: string, content: Buffer): PlannedFile {
  return { relativePath, targetPath, content, hash: sha256(content) };
}

function expectedHookGroups(paths: CodexSetupPaths): HookSpec[] {
  return CODEX_HOOK_EVENTS.map((event) => {
    const file = event === "UserPromptSubmit" ? "submit-hook.ts" : "stop-hook.ts";
    const command = `node --experimental-strip-types ${shellQuote(join(paths.supportDirectory, "src", "codex", file))}`;
    return {
      event,
      command,
      group: {
        hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
      },
    };
  });
}

function expectedNotifyArgv(paths: CodexSetupPaths): string[] {
  return [
    "node",
    "--experimental-strip-types",
    join(paths.supportDirectory, "src", "codex", "notify-commit.ts"),
  ];
}

function notifyLine(paths: CodexSetupPaths): string {
  return `notify = ${JSON.stringify(expectedNotifyArgv(paths))}`;
}

function createManifest(plan: PlannedFile[], paths: CodexSetupPaths): CodexManifest {
  const files = plan.map(({ relativePath, hash }) => ({ path: relativePath, sha256: hash }));
  const hooks = expectedHookGroups(paths).map(({ event, command, group }) => ({
    event,
    command,
    sha256: sha256(JSON.stringify(group)),
  }));
  const notifyArgv = expectedNotifyArgv(paths);
  const payload = { format: MANIFEST_FORMAT, files, hooks, notifyArgv };
  return { ...payload, manifestSha256: sha256(JSON.stringify(payload)) };
}

function readManifest(paths: CodexSetupPaths): ManifestRead {
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
  const filesValue = value.files;
  const hooksValue = value.hooks;
  const notifyValue = value.notifyArgv;
  const manifestSha256 = value.manifestSha256;
  if (
    !Array.isArray(filesValue) ||
    !Array.isArray(hooksValue) ||
    !Array.isArray(notifyValue) ||
    !notifyValue.every((item) => typeof item === "string") ||
    typeof manifestSha256 !== "string" ||
    filesValue.length !== CODEX_COLLECTOR_SOURCE_FILES.length ||
    hooksValue.length !== CODEX_HOOK_EVENTS.length
  ) {
    return { kind: "invalid" };
  }

  const files: ManifestEntry[] = [];
  const expectedPaths = CODEX_COLLECTOR_SOURCE_FILES.map(
    (relativePath) => `${HARVEST_CODEX_SUPPORT_DIRECTORY_NAME}/${relativePath}`,
  );
  for (const [index, entry] of filesValue.entries()) {
    if (
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      entry.path !== expectedPaths[index] ||
      !isSha256(entry.sha256)
    ) {
      return { kind: "invalid" };
    }
    files.push({ path: entry.path, sha256: entry.sha256 });
  }

  const hooks: ManifestHookEntry[] = [];
  for (const [index, entry] of hooksValue.entries()) {
    const expectedEvent = CODEX_HOOK_EVENTS[index];
    if (
      !isRecord(entry) ||
      expectedEvent === undefined ||
      entry.event !== expectedEvent ||
      typeof entry.command !== "string" ||
      !isSha256(entry.sha256)
    ) {
      return { kind: "invalid" };
    }
    hooks.push({ event: expectedEvent, command: entry.command, sha256: entry.sha256 });
  }

  const manifest: CodexManifest = {
    format: MANIFEST_FORMAT,
    files,
    hooks,
    notifyArgv: [...notifyValue] as string[],
    manifestSha256,
  };
  const payload = {
    format: manifest.format,
    files: manifest.files,
    hooks: manifest.hooks,
    notifyArgv: manifest.notifyArgv,
  };
  if (manifestSha256 !== sha256(JSON.stringify(payload))) {
    return { kind: "invalid" };
  }
  return { kind: "valid", manifest };
}

function encodeManifest(manifest: CodexManifest): string {
  return `${JSON.stringify(manifest)}\n`;
}

function manifestMatchesPlan(
  manifest: CodexManifest,
  plan: PlannedFile[],
  paths: CodexSetupPaths,
): boolean {
  const expectedHooks = expectedHookGroups(paths);
  return (
    manifest.files.length === plan.length &&
    manifest.files.every(
      (entry, index) =>
        entry.path === plan[index]?.relativePath && entry.sha256 === plan[index]?.hash,
    ) &&
    manifest.hooks.length === expectedHooks.length &&
    manifest.hooks.every((entry, index) => {
      const expected = expectedHooks[index];
      return (
        expected !== undefined &&
        entry.event === expected.event &&
        entry.command === expected.command &&
        entry.sha256 === sha256(JSON.stringify(expected.group))
      );
    }) &&
    arraysEqual(manifest.notifyArgv, expectedNotifyArgv(paths))
  );
}

function manifestHash(manifest: CodexManifest, relativePath: string): string | undefined {
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
      throw new Error(`Harvest Codex setup failed to verify ${file.targetPath}.`);
    }
  }
}

function verifyManifest(paths: CodexSetupPaths, plan: PlannedFile[]): void {
  const manifest = readManifest(paths);
  if (manifest.kind !== "valid" || !manifestMatchesPlan(manifest.manifest, plan, paths)) {
    throw new Error(`Harvest Codex setup failed to verify ${paths.manifestPath}.`);
  }
}

function verifyHookRegistration(hooksPath: string, expected: HookSpec[]): void {
  const hooks = readHooksDocument(hooksPath);
  const statuses = inspectHookGroups(hooks, expected, hooksPath);
  if (statuses.some((item) => item.status !== "installed")) {
    throw new Error(`Harvest Codex setup failed to verify ${hooksPath}.`);
  }
}

function readHooksDocument(hooksPath: string): HookRead {
  const kind = pathKind(hooksPath);
  if (kind === "missing") {
    return { kind: "missing", source: "" };
  }
  if (kind !== "file") {
    return { kind: "invalid", source: "" };
  }
  const source = readFileSync(hooksPath, "utf8");
  try {
    JSON.parse(source);
    const document = parseJsonDocument(source);
    if (document.root.kind !== "object") {
      return { kind: "invalid", source };
    }
    return { kind: "valid", source, document };
  } catch {
    return { kind: "invalid", source };
  }
}

function inspectHookGroups(
  hooks: HookRead,
  expected: HookSpec[],
  hooksPath = "",
): HookInspection[] {
  if (hooks.kind !== "valid" || hooks.document === undefined) {
    return expected.map((spec) => ({
      event: spec.event,
      status: hooks.kind === "missing" ? "missing" : "stale",
      path: hooksPath,
    }));
  }
  const hooksProperty = findProperty(hooks.document.root, "hooks");
  if (hooksProperty === undefined || hooksProperty.value.kind !== "object") {
    return expected.map((spec) => ({
      event: spec.event,
      status: hooksProperty === undefined ? "missing" : "stale",
      path: hooksPath,
    }));
  }
  const hooksObject = hooksProperty.value;
  return expected.map((spec) => inspectHookGroup(hooksObject, spec, hooksPath));
}

function inspectHookGroup(hooksObject: JsonObjectNode, spec: HookSpec, path = ""): HookInspection {
  const eventProperty = findProperty(hooksObject, spec.event);
  if (eventProperty === undefined) {
    return { event: spec.event, status: "missing", path };
  }
  if (eventProperty.value.kind !== "array") {
    return { event: spec.event, status: "stale", path };
  }

  const exactIndices: number[] = [];
  let hasModifiedCommand = false;
  for (const [index, element] of eventProperty.value.elements.entries()) {
    if (!hasCommand(element.value, spec.command)) {
      continue;
    }
    if (deepEqualJson(element.value, spec.group)) {
      exactIndices.push(index);
    } else {
      hasModifiedCommand = true;
    }
  }
  if (hasModifiedCommand || exactIndices.length !== (exactIndices.length === 0 ? 0 : 1)) {
    return {
      event: spec.event,
      status: "stale",
      path,
      array: eventProperty.value,
      exactIndex: exactIndices[0],
    };
  }
  if (exactIndices.length === 1) {
    return {
      event: spec.event,
      status: "installed",
      path,
      array: eventProperty.value,
      exactIndex: exactIndices[0],
    };
  }
  return { event: spec.event, status: "missing", path, array: eventProperty.value };
}

function addMissingHookGroups(
  hooks: HookRead,
  expected: HookSpec[],
  statuses: HookInspection[],
): string {
  const missing = expected.filter((spec) =>
    statuses.some((item) => item.event === spec.event && item.status === "missing"),
  );
  if (missing.length === 0 && hooks.kind !== "missing") {
    return hooks.source;
  }
  if (hooks.kind === "missing") {
    const groups = Object.fromEntries(expected.map((spec) => [spec.event, [spec.group]]));
    return `${JSON.stringify({ hooks: groups })}\n`;
  }
  if (hooks.kind !== "valid" || hooks.document === undefined) {
    throw new CodexSetupConflictError("Harvest Codex hooks.json is not valid JSON.");
  }

  const root = hooks.document.root;
  const hooksProperty = findProperty(root, "hooks");
  const edits: TextEdit[] = [];
  if (hooksProperty === undefined) {
    const groups = Object.fromEntries(missing.map((spec) => [spec.event, [spec.group]]));
    edits.push({
      start: root.closeIndex,
      end: root.closeIndex,
      replacement: objectInsertion(root.properties.length > 0, { hooks: groups }),
    });
    return applyEdits(hooks.source, edits);
  }
  if (hooksProperty.value.kind !== "object") {
    throw new CodexSetupConflictError("Harvest Codex hooks.json has a non-object hooks value.");
  }

  const hooksObject = hooksProperty.value;
  const missingProperties: Record<string, unknown> = {};
  for (const spec of missing) {
    const eventProperty = findProperty(hooksObject, spec.event);
    if (eventProperty === undefined) {
      missingProperties[spec.event] = [spec.group];
      continue;
    }
    if (eventProperty.value.kind !== "array") {
      throw new CodexSetupConflictError(
        `Harvest Codex hooks.json has a non-array ${spec.event} value.`,
      );
    }
    edits.push({
      start: eventProperty.value.closeIndex,
      end: eventProperty.value.closeIndex,
      replacement: `${eventProperty.value.elements.length > 0 ? "," : ""}${JSON.stringify(spec.group)}`,
    });
  }
  if (Object.keys(missingProperties).length > 0) {
    edits.push({
      start: hooksObject.closeIndex,
      end: hooksObject.closeIndex,
      replacement: objectInsertion(hooksObject.properties.length > 0, missingProperties),
    });
  }
  return applyEdits(hooks.source, edits);
}

function removeOwnedHookGroups(
  hooks: Extract<HookRead, { kind: "valid" }>,
  expected: HookSpec[],
  statuses: HookInspection[],
): string {
  const root = hooks.document.root;
  const hooksProperty = findProperty(root, "hooks");
  if (hooksProperty === undefined || hooksProperty.value.kind !== "object") {
    return hooks.source;
  }
  const hooksObject = hooksProperty.value;
  const removable = statuses
    .filter((item) => item.status === "installed" && item.array !== undefined)
    .map((item) => ({
      item,
      spec: expected.find((candidate) => candidate.event === item.event),
    }))
    .filter(
      (value): value is { item: HookInspection & { array: JsonArrayNode }; spec: HookSpec } =>
        value.spec !== undefined && value.item.array !== undefined,
    );
  if (removable.length === 0) {
    return hooks.source;
  }

  const canDropHooksObject =
    hooksObject.properties.length > 0 &&
    hooksObject.properties.every((property) => {
      const candidate = removable.find((value) => value.spec.event === property.key);
      return (
        candidate !== undefined &&
        candidate.item.array.elements.length === 1 &&
        candidate.item.exactIndex === 0
      );
    });
  if (canDropHooksObject) {
    const rootIndex = root.properties.findIndex((property) => property.key === "hooks");
    if (rootIndex >= 0) {
      return applyEdits(hooks.source, [
        removeSiblingSpan(hooks.source, root.properties, rootIndex),
      ]);
    }
  }

  const edits: TextEdit[] = [];
  const propertyIndices: number[] = [];
  for (const { item, spec } of removable) {
    const eventProperty = findProperty(hooksObject, spec.event);
    if (eventProperty === undefined) {
      continue;
    }
    if (item.array.elements.length === 1 && item.exactIndex === 0) {
      const propertyIndex = hooksObject.properties.findIndex(
        (property) => property.key === spec.event,
      );
      if (propertyIndex >= 0) {
        propertyIndices.push(propertyIndex);
      }
    } else if (item.exactIndex !== undefined) {
      edits.push(removeSiblingSpan(hooks.source, item.array.elements, item.exactIndex));
    }
  }
  for (const run of contiguousRuns(propertyIndices)) {
    edits.push(removeSiblingRunSpan(hooks.source, hooksObject.properties, run.start, run.end));
  }
  return applyEdits(hooks.source, edits);
}

function objectInsertion(hasProperties: boolean, values: Record<string, unknown>): string {
  const entries = Object.entries(values).map(
    ([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`,
  );
  return `${hasProperties ? "," : ""}${entries.join(",")}`;
}

interface TextEdit {
  start: number;
  end: number;
  replacement: string;
}

function applyEdits(source: string, edits: TextEdit[]): string {
  const ordered = [...edits].sort((left, right) => right.start - left.start);
  let result = source;
  for (const edit of ordered) {
    result = `${result.slice(0, edit.start)}${edit.replacement}${result.slice(edit.end)}`;
  }
  return result;
}

function removeSiblingSpan(
  source: string,
  siblings: readonly { start: number; end: number }[],
  index: number,
): TextEdit {
  const sibling = siblings[index];
  if (sibling === undefined) {
    throw new Error("Harvest Codex setup attempted to remove an unknown JSON sibling.");
  }
  const next = siblings[index + 1];
  if (next !== undefined) {
    const comma = source.indexOf(",", sibling.end);
    if (comma < 0 || comma >= next.start) {
      throw new Error("Harvest Codex setup could not locate a JSON separator.");
    }
    return { start: sibling.start, end: comma + 1, replacement: "" };
  }
  const previous = siblings[index - 1];
  if (previous !== undefined) {
    const comma = source.lastIndexOf(",", sibling.start);
    if (comma < previous.end || comma >= sibling.start) {
      throw new Error("Harvest Codex setup could not locate a JSON separator.");
    }
    return { start: comma, end: sibling.end, replacement: "" };
  }
  return { start: sibling.start, end: sibling.end, replacement: "" };
}

function removeSiblingRunSpan(
  source: string,
  siblings: readonly { start: number; end: number }[],
  startIndex: number,
  endIndex: number,
): TextEdit {
  const first = siblings[startIndex];
  const last = siblings[endIndex];
  if (first === undefined || last === undefined) {
    throw new Error("Harvest Codex setup attempted to remove an unknown JSON sibling run.");
  }
  const next = siblings[endIndex + 1];
  if (next !== undefined) {
    const comma = source.indexOf(",", last.end);
    if (comma < 0 || comma >= next.start) {
      throw new Error("Harvest Codex setup could not locate a JSON separator.");
    }
    return { start: first.start, end: comma + 1, replacement: "" };
  }
  const previous = siblings[startIndex - 1];
  if (previous !== undefined) {
    const comma = source.lastIndexOf(",", first.start);
    if (comma < previous.end || comma >= first.start) {
      throw new Error("Harvest Codex setup could not locate a JSON separator.");
    }
    return { start: comma, end: last.end, replacement: "" };
  }
  return { start: first.start, end: last.end, replacement: "" };
}

function contiguousRuns(indices: readonly number[]): { start: number; end: number }[] {
  const sorted = [...indices].sort((left, right) => left - right);
  const runs: { start: number; end: number }[] = [];
  for (const index of sorted) {
    const last = runs.at(-1);
    if (last === undefined || index !== last.end + 1) {
      runs.push({ start: index, end: index });
    } else {
      last.end = index;
    }
  }
  return runs;
}

function inspectNotify(configPath: string, expected: string[]): NotifyRead {
  const kind = pathKind(configPath);
  if (kind === "missing") {
    return { status: "missing" };
  }
  if (kind !== "file") {
    return { status: "stale" };
  }
  const source = readFileSync(configPath, "utf8");
  const result = parseTopLevelNotify(source);
  if (result.status === "invalid") {
    return { status: "stale" };
  }
  if (result.status === "missing") {
    return { status: "missing" };
  }
  if (arraysEqual(result.argv, expected)) {
    return { status: "installed", argv: result.argv };
  }
  return result.argv.includes(expected.at(-1) ?? "")
    ? { status: "stale", argv: result.argv }
    : { status: "missing", argv: result.argv };
}

type NotifyParseResult =
  | { status: "missing" }
  | { status: "invalid" }
  | { status: "present"; argv: string[] };

/** Read-only fallback detector for a top-level TOML notify argv array. */
function parseTopLevelNotify(source: string): NotifyParseResult {
  let inTable = false;
  let found: string[] | undefined;
  let offset = 0;
  for (const lineWithEnding of source.match(/[^\n]*(?:\n|$)/g) ?? []) {
    const line = lineWithEnding.endsWith("\n") ? lineWithEnding.slice(0, -1) : lineWithEnding;
    const visible = stripTomlComment(line).trim();
    if (visible.startsWith("[")) {
      inTable = true;
      offset += lineWithEnding.length;
      continue;
    }
    if (!inTable) {
      const match = /^notify\s*=/.exec(visible);
      if (match !== null) {
        const equals = line.indexOf("=");
        const expressionStart = offset + equals + 1;
        const arrayStart = skipTomlWhitespace(source, expressionStart);
        const arrayEnd = findTomlArrayEnd(source, arrayStart);
        if (arrayEnd === undefined || source[arrayStart] !== "[") {
          return { status: "invalid" };
        }
        const argv = parseTomlStringArray(source.slice(arrayStart, arrayEnd));
        if (argv === undefined || found !== undefined) {
          return { status: "invalid" };
        }
        found = argv;
      }
    }
    offset += lineWithEnding.length;
  }
  return found === undefined ? { status: "missing" } : { status: "present", argv: found };
}

function stripTomlComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (quote === '"') {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          quote = null;
        }
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"') {
      quote = '"';
    } else if (character === "'") {
      quote = "'";
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function skipTomlWhitespace(source: string, start: number): number {
  let index = start;
  while (index < source.length && /\s/.test(source[index] ?? "")) {
    index += 1;
  }
  return index;
}

function findTomlArrayEnd(source: string, start: number): number | undefined {
  if (source[start] !== "[") {
    return undefined;
  }
  let depth = 0;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (quote === '"') {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          quote = null;
        }
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === "#") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return index + 1;
      }
    }
  }
  return undefined;
}

function parseTomlStringArray(source: string): string[] | undefined {
  if (source[0] !== "[" || source.at(-1) !== "]") {
    return undefined;
  }
  if (source.trim() === "[]") {
    return [];
  }
  const values: string[] = [];
  let index = 1;
  while (index < source.length - 1) {
    index = skipTomlWhitespace(source, index);
    while (source[index] === "#") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd < 0 ? source.length - 1 : lineEnd + 1;
      index = skipTomlWhitespace(source, index);
    }
    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source[index] === "]") {
      return values;
    }
    if (source[index] !== '"' && source[index] !== "'") {
      return undefined;
    }
    const start = index;
    const quote = source[index];
    index += 1;
    let escaped = false;
    let closed = false;
    while (index < source.length) {
      const character = source[index];
      if (quote === "'" && character === "'") {
        index += 1;
        closed = true;
        break;
      }
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && character === "\\") {
        escaped = true;
      } else if (quote === '"' && character === '"') {
        index += 1;
        closed = true;
        break;
      }
      index += 1;
    }
    if (!closed) {
      return undefined;
    }
    try {
      const value: unknown =
        quote === "'" ? source.slice(start + 1, index - 1) : JSON.parse(source.slice(start, index));
      if (typeof value !== "string") {
        return undefined;
      }
      values.push(value);
    } catch {
      return undefined;
    }
    index = skipTomlWhitespace(source, index);
    if (source[index] === "]") {
      return values;
    }
    if (source[index] !== ",") {
      return undefined;
    }
  }
  return undefined;
}

interface JsonDocument {
  source: string;
  root: JsonObjectNode;
}

interface JsonBaseNode {
  start: number;
  end: number;
  value: unknown;
}

interface JsonValueNode extends JsonBaseNode {
  kind: "value";
}

interface JsonArrayNode extends JsonBaseNode {
  kind: "array";
  openIndex: number;
  closeIndex: number;
  elements: JsonNode[];
}

interface JsonProperty {
  key: string;
  start: number;
  end: number;
  value: JsonNode;
}

interface JsonObjectNode extends JsonBaseNode {
  kind: "object";
  openIndex: number;
  closeIndex: number;
  properties: JsonProperty[];
}

type JsonNode = JsonValueNode | JsonArrayNode | JsonObjectNode;

class JsonSourceParser {
  private index = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): JsonDocument {
    this.skipWhitespace();
    const root = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.source.length || root.kind !== "object") {
      throw new Error("JSON root must be an object with no trailing content.");
    }
    return { source: this.source, root };
  }

  private parseValue(): JsonNode {
    this.skipWhitespace();
    const start = this.index;
    const character = this.source[this.index];
    if (character === "{") {
      return this.parseObject(start);
    }
    if (character === "[") {
      return this.parseArray(start);
    }
    if (character === '"') {
      return { kind: "value", start, end: this.parseString(), value: this.lastStringValue };
    }
    return this.parseLiteral(start);
  }

  private lastStringValue = "";

  private parseString(): number {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const character = this.source[this.index];
      if (character === "\\") {
        this.index += 2;
        continue;
      }
      if (character === '"') {
        this.index += 1;
        const value: unknown = JSON.parse(this.source.slice(start, this.index));
        if (typeof value !== "string") {
          throw new Error("JSON string value is invalid.");
        }
        this.lastStringValue = value;
        return this.index;
      }
      if ((character?.codePointAt(0) ?? 0) < 0x20) {
        throw new Error("JSON string contains a control character.");
      }
      this.index += 1;
    }
    throw new Error("JSON string is unterminated.");
  }

  private parseObject(start: number): JsonObjectNode {
    const openIndex = this.index;
    this.index += 1;
    const properties: JsonProperty[] = [];
    const values: Record<string, unknown> = {};
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      const closeIndex = this.index;
      this.index += 1;
      return {
        kind: "object",
        start,
        end: this.index,
        value: values,
        openIndex,
        closeIndex,
        properties,
      };
    }
    while (true) {
      this.skipWhitespace();
      const keyStart = this.index;
      if (this.source[this.index] !== '"') {
        throw new Error("JSON object key is invalid.");
      }
      this.parseString();
      const key = this.lastStringValue;
      if (properties.some((property) => property.key === key)) {
        throw new Error("Duplicate JSON object key.");
      }
      this.skipWhitespace();
      if (this.source[this.index] !== ":") {
        throw new Error("JSON object separator is missing.");
      }
      this.index += 1;
      const value = this.parseValue();
      properties.push({ key, start: keyStart, end: value.end, value });
      values[key] = value.value;
      this.skipWhitespace();
      if (this.source[this.index] === "}") {
        const closeIndex = this.index;
        this.index += 1;
        return {
          kind: "object",
          start,
          end: this.index,
          value: values,
          openIndex,
          closeIndex,
          properties,
        };
      }
      if (this.source[this.index] !== ",") {
        throw new Error("JSON object member separator is missing.");
      }
      this.index += 1;
    }
  }

  private parseArray(start: number): JsonArrayNode {
    const openIndex = this.index;
    this.index += 1;
    const elements: JsonNode[] = [];
    const values: unknown[] = [];
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      const closeIndex = this.index;
      this.index += 1;
      return {
        kind: "array",
        start,
        end: this.index,
        value: values,
        openIndex,
        closeIndex,
        elements,
      };
    }
    while (true) {
      const value = this.parseValue();
      elements.push(value);
      values.push(value.value);
      this.skipWhitespace();
      if (this.source[this.index] === "]") {
        const closeIndex = this.index;
        this.index += 1;
        return {
          kind: "array",
          start,
          end: this.index,
          value: values,
          openIndex,
          closeIndex,
          elements,
        };
      }
      if (this.source[this.index] !== ",") {
        throw new Error("JSON array member separator is missing.");
      }
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseLiteral(start: number): JsonValueNode {
    while (this.index < this.source.length && !/[\s,\]}]/.test(this.source[this.index] ?? "")) {
      this.index += 1;
    }
    const token = this.source.slice(start, this.index);
    let value: unknown;
    try {
      value = JSON.parse(token);
    } catch {
      throw new Error("JSON literal is invalid.");
    }
    return { kind: "value", start, end: this.index, value };
  }

  private skipWhitespace(): void {
    while (this.index < this.source.length && /\s/.test(this.source[this.index] ?? "")) {
      this.index += 1;
    }
  }
}

function parseJsonDocument(source: string): JsonDocument {
  return new JsonSourceParser(source).parse();
}

function findProperty(object: JsonObjectNode, key: string): JsonProperty | undefined {
  return object.properties.find((property) => property.key === key);
}

function hasCommand(value: unknown, command: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasCommand(item, command));
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, entry]) =>
    key === "command" && entry === command ? true : hasCommand(entry, command),
  );
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => deepEqualJson(value, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && deepEqualJson(left[key], right[key]))
    );
  }
  return false;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
      throw new CodexSetupConflictError(`Harvest Codex setup path is not a directory: ${current}`, [
        current,
      ]);
    }
    break;
  }
  for (const path of missing.reverse()) {
    mkdirSync(path, { mode: 0o700 });
  }
}

function writeOwnedFile(targetPath: string, content: Buffer, expectedHash: string): void {
  const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, content, { flag: "wx", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, targetPath);
    if (sha256(readFileSync(targetPath)) !== expectedHash) {
      throw new Error(`Harvest Codex setup failed to verify ${targetPath}.`);
    }
  } finally {
    if (pathKind(temporaryPath) === "file") {
      unlinkSync(temporaryPath);
    }
  }
}

function assertSafeHome(homeDirectory: string): void {
  if (pathKind(homeDirectory) !== "directory") {
    throw new CodexSetupValidationError(
      `Target home directory is not an existing directory: ${homeDirectory}`,
    );
  }
}

function assertSafeAncestors(paths: CodexSetupPaths): void {
  const unsafePath = findUnsafeAncestor(paths);
  if (unsafePath !== undefined) {
    throw new CodexSetupConflictError(
      `Harvest Codex setup path is not a safe directory: ${unsafePath}`,
      [unsafePath],
    );
  }
}

function findUnsafeAncestor(paths: CodexSetupPaths): string | undefined {
  const homeKind = pathKind(paths.homeDirectory);
  if (homeKind !== "missing" && homeKind !== "directory") {
    return paths.homeDirectory;
  }
  for (const targetPath of [
    paths.hooksPath,
    paths.configPath,
    ...CODEX_COLLECTOR_SOURCE_FILES.map((relativePath) =>
      join(paths.supportDirectory, relativePath),
    ),
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
    throw new CodexSetupValidationError(`${label} must be a non-empty path.`);
  }
  return resolve(value);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
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
