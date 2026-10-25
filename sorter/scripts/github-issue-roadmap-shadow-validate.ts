import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  SHADOW_PUBLISH_MANIFEST_SCHEMA_VERSION,
  deriveShadowPublication,
  type PublicationArtifact,
  type PublicationInventoryEntry,
  type PublicationJournalRecord,
  type PublicationTransition,
  type ShadowPublicationResult,
} from "./lib/github-issue-roadmap/shadow-publication-core";
import { canonicalJsonSha256, prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import {
  INTAKE_ATTEMPT_SCHEMA,
  readIntakeJournalRecord,
} from "./lib/github-issue-roadmap/intake-observation";

const INVENTORY_SCHEMA = "github-issue-roadmap-shadow-initial-inventory/v1" as const;
const SPOOL_ENTRY_SCHEMA = "github-issue-roadmap-shadow-spool-entry/v1" as const;
const NON_PROMOTION_RECEIPT_SCHEMA = "github-issue-roadmap-shadow-non-promotion-receipt/v1" as const;
const SPOOL_DIRECTORY = "roadmap-shadow-spool";
const ARTIFACT_DIRECTORY = "artifacts/github-issue-roadmap";
const SHA256 = /^[0-9a-f]{64}$/;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ADMINISTRATORS_SID = "S-1-5-32-544";
const WINDOWS_FULL_CONTROL = 0x1f01ff;

export interface WindowsPrivateDirectoryAclProof {
  readonly daclProtected: boolean;
  readonly ownerSid: string;
  readonly currentSid: string;
  readonly rules: readonly {
    readonly sid: string;
    readonly accessControlType: string;
    readonly rights: number;
    readonly inheritanceFlags: string;
    readonly propagationFlags: string;
  }[];
}

export interface WindowsPrivateDirectoryAclController {
  readonly secure: (path: string) => void;
  readonly inspect: (path: string) => WindowsPrivateDirectoryAclProof;
}

export interface ShadowPrivateDirectoryPolicy {
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: WindowsPrivateDirectoryAclController;
}

interface InitialInventoryFile {
  readonly schemaVersion: typeof INVENTORY_SCHEMA;
  readonly entries: readonly PublicationInventoryEntry[];
}

interface SpoolMarker {
  readonly schemaVersion: typeof SPOOL_ENTRY_SCHEMA;
  readonly bundleSha256: string;
  readonly publishManifestPath: string;
  readonly publishManifestSha256: string;
  readonly files: readonly PublicationInventoryEntry[];
}

export type ShadowPromotionCrashStage = "before_write" | "during_write" | "before_rename" | "after_rename";

export interface ShadowSpoolEntryReceipt {
  readonly entryPath: string;
  readonly bundleSha256: string;
  readonly publishManifestPath: string;
  readonly publishManifestSha256: string;
}

export interface ShadowSpoolDiscovery {
  readonly completed: readonly ShadowSpoolEntryReceipt[];
  readonly interrupted: readonly string[];
  readonly safeToInitializeFallback: boolean;
}

function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function relativeLocator(root: string, path: string): string {
  const locator = relative(root, path).replaceAll("\\", "/");
  if (locator === "" || locator.startsWith("../") || isAbsolute(locator)) throw new Error("Artifact path escaped the repository root.");
  return locator;
}

function windowsPrivateDirectoryDaclProtectedViolation(path: string): string {
  return `${path} has daclProtected=false: its DACL is inherited rather than protected.`;
}

function windowsPrivateDirectoryDaclProtectedViolationWithRemedy(path: string): string {
  return `${path} has daclProtected=false: its DACL is inherited rather than protected; createWindowsPrivateDirectoryAclController(process.env).secure(path) establishes it.`;
}

function collectWindowsPrivateDirectoryAclViolations(
  path: string,
  proof: WindowsPrivateDirectoryAclProof,
): string[] {
  const violations: string[] = [];
  const allowed = new Set([proof.currentSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]);
  const fullControlSids = new Set<string>();
  if (!proof.daclProtected) {
    violations.push(windowsPrivateDirectoryDaclProtectedViolation(path));
  }
  if (proof.ownerSid !== proof.currentSid) {
    violations.push(`${path} owner SID ${proof.ownerSid} does not match current SID ${proof.currentSid}.`);
  }
  if (proof.rules.length === 0) violations.push(`${path} has no Windows ACL rules.`);
  for (const rule of proof.rules) {
    const inheritance = new Set(rule.inheritanceFlags.split(",").map((value) => value.trim()));
    if (rule.accessControlType !== "Allow") {
      violations.push(`${path} ACL rule for SID ${rule.sid} has access-control type ${rule.accessControlType}; expected Allow.`);
    }
    if (!allowed.has(rule.sid)) {
      violations.push(`${path} ACL rule names disallowed SID ${rule.sid}.`);
    }
    if ((rule.rights & WINDOWS_FULL_CONTROL) !== WINDOWS_FULL_CONTROL) {
      violations.push(`${path} ACL rule for SID ${rule.sid} lacks FullControl.`);
    }
    const missingInheritanceFlags = ["ContainerInherit", "ObjectInherit"].filter((flag) => !inheritance.has(flag));
    if (missingInheritanceFlags.length > 0) {
      violations.push(`${path} ACL rule for SID ${rule.sid} lacks required inheritance flag(s): ${missingInheritanceFlags.join(", ")}.`);
    }
    if (rule.propagationFlags !== "None") {
      violations.push(`${path} ACL rule for SID ${rule.sid} has propagation flags ${rule.propagationFlags}; expected None.`);
    }
    if (rule.accessControlType === "Allow" && allowed.has(rule.sid) &&
        (rule.rights & WINDOWS_FULL_CONTROL) === WINDOWS_FULL_CONTROL && missingInheritanceFlags.length === 0 &&
        rule.propagationFlags === "None") {
      fullControlSids.add(rule.sid);
    }
  }
  const missingSids = [proof.currentSid, WINDOWS_SYSTEM_SID, WINDOWS_ADMINISTRATORS_SID]
    .filter((sid) => !fullControlSids.has(sid));
  if (missingSids.length > 0) violations.push(`${path} is missing required full-control SID(s): ${missingSids.join(", ")}.`);
  return violations;
}

function assertWindowsPrivateDirectoryAcl(path: string, proof: WindowsPrivateDirectoryAclProof): void {
  const violations = collectWindowsPrivateDirectoryAclViolations(path, proof);
  const firstViolation = violations[0];
  if (firstViolation === undefined) return;
  if (violations.length === 1) {
    throw new Error(firstViolation === windowsPrivateDirectoryDaclProtectedViolation(path)
      ? windowsPrivateDirectoryDaclProtectedViolationWithRemedy(path)
      : firstViolation);
  }
  throw new Error([
    `${path} has ${violations.length} Windows private-directory ACL violations.`,
    ...violations.map((violation) => `- ${violation}`),
  ].join("\n"));
}

export function assertShadowPrivateDirectory(
  path: string,
  create = false,
  policy: ShadowPrivateDirectoryPolicy = {},
): void {
  const platform = policy.platform ?? process.platform;
  const windowsAcl = platform === "win32" ? policy.windowsAcl : undefined;
  if (platform === "win32" && windowsAcl === undefined) {
    throw new Error("Windows private-directory validation requires an injected ACL controller.");
  }
  const created = create && !existsSync(path);
  if (created) {
    if (windowsAcl !== undefined) windowsAcl.secure(path);
    else mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const before = lstatSync(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error(`${path} must be a non-link private directory.`);
  if (windowsAcl !== undefined) {
    let proof = windowsAcl.inspect(path);
    const violations = collectWindowsPrivateDirectoryAclViolations(path, proof);
    if (create && !created && violations.length === 1 &&
        violations[0] === windowsPrivateDirectoryDaclProtectedViolation(path)) {
      windowsAcl.secure(path);
      proof = windowsAcl.inspect(path);
    }
    assertWindowsPrivateDirectoryAcl(path, proof);
  } else {
    if ((before.mode & 0o077) !== 0) throw new Error(`${path} is not owner-only.`);
    if (created) chmodSync(path, 0o700);
  }
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory() || after.isSymbolicLink()) {
    throw new Error(`${path} changed identity during private-directory validation.`);
  }
  if (windowsAcl !== undefined) assertWindowsPrivateDirectoryAcl(path, windowsAcl.inspect(path));
  else if ((after.mode & 0o077) !== 0) throw new Error(`${path} is not owner-only.`);
}

function sameFileIdentity(
  left: { readonly dev: number; readonly ino: number; readonly size: number; readonly birthtimeMs: number },
  right: { readonly dev: number; readonly ino: number; readonly size: number; readonly birthtimeMs: number },
): boolean {
  return process.platform === "win32"
    ? left.size === right.size && left.ino === right.ino
    : left.dev === right.dev && left.ino === right.ino;
}

function readRegularNoFollow(path: string): Buffer {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${path} must be a non-link regular file.`);
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(opened, before)) throw new Error(`${path} changed identity before read.`);
    const bytes = readFileSync(descriptor);
    const after = lstatSync(path);
    if (!sameFileIdentity(after, opened) || after.size !== bytes.byteLength || after.isSymbolicLink()) {
      throw new Error(`${path} changed identity during read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function modeOf(path: string): string {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${path} is not a publishable regular file.`);
  return process.platform === "win32" || (stat.mode & 0o111) === 0 ? "100644" : "100755";
}

function walkArtifacts(repoRoot: string): PublicationArtifact[] {
  const root = resolve(repoRoot, ARTIFACT_DIRECTORY);
  if (!existsSync(root)) return [];
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Roadmap artifact root must be a non-link directory.");
  const result: PublicationArtifact[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const name of readdirSync(directory).sort(lexical)) {
      const path = join(directory, name);
      const before = lstatSync(path);
      if (before.isSymbolicLink()) throw new Error(`${relativeLocator(repoRoot, path)} is a link or reparse point.`);
      if (before.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!before.isFile()) throw new Error(`${relativeLocator(repoRoot, path)} is not a regular artifact.`);
      const bytes = readRegularNoFollow(path);
      const after = lstatSync(path);
      result.push({
        path: relativeLocator(repoRoot, path),
        bytes,
        mode: modeOf(path),
        objectType: "blob",
        linkOrReparsePoint: false,
        identityStable: before.dev === after.dev && before.ino === after.ino && before.size === after.size,
      });
    }
  }
  return result.sort((left, right) => lexical(left.path, right.path));
}

function inventoryOf(artifacts: readonly PublicationArtifact[]): PublicationInventoryEntry[] {
  return artifacts.map((artifact) => {
    if (artifact.mode !== "100644" || artifact.objectType !== "blob" ||
        artifact.linkOrReparsePoint || !artifact.identityStable) {
      throw new Error(`Initial inventory artifact ${artifact.path} is not a stable non-executable blob.`);
    }
    return {
      path: artifact.path,
      contentSha256: sha256Bytes(artifact.bytes),
      mode: "100644" as const,
      objectType: "blob" as const,
    };
  }).sort((left, right) => lexical(left.path, right.path));
}

function writeOnceFile(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
    (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) offset += writeSync(descriptor, bytes, offset, bytes.byteLength - offset);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!new Set(["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EACCES"]).has(code ?? "")) throw error;
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function spoolRoot(stateRoot: string): string {
  return join(resolve(stateRoot), SPOOL_DIRECTORY);
}

function completedEntryPath(stateRoot: string, bundleSha256: string): string {
  if (!SHA256.test(bundleSha256)) throw new Error("Spool bundle identity must be a lowercase SHA-256.");
  return join(spoolRoot(stateRoot), bundleSha256);
}

function markerFor(publication: ShadowPublicationResult): SpoolMarker {
  return {
    schemaVersion: SPOOL_ENTRY_SCHEMA,
    bundleSha256: publication.bundleSha256,
    publishManifestPath: publication.publishManifestPath,
    publishManifestSha256: publication.publishManifest.manifestSha256,
    files: publication.files.map((file) => ({
      path: file.path,
      contentSha256: sha256Bytes(file.bytes),
      mode: "100644" as const,
      objectType: "blob" as const,
    })).sort((left, right) => lexical(left.path, right.path)),
  };
}

function markerBytes(marker: SpoolMarker): Buffer {
  return Buffer.from(prettyCanonicalJson(marker));
}

function safeEntryFile(entryPath: string, locator: string): string {
  if (locator !== locator.normalize("NFC") || locator.includes("\\") || /^[A-Za-z]:/.test(locator) ||
      locator.split("/").some((segment) => segment === "" || segment === "." || segment === ".." ||
        segment.includes(":") || /^\.git/i.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) {
    throw new Error("Spool marker contains an unsafe locator.");
  }
  const path = resolve(entryPath, locator);
  const fromEntry = relative(entryPath, path);
  if (fromEntry === "" || fromEntry.startsWith("..") || isAbsolute(fromEntry)) throw new Error("Spool marker locator escaped its entry.");
  return path;
}

export function reopenShadowSpoolEntry(
  entryPathValue: string,
  privateDirectoryPolicy: ShadowPrivateDirectoryPolicy = {},
): ShadowSpoolEntryReceipt {
  const entryPath = resolve(entryPathValue);
  assertShadowPrivateDirectory(entryPath, false, privateDirectoryPolicy);
  const markerPath = join(entryPath, ".bundle.json");
  const marker = JSON.parse(readRegularNoFollow(markerPath).toString("utf8")) as SpoolMarker;
  if (marker.schemaVersion !== SPOOL_ENTRY_SCHEMA || !SHA256.test(marker.bundleSha256) || !SHA256.test(marker.publishManifestSha256) ||
      !Array.isArray(marker.files) || Object.keys(marker).sort().join(",") !==
      ["bundleSha256", "files", "publishManifestPath", "publishManifestSha256", "schemaVersion"].sort().join(",")) {
    throw new Error("Spool entry marker is invalid or has an unknown schema.");
  }
  const seen = new Set<string>();
  for (const file of marker.files) {
    if (seen.has(file.path) || file.mode !== "100644" || file.objectType !== "blob" || !SHA256.test(file.contentSha256)) {
      throw new Error("Spool entry file inventory is invalid.");
    }
    seen.add(file.path);
    const path = safeEntryFile(entryPath, file.path);
    if (modeOf(path) !== "100644" || sha256Bytes(readRegularNoFollow(path)) !== file.contentSha256) {
      throw new Error(`Spool entry file ${file.path} changed hash or mode.`);
    }
  }
  const publishBytes = readRegularNoFollow(safeEntryFile(entryPath, marker.publishManifestPath));
  const publish = JSON.parse(publishBytes.toString("utf8")) as Record<string, unknown>;
  const publishKeys = [
    "schemaVersion", "validatorVersion", "originIdentity", "trustedMainSha", "runId", "collectionStatus",
    "collectionManifestPath", "collectionManifestSha256", "transition", "blobs", "expectedOutputTreeSha256",
    "manifestSha256",
  ].sort();
  if (Object.keys(publish).sort().join(",") !== publishKeys.join(",") ||
      publish.schemaVersion !== SHADOW_PUBLISH_MANIFEST_SCHEMA_VERSION || !Array.isArray(publish.blobs)) {
    throw new Error("Spool publish manifest has an unknown or noncanonical schema.");
  }
  const manifestSha256 = publish.manifestSha256;
  if (typeof manifestSha256 !== "string" || manifestSha256 !== marker.publishManifestSha256) {
    throw new Error("Spool publish manifest identity drifted.");
  }
  const withoutManifestHash = { ...publish };
  delete withoutManifestHash.manifestSha256;
  if (canonicalJsonSha256(withoutManifestHash) !== manifestSha256 ||
      canonicalJsonSha256(publish.blobs) !== publish.expectedOutputTreeSha256) {
    throw new Error("Spool publish manifest canonical hash or output-tree hash drifted.");
  }
  const publishInventory: PublicationInventoryEntry = {
    path: marker.publishManifestPath,
    contentSha256: sha256Bytes(publishBytes),
    mode: "100644",
    objectType: "blob",
  };
  const expectedFiles = [...publish.blobs as PublicationInventoryEntry[], publishInventory]
    .sort((left, right) => lexical(left.path, right.path));
  if (canonicalJsonSha256(marker.files) !== canonicalJsonSha256(expectedFiles)) {
    throw new Error("Spool entry inventory disagrees with the publish manifest exact blobs.");
  }
  const expectedBundleSha256 = canonicalJsonSha256({
    publishManifestSha256: manifestSha256,
    publishManifestBlobSha256: publishInventory.contentSha256,
    files: expectedFiles,
  });
  if (marker.bundleSha256 !== expectedBundleSha256 || basename(entryPath) !== expectedBundleSha256) {
    throw new Error("Spool bundle hash or write-once directory identity drifted.");
  }
  return {
    entryPath,
    bundleSha256: marker.bundleSha256,
    publishManifestPath: marker.publishManifestPath,
    publishManifestSha256: marker.publishManifestSha256,
  };
}

export function discoverShadowSpool(
  stateRootValue: string,
  privateDirectoryPolicy: ShadowPrivateDirectoryPolicy = {},
): ShadowSpoolDiscovery {
  const stateRoot = resolve(stateRootValue);
  if (!existsSync(stateRoot)) return { completed: [], interrupted: [], safeToInitializeFallback: true };
  assertShadowPrivateDirectory(stateRoot, false, privateDirectoryPolicy);
  const root = spoolRoot(stateRoot);
  if (!existsSync(root)) return { completed: [], interrupted: [], safeToInitializeFallback: true };
  assertShadowPrivateDirectory(root, false, privateDirectoryPolicy);
  const completed: ShadowSpoolEntryReceipt[] = [];
  const interrupted: string[] = [];
  for (const name of readdirSync(root).sort(lexical)) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Spool child ${name} must be a non-link directory.`);
    if (name.startsWith(".tmp-")) {
      interrupted.push(path);
      continue;
    }
    if (!SHA256.test(name)) throw new Error(`Spool child ${name} has a noncanonical identity.`);
    const receipt = reopenShadowSpoolEntry(path, privateDirectoryPolicy);
    if (receipt.bundleSha256 !== name) throw new Error(`Spool entry ${name} disagrees with its directory identity.`);
    completed.push(receipt);
  }
  return { completed, interrupted, safeToInitializeFallback: interrupted.length === 0 };
}

export function promoteShadowPublication(input: {
  readonly stateRoot: string;
  readonly publication: ShadowPublicationResult;
  readonly crashAt?: ShadowPromotionCrashStage;
  readonly privateDirectoryPolicy?: ShadowPrivateDirectoryPolicy;
}): ShadowSpoolEntryReceipt {
  const stateRoot = resolve(input.stateRoot);
  assertShadowPrivateDirectory(stateRoot, true, input.privateDirectoryPolicy);
  const root = spoolRoot(stateRoot);
  assertShadowPrivateDirectory(root, true, input.privateDirectoryPolicy);
  const completedPath = completedEntryPath(stateRoot, input.publication.bundleSha256);
  if (existsSync(completedPath)) {
    const receipt = reopenShadowSpoolEntry(completedPath, input.privateDirectoryPolicy);
    if (receipt.publishManifestSha256 !== input.publication.publishManifest.manifestSha256) {
      throw new Error("Existing write-once spool entry has a different publish manifest identity.");
    }
    return receipt;
  }

  const temporaryPath = join(root, `.tmp-${input.publication.bundleSha256}-${randomUUID()}`);
  assertShadowPrivateDirectory(temporaryPath, true, input.privateDirectoryPolicy);
  const crash = (stage: ShadowPromotionCrashStage): void => {
    if (input.crashAt === stage) throw new Error(`Simulated crash at ${stage}.`);
  };
  crash("before_write");
  const marker = markerFor(input.publication);
  let wrote = 0;
  for (const file of input.publication.files) {
    writeOnceFile(safeEntryFile(temporaryPath, file.path), file.bytes);
    wrote += 1;
    if (wrote === 1) crash("during_write");
  }
  writeOnceFile(join(temporaryPath, ".bundle.json"), markerBytes(marker));
  fsyncDirectory(temporaryPath);
  crash("before_rename");
  renameSync(temporaryPath, completedPath);
  fsyncDirectory(root);
  crash("after_rename");
  const receipt = reopenShadowSpoolEntry(completedPath, input.privateDirectoryPolicy);
  if (receipt.bundleSha256 !== input.publication.bundleSha256 ||
      receipt.publishManifestSha256 !== input.publication.publishManifest.manifestSha256) {
    throw new Error("Promoted spool entry failed immediate current-process validation.");
  }
  return receipt;
}

function parseArgs(argv: readonly string[]): { command: string; values: ReadonlyMap<string, string> } {
  const [command = "validate", ...rest] = argv;
  const values = new Map<string, string>();
  for (const argument of rest) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (match === null || values.has(match[1])) throw new Error(`Unsupported or duplicate argument: ${argument}`);
    values.set(match[1], match[2]);
  }
  const supported = new Set(command === "inventory"
    ? ["repo-root", "prepared-state"]
    : ["repo-root", "prepared-state", "origin", "trusted-main-sha", "transition", "lease", "collection-manifest"]);
  for (const name of values.keys()) if (!supported.has(name)) throw new Error(`Unsupported --${name} argument.`);
  return { command, values };
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined) throw new Error(`Missing required --${name}=VALUE argument.`);
  return value;
}

