import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface ArtifactFs {
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
  statSync(path: string): { isDirectory(): boolean };
}

const realFs: ArtifactFs = { existsSync, realpathSync, statSync };

export function resolveRoadmapArtifactRealPath(path: string, fs: ArtifactFs = realFs): string {
  let current = path;
  const missingTail: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    missingTail.unshift(basename(current));
    current = parent;
  }
  return join(fs.realpathSync(current), ...missingTail);
}

export function assertPathInsideRepository(
  path: string,
  repoRoot: string,
  context: string,
  fs: ArtifactFs = realFs,
): string {
  const root = resolveRoadmapArtifactRealPath(resolve(repoRoot), fs);
  const target = resolveRoadmapArtifactRealPath(resolve(repoRoot, path), fs);
  const fromRoot = relative(root, target);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error(`${context} must resolve inside the repository.`);
  }
  return target;
}

export function assertRoadmapArtifactOutputPath(
  outputPath: string,
  repoRoot: string,
  fs: ArtifactFs = realFs,
): string {
  const root = resolveRoadmapArtifactRealPath(resolve(repoRoot), fs);
  const logicalAllowedRoot = resolve(repoRoot, "artifacts/github-issue-roadmap");
  const logicalTarget = resolve(repoRoot, outputPath);
  const target = resolveRoadmapArtifactRealPath(logicalTarget, fs);
  const allowedRoot = resolveRoadmapArtifactRealPath(logicalAllowedRoot, fs);
  const expectedAllowedFromRoot = relative(resolve(repoRoot), logicalAllowedRoot);
  const actualAllowedFromRoot = relative(root, allowedRoot);
  const logicalPathFromAllowedRoot = relative(logicalAllowedRoot, logicalTarget);
  const pathFromRoot = relative(root, target);
  const pathFromAllowedRoot = relative(allowedRoot, target);
  if (
    actualAllowedFromRoot.toLowerCase() !== expectedAllowedFromRoot.toLowerCase() ||
    logicalPathFromAllowedRoot === "" || logicalPathFromAllowedRoot.startsWith("..") ||
    isAbsolute(logicalPathFromAllowedRoot) || pathFromRoot === "" ||
    pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot) ||
    pathFromAllowedRoot === "" || pathFromAllowedRoot.startsWith("..") ||
    isAbsolute(pathFromAllowedRoot) || extname(target).toLowerCase() !== ".json"
  ) {
    throw new Error("The --out path must be a JSON file under artifacts/github-issue-roadmap/.");
  }
  try {
    if (fs.statSync(target).isDirectory()) {
      throw new Error("The --out path must name a JSON file, not a directory.");
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  return target;
}

export function assertDistinctRoadmapArtifactPaths(
  paths: readonly { readonly label: string; readonly path: string }[],
  repoRoot: string,
  fs: ArtifactFs = realFs,
): void {
  const seen = new Map<string, string>();
  for (const entry of paths) {
    const realPath = resolveRoadmapArtifactRealPath(resolve(repoRoot, entry.path), fs);
    // Case-folding identity is a filesystem question, and `sep` answers it without reaching the
    // process object: the shadow boundary gate bans `process` outright (no carve-out), and this is
    // one of the three reads that used to force one.
    const identity = sep === "\\" ? realPath.toLowerCase() : realPath;
    const prior = seen.get(identity);
    if (prior !== undefined) {
      throw new Error(`${entry.label} and ${prior} resolve to the same file.`);
    }
    seen.set(identity, entry.label);
  }
}

export function writeRoadmapArtifactAtomically(outputPath: string, contents: string): void {
  // randomUUID() alone carries the uniqueness a temp name needs; the pid added nothing it did not
  // already have, and reaching `process` for it is no longer permitted inside the shadow closure.
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx" });
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write error; a uniquely named temp is safe to clean later.
    }
    throw error;
  }
}

export interface ImmutableArtifactWriteFs {
  closeSync(fd: number): void;
  existsSync(path: string): boolean;
  linkSync(existingPath: string, newPath: string): void;
  openSync(path: string, flags: string, mode?: number): number;
  unlinkSync(path: string): void;
  writeFileSync(path: string, contents: string, options: { encoding: "utf8"; flag: "wx"; mode: number }): void;
}

const immutableArtifactWriteFs: ImmutableArtifactWriteFs = {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  unlinkSync,
  writeFileSync,
};

export function writeRoadmapArtifactImmutably(
  outputPath: string,
  contents: string,
  fs: ImmutableArtifactWriteFs = immutableArtifactWriteFs,
): void {
  const claimPath = `${outputPath}.claim`;
  const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
  let claim: number | null = null;
  let ownsClaim = false;
  try {
    claim = fs.openSync(claimPath, "wx", 0o600);
    ownsClaim = true;
    fs.closeSync(claim);
    claim = null;
    if (fs.existsSync(outputPath)) {
      throw new Error(`Immutable roadmap artifact collision: ${outputPath} already exists.`);
    }
    fs.writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    // A hard-link commit is atomic and never replaces an existing pathname on POSIX or Windows.
    fs.linkSync(temporaryPath, outputPath);
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (claim !== null) fs.closeSync(claim);
    try {
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    } catch {
      // Preserve the original publication error; the unique temp can be cleaned later.
    }
    throw error;
  } finally {
    try {
      if (ownsClaim && fs.existsSync(claimPath)) fs.unlinkSync(claimPath);
    } catch {
      // A stale claim is fail-closed and safer than masking a successful or failed publication.
    }
  }
}
