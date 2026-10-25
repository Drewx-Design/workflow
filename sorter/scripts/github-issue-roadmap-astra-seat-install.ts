import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import {
  STEWARDSHIP_ASTRA_BIN_DIRECTORY, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE, STEWARDSHIP_ASTRA_PIN,
  assertStewardshipAstraInstallPath, stewardshipAstraFileSha256, stewardshipAstraTreeManifestSha256,
} from "./lib/github-issue-roadmap/stewardship-astra-seat-pin";

interface InstallDependencies {
  readonly pins?: { readonly [K in keyof typeof STEWARDSHIP_ASTRA_PIN]: string };
  readonly fetch?: typeof fetch;
  readonly destination?: string;
  readonly tarRunner?: (command: string, args: readonly string[], bytes: Buffer) => Promise<void>;
}

function safeArchivePath(name: string, metadata = false): void {
  const parts = name.replace(/\/$/, "").split("/");
  if (!name || isAbsolute(name) || win32.isAbsolute(name) || /[\\:\x00-\x1f]/.test(name)
    || parts.some((part) => !part || part === ".." || part === "." || /[. ]$/.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    || (!metadata && parts[0] !== "package")) {
    throw new Error(`Unsafe tar entry: ${JSON.stringify(name)} (must stay under package/).`);
  }
}

function tarNumber(field: Buffer): number {
  const text = field.toString("ascii").replace(/\0.*$/, "").trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("Invalid tar numeric field.");
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) throw new Error("Invalid tar size.");
  return value;
}

function paxFields(bytes: Buffer): Record<string, string> {
  const fields: Record<string, string> = {};
  for (let offset = 0; offset < bytes.length;) {
    const space = bytes.indexOf(32, offset);
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    const length = Number(lengthText);
    if (space < offset || !/^[1-9][0-9]*$/.test(lengthText) || !Number.isSafeInteger(length)
      || length <= space - offset + 2 || offset + length > bytes.length || bytes[offset + length - 1] !== 10) {
      throw new Error("Invalid tar extended header.");
    }
    const record = bytes.subarray(space + 1, offset + length - 1).toString("utf8");
    const equals = record.indexOf("=");
    const key = record.slice(0, equals);
    if (equals < 1 || Object.hasOwn(fields, key)
      || !/^(path|size|mtime|atime|ctime|uid|gid|uname|gname|SCHILY\.(dev|ino|nlink))$/.test(key)) {
      throw new Error("Unsupported tar extended header (links and special files are forbidden).");
    }
    fields[key] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}

/** Inspect actual filesystem entries before tar.exe can write anything. PAX records are metadata. */
function validateArchive(tarball: Buffer): void {
  const bytes = gunzipSync(tarball, { maxOutputLength: 512 * 1024 * 1024 });
  const paths = new Set<string>();
  let extended: Record<string, string> | undefined;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (extended || bytes.length - offset < 1024 || !bytes.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Invalid tar ending.");
      }
      return;
    }
    const checksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (checksum !== tarNumber(header.subarray(148, 156))) throw new Error("Invalid tar header checksum.");
    const field = (start: number, end: number) => header.subarray(start, end).toString("utf8").replace(/\0.*$/, "");
    if (field(257, 263) !== "ustar") throw new Error("Unsupported tar format.");
    const name = [field(345, 500), field(0, 100)].filter(Boolean).join("/");
    const size = tarNumber(header.subarray(124, 136));
    const type = field(156, 157);
    const next = offset + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length || field(157, 257)) throw new Error("Invalid tar entry or forbidden link.");
    if (type === "x") {
      safeArchivePath(name, true);
      if (extended) throw new Error("Repeated tar extended header.");
      extended = paxFields(bytes.subarray(offset + 512, offset + 512 + size));
    } else {
      if (!["", "0", "5"].includes(type)) throw new Error("Forbidden tar link or special entry.");
      safeArchivePath(name);
      const effectivePath = extended?.path ?? name;
      safeArchivePath(effectivePath);
      const key = effectivePath.replace(/\/$/, "").toLowerCase();
      if (paths.has(key)) throw new Error("Duplicate effective tar entry path.");
      paths.add(key);
      if ((extended?.size !== undefined && extended.size !== String(size)) || (type === "5" && size !== 0)) {
        throw new Error("Conflicting tar entry size.");
      }
      extended = undefined;
    }
    offset = next;
  }
  throw new Error("Truncated tar archive.");
}

async function assertRegularTree(directory: string): Promise<void> {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Extracted tree contains a link or special entry.");
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error("Extracted tree contains a link or special entry.");
    if (entry.isDirectory()) await assertRegularTree(path);
    else if (!entry.isFile()) throw new Error("Extracted tree contains a link or special entry.");
  }
}

