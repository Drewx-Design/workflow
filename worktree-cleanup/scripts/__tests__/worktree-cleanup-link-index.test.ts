import './worktree-cleanup-test-env';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inventory, normalizePath, scanTreeLinks } from '../lib/worktree-cleanup/inventory.mjs';
import * as linkInventory from '../lib/worktree-cleanup/inventory.mjs';
import { negative, ok, probe, unknown } from '../lib/worktree-cleanup/probe.mjs';
import { buildInboundLinks, existingCasePath, linkIndexPath, projectLinkIndex, readLinkIndex, writeLinkIndex } from '../lib/worktree-cleanup/link-index.mjs';
import { runCleanup } from '../worktree-cleanup.mjs';

vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync), readdirSync: vi.fn(fs.readdirSync),
    writeFileSync: vi.fn(fs.writeFileSync), renameSync: vi.fn(fs.renameSync) };
});
// Keep the coordinator test focused on index publication and report invariance.
vi.mock('../lib/worktree-cleanup/idle-journal.mjs', () => ({ appendIdleObservation: () => ({ state: 'ok', value: null }) }));

const roots: string[] = [], junctions: string[] = [];
const observedAt = Date.UTC(2026, 9, 5, 4);
afterEach(() => {
  vi.mocked(readFileSync).mockReset(); vi.mocked(readdirSync).mockReset();
  vi.mocked(writeFileSync).mockReset(); vi.mocked(renameSync).mockReset();
  for (const path of junctions.splice(0)) {
    if (process.platform === 'win32') rmdirSync(path); else unlinkSync(path);
  }
  for (const root of roots.splice(0)) {
    const path = resolve(root);
    if (!path.startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
    rmSync(path, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cleanup-link-index-')); roots.push(directory);
  const primary = join(directory, 'primary'); mkdirSync(primary);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: primary, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '--initial-branch=main'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture');
  writeFileSync(join(primary, 'tracked.txt'), 'original\n');
  git('add', '.'); git('-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture');
  const add = (name: string, path = join(directory, name)) => { git('worktree', 'add', '-b', name, path); return path; };
  const scan = (candidatePath?: string) => {
    const result = inventory({ repositoryPath: primary, runnerPath: join(directory, 'runner'), candidatePath });
    if (result.state !== 'ok') throw new Error('Fixture inventory unavailable: ' + JSON.stringify(result));
    return result.value;
  };
  const link = (source: string, target: string, name = 'nested/dependency') => {
    const path = join(source, name); mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, 'junction'); junctions.push(path); return path;
  };
  const common = join(primary, '.git'), root = join(directory, 'state');
  return { directory, primary, common, root, git, add, scan, link };
}
function entryFor(index: ReturnType<typeof projectLinkIndex>, path: string) {
  return Object.values(index.entries).find(entry => entry.path === normalizePath(path))!;
}

describe('primary index and registered subtree boundaries', () => {
  it('skips a nested registered root while walking an unregistered sibling, even when root itself is in skipRoots', () => {
    const f = fixture(), target = f.add('target'), nested = f.add('nested', join(f.primary, '.worktrees', 'nested'));
    f.link(nested, target);
    const outside = f.link(f.primary, target, '.worktrees/leftover/dependency');
    vi.mocked(readdirSync).mockClear();
    const links = scanTreeLinks(f.primary, { skipRoots: new Set([normalizePath(f.primary), normalizePath(nested)]) });
    expect(links).toMatchObject({ state: 'ok', value: [expect.objectContaining({ path: outside })] });
    expect(vi.mocked(readdirSync).mock.calls.some(([path]) => normalizePath(String(path)) === normalizePath(nested))).toBe(false);
  });

  it('projects a complete primary entry from a separate walk without changing the nightly snapshot', () => {
    const f = fixture(), target = f.add('target'), nested = f.add('nested', join(f.primary, '.worktrees', 'nested'));
    const nestedLink = f.link(nested, target), outside = f.link(f.primary, target, '.worktrees/leftover/dependency');
    const snapshot = f.scan(), before = structuredClone(snapshot);
    const index = projectLinkIndex(snapshot, observedAt);
    expect(index.entries[`${normalizePath(f.primary)}\0primary\0${normalizePath(f.common)}`]).toMatchObject({
      path: normalizePath(f.primary), complete: true, links: [expect.objectContaining({ path: outside })],
    });
    expect(entryFor(index, nested).links).toEqual([expect.objectContaining({ path: nestedLink })]);
    expect(snapshot).toEqual(before);
  });

  it('projects an incomplete primary entry without throwing or reusing its nightly links when its extra walk fails', () => {
    const f = fixture(), target = f.add('target'); f.link(f.primary, target, 'leftover/dependency');
    const snapshot = f.scan(), read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(f.primary)) throw new Error('Injected primary scan failure');
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    const index = projectLinkIndex(snapshot, observedAt);
    expect(entryFor(index, f.primary)).toMatchObject({ complete: false });
    expect(entryFor(index, f.primary)).not.toHaveProperty('links');
  });

  it('uses cached primary and nested entries with the correct source for each inbound link', () => {
    const f = fixture(), target = f.add('target'), nested = f.add('nested', join(f.primary, '.worktrees', 'nested'));
    const nestedLink = f.link(nested, target), outside = f.link(f.primary, target, '.worktrees/leftover/dependency');
    const index = projectLinkIndex(f.scan(), observedAt);
    const result = buildInboundLinks(target, f.scan(target), ok(index), { now: observedAt });
    expect(result.inboundLinks).toMatchObject({ state: 'ok', value: expect.arrayContaining([
      expect.objectContaining({ sourceTree: nested.replaceAll('\\', '/'), path: nestedLink }),
      expect.objectContaining({ sourceTree: f.primary.replaceAll('\\', '/'), path: outside }),
    ]) });
    expect(result.inboundLinks.value).toHaveLength(2);
    expect(result.liveWalked.size).toBe(0);
  });

  it.each(['absent', 'incomplete'])('live-walks an %s primary entry without revisiting nested registered roots', kind => {
    const f = fixture(), target = f.add('target'), nested = f.add('nested', join(f.primary, '.worktrees', 'nested'));
    const nestedLink = f.link(nested, target);
    const index = projectLinkIndex(f.scan(), observedAt), key = `${normalizePath(f.primary)}\0primary\0${normalizePath(f.common)}`;
    expect(index.entries[key]).toBeDefined();
    if (kind === 'absent') delete index.entries[key];
    else { index.entries[key].complete = false; delete index.entries[key].links; }
    const outside = f.link(f.primary, target, '.worktrees/leftover/dependency');
    const fresh = f.scan(target);
    vi.mocked(readdirSync).mockClear();
    const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt });
    expect(result.inboundLinks).toMatchObject({ state: 'ok', value: expect.arrayContaining([
      expect.objectContaining({ sourceTree: nested.replaceAll('\\', '/'), path: nestedLink }),
      expect.objectContaining({ sourceTree: f.primary.replaceAll('\\', '/'), path: outside }),
    ]) });
    expect(result.inboundLinks.value).toHaveLength(2);
    expect([...result.liveWalked].map(normalizePath)).toEqual([normalizePath(f.primary)]);
    // One shallow scan of the nested tree, never a second scan through its parent.
    expect(vi.mocked(readdirSync).mock.calls.filter(([path]) => normalizePath(String(path)) === normalizePath(nested))).toHaveLength(1);
  });

  it('passes registered subtree exclusions to live walks of non-primary foreign trees', () => {
    const f = fixture(), target = f.add('target'), parent = f.add('parent'), nested = f.add('nested', join(parent, 'child'));
    const nestedLink = f.link(nested, target), index = projectLinkIndex(f.scan(), observedAt);
    const parentKey = Object.keys(index.entries).find(key => index.entries[key].path === normalizePath(parent))!;
    delete index.entries[parentKey];
    const result = buildInboundLinks(target, f.scan(target), ok(index), { now: observedAt });
    expect(result.inboundLinks).toMatchObject({ state: 'ok', value: [expect.objectContaining({ sourceTree: nested.replaceAll('\\', '/'), path: nestedLink })] });
    expect([...result.liveWalked].map(normalizePath)).toEqual([normalizePath(parent)]);
  });

  it.each(['wrong-key', 'duplicate'])('refuses a %s primary entry', kind => {
    const f = fixture(); f.add('target');
    const index = projectLinkIndex(f.scan(), observedAt), key = `${normalizePath(f.primary)}\0primary\0${normalizePath(f.common)}`;
    expect(index.entries[key]).toBeDefined();
    const copy = { ...index.entries[key], path: normalizePath(join(f.directory, 'other')) };
    index.entries[kind === 'wrong-key' ? key + '-wrong' : `${copy.path}\0primary\0${index.repositoryIdentity}`] = copy;
    if (kind === 'wrong-key') delete index.entries[key];
    mkdirSync(f.root); writeFileSync(linkIndexPath(f.root, f.common), JSON.stringify(index));
    expect(readLinkIndex(f.root, f.common, { now: observedAt })).toMatchObject({ state: 'unknown', reason: 'link-index-stale' });
  });
});