function readInitialInventory(path: string): PublicationInventoryEntry[] {
  const value = JSON.parse(readRegularNoFollow(resolve(path)).toString("utf8")) as InitialInventoryFile;
  if (value.schemaVersion !== INVENTORY_SCHEMA || !Array.isArray(value.entries)) throw new Error("Initial inventory schema is invalid.");
  return [...value.entries];
}

interface PreparedBatchStateRoot {
  readonly runId: string;
  readonly trustedMainSha: string;
  readonly stateRoot: string;
}

function readPreparedBatchStateRoot(path: string): PreparedBatchStateRoot {
  const value = JSON.parse(readRegularNoFollow(resolve(path)).toString("utf8")) as {
    readonly schemaVersion?: unknown;
    readonly phase?: unknown;
    readonly runId?: unknown;
    readonly trustedMainSha?: unknown;
    readonly durableStateRoots?: {
      readonly stateRoot?: unknown;
      readonly spoolRoot?: unknown;
      readonly operatorJournalRoot?: unknown;
    };
  };
  const roots = value.durableStateRoots;
  if (value.schemaVersion !== "github-issue-roadmap-shadow-batch/v1" || value.phase !== "prepared" ||
      typeof value.runId !== "string" || !/^(?=.{1,128}$)(?=.*[^.])[A-Za-z0-9._-]+$/.test(value.runId) ||
      typeof value.trustedMainSha !== "string" || !/^[0-9a-f]{40}$/.test(value.trustedMainSha) || roots === undefined ||
      typeof roots.stateRoot !== "string" || !isAbsolute(roots.stateRoot) ||
      typeof roots.spoolRoot !== "string" || resolve(roots.spoolRoot) !== join(resolve(roots.stateRoot), SPOOL_DIRECTORY) ||
      typeof roots.operatorJournalRoot !== "string" ||
      resolve(roots.operatorJournalRoot) !== join(resolve(roots.stateRoot), "roadmap-shadow-operator-journal") ||
      !/^\.example-repo-roadmap-shadow-[0-9a-f]{16}$/.test(basename(roots.stateRoot))) {
    throw new Error("Prepared batch does not contain the exact U1 durable state roots for this publication run.");
  }
  return { runId: value.runId, trustedMainSha: value.trustedMainSha, stateRoot: resolve(roots.stateRoot) };
}

