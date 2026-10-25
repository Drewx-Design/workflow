import './worktree-cleanup-test-env';
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { negative, ok, probe, resolveExecutable, unknown } from "../lib/worktree-cleanup/probe.mjs";
import { candidateInventory, checkPrunePreview, inventory, isAdmissibleTopLevelNodeModulesJunction, isBuildSelfLink, isWithin, normalizePath, parseStatus, parseWorktrees, readLink, scanShallowLinks, walkDirectory } from "../lib/worktree-cleanup/inventory.mjs";
import { planWorktrees } from "../lib/worktree-cleanup/policy.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync), lstatSync: vi.fn(fs.lstatSync), readlinkSync: vi.fn(fs.readlinkSync) };
});

const roots: string[] = [];
const junctions: string[] = [];
afterEach(() => {
  // Remove the junction itself, never recursively remove a tree through it.
  for (const junction of junctions.splice(0)) { if (process.platform === "win32") rmdirSync(junction); else unlinkSync(junction); }
  for (const root of roots.splice(0)) {
    const target = resolve(root), temporaryRoot = resolve(tmpdir());
    if (!target.startsWith(temporaryRoot + (process.platform === "win32" ? "\\" : "/"))) throw new Error("Unsafe fixture cleanup");
    rmSync(target, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cleanup-inventory-")); roots.push(directory);
  const primary = join(directory, "primary"); mkdirSync(primary);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: primary, encoding: "utf8", windowsHide: true }).trim();
  git("init", "--initial-branch=main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture"); git("config", "core.autocrlf", "false");
  writeFileSync(join(primary, ".gitignore"), ".worktrees/\nnode_modules/\n.next/\nnext-env.d.ts\nprivate/\n");
  writeFileSync(join(primary, "tracked.txt"), "original\n");
  git("add", "."); git("-c", "core.hooksPath=", "-c", "commit.gpgsign=false", "commit", "-m", "Fixture");
  const add = (name: string, path = join(directory, name)) => { git("worktree", "add", "-b", name.replaceAll(/[^a-zA-Z0-9-]/g, "-"), path); return path; };
  const scan = (runnerPath = join(directory, "unused-runner")) => inventory({ repositoryPath: primary, runnerPath });
  return { directory, primary, git, add, scan };
}

describe('Next build self-link U3 admission', { timeout: 30_000 }, () => {
  it.skipIf(process.platform !== 'win32')('U3-T2 holds a foreign target and preserves its inbound protection', () => {
    const f = fixture(), source = f.add('source'), other = f.add('other');
    const target = join(other, 'node_modules', 'pkg'), link = join(source, '.next', 'node_modules', 'pkg-hash');
    mkdirSync(target, { recursive: true }); mkdirSync(join(source, '.next', 'node_modules'), { recursive: true });
    symlinkSync(target, link, 'junction'); junctions.push(link);
    const result = f.scan();
    expect(tree(result, source).links).toMatchObject({ state: 'ok', value: { forbidden: ['.next/node_modules/pkg-hash'] } });
    expect(tree(result, other).inboundLinks).toMatchObject({ state: 'ok', value: [expect.objectContaining({ path: link })] });
  });
  it.skipIf(process.platform !== 'win32')('U3-T3 holds a self-link through shared node_modules and leaves its target intact', () => {
    const f = fixture(), source = f.add('shared-source'), shared = join(f.directory, 'shared');
    mkdirSync(join(shared, 'pkg'), { recursive: true }); writeFileSync(join(shared, 'pkg', 'keep'), 'safe');
    writeFileSync(join(shared, '.package-lock.json'), '{"packages":{}}');
    const modules = join(source, 'node_modules'), link = join(source, '.next', 'pkg-hash');
    mkdirSync(join(source, '.next')); symlinkSync(shared, modules, 'junction'); junctions.push(modules);
    symlinkSync(join(modules, 'pkg'), link, 'junction'); junctions.push(link);
    expect(tree(f.scan(), source).links).toMatchObject({ state: 'ok', value: { forbidden: ['.next/pkg-hash'] } });
    expect(readFileSync(join(shared, 'pkg', 'keep'), 'utf8')).toBe('safe');
  });
  it.skipIf(process.platform !== 'win32')('U3-T4 directly rejects otherwise valid evidence when .next is linked', () => {
    const f = fixture(), source = f.add('linked-next'), target = join(source, 'node_modules', 'pkg');
    const next = join(source, '.next'), link = join(next, 'pkg-hash');
    mkdirSync(target, { recursive: true }); mkdirSync(next); symlinkSync(target, link, 'junction'); junctions.push(link);
    const evidence = readLink(source, link, 'symlink', probe);
    expect(isBuildSelfLink(source, evidence)).toBe(true);
    rmdirSync(link); junctions.pop(); rmdirSync(next);
    const outside = join(f.directory, 'next'); mkdirSync(outside); symlinkSync(outside, next, 'junction'); junctions.push(next);
    expect(isBuildSelfLink(source, evidence)).toBe(false);
    expect(tree(f.scan(), source).links).toMatchObject({ state: 'ok', value: { forbidden: ['.next'] } });
  });
  it.skipIf(process.platform !== 'win32').each(['next-target', 'two-hop'])('U3-T10 holds %s links', kind => {
    const f = fixture(), source = f.add('chained'), next = join(source, '.next'); mkdirSync(next);
    const target = join(source, 'node_modules', 'pkg'); mkdirSync(target, { recursive: true });
    const middle = join(next, 'middle'), link = join(next, 'pkg-hash');
    if (kind === 'next-target') mkdirSync(middle);
    else { symlinkSync(target, middle, 'junction'); junctions.push(middle); }
    symlinkSync(middle, link, 'junction'); junctions.push(link);
    const links = tree(f.scan(), source).links;
    if (links.state !== 'ok') throw new Error('Links unavailable');
    expect(links.value.forbidden).toContain('.next/pkg-hash');
  });
  it.skipIf(process.platform !== 'win32')('U3-T15 holds a file symlink into own node_modules', () => {
    const f = fixture(), source = f.add('file-link'), target = join(source, 'node_modules', 'file.js');
    mkdirSync(join(source, 'node_modules')); writeFileSync(target, 'safe'); mkdirSync(join(source, '.next'));
    const link = join(source, '.next', 'file-hash'); symlinkSync(target, link, 'file');
    expect(tree(f.scan(), source).links).toMatchObject({ state: 'ok', value: { forbidden: ['.next/file-hash'] } });
  });
  it.skipIf(process.platform !== 'win32').for(['escape', 'prefix', 'relative'])('U3-T16 normalizes containment for %s targets', (kind, context) => {
    const f = fixture(), source = f.add('normalized'), modules = join(source, 'node_modules'); mkdirSync(modules);
    const link = join(source, '.next', 'pkg-hash'); mkdirSync(join(source, '.next'));
    const target = kind === 'escape' ? join(f.directory, 'other', 'node_modules', 'x') :
      kind === 'prefix' ? join(source, 'node_modules-evil', 'x') : join(modules, 'x');
    mkdirSync(target, { recursive: true });
    const raw = kind === 'escape' ? modules + '\\..\\..\\other\\node_modules\\x' : kind === 'relative' ? '..\\node_modules\\x' : target;
    try { symlinkSync(raw, link, 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') context.skip('Windows directory symlink privilege unavailable (EPERM)'); throw error; }
    junctions.push(link);
    // Node canonicalizes absolute targets while creating Windows symlinks.
    // Preserve the raw spelling at the existing readlink seam to test our normalization.
    const realRead = vi.mocked(readlinkSync).getMockImplementation()!;
    if (kind === 'escape') vi.mocked(readlinkSync).mockImplementation((...args) =>
      normalizePath(String(args[0])) === normalizePath(link) ? raw : realRead(...args));
    try {
      const evidence = readLink(source, link, 'symlink', probe), admitted = kind === 'relative';
      if (kind === 'escape') expect(evidence.rawTarget).toBe(raw);
      expect(isBuildSelfLink(source, evidence)).toBe(admitted);
      const links = tree(f.scan(), source).links;
      if (links.state !== 'ok') throw new Error('Links unavailable');
      expect(links.value.forbidden).toEqual(admitted ? [] : ['.next/pkg-hash']);
    } finally { vi.mocked(readlinkSync).mockImplementation(realRead); }
  });
});

describe('U2 stale registration identity', () => {
  it.skipIf(process.platform !== 'win32')('includes a full targetBaseline only when requested for a scoped release inventory', () => {
    const f = fixture(), target = f.add('release'), packages = join(f.primary, 'node_modules');
    mkdirSync(join(packages, 'nested'), { recursive: true }); writeFileSync(join(packages, 'nested', 'keep'), 'safe');
    writeFileSync(join(packages, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const link = join(target, 'node_modules'); symlinkSync(packages, link, 'junction'); junctions.push(link);
    const options = { repositoryPath: f.primary, runnerPath: f.primary, candidatePath: target };
    const shallow = inventory(options), full = inventory({ ...options, fullTargetBaseline: true });
    expect(shallow.state).toBe('ok'); expect(full.state).toBe('ok');
    if (shallow.state !== 'ok' || full.state !== 'ok') throw new Error('Inventory failed');
    expect(shallow.value.worktrees[0]).not.toHaveProperty('targetBaseline');
    expect(full.value.worktrees).toHaveLength(1);
    expect(full.value.worktrees[0].targetBaseline).toMatchObject({ state: 'ok', value: { count: 3, topLevelCount: 2 } });
  });
  it.each([false, true])('U1 rejects a candidate recreated at the same path, branch and HEAD (scoped release=%s)', scoped => {
    const f = fixture(), candidate = f.add('candidate'), snapshot = f.scan();
    if (snapshot.state !== 'ok') throw new Error('Inventory unavailable');
    if (scoped) Object.assign(snapshot.value, { scopedInboundBaseline: true,
      worktrees: snapshot.value.worktrees.filter(tree => normalizePath(tree.path) === normalizePath(candidate)) });
    const original = snapshot.value.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(candidate))!;
    f.git('worktree', 'remove', candidate);
    f.git('worktree', 'add', candidate, 'candidate');
    const fresh = f.scan();
    if (fresh.state !== 'ok') throw new Error('Inventory unavailable');
    const replacement = fresh.value.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(candidate))!;
    expect(fresh.value.registrations).toEqual(snapshot.value.registrations);
    expect(replacement.key).toBe(original.key);
    expect(replacement.gitdirFingerprint).not.toBe(original.gitdirFingerprint);
    expect(candidateInventory(candidate, snapshot.value)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('HEAD or registration changed') });
  });
  it('U1 rejects a candidate whose frozen admin path differs', () => {
    const f = fixture(), candidate = f.add('candidate'), snapshot = f.scan();
    if (snapshot.state !== 'ok') throw new Error('Inventory unavailable');
    const original = snapshot.value.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(candidate))!;
    original.adminPath = join(f.primary, '.git', 'worktrees', 'previous-admin');
    expect(candidateInventory(candidate, snapshot.value)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('HEAD or registration changed') });
  });
  const preview = (primary: string) => {
    const output = spawnSync('git', ['-C', primary, 'worktree', 'prune', '--dry-run', '--verbose'], { encoding: 'utf8', windowsHide: true });
    expect(output.status).toBe(0);
    return output.stdout + output.stderr;
  };
  it.each(['directory-gone', 'git-gone'])('skips only the frozen path/admin key: %s', kind => {
    const f = fixture(), candidate = f.add('candidate'), stale = f.add('stale');
    if (kind === 'git-gone') unlinkSync(join(stale, '.git'));
    else {
      expect(isWithin(stale, f.directory)).toBe(true);
      rmSync(stale, { recursive: true });
    }
    const snapshot = f.scan();
    if (snapshot.state !== 'ok') throw new Error('Inventory unavailable');
    expect(snapshot.value.knownStaleRegistrations).toEqual([{ path: stale.replaceAll('\\', '/'),
      adminPath: join(f.primary, '.git', 'worktrees', 'stale'), key: normalizePath(stale) + '\0' + normalizePath(join(f.primary, '.git', 'worktrees', 'stale')),
      gitdirFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    const fresh = candidateInventory(candidate, snapshot.value);
    expect(fresh).toMatchObject({ state: 'ok', value: { skippedStaleRegistrations: snapshot.value.knownStaleRegistrations } });
    const text = preview(f.primary);
    expect(checkPrunePreview(text, snapshot.value)).toEqual({ stopReason: null, deferred: true });
    const forged = { ...snapshot.value, knownStaleRegistrations: snapshot.value.knownStaleRegistrations.map(entry => ({ ...entry, key: entry.key + '-other-admin' })) };
    expect(candidateInventory(candidate, forged).state).toBe(kind === 'directory-gone' ? 'unknown' : 'ok');
    expect(checkPrunePreview(text, forged)).toEqual({ stopReason: 'prune-unknown', deferred: false });
  });
  it.each(['missing', 'unreadable'])('skips a %s ghost admin entry but refuses its prune preview', kind => {
    const f = fixture(), candidate = f.add('candidate'), ghost = join(f.primary, '.git', 'worktrees', 'ghost');
    mkdirSync(ghost);
    const gitdir = join(ghost, 'gitdir');
    if (kind === 'unreadable') mkdirSync(gitdir);
    const snapshot = f.scan();
    expect(snapshot.state).toBe('ok');
    if (snapshot.state !== 'ok') throw new Error('Inventory unavailable');
    expect(snapshot.value.registrationKeys.map(entry => entry.adminPath)).not.toContain(ghost);
    expect(snapshot.value.knownStaleRegistrations).toEqual([]);
    expect(candidateInventory(candidate, snapshot.value).state).toBe('ok');
    const text = preview(f.primary);
    expect(text).toContain('Removing worktrees/ghost:');
    expect(checkPrunePreview(text, snapshot.value)).toEqual({ stopReason: 'prune-unknown', deferred: false });
  });
  it.each(['invalid', 'invalid-utf8'])('rejects %s ghost keys during prune preview', kind => {
    const f = fixture(); f.add('candidate');
    const ghost = join(f.primary, '.git', 'worktrees', 'ghost'); mkdirSync(ghost);
    const snapshot = f.scan();
    if (snapshot.state !== 'ok') throw new Error('Inventory unavailable');
    // Freeze a valid Git listing first: malformed gitdir bytes can also corrupt
    // Git's porcelain output, independently of the admin-key reader under test.
    writeFileSync(join(ghost, 'gitdir'), kind === 'invalid' ? 'not-an-absolute-gitdir\n' : Buffer.from([0xff]));
    expect(checkPrunePreview(preview(f.primary), snapshot.value)).toEqual({ stopReason: 'prune-unknown', deferred: false });
    expect(snapshot.value.knownStaleRegistrations).toEqual([]);
  });
  it.each(['regular-file', 'vanished', 'ENOTDIR'])('skips a %s admin entry while keeping its prune preview unknown', kind => {
    const f = fixture(), candidate = f.add('candidate'), root = join(f.primary, '.git', 'worktrees'), ghost = join(root, 'ghost');
    if (kind === 'ENOTDIR') mkdirSync(ghost);
    else writeFileSync(ghost, 'not an admin directory');
    const read = vi.mocked(readdirSync).getMockImplementation()!, stat = vi.mocked(lstatSync).getMockImplementation()!;
    if (kind === 'vanished') vi.mocked(readdirSync).mockImplementation(((path, options) => {
      const entries = Reflect.apply(read, undefined, [path, options]);
      if (String(path) === root && lstatSync(ghost, { throwIfNoEntry: false })) unlinkSync(ghost);
      return entries;
    }) as typeof readdirSync);
    if (kind === 'ENOTDIR') vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (String(path) === join(ghost, 'gitdir')) throw Object.assign(new Error('Admin entry changed to a file'), { code: 'ENOTDIR' });
      return stat(path, options);
    }) as typeof lstatSync);
    try {
      const snapshot = f.scan();
      expect(snapshot.state).toBe('ok');
      if (snapshot.state !== 'ok') throw new Error('Inventory unavailable');
      expect(snapshot.value.registrationKeys.map(entry => entry.adminPath)).not.toContain(ghost);
      expect(snapshot.value.registrationKeys.map(entry => entry.path)).toContain(candidate.replaceAll('\\', '/'));
      expect(candidateInventory(candidate, snapshot.value).state).toBe('ok');
      expect(checkPrunePreview('Removing worktrees/ghost: invalid admin entry\n', snapshot.value))
        .toEqual({ stopReason: 'prune-unknown', deferred: false });
    } finally {
      vi.mocked(readdirSync).mockImplementation(read);
      vi.mocked(lstatSync).mockImplementation(stat);
    }
  });
  it.skipIf(process.platform !== 'win32')('fails the whole inventory for a linked admin directory before any tree can be removable', async () => {
    const f = fixture(), candidate = f.add('candidate'); f.add('other');
    const admin = join(f.primary, '.git', 'worktrees', 'candidate'), target = join(f.directory, 'linked-admin');
    expect(isWithin(admin, f.directory) && isWithin(target, f.directory)).toBe(true);
    renameSync(admin, target);
    symlinkSync(target, admin, 'junction'); junctions.push(admin);
    // Git still sees the registration through the junction.
    expect(f.git('worktree', 'list', '--porcelain')).toContain(candidate.replaceAll('\\', '/'));
    const result = f.scan();
    expect(result).toMatchObject({ state: 'unknown', reason: expect.stringContaining('link or non-directory ancestor') });
    await expect(classify(result)).rejects.toThrow('Inventory failed');
    expect(readFileSync(join(candidate, 'tracked.txt'), 'utf8')).toBe('original\n');
  });
  it('stops when .git disappears only after classification', () => {
    const f = fixture(), candidate = f.add('candidate'), other = f.add('other'), baseline = f.scan();
    if (baseline.state !== 'ok') throw new Error('Inventory unavailable');
    unlinkSync(join(other, '.git'));
    expect(baseline.value.knownStaleRegistrations).toEqual([]);
    expect(candidateInventory(candidate, baseline.value)).toMatchObject({ state: 'unknown', stopReason: 'half-removed' });
    expect(checkPrunePreview(preview(f.primary), baseline.value).stopReason).toBe('prune-unknown');
  });
});
type InventoryResult = ReturnType<typeof inventory>;
function tree(result: InventoryResult, path: string) {
  if (result.state !== "ok") throw new Error(result.state === "unknown" ? result.reason : "Inventory returned negative");
  const entry = result.value.worktrees.find((row) => normalizePath(row.path) === normalizePath(path));
  if (!entry) throw new Error("Missing tree " + path);
  return entry;
}
async function classify(result: InventoryResult) {
  if (result.state !== "ok") throw new Error("Inventory failed");
  const planned = await planWorktrees({ ...result.value, worktrees: result.value.worktrees.map(entry => ({ ...entry,
    activity: { live: negative(), head: entry.registration.state === "ok" ? ok(entry.registration.value.head) : negative() },
  })) }, { prSnapshot: ok([]), ancestorOfMain: () => ok(true) });
  if (planned.state !== "ok") throw new Error("Classification failed");
  return (path: string) => planned.value.worktrees.find(entry => normalizePath(entry.path) === normalizePath(path))!;
}
function snapshot(root: string): string[] {
  const entries: string[] = [];
  function visit(path: string) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("Snapshot fixture must not contain links");
    entries.push(relative(root, path) + ":" + (stat.isDirectory() ? "directory" : createHash("sha256").update(readFileSync(path)).digest("hex")) + ":" + stat.mtimeMs);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
  }
  visit(root); return entries;
}