describe('nightly link index projection and validation', () => {
  it('records identity, observation time, full complete links, and no partial links for a timeout', () => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign'), incomplete = f.add('incomplete');
    f.link(foreign, target);
    const snapshot = f.scan();
    snapshot.worktrees.find(tree => normalizePath(tree.path) === normalizePath(incomplete))!.links = unknown('Filesystem inventory timed out');
    const index = projectLinkIndex(snapshot, observedAt);
    expect(index).toMatchObject({ version: 1, repositoryIdentity: normalizePath(f.common), observedAt });
    const foreignLinks = snapshot.worktrees.find(tree => normalizePath(tree.path) === normalizePath(foreign))!.links;
    if (foreignLinks.state !== 'ok') throw new Error('Fixture link walk unavailable');
    expect(entryFor(index, foreign)).toMatchObject({ complete: true,
      links: foreignLinks.value.entries });
    expect(entryFor(index, incomplete)).toMatchObject({ complete: false });
    expect(entryFor(index, incomplete)).not.toHaveProperty('links');
    const key = snapshot.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!;
    expect(key.gitdirFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(index.entries[`${normalizePath(foreign)}\0${normalizePath(key.adminPath)}\0${key.gitdirFingerprint}`]).toBe(entryFor(index, foreign));
  });

  it.each(['missing', 'unreadable', 'invalid-json', 'missing-links', 'invalid-link', 'wrong-repository', 'expired', 'future'])('refuses a %s index', kind => {
    const f = fixture(); f.add('target');
    const index = projectLinkIndex(f.scan(), observedAt);
    mkdirSync(f.root);
    const file = linkIndexPath(f.root, f.common);
    if (kind === 'missing-links') delete (Object.values(index.entries)[0] as { links?: unknown }).links;
    if (kind === 'invalid-link') (Object.values(index.entries)[0] as { links?: unknown[] }).links = [{}];
    if (kind === 'wrong-repository') index.repositoryIdentity = normalizePath(join(f.directory, 'other', '.git'));
    if (kind === 'expired') index.observedAt -= 60 * 60 * 60_000 + 1;
    if (kind === 'future') index.observedAt++;
    if (kind !== 'missing') writeFileSync(file, kind === 'invalid-json' ? '{' : JSON.stringify(index));
    if (kind === 'unreadable') {
      const read = vi.mocked(readFileSync).getMockImplementation()!;
      vi.mocked(readFileSync).mockImplementation(((path, ...args) => {
        if (String(path) === file) throw Object.assign(new Error('Unreadable index'), { code: 'EACCES' });
        return Reflect.apply(read, undefined, [path, ...args]);
      }) as typeof readFileSync);
    }
    expect(readLinkIndex(f.root, f.common, { now: observedAt })).toMatchObject({ state: 'unknown', reason: 'link-index-stale' });
  });

  it('accepts a valid index through exactly 60 hours and separates repository filenames', () => {
    const f = fixture(); f.add('target');
    const snapshot = f.scan();
    const file = writeLinkIndex(f.root, snapshot, { observedAt });
    expect(file).toBe(linkIndexPath(f.root, f.common));
    expect(file).not.toBe(linkIndexPath(f.root, join(f.directory, 'other', '.git')));
    expect(readLinkIndex(f.root, f.common, { now: observedAt + 60 * 60 * 60_000 }))
      .toMatchObject({ state: 'ok', value: projectLinkIndex(snapshot, observedAt) });
  });

  it('survives one missed nightly: accepts a 59-hour index and refuses a 61-hour one with its age', () => {
    const f = fixture(); f.add('target');
    writeLinkIndex(f.root, f.scan(), { observedAt });
    expect(readLinkIndex(f.root, f.common, { now: observedAt + 59 * 60 * 60_000 }).state).toBe('ok');
    expect(readLinkIndex(f.root, f.common, { now: observedAt + 61 * 60 * 60_000 })).toMatchObject({
      state: 'unknown', reason: 'link-index-stale', ageMs: 61 * 60 * 60_000,
      detail: 'Link index is 61.0 h old (limit 60.0 h); the next scheduled nightly cleanup refreshes it' });
  });

  it('reports an age only when the observed age exceeds the limit', () => {
    const f = fixture(); f.add('target');
    const missing = readLinkIndex(f.root, f.common, { now: observedAt });
    expect(missing).toMatchObject({ reason: 'link-index-stale', ageMs: null, detail: expect.stringContaining('is missing or unusable (limit 60.0 h)') });
    const index = projectLinkIndex(f.scan(), observedAt - 61 * 60 * 60_000);
    index.repositoryIdentity = normalizePath(join(f.directory, 'other', '.git'));
    mkdirSync(f.root); writeFileSync(linkIndexPath(f.root, f.common), JSON.stringify(index));
    // An expired index that is also foreign must not blame age: waiting would not fix it.
    expect(readLinkIndex(f.root, f.common, { now: observedAt })).toMatchObject({ reason: 'link-index-stale', ageMs: null,
      detail: expect.stringContaining('is missing or unusable') });
  });
});

