import './worktree-cleanup-test-env';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as archive from '../lib/worktree-cleanup/archive.mjs';
import * as journal from '../lib/worktree-cleanup/idle-journal.mjs';
import { inventory } from '../lib/worktree-cleanup/inventory.mjs';
import { collectActivity } from '../lib/worktree-cleanup/activity.mjs';
import { planWorktrees } from '../lib/worktree-cleanup/policy.mjs';
import { executeRemovals } from '../lib/worktree-cleanup/remove.mjs';
import { main } from '../worktree-cleanup.mjs';
import { negative, ok, unknown, withDeadline } from '../lib/worktree-cleanup/probe.mjs';
import { archiveSummary, writeRunReport } from '../lib/worktree-cleanup/report.mjs';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, writeFileSync: vi.fn(fs.writeFileSync), rmdirSync: vi.fn(fs.rmdirSync) };
});

const roots: string[] = [];
const DAY = 86_400_000, now = Date.now(), old = new Date(now - 30 * DAY);
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV };
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.replace(/\r?\n$/, '');
}
function put(root: string, path: string, bytes: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
}
function age(root: string) {
  for (const name of readdirSync(root)) {
    if (name === '.git') continue;
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) age(path); else utimesSync(path, old, old);
  }
}
function working(root: string) {
  const files: Record<string, string> = {}, dirs: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const path = join(dir, name), rel = relative(root, path).split(sep).join('/');
      if (lstatSync(path).isDirectory()) { dirs.push(rel); walk(path); }
      else files[rel] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  }
  walk(root); return { files, dirs: dirs.sort() };
}
function fixture(crlf = false) {
  const root = mkdtempSync(join(tmpdir(), 'wt-archive-')); roots.push(root);
  const primary = join(root, 'primary'), tree = join(root, 'candidate'), home = join(root, 'home');
  mkdirSync(primary); mkdirSync(home);
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.name', 'Fixture'); git(primary, 'config', 'user.email', 'fixture@example.invalid');
  git(primary, 'config', 'core.autocrlf', crlf ? 'true' : 'false'); git(primary, 'config', 'core.longpaths', 'true');
  put(primary, '.gitignore', '.env.local\nignored/\nnode_modules/\n.next/\ncoverage/\n');
  for (const name of ['mixed.txt', 'staged.txt', 'stage-delete.txt', 'work-delete.txt', 'lf.txt']) put(primary, name, 'base\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'base');
  git(primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(primary, 'worktree', 'add', '-b', 'candidate', tree);
  const options = { archiveRoot: join(root, 'archives'), journalPath: join(root, 'idle.jsonl'), now: () => now,
    activityOptions: { homeDirectory: home, now: () => now }, prSnapshot: ok([]) };
  age(tree); return { root, primary, tree, home, options };
}
type Fixture = ReturnType<typeof fixture>;
function mixed(f: Fixture) {
  put(f.tree, 'mixed.txt', 'index\n'); put(f.tree, 'staged.txt', 'staged only\n');
  git(f.tree, 'add', 'mixed.txt', 'staged.txt'); git(f.tree, 'rm', 'stage-delete.txt');
  put(f.tree, 'mixed.txt', Buffer.from([0, 255, 1, 10]));
  unlinkSync(join(f.tree, 'work-delete.txt')); put(f.tree, 'lf.txt', 'LF only\n');
  put(f.tree, 'artifacts/result.json', '{"answer":42}\n'); put(f.tree, '.env.local', 'PRIVATE=fixture\n');
  put(f.tree, 'ignored/deep/data.bin', Buffer.from([255, 128, 0])); mkdirSync(join(f.tree, 'empty'));
  age(f.tree);
}
function value<T extends { state: string; value?: unknown; reason?: string }>(result: T): NonNullable<Extract<T, { state: 'ok' }>['value']> {
  expect(result.state, result.reason).toBe('ok');
  if (result.state !== 'ok' || result.value === undefined) throw new Error(result.reason ?? 'Missing value');
  return result.value as NonNullable<Extract<T, { state: 'ok' }>['value']>;
}
function saved(f: Fixture, extra = {}) { return value(archive.createArchive(f.tree, { ...f.options, ...extra })); }
function history(f: Fixture, count = 16, liveDay = -1) {
  for (let day = count - 1; day >= 0; day--) {
    value(journal.appendIdleObservation(f.tree, { head: ok(git(f.tree, 'rev-parse', 'HEAD')), live: day === liveDay ? ok({ reasons: ['transcript'] }) : negative() },
      { ...f.options, now: () => now - day * DAY }));
  }
}
async function snapshot(f: Fixture) {
  const result = value(inventory({ repositoryPath: f.primary, runnerPath: f.primary }));
  const signals = await collectActivity(result.worktrees, f.options.activityOptions);
  return { ...result, worktrees: result.worktrees.map((tree, i) => ({ ...tree, activity: signals[i] })) };
}
function discardFixtureTree(f: Fixture) { git(f.primary, 'worktree', 'remove', '--force', f.tree); }
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(writeFileSync).mockReset();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('U7 raw-byte archive (temp repositories only)', { timeout: 60_000 }, () => {
  it.each([false, true])('preserves a repository stop when staging cleanup fails=%s', cleanupFails => {
    const f = fixture(); put(f.tree, 'payload.txt', 'preserved');
    let staging = '';
    const result = archive.createArchive(f.tree, { ...f.options, onBeforeVerify: path => {
      staging = path;
      if (cleanupFails) vi.mocked(rmdirSync).mockImplementationOnce(() => { throw new Error('Staging cleanup denied'); });
      throw Object.assign(new Error('Repository registration disappeared'), { stopReason: 'prune-unknown' });
    } });
    expect(result).toMatchObject({ state: 'unknown', stopReason: 'prune-unknown' });
    if (result.state !== 'unknown') throw new Error('Archive unexpectedly succeeded');
    expect(result.reason.includes('partial archive cleanup failed')).toBe(cleanupFails);
    expect(existsSync(staging)).toBe(cleanupFails);
    expect(readFileSync(join(f.tree, 'payload.txt'), 'utf8')).toBe('preserved');
  });
  it('cleans staging after the deadline expires immediately after a payload write', () => {
    const f = fixture(); put(f.tree, 'payload.txt', 'preserved');
    let clock = 100, expired = false;
    const end = 120_100, realWrite = vi.mocked(writeFileSync).getMockImplementation()!;
    vi.mocked(writeFileSync).mockImplementation((...args) => {
      const result = realWrite(...args);
      if (String(args[0]).startsWith(f.options.archiveRoot) && String(args[0]).endsWith('payload.txt')) {
        expired = true; clock = end;
      }
      return result;
    });
    const result = withDeadline(end, () => clock, () => archive.createArchive(f.tree, f.options));
    expect(expired).toBe(true);
    expect(result).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Soft deadline reached') });
    expect(readdirSync(f.options.archiveRoot)).toEqual(['.staging']);
    expect(readdirSync(join(f.options.archiveRoot, '.staging'))).toEqual([]);
    expect(archive.pruneArchives({ ...f.options, currentRunId: 'next' }).state).toBe('ok');
    const report = writeRunReport(f.root, { runId: 'deadline', startedAt: now, finishedAt: now, status: 'completed', stage: 'complete', worktrees: [] });
    expect(report.status).toBe('completed');
    expect(report.archives).toMatchObject({ count: 0, totalBytes: 0 });
  });
  it('excludes abandoned staging from discovery and removes it on the next retention pass', () => {
    const f = fixture(), abandoned = join(f.options.archiveRoot, '.staging', 'old-run-candidate');
    put(abandoned, 'files/partial.txt', 'partial');
    for (const path of [join(abandoned, 'files/partial.txt'), join(abandoned, 'files'), abandoned]) utimesSync(path, old, old);
    expect(archiveSummary(f.root, now)).toMatchObject({ count: 0, totalBytes: 0 });
    expect(writeRunReport(f.root, { runId: 'abandoned', startedAt: now, finishedAt: now, status: 'completed', stage: 'complete', worktrees: [] }).status).toBe('completed');
    expect(archive.pruneArchives({ ...f.options, currentRunId: 'next' }).state).toBe('ok');
    expect(existsSync(abandoned)).toBe(false);
  });
  it.each(['entry', 'nested-file', 'nested-directory', 'one-hour'])('keeps staging with a recent %s mtime and warns', newest => {
    const f = fixture(), staging = join(f.options.archiveRoot, '.staging', 'live-run-candidate');
    const file = join(staging, 'files/partial.txt'), directory = join(staging, 'files');
    put(staging, 'files/partial.txt', 'partial');
    for (const path of [file, directory, staging]) utimesSync(path, old, old);
    // One second inside the hour: an mtime set exactly on the boundary can read
    // back a fraction of a millisecond early on Linux and flake.
    const recent = new Date(newest === 'one-hour' ? now - 3_599_000 : now);
    utimesSync(newest === 'nested-file' ? file : newest === 'nested-directory' ? directory : staging, recent, recent);
    const result = value(archive.pruneArchives({ ...f.options, currentRunId: 'next' }));
    expect(result.warnings).toEqual([expect.stringContaining(staging)]);
    expect(existsSync(staging)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('partial');
  });
  it('keeps live staging when another retention pass runs before publication', () => {
    const f = fixture(); put(f.tree, 'payload.txt', 'preserved');
    const result = saved(f, { onBeforeVerify: (path: string) => {
      const pruned = value(archive.pruneArchives({ ...f.options, currentRunId: 'other-run' }));
      expect.soft(existsSync(path)).toBe(true);
      expect.soft(pruned.warnings).toEqual([expect.stringContaining(path)]);
    } });
    value(archive.verifyArchive(result.archivePath));
    expect(readFileSync(join(f.tree, 'payload.txt'), 'utf8')).toBe('preserved');
  });
  it('round trips mixed base/index/work bytes, deletions, LF with autocrlf, ignored contents and empty dirs', () => {
    const f = fixture(true); mixed(f);
    const before = working(f.tree), index = git(f.tree, 'ls-files', '--stage', '-z'), status = git(f.tree, 'status', '--porcelain=v1', '-z');
    let staged = '';
    const result = saved(f, { onBeforeVerify: (path: string) => {
      staged = path;
      expect(dirname(path)).toBe(join(f.options.archiveRoot, '.staging'));
      expect(archiveSummary(f.root, now)).toMatchObject({ count: 0, totalBytes: 0 });
      expect(existsSync(join(path, 'manifest.json'))).toBe(true);
    } });
    expect(existsSync(staged)).toBe(false);
    expect(readdirSync(f.options.archiveRoot).sort()).toEqual(['.staging', relative(f.options.archiveRoot, result.archivePath)].sort());
    expect(archiveSummary(f.root, now)).toMatchObject({ count: 1, totalBytes: result.totalBytes });
    expect(readFileSync(join(result.archivePath, 'files/mixed.txt'))).toEqual(Buffer.from([0, 255, 1, 10]));
    expect(readFileSync(join(result.archivePath, 'staged/mixed.txt'), 'utf8')).toBe('index\n');
    value(archive.verifyArchive(result.archivePath)); discardFixtureTree(f);
    value(archive.restoreArchive(result.archivePath));
    expect(git(f.tree, 'symbolic-ref', 'HEAD')).toBe('refs/heads/candidate');
    expect(working(f.tree)).toEqual(before); expect(git(f.tree, 'ls-files', '--stage', '-z')).toBe(index);
    expect(git(f.tree, 'status', '--porcelain=v1', '-z')).toBe(status);
  });
  it('round trips many tracked deletions including staged deletions', () => {
    const f = fixture();
    for (let i = 0; i < 120; i++) put(f.tree, `many/${i}.txt`, `${i}\n`);
    git(f.tree, 'add', '.'); git(f.tree, 'commit', '-m', 'many');
    for (let i = 0; i < 120; i++) unlinkSync(join(f.tree, `many/${i}.txt`));
    git(f.tree, 'add', 'many/0.txt', 'many/1.txt'); age(f.tree);
    const before = working(f.tree), index = git(f.tree, 'ls-files', '--stage', '-z'), result = saved(f);
    discardFixtureTree(f); value(archive.restoreArchive(result.archivePath));
    expect(working(f.tree)).toEqual(before); expect(git(f.tree, 'ls-files', '--stage', '-z')).toBe(index);
  });
  it.skipIf(process.platform !== 'win32')('round trips non-ASCII names and paths over 260 characters', () => {
    const f = fixture(); const long = Array.from({ length: 8 }, (_, i) => `directory-${i}-${'x'.repeat(25)}`).join('/') + '/résumé-日本語.bin';
    put(f.tree, long, Buffer.from([0, 254, 127])); put(f.tree, 'é-資料.txt', 'raw\n'); age(f.tree);
    const before = working(f.tree), result = saved(f); discardFixtureTree(f);
    value(archive.restoreArchive(result.archivePath)); expect(working(f.tree)).toEqual(before);
  });
  it('bundles an unreferenced detached commit and restores after its objects are pruned', () => {
    const f = fixture(); git(f.tree, 'checkout', '--detach'); put(f.tree, 'unique.txt', 'detached\n');
    git(f.tree, 'add', '.'); git(f.tree, 'commit', '-m', 'detached');
    const head = git(f.tree, 'rev-parse', 'HEAD'); put(f.tree, 'leftover.bin', 'leftover'); age(f.tree);
    const before = working(f.tree), result = saved(f); expect(existsSync(join(result.archivePath, 'HEAD.bundle'))).toBe(true);
    discardFixtureTree(f); git(f.primary, 'reflog', 'expire', '--expire=now', '--all'); git(f.primary, 'gc', '--prune=now');
    value(archive.restoreArchive(result.archivePath)); expect(git(f.tree, 'rev-parse', 'HEAD')).toBe(head); expect(working(f.tree)).toEqual(before);
  });
  it('keeps restore detached at recorded HEAD when the branch moved', () => {
    const f = fixture(); mixed(f); const result = saved(f), head = git(f.tree, 'rev-parse', 'HEAD');
    discardFixtureTree(f); put(f.primary, 'new.txt', 'new'); git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'advance');
    git(f.primary, 'branch', '-f', 'candidate', 'HEAD'); value(archive.restoreArchive(result.archivePath));
    expect(git(f.tree, 'rev-parse', 'HEAD')).toBe(head); expect(git(f.tree, 'branch', '--show-current')).toBe('');
  });
  it('deletes a corrupt partial archive without changing the tree', () => {
    const f = fixture(); mixed(f); const before = working(f.tree);
    const result = archive.createArchive(f.tree, { ...f.options, onBeforeVerify: (path: string) => writeFileSync(join(path, 'files/mixed.txt'), 'corrupt') });
    expect(result.state).toBe('unknown'); expect(working(f.tree)).toEqual(before);
    expect(readdirSync(f.options.archiveRoot)).toEqual(['.staging']);
    expect(readdirSync(join(f.options.archiveRoot, '.staging'))).toEqual([]);
  });
  it('refuses restore over an existing path and rejects corrupt or unsafe manifests before writes', () => {
    const f = fixture(); mixed(f); const result = saved(f), before = working(f.tree);
    expect(archive.restoreArchive(result.archivePath).state).toBe('unknown'); expect(working(f.tree)).toEqual(before);
    const manifestPath = join(result.archivePath, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.entries[0].path = '../escape'; writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(archive.verifyArchive(result.archivePath).state).toBe('unknown');
  });
  it('enforces size and double-space bounds before any archive directory is written', () => {
    const f = fixture(); mixed(f);
    expect(archive.createArchive(f.tree, { ...f.options, maxArchiveBytes: 1 }).state).toBe('unknown');
    expect(existsSync(f.options.archiveRoot)).toBe(false);
    expect(archive.createArchive(f.tree, { ...f.options, freeBytes: () => 1 }).state).toBe('unknown');
    expect(existsSync(f.options.archiveRoot)).toBe(false);
    expect(archive.MAX_ARCHIVE_BYTES).toBe(2 * 1024 ** 3);
  });
  it('exposes the restore CLI', async () => {
    const f = fixture(); mixed(f); const result = saved(f), before = working(f.tree); discardFixtureTree(f);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['restore', result.archivePath])).toBe(0); expect(working(f.tree)).toEqual(before);
    expect(await main(['restore', result.archivePath])).toBe(1);
  });
  it('restores staged directory-to-file swaps after staged blobs have been pruned', () => {
    const f = fixture(); put(f.tree, 'swap/child.txt', 'old child'); git(f.tree, 'add', '.'); git(f.tree, 'commit', '-m', 'directory');
    unlinkSync(join(f.tree, 'swap/child.txt')); rmdirSync(join(f.tree, 'swap'));
    put(f.tree, 'swap', 'staged replacement'); git(f.tree, 'add', '-A'); put(f.tree, 'swap', 'working replacement'); age(f.tree);
    const before = working(f.tree), index = git(f.tree, 'ls-files', '--stage', '-z'), result = saved(f);
    discardFixtureTree(f); git(f.primary, 'reflog', 'expire', '--expire=now', '--all'); git(f.primary, 'gc', '--prune=now');
    value(archive.restoreArchive(result.archivePath)); expect(working(f.tree)).toEqual(before); expect(git(f.tree, 'ls-files', '--stage', '-z')).toBe(index);
  });
  it('leaves restored files recent so a user restore is a live-session signal', () => {
    const f = fixture(); mixed(f); const result = saved(f); discardFixtureTree(f); value(archive.restoreArchive(result.archivePath));
    expect(lstatSync(join(f.tree, 'mixed.txt')).mtimeMs).toBeGreaterThan(now - DAY);
  });
  it('rejects an actual sparse file above 2 GB before allocation', () => {
    const f = fixture(); put(f.tree, 'huge.bin', ''); truncateSync(join(f.tree, 'huge.bin'), archive.MAX_ARCHIVE_BYTES + 1); age(f.tree);
    const result = archive.createArchive(f.tree, f.options);
    expect(result).toMatchObject({ state: 'unknown', reason: expect.stringMatching(/ceiling/) }); expect(existsSync(f.options.archiveRoot)).toBe(false);
  });
  it('does not overwrite a same-day archive and detects missing/corrupt staged payloads', () => {
    const f = fixture(); mixed(f); const result = saved(f), manifest = readFileSync(join(result.archivePath, 'manifest.json'));
    expect(archive.createArchive(f.tree, f.options).state).toBe('unknown'); expect(readFileSync(join(result.archivePath, 'manifest.json'))).toEqual(manifest);
    writeFileSync(join(result.archivePath, 'staged/mixed.txt'), 'bad'); expect(archive.verifyArchive(result.archivePath).state).toBe('unknown');
    unlinkSync(join(result.archivePath, 'staged/mixed.txt')); expect(archive.verifyArchive(result.archivePath).state).toBe('unknown');
  });
  it('holds intent-to-add index entries instead of silently restoring them as staged files', () => {
    const f = fixture(); put(f.tree, 'intent.txt', 'intent only'); git(f.tree, 'add', '-N', 'intent.txt'); age(f.tree);
    const before = working(f.tree), index = git(f.tree, 'ls-files', '--debug');
    expect(archive.createArchive(f.tree, f.options).state).toBe('unknown');
    expect(working(f.tree)).toEqual(before); expect(git(f.tree, 'ls-files', '--debug')).toBe(index);
  });
  it.skipIf(process.platform !== 'win32')('does not follow junctions in source files or archive-root ancestors', () => {
    const f = fixture(); mixed(f); const target = join(f.root, 'shared'); mkdirSync(target); put(target, 'private.txt', 'outside bytes');
    const sourceLink = join(f.tree, 'ignored/link'), rootLink = join(f.root, 'root-link');
    symlinkSync(target, sourceLink, 'junction'); symlinkSync(target, rootLink, 'junction');
    const unlinkJunction = (path: string) => {
      const result = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-File', resolve('scripts/remove-worktree-junction.ps1'), '-ExpectedLinkType', 'Junction', '-ExpectedTarget', target, path], { env, windowsHide: true });
      if (result.status !== 0) throw new Error('Fixture junction cleanup failed');
    };
    try {
      expect(archive.createArchive(f.tree, f.options).state).toBe('unknown');
      unlinkJunction(sourceLink);
      expect(archive.createArchive(f.tree, { ...f.options, archiveRoot: join(rootLink, 'archives'), freeBytes: () => 10 * archive.MAX_ARCHIVE_BYTES }).state).toBe('unknown');
      expect(readdirSync(target)).toEqual(['private.txt']); expect(readFileSync(join(target, 'private.txt'), 'utf8')).toBe('outside bytes');
    } finally {
      if (existsSync(sourceLink)) unlinkJunction(sourceLink);
      unlinkJunction(rootLink);
    }
  });
});

describe('U7 idle journal and policy', { timeout: 60_000 }, () => {
  it('rejects thirteen elapsed days despite observations in fifteen UTC buckets', () => {
    const f = fixture(), clock = Date.parse('2026-09-27T00:01:00Z');
    const head = ok(git(f.tree, 'rev-parse', 'HEAD'));
    for (let day = 14; day >= 0; day--) {
      value(journal.appendIdleObservation(f.tree, { head, live: negative() }, {
        ...f.options, now: () => day === 0 ? clock : Date.parse('2026-09-27T23:59:00Z') - day * DAY,
      }));
    }
    expect(journal.idleEvidence(f.tree, { ...f.options, now: () => clock }).state).toBe('negative');
  });
  it.each([false, true])('accepts 16 clear UTC days with historical observations five minutes later (older history=%s)', older => {
    const f = fixture(), clock = Math.floor(now / DAY) * DAY + 12 * 3_600_000;
    const head = ok(git(f.tree, 'rev-parse', 'HEAD'));
    for (let day = older ? 16 : 15; day >= 0; day--) {
      value(journal.appendIdleObservation(f.tree, { head, live: negative() }, {
        ...f.options, now: () => clock - day * DAY + (day === 0 ? 0 : 5 * 60_000),
      }));
    }
    expect(journal.idleEvidence(f.tree, { ...f.options, now: () => clock })).toMatchObject({ state: 'ok', value: { consecutiveDays: 16 } });
  });
  it('holds missing, short, interrupted and unreadable history; accepts 16 clear days', async () => {
    const f = fixture(); mixed(f);
    expect(journal.idleEvidence(f.tree, f.options).state).toBe('unknown');
    history(f, 13); expect(journal.idleEvidence(f.tree, f.options).state).toBe('negative');
    unlinkSync(f.options.journalPath); history(f); expect(journal.idleEvidence(f.tree, f.options).state).toBe('ok');
    const facts = await snapshot(f);
    const plan = value(await planWorktrees(facts, { prSnapshot: ok([]), idleJournalOptions: f.options }));
    expect(plan.worktrees.find(t => resolve(t.path) === f.tree)?.disposition).toBe('archive');
    const open = value(await planWorktrees(facts, { prSnapshot: ok([{ number: 1, headRefName: 'candidate', headRefOid: git(f.tree, 'rev-parse', 'HEAD'), state: 'OPEN', baseRefName: 'main' }]), idleJournalOptions: f.options }));
    expect(open.worktrees.find(t => resolve(t.path) === f.tree)?.reason).toBe('open-pr');
    unlinkSync(f.options.journalPath); history(f, 16, 5); expect(journal.idleEvidence(f.tree, f.options).state).toBe('negative');
    writeFileSync(f.options.journalPath, 'broken\n'); expect(journal.idleEvidence(f.tree, f.options).state).toBe('unknown');
  });
  it('holds gaps, unknown signals, duplicate-day live signals, future observations and fresh files', () => {
    const f = fixture(); mixed(f); history(f);
    const rows = readFileSync(f.options.journalPath, 'utf8').trim().split('\n');
    writeFileSync(f.options.journalPath, rows.filter((_, i) => i !== 8).join('\n') + '\n');
    expect(journal.idleEvidence(f.tree, f.options).state).toBe('unknown');
    writeFileSync(f.options.journalPath, rows.join('\n') + '\n');
    value(journal.appendIdleObservation(f.tree, { head: ok(git(f.tree, 'rev-parse', 'HEAD')), live: unknown('lease unreadable') }, f.options));
    expect(journal.idleEvidence(f.tree, f.options).state).not.toBe('ok');
    writeFileSync(f.options.journalPath, rows.join('\n') + '\n'); put(f.tree, 'ignored/fresh.txt', 'fresh');
    expect(journal.idleEvidence(f.tree, f.options).state).toBe('negative');
  });
  it('holds duplicate-day live signals, future observations and a changed HEAD', () => {
    const f = fixture(); mixed(f); history(f); const original = readFileSync(f.options.journalPath);
    value(journal.appendIdleObservation(f.tree, { head: ok(git(f.tree, 'rev-parse', 'HEAD')), live: ok({ reasons: ['transcript'] }) }, f.options));
    value(journal.appendIdleObservation(f.tree, { head: ok(git(f.tree, 'rev-parse', 'HEAD')), live: negative() }, f.options));
    expect(journal.idleEvidence(f.tree, f.options).state).toBe('negative');
    writeFileSync(f.options.journalPath, original);
    value(journal.appendIdleObservation(f.tree, { head: ok(git(f.tree, 'rev-parse', 'HEAD')), live: negative() }, { ...f.options, now: () => now + DAY }));
    expect(journal.idleEvidence(f.tree, f.options).state).toBe('unknown');
    writeFileSync(f.options.journalPath, original); git(f.tree, 'commit', '-m', 'changed head'); age(f.tree);
    expect(journal.idleEvidence(f.tree, f.options).state).toBe('negative');
  });
});

describe('U7 verified cleanup and pruning', { timeout: 60_000 }, () => {
  it('U2-T8 holds a vanished archive source without half-removed promotion', async () => {
    const f = fixture(); mixed(f); history(f);
    const baseline = await snapshot(f), result = saved(f);
    discardFixtureTree(f);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
    expect(cleaned).toMatchObject({ disposition: 'hold', reasonCode: 'registration-vanished', stopReason: null, mutations: [], archivePath: result.archivePath });
    expect(existsSync(result.archivePath)).toBe(true);
  });
  it.each([false, true])('U2-fix preserves the vanished cause after archive mutation (missing .git=%s)', async missingGit => {
    const f = fixture(); mixed(f); history(f);
    const baseline = await snapshot(f), result = saved(f);
    let unlinks = 0;
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, { ...f.options, onBeforeMutation: event => {
      if (event.kind !== 'unlink' || ++unlinks !== 2) return;
      const admin = join(f.primary, '.git', 'worktrees', 'candidate');
      expect(resolve(admin).startsWith(resolve(f.root) + sep)).toBe(true); rmSync(admin, { recursive: true });
      if (missingGit) unlinkSync(join(f.tree, '.git'));
    } }));
    expect(cleaned).toMatchObject({ disposition: 'pending', reason: 'Classification registration vanished',
      reasonCode: 'registration-vanished', stopReason: missingGit ? 'half-removed' : 'mutated-then-held',
      mutations: [{ kind: 'archive-unlink' }], archivePath: result.archivePath });
    expect(unlinks).toBe(2); expect(existsSync(result.archivePath)).toBe(true);
  });
  it('U2 stops a tree half-removed before archive cleanup can recheck it', async () => {
    const f = fixture(); mixed(f); history(f);
    const baseline = await snapshot(f), result = saved(f);
    unlinkSync(join(f.tree, '.git'));
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
    expect(cleaned).toMatchObject({ disposition: 'hold', stopReason: 'half-removed', mutations: [] });
    expect(existsSync(result.archivePath)).toBe(true);
  });
  it.each(['.staging-x', '.staging'])('publishes, reports, prunes and restores a worktree named %s', async name => {
    const f = fixture(), renamed = join(f.root, name);
    git(f.primary, 'worktree', 'move', f.tree, renamed); f.tree = renamed;
    mixed(f); history(f);
    const baseline = await snapshot(f), before = working(f.tree), index = git(f.tree, 'ls-files', '--stage', '-z');
    const result = saved(f), cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
    expect(cleaned.disposition).toBe('clean');
    if (!('plan' in cleaned)) throw new Error('Missing clean handoff');
    const removed = value(await executeRemovals(cleaned.plan, cleaned.snapshot, { activityOptions: f.options.activityOptions }));
    expect(removed.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition).toBe('removed');
    expect(existsSync(f.tree)).toBe(false);
    expect.soft(archiveSummary(f.root, now)).toMatchObject({ count: 1, totalBytes: result.totalBytes });
    expect(value(archive.pruneArchives({ ...f.options, currentRunId: 'next' })).pruned).toEqual([]);
    expect.soft(existsSync(result.archivePath)).toBe(true);
    value(archive.restoreArchive(result.archivePath));
    expect(working(f.tree)).toEqual(before);
    expect(git(f.tree, 'ls-files', '--stage', '-z')).toBe(index);
  });
  it('holds changed bytes after verification and keeps the archive', async () => {
    const f = fixture(); mixed(f); history(f); const baseline = await snapshot(f), result = saved(f);
    put(f.tree, 'mixed.txt', 'changed'); age(f.tree);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
    expect(cleaned.disposition).toBe('hold'); expect(readFileSync(join(f.tree, 'mixed.txt'), 'utf8')).toBe('changed');
    expect(cleaned.mutations).toEqual([]); expect(cleaned.stopReason).toBeNull();
    expect(existsSync(result.archivePath)).toBe(true);
  });
  it('leaves a backdated file created inside an ignored directory pending and untouched', async () => {
    const f = fixture(); mixed(f); history(f); const baseline = await snapshot(f);
    const result = saved(f, { onBeforeVerify: () => { put(f.tree, 'ignored/deep/new.bin', 'new'); age(f.tree); } });
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
    expect(cleaned.disposition).toBe('pending'); expect(readFileSync(join(f.tree, 'ignored/deep/new.bin'), 'utf8')).toBe('new');
    expect(existsSync(f.tree)).toBe(true);
  });
  it('hands a clean snapshot to U5, then restores the removed worktree exactly', async () => {
    const f = fixture(true); mixed(f); history(f); const baseline = await snapshot(f), before = working(f.tree), index = git(f.tree, 'ls-files', '--stage', '-z');
    const result = saved(f), cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
    expect(cleaned.disposition, JSON.stringify(cleaned)).toBe('clean');
    expect(cleaned.mutations.map((entry: { kind: string }) => entry.kind)).toEqual(expect.arrayContaining(['archive-unlink', 'archive-restore', 'archive-timestamp', 'archive-rmdir']));
    if (!('plan' in cleaned)) throw new Error('Missing clean handoff');
    const removed = value(await executeRemovals(cleaned.plan, cleaned.snapshot, { activityOptions: f.options.activityOptions }));
    expect(removed.worktrees.find(t => resolve(t.path) === f.tree)?.disposition).toBe('removed');
    value(archive.restoreArchive(result.archivePath)); expect(working(f.tree)).toEqual(before); expect(git(f.tree, 'ls-files', '--stage', '-z')).toBe(index);
  });
  it.skipIf(process.platform !== 'win32')('archives and removes an unchanged one-hop junction with its classification target baseline', async () => {
    const f = fixture(), target = join(f.root, 'shared'), link = join(f.tree, 'node_modules');
    put(target, '.package-lock.json', '{"packages":{}}'); put(target, 'package/index.js', 'shared bytes');
    put(f.tree, 'leftover.txt', 'preserve'); symlinkSync(target, link, 'junction');
    const before = working(target), count = Object.keys(before.files).length + before.dirs.length;
    const lockHash = createHash('sha256').update(readFileSync(join(target, '.package-lock.json'))).digest('hex');
    try {
      age(f.tree); history(f);
      const baseline = await snapshot(f), original = baseline.worktrees.find(tree => resolve(tree.path) === f.tree)!;
      expect(original.targetBaseline).toMatchObject({ state: 'ok', value: { count, topLevelCount: 2, lockHash } });
      const plan = value(await planWorktrees(baseline, { prSnapshot: ok([]), idleJournalOptions: f.options }));
      expect(plan.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition).toBe('archive');
      const result = saved(f, { snapshot: baseline });
      const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
      expect(cleaned.disposition, JSON.stringify(cleaned)).toBe('clean');
      if (!('plan' in cleaned)) throw new Error('Missing clean handoff');
      const handoff = cleaned.snapshot.worktrees.find((tree: { path: string; links?: unknown; targetBaseline?: unknown }) => resolve(tree.path) === f.tree)!;
      expect(handoff.links).toEqual(original.links);
      expect(handoff.targetBaseline).toBe(original.targetBaseline);
      const removed = value(await executeRemovals(cleaned.plan, cleaned.snapshot, { activityOptions: f.options.activityOptions }));
      expect(removed.halted).toBe(false);
      expect(removed.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition, JSON.stringify(removed)).toBe('removed');
      expect(existsSync(f.tree)).toBe(false);
      const after = working(target);
      expect(Object.keys(after.files).length + after.dirs.length).toBe(count);
      expect(createHash('sha256').update(readFileSync(join(target, '.package-lock.json'))).digest('hex')).toBe(lockHash);
      expect(after).toEqual(before); value(archive.verifyArchive(result.archivePath));
    } finally { if (lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()) rmdirSync(link); }
  });
  it.skipIf(process.platform !== 'win32')('holds a hidden node_modules junction at the archive-to-removal handoff', async () => {
    const f = fixture(); put(f.tree, 'leftover.txt', 'preserve');
    put(f.tree, 'node_modules/.package-lock.json', '{"packages":{}}');
    mkdirSync(join(f.tree, 'node_modules/pkg'));
    age(f.tree); history(f);
    const baseline = await snapshot(f), result = saved(f);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, f.options));
    expect(cleaned.disposition, JSON.stringify(cleaned)).toBe('clean');
    if (!('plan' in cleaned)) throw new Error('Missing clean handoff');
    const target = join(f.root, 'shared'), link = join(f.tree, 'node_modules/pkg/cache');
    put(target, 'sentinel', 'keep'); symlinkSync(target, link, 'junction');
    try {
      const mutations: string[] = [];
      const removed = value(await executeRemovals(cleaned.plan, cleaned.snapshot, { activityOptions: f.options.activityOptions,
        onBeforeMutation: ({ kind }) => { mutations.push(kind); throw new Error('Fixture guard'); } }));
      expect(removed.worktrees[0]).toMatchObject({ disposition: 'hold', reason: 'Pre-removal link scan unavailable' });
      expect(mutations).toEqual([]); expect(existsSync(f.tree)).toBe(true);
      expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep');
    } finally { rmdirSync(link); }
  });
  it('holds missing safety evidence and a newly open PR without touching leftovers', async () => {
    const f = fixture(); mixed(f); history(f); const baseline = await snapshot(f), result = saved(f), before = working(f.tree);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, { ...f.options, prSnapshot: unknown('offline') }));
    expect(cleaned.disposition).toBe('hold'); expect(working(f.tree)).toEqual(before);
    const open = value(await archive.prepareArchivedTree(result.archivePath, baseline, { ...f.options, prSnapshot: ok([{ number: 1, headRefName: 'candidate', headRefOid: git(f.tree, 'rev-parse', 'HEAD'), state: 'OPEN', baseRefName: 'main' }]) }));
    expect(open.disposition).toBe('hold'); expect(working(f.tree)).toEqual(before);
  });
  it.each(['work-delete.txt', 'staged.txt'])('preserves %s recreated or changed between deletion and git restore', async (file) => {
    const f = fixture(); mixed(f); history(f); const baseline = await snapshot(f), result = saved(f);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, { ...f.options, onBeforeMutation: (event: { kind: string }) => {
      if (event.kind === 'restore') { put(f.tree, file, 'concurrent user bytes'); age(f.tree); }
    } }));
    expect(cleaned.disposition).toBe('pending'); expect(readFileSync(join(f.tree, file), 'utf8')).toBe('concurrent user bytes');
    expect(cleaned.stopReason).toBe('mutated-then-held');
    expect(cleaned.mutations).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'archive-unlink' })]));
  });
  it('holds if an index write or a transcript appears at the first mutation boundary', async () => {
    const f = fixture(); mixed(f); history(f); const baseline = await snapshot(f), result = saved(f), before = working(f.tree);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, { ...f.options, onBeforeMutation: (event: { kind: string }) => {
      if (event.kind === 'cleanup') git(f.tree, 'add', 'mixed.txt');
    } }));
    expect(cleaned.disposition).toBe('hold'); expect(working(f.tree)).toEqual(before);
  });
  it('does not backdate unchanged HEAD files that change while Git restores other paths', async () => {
    const f = fixture(); mixed(f); history(f); const baseline = await snapshot(f), result = saved(f);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, { ...f.options, onBeforeMutation: (event: { kind: string }) => {
      if (event.kind === 'restore') put(f.tree, '.gitignore', 'new user rules\n');
    } }));
    expect(cleaned.disposition).toBe('pending'); expect(readFileSync(join(f.tree, '.gitignore'), 'utf8')).toBe('new user rules\n');
  });
  it('rechecks new live transcripts immediately before the first unlink', async () => {
    const f = fixture(); mixed(f); history(f); const baseline = await snapshot(f), result = saved(f), before = working(f.tree);
    const cleaned = value(await archive.prepareArchivedTree(result.archivePath, baseline, { ...f.options, onBeforeMutation: (event: { kind: string }) => {
      if (event.kind === 'unlink') put(f.home, '.codex/sessions/new.jsonl', JSON.stringify({ type: 'session_meta', payload: { cwd: f.tree } }) + '\n');
    } }));
    expect(cleaned.disposition).toBe('hold'); expect(working(f.tree)).toEqual(before);
  });
  it('holds recent tracked files even when their path is build-output allowlisted', () => {
    const f = fixture(); put(f.tree, 'coverage/tracked.txt', 'base'); git(f.tree, 'add', '-f', 'coverage/tracked.txt'); git(f.tree, 'commit', '-m', 'tracked build path');
    mixed(f); history(f); put(f.tree, 'coverage/tracked.txt', 'recent');
    expect(journal.idleEvidence(f.tree, f.options).state).toBe('negative');
  });
  it('prunes expired archives then oldest to size, protects current run, and warns at day 179', () => {
    const f = fixture(); mixed(f);
    const a = saved(f, { now: () => now - 181 * DAY, runId: 'old' });
    const b = saved(f, { now: () => now - 179 * DAY, runId: 'warning' });
    const c = saved(f, { now: () => now - 100 * DAY, runId: 'middle' });
    const d = saved(f, { now: () => now - 200 * DAY, runId: 'current' });
    discardFixtureTree(f);
    const result = value(archive.pruneArchives({ ...f.options, currentRunId: 'current', maxTotalBytes: 1 }));
    expect(result.pruned).toEqual([a.archivePath, b.archivePath, c.archivePath]);
    expect(result.warnings).toContain(b.archivePath); expect(existsSync(d.archivePath)).toBe(true);
  });
  it.each(['registered', 'on-disk', 'stale-registration'])('U2 retention protects an old source that is %s', kind => {
    const f = fixture(); mixed(f);
    const savedArchive = saved(f, { now: () => now - 181 * DAY, runId: 'old' });
    if (kind === 'on-disk') { discardFixtureTree(f); mkdirSync(f.tree); }
    if (kind === 'stale-registration') {
      expect(resolve(f.tree).startsWith(resolve(f.root) + sep)).toBe(true);
      rmSync(f.tree, { recursive: true });
    }
    const result = value(archive.pruneArchives({ ...f.options, currentRunId: 'next', maxTotalBytes: 0 }));
    expect(result.pruned).toEqual([]); expect(existsSync(savedArchive.archivePath)).toBe(true);
  });
});