describe("probe boundary", () => {
  it('bounded inventory walk stops mid-directory at the absolute deadline', () => {
    const f = fixture(); let clock = 100, visited = 0;
    const result = walkDirectory(f.primary, { softDeadline: 200, now: () => clock, visit: () => { visited++; clock = 200; } });
    expect(result).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Soft deadline reached') });
    expect(visited).toBe(1);
  });
  it("preserves stderr and rejects empty stdout on nonzero exit", () => {
    expect(probe(process.execPath, ["-e", "process.stderr.write('failed'); process.exit(2)"])).toMatchObject({ state: "unknown", exitCode: 2, stderr: "failed" });
  });
  it("fails closed on timeout, missing executables, relative executables and parse failures", () => {
    expect(probe(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], { timeout: 30 }).state).toBe("unknown");
    expect(probe(join(tmpdir(), "missing-cleanup-executable"), []).state).toBe("unknown");
    expect(probe("git", []).state).toBe("unknown");
    expect(probe(process.execPath, ["-e", "process.stdout.write('invalid')"], { parse: JSON.parse }).state).toBe("unknown");
  });
  it("uses argument arrays and only produces negative from a successful parsed answer", () => {
    const value = "space ; $(not-a-command) é";
    expect(probe(process.execPath, ["-e", "process.stdout.write(process.argv[1])", value])).toMatchObject({ state: "ok", value });
    expect(probe(process.execPath, ["-e", "process.stdout.write('false')"], { parse: JSON.parse, isNegative: (value: unknown) => value === false })).toMatchObject({ state: "negative" });
    expect(resolveExecutable("git").state).toBe("ok");
  });
});