function gitCommonDirectory(repoRoot: string): string {
  const dotGit = resolve(repoRoot, ".git");
  const stat = lstatSync(dotGit);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return dotGit;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Trusted checkout .git metadata must be a non-link file or directory.");
  const match = /^gitdir:\s*(.+)\s*$/i.exec(readRegularNoFollow(dotGit).toString("utf8"));
  if (match === null) throw new Error("Trusted checkout .git file is malformed.");
  const worktreeGitDir = resolve(repoRoot, match[1]);
  const commonDirFile = join(worktreeGitDir, "commondir");
  return existsSync(commonDirFile)
    ? resolve(worktreeGitDir, readRegularNoFollow(commonDirFile).toString("utf8").trim())
    : worktreeGitDir;
}

function expectedStateRoot(repoRoot: string): string {
  const commonDir = gitCommonDirectory(repoRoot);
  const identity = createHash("sha256")
    .update(process.platform === "win32" ? commonDir.toLowerCase() : commonDir, "utf8")
    .digest("hex")
    .slice(0, 16);
  return join(dirname(dirname(commonDir)), `.example-repo-roadmap-shadow-${identity}`);
}

function stateRootFromPreparedBatch(path: string, publication: ShadowPublicationResult): PreparedBatchStateRoot {
  const prepared = readPreparedBatchStateRoot(path);
  if (prepared.runId !== publication.publishManifest.runId ||
      prepared.trustedMainSha !== publication.publishManifest.trustedMainSha) {
    throw new Error("Prepared batch state roots are bound to a different run or trusted main SHA.");
  }
  return prepared;
}