async function removeDirectRegularFiles(directory: string): Promise<void> {
  const files: string[] = [];
  for (const name of await readdir(directory)) {
    const path = join(directory, name);
    const entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-regular package entry: ${path}`);
    }
    files.push(path);
  }
  for (const path of files) await unlink(path);
  await rmdir(directory);
}

async function alreadyInstalled(destination: string, pins: NonNullable<InstallDependencies["pins"]>): Promise<boolean> {
  await assertStewardshipAstraInstallPath(dirname(destination), destination, true);
  try { await lstat(destination); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const info = await lstat(destination);
    await assertStewardshipAstraInstallPath(dirname(destination), join(destination, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE));
    if (info.isDirectory()
      && await stewardshipAstraFileSha256(join(destination, STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE)) === pins.executableSha256
      && await stewardshipAstraTreeManifestSha256(join(destination, "vendor")) === pins.treeManifestSha256) return true;
  } catch { /* An incomplete or unreadable installation must also be left untouched. */ }
  throw new Error(`Destination already exists with an unqualified vendor tree; remove it manually before reinstalling: ${destination}`);
}

async function runTar(command: string, args: readonly string[], bytes: Buffer): Promise<void> {
  if (process.platform !== "win32") throw new Error("Astra seat installation requires Windows tar.exe.");
  const result = spawnSync(command, [...args], { input: bytes, encoding: "utf8", windowsHide: true, timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error("Windows tar.exe extraction failed.");
}

/** Operator-only entry point. Imports never download, extract, install, or execute a package. */
export async function installStewardshipAstraSeat(dependencies: InstallDependencies = {}): Promise<string> {
  const pins = dependencies.pins ?? STEWARDSHIP_ASTRA_PIN;
  const fetchBytes = dependencies.fetch ?? fetch;
  const destination = resolve(dependencies.destination ?? STEWARDSHIP_ASTRA_BIN_DIRECTORY);
  const ownedRoot = dirname(destination);
  let staging: string | undefined;
  let receipt!: string;
  let failed = false;
  let primaryError: unknown;
  try {
    // Invariant order: pinned integrity, registry integrity, header validation, extraction from verified bytes, manifest, publish — never reorder.
    const response = await fetchBytes(pins.tarballUrl);
    if (!response.ok) throw new Error("Pinned tarball download failed.");
    const tarball = Buffer.from(await response.arrayBuffer());
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    if (integrity !== pins.tarballIntegrity) throw new Error("Tarball integrity mismatch against pinned integrity.");
    const registry = await fetchBytes(`https://registry.npmjs.org/@openai%2fcodex/${pins.version}-win32-x64`);
    if (!registry.ok) throw new Error("Registry version integrity lookup failed.");
    const published = await registry.json() as { version?: string; dist?: { integrity?: string } };
    if (published.version !== `${pins.version}-win32-x64`) throw new Error("Registry version mismatch.");
    if (published.dist?.integrity !== pins.tarballIntegrity) throw new Error("Registry integrity mismatch against pinned integrity.");
    validateArchive(tarball);
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !/^[A-Za-z]:[\\/]/.test(systemRoot)) throw new Error("Drive-letter SystemRoot is required for Windows tar.exe.");
    await assertStewardshipAstraInstallPath(ownedRoot, destination, true);
    await mkdir(ownedRoot, { recursive: true });
    await assertStewardshipAstraInstallPath(ownedRoot, ownedRoot);
    staging = await mkdtemp(join(ownedRoot, "roadmap-astra-stage-"));
    await (dependencies.tarRunner ?? runTar)(win32.join(systemRoot, "System32", "tar.exe"), ["-xzf", "-", "-C", staging], tarball);
    await assertStewardshipAstraInstallPath(ownedRoot, join(staging, "package"));
    await assertRegularTree(join(staging, "package"));
    const executableSha256 = await stewardshipAstraFileSha256(join(staging, "package", STEWARDSHIP_ASTRA_EXECUTABLE_RELATIVE));
    if (executableSha256 !== pins.executableSha256) throw new Error("Extracted codex.exe SHA-256 mismatch against seat pin.");
    const treeManifestSha256 = await stewardshipAstraTreeManifestSha256(join(staging, "package", "vendor"));
    if (treeManifestSha256 !== pins.treeManifestSha256) throw new Error("Extracted vendor tree manifest SHA-256 mismatch against seat pin.");
    let status = "installed";
    if (await alreadyInstalled(destination, pins)) status = "already-installed";
    else {
      await rename(join(staging, "package", "vendor"), join(staging, "vendor"));
      await removeDirectRegularFiles(join(staging, "package"));
      await assertStewardshipAstraInstallPath(ownedRoot, destination, true);
      // Windows directory rename refuses an existing destination, including an empty directory.
      await rename(staging, destination);
      staging = undefined;
    }
    receipt = `${status}: version=${pins.version}\ntarball integrity=${integrity}\ncodex.exe sha256=${executableSha256}\nvendor manifest sha256=${treeManifestSha256}\ndestination=${destination}`;
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  if (failed) {
    if (staging) {
      const absolute = resolve(staging);
      // Retained staging directories under astra-seat-bin are inert: the seat reads only the versioned destination.
      const notice = `Astra seat staging remains at ${absolute}. Delete it manually after checking it.`;
      try {
        if (primaryError instanceof Error) primaryError.message = `${primaryError.message}\n${notice}`;
        else console.error(notice);
      } catch (cleanupError) {
        try { Object.defineProperty(primaryError, "cleanupErrors", { value: [cleanupError, new Error(notice)] }); }
        catch { console.error(notice, cleanupError); }
      }
    }
    throw primaryError;
  }
  return receipt;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  installStewardshipAstraSeat().then((receipt) => { console.log(receipt); }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