describe('existingCasePath', () => {
  it('resolves each lowercase index component to its on-disk casing', () => {
    const base = mkdtempSync(join(tmpdir(), 'wt-case-')), actual = join(base, 'MixedCase', 'Leaf');
    try {
      mkdirSync(actual, { recursive: true });
      expect(normalizePath(existingCasePath(normalizePath(actual))!)).toBe(normalizePath(actual));
      expect(existingCasePath(normalizePath(actual))).toMatch(/[\\/]MixedCase[\\/]Leaf$/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('returns null when a component is absent', () => {
    const base = mkdtempSync(join(tmpdir(), 'wt-case-'));
    try { expect(existingCasePath(normalizePath(join(base, 'missing', 'leaf')))).toBeNull(); }
    finally { rmSync(base, { recursive: true, force: true }); }
  });

  it('refuses two names that differ only by case', () => {
    const base = mkdtempSync(join(tmpdir(), 'wt-case-')), read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => normalizePath(String(path)) === normalizePath(base)
      ? ['Leaf', 'leaf'] : Reflect.apply(read, undefined, [path, ...args])) as typeof readdirSync);
    try { expect(() => existingCasePath(normalizePath(join(base, 'leaf')))).toThrow(/Ambiguous case-variant path/); }
    finally { vi.mocked(readdirSync).mockImplementation(read); rmSync(base, { recursive: true, force: true }); }
  });
});

describe('release inbound baseline', () => {
  it.each(['primary-absent', 'primary-incomplete', 'foreign-absent', 'foreign-recreated', 'foreign-incomplete', 'leftover'])('gives the %s live walk 240 seconds and caps it to the remaining soft deadline', kind => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign');
    const snapshot = f.scan(), index = projectLinkIndex(snapshot, observedAt);
    const source = kind.startsWith('primary') ? f.primary : foreign;
    const key = Object.keys(index.entries).find(key => index.entries[key].path === normalizePath(source))!;
    if (kind.endsWith('absent')) delete index.entries[key];
    if (kind.endsWith('incomplete')) { index.entries[key].complete = false; delete index.entries[key].links; }
    if (kind === 'foreign-recreated') {
      f.git('worktree', 'remove', foreign); f.git('worktree', 'add', foreign, 'foreign');
    }
    if (kind === 'leftover') {
      const admin = snapshot.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!.adminPath;
      expect(normalizePath(admin).startsWith(normalizePath(f.common) + '/')).toBe(true);
      rmSync(admin, { recursive: true }); unlinkSync(join(foreign, '.git'));
    }
    const fresh = f.scan(target), scan = vi.spyOn(linkInventory, 'scanTreeLinks');
    const now = () => observedAt;
    try {
      for (const remaining of [10 * 60_000, 90_000]) {
        scan.mockClear();
        const softDeadline = observedAt + remaining;
        const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt, softDeadline, deadlineNow: now });
        expect(result.inboundLinks.state).toBe('negative');
        expect([...result.liveWalked].map(normalizePath)).toEqual([normalizePath(source)]);
        expect(scan).toHaveBeenCalledOnce();
        expect(scan).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
          walkTimeout: Math.min(240_000, remaining), softDeadline, deadlineNow: now,
        }));
      }
    } finally { scan.mockRestore(); }
  }, 30_000);

  // An existing folder can be missing from its parent's listing: an NTFS 8.3 alias, or a Linux autofs key
  // without browse mode. The leftover sits under an all-lowercase parent so its lowercase raw path exists everywhere.
  it('still walks a leftover its parent listing omits, such as an 8.3 alias or autofs key, through its raw path', () => {
    const lowerParent = join(tmpdir(), `wt-lower-${randomUUID()}`); mkdirSync(lowerParent); roots.push(lowerParent);
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign', join(lowerParent, 'foreign'));
    if (process.platform !== 'win32') expect(normalizePath(foreign)).toBe(foreign);
    const snapshot = f.scan(), index = projectLinkIndex(snapshot, observedAt);
    const admin = snapshot.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!.adminPath;
    rmSync(admin, { recursive: true }); unlinkSync(join(foreign, '.git'));
    const fresh = f.scan(target), read = vi.mocked(readdirSync).getMockImplementation()!;
    // The parent listing shows only long names, so the indexed component matches none of them.
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      const names = Reflect.apply(read, undefined, [path, ...args]);
      return normalizePath(String(path)) === normalizePath(dirname(foreign)) && !args.length
        ? (names as string[]).filter(name => name.toLowerCase() !== 'foreign') : names;
    }) as typeof readdirSync);
    const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt, softDeadline: observedAt + 10 * 60_000, deadlineNow: () => observedAt });
    expect(result.inboundLinks.state).toBe('negative');
    expect([...result.liveWalked].map(normalizePath)).toEqual([normalizePath(foreign)]);
  }, 30_000);

  it('stops a live walk at the soft deadline even when its 240-second timeout has time left', () => {
    const f = fixture(), target = f.add('target'), index = projectLinkIndex(f.scan(), observedAt);
    const primary = entryFor(index, f.primary); primary.complete = false; delete primary.links;
    const fresh = f.scan(target), read = vi.mocked(readdirSync).getMockImplementation()!;
    let clock = observedAt;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(f.primary)) clock += 90_000;
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt, softDeadline: observedAt + 90_000, deadlineNow: () => clock });
    expect(result.inboundLinks).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Soft deadline reached') });
  });

  it('completes a primary live walk taking more than the former 120-second limit', () => {
    const f = fixture(), target = f.add('target'), index = projectLinkIndex(f.scan(), observedAt);
    const primary = entryFor(index, f.primary); primary.complete = false; delete primary.links;
    const fresh = f.scan(target), read = vi.mocked(readdirSync).getMockImplementation()!;
    let clock = observedAt;
    const dateNow = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(f.primary)) clock += 150_000;
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    try {
      const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt, softDeadline: observedAt + 10 * 60_000, deadlineNow: () => clock });
      expect(result.inboundLinks.state).toBe('negative');
    } finally { dateNow.mockRestore(); }
  });
  it.skipIf(process.platform !== 'win32').each(['dependency', 'nested/dependency'])('live-walks a complete de-registered entry for a new %s junction', name => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign');
    const snapshot = f.scan(), index = projectLinkIndex(snapshot, observedAt);
    expect(entryFor(index, foreign)).toMatchObject({ complete: true, links: [] });
    const key = snapshot.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!;
    expect(normalizePath(key.adminPath).startsWith(normalizePath(f.primary) + '/')).toBe(true);
    rmSync(key.adminPath, { recursive: true }); unlinkSync(join(foreign, '.git'));
    const link = f.link(foreign, target, name);
    const result = buildInboundLinks(target, f.scan(target), ok(index), { now: observedAt });
    expect(result.inboundLinks.state).toBe('ok');
    if (result.inboundLinks.state !== 'ok') throw new Error('Missing leftover link');
    expect(result.inboundLinks.value.map((entry: { path: string }) => normalizePath(entry.path))).toEqual([normalizePath(link)]);
  });
  it('skips an absent prunable registration', () => {
    const f = fixture(), target = f.add('target'), stale = f.add('stale');
    const index = projectLinkIndex(f.scan(), observedAt);
    expect(normalizePath(stale).startsWith(normalizePath(f.directory) + '/')).toBe(true);
    rmSync(stale, { recursive: true });
    const snapshot = f.scan(target);
    expect(snapshot.registrations?.find(entry => normalizePath(entry.path) === normalizePath(stale))).toMatchObject({ prunable: expect.any(String) });
    expect(buildInboundLinks(target, snapshot, ok(index), { now: observedAt }).inboundLinks.state).toBe('negative');
  });
  it('still scans a prunable registration whose folder exists', () => {
    const f = fixture(), target = f.add('target'), stale = f.add('stale');
    const index = projectLinkIndex(f.scan(), observedAt);
    unlinkSync(join(stale, '.git'));
    const link = f.link(stale, target, 'dependency'), snapshot = f.scan(target);
    expect(snapshot.registrations?.find(entry => normalizePath(entry.path) === normalizePath(stale))).toMatchObject({ prunable: expect.any(String) });
    expect(buildInboundLinks(target, snapshot, ok(index), { now: observedAt }).inboundLinks)
      .toMatchObject({ state: 'ok', value: [expect.objectContaining({ path: link })] });
  });
  it.skipIf(process.platform !== 'win32').each(['complete', 'incomplete', 'failed-walk'])('retains a de-registered on-disk foreign entry: %s', kind => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign', join(f.primary, '.worktrees', 'foreign'));
    const link = f.link(foreign, target), snapshot = f.scan();
    if (kind === 'incomplete') snapshot.worktrees.find(tree => normalizePath(tree.path) === normalizePath(foreign))!.links = unknown('timed out');
    const index = projectLinkIndex(snapshot, observedAt);
    const key = snapshot.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!;
    // Simulate a half-removed folder whose registration has been pruned.
    expect(normalizePath(key.adminPath).startsWith(normalizePath(f.primary) + '/')).toBe(true);
    rmSync(key.adminPath, { recursive: true }); unlinkSync(join(foreign, '.git'));
    const fresh = f.scan(target), read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockClear();
    if (kind === 'failed-walk') vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(foreign)) throw new Error('Injected leftover walk failure');
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt });
    if (kind === 'failed-walk') expect(result.inboundLinks.state).toBe('unknown');
    else {
      expect(result.inboundLinks.state).toBe('ok');
      if (result.inboundLinks.state !== 'ok') throw new Error('Missing leftover link');
      expect(result.inboundLinks.value.map((entry: { path: string }) => normalizePath(entry.path))).toEqual([normalizePath(link)]);
    }
    expect(result.liveWalked.size).toBe(1);
  });
  it('uses an indexed nested junction and shallow-scans all foreign trees without deep-walking matching entries', () => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign'), shallow = f.add('shallow');
    const nested = f.link(foreign, target);
    const index = projectLinkIndex(f.scan(), observedAt);
    const top = f.link(shallow, target, 'dependency');
    const result = buildInboundLinks(target, f.scan(target), ok(index), { now: observedAt });
    expect(result.inboundLinks).toMatchObject({ state: 'ok', value: expect.arrayContaining([
      expect.objectContaining({ sourceTree: foreign.replaceAll('\\', '/'), path: nested }),
      expect.objectContaining({ sourceTree: shallow.replaceAll('\\', '/'), path: top }),
    ]) });
    expect(result.liveWalked.size).toBe(0);
  });

  it.each(['absent', 'recreated', 'incomplete'])('deep-walks a foreign tree whose indexed incarnation is %s', kind => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign'), stable = f.add('stable');
    const snapshot = f.scan(), index = projectLinkIndex(snapshot, observedAt);
    const oldKey = Object.keys(index.entries).find(key => index.entries[key].path === normalizePath(foreign))!;
    if (kind === 'absent') delete index.entries[oldKey];
    if (kind === 'incomplete') index.entries[oldKey] = { ...index.entries[oldKey], complete: false };
    if (kind === 'incomplete') delete index.entries[oldKey].links;
    if (kind === 'recreated') {
      const head = f.git('-C', foreign, 'rev-parse', 'HEAD');
      f.git('worktree', 'remove', foreign);
      f.git('worktree', 'add', foreign, 'foreign');
      expect(f.git('-C', foreign, 'rev-parse', 'HEAD')).toBe(head);
    }
    const nested = f.link(foreign, target);
    const fresh = f.scan(target);
    if (kind === 'recreated') {
      const key = fresh.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!;
      expect(key.gitdirFingerprint).not.toBe(snapshot.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!.gitdirFingerprint);
      expect(key.key).toBe(snapshot.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!.key);
    }
    const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt });
    expect(result.inboundLinks).toMatchObject({ state: 'ok', value: expect.arrayContaining([expect.objectContaining({ path: nested })]) });
    expect(new Set([...result.liveWalked].map(normalizePath))).toEqual(new Set([normalizePath(foreign)]));
    expect([...result.liveWalked].map(normalizePath)).not.toContain(normalizePath(stable));
  });

  it('refuses a failed live walk of an incomplete entry, without using its partial links', () => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign');
    const snapshot = f.scan(), index = projectLinkIndex(snapshot, observedAt);
    const entry = entryFor(index, foreign); entry.complete = false; delete entry.links;
    const fresh = f.scan(target), read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(foreign)) throw new Error('Injected unreadable foreign tree');
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    const result = buildInboundLinks(target, fresh, ok(index), { now: observedAt });
    expect(result.inboundLinks).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Injected unreadable foreign tree') });
    expect([...result.liveWalked].map(normalizePath)).toContain(normalizePath(foreign));
  });

  it('refuses a shallow scan failure even with a complete index and propagates a stale reader', () => {
    const f = fixture(), target = f.add('target'), foreign = f.add('foreign');
    const index = projectLinkIndex(f.scan(), observedAt), fresh = f.scan(target);
    const read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(foreign)) throw new Error('Shallow scan failed');
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    expect(buildInboundLinks(target, fresh, ok(index), { now: observedAt }).inboundLinks.state).toBe('unknown');
    const stale = buildInboundLinks(target, fresh, unknown('link-index-stale'), { now: observedAt });
    expect(stale.inboundLinks).toMatchObject({ state: 'unknown', reason: 'link-index-stale' });
    expect(stale.liveWalked.size).toBe(0);
  });
});