function initialInventoryPath(prepared: PreparedBatchStateRoot): string {
  return join(prepared.stateRoot, "roadmap-shadow-initial-inventories", `${prepared.runId}.json`);
}

/** Check the original baseline before any resumed collector work can consume it. */
export function assertShadowResumeBaseline(repoRoot: string, preparedPath: string): boolean {
  const prepared = readPreparedBatchStateRoot(preparedPath);
  if (prepared.stateRoot !== expectedStateRoot(repoRoot)) {
    throw new Error("Prepared batch state root does not match the trusted checkout Git common directory.");
  }
  const path = initialInventoryPath(prepared);
  if (!existsSync(path)) return false;
  const current = new Map(inventoryOf(walkArtifacts(repoRoot)).map((entry) => [entry.path, entry]));
  const initial = readInitialInventory(path);
  const seen = new Set<string>();
  for (const prior of initial) {
    const present = current.get(prior.path);
    if (seen.has(prior.path) || present === undefined || prior.mode !== "100644" || prior.objectType !== "blob" ||
        present.contentSha256 !== prior.contentSha256) {
      throw new Error(`Trusted initial inventory path ${prior.path} was deleted, modified, or duplicated.`);
    }
    seen.add(prior.path);
  }
  if (!seen.has(relative(repoRoot, preparedPath).replaceAll("\\", "/"))) {
    throw new Error("Trusted initial inventory does not bind this prepared batch.");
  }
  return true;
}