describe("NUL parsers and containment", () => {
  it.each(["accepted", "nested", "symlink", "zero-hop", "two-hop", "unknown", "missing"])("junction predicate rejects every unproven case: %s", kind => {
    const target = resolve(tmpdir(), "target"), link = {
      path: resolve(tmpdir(), "source/node_modules"), relativePath: kind === "nested" ? "nested/node_modules" : "node_modules",
      kind: kind === "symlink" ? "symlink" : "junction", target,
      targetChain: kind === "zero-hop" ? [] : kind === "two-hop" ? [resolve(tmpdir(), "middle"), target] : [target],
      targetIdentity: kind === "unknown" ? unknown("Unproven target") : ok(target),
    };
    expect(isAdmissibleTopLevelNodeModulesJunction(kind === "missing" ? undefined : link)).toBe(kind === "accepted");
  });
  it("rejects truncated and malformed evidence", () => {
    for (const text of [" M file", "garbage\0", "R  renamed\0", "ZZ file\0"]) expect(() => parseStatus(text)).toThrow();
    for (const text of ["", "worktree /tmp/tree\0", "worktree /tmp/tree\0HEAD bad\0detached\0\0"]) expect(() => parseWorktrees(text)).toThrow();
  });
  it("preserves rename source/destination and unusual filenames", () => {
    expect(parseStatus("R  new name é\0-old name\0?? line\nname.md\0")).toEqual([
      { index: "R", worktree: " ", path: "new name é", originalPath: "-old name" },
      { index: "?", worktree: "?", path: "line\nname.md" },
    ]);
  });
  it("compares path components case insensitively, excluding siblings", () => {
    expect(isWithin("/tmp/BT-X/child", "/tmp/bt-x")).toBe(true);
    expect(isWithin("/tmp/bt-x2", "/tmp/bt-x")).toBe(false);
  });
  it.skipIf(process.platform !== "win32")("normalizes drive case and backslashes", () => {
    expect(normalizePath("C:\\Temp\\BT-X\\")).toBe(normalizePath("c:/temp/bt-x"));
    expect(isWithin("C:\\Temp\\BT-X\\child", "c:/temp/bt-x")).toBe(true);
  });
});

