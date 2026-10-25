import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// Moving these pins requires re-qualification and an explicit operator reinstall.
export const STEWARDSHIP_ASTRA_PIN = {
  version: "0.160.0",
  tarballUrl: "https://registry.npmjs.org/@openai/codex/-/codex-0.160.0-win32-x64.tgz",
  tarballIntegrity: "sha512-/gCFcuOmGlQkgGivWCtY8BNEDixh70Pue0HZOk9S8bj2vUIE1GLD9zcNB/KqqDJmn0S+lIttauLpzQnw6HOCHA==",
  executableSha256: "FDDA5FA3CF3FB3D000B876720742857676293E4315E4B045FAE6F8BD7E866D1D",
  treeManifestSha256: "ABE8AE3B230BD07A5D9C55F1A11D9A1FDF1790EB999ADF4C060BD9B98C0D25C2",
} as const;

export const STEWARDSHIP_ASTRA_ROOT = resolve(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"),
  "WorkflowTools", "github-issue-roadmap");
export const STEWARDSHIP_ASTRA_BIN_DIRECTORY = join(STEWARDSHIP_ASTRA_ROOT, "astra-seat-bin", STEWARDSHIP_ASTRA_PIN.version);
export const STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE = join("vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");

export class StewardshipAstraInstallPathError extends Error {
  constructor() { super("Astra install path contains a link or special entry."); }
}

/** lstat every owned component before following it, including Windows junctions. */
export async function assertStewardshipAstraInstallPath(ownedRoot: string, target: string, allowMissing = false): Promise<void> {
  const root = resolve(ownedRoot);
  const suffix = relative(root, resolve(target));
  if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith(`..${sep}`)) throw new StewardshipAstraInstallPathError();
  const parts = suffix ? suffix.split(sep) : [];
  let current = root;
  for (let index = 0; index <= parts.length; index++) {
    if (index > 0) current = join(current, parts[index - 1]);
    let info;
    try { info = await lstat(current); } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || (!info.isDirectory() && (index < parts.length || !info.isFile()))) {
      throw new StewardshipAstraInstallPathError();
    }
  }
}

export async function stewardshipAstraFileSha256(path: string, signal?: AbortSignal): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new StewardshipAstraInstallPathError();
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}

/** Paths are relative to vendor/, exact case, ordinal sorted; every regular file participates. */
export async function stewardshipAstraTreeManifestSha256(vendor: string, signal?: AbortSignal): Promise<string> {
  await assertStewardshipAstraInstallPath(dirname(dirname(vendor)), vendor);
  const files: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    signal?.throwIfAborted();
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StewardshipAstraInstallPathError();
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw new StewardshipAstraInstallPathError();
      if (entry.isDirectory()) await walk(path, `${prefix}${name}/`);
      else if (entry.isFile()) files.push(`${prefix}${name}`);
      else throw new StewardshipAstraInstallPathError();
    }
  };
  await walk(vendor, "");
  const manifest = createHash("sha256");
  for (const path of files.sort()) {
    signal?.throwIfAborted();
    manifest.update(`${path} ${await stewardshipAstraFileSha256(join(vendor, path), signal)}\n`);
  }
  return manifest.digest("hex").toUpperCase();
}