export const SHADOW_ENTRY_SCRATCH_FILES = [
  "candidate-envelope.json",
  "assessment-prompt.md",
  "assessment-stack.json",
  "assessment-schema.json",
  "intake-snapshot.json",
  "existence-record.json",
  "verified-existence-record.json",
  "assessment-request.json",
  "assessment.json",
  "validated-assessment.json",
  "shadow-report.json",
] as const;

function expectedU2ScratchPaths(
  artifacts: readonly PublicationArtifact[],
  collectionManifestPath: string,
  prepared: PreparedBatchStateRoot,
): ReadonlySet<string> {
  const manifestArtifact = artifacts.find(({ path }) => path === collectionManifestPath);
  if (manifestArtifact === undefined) throw new Error("Collection manifest is missing from the current artifact inventory.");
  const manifest = JSON.parse(Buffer.from(manifestArtifact.bytes).toString("utf8")) as {
    readonly schemaVersion?: unknown;
    readonly phase?: unknown;
    readonly runId?: unknown;
    readonly entries?: readonly { readonly revisionId?: unknown; readonly selected?: unknown }[];
  };
  if (manifest.schemaVersion !== "github-issue-roadmap-shadow-collection-manifest/v1" ||
      manifest.phase !== "sealed" || manifest.runId !== prepared.runId || !Array.isArray(manifest.entries)) {
    throw new Error("Collection manifest cannot define the closed U2 scratch inventory.");
  }
  const selected = manifest.entries.filter((entry) => entry.selected === true);
  const paths = new Set<string>([
    `${ARTIFACT_DIRECTORY}/shadow-runs/${prepared.runId}/ledger.jsonl`,
  ]);
  selected.forEach((entry, index) => {
    if (typeof entry.revisionId !== "string" || !SHA256.test(entry.revisionId)) {
      throw new Error("Collection manifest selected entry has an invalid revision identity.");
    }
    const prefix = `${ARTIFACT_DIRECTORY}/shadow-runs/${prepared.runId}/entries/${
      String(index + 1).padStart(4, "0")
    }-${entry.revisionId}/`;
    for (const name of SHADOW_ENTRY_SCRATCH_FILES) paths.add(`${prefix}${name}`);
  });
  return paths;
}