describe("U1 structured per-hop link evidence", { timeout: 30_000 }, () => {
  function aliasChainFixture(name: string) {
    const f = fixture(), source = f.add(name), target = join(f.primary, "tracked.txt");
    const first = join(f.directory, "first.md"), middle = join(f.directory, "middle.md"), path = join(source, "note.md");
    symlinkSync(target, middle, "file"); symlinkSync(middle, first, "file"); symlinkSync(first, path, "file");
    return { ...f, source, target, first, middle, path };
  }
  it.skipIf(process.platform !== "win32").each([
    { kind: "drive", root: "Z:\\", errorPath: "Z:/" },
    { kind: "UNC share", root: "\\\\cleanup-unreachable.invalid\\share\\", errorPath: "//cleanup-unreachable.invalid/share" },
    { kind: "long-path UNC share", root: "\\\\cleanup-unreachable.invalid\\share\\", errorPath: "\\\\?\\UNC\\cleanup-unreachable.invalid\\share" },
    { kind: "drive-relative", root: "Z:\\", errorPath: "Z:" },
    { kind: "deep drive-relative", root: "Z:\\", errorPath: "Z:absent\\target.md" },
    { kind: "device-namespace UNC share", root: "\\\\cleanup-unreachable.invalid\\share\\", errorPath: "\\\\.\\UNC\\cleanup-unreachable.invalid\\share" },
  ])("U1 review records $kind root ENOENT as error", ({ root, errorPath }) => {
    const f = aliasChainFixture("root-error"), target = join(root, "absent", "target.md");
    const realStat = vi.mocked(lstatSync).getMockImplementation()!, realRead = vi.mocked(readlinkSync).getMockImplementation()!;
    const error = Object.assign(new Error("Volume root unavailable"), { code: "ENOENT", path: errorPath });
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (normalizePath(String(path)) === normalizePath(root)) throw error;
      return realStat(path, options);
    }) as typeof lstatSync);
    vi.mocked(readlinkSync).mockImplementation((path, options) => {
      if (normalizePath(String(path)) === normalizePath(f.path)) return target;
      return realRead(path, options);
    });
    try {
      vi.mocked(lstatSync).mockClear();
      const entry = tree(f.scan(), f.source);
      if (entry.links.state !== "ok") throw new Error("Links unavailable");
      expect(entry.links.value.entries[0]).toMatchObject({ target, targetChain: [target],
        targetIdentity: unknown(`Link target identity unavailable: ${String(error)}`),
        targetHops: [{ path: target, outcome: "error", code: "ENOENT" }], targetChainCycle: false, targetChainHopLimit: false });
      expect(vi.mocked(lstatSync).mock.calls.some(args => normalizePath(String(args[0])) === normalizePath(target))).toBe(false);
    } finally { vi.mocked(lstatSync).mockImplementation(realStat); vi.mocked(readlinkSync).mockImplementation(realRead); }
  });
  it.each(["first", "middle"] as const)("U1 review records readlink ENOENT at the %s proven link as error", location => {
    const f = aliasChainFixture("readlink-error"), target = f[location];
    const realRead = vi.mocked(readlinkSync).getMockImplementation()!;
    const error = Object.assign(new Error("Link read unavailable"), { code: "ENOENT", path: target });
    vi.mocked(readlinkSync).mockImplementation((path, options) => {
      if (normalizePath(String(path)) === normalizePath(target)) throw error;
      return realRead(path, options);
    });
    try {
      const entry = tree(f.scan(), f.source);
      if (entry.links.state !== "ok") throw new Error("Links unavailable");
      expect(entry.links.value.entries[0]).toMatchObject({ target: f.first,
        targetChain: location === "first" ? [f.first] : [f.first, f.middle],
        targetIdentity: unknown(`Link target identity unavailable: ${String(error)}`),
        targetHops: [...(location === "first" ? [] : [{ path: f.first, outcome: "link", code: null }]),
          { path: target, outcome: "error", code: "ENOENT" }], targetChainCycle: false, targetChainHopLimit: false });
    } finally { vi.mocked(readlinkSync).mockImplementation(realRead); }
  });
  it("U1 review records a linked ancestor as error without inspecting the target", () => {
    const f = fixture(), source = f.add("linked-ancestor"), parent = join(f.directory, "linked-parent");
    symlinkSync(f.primary, parent, "junction"); junctions.push(parent);
    const target = join(parent, "tracked.txt"); symlinkSync(target, join(source, "note.md"), "file");
    vi.mocked(lstatSync).mockClear();
    const entry = tree(f.scan(), source), reason = "Error: Worktree path has a link or non-directory ancestor";
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    expect(entry.links.value.entries[0]).toMatchObject({ target, targetChain: [target],
      targetIdentity: unknown(`Link target identity unavailable: ${reason}`),
      targetHops: [{ path: target, outcome: "error", code: reason }], targetChainCycle: false, targetChainHopLimit: false });
    expect(vi.mocked(lstatSync).mock.calls.some(args => normalizePath(String(args[0])) === normalizePath(target))).toBe(false);
  });
  it("U1 review records an unsupported intermediate entry as error", () => {
    const f = aliasChainFixture("unsupported-hop"), realStat = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (normalizePath(String(path)) === normalizePath(f.middle)) return {
        isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false,
      };
      return realStat(path, options);
    }) as typeof lstatSync);
    try {
      const entry = tree(f.scan(), f.source), reason = "Error: Unsupported link target entry";
      if (entry.links.state !== "ok") throw new Error("Links unavailable");
      expect(entry.links.value.entries[0]).toMatchObject({ target: f.first, targetChain: [f.first, f.middle],
        targetIdentity: unknown(`Link target identity unavailable: ${reason}`),
        targetHops: [{ path: f.first, outcome: "link", code: null }, { path: f.middle, outcome: "error", code: reason }],
        targetChainCycle: false, targetChainHopLimit: false });
    } finally { vi.mocked(lstatSync).mockImplementation(realStat); }
  });
  it.each(["EACCES", "ENOENT", "ENOTDIR"])("U1 review records intermediate lstat %s without an error path as error", code => {
    const f = aliasChainFixture("intermediate-error"), realStat = vi.mocked(lstatSync).getMockImplementation()!;
    const error = Object.assign(new Error("Intermediate hop unavailable"), { code });
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (normalizePath(String(path)) === normalizePath(f.middle)) throw error;
      return realStat(path, options);
    }) as typeof lstatSync);
    try {
      const entry = tree(f.scan(), f.source);
      if (entry.links.state !== "ok") throw new Error("Links unavailable");
      expect(entry.links.value.entries[0]).toMatchObject({ target: f.first, targetChain: [f.first, f.middle],
        targetIdentity: unknown(`Link target identity unavailable: ${String(error)}`),
        targetHops: [{ path: f.first, outcome: "link", code: null }, { path: f.middle, outcome: "error", code }],
        targetChainCycle: false, targetChainHopLimit: false });
    } finally { vi.mocked(lstatSync).mockImplementation(realStat); }
  });
  it.skipIf(process.platform !== "win32")("U1-T1 records a live junction directory without changing legacy evidence", async () => {
    const f = fixture(), source = f.add("live-hop"), target = join(f.directory, "target"); mkdirSync(target);
    writeFileSync(join(target, ".package-lock.json"), JSON.stringify({ packages: {} }));
    const path = join(source, "node_modules"); symlinkSync(target, path, "junction"); junctions.push(path);
    const result = f.scan(), entry = tree(result, source);
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    const link = entry.links.value.entries[0];
    expect(link).toMatchObject({ path, relativePath: "node_modules", kind: "junction", target, targetChain: [target], targetIdentity: ok(target) });
    expect(isAdmissibleTopLevelNodeModulesJunction(link)).toBe(true);
    expect((await classify(result))(source).disposition).toBe("remove");
    expect(link).toMatchObject({ targetHops: [{ path: target, outcome: "directory", code: null }], targetChainCycle: false, targetChainHopLimit: false });
  });
  it("U1-T1 records link and file outcomes for a live alias chain", () => {
    const f = fixture(), source = f.add("file-hops"), target = join(f.primary, "tracked.txt"), middle = join(f.directory, "alias.md");
    symlinkSync(target, middle, "file"); symlinkSync(middle, join(source, "note.md"), "file");
    const entry = tree(f.scan(), source);
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    expect(entry.holdReasons).toContain("links");
    expect(entry.links.value.entries[0]).toMatchObject({ kind: "symlink", target: middle, targetChain: [middle, target], targetIdentity: ok(target),
      targetHops: [{ path: middle, outcome: "link", code: null }, { path: target, outcome: "file", code: null }],
      targetChainCycle: false, targetChainHopLimit: false });
  });
  it.skipIf(process.platform !== "win32")("U1-T2 records link then missing for a dangling two-hop junction", async () => {
    const f = fixture(), source = f.add("missing-hop"), target = join(f.directory, "absent"), middle = join(f.directory, "middle");
    const path = join(source, "node_modules");
    symlinkSync(target, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, path, "junction"); junctions.push(path);
    const result = f.scan(), entry = tree(result, source);
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    const link = entry.links.value.entries[0];
    expect(link).toMatchObject({ kind: "junction", target: middle, targetChain: [middle, target], targetIdentity: { state: "unknown", reason: expect.stringContaining("ENOENT") } });
    expect(isAdmissibleTopLevelNodeModulesJunction(link)).toBe(true);
    expect((await classify(result))(source)).toMatchObject({ disposition: "remove" });
    expect(link).toMatchObject({ targetHops: [{ path: middle, outcome: "link", code: null }, { path: target, outcome: "missing", code: "ENOENT" }],
      targetChainCycle: false, targetChainHopLimit: false });
  });
  it.skipIf(process.platform !== "win32")("U1-T3 records the final hop as missing when its parent is absent", () => {
    const f = fixture(), source = f.add("missing-parent"), parent = join(f.directory, "absent-parent"), target = join(parent, "node_modules");
    const middle = join(f.directory, "middle"), path = join(source, "node_modules");
    symlinkSync(target, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, path, "junction"); junctions.push(path);
    vi.mocked(lstatSync).mockClear();
    const entry = tree(f.scan(), source);
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    expect(entry.holdReasons).not.toContain("links");
    expect(entry.links.value.entries[0]).toMatchObject({ kind: "junction", target: middle, targetChain: [middle, target],
      targetIdentity: { state: "unknown", reason: expect.stringContaining(parent) },
      targetHops: [{ path: middle, outcome: "link", code: null }, { path: target, outcome: "missing", code: "ENOENT" }],
      targetChainCycle: false, targetChainHopLimit: false });
    expect(vi.mocked(lstatSync).mock.calls.some(args => normalizePath(String(args[0])) === normalizePath(target))).toBe(false);
  });
  it.skipIf(process.platform !== "win32")("U1-T3 records ancestor ENOTDIR as missing for the final hop", () => {
    const f = fixture(), source = f.add("notdir-parent"), parent = join(f.directory, "parent"); mkdirSync(parent);
    const target = join(parent, "node_modules"), middle = join(f.directory, "middle"), path = join(source, "node_modules");
    symlinkSync(target, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, path, "junction"); junctions.push(path);
    const realStat = vi.mocked(lstatSync).getMockImplementation()!, error = Object.assign(new Error("Ancestor unavailable"), { code: "ENOTDIR", path: parent });
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (normalizePath(String(path)) === normalizePath(parent)) throw error;
      return realStat(path, options);
    }) as typeof lstatSync);
    try {
      const entry = tree(f.scan(), source);
      if (entry.links.state !== "ok") throw new Error("Links unavailable");
      expect(entry.holdReasons).not.toContain("links");
      expect(entry.links.value.entries[0]).toMatchObject({ targetChain: [middle, target],
        targetIdentity: unknown(`Link target identity unavailable: ${String(error)}`),
        targetHops: [{ path: middle, outcome: "link", code: null }, { path: target, outcome: "missing", code: "ENOTDIR" }],
        targetChainCycle: false, targetChainHopLimit: false });
    } finally { vi.mocked(lstatSync).mockImplementation(realStat); }
  });
  it.skipIf(process.platform !== "win32").each(["EACCES", "EPERM", "EBUSY", "ELOOP"])("U1-T4 records a later-hop %s error without changing its legacy reason", code => {
    const f = fixture(), source = f.add("error-hop"), target = join(f.directory, "target"); mkdirSync(target);
    const middle = join(f.directory, "middle"), path = join(source, "node_modules");
    symlinkSync(target, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, path, "junction"); junctions.push(path);
    const realStat = vi.mocked(lstatSync).getMockImplementation()!, error = Object.assign(new Error("Hop unavailable"), { code });
    vi.mocked(lstatSync).mockImplementation(((path, options) => {
      if (normalizePath(String(path)) === normalizePath(target)) throw error;
      return realStat(path, options);
    }) as typeof lstatSync);
    try {
      const entry = tree(f.scan(), source);
      if (entry.links.state !== "ok") throw new Error("Links unavailable");
      expect(entry.holdReasons).toContain("links");
      expect(entry.links.value.entries[0]).toMatchObject({ kind: "junction", target: middle, targetChain: [middle, target],
        targetIdentity: unknown(`Link target identity unavailable: ${String(error)}`),
        targetHops: [{ path: middle, outcome: "link", code: null }, { path: target, outcome: "error", code }],
        targetChainCycle: false, targetChainHopLimit: false });
    } finally { vi.mocked(lstatSync).mockImplementation(realStat); }
  });
  it.skipIf(process.platform !== "win32")("U1-T5 flags a junction cycle while preserving its chain and message", () => {
    const f = fixture(), source = f.add("cycle-evidence"), path = join(source, "node_modules"), middle = join(f.directory, "middle");
    symlinkSync(path, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, path, "junction"); junctions.push(path);
    const entry = tree(f.scan(), source);
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    expect(entry.holdReasons).toContain("links");
    expect(entry.links.value.entries[0]).toMatchObject({ target: middle, targetChain: [middle, path],
      targetIdentity: unknown("Link target identity unavailable: Error: Link chain cycle"),
      targetHops: [{ path: middle, outcome: "link", code: null }, { path, outcome: "error", code: "Error: Link chain cycle" }],
      targetChainCycle: true, targetChainHopLimit: false });
  });
  it.skipIf(process.platform !== "win32")("U1-T5 flags the hop cap while preserving visited link outcomes and the message", () => {
    const f = fixture(), source = f.add("capped-evidence"), target = join(f.directory, "target"); mkdirSync(target);
    const hops = Array.from({ length: 8 }, (_, index) => join(f.directory, `hop-${index}`));
    for (let index = hops.length - 1; index >= 0; index--) {
      symlinkSync(hops[index + 1] ?? target, hops[index], "junction"); junctions.push(hops[index]);
    }
    const path = join(source, "node_modules"); symlinkSync(hops[0], path, "junction"); junctions.push(path);
    const entry = tree(f.scan(), source);
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    expect(entry.holdReasons).toContain("links");
    expect(entry.links.value.entries[0]).toMatchObject({ target: hops[0], targetChain: hops,
      targetIdentity: unknown("Link target identity unavailable: Error: Link chain exceeds 8 hops"),
      targetHops: hops.map(path => ({ path, outcome: "link", code: null })), targetChainCycle: false, targetChainHopLimit: true });
  });
});

