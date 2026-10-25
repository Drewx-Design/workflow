import './worktree-cleanup-test-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, toNamespacedPath } from 'node:path';
import { runRelease } from '../lib/worktree-cleanup/release.mjs';
import { main } from '../worktree-cleanup.mjs';
import { inventory, isWithin, normalizePath } from '../lib/worktree-cleanup/inventory.mjs';
import { linkIndexPath, projectLinkIndex, readLinkIndex, writeLinkIndex } from '../lib/worktree-cleanup/link-index.mjs';
import { acquireRunLock, coordinationDirectory, defaultReportRoot, writeRunReport } from '../lib/worktree-cleanup/report.mjs';
import { executeRemovals } from '../lib/worktree-cleanup/remove.mjs';
import { collectActivity } from '../lib/worktree-cleanup/activity.mjs';
import { ok, probe, unknown } from '../lib/worktree-cleanup/probe.mjs';

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readdirSync: vi.fn(fs.readdirSync), readFileSync: vi.fn(fs.readFileSync) };
});
const roots: string[] = [];
const env: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV };
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
function cleanup(root: string) {
  if (!isWithin(root, tmpdir()) || normalizePath(root) === normalizePath(tmpdir())) throw new Error('Unsafe cleanup');
  for (const name of readdirSync(root)) {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) { if (process.platform === 'win32') rmdirSync(path); else unlinkSync(path); }
    else if (stat.isDirectory()) cleanup(path);
  }
  rmSync(root, { recursive: true, force: true });
}
afterEach(() => { vi.restoreAllMocks(); vi.mocked(readdirSync).mockReset(); vi.mocked(readFileSync).mockReset(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) cleanup(root); }, 60_000);
function packagesAt(path: string) { mkdirSync(path); writeFileSync(join(path, '.package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {} })); }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-release-')); roots.push(root);
  const primary = join(root, 'primary'), home = join(root, 'home'), reportRoot = join(root, 'state');
  mkdirSync(primary); mkdirSync(home);
  git(primary, 'init', '-b', 'main'); git(primary, 'config', 'user.email', 'fixture@example.invalid'); git(primary, 'config', 'user.name', 'Fixture');
  git(primary, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(primary, '.gitignore'), '.worktrees/\nnode_modules/\n'); writeFileSync(join(primary, 'tracked.txt'), 'original\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'fixture');
  const add = (name: string, path = join(root, name)) => { git(primary, 'worktree', 'add', '-b', name, path); return path; };
  const tree = add('unit');
  const scan = () => { const result = inventory({ repositoryPath: primary, runnerPath: primary }); if (result.state !== 'ok') throw new Error('Inventory failed'); return result.value; };
  const index = () => writeLinkIndex(reportRoot, scan());
  const link = (source: string, target: string, name = 'node_modules') => { const path = join(source, name); mkdirSync(dirname(path), { recursive: true }); symlinkSync(target, path, 'junction'); return path; };
  const transcript = (session = 'owner') => {
    const folder = join(home, '.codex', 'sessions'); mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'rollout.jsonl'), [
      { type: 'session_meta', payload: { id: session, cwd: primary } },
      { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git status', workdir: tree }) } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n');
  };
  const runGh = vi.fn(() => ok('[]'));
  const options = { targetPath: tree, repositoryPath: primary, reportRoot, ghPath: process.execPath, ownerSession: 'owner', runGh, activityOptions: { homeDirectory: home } };
  index();
  return { root, primary, tree, home, reportRoot, add, scan, index, link, transcript, runGh, options };
}
function rows(root: string) { return readFileSync(join(root, 'owner-release-journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
type Fixture = ReturnType<typeof fixture>;
function intact(f: Fixture) { expect(existsSync(join(f.tree, '.git'))).toBe(true); expect(readFileSync(join(f.tree, 'tracked.txt'), 'utf8')).toBe('original\n'); }

describe('owner release coordinator', { timeout: 30_000 }, () => {
  it.each(['published_verified', 'corrupt'])('checks default-root %s binding when --report-root is custom', async state => {
    const f = fixture(); vi.stubEnv('LOCALAPPDATA', join(f.root, 'local-app-data'));
    const path = join(defaultReportRoot(), 'snapshots', createHash('sha256').update(normalizePath(f.tree)).digest('hex') + '.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, state === 'corrupt' ? '{broken' : JSON.stringify({ schema: 'worktree-cleanup-snapshot/v1', treePath: normalizePath(f.tree), state }));
    const remove = vi.fn(executeRemovals), rename = vi.fn(renameSync);
    const result = await runRelease(f.options, { executeRemovals: remove, rename });
    expect(result).toMatchObject({ exitCode: 3, reasonCode: 'snapshot-bound', mutations: [] });
    expect(remove).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled(); intact(f);
  });

  it.each(['not_pushed', 'pushed_unverified', 'published_verified', 'corrupt'])('refuses owner release with a %s snapshot journal before mutation', async state => {
    const f = fixture(), path = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(f.tree)).digest('hex') + '.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, state === 'corrupt' ? '{broken' : JSON.stringify({ schema: 'worktree-cleanup-snapshot/v1', treePath: normalizePath(f.tree), state }));
    const before = readFileSync(path), remove = vi.fn(executeRemovals), rename = vi.fn(renameSync);
    const result = await runRelease(f.options, { executeRemovals: remove, rename });
    expect(result).toMatchObject({ exitCode: 3, outcome: 'refused', reasonCode: 'snapshot-bound', mutations: [] });
    expect(remove).not.toHaveBeenCalled(); expect(rename).not.toHaveBeenCalled(); intact(f);
    expect(readFileSync(path)).toEqual(before); expect(rows(f.reportRoot)[0]).toMatchObject({ reasonCode: 'snapshot-bound', mutations: [] });
  });

  it.each(['removed', 'none'])('preserves ordinary owner release with a %s snapshot journal', async state => {
    const f = fixture(), path = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(f.tree)).digest('hex') + '.json');
    if (state === 'removed') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ schema: 'worktree-cleanup-snapshot/v1', treePath: normalizePath(f.tree), state }));
    }
    const before = state === 'removed' ? readFileSync(path) : null;
    const result = await runRelease(f.options);
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, outcome: 'removed', reasonCode: 'removed' });
    expect(existsSync(f.tree)).toBe(false); expect(git(f.primary, 'rev-parse', 'refs/heads/unit')).toBe(git(f.primary, 'rev-parse', 'HEAD'));
    if (before) expect(readFileSync(path)).toEqual(before); else expect(existsSync(path)).toBe(false);
  });

  it('rechecks snapshot binding before the owner-release rename', async () => {
    const f = fixture(), rename = vi.fn(renameSync);
    const result = await runRelease(f.options, {
      executeRemovals: async (...args: Parameters<typeof executeRemovals>) => {
        const path = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(f.tree)).digest('hex') + '.json');
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({ schema: 'worktree-cleanup-snapshot/v1', treePath: normalizePath(f.tree), state: 'published_verified' }));
        return executeRemovals(...args);
      }, rename,
    });
    expect(result).toMatchObject({ exitCode: 3, reasonCode: 'snapshot-bound', mutations: [] });
    expect(rename).not.toHaveBeenCalled(); intact(f);
  });

  it.skipIf(process.platform !== 'win32')('dangling U2-T8 owner release removes a missing chain without links-unknown', async () => {
    const f = fixture(), removed = join(f.root, 'removed'), target = join(removed, 'node_modules');
    const middleRoot = join(f.root, 'foreign'), middle = join(middleRoot, 'node_modules');
    mkdirSync(target, { recursive: true }); f.link(middleRoot, target); f.link(f.tree, middle);
    rmdirSync(target); rmdirSync(removed);
    // The existing index predates this chain: admission must use the live target scan.
    f.transcript();
    const mutations: string[] = [];
    const result = await runRelease(f.options, {
      executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: Parameters<typeof executeRemovals>[2]) =>
        executeRemovals(plan, snapshot, { ...options, onAfterMutation: event => { mutations.push(event.kind); } }),
    });
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, outcome: 'removed', reasonCode: 'removed' });
    expect(mutations).toEqual(['unlink-junction', 'remove', 'prune']);
    expect(lstatSync(middle).isSymbolicLink()).toBe(true); expect(existsSync(f.tree)).toBe(false);
    expect(rows(f.reportRoot)[0]).toMatchObject({ outcome: 'removed', reasonCode: 'removed' });
  });
  it('U4-T1 completes both owner releases after B waits behind A', async () => {
    const f = fixture(), secondTarget = f.add('second'); f.index();
    let queued!: () => void, resume!: () => void;
    const waiting = new Promise<void>(accept => { queued = accept; });
    const resumed = new Promise<void>(accept => { resume = accept; });
    let second!: ReturnType<typeof runRelease>;
    const first = await runRelease(f.options, {
      executeRemovals: async (...args: Parameters<typeof executeRemovals>) => {
        second = runRelease({ ...f.options, targetPath: secondTarget }, { waitForLock: async () => { queued(); await resumed; } });
        await waiting;
        return executeRemovals(...args);
      },
    });
    resume();
    expect(first).toMatchObject({ exitCode: 0, outcome: 'removed' });
    expect(await second).toMatchObject({ exitCode: 0, outcome: 'removed' });
    expect(rows(f.reportRoot)).toHaveLength(2);
  });
  it('U4-T13 starts the full mutation budget after nine minutes waiting', async () => {
    const f = fixture(); let clock = Date.now(), deadline = 0;
    const result = await runRelease({ ...f.options, now: () => clock }, {
      acquireRunLock: async (repository: string, root: string, kind: string) => {
        const unlock = await acquireRunLock(repository, root, kind); clock += 9 * 60_000; return unlock;
      },
      executeRemovals: async (...args: Parameters<typeof executeRemovals>) => {
        deadline = args[2]!.softDeadline!; return executeRemovals(...args);
      },
    });
    expect(result).toMatchObject({ exitCode: 0, outcome: 'removed', pruneDeferred: false });
    expect(deadline - clock).toBe(10 * 60_000);
  });
  it('U4-T14 journals deferred prune after successful removal under unrelated churn', async () => {
    const f = fixture(); let changed = false;
    const result = await runRelease(f.options, { runProbe: ((exe, args, options) => {
      const output = probe(exe, args, options);
      if (args.includes('worktree') && args.includes('remove') && !changed) { changed = true; f.add('arrived'); }
      if (args.includes('--dry-run') && changed) return { ...output, stderr: 'Removing worktrees/unknown: gitdir file points to non-existent location\n' };
      return output;
    }) satisfies typeof probe });
    expect(changed).toBe(true);
    expect(result).toMatchObject({ exitCode: 0, outcome: 'removed', pruneDeferred: true });
    expect(rows(f.reportRoot)[0]).toMatchObject({ outcome: 'removed', pruneDeferred: true });
    expect(existsSync(join(f.root, 'arrived'))).toBe(true);
  });
  it('returns refusal exit 3 and journals a relative CLI target', async () => {
    const f = fixture(), output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['release', 'relative', '--repo', f.primary, '--report-root', f.reportRoot])).toBe(3);
    expect(rows(f.reportRoot)[0]).toMatchObject({ target: 'relative', outcome: 'refused', reasonCode: 'absolute-path-required' });
    expect(output).toHaveBeenCalledOnce(); intact(f);
  });
  it('removes only the clean owner-mentioned target, keeps its branch and journals once without fetch', async () => {
    const f = fixture(), sibling = f.add('sibling'); f.transcript();
    const calls: string[][] = []; let removalTimeout = 0;
    const runProbe: typeof probe = (exe, args, extra) => { calls.push(args); if (args.includes('remove')) removalTimeout = extra?.timeout ?? 0; return probe(exe, args, extra); };
    const result = await runRelease(f.options, { runProbe });
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0, outcome: 'removed', reasonCode: 'removed' });
    expect(existsSync(f.tree)).toBe(false); expect(existsSync(sibling)).toBe(true);
    expect(git(f.primary, 'rev-parse', 'unit')).toBe(git(f.primary, 'rev-parse', 'HEAD'));
    expect(git(f.primary, 'worktree', 'list', '--porcelain')).not.toContain(f.tree.replaceAll('\\', '/'));
    expect(rows(f.reportRoot)).toEqual([expect.objectContaining({ target: f.tree, branch: 'refs/heads/unit', head: expect.stringMatching(/^[a-f0-9]{40}$/), outcome: 'removed', ownerSession: 'owner', overriddenEvidence: expect.any(Object), startedAt: expect.any(Number), finishedAt: expect.any(Number) })]);
    expect(calls.some(args => args.includes('fetch') || args.includes('rev-list'))).toBe(false);
    expect(calls.filter(args => args.includes('remove'))).toHaveLength(1);
    expect(removalTimeout).toBeGreaterThan(8 * 60_000);
    expect(removalTimeout).toBeLessThan(10 * 60_000);
    expect(f.runGh.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  it('refuses invoked-from-target before inspection and journals the refusal', async () => {
    const f = fixture(), cwd = process.cwd(), scan = vi.fn(inventory);
    try { process.chdir(f.tree); expect(await runRelease(f.options, { inventory: scan })).toMatchObject({ exitCode: 3, reasonCode: 'invoked-from-target' }); }
    finally { process.chdir(cwd); }
    expect(scan).not.toHaveBeenCalled(); intact(f); expect(rows(f.reportRoot)).toHaveLength(1);
  });
  it.each([
    { ownerSession: undefined, claude: undefined, codex: undefined },
    { ownerSession: '', claude: '', codex: '' },
    { ownerSession: ' \t ', claude: ' \t ', codex: ' \n ' },
  ])('refuses without an owner session before lock or inspection ($ownerSession)', async ({ ownerSession, claude, codex }) => {
    const f = fixture(), lock = vi.fn(acquireRunLock), scan = vi.fn(inventory), runProbe = vi.fn(probe);
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', claude); vi.stubEnv('CODEX_THREAD_ID', codex);
    expect(await runRelease({ ...f.options, ownerSession }, { acquireRunLock: lock, inventory: scan, runProbe }))
      .toMatchObject({ exitCode: 3, outcome: 'refused', reasonCode: 'owner-session-required', ownerSession: null, mutations: [] });
    expect(lock).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled(); expect(runProbe).not.toHaveBeenCalled();
    expect(f.runGh).not.toHaveBeenCalled(); intact(f);
    expect(rows(f.reportRoot)).toEqual([expect.objectContaining({ reasonCode: 'owner-session-required', ownerSession: null })]);
  });
  it.each(['nightly', 'owner-release'])('refuses a nightly holder or expires behind %s and preserves its owner record', async kind => {
    const f = fixture(), unlock = await acquireRunLock(f.primary, f.reportRoot, kind);
    const owner = join(coordinationDirectory(f.primary), 'owner.json'), before = readFileSync(owner, 'utf8');
    const scan = vi.fn(inventory); let clock = Date.now();
    const waitForLock = vi.fn(async () => { clock += 600_000; });
    try {
      expect(JSON.parse(before).kind).toBe(kind);
      expect(await runRelease({ ...f.options, now: () => clock }, { inventory: scan, waitForLock })).toMatchObject({ exitCode: 3, reasonCode: kind === 'nightly' ? 'nightly-running' : 'release-running' });
      expect(waitForLock).toHaveBeenCalledTimes(kind === 'nightly' ? 0 : 1);
      expect(readdirSync(coordinationDirectory(f.primary)).filter(name => name.endsWith('.ticket.json'))).toEqual([]);
      expect(scan).not.toHaveBeenCalled(); expect(readFileSync(owner, 'utf8')).toBe(before); intact(f);
    } finally { await unlock(); }
  });
  it.each(['relative', 'unregistered', 'primary'])('refuses %s before inventory', async kind => {
    const f = fixture(), scan = vi.fn(inventory);
    const targetPath = kind === 'relative' ? 'relative' : kind === 'primary' ? f.primary : join(f.root, 'missing');
    expect(await runRelease({ ...f.options, targetPath }, { inventory: scan })).toMatchObject({ exitCode: 3, reasonCode: kind === 'relative' ? 'absolute-path-required' : kind === 'primary' ? 'exempt' : 'not-registered' });
    expect(scan).not.toHaveBeenCalled(); intact(f); expect(rows(f.reportRoot)).toHaveLength(1);
  });
  it.skipIf(process.platform !== 'win32').each(['elapsed', 'mutation-budget', 'unlink-budget'])('refuses deadline for %s and releases the lock', async kind => {
    const f = fixture(), start = Date.now(); let clock = start;
    if (kind === 'unlink-budget') { const packages = join(f.primary, 'node_modules'); packagesAt(packages); f.link(f.tree, packages); f.index(); clock = Date.now(); }
    const result = await runRelease({ ...f.options, now: () => clock }, {
      executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: Parameters<typeof executeRemovals>[2]) => {
        clock += kind === 'elapsed' ? 600_001 : kind === 'unlink-budget' ? 599_000 : 450_000;
        return executeRemovals(plan, snapshot, options);
      },
    });
    expect(result).toMatchObject({ exitCode: 3, reasonCode: 'deadline' }); intact(f);
    if (kind === 'unlink-budget') expect(lstatSync(join(f.tree, 'node_modules')).isSymbolicLink()).toBe(true);
    const unlock = await acquireRunLock(f.primary, f.reportRoot); await unlock();
  });
  it.skipIf(process.platform !== 'win32')('reserves the following removal budget before unlinking a junction', async () => {
    const f = fixture(), packages = join(f.primary, 'node_modules'); packagesAt(packages); f.link(f.tree, packages); f.index();
    let clock = Date.now(); const mutations: string[] = [], rename = vi.fn(renameSync);
    const result = await runRelease({ ...f.options, now: () => clock }, {
      rename,
      executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: Parameters<typeof executeRemovals>[2]) => {
        // 150 seconds fits the unlink probe, but not the 180-second removal.
        clock += 450_000;
        return executeRemovals(plan, snapshot, { ...options, onAfterMutation: event => { mutations.push(event.kind); } });
      },
    });
    expect(result).toMatchObject({ exitCode: 3, reasonCode: 'deadline', mutations: [] });
    expect(mutations).toEqual([]); expect(rename).not.toHaveBeenCalled();
    intact(f); expect(lstatSync(join(f.tree, 'node_modules')).isSymbolicLink()).toBe(true);
  });
  it.skipIf(process.platform !== 'win32').each(['junction', 'scan-failure'])('rechecks a de-registered leftover before mutation: %s', async kind => {
    const f = fixture(), foreign = f.add('foreign'); f.index();
    const key = f.scan().registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(foreign))!;
    expect(normalizePath(key.adminPath).startsWith(normalizePath(f.primary) + '/')).toBe(true);
    rmSync(key.adminPath, { recursive: true }); unlinkSync(join(foreign, '.git'));
    const mutations: string[] = [];
    const result = await runRelease(f.options, {
      executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: Parameters<typeof executeRemovals>[2]) => {
        if (kind === 'junction') f.link(foreign, f.tree, 'dependency');
        else {
          const read = vi.mocked(readdirSync).getMockImplementation()!;
          vi.mocked(readdirSync).mockImplementation(((path, ...args) => {
            if (normalizePath(String(path)) === normalizePath(foreign)) throw new Error('leftover scan failed');
            return Reflect.apply(read, undefined, [path, ...args]);
          }) as typeof readdirSync);
        }
        return executeRemovals(plan, snapshot, { ...options, onAfterMutation: event => { mutations.push(event.kind); } });
      },
    });
    expect(result).toMatchObject({ exitCode: 3, outcome: 'refused', mutations: [] });
    expect(result.reason).toContain(kind === 'junction' ? 'Inbound link' : 'Fresh inventory unavailable');
    expect(mutations).toEqual([]); intact(f);
    vi.mocked(readdirSync).mockReset();
  });
  it('gives every release a fresh lease memo, even when the caller supplies one', async () => {
    const supplied = new Set(['stale-verdict']);
    const memos: unknown[] = [];
    for (let release = 0; release < 2; release++) {
      const f = fixture(); f.index();
      const result = await runRelease({ ...f.options, activityOptions: { ...f.options.activityOptions, leaseMemo: supplied } }, {
        collectActivity: (trees: Parameters<typeof collectActivity>[0], options: Parameters<typeof collectActivity>[1]) => { memos.push(options?.leaseMemo); return collectActivity(trees, options); },
      });
      expect(result).toMatchObject({ exitCode: 0, outcome: 'removed' });
    }
    expect(memos).toHaveLength(2);
    for (const memo of memos) { expect(memo).toBeInstanceOf(Set); expect(memo).not.toBe(supplied); }
    expect(memos[0]).not.toBe(memos[1]);
  });
  it('releases with an absent prunable registration without pruning it', async () => {
    const f = fixture(), stale = f.add('stale'); f.index();
    expect(isWithin(stale, f.root)).toBe(true); rmSync(stale, { recursive: true });
    const result = await runRelease(f.options);
    expect(result).toMatchObject({ exitCode: 0, outcome: 'removed' });
    expect(git(f.primary, 'worktree', 'list', '--porcelain')).toContain('prunable');
    expect(existsSync(f.tree)).toBe(false);
  });
  it.skipIf(process.platform !== 'win32').each(['open', 'saturated', 'failed'])('fresh PR guard refuses %s evidence before unlink', async kind => {
    const f = fixture(), packages = join(f.primary, 'node_modules'); packagesAt(packages); writeFileSync(join(packages, 'keep'), 'packages'); f.link(f.tree, packages); f.index();
    let queries = 0; const head = git(f.primary, 'rev-parse', 'HEAD');
    f.runGh.mockImplementation(() => ++queries === 1 ? ok('[]') : kind === 'failed' ? unknown('offline') : ok(JSON.stringify(Array.from({ length: kind === 'saturated' ? 10000 : 1 }, (_, i) => ({ number: i + 1, headRefName: 'unit', headRefOid: head, state: 'OPEN', baseRefName: 'main' })))));
    const result = await runRelease(f.options);
    expect(result).toMatchObject({ exitCode: 3, reasonCode: kind === 'open' ? 'open-pr' : 'pr-unknown' }); intact(f);
    expect(lstatSync(join(f.tree, 'node_modules')).isSymbolicLink()).toBe(true); expect(readFileSync(join(packages, 'keep'), 'utf8')).toBe('packages');
  }, 60_000);
  it.each(['indexed', 'new', 'recreated'])('refuses a nested inbound junction from an %s foreign tree', async kind => {
    const f = fixture(), foreign = f.add('foreign');
    if (kind === 'indexed') { f.link(foreign, f.tree, 'nested/dependency'); f.index(); }
    else {
      if (kind === 'recreated') { f.index(); git(f.primary, 'worktree', 'remove', foreign); git(f.primary, 'worktree', 'add', foreign, 'foreign'); }
      f.link(foreign, f.tree, 'nested/dependency');
    }
    const result = await runRelease(f.options);
    expect(result).toMatchObject({ exitCode: 3, reasonCode: 'shared' });
    expect(JSON.stringify(result)).toContain('nested'); intact(f);
  });
  it('refuses an incomplete foreign entry when its live walk fails', async () => {
    const f = fixture(), foreign = f.add('foreign'), snapshot = f.scan();
    snapshot.worktrees.find(tree => normalizePath(tree.path) === normalizePath(foreign))!.links = unknown('timed out');
    const index = projectLinkIndex(snapshot); writeFileSync(linkIndexPath(f.reportRoot, join(f.primary, '.git')), JSON.stringify(index));
    const read = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation(((path, ...args) => { if (normalizePath(String(path)) === normalizePath(foreign)) throw new Error('walk failed'); return Reflect.apply(read, undefined, [path, ...args]); }) as typeof readdirSync);
    expect(await runRelease(f.options)).toMatchObject({ exitCode: 3, reasonCode: 'links-unknown' }); intact(f);
  });
  it.each(['missing', 'unreadable', 'expired', 'missing-links', 'wrong-repository'])('refuses a %s link index', async kind => {
    const f = fixture(), file = linkIndexPath(f.reportRoot, join(f.primary, '.git')), index = JSON.parse(readFileSync(file, 'utf8'));
    if (kind === 'expired') index.observedAt -= 61 * 60 * 60_000;
    if (kind === 'missing-links') for (const entry of Object.values(index.entries) as { links?: unknown }[]) delete entry.links;
    if (kind === 'wrong-repository') index.repositoryIdentity = normalizePath(join(f.root, 'another', '.git'));
    writeFileSync(file, JSON.stringify(index));
    if (kind === 'missing') unlinkSync(file);
    if (kind === 'unreadable') { unlinkSync(file); mkdirSync(file); }
    expect(await runRelease(f.options)).toMatchObject({ exitCode: 3, reasonCode: 'link-index-stale',
      reason: kind === 'expired' ? expect.stringMatching(/^Link index is 61\.\d h old \(limit 60\.0 h\); the next scheduled nightly cleanup refreshes it$/)
        : expect.stringMatching(/missing or unusable \(limit 60\.0 h\); the next scheduled nightly cleanup refreshes it$/) }); intact(f);
  });
  it('releases with a 59-hour index after one missed nightly', async () => {
    const f = fixture(), file = linkIndexPath(f.reportRoot, join(f.primary, '.git')), index = JSON.parse(readFileSync(file, 'utf8'));
    index.observedAt -= 59 * 60 * 60_000; writeFileSync(file, JSON.stringify(index));
    expect(await runRelease(f.options)).toMatchObject({ exitCode: 0, reasonCode: 'removed' });
  });
  it('reports the age when the index expires between the read and the inbound baseline', async () => {
    const f = fixture(), file = linkIndexPath(f.reportRoot, join(f.primary, '.git'));
    let clock = JSON.parse(readFileSync(file, 'utf8')).observedAt + 60 * 60 * 60_000;
    const result = await runRelease({ ...f.options, now: () => clock }, {
      readLinkIndex: (...args: Parameters<typeof readLinkIndex>) => { const index = readLinkIndex(...args); clock += 6 * 60_000; return index; },
    });
    expect(result).toMatchObject({ exitCode: 3, reasonCode: 'link-index-stale',
      reason: 'Link index is 60.1 h old (limit 60.0 h); the next scheduled nightly cleanup refreshes it' }); intact(f);
  });
  it.skipIf(process.platform !== 'win32')('refuses an injected first rename failure without unlinking anything', async () => {
    const f = fixture(), packages = join(f.primary, 'node_modules'); packagesAt(packages); f.link(f.tree, packages); f.index();
    const rename = vi.fn((_from: string, _to: string) => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); });
    expect(await runRelease(f.options, { rename })).toMatchObject({ exitCode: 3, reasonCode: 'in-use' });
    expect(rename).toHaveBeenCalledOnce(); expect(rename.mock.calls[0][0]).toBe(toNamespacedPath(f.tree)); intact(f); expect(lstatSync(join(f.tree, 'node_modules')).isSymbolicLink()).toBe(true);
  });
  it('retries rename-back and reports exact repair recovery when restoration fails', async () => {
    const f = fixture(); let moved = '', calls = 0;
    const rename = (from: string, to: string) => { calls++; if (calls > 1) throw new Error('restore denied'); moved = to; renameSync(from, to); };
    try {
      const result = await runRelease(f.options, { rename, sleep: async () => {} });
      expect(result).toMatchObject({ exitCode: 3, reasonCode: 'restore-failed', recovery: expect.stringContaining('git') });
      expect(result.recovery).toContain('worktree repair'); expect(result.recovery).toContain(f.tree); expect(calls).toBeGreaterThanOrEqual(3);
      expect(existsSync(join(moved, 'tracked.txt'))).toBe(true); expect(git(f.primary, 'rev-parse', 'unit')).toMatch(/^[a-f0-9]{40}$/);
    } finally { if (moved && existsSync(moved)) renameSync(moved, toNamespacedPath(f.tree)); }
  });
  it('recovers from a transient rename-back failure', async () => {
    const f = fixture(); let calls = 0;
    expect(await runRelease(f.options, { rename: (from: string, to: string) => { if (++calls === 2) throw new Error('transient'); renameSync(from, to); }, sleep: async () => {} })).toMatchObject({ exitCode: 0 });
    expect(calls).toBe(3);
  });
  it.skipIf(process.platform !== 'win32').each(['remove', 'unlink-junction'])('refuses a HEAD change during rename-back before %s', async kind => {
    const f = fixture(), originalHead = git(f.tree, 'rev-parse', 'HEAD');
    if (kind === 'unlink-junction') { const packages = join(f.primary, 'node_modules'); packagesAt(packages); f.link(f.tree, packages); f.index(); }
    let restored = false;
    const mutations: string[] = [], headReads: string[] = [];
    const rename = vi.fn((from: string, to: string) => {
      renameSync(from, to);
      if (to === toNamespacedPath(f.tree)) { git(f.tree, 'commit', '--allow-empty', '-m', 'HEAD changed during rename probe'); restored = true; }
    });
    const runProbe: typeof probe = (exe, args, extra) => {
      const result = probe(exe, args, extra);
      if (restored && args[args.indexOf('-C') + 1] === f.tree && args.slice(-2).join(' ') === 'rev-parse HEAD') {
        expect(extra).toMatchObject({ softDeadline: expect.any(Number), deadlineNow: expect.any(Function), timeout: expect.any(Number) });
        if (result.state === 'ok' && typeof result.value === 'string') headReads.push(result.value.trim());
      }
      return result;
    };
    const result = await runRelease(f.options, { rename, runProbe,
      executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: Parameters<typeof executeRemovals>[2]) =>
        executeRemovals(plan, snapshot, { ...options, onAfterMutation: event => { mutations.push(event.kind); } }),
    });
    expect(result).toMatchObject({ exitCode: 3, outcome: 'refused', reasonCode: 'head-changed', head: originalHead, mutations: [] });
    expect(rename).toHaveBeenCalledTimes(2); expect(mutations).toEqual([]); intact(f);
    const changedHead = git(f.tree, 'rev-parse', 'HEAD');
    expect(changedHead).not.toBe(originalHead); expect(headReads).toEqual([changedHead]);
    if (kind === 'unlink-junction') expect(lstatSync(join(f.tree, 'node_modules')).isSymbolicLink()).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('pins the default runner and preserves full junction target evidence through real unlink/removal', async () => {
    const f = fixture(), sibling = f.add('packages'), packages = join(sibling, 'node_modules'); packagesAt(packages); writeFileSync(join(packages, 'keep'), 'safe'); f.link(f.tree, packages); f.index();
    const events: string[] = [];
    const result = await runRelease(f.options, { executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: Parameters<typeof executeRemovals>[2]) => {
      expect(snapshot.runnerPath).toBe(join(f.primary, '.worktrees', '.worktree-cleanup-runner'));
      expect(snapshot.worktrees).toHaveLength(1); expect((snapshot.worktrees[0] as { targetBaseline: unknown }).targetBaseline).toMatchObject({ state: 'ok', value: { count: 2 } });
      return executeRemovals(plan, snapshot, { ...options, onAfterMutation: event => { events.push(event.kind); } });
    } });
    expect(result, JSON.stringify(result)).toMatchObject({ exitCode: 0 }); expect(events.slice(0, 2)).toEqual(['unlink-junction', 'remove']);
    expect(readFileSync(join(packages, 'keep'), 'utf8')).toBe('safe'); expect(existsSync(f.tree)).toBe(false);
    expect(f.runGh).toHaveBeenCalledTimes(3);
  }, 60_000);
  it('does not deep-walk indexed foreign trees during classification or remover rechecks', async () => {
    const f = fixture(), old = f.add('old'); mkdirSync(join(old, 'nested')); writeFileSync(join(old, 'nested', 'keep'), 'old'); f.index();
    const fresh = f.add('fresh'); mkdirSync(join(fresh, 'nested'));
    vi.mocked(readdirSync).mockClear();
    expect(await runRelease(f.options)).toMatchObject({ exitCode: 0 });
    const reads = vi.mocked(readdirSync).mock.calls.map(([path]) => normalizePath(String(path)));
    expect(reads).not.toContain(normalizePath(join(old, 'nested'))); expect(reads).toContain(normalizePath(join(fresh, 'nested')));
    expect(reads.filter(path => path === normalizePath(join(fresh, 'nested')))).toHaveLength(1);
    expect(reads.filter(path => path === normalizePath(old)).length).toBeGreaterThan(1);
  });
  it('leaves nightly journal bytes and subsequent held ages unchanged', async () => {
    const f = fixture(), held = f.add('held'), now = Date.now(), row = { path: held, action: 'hold', disposition: 'hold', reasonCode: 'live', firstHeldAt: now - 100_000 };
    writeRunReport(f.reportRoot, { runId: 'before', startedAt: now, finishedAt: now, status: 'completed', stage: 'complete', worktrees: [row] });
    const file = join(f.reportRoot, 'journal.jsonl'), before = readFileSync(file, 'utf8');
    expect(await runRelease(f.options)).toMatchObject({ exitCode: 0 }); expect(readFileSync(file, 'utf8')).toBe(before);
    const report = writeRunReport(f.reportRoot, { runId: 'after', startedAt: now + 10, finishedAt: now + 10, status: 'completed', stage: 'complete', worktrees: [{ ...row, firstHeldAt: undefined }] });
    expect(report.worktrees[0].firstHeldAt).toBe(row.firstHeldAt);
  });
  it.each(['claude', 'codex', 'absent'])('defaults owner identity from %s environment', async kind => {
    const f = fixture(); f.transcript();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', kind === 'claude' ? 'owner' : ''); vi.stubEnv('CODEX_THREAD_ID', kind === 'absent' ? '' : kind === 'claude' ? 'other' : 'owner');
    expect(await runRelease({ ...f.options, ownerSession: undefined })).toMatchObject(kind === 'absent' ? { exitCode: 3, reasonCode: 'owner-session-required' } : { exitCode: 0 });
  });
  it('reports a coordinator error and releases its lock', async () => {
    const f = fixture(); expect(await runRelease(f.options, { inventory: () => { throw new Error('injected crash'); } })).toMatchObject({ exitCode: 1, outcome: 'error' });
    intact(f); expect(rows(f.reportRoot)).toHaveLength(1); const unlock = await acquireRunLock(f.primary, f.reportRoot); await unlock();
  });
});