function transition(values: ReadonlyMap<string, string>, trustedMainSha: string): PublicationTransition {
  const tag = required(values, "transition");
  const lease = values.get("lease") ?? null;
  if (tag === "create") {
    if (lease !== null) throw new Error("create forbids --lease; its lease is exactly null.");
    return { tag, leaseSha: null, orderedParents: [trustedMainSha] };
  }
  if (tag === "same_main") {
    if (lease === null) throw new Error("same_main requires --lease=SHA.");
    return { tag, leaseSha: lease, orderedParents: [lease] };
  }
  if (tag === "advanced_main") {
    if (lease === null) throw new Error("advanced_main requires --lease=SHA.");
    return { tag, leaseSha: lease, orderedParents: [lease, trustedMainSha] };
  }
  throw new Error("--transition must be create, same_main, or advanced_main.");
}

export function runShadowPublicationValidatorCli(
  argv: readonly string[],
  cwd = process.cwd(),
  privateDirectoryPolicy: ShadowPrivateDirectoryPolicy = {},
): string {
  const { command, values } = parseArgs(argv);
  const repoRoot = resolve(values.get("repo-root") ?? cwd);
  if (command === "inventory") {
    const prepared = readPreparedBatchStateRoot(required(values, "prepared-state"));
    if (prepared.stateRoot !== expectedStateRoot(repoRoot)) {
      throw new Error("Prepared batch state root does not match the trusted checkout Git common directory.");
    }
    assertShadowPrivateDirectory(prepared.stateRoot, true, privateDirectoryPolicy);
    const out = initialInventoryPath(prepared);
    if (existsSync(out)) {
      // Resume, not rewrite.
      //
      // The inventory is the pre-run baseline `validate` diffs against to decide what this
      // run produced, and the run ID is one Eastern-week bucket, so every attempt in a week
      // addresses the same file. Refusing here meant the first attempt's failure -- whatever
      // it was -- silently became "inventory collision" for every retry that week, masking
      // the original cause and leaving the schedule exactly one attempt per week. Four
      // separately preserved failure worktrees for `weekly-20260824` are all this one
      // cascade.
      //
      // Reusing the existing baseline is the stricter reading of write-once, not a relaxation
      // of it: the baseline is still computed exactly once per run ID and never recomputed
      // after partial work, which is the property that stops a failed attempt's artifacts
      // being mistaken for pre-existing ones. Re-reading it here also fails closed on a
      // corrupt or schema-invalid file rather than proceeding on an unreadable baseline.
      //
      // Known consequence: artifacts added between attempts are attributed to the run. That
      // is the correct trade against having no retry path at all.
      readInitialInventory(out);
      return out;
    }
    const body: InitialInventoryFile = { schemaVersion: INVENTORY_SCHEMA, entries: inventoryOf(walkArtifacts(repoRoot)) };
    writeOnceFile(out, Buffer.from(prettyCanonicalJson(body)));
    return out;
  }
  if (command !== "validate") throw new Error("Command must be inventory or validate.");
  const prepared = readPreparedBatchStateRoot(required(values, "prepared-state"));
  if (prepared.stateRoot !== expectedStateRoot(repoRoot)) {
    throw new Error("Prepared batch state root does not match the trusted checkout Git common directory.");
  }
  const trustedMainSha = required(values, "trusted-main-sha");
  const artifacts = walkArtifacts(repoRoot);
  const initialInventory = readInitialInventory(initialInventoryPath(prepared));
  const initialPaths = new Set(initialInventory.map(({ path }) => path));
  const journalRecords: PublicationJournalRecord[] = artifacts.flatMap((entry) => {
    if (initialPaths.has(entry.path) || (!entry.path.startsWith(`${ARTIFACT_DIRECTORY}/observations/`) &&
        !entry.path.startsWith(`${ARTIFACT_DIRECTORY}/attempts/`))) return [];
    const path = resolve(repoRoot, entry.path);
    return [{ path: entry.path, record: readIntakeJournalRecord(path) }];
  });
  const collectionManifestPath = required(values, "collection-manifest").replaceAll("\\", "/");
  const requestedPaths = new Set<string>([collectionManifestPath, ...journalRecords.map(({ path }) => path)]);
  for (const { record } of journalRecords) {
    if (record.schemaVersion !== INTAKE_ATTEMPT_SCHEMA) {
      requestedPaths.add(record.candidate.locator);
      requestedPaths.add(record.snapshot.locator);
    } else {
      if (record.bindings.candidate !== null) requestedPaths.add(record.bindings.candidate.locator);
      if (record.bindings.snapshot !== null) requestedPaths.add(record.bindings.snapshot.locator);
    }
  }
  const scratchPaths = expectedU2ScratchPaths(artifacts, collectionManifestPath, prepared);
  const unexpected = artifacts.filter(({ path }) =>
    !initialPaths.has(path) && !requestedPaths.has(path) && !scratchPaths.has(path));
  if (unexpected.length > 0) {
    throw new Error(`Publication allowlist rejects unmanifested or prohibited additions: ${
      unexpected.map(({ path }) => path).sort(lexical).join(", ")
    }.`);
  }
  const currentArtifacts = artifacts.filter(({ path }) => initialPaths.has(path) || requestedPaths.has(path));
  const publication = deriveShadowPublication({
    originIdentity: required(values, "origin"),
    trustedMainSha,
    transition: transition(values, trustedMainSha),
    collectionManifestPath,
    initialInventory,
    currentArtifacts,
    journalRecords,
  });
  const boundPrepared = stateRootFromPreparedBatch(required(values, "prepared-state"), publication);
  const collectionArtifact = publication.files.find(({ path }) => path === publication.publishManifest.collectionManifestPath);
  if (collectionArtifact === undefined) throw new Error("Validated publication lost its sealed collection manifest.");
  const collection = JSON.parse(Buffer.from(collectionArtifact.bytes).toString("utf8")) as {
    readonly counts?: { readonly attempted?: unknown };
  };
  const attempted = collection.counts?.attempted;
  if (!Number.isSafeInteger(attempted) || (attempted as number) < 0) {
    throw new Error("Sealed collection manifest has an invalid attempted count.");
  }
  if (attempted === 0) {
    const discovery = discoverShadowSpool(boundPrepared.stateRoot, privateDirectoryPolicy);
    return prettyCanonicalJson({
      schemaVersion: NON_PROMOTION_RECEIPT_SCHEMA,
      state: "not_promoted",
      reason: "zero_attempts",
      runId: publication.publishManifest.runId,
      collectionManifestPath: publication.publishManifest.collectionManifestPath,
      collectionManifestSha256: publication.publishManifest.collectionManifestSha256,
      spoolBundleCount: discovery.completed.length,
    }).trimEnd();
  }
  return prettyCanonicalJson(promoteShadowPublication({
    stateRoot: boundPrepared.stateRoot,
    publication,
    privateDirectoryPolicy,
  })).trimEnd();
}