// Each case builds real repositories and worktrees; on Windows that routinely exceeds vitest's 5 s default.
describe("read-only real repository inventory", { timeout: 30_000 }, () => {
  it.each(["missing", "no-hops", "empty-hops", "live-hop", "error", "cycle", "limit"])("dangling admission requires fresh complete hop evidence (%s)", condition => {
    const target = resolve("missing-target"), path = resolve("source/node_modules");
    const link: NonNullable<Parameters<typeof isAdmissibleTopLevelNodeModulesJunction>[0]> = {
      path, relativePath: "node_modules", kind: "junction", target, targetChain: [target], targetIdentity: unknown("unresolved"),
      targetHops: condition === "no-hops" ? undefined : condition === "empty-hops" ? [] : [
        { path: target, outcome: condition === "live-hop" ? "directory" : condition === "error" ? "error" : "missing", code: "reason, not a decision" },
      ], targetChainCycle: condition === "cycle", targetChainHopLimit: condition === "limit" };
    expect(isAdmissibleTopLevelNodeModulesJunction(link)).toBe(condition === "missing");
  });
  it.skipIf(process.platform !== "win32")("dangling U2-T1 admits the bt-r1A chain without a target snapshot or own inbound hold", async () => {
    const f = fixture(), source = f.add("dangling"), removed = join(f.directory, "removed");
    const target = join(removed, "node_modules"), middle = join(f.directory, "middle"), link = join(source, "node_modules");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, link, "junction"); junctions.push(link);
    rmdirSync(target); rmdirSync(removed);
    const result = f.scan(), entry = tree(result, source);
    expect((await classify(result))(source)).toMatchObject({ disposition: "remove" });
    expect(entry).toMatchObject({ inboundLinks: { state: "negative" }, targetBaseline: null, links: { state: "ok", value: {
      forbidden: [], nodeModulesTarget: null, nodeModulesTargetEvidence: null,
      entries: [expect.objectContaining({ danglingJunction: true, targetChain: [middle, target] })],
    } } });
  });
  it.skipIf(process.platform !== "win32")("dangling U2-T3 keeps an empty live primary target held", async () => {
    const f = fixture(), source = f.add("empty-target"), target = join(f.primary, "node_modules"), link = join(source, "node_modules");
    mkdirSync(target); symlinkSync(target, link, "junction"); junctions.push(link);
    expect((await classify(f.scan()))(source)).toMatchObject({ disposition: "hold", reason: "links" });
    expect(lstatSync(target).isDirectory()).toBe(true);
  });
  it.skipIf(process.platform !== "win32").each(["EACCES", "EPERM"])("dangling U2-T4 holds a %s hop", async code => {
    const f = fixture(), source = f.add("unreadable-hop"), target = join(f.directory, "target"), middle = join(f.directory, "middle");
    mkdirSync(target); symlinkSync(target, middle, "junction"); junctions.push(middle);
    const link = join(source, "node_modules"); symlinkSync(middle, link, "junction"); junctions.push(link);
    rmdirSync(target);
    const realStat = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation((...args) => {
      if (String(args[0]) === target) throw Object.assign(new Error("denied"), { code, path: target });
      return realStat(...args);
    });
    try {
      const result = f.scan();
      expect((await classify(result))(source)).toMatchObject({ disposition: "hold", reason: "links" });
      expect(tree(result, source).links).toMatchObject({ value: { entries: [expect.objectContaining({
        targetHops: [expect.objectContaining({ outcome: "link" }), { path: target, outcome: "error", code }],
      })] } });
    } finally { vi.mocked(lstatSync).mockImplementation(realStat); }
  });
  it.skipIf(process.platform !== "win32")("dangling U2-T6 holds a symlink-kind top-level entry", async () => {
    const f = fixture(), source = f.add("symlink-missing"), target = join(f.directory, "target"), link = join(source, "node_modules");
    mkdirSync(target); symlinkSync(target, link, "dir"); junctions.push(link); rmdirSync(target);
    const result = f.scan();
    expect((await classify(result))(source)).toMatchObject({ disposition: "hold", reason: "links" });
    expect(tree(result, source).links).toMatchObject({ value: { entries: [expect.objectContaining({ kind: "symlink" })] } });
  });
  it.skipIf(process.platform !== "win32")("dangling U2-T7 preserves inbound protection for the tree containing a recorded missing hop", async () => {
    const f = fixture(), source = f.add("source"), protectedTree = f.add("protected");
    const target = join(protectedTree, "node_modules"), middle = join(f.directory, "middle"), link = join(source, "node_modules");
    mkdirSync(target); symlinkSync(target, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, link, "junction"); junctions.push(link); rmdirSync(target);
    const result = f.scan(), decision = await classify(result);
    expect(decision(source)).toMatchObject({ disposition: "remove" });
    expect(decision(protectedTree)).toMatchObject({ disposition: "hold", reason: "shared" });
    expect(tree(result, protectedTree).inboundLinks.state).toBe("unknown");
  });
  it("proves clean registered identity, empty links and does not mutate any file", () => {
    const f = fixture(), path = f.add("clean");
    const before = snapshot(f.directory), result = f.scan(), entry = tree(result, path);
    expect(entry.identity.state).toBe("ok");
    expect(entry.status).toMatchObject({ state: "ok", value: { clean: true, entries: [] } });
    expect(entry.links).toMatchObject({ state: "ok", value: { entries: [], forbidden: [] } });
    expect(entry.inboundLinks.state).toBe("negative");
    expect(entry.holdReasons).toEqual([]);
    expect(snapshot(f.directory)).toEqual(before);
  });
  it("holds a half-removed nested tree despite Git falling back to a clean parent", () => {
    const f = fixture(), path = f.add("broken", join(f.primary, ".worktrees", "broken"));
    unlinkSync(join(path, ".git"));
    expect(execFileSync("git", ["--no-optional-locks", "-C", path, "status", "--porcelain=v1", "-z"], { encoding: "utf8" })).toBe("");
    const entry = tree(f.scan(), path);
    expect(entry.identity.state).toBe("unknown"); expect(entry.status.state).toBe("unknown"); expect(entry.holdReasons).toContain("identity");
  });
  it("does not trust a different repository's .git or a missing registered path", () => {
    const f = fixture(), path = f.add("wrong"), other = fixture();
    unlinkSync(join(path, ".git"));
    writeFileSync(join(path, ".git"), "gitdir: " + join(other.primary, ".git") + "\n");
    expect(tree(f.scan(), path).identity.state).toBe("unknown");
    // This path was created inside this fixture's verified temporary root.
    if (!isWithin(path, f.directory)) throw new Error("Unsafe fixture path");
    rmSync(path, { recursive: true });
    expect(tree(f.scan(), path).identity.state).toBe("unknown");
  });
  it("makes a failed git status unknown even with empty stdout", () => {
    const f = fixture(), path = f.add("status-failure");
    const result = inventory({ repositoryPath: f.primary, runnerPath: f.directory, runProbe: (executable, args, options) =>
      args.includes("status") ? probe(process.execPath, ["-e", "process.exit(3)"]) : probe(executable, args, options) });
    expect(tree(result, path).identity.state).toBe("ok"); expect(tree(result, path).status.state).toBe("unknown");
  });
  it("holds malformed status and does not run a configured filesystem monitor", () => {
    const f = fixture(), path = f.add("malformed");
    f.git("config", "core.fsmonitor", join(f.directory, "missing-monitor"));
    expect(tree(f.scan(), path).status.state).toBe("ok");
    const result = inventory({ repositoryPath: f.primary, runnerPath: f.directory, runProbe: (executable, args, options) =>
      args.includes("status") ? probe(process.execPath, ["-e", "process.stdout.write(' M truncated')"], options) : probe(executable, args, options) });
    expect(tree(result, path).status.state).toBe("unknown");
    expect(tree(result, path).ignored.state).toBe("unknown");
  });
  it("confines a failed deep scan to its own tree", () => {
    const f = fixture(), path = f.add("scan-failure");
    mkdirSync(join(path, "node_modules"));
    writeFileSync(join(path, "node_modules", ".package-lock.json"), "{");
    const result = f.scan();
    const entry = tree(result, path);
    expect(entry.status.state).toBe("ok");
    for (const fact of [entry.links, entry.containment, entry.inboundLinks]) expect(fact.state).toBe("unknown");
    expect(tree(result, f.primary).links.state).toBe("ok");
    expect(tree(result, f.primary).inboundLinks.state).toBe("negative");
  });
  it.skipIf(process.platform !== "win32").each(['cache', 'z-link', 'node_modules/pkg/link', 'node_modules/.vite/link'])("preserves inbound links at %s while walking lockless node_modules", name => {
    const f = fixture(), source = f.add("source"), target = f.add("target"), link = join(source, name);
    mkdirSync(join(source, 'node_modules/pkg'), { recursive: true });
    mkdirSync(join(source, 'node_modules/.vite'));
    symlinkSync(target, link, "junction"); junctions.push(link);
    // The full walk, including Vite caches, supplies the link evidence.
    const result = f.scan();
    expect(tree(result, source).links).toMatchObject({ state: "ok", value: { entries: [expect.objectContaining({ path: link, target })] } });
    expect(tree(result, target).inboundLinks).toMatchObject({ state: "ok", value: [expect.objectContaining({ path: link, target })] });
    if (result.state !== "ok") throw new Error("Inventory failed");
    expect(result.value.incompleteScans).toEqual([]);
  });
  it.skipIf(process.platform !== 'win32')('records an unreadable directory but keeps scanning readable sibling directories', () => {
    const f = fixture(), source = f.add('source'), target = f.add('target');
    const denied = join(source, 'z-denied'), readable = join(source, 'a-readable'), link = join(readable, 'z-link');
    mkdirSync(denied); mkdirSync(readable);
    symlinkSync(target, link, 'junction'); junctions.push(link);
    const realRead = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation((...args) => {
      if (String(args[0]) === denied) throw new Error('EACCES fixture');
      return realRead(...args);
    });
    try {
      const result = f.scan();
      expect(tree(result, source).links).toMatchObject({ state: 'unknown', reason: expect.stringContaining(denied) });
      expect(tree(result, target).inboundLinks).toMatchObject({ state: 'ok', value: [expect.objectContaining({ path: link, target })] });
      if (result.state !== 'ok') throw new Error('Inventory failed');
      expect(result.value.incompleteScans).toEqual([expect.objectContaining({ path: source.replaceAll('\\', '/') })]);
    } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
  });
  it.skipIf(process.platform !== "win32")("scans paths over 260 characters with Node", () => {
    const f = fixture(), path = f.add("long-path");
    const deep = join(path, ".next", ...Array<string>(8).fill("long-roadmap-artifact-segment"));
    mkdirSync(deep, { recursive: true });
    const file = join(deep, "artifact.json");
    expect(file.length).toBeGreaterThan(260);
    writeFileSync(file, "{}");
    expect(tree(f.scan(), path).links.state).toBe("ok");
  }, 15_000);
  it("U3-T5 walks nested node_modules without a lockfile and holds a link to a tracked file", () => {
    const f = fixture(), path = f.add("nested-modules"), modules = join(path, ".next", "node_modules");
    mkdirSync(modules, { recursive: true });
    expect(tree(f.scan(), path).links).toMatchObject({ state: "ok", value: { entries: [] } });
    symlinkSync(join(path, "tracked.txt"), join(modules, "note.md"), "file");
    const entry = tree(f.scan(), path);
    expect(entry.links).toMatchObject({ state: "ok", value: { forbidden: [".next/node_modules/note.md"] } });
    expect(entry.holdReasons).toContain("links");
  }, 15_000);
  it.skipIf(process.platform !== "win32")("keeps top-level junction inbound evidence when its source deep scan fails", () => {
    const f = fixture(), target = f.add("fallback-target"), link = join(f.primary, "node_modules");
    symlinkSync(target, link, "junction"); junctions.push(link);
    const realRead = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation((...args) => {
      if (normalizePath(String(args[0])) === normalizePath(f.primary)) throw new Error("Injected deep scan failure");
      return realRead(...args);
    });
    let result;
    try { result = f.scan(); } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
    expect(tree(result, f.primary).links).toMatchObject({ state: "unknown", reason: expect.stringContaining("Injected deep scan failure") });
    expect(tree(result, target).inboundLinks).toMatchObject({ state: "ok", value: [expect.objectContaining({ path: link, target })] });
  }, 15_000);
  it.skipIf(process.platform !== "win32")("marks both targets of a two-hop junction chain inbound", async () => {
    const f = fixture(), a = f.add("chain-source"), b = f.add("chain-middle"), c = f.add("chain-target");
    const target = join(c, "node_modules"); mkdirSync(target);
    writeFileSync(join(target, ".package-lock.json"), JSON.stringify({ packages: {} }));
    const middle = join(b, "node_modules"), source = join(a, "node_modules");
    symlinkSync(target, middle, "junction"); junctions.push(middle);
    symlinkSync(middle, source, "junction"); junctions.push(source);
    const result = f.scan();
    for (const path of [b, c]) expect(tree(result, path).inboundLinks).toMatchObject({
      state: "ok", value: expect.arrayContaining([expect.objectContaining({ sourceTree: a.replaceAll("\\", "/") })]),
    });
    expect(tree(result, a).links).toMatchObject({ state: "ok", value: { forbidden: ["node_modules"], entries: [expect.objectContaining({ targetIdentity: expect.objectContaining({ state: "ok", value: target }) })] } });
    const decision = await classify(result);
    expect(decision(a)).toMatchObject({ disposition: "hold", reason: "links", evidence: { value: {
      nodeModulesTarget: null, entries: [expect.objectContaining({ targetChain: [middle, target], manualRelease: "unlink this tree's node_modules junction" })],
    } } });
    for (const path of [b, c]) expect(decision(path)).toMatchObject({ disposition: "hold", reason: "shared" });
    expect(tree(result, f.primary).inboundLinks.state).toBe("negative");
    rmdirSync(source); junctions.splice(junctions.indexOf(source), 1);
    const released = (await classify(f.scan()))(a);
    expect(released).toMatchObject({ disposition: "remove" });
    expect(released.reason).not.toBe("links");
  }, 20_000);
  it("confines a link cycle's unknown results to the involved trees", async () => {
    const f = fixture(), a = f.add("cycle-a"), b = f.add("cycle-b");
    const first = join(a, "node_modules"), second = join(b, "node_modules");
    const kind = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(second, first, kind); symlinkSync(first, second, kind);
    if (process.platform === "win32") junctions.push(first, second);
    const result = f.scan();
    for (const path of [a, b]) {
      const entry = tree(result, path);
      expect(entry.inboundLinks).toMatchObject({ state: "unknown", reason: expect.stringMatching(/cycle/i) });
      expect(entry.holdReasons).toContain("inbound-links");
      expect(entry.holdReasons).toContain("links");
    }
    const decision = await classify(result);
    expect(decision(a)).toMatchObject({ disposition: "hold", reason: "links", evidence: { value: {
      entries: [expect.objectContaining({ targetChain: [second, first], targetIdentity: expect.objectContaining({ state: "unknown", reason: expect.stringMatching(/cycle/i) }) })],
    } } });
    if (process.platform === "win32") expect(JSON.stringify(decision(a).evidence)).toContain("unlink this tree's node_modules junction");
    expect(tree(result, f.primary).inboundLinks.state).toBe("negative");
  }, 20_000);
  it.skipIf(process.platform !== "win32").each(["real", "one-hop", "two-hop", "unknown"])("classification and junction admissibility agree for %s node_modules", async kind => {
    const f = fixture(), source = f.add("parity"), modules = join(source, "node_modules"), target = join(f.directory, "target");
    if (kind === "real") {
      mkdirSync(modules); writeFileSync(join(modules, ".package-lock.json"), '{"packages":{}}');
    } else {
      if (kind !== "unknown") { mkdirSync(target); writeFileSync(join(target, ".package-lock.json"), '{"packages":{}}'); }
      const middle = join(f.directory, "middle");
      if (kind === "two-hop") { symlinkSync(target, middle, "junction"); junctions.push(middle); }
      symlinkSync(kind === "two-hop" ? middle : target, modules, "junction"); junctions.push(modules);
    }
    const result = f.scan(), entry = tree(result, source);
    if (entry.links.state !== "ok") throw new Error("Links unavailable");
    const link = entry.links.value.entries.find(link => link.relativePath === "node_modules");
    expect(isAdmissibleTopLevelNodeModulesJunction(link)).toBe(kind === "one-hop" || kind === "unknown");
    // Real directories have no link requiring the junction exemption.
    const admissible = entry.links.value.entries.every(isAdmissibleTopLevelNodeModulesJunction);
    const decision = (await classify(result))(source);
    expect(decision.disposition === "remove").toBe(admissible);
    if (!admissible) {
      expect(decision).toMatchObject({ disposition: "hold", reason: "links" });
      expect(entry.links.value.nodeModulesTarget).toBeNull();
    }
    if (kind === "unknown") expect(link?.targetIdentity).toMatchObject({ state: "unknown" });
  });
  it.skipIf(process.platform !== "win32")("names the visited hops and hop cap when a junction chain is too long", async () => {
    const f = fixture(), source = f.add("capped"), target = join(f.directory, "target"); mkdirSync(target);
    const hops = Array.from({ length: 8 }, (_, index) => join(f.directory, `hop-${index}`));
    for (let index = hops.length - 1; index >= 0; index--) {
      symlinkSync(hops[index + 1] ?? target, hops[index], "junction"); junctions.push(hops[index]);
    }
    const modules = join(source, "node_modules"); symlinkSync(hops[0], modules, "junction"); junctions.push(modules);
    const decision = (await classify(f.scan()))(source);
    expect(decision).toMatchObject({ disposition: "hold", reason: "links", evidence: { value: {
      entries: [expect.objectContaining({ targetChain: hops, targetIdentity: expect.objectContaining({ state: "unknown", reason: expect.stringContaining("exceeds 8 hops") }),
        manualRelease: "unlink this tree's node_modules junction" })],
    } } });
  });
  it.skipIf(process.platform !== "win32")("snapshots a shared admissible junction target once per inventory", () => {
    const f = fixture(), a = f.add("snapshot-a"), b = f.add("snapshot-b"), target = join(f.directory, "target"); mkdirSync(target);
    const lock = '{"packages":{}}'; writeFileSync(join(target, ".package-lock.json"), lock);
    mkdirSync(join(target, "package")); writeFileSync(join(target, "package", "index.js"), "safe");
    for (const source of [a, b]) { const link = join(source, "node_modules"); symlinkSync(target, link, "junction"); junctions.push(link); }
    vi.mocked(readdirSync).mockClear();
    const result = f.scan();
    expect(vi.mocked(readdirSync).mock.calls.filter(args => normalizePath(String(args[0])) === normalizePath(target))).toHaveLength(1);
    expect(vi.mocked(readdirSync).mock.calls.filter(args => normalizePath(String(args[0])) === normalizePath(join(target, "package")))).toHaveLength(1);
    for (const source of [a, b]) expect(tree(result, source)).toMatchObject({
      targetBaseline: { state: "ok", value: { count: 3, topLevelCount: 2, lockHash: createHash("sha256").update(lock).digest("hex") } },
      links: { state: "ok", value: {
        nodeModulesTargetEvidence: { state: "ok", value: { topLevelCount: 2, lockHash: createHash("sha256").update(lock).digest("hex") } },
      } },
    });
  });
  it.skipIf(process.platform !== "win32")("candidatePath inventory reads cheap target evidence without a full walk", () => {
    const f = fixture(), source = f.add("cheap-recheck"), target = join(f.directory, "target");
    mkdirSync(join(target, "package"), { recursive: true });
    const lock = '{"packages":{}}'; writeFileSync(join(target, ".package-lock.json"), lock);
    writeFileSync(join(target, "package", "index.js"), "safe");
    const link = join(source, "node_modules"); symlinkSync(target, link, "junction"); junctions.push(link);
    const baseline = f.scan();
    vi.mocked(readdirSync).mockClear();
    const result = inventory({ repositoryPath: f.primary, runnerPath: f.primary, candidatePath: source });
    expect(tree(result, source)).not.toHaveProperty("targetBaseline");
    expect(tree(result, source).links).toEqual(tree(baseline, source).links);
    expect(tree(result, source).links).not.toHaveProperty("value.nodeModulesTargetSnapshot");
    expect(tree(result, source).links).toMatchObject({ state: "ok", value: {
      nodeModulesTargetEvidence: { state: "ok", value: { topLevelCount: 2, lockHash: createHash("sha256").update(lock).digest("hex") } },
    } });
    expect(vi.mocked(readdirSync).mock.calls.filter(args => normalizePath(String(args[0])) === normalizePath(target))).toHaveLength(1);
    expect(vi.mocked(readdirSync).mock.calls.map(args => resolve(String(args[0])))).not.toContain(join(target, "package"));
  });
  it.skipIf(process.platform !== "win32")("holds candidate reclassification when the target directory becomes unreadable", async () => {
    const f = fixture(), source = f.add("unreadable-recheck"), target = join(f.directory, "target");
    mkdirSync(target); writeFileSync(join(target, ".package-lock.json"), '{"packages":{}}');
    const link = join(source, "node_modules"); symlinkSync(target, link, "junction"); junctions.push(link);
    const baseline = f.scan();
    expect((await classify(baseline))(source)).toMatchObject({ disposition: "remove" });
    if (baseline.state !== "ok") throw new Error("Inventory failed");
    const realRead = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation((...args) => {
      if (normalizePath(String(args[0])) === normalizePath(target)) throw new Error("EACCES target fixture");
      return realRead(...args);
    });
    try {
      const fresh = candidateInventory(source, baseline.value);
      expect(tree(fresh, source).links).toMatchObject({ state: "ok", value: {
        nodeModulesTarget: target, nodeModulesTargetEvidence: { state: "unknown", reason: expect.stringContaining("EACCES target fixture") },
      } });
      expect((await classify(fresh))(source)).toMatchObject({ disposition: "hold", reason: "links" });
    } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
  });
  it("reads spaces, leading dashes, Unicode, staged renames and ignored allowlist", () => {
    const f = fixture(), path = f.add("names");
    for (const name of ["with space.md", "-leading.md", "é.md", "next-env.d.ts"]) writeFileSync(join(path, name), "content");
    execFileSync("git", ["-C", path, "mv", "tracked.txt", "renamed é.txt"]);
    mkdirSync(join(path, "private")); writeFileSync(join(path, "private", "notes.txt"), "private");
    const entry = tree(f.scan(), path);
    expect(entry.status).toMatchObject({ state: "ok", value: { clean: false, entries: expect.arrayContaining([
      { index: "R", worktree: " ", path: "renamed é.txt", originalPath: "tracked.txt" },
      { index: "?", worktree: "?", path: "-leading.md" }, { index: "?", worktree: "?", path: "with space.md" }, { index: "?", worktree: "?", path: "é.md" },
    ]) } });
    expect(entry.ignored).toMatchObject({ state: "ok", value: { unexpected: ["private/"] } });
    expect(entry.holdReasons).toContain("ignored");
  });
  it("allows next-env.d.ts without treating ignored entries as dirty", () => {
    const f = fixture(), path = f.add("ignored"); writeFileSync(join(path, "next-env.d.ts"), "generated");
    const entry = tree(f.scan(), path);
    expect(entry.status).toMatchObject({ state: "ok", value: { clean: true } });
    expect(entry.ignored).toMatchObject({ state: "ok", value: { entries: ["next-env.d.ts"], unexpected: [] } });
    expect(entry.holdReasons).not.toContain("ignored");
  });
  it.each(["primary", "worktree"])("treats empty top-level node_modules in the %s as link-free", (kind) => {
    const f = fixture(), path = kind === "primary" ? f.primary : f.add("empty-dependencies");
    mkdirSync(join(path, "node_modules"));
    const entry = tree(f.scan(), path);
    expect(entry.links).toMatchObject({ state: "ok", value: { entries: [], forbidden: [] } });
    expect(entry.inboundLinks.state).toBe("negative");
    expect(entry.holdReasons).not.toContain("links");
  });
  it.each(["primary", "worktree"])("walks a lockless Vite cache in the %s and proves it link-free", kind => {
    const f = fixture(), path = kind === "primary" ? f.primary : f.add("vite-cache");
    const cache = join(path, "node_modules", ".vite");
    mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, "cache.js"), "cached");
    const result = f.scan(), entry = tree(result, path);
    expect(entry.links).toMatchObject({ state: "ok", value: { entries: [], forbidden: [] } });
    expect(entry.inboundLinks.state).toBe("negative");
    expect(vi.mocked(readdirSync).mock.calls.some(args => String(args[0]) === cache)).toBe(true);
    if (result.state !== "ok") throw new Error("Inventory failed");
    expect(result.value.incompleteScans).toEqual([]);
  });
  it("makes a lockless node_modules walk unknown when its existing timeout expires", () => {
    const f = fixture(), path = f.add("slow-cache"), cache = join(path, "node_modules", ".vite");
    mkdirSync(cache, { recursive: true }); writeFileSync(join(cache, "cache.js"), "cached");
    let clock = 0;
    const realRead = vi.mocked(readdirSync).getMockImplementation()!;
    const time = vi.spyOn(Date, "now").mockImplementation(() => clock);
    vi.mocked(readdirSync).mockImplementation((...args) => {
      const result = realRead(...args);
      if (String(args[0]) === cache) clock = 100;
      return result;
    });
    try {
      const result = inventory({ repositoryPath: f.primary, runnerPath: f.primary, walkTimeout: 100 });
      expect(tree(result, path).links).toMatchObject({ state: "unknown", reason: expect.stringContaining("Filesystem inventory timed out") });
      expect(clock).toBe(100);
    } finally { time.mockRestore(); vi.mocked(readdirSync).mockImplementation(realRead); }
  });
  it("does not walk real node_modules with 2,000 files and a link-free package lock", () => {
    const f = fixture(), path = f.add("large-dependencies"), modules = join(path, "node_modules");
    mkdirSync(modules);
    for (let index = 0; index < 2000; index++) writeFileSync(join(modules, `file-${index}.js`), "x");
    writeFileSync(join(modules, ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/example": { version: "1.0.0" } } }));
    // Sentinels make descent observable in the filesystem walk.
    mkdirSync(join(modules, "nested", ".git"), { recursive: true });
    const target = join(f.directory, "outside"), link = join(modules, "unlisted-link"); mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    if (process.platform === "win32") junctions.push(link);
    const entry = tree(f.scan(), path);
    expect(entry.links).toMatchObject({ state: "ok", value: { entries: [], forbidden: [] } });
    expect(entry.containment).toMatchObject({ state: "ok", value: { unregisteredRepositories: [] } });
    expect(entry.inboundLinks.state).toBe("negative");
    expect(entry.holdReasons).not.toContain("links");
  }, 20_000);
  it("holds a real node_modules when its package lock declares a link", () => {
    const f = fixture(), path = f.add("linked-package"), modules = join(path, "node_modules");
    mkdirSync(modules, { recursive: true });
    writeFileSync(join(modules, ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/local": { resolved: "../local", link: true } } }));
    const result = f.scan(), entry = tree(result, path);
    expect(entry.links).toMatchObject({ state: "ok", value: { forbidden: ["node_modules/local"] } });
    expect(entry.holdReasons).toContain("links");
    // A lockfile link alone does not prove its on-disk target identity.
    expect(entry.inboundLinks.state).toBe("unknown");
    expect(tree(result, f.primary).inboundLinks.state).toBe("negative");
  });
  it.each(["missing", "corrupt", "invalid-packages", "invalid-link", "non-file"])("walks only a missing package lock and keeps %s locks unknown while walking them", (condition) => {
    const f = fixture(), path = f.add("uncertain-dependencies"), modules = join(path, "node_modules");
    mkdirSync(modules);
    const lock = join(modules, ".package-lock.json");
    if (condition === "missing") writeFileSync(join(modules, "installed-package.js"), "walk this installed package");
    if (condition === "corrupt") writeFileSync(lock, "{");
    if (condition === "invalid-packages") writeFileSync(lock, JSON.stringify({ packages: [] }));
    if (condition === "invalid-link") writeFileSync(lock, JSON.stringify({ packages: { "node_modules/local": { link: "true" } } }));
    if (condition === "non-file") mkdirSync(lock);
    const unlisted = join(modules, "unlisted-entry");
    if (condition !== "missing") {
      if (process.platform === "win32") { symlinkSync(f.primary, unlisted, "junction"); junctions.push(unlisted); }
      else writeFileSync(unlisted, "must not be inspected");
    }
    const result = f.scan(), entry = tree(result, path);
    if (condition === "missing") {
      expect(entry.links).toMatchObject({ state: "ok", value: { entries: [], forbidden: [] } });
      expect(entry.holdReasons).not.toContain("links");
      if (result.state !== "ok") throw new Error("Inventory failed");
      expect(result.value.incompleteScans).toEqual([]);
    } else {
      expect(entry.links).toMatchObject({ state: "unknown", reason: expect.stringContaining("Package lock unavailable") });
      expect(entry.holdReasons).toContain("links");
      // A bad lock stays unknown but is still walked, so links inside it remain
      // inbound evidence for their targets.
      expect(vi.mocked(lstatSync).mock.calls.some(args => String(args[0]) === unlisted)).toBe(true);
    }
    if (condition !== "missing" && process.platform === "win32") {
      expect(tree(result, f.primary).inboundLinks).toMatchObject({ state: "ok", value: [expect.objectContaining({ path: unlisted })] });
    } else expect(tree(result, f.primary).inboundLinks.state).toBe("negative");
  });
  it.skipIf(process.platform !== "win32")("still records a node_modules junction to an empty target and requires its target lock evidence", () => {
    const f = fixture(), a = f.add("junction-source"), b = f.add("junction-target");
    const target = join(b, "node_modules"), link = join(a, "node_modules"); mkdirSync(target);
    symlinkSync(target, link, "junction"); junctions.push(link);
    const result = f.scan();
    expect(tree(result, a).links).toMatchObject({ state: "ok", value: {
      entries: [expect.objectContaining({ relativePath: "node_modules", kind: "junction", target, targetIdentity: expect.objectContaining({ state: "ok", value: target }) })],
      nodeModulesTarget: target, forbidden: [],
    } });
    expect(tree(result, a).links).toMatchObject({ value: { nodeModulesTargetEvidence: { state: "unknown" } } });
    expect(tree(result, a).targetBaseline).toMatchObject({ state: "unknown" });
    expect(tree(result, b).links).toMatchObject({ state: "ok", value: { entries: [], forbidden: [] } });
  });
  it("finds unregistered nested repositories and registered children without sibling-prefix mistakes", () => {
    const f = fixture(), path = f.add("bt-x"), sibling = f.add("bt-x2");
    const child = f.add("child", join(path, "registered"));
    const nested = join(path, "nested"); mkdirSync(nested); execFileSync("git", ["init", nested]);
    const result = f.scan(), entry = tree(result, path);
    expect(entry.containment).toMatchObject({ state: "ok", value: { children: [child.replaceAll("\\", "/")], unregisteredRepositories: [nested] } });
    expect(entry.holdReasons).toContain("containment");
    expect(tree(result, sibling).containment).toMatchObject({ state: "ok", value: { children: [], parents: [] } });
  });
  it("marks primary, runner, scheduled collectors and roadmap data exempt", () => {
    const f = fixture(), runner = f.add("runner"), collector = f.add("collector", join(f.primary, ".worktrees", ".roadmap-shadow-scheduled-test"));
    const data = f.add("data", join(f.primary, ".worktrees", "roadmap-data"));
    const result = f.scan(runner);
    for (const path of [f.primary, runner, collector, data]) expect(tree(result, path).exemption.state).toBe("ok");
  });
  it("holds symlinked markdown and nested directory links without following them", () => {
    const f = fixture(), path = f.add("links"), target = join(f.directory, "outside"); mkdirSync(target);
    writeFileSync(join(target, "secret.md"), "outside"); mkdirSync(join(target, ".git"));
    symlinkSync(join(target, "secret.md"), join(path, "note.md"), "file"); symlinkSync(target, join(path, "cache"), "dir");
    const entry = tree(f.scan(), path);
    expect(entry.links).toMatchObject({ state: "ok", value: { forbidden: expect.arrayContaining(["cache", "note.md"]) } });
    expect(entry.containment).toMatchObject({ state: "ok", value: { unregisteredRepositories: [] } });
    expect(entry.holdReasons).toContain("links");
  });
  it("resolves a file link target that is itself an alias", () => {
    const f = fixture(), a = f.add("alias-source"), b = f.add("alias-target");
    const alias = join(f.directory, "alias.md");
    symlinkSync(join(b, "tracked.txt"), alias, "file");
    symlinkSync(alias, join(a, "note.md"), "file");
    expect(tree(f.scan(), b).inboundLinks.state).toBe("ok");
  });
  it.skipIf(process.platform !== "win32")("maps junction targets and forbids nested junctions without visiting their contents", () => {
    const f = fixture(), a = f.add("source"), b = f.add("target");
    const target = join(b, "node_modules"); mkdirSync(target); mkdirSync(join(target, ".git"));
    writeFileSync(join(target, ".package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }));
    const top = join(a, "node_modules"), nested = join(a, "packages", "x", "cache"); mkdirSync(join(a, "packages", "x"), { recursive: true });
    for (const link of [top, nested]) { symlinkSync(target, link, "junction"); junctions.push(link); }
    const result = f.scan();
    expect(tree(result, a).links).toMatchObject({ state: "ok", value: { nodeModulesTarget: target, forbidden: ["packages/x/cache"] } });
    expect(tree(result, b).inboundLinks).toMatchObject({ state: "ok", value: expect.arrayContaining([expect.objectContaining({ sourceTree: a.replaceAll("\\", "/"), target })]) });
    expect(tree(result, a).containment).toMatchObject({ state: "ok", value: { unregisteredRepositories: [] } });
    expect(tree(result, b).holdReasons).toContain("inbound-links");
    expect(lstatSync(join(target, ".git")).isDirectory()).toBe(true);
  });
  it("prints inventory JSON through the CLI and rejects unimplemented commands", () => {
    const f = fixture();
    const cli = resolve("scripts/worktree-cleanup.mjs");
    // CLI smoke coverage must use fixture evidence, not scan the operator's
    // growing transcript history (which can outlive this test's timeout).
    const result = JSON.parse(execFileSync(process.execPath, [cli, "inventory", "--repo", f.primary], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, HOME: f.directory, USERPROFILE: f.directory },
    }));
    expect(result.state).toBe("ok"); expect(result.value.worktrees).toHaveLength(1);
    expect(() => execFileSync(process.execPath, [cli, "run"], { stdio: "pipe" })).toThrow(/not implemented/);
    expect(() => execFileSync(process.execPath, [cli, "inventory", "--timeout-ms", "0"], { stdio: "pipe" })).toThrow();
  });
});
describe("link-type probes stay off foreign-tree readers", () => {
  it.skipIf(process.platform !== "win32")("scanShallowLinks and a probe-less readLink spawn no PowerShell probe", () => {
    const root = mkdtempSync(join(tmpdir(), "wc-probe-")), tree = join(root, "tree"), target = join(root, "modules");
    mkdirSync(join(tree, ".next"), { recursive: true }); mkdirSync(target);
    const top = join(tree, "node_modules"), next = join(tree, ".next", "pkg");
    symlinkSync(target, top, "junction"); symlinkSync(target, next, "junction");
    try {
      const probeCalls = vi.fn<(executable: string, args: string[], options?: unknown) => void>();
      const runProbe: typeof probe = (executable, args, options) => {
        probeCalls(executable, args, options);
        return probe(executable, args, options);
      };
      const shallow = scanShallowLinks(tree, { runProbe });
      expect(shallow.state).toBe("ok");
      expect(readLink(tree, next)).not.toHaveProperty("linkType");
      expect(probeCalls).not.toHaveBeenCalled();
      expect(readLink(tree, next, "symlink", runProbe)).toMatchObject({ kind: "junction", linkType: "Junction", directoryLink: true });
      expect(probeCalls).toHaveBeenCalledTimes(1);
    } finally { unlinkSync(next); unlinkSync(top); rmSync(root, { recursive: true, force: true }); }
  });
});