describe('atomic index publication', () => {
  it('writes no index when the nightly fails before inventory completes', async () => {
    const f = fixture(); f.add('target');
    const writer = vi.fn(writeLinkIndex);
    const report = await runCleanup({ repositoryPath: f.primary, reportRoot: f.root, gitPath: 'git', ghPath: 'git',
      dryRun: true, runId: 'fixed', now: () => observedAt }, {
      inventory: () => unknown('Injected inventory failure'), writeLinkIndex: writer,
      acquireRunLock: async () => async () => {}, notifyRun: () => {},
    });
    expect(report).toMatchObject({ status: 'failed', stage: 'inventory' });
    expect(writer).not.toHaveBeenCalled();
    expect(readLinkIndex(f.root, f.common, { now: observedAt })).toMatchObject({ state: 'unknown', ageMs: null });
  });

  it('publishes a complete early primary scan when removals consume the remaining decision budget', async () => {
    const f = fixture(), target = f.add('target'), nested = f.add('nested', join(f.primary, '.worktrees', 'nested'));
    f.link(nested, target);
    const leftover = f.link(f.primary, target, '.worktrees/leftover/dependency');
    const snapshot = f.scan(), order: string[] = [];
    const softTimeoutMs = 10 * 60_000, treeDeadline = observedAt + softTimeoutMs - 2 * 60_000;
    let clock = observedAt;
    const read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(f.primary)) order.push('primary');
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    const report = await runCleanup({ repositoryPath: f.primary, reportRoot: f.root, gitPath: 'git', ghPath: 'git',
      runId: 'fixed', now: () => clock, softTimeoutMs }, {
      inventory: () => { order.push('inventory'); return ok(snapshot); },
      runProbe: (executable: string, args: string[], options: Parameters<typeof probe>[2]) =>
        args.includes('fetch') ? ok('') : probe(executable, args, options),
      collectActivity: () => { order.push('activity'); return snapshot.worktrees.map(() => ({ live: negative(), transcript: negative() })); },
      planWorktrees: () => {
        order.push('classify');
        return ok({ worktrees: snapshot.worktrees.map(tree => ({ path: tree.path,
          disposition: normalizePath(tree.path) === normalizePath(target) ? 'remove' : 'hold', reason: 'fixture' })) });
      },
      appendIdleObservation: () => ok(null),
      executeRemovals: () => {
        order.push('remove'); clock = treeDeadline;
        throw Object.assign(new Error('Soft deadline reached during removal'), { stopReason: 'deadline' });
      },
      writeLinkIndex: (...args: Parameters<typeof writeLinkIndex>) => { order.push('write'); return writeLinkIndex(...args); },
      acquireRunLock: async () => async () => {}, notifyRun: () => {},
    });
    expect(report).toMatchObject({ status: 'failed', stage: 'remove', stopReason: 'deadline', outcome: 'deadline' });
    const index = readLinkIndex(f.root, f.common, { now: clock });
    expect(index.state).toBe('ok');
    if (index.state !== 'ok') throw new Error('Primary index was not published');
    expect(entryFor(index.value, f.primary)).toMatchObject({ complete: true, links: [expect.objectContaining({ path: leftover })] });
    expect(order).toEqual(['inventory', 'primary', 'activity', 'classify', 'remove', 'write']);
    const journal = JSON.parse(readFileSync(join(f.root, 'journal.jsonl'), 'utf8').trim());
    expect(journal.notes).toBeUndefined();
  });

  it('records an incomplete primary entry and a note when the early scan exhausts its own three-minute budget', async () => {
    const f = fixture(), target = f.add('target'), snapshot = f.scan();
    let clock = observedAt;
    const read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
      if (normalizePath(String(path)) === normalizePath(f.primary)) clock = observedAt + 3 * 60_000;
      return Reflect.apply(read, undefined, [path, ...args]);
    }) as typeof readdirSync);
    const planWorktrees = vi.fn(() => ok({ worktrees: snapshot.worktrees.map(tree => ({ path: tree.path,
      disposition: normalizePath(tree.path) === normalizePath(target) ? 'remove' : 'hold', reason: 'fixture' })) }));
    const report = await runCleanup({ repositoryPath: f.primary, reportRoot: f.root, gitPath: 'git', ghPath: 'git',
      dryRun: true, runId: 'fixed', now: () => clock, softTimeoutMs: 10 * 60_000 }, {
      inventory: () => ok(snapshot), planWorktrees,
      collectActivity: () => snapshot.worktrees.map(() => ({ live: negative(), transcript: negative() })),
      acquireRunLock: async () => async () => {}, notifyRun: () => {},
    });
    expect(report).toMatchObject({ status: 'completed', stage: 'dry-run-complete' });
    expect(planWorktrees).toHaveBeenCalledOnce();
    const index = readLinkIndex(f.root, f.common, { now: clock });
    expect(index.state).toBe('ok');
    if (index.state !== 'ok') throw new Error('Incomplete primary index was not published');
    expect(entryFor(index.value, f.primary)).toMatchObject({ complete: false });
    expect(entryFor(index.value, f.primary)).not.toHaveProperty('links');
    const journal = JSON.parse(readFileSync(join(f.root, 'journal.jsonl'), 'utf8').trim());
    expect(journal.notes).toEqual([expect.stringContaining('Soft deadline reached')]);
  });

  it.each(['partial-write', 'rename'])('preserves the old complete file and removes temporary bytes on %s failure', kind => {
    const f = fixture(); f.add('target');
    const snapshot = f.scan(), file = writeLinkIndex(f.root, snapshot, { observedAt });
    const previous = readFileSync(file, 'utf8');
    if (kind === 'rename') vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error('Injected rename failure'); });
    else {
      const write = vi.mocked(writeFileSync).getMockImplementation()!;
      vi.mocked(writeFileSync).mockImplementationOnce(((path, _data, options) => {
        Reflect.apply(write, undefined, [path, '{partial', options]); throw new Error('Injected partial write');
      }) as typeof writeFileSync);
    }
    expect(() => writeLinkIndex(f.root, snapshot, { observedAt: observedAt + 1 })).toThrow('Injected');
    expect(readFileSync(file, 'utf8')).toBe(previous);
    expect(readdirSync(f.root)).toEqual([file.slice(f.root.length + 1)]);
    expect(readLinkIndex(f.root, f.common, { now: observedAt + 1 }).state).toBe('ok');
  });

  it('keeps nightly decisions and per-tree reports identical when the writer succeeds, is absent, or fails', async () => {
    const f = fixture(), target = f.add('target'), snapshot = f.scan();
    const plans: unknown[] = [], reports = [];
    for (const mode of ['none', 'success', 'failure', 'primary-scan-failure']) {
      const root = join(f.directory, mode);
      const writer = mode === 'success' || mode === 'primary-scan-failure' ? vi.fn(writeLinkIndex) : vi.fn(() => { if (mode === 'failure') throw new Error('Injected writer failure'); });
      const read = vi.mocked(readdirSync).getMockImplementation()!;
      if (mode === 'primary-scan-failure') vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
        if (normalizePath(String(path)) === normalizePath(f.primary)) throw new Error('Injected primary scan failure');
        return Reflect.apply(read, undefined, [path, ...args]);
      }) as typeof readdirSync);
      const report = await runCleanup({ repositoryPath: f.primary, reportRoot: root, gitPath: 'git', ghPath: 'git',
        dryRun: true, runId: 'fixed', now: () => observedAt }, {
        inventory: () => ok(snapshot), writeLinkIndex: writer,
        ...(mode === 'none' ? { scanPrimaryLinks: () => ok([]) } : {}),
        collectActivity: () => snapshot.worktrees.map(() => ({ live: negative(), transcript: negative() })),
        planWorktrees: (value: unknown) => {
          plans.push(structuredClone(value));
          return ok({ worktrees: snapshot.worktrees.map(tree => ({ path: tree.path,
            disposition: normalizePath(tree.path) === normalizePath(target) ? 'remove' : 'hold', reason: 'fixture' })) });
        },
        acquireRunLock: async () => async () => {}, notifyRun: () => {},
      });
      expect(report.status).toBe('completed');
      expect(writer).toHaveBeenCalledOnce();
      const journal = JSON.parse(readFileSync(join(root, 'journal.jsonl'), 'utf8').trim());
      if (mode === 'failure') expect(journal.notes).toEqual([expect.stringContaining('Injected writer failure')]);
      else if (mode === 'primary-scan-failure') {
        expect(journal.notes).toEqual([expect.stringContaining('Injected primary scan failure')]);
        const index = readLinkIndex(root, f.common, { now: observedAt });
        expect(index.state).toBe('ok');
        if (index.state !== 'ok') throw new Error('Incomplete primary index was not published');
        expect(entryFor(index.value, f.primary)).toMatchObject({ complete: false });
        expect(entryFor(index.value, f.primary)).not.toHaveProperty('links');
      }
      else expect(journal.notes).toBeUndefined();
      reports.push({ rows: report.worktrees, counts: report.counts, text: readFileSync(report.reportPath!, 'utf8') });
      vi.mocked(readdirSync).mockImplementation(read);
    }
    expect(plans).toHaveLength(4);
    expect(plans[1]).toEqual(plans[0]); expect(plans[2]).toEqual(plans[0]);
    expect(plans[3]).toEqual(plans[0]);
    expect(reports[1]).toEqual(reports[0]); expect(reports[2]).toEqual(reports[0]);
    expect(reports[3]).toEqual(reports[0]);
  });
});
