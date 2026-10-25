import './worktree-cleanup-test-env';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { main, runCleanup, runCommission } from '../worktree-cleanup.mjs';
import { acquireRunLock, admitRunLock, coordinationDirectory, lockPort, writeRunReport, type RunReport } from '../lib/worktree-cleanup/report.mjs';
import { negative, ok, probe, resolveExecutable, unknown } from '../lib/worktree-cleanup/probe.mjs';
import { appendIdleObservation } from '../lib/worktree-cleanup/idle-journal.mjs';
import { createArchive, restoreArchive } from '../lib/worktree-cleanup/archive.mjs';
import { executeRemovals, type RemovalOptions } from '../lib/worktree-cleanup/remove.mjs';
import { planWorktrees } from '../lib/worktree-cleanup/policy.mjs';
import { inventory, isWithin, normalizePath } from '../lib/worktree-cleanup/inventory.mjs';
import { collectActivity } from '../lib/worktree-cleanup/activity.mjs';
import { writeLinkIndex } from '../lib/worktree-cleanup/link-index.mjs';
import { readCommissioning, preflightSnapshot, publishSnapshot, verifySnapshotRecord, markSnapshotProgress, markSnapshotRemoved, recoverSnapshot, writeCommissioningArtifact } from '../lib/worktree-cleanup/snapshot.mjs';
import { runRescueCommand } from '../lib/worktree-cleanup/rescue.mjs';

type InventorySnapshot = Extract<ReturnType<typeof inventory>, { state: 'ok' }>['value'];
type CandidatePlan = { primaryPath: string; worktrees: { path: string }[] };
// Commissioning populates fields absent from runCommission's inferred report literal.
type CommissioningReport = RunReport & { planHash?: string };

vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, readFileSync: vi.fn(fs.readFileSync) };
});

vi.mock('../lib/worktree-cleanup/report.mjs', async original => {
  const reportModule = await original<typeof import('../lib/worktree-cleanup/report.mjs')>();
  return { ...reportModule, writeRunReport: vi.fn(reportModule.writeRunReport) };
});

const roots: string[] = [];
const templates = new Map<string, { root: string; directory: string }>();
describe('release CLI parsing', () => {
  it.each([0, 3, 1])('routes one target and overrides to release and preserves exit %s', async exitCode => {
    const runRelease = vi.fn(async () => ({ exitCode, outcome: exitCode === 0 ? 'removed' : exitCode === 3 ? 'refused' : 'error', reasonCode: 'fixture', recovery: 'git worktree repair fixture' }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const target = resolve(tmpdir(), 'cli-target'), primary = resolve(tmpdir(), 'cli-primary');
    expect(await main(['release', target, '--repo', primary, '--owner-session', 'owner', '--runner', 'runner', '--report-root', 'state', '--git', 'git', '--gh', 'gh', '--timeout-ms', '5000', '--walk-timeout-ms', '10000', '--soft-timeout-ms', '30000'], { runRelease })).toBe(exitCode);
    expect(runRelease).toHaveBeenCalledWith(expect.objectContaining({ targetPath: target, repositoryPath: primary, ownerSession: 'owner', runnerPath: 'runner', reportRoot: 'state', timeout: 5000, walkTimeout: 10000, softTimeoutMs: 30000 }), expect.any(Object));
    expect(output).toHaveBeenCalledOnce(); expect(String(output.mock.calls[0][0])).toContain('git worktree repair');
  });
  it.each([[], ['relative'], ['--repo', 'repo'], ['TARGET', '--repo'], ['TARGET', '--repo', 'repo', 'extra'], ['TARGET', '--repo', 'repo', '--owner-session'], ['TARGET', '--repo', 'repo', '--repo', 'again'], ['TARGET', '--repo', 'repo', '--timeout-ms', '0'], ['TARGET', '--repo', 'repo', '--dry-run']].map(args => ({ args })))('rejects malformed release arguments $args without dispatch', async ({ args }) => {
    const runRelease = vi.fn(), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['release', ...args.map(arg => arg === 'TARGET' ? resolve(tmpdir(), 'cli-target') : arg)], { runRelease })).toBe(1);
    expect(runRelease).not.toHaveBeenCalled(); expect(error.mock.calls.flat().join(' ')).toContain('release');
  });
});
// The launcher honors WORKTREE_CLEANUP_*_MS test overrides only under this sentinel.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV,
  WORKTREE_CLEANUP_TEST_OVERRIDES: '1' };
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const installer = resolve('scripts/install-worktree-cleanup.ps1');
const launcher = resolve('scripts/run-worktree-cleanup.ps1');
const releaseEntrypoint = resolve('scripts/release-worktree.ps1');
const found = resolveExecutable('git');
if (found.state !== 'ok') throw new Error('Git is required');
const gitPath = found.value;
function git(path: string, ...args: string[]) {
  const result = spawnSync(gitPath, ['-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=false', '-C', path, ...args], { env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
function ps(file: string, args: string[] = [], extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  return spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { env: { ...env, ...extraEnv }, encoding: 'utf8', windowsHide: true, timeout: 25_000 });
}
function psAsync(file: string, args: string[], extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
    env: { ...env, ...extraEnv, WORKTREE_CLEANUP_NO_TOAST: '1' }, windowsHide: true,
  });
  const state = { stdout: '', stderr: '', exited: false };
  child.stdout.on('data', data => { state.stdout += data.toString(); });
  child.stderr.on('data', data => { state.stderr += data.toString(); });
  const result = new Promise<number | null>((accept, reject) => {
    child.once('error', reject);
    child.once('close', code => { state.exited = true; accept(code); });
  });
  return { child, state, result };
}
function age(root: string) {
  const old = new Date(Date.now() - 30 * 86_400_000);
  for (const name of readdirSync(root)) {
    if (name === '.git') continue;
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isDirectory()) age(path); else utimesSync(path, old, old);
  }
}
function bytes(root: string) {
  const result: Record<string, string> = {};
  function walk(path: string) {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('Unexpected fixture link');
      if (stat.isDirectory()) walk(full);
      else result[relative(root, full)] = createHash('sha256').update(readFileSync(full)).digest('hex');
    }
  }
  walk(root); return result;
}
type Pr = { number: number; state: string; isDraft: boolean; headRefName: string; headRefOid: string; baseRefName: string; url: string; body: string };
function fixture(primaryName = 'primary', template?: string) {
  const saved = template ? templates.get(template) : undefined;
  const root = saved?.root ?? mkdtempSync(join(tmpdir(), 'wt-launcher-')); roots.push(root);
  if (saved) {
    if (existsSync(root)) throw new Error('Previous fixture was not removed');
    cpSync(saved.directory, root, { recursive: true, preserveTimestamps: true });
  }
  const primary = join(root, primaryName), remote = join(root, 'remote.git'), home = join(root, 'home'), reportRoot = join(root, 'installed');
  if (!saved) {
    mkdirSync(primary); mkdirSync(remote); mkdirSync(home);
    git(remote, 'init', '--bare', '-b', 'main'); git(primary, 'init', '-b', 'main');
    git(primary, 'config', 'user.name', 'Fixture'); git(primary, 'config', 'user.email', 'fixture@example.invalid');
    git(primary, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(primary, '.gitignore'), '.worktrees/\nnode_modules/\n');
    writeFileSync(join(primary, 'tracked.md'), '# Original\n');
    git(primary, 'add', '.'); git(primary, 'commit', '-m', 'fixture');
    git(primary, 'remote', 'add', 'origin', remote); git(primary, 'push', 'origin', 'main');
  }
  const prs: Pr[] = [];
  const runGh = vi.fn((args: string[]) => {
    const head = args.includes('--head') ? args[args.indexOf('--head') + 1] : null;
    if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(prs.filter(pr => !head || pr.headRefName === head).map(pr => ({ ...pr,
      headRefOid: pr.headRefName.startsWith('chore/rescued-') ? git(remote, 'rev-parse', `refs/heads/${pr.headRefName}`) : pr.headRefOid }))));
    if (args[0] === 'pr' && args[1] === 'create') {
      const number = Math.max(0, ...prs.map(pr => pr.number)) + 1, branch = args[args.indexOf('--head') + 1];
      const pr = { number, state: 'OPEN', isDraft: args.includes('--draft'), headRefName: branch, headRefOid: git(remote, 'rev-parse', `refs/heads/${branch}`),
        baseRefName: 'main', url: `https://github.com/example-org/example-repo/pull/${number}`, body: args[args.indexOf('--body') + 1] };
      prs.push(pr); return ok(pr.url);
    }
    if (args[0] === 'pr' && args[1] === 'edit') return ok('');
    return unknown('Unexpected stubbed gh command');
  });
  function add(name: string) { const path = join(root, name); git(primary, 'worktree', 'add', '-b', name, path); age(path); return path; }
  const options = { repositoryPath: primary, runnerPath: primary, reportRoot, remotePath: remote, gitPath,
    ghPath: process.execPath, runGh, activityOptions: { homeDirectory: home } };
  return { root, primary, remote, reportRoot, prs, runGh, add, options };
}
// Save only pre-production Git state and payloads; all evidence is read after restoration.
function saveFixture(name: string, root: string) {
  if (templates.has(name)) return;
  const directory = root + '-template'; templates.set(name, { root, directory });
  cpSync(root, directory, { recursive: true, preserveTimestamps: true });
}
function installed(f: ReturnType<typeof fixture>) {
  const result = ps(installer, ['-Repository', f.primary, '-InstallRoot', f.reportRoot, '-InstallOnly']);
  expect(result.status, result.stderr).toBe(0);
  return join(f.reportRoot, 'run-worktree-cleanup.ps1');
}
function journal(root: string) {
  return readFileSync(join(root, 'journal.jsonl'), 'utf8').split('\n').flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}
const quiet = { notifyRun: () => {} };

describe('U5a commissioned snapshot coordination', { timeout: 60_000 }, () => {
  function scratchFixture() {
    const fresh = !templates.has('scratch'), f = fixture('primary', 'scratch');
    const tracked = 'artifacts/github-issue-roadmap/tracked.json';
    if (fresh) {
      git(f.primary, 'config', 'core.autocrlf', 'true');
      writeFileSync(join(f.primary, '.gitignore'), '.worktrees/\nnode_modules/\n.reproduce-out/\n');
      mkdirSync(join(f.primary, 'artifacts/github-issue-roadmap'), { recursive: true });
      writeFileSync(join(f.primary, tracked), '{"base":true}\n');
      git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'scratch fixture'); git(f.primary, 'push', 'origin', 'main');
      f.add('scratch');
    }
    const path = join(f.root, 'scratch'), head = git(path, 'rev-parse', 'HEAD');
    const files = [
      { path: '.tmp-intake/untracked.json', bytes: Buffer.from('{"untracked":true}\r\n') },
      { path: '.reproduce-out/ignored.json', bytes: Buffer.from('{"ignored":true}\n') },
      { path: tracked, bytes: Buffer.from('{"modified":true}\n') },
    ];
    if (fresh) {
      for (const file of files) {
        mkdirSync(join(path, file.path, '..'), { recursive: true });
        writeFileSync(join(path, file.path), file.bytes);
      }
      age(path); saveFixture('scratch', f.root);
    }
    const refs = () => git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/rescue/');
    const commission = () => {
      const ref = 'refs/heads/rescue/commissioned';
      git(f.remote, 'update-ref', ref, head);
      mkdirSync(f.reportRoot, { recursive: true });
      writeFileSync(join(f.reportRoot, 'commissioning.json'), JSON.stringify({ schema: 'worktree-cleanup-commissioning/v1',
        planHash: 'a'.repeat(64), createdAt: new Date().toISOString(), refs: [{ ref, commitSha: head }] }));
      return ref;
    };
    const facts = () => {
      const scan = inventory(f.options);
      if (scan.state !== 'ok') throw new Error(scan.state === 'unknown' ? scan.reason : 'Unexpected negative inventory');
      return scan.value.worktrees.find(tree => normalizePath(tree.path) === normalizePath(path))!;
    };
    const runGit = vi.fn(runRescueCommand), publish = vi.fn(publishSnapshot), remove = vi.fn(executeRemovals), gate = vi.fn(readCommissioning);
    const progress = vi.fn(markSnapshotProgress), removed = vi.fn(markSnapshotRemoved), runProbe = vi.fn(probe);
    const planner = vi.fn((snapshot: InventorySnapshot, options: Parameters<typeof planWorktrees>[1]) => planWorktrees(snapshot, options));
    const dependencies = { ...quiet, planWorktrees: planner, publishSnapshot: publish, executeRemovals: remove, readCommissioning: gate,
      markSnapshotProgress: progress, markSnapshotRemoved: removed, runProbe };
    const run = (options = {}) => runCleanup({ ...f.options, manual: true, runGit, ...options }, dependencies);
    const journalPath = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(path)).digest('hex') + '.json');
    return { ...f, path, head, files, refs, commission, facts, runGit, publish, remove, gate, progress, removed, runProbe, planner, dependencies, run, journalPath };
  }

  it.each(['missing', 'corrupt', 'deleted', 'moved', 'dry run'])('keeps scratch eligible-only for %s commissioning', async state => {
    const f = scratchFixture();
    if (state !== 'missing') {
      const ref = f.commission();
      if (state === 'deleted') git(f.remote, 'update-ref', '-d', ref);
      if (state === 'moved') git(f.remote, 'update-ref', ref, git(f.primary, 'rev-parse', 'HEAD^'));
      if (state === 'corrupt') writeFileSync(join(f.reportRoot, 'commissioning.json'), '{broken');
    }
    const before = bytes(f.path), refs = f.refs(), objects = git(f.primary, 'count-objects', '-v');
    const report = await f.run({ dryRun: state === 'dry run' });
    expect(report.status, report.error).toBe('completed');
    expect(report.worktrees.find(tree => normalizePath(tree.path) === normalizePath(f.path))).toMatchObject({
      action: 'hold', disposition: 'hold', reasonCode: 'snapshot-eligible', snapshot: { gate: 'eligible', fileCount: 3 },
    });
    expect(bytes(f.path)).toEqual(before); expect(f.refs()).toBe(refs); expect(git(f.primary, 'count-objects', '-v')).toBe(objects);
    expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.gate).toHaveBeenCalledTimes(state === 'dry run' ? 0 : 1);
    expect(existsSync(join(f.reportRoot, 'snapshots'))).toBe(false);
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    if (state === 'missing') expect(f.refs()).toBe('');
  });

  it.each(['manual', 'scheduled'])('publishes and removes a commissioned %s tree, retains its branch and reports recovery', async mode => {
    const f = scratchFixture(); f.commission();
    const report = await f.run(mode === 'scheduled' ? { manual: false, scheduledNightly: true } : {});
    expect(report.status, report.error).toBe('completed');
    const row = report.worktrees.find(tree => normalizePath(tree.path) === normalizePath(f.path))!;
    expect(row, JSON.stringify(row)).toMatchObject({ action: 'snapshot', disposition: 'removed', snapshotState: 'removed',
      snapshotRef: expect.stringMatching(/^refs\/heads\/rescue\/scratch-/), snapshotCommit: expect.stringMatching(/^[a-f0-9]{40}$/) });
    expect(row.restoreCommand).toBe(`node scripts/worktree-cleanup.mjs recover --ref ${row.snapshotRef} --dest <ABSOLUTE_DIR>`);
    expect(git(f.remote, 'rev-parse', row.snapshotRef!)).toBe(row.snapshotCommit);
    expect(git(f.primary, 'rev-parse', 'refs/heads/scratch')).toBe(f.head);
    expect(existsSync(f.path)).toBe(false); expect(JSON.parse(readFileSync(f.journalPath, 'utf8')).state).toBe('removed');
    expect(f.gate).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce(); expect(f.remove).toHaveBeenCalledOnce();
    const plan = await f.planner.mock.results[0].value;
    if (plan.state !== 'ok') throw new Error('Plan failed');
    expect(plan.value.worktrees.every((tree: object) => !('snapshotPreflight' in tree))).toBe(true);
    expect(f.progress.mock.calls.length).toBeGreaterThan(0); expect(f.removed).toHaveBeenCalledWith(join(f.reportRoot, 'snapshots'), row.path);
    const removes = f.runProbe.mock.calls.filter(([, args]) => args.includes('worktree') && args.includes('remove'));
    expect(removes).toHaveLength(1); expect(removes[0][1]).not.toContain('--force');
    for (const file of f.files) {
      const blob = spawnSync(gitPath, ['-C', f.primary, 'cat-file', 'blob', `${row.snapshotCommit}:${file.path}`], { env, windowsHide: true });
      expect(blob.status).toBe(0); expect(blob.stdout).toEqual(file.bytes);
    }
    const text = readFileSync(report.reportPath!, 'utf8');
    expect(text).toContain(row.snapshotRef); expect(text).toContain(row.snapshotCommit);
    expect(text).toContain('recover --ref');
    expect(JSON.parse(readFileSync(join(f.reportRoot, 'journal.jsonl'), 'utf8').trim()).worktrees).toContainEqual(expect.objectContaining({
      path: row.path, snapshotRef: row.snapshotRef, snapshotCommit: row.snapshotCommit, restoreCommand: row.restoreCommand,
    }));
  });

  it.each(['untouched', 'cleaned', 'live lock', 'invalid lock'])('handles a bound published continuation with %s source', async state => {
    const f = scratchFixture(); f.commission();
    const facts = f.facts(), published = publishSnapshot(facts, preflightSnapshot(facts), { ...f.options, runGit: f.runGit });
    expect(published.state).toBe('ok');
    if (published.state !== 'ok') throw new Error('Publication failed');
    if (state === 'cleaned') {
      f.remove.mockImplementationOnce((plan, snapshot, options) => executeRemovals(plan, snapshot, { ...options,
        onBeforeMutation: async event => {
          await options?.onBeforeMutation?.(event);
          if (event.kind === 'remove') throw new Error('Fixture crash after copy-set cleanup');
        },
      }));
      const interrupted = await f.run();
      expect(interrupted.status).toBe('failed');
      expect(JSON.parse(readFileSync(f.journalPath, 'utf8')).progress.cleaned).toHaveLength(f.files.length);
      expect(existsSync(f.path)).toBe(true); f.remove.mockClear();
    }
    const before = readFileSync(f.journalPath);
    const lock = `${f.journalPath}.lock`;
    if (state === 'live lock' || state === 'invalid lock') writeFileSync(lock, state === 'live lock' ? String(process.pid) : 'unknown');
    f.runGit.mockClear();
    const report = await f.run();
    expect(report.status, report.error).toBe('completed');
    const row = report.worktrees.find(tree => normalizePath(tree.path) === normalizePath(f.path))!;
    expect(row).toMatchObject({ snapshotBound: true, snapshotRef: published.value.ref, snapshotCommit: published.value.commitSha });
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    if (state.endsWith('lock')) {
      expect(row).toMatchObject({ action: 'hold', disposition: 'hold', reasonCode: 'snapshot-pending' });
      expect(f.remove).not.toHaveBeenCalled(); expect(readFileSync(f.journalPath)).toEqual(before);
      expect(existsSync(f.path)).toBe(true); expect(existsSync(lock)).toBe(true);
    } else {
      expect(row, JSON.stringify(row)).toMatchObject({ action: 'snapshot', disposition: 'removed', snapshotState: 'removed' });
      expect(f.remove).toHaveBeenCalledOnce(); expect(f.removed).toHaveBeenCalledOnce();
      expect(existsSync(f.path)).toBe(false); expect(JSON.parse(readFileSync(f.journalPath, 'utf8')).state).toBe('removed');
    }
  });

  it('reports a source-change publication veto and never invokes removal', async () => {
    const f = scratchFixture(); f.commission();
    f.publish.mockImplementation((tree, preflight, options) => {
      writeFileSync(join(f.path, f.files[0].path), '{"changed":true}\n');
      return publishSnapshot(tree, preflight, options);
    });
    const refs = f.refs(), report = await f.run();
    expect(report.status, report.error).toBe('completed');
    expect(report.worktrees.find(tree => normalizePath(tree.path) === normalizePath(f.path))).toMatchObject({
      disposition: 'hold', reasonCode: 'snapshot-publication-refused', snapshotVeto: 'snapshot-publication-refused',
      snapshot: { gate: 'snapshot-publication-refused' },
    });
    expect(f.publish).toHaveBeenCalledOnce(); expect(f.remove).not.toHaveBeenCalled();
    const plan = await f.planner.mock.results[0].value;
    if (plan.state !== 'ok') throw new Error('Plan failed');
    expect(plan.value.worktrees.every((tree: object) => !('snapshotPreflight' in tree))).toBe(true);
    expect(f.refs()).toBe(refs); expect(existsSync(f.path)).toBe(true);
    expect(readFileSync(join(f.path, f.files[0].path), 'utf8')).toBe('{"changed":true}\n');
  });
});

describe('U5b supervised commissioning', { timeout: 60_000 }, () => {
  function commissioningFixture(count = 1, template: boolean | string = false) {
    const name = typeof template === 'string' ? template : template ? `commission-${count}` : undefined;
    const fresh = !name || !templates.has(name), f = fixture('primary', name);
    const ancestor = git(f.primary, 'rev-parse', fresh ? 'HEAD' : 'HEAD^');
    if (fresh) {
      writeFileSync(join(f.primary, 'tracked.md'), '# New main\n');
      git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'main advances'); git(f.primary, 'push', 'origin', 'main');
    }
    const head = git(f.primary, 'rev-parse', 'HEAD');
    f.prs.push({ number: 1, state: 'MERGED', isDraft: false, headRefName: 'merged-unit', headRefOid: head,
      baseRefName: 'main', url: 'https://github.com/example-org/example-repo/pull/1', body: '' });
    const paths = Array.from({ length: count }, (_, index) => fresh ? f.add(`scratch-${index}`) : join(f.root, `scratch-${index}`));
    if (fresh) {
      for (const path of paths) {
        mkdirSync(join(path, '.tmp-intake')); writeFileSync(join(path, '.tmp-intake/output.json'), '{"scratch":true}\r\n'); age(path);
      }
      if (name) saveFixture(name, f.root);
    }
    const refs = () => git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/rescue/');
    const runGit = vi.fn(runRescueCommand), publish = vi.fn((tree: InventorySnapshot['worktrees'][number], preflight: Parameters<typeof publishSnapshot>[1], options: Parameters<typeof publishSnapshot>[2]) =>
      publishSnapshot(tree, preflight, options)), remove = vi.fn(executeRemovals);
    const planner = vi.fn((snapshot: InventorySnapshot, options: Parameters<typeof planWorktrees>[1]) => planWorktrees(snapshot, options)), artifact = vi.fn(writeCommissioningArtifact);
    const dependencies = { ...quiet, publishSnapshot: publish, executeRemovals: remove, planWorktrees: planner, writeCommissioningArtifact: artifact };
    const options = { ...f.options, runGit };
    const preview = () => runCommission({ ...options, preview: true }, dependencies) as unknown as Promise<CommissioningReport>;
    const confirm = (hash: string, extra = {}) => runCommission({ ...options, confirm: hash }, { ...dependencies, ...extra }) as unknown as Promise<CommissioningReport>;
    const gate = () => readCommissioning(f.reportRoot, options);
    return { ...f, paths, ancestor, head, refs, runGit, publish, remove, planner, artifact, dependencies, options, preview, confirm, gate };
  }

  // Reuse a real published journal and Git objects, then read all evidence afresh.
  // These templates contain no commissioning record or removal progress.
  function publishedFixture(kind: 'plain' | 'retained' | 'ignored' = 'plain') {
    const name = `commission-published-${kind}`, saved = templates.has(name);
    const f = commissioningFixture(1, saved ? name : true), path = f.paths[0];
    if (!saved) {
      if (kind === 'retained') writeFileSync(join(path, '.tmp-intake/retained.json'), '{}\n');
      if (kind === 'ignored') {
        writeFileSync(join(f.primary, '.git/info/exclude'), '.tmp-intake/cache/\n');
        mkdirSync(join(path, '.tmp-intake/cache'));
        writeFileSync(join(path, '.tmp-intake/cache/original.json'), '{"cached":true}\n');
      }
      age(path);
      const snapshot = inventory(f.options);
      if (snapshot.state !== 'ok') throw new Error('Inventory failed');
      const facts = snapshot.value.worktrees.find(tree => normalizePath(tree.path) === normalizePath(path))!;
      const published = publishSnapshot(facts, preflightSnapshot(facts), f.options);
      if (published.state !== 'ok') throw new Error('Publication failed');
      const directory = f.root + `-${name}-template`;
      cpSync(f.root, directory, { recursive: true, preserveTimestamps: true });
      templates.set(name, { root: f.root, directory });
    }
    const journalPath = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(path)).digest('hex') + '.json');
    f.publish.mockClear(); f.runGit.mockClear();
    return { ...f, journalPath };
  }

  it('previews only exact-HEAD merged-PR scratch candidates, with a stable printed hash and no journals or pushes', async () => {
    const f = commissioningFixture(1, true);
    const ancestorOnly = f.add('ancestor-only'); git(ancestorOnly, 'reset', '--hard', f.ancestor);
    mkdirSync(join(ancestorOnly, '.tmp-intake')); writeFileSync(join(ancestorOnly, '.tmp-intake/output.json'), '{}\n'); age(ancestorOnly);
    const vetoed = f.add('vetoed'); mkdirSync(join(vetoed, '.tmp-intake'));
    writeFileSync(join(vetoed, '.tmp-intake/.env.local'), 'PLACEHOLDER=true\n'); age(vetoed);
    for (const name of ['bt-followups', 'bt-voice-prefs', 'example-repo-roadmap-cutover-20260818', 'bt-docs-rescue', 'bt-2186-excerpts']) {
      const path = f.add(name); writeFileSync(join(path, 'outside-scratch.txt'), 'held out\n'); age(path);
    }
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = (options: Parameters<typeof runCommission>[0], dependencies: Parameters<typeof runCommission>[1]) => runCommission({ ...f.options, ...options }, dependencies);
    const args = ['commission', '--preview', '--repo', f.primary, '--report-root', f.reportRoot];
    expect(await main(args, { ...f.dependencies, runCommission: run })).toBe(0);
    expect(await main(args, { ...f.dependencies, runCommission: run })).toBe(0);
    const hash = String(output.mock.calls[0][0]);
    expect(hash).toMatch(/^[a-f0-9]{64}$/); expect(output.mock.calls[1][0]).toBe(hash);
    const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${hash}.json`), 'utf8'));
    expect(saved.candidates).toEqual([{ path: normalizePath(f.paths[0]), head: f.head,
      'ref-stem': `rescue/scratch-0-${new Date().toISOString().slice(0, 10)}`,
      files: [{ path: '.tmp-intake/output.json', kind: 'untracked', digest: expect.stringMatching(/^[a-f0-9]{40}$/) }] }]);
    expect(hash).toBe(createHash('sha256').update(JSON.stringify(saved.candidates)).digest('hex'));
    expect(readFileSync(join(f.reportRoot, 'reports', `commission-preview-${hash}.md`), 'utf8')).toContain('## Commissioning preview');
    expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled(); expect(f.refs()).toBe('');
    expect(existsSync(join(f.reportRoot, 'snapshots'))).toBe(false); expect(existsSync(join(f.reportRoot, 'journal.jsonl'))).toBe(false);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
  });

  it('excludes published retries for every exact merged-head clause', async () => {
    const f = commissioningFixture(1, true), path = f.paths[0];
    git(path, 'reset', '--hard', f.ancestor);
    const snapshot = inventory(f.options);
    if (snapshot.state !== 'ok') throw new Error('Inventory failed');
    const facts = snapshot.value.worktrees.find(tree => normalizePath(tree.path) === normalizePath(path))!;
    const published = publishSnapshot(facts, preflightSnapshot(facts), f.options);
    if (published.state !== 'ok') throw new Error('Publication failed');
    expect('recoveryFailure' in published.value).toBe(false);
    const before = readFileSync(published.value.journalPath), sourceBefore = bytes(path), refs = f.refs();
    f.runGit.mockClear();
    for (const change of ['ancestor-only', 'open PR', 'other base', 'unavailable PRs']) {
      // Isolate each clause: every available PR after the ancestor case has the exact head.
      f.prs[0].headRefOid = change === 'ancestor-only' ? f.head : f.ancestor;
      f.prs[0].state = change === 'open PR' ? 'OPEN' : 'MERGED';
      f.prs[0].baseRefName = change === 'other base' ? 'develop' : 'main';
      if (change === 'unavailable PRs') f.runGh.mockImplementation(() => unknown('Injected PR lookup failure'));
      const preview = await f.preview();
      expect(preview.status, change).toBe('completed');
      const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${preview.planHash}.json`), 'utf8'));
      const detail = change === 'unavailable PRs' ? 'Merged PR evidence unavailable' :
        'Snapshot HEAD is not the exact head of a PR merged into main';
      expect(saved.candidates, change).toEqual([]);
      expect(saved.excluded, change).toEqual([{ path: normalizePath(path), reason: 'snapshot-bound', detail }]);
      expect(preview.worktrees, change).toContainEqual(expect.objectContaining({ path: normalizePath(path), reasonCode: 'snapshot-bound', detail }));
      expect(f.planner.mock.calls.at(-1)![0].worktrees.map(tree => normalizePath(tree.path)), change).toEqual([normalizePath(f.primary)]);
      const plan = await f.planner.mock.results.at(-1)!.value;
      if (plan.state !== 'ok') throw new Error('Plan failed');
      expect(plan.value, change).toMatchObject({ prSnapshot: { state: change === 'unavailable PRs' ? 'unknown' : 'ok' } });
      expect(f.publish, change).not.toHaveBeenCalled(); expect(f.remove, change).not.toHaveBeenCalled();
      expect(f.runGit.mock.calls.some(([, args]) => args.includes('push')), change).toBe(false);
      expect(existsSync(join(f.reportRoot, 'commissioning.json')), change).toBe(false);
      expect(readFileSync(published.value.journalPath), change).toEqual(before);
      expect(bytes(path), change).toEqual(sourceBefore); expect(f.refs(), change).toBe(refs);
    }
  });

  it('publishes every candidate, recovers, writes the record before removal, and retains branches', async () => {
    const f = commissioningFixture(2, true), preview = await f.preview();
    expect(preview.status, preview.error).toBe('completed');
    const events: string[] = [];
    f.artifact.mockImplementation((root, name, record) => {
      writeCommissioningArtifact(root, name, record);
      if (name === 'commissioning.json') events.push('record');
    });
    f.remove.mockImplementation((plan, snapshot, options) => {
      events.push('remove'); expect(f.gate().state).toBe('ok');
      return executeRemovals(plan, snapshot, options);
    });
    const recover = vi.fn((options: Parameters<typeof recoverSnapshot>[0]) => {
      events.push('recover'); return recoverSnapshot(options);
    });
    const report = await f.confirm(preview.planHash!, { recoverSnapshot: recover });
    expect(report.status, report.error).toBe('completed'); expect(events).toEqual(['recover', 'record', 'remove']);
    expect(report.worktrees).toHaveLength(2); expect(report.worktrees.every(row => row.disposition === 'removed')).toBe(true);
    expect(f.publish).toHaveBeenCalledTimes(2); expect(f.refs().split('\n')).toHaveLength(2); expect(f.gate().state).toBe('ok');
    expect(git(f.primary, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(git(f.primary, 'for-each-ref', 'refs/worktree-cleanup/recover')).toBe('');
    for (const path of f.paths) {
      expect(existsSync(path)).toBe(false); expect(git(f.primary, 'rev-parse', `refs/heads/${path.split(/[\\/]/).at(-1)}`)).toBe(f.head);
    }
    const plan = await f.planner.mock.results.at(-1)!.value;
    if (plan.state !== 'ok') throw new Error('Plan failed');
    expect(plan.value.worktrees.every((tree: object) => !('snapshotPreflight' in tree))).toBe(true);
    const nightly = await runCleanup({ ...f.options, scheduledNightly: true }, quiet);
    expect(nightly.status, nightly.error).toBe('completed'); expect(f.gate().state).toBe('ok');
  });

  it('refuses a cleanup run whose report root is inside a candidate worktree', async () => {
    const f = commissioningFixture(1, true), inside = join(f.paths[0], '.cleanup-state');
    const report = await runCleanup({ ...f.options, scheduledNightly: true, reportRoot: inside }, quiet);
    expect(report.status).toBe('failed');
    expect(report.error).toContain('Cleanup report root must be outside candidate worktrees');
    expect(report.worktrees.every(row => row.disposition !== 'removed')).toBe(true);
    for (const path of f.paths) expect(existsSync(join(path, '.git'))).toBe(true);
    expect(f.refs()).toBe(''); expect(existsSync(join(inside, 'snapshots'))).toBe(false);
  });

  it('excludes a failed-push journal after scratch changes, without resuming or hashing its content', async () => {
    const f = commissioningFixture(1, true), firstPreview = await f.preview();
    f.runGit.mockImplementation((exe, args, options) => args.includes('push') ? unknown('Injected push failure') : runRescueCommand(exe, args, options));
    const firstConfirm = await f.confirm(firstPreview.planHash!);
    expect(firstConfirm.status).toBe('failed');
    const journalPath = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(f.paths[0])).digest('hex') + '.json');
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).state).toBe('not_pushed');
    expect(f.refs()).toBe('');
    writeFileSync(join(f.paths[0], '.tmp-intake/output.json'), '{"changed":true}\n'); age(f.paths[0]);
    const journalBefore = readFileSync(journalPath), sourceBefore = bytes(f.paths[0]), objectsBefore = git(f.primary, 'count-objects', '-v');
    f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear(); f.publish.mockClear();
    const nextPreview = await f.preview();
    expect(nextPreview.status, nextPreview.error).toBe('completed');
    const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${nextPreview.planHash}.json`), 'utf8'));
    expect(saved.candidates).toEqual([]);
    expect(saved.excluded).toEqual([{ path: normalizePath(f.paths[0]), reason: 'snapshot-bound',
      detail: 'Snapshot cannot resume commissioning' }]);
    expect(nextPreview.planHash).toBe(createHash('sha256').update('[]').digest('hex'));
    expect(nextPreview.planHash).not.toBe(firstPreview.planHash);
    expect(nextPreview.worktrees).toContainEqual(expect.objectContaining({ path: normalizePath(f.paths[0]), reasonCode: 'snapshot-bound', disposition: 'hold' }));
    expect(readFileSync(nextPreview.reportPath!, 'utf8')).toContain(`${JSON.stringify(normalizePath(f.paths[0]))}: snapshot-bound`);
    expect(f.planner.mock.calls.at(-1)![0].worktrees.some(tree => normalizePath(tree.path) === normalizePath(f.paths[0]))).toBe(false);
    expect(readFileSync(journalPath)).toEqual(journalBefore); expect(bytes(f.paths[0])).toEqual(sourceBefore);
    expect(git(f.primary, 'count-objects', '-v')).toBe(objectsBefore);
    const nextConfirm = await f.confirm(nextPreview.planHash!);
    expect(nextConfirm.status).toBe('failed'); expect(nextConfirm.error).toContain('No candidate published');
    expect(nextConfirm.worktrees).toContainEqual(expect.objectContaining({ reasonCode: 'snapshot-bound' }));
    expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(f.refs()).toBe(''); expect(readFileSync(journalPath)).toEqual(journalBefore); expect(bytes(f.paths[0])).toEqual(sourceBefore);
    expect(git(f.primary, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(git(f.primary, 'for-each-ref', 'refs/worktree-cleanup/recover')).toBe('');
  });

  it.each(['not_pushed', 'pushed_unverified', 'malformed'])('excludes a %s journal while commissioning an unbound tree', async state => {
    const f = commissioningFixture(2, true), snapshot = inventory(f.options);
    if (snapshot.state !== 'ok') throw new Error('Inventory failed');
    const facts = snapshot.value.worktrees.find(tree => normalizePath(tree.path) === normalizePath(f.paths[0]))!;
    const published = publishSnapshot(facts, preflightSnapshot(facts), f.options);
    if (published.state !== 'ok') throw new Error('Publication failed');
    const journalPath = published.value.journalPath;
    writeFileSync(journalPath, state === 'malformed' ? '{broken' : JSON.stringify({ ...published.value, state }));
    const before = readFileSync(journalPath); f.runGit.mockClear();
    const preview = await f.preview();
    expect(preview.status, preview.error).toBe('completed');
    const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${preview.planHash}.json`), 'utf8'));
    expect(saved.candidates.map((candidate: { path: string }) => candidate.path)).toEqual([normalizePath(f.paths[1])]);
    expect(saved.excluded).toEqual([{ path: normalizePath(f.paths[0]), reason: 'snapshot-bound',
      detail: state === 'malformed' ? 'Snapshot registration unavailable' : 'Snapshot cannot resume commissioning' }]);
    expect(preview.planHash).toBe(createHash('sha256').update(JSON.stringify(saved.candidates)).digest('hex'));
    expect(readFileSync(journalPath)).toEqual(before);
    const report = await f.confirm(preview.planHash!);
    expect(report.status, report.error).toBe('completed'); expect(f.publish).toHaveBeenCalledOnce();
    expect(normalizePath(f.publish.mock.calls[0][0].path)).toBe(normalizePath(f.paths[1]));
    expect(existsSync(f.paths[0])).toBe(true); expect(existsSync(f.paths[1])).toBe(false);
    expect(readFileSync(journalPath)).toEqual(before);
    expect(f.runGit.mock.calls.filter(([, args]) => args.includes('push'))).toHaveLength(1);
    expect(git(f.primary, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(git(f.primary, 'for-each-ref', 'refs/worktree-cleanup/recover')).toBe('');
  });

  it('commissions new scratch at a recreated path whose journal is removed', async () => {
    const f = commissioningFixture(1, true), firstPreview = await f.preview();
    const firstConfirm = await f.confirm(firstPreview.planHash!);
    expect(firstConfirm.status, firstConfirm.error).toBe('completed');
    const journalPath = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(f.paths[0])).digest('hex') + '.json');
    expect(JSON.parse(readFileSync(journalPath, 'utf8')).state).toBe('removed');
    const before = readFileSync(journalPath);
    git(f.primary, 'worktree', 'add', f.paths[0], 'scratch-0');
    mkdirSync(join(f.paths[0], '.tmp-intake')); writeFileSync(join(f.paths[0], '.tmp-intake/output.json'), '{"new":true}\n'); age(f.paths[0]);
    const preview = await f.preview();
    expect(preview.status, preview.error).toBe('completed');
    const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${preview.planHash}.json`), 'utf8'));
    expect(saved.excluded).toEqual([]); expect(saved.candidates.map((candidate: { path: string }) => candidate.path)).toEqual([normalizePath(f.paths[0])]);
    expect(preview.planHash).not.toBe(firstPreview.planHash); expect(readFileSync(journalPath)).toEqual(before);
    const report = await f.confirm(preview.planHash!);
    expect(report.status, report.error).toBe('completed'); expect(f.refs().split('\n')).toHaveLength(2);
    expect(existsSync(f.paths[0])).toBe(false);
    expect(git(f.primary, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(git(f.primary, 'for-each-ref', 'refs/worktree-cleanup/recover')).toBe('');
  });

  it.each(['stale', 'unknown', 'corrupt preview'])('refuses a %s hash before any push', async change => {
    const f = commissioningFixture(1, true), preview = await f.preview();
    if (change === 'stale') writeFileSync(join(f.paths[0], '.tmp-intake/output.json'), '{"changed":true}\n');
    if (change === 'corrupt preview') writeFileSync(join(f.reportRoot, `commission-preview-${preview.planHash}.json`), '{broken');
    const report = await f.confirm(change === 'unknown' ? '0'.repeat(64) : preview.planHash!);
    expect(report.status).toBe('failed'); expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.refs()).toBe(''); expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
  });

  it('retains pushed refs and removes nothing on a recovery digest mismatch', async () => {
    const f = commissioningFixture(1, true), preview = await f.preview();
    const report = await f.confirm(preview.planHash!, { recoverSnapshot: (options: Parameters<typeof recoverSnapshot>[0]) => {
      const recovered = recoverSnapshot(options); writeFileSync(join(options.dest, '.tmp-intake/output.json'), 'mismatch\n'); return recovered;
    } });
    expect(report.status).toBe('failed'); expect(report.error).toContain('refs remain'); expect(f.refs()).not.toBe('');
    expect(report.error).toContain('Recovery digest mismatch: .tmp-intake/output.json');
    expect(f.remove).not.toHaveBeenCalled(); expect(existsSync(f.paths[0])).toBe(true);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
    expect(readFileSync(report.reportPath!, 'utf8')).toContain('no commissioning record written and nothing removed');
  });

  it('records a transient recovery failure and resumes the next confirm without publishing again', async () => {
    const f = commissioningFixture(1, true), preview = await f.preview();
    let publishedRefs = '';
    const recover = vi.fn((options: Parameters<typeof recoverSnapshot>[0]) => recoverSnapshot(options))
      .mockImplementationOnce(() => {
        publishedRefs = f.refs(); return unknown('Injected transient recovery fetch failure');
      });
    const failed = await f.confirm(preview.planHash!, { recoverSnapshot: recover });
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('Injected transient recovery fetch failure');
    expect(failed.worktrees[0].reason).toBe(failed.error);
    expect(readFileSync(failed.reportPath!, 'utf8')).toContain('Injected transient recovery fetch failure');
    const journalPath = join(f.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(f.paths[0])).digest('hex') + '.json');
    const before = readFileSync(journalPath), record = JSON.parse(before.toString('utf8'));
    expect(record.state).toBe('published_verified'); expect(record.progress).toBeUndefined();
    expect(record.recoveryFailure).toEqual({ time: expect.any(String), reason: failed.error });
    expect(Number.isFinite(Date.parse(record.recoveryFailure.time))).toBe(true);
    expect(record.files.every((file: object) => !('bytes' in file))).toBe(true);
    expect(f.remove).not.toHaveBeenCalled(); expect(existsSync(f.paths[0])).toBe(true);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
    expect(publishedRefs).not.toBe(''); expect(f.refs()).toBe(publishedRefs);
    const sourceBefore = bytes(f.paths[0]), objectsBefore = git(f.primary, 'count-objects', '-v');
    f.publish.mockClear(); f.runGit.mockClear();
    const retry = await f.preview();
    expect(retry.status, retry.error).toBe('completed');
    const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${retry.planHash}.json`), 'utf8'));
    expect(saved.excluded).toEqual([]);
    expect(saved.candidates).toEqual([{ path: normalizePath(f.paths[0]), head: f.head,
      ref: record.ref, commitSha: record.commitSha, resumed: true,
      files: record.files.map(({ path, kind, digest }: { path: string; kind: string; digest: string }) => ({ path, kind, digest })) }]);
    expect(retry.planHash).toBe(createHash('sha256').update(JSON.stringify(saved.candidates)).digest('hex'));
    expect(readFileSync(retry.reportPath!, 'utf8')).toContain('Resumed');
    expect(readFileSync(journalPath)).toEqual(before); expect(bytes(f.paths[0])).toEqual(sourceBefore);
    expect(git(f.primary, 'count-objects', '-v')).toBe(objectsBefore); expect(f.refs()).toBe(publishedRefs);
    const report = await f.confirm(retry.planHash!, { recoverSnapshot: recover });
    expect(report.status, report.error).toBe('completed'); expect(recover).toHaveBeenCalledTimes(2);
    expect(f.publish).not.toHaveBeenCalled(); expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(f.refs()).toBe(publishedRefs);
    expect(JSON.parse(readFileSync(join(f.reportRoot, 'commissioning.json'), 'utf8')).refs)
      .toEqual([{ ref: record.ref, commitSha: record.commitSha }]);
    expect(existsSync(f.paths[0])).toBe(false);
    expect(git(f.primary, 'rev-parse', 'refs/heads/scratch-0')).toBe(f.head);
  });

  it('excludes failed-confirm retries for added, changed and deleted copy-set files', async () => {
    const f = publishedFixture('retained'), path = f.paths[0], preview = await f.preview();
    const failed = await f.confirm(preview.planHash!, { recoverSnapshot: () => unknown('Transient recovery failure') });
    expect(failed.status).toBe('failed'); expect(failed.error).toContain('Transient recovery failure');
    const before = readFileSync(f.journalPath), refs = f.refs();
    const original = readFileSync(join(path, '.tmp-intake/output.json'));
    f.publish.mockClear(); f.runGit.mockClear();
    for (const change of ['added untracked file', 'changed bytes', 'deleted copy-set file']) {
      if (change === 'added untracked file') writeFileSync(join(path, '.tmp-intake/added.json'), '{}\n');
      if (change === 'changed bytes') writeFileSync(join(path, '.tmp-intake/output.json'), '{"changed":true}\n');
      if (change === 'deleted copy-set file') rmSync(join(path, '.tmp-intake/output.json'));
      age(path);
      const sourceBefore = bytes(path), objectsBefore = git(f.primary, 'count-objects', '-v');
      const retry = await f.preview();
      expect(retry.status, change).toBe('completed');
      const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${retry.planHash}.json`), 'utf8'));
      expect(saved.candidates, change).toEqual([]);
      expect(saved.excluded, change).toEqual([{ path: normalizePath(path), reason: 'snapshot-bound', detail: 'Snapshot copy set no longer matches journal' }]);
      expect(retry.worktrees, change).not.toContainEqual(expect.objectContaining({ resumed: true }));
      expect(readFileSync(f.journalPath), change).toEqual(before); expect(bytes(path), change).toEqual(sourceBefore);
      expect(git(f.primary, 'count-objects', '-v'), change).toBe(objectsBefore);
      expect(f.publish, change).not.toHaveBeenCalled(); expect(f.remove, change).not.toHaveBeenCalled();
      expect(f.runGit.mock.calls.some(([, args]) => args.includes('push')), change).toBe(false);
      expect(existsSync(join(f.reportRoot, 'commissioning.json')), change).toBe(false); expect(f.refs(), change).toBe(refs);
      if (change === 'added untracked file') rmSync(join(path, '.tmp-intake/added.json'));
      writeFileSync(join(path, '.tmp-intake/output.json'), original); age(path);
    }
  });

  it('skips every resumed entry when fresh confirm inventory finds copy-set drift, without writing a record', async () => {
    const f = publishedFixture(), path = f.paths[0], retry = await f.preview(), refs = f.refs();
    const before = readFileSync(f.journalPath), preflight = vi.fn(preflightSnapshot), freshInventory = vi.fn(inventory);
    f.planner.mockImplementationOnce((snapshot, options) => {
      const plan = planWorktrees(snapshot, options);
      writeFileSync(join(path, '.tmp-intake/output.json'), '{"changed":true}\n'); age(path);
      return plan;
    });
    const recover = vi.fn(recoverSnapshot), report = await f.confirm(retry.planHash!, {
      inventory: freshInventory, preflightSnapshot: preflight, recoverSnapshot: recover,
    });
    expect(freshInventory).toHaveBeenCalledTimes(2); expect(preflight).toHaveBeenCalledTimes(2);
    expect(report.status).toBe('failed'); expect(report.error).toContain('No candidate published and verified');
    expect(report.worktrees).toContainEqual(expect.objectContaining({ reasonCode: 'snapshot-unverified', reason: 'Snapshot copy set no longer matches journal' }));
    expect(recover).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
    expect(existsSync(path)).toBe(true); expect(readFileSync(f.journalPath)).toEqual(before); expect(f.refs()).toBe(refs);
  });

  it('refreshes resumed status for a new path after planning and skips recovery', async () => {
    const f = publishedFixture(), path = f.paths[0], retry = await f.preview(), refs = f.refs();
    f.planner.mockImplementationOnce((snapshot, options) => {
      const plan = planWorktrees(snapshot, options);
      writeFileSync(join(path, 'outside-scratch.txt'), 'new work after planning\n'); age(path);
      return plan;
    });
    f.publish.mockClear(); f.runGit.mockClear();
    const recover = vi.fn(recoverSnapshot), report = await f.confirm(retry.planHash!, { recoverSnapshot: recover });
    expect(report.status).toBe('failed'); expect(report.error).toContain('No candidate published and verified');
    expect(report.worktrees).toContainEqual(expect.objectContaining({ reasonCode: 'snapshot-unverified',
      reason: 'Snapshot copy-set preflight failed: Snapshot evidence unreadable, changed or deadline exceeded' }));
    expect(recover).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
    expect(readFileSync(join(path, 'outside-scratch.txt'), 'utf8')).toBe('new work after planning\n'); expect(f.refs()).toBe(refs);
  });

  it.each([
    { change: 'new untracked file', reason: 'Status changed' },
    { change: 'changed copy-set bytes', reason: 'Snapshot file bytes changed' },
    { change: 'new ignored child', reason: 'Snapshot ignored directory scan unavailable' },
    { change: 'recent file activity', reason: 'Recent file activity' },
    { change: 'live Codex lease', reason: 'Classification activity unavailable' },
    { change: 'recent transcript mention', reason: 'Classification activity unavailable' },
  ])('holds a resumed candidate at removal after $change', async ({ change, reason }) => {
    const f = publishedFixture(change === 'new ignored child' ? 'ignored' : 'plain'), path = f.paths[0];
    const record = JSON.parse(readFileSync(f.journalPath, 'utf8'));
    expect(record.state, change).toBe('published_verified'); expect(record.progress, change).toBeUndefined();
    expect(f.remove, change).not.toHaveBeenCalled(); expect(existsSync(path), change).toBe(true);
    if (change === 'new ignored child') {
      expect(record.files, change).toContainEqual(expect.objectContaining({ path: '.tmp-intake/cache/original.json', kind: 'ignored' }));
    }
    // Lease/transcript evidence lives outside the copy set, so preview still admits
    // each resumed entry; removal must independently enforce its activity hold.
    if (change === 'live Codex lease') {
      const job = join(f.options.activityOptions.homeDirectory, '.claude', 'codex-jobs', 'resumed-lease');
      mkdirSync(job, { recursive: true });
      writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'resumed-lease', cwd: path, pid: process.pid, started_at: new Date().toISOString() }));
    }
    if (change === 'recent transcript mention') {
      const directory = join(f.options.activityOptions.homeDirectory, '.codex/sessions'), now = Date.now();
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'resumed-mention.jsonl'), [
        { type: 'session_meta', timestamp: new Date(now - 73 * 3_600_000).toISOString(), payload: { cwd: f.root } },
        { timestamp: new Date(now - 3_600_000).toISOString(), type: 'response_item',
          payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: `git -C "${path}" status` }) } },
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    }
    const refsBefore = git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)');
    expect(f.refs(), change).not.toBe('');
    const retry = await f.preview();
    expect(retry.status, change).toBe('completed');
    const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${retry.planHash}.json`), 'utf8'));
    expect(saved.excluded, change).toEqual([]);
    expect(saved.candidates, change).toEqual([expect.objectContaining({ path: normalizePath(path), resumed: true })]);
    expect(retry.planHash, change).toBe(createHash('sha256').update(JSON.stringify(saved.candidates)).digest('hex'));
    let sourceBefore = bytes(path);
    const recover = vi.fn((options: Parameters<typeof recoverSnapshot>[0]) => {
      const recovered = recoverSnapshot(options);
      // New untracked files, changed bytes and ignored children would now fail
      // preview's copy-set equality guard. Inject them after preview AND the
      // confirm-time resume check so only removal can observe and hold them.
      if (change === 'new ignored child') writeFileSync(join(path, '.tmp-intake/cache/added.json'), '{"new":true}\n');
      if (change === 'new untracked file') writeFileSync(join(path, '.tmp-intake/added.json'), '{"new":true}\n');
      if (change === 'changed copy-set bytes') writeFileSync(join(path, '.tmp-intake/output.json'), '{"changed":true}\n');
      // An mtime change leaves the preview copy set intact; inject it here too
      // to prove removal reads current file activity rather than admission facts.
      if (change === 'recent file activity') {
        const recent = new Date(); utimesSync(join(path, '.tmp-intake/output.json'), recent, recent);
      } else age(path);
      sourceBefore = bytes(path);
      return recovered;
    });
    const report = await f.confirm(retry.planHash!, { recoverSnapshot: recover });
    expect(recover, change).toHaveBeenCalledOnce(); expect(f.remove, change).toHaveBeenCalledOnce();
    expect(existsSync(join(path, '.git')), change).toBe(true); expect(bytes(path), change).toEqual(sourceBefore);
    expect(report.worktrees.find(row => normalizePath(row.path) === normalizePath(path)), change)
      .toMatchObject({ disposition: 'hold', reason });
    expect(f.publish, change).not.toHaveBeenCalled(); expect(f.runGit.mock.calls.some(([, args]) => args.includes('push')), change).toBe(false);
    expect(git(f.remote, 'for-each-ref', '--format=%(refname) %(objectname)'), change).toBe(refsBefore);
    expect(JSON.parse(readFileSync(f.journalPath, 'utf8')).state, change).toBe('published_verified');
  });

  it('preserves the recovery failure reason when its report row is missing', async () => {
    const f = commissioningFixture(1, true), preview = await f.preview();
    f.publish.mockImplementationOnce((tree, preflight, options) => {
      const published = publishSnapshot(tree, preflight, options);
      if (published.state !== 'ok') throw new Error('Publication failed');
      return ok({ ...published.value, treePath: normalizePath(join(f.root, 'missing-report-row')) });
    });
    const report = await f.confirm(preview.planHash!, { recoverSnapshot: () => unknown('Injected recovery failure without a report row') });
    expect(report.status).toBe('failed');
    expect(report.error).toContain('Recovery check failed: Injected recovery failure without a report row; refs remain');
    expect(report.error).toContain('recovery failure journal update refused');
    expect(f.remove).not.toHaveBeenCalled(); expect(existsSync(f.paths[0])).toBe(true);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
  });

  it('commissions resumed and new candidates together with only one new publication', async () => {
    const f = publishedFixture(), published = JSON.parse(readFileSync(f.journalPath, 'utf8'));
    const fresh = f.add('scratch-new'); f.paths.push(fresh);
    mkdirSync(join(fresh, '.tmp-intake'));
    writeFileSync(join(fresh, '.tmp-intake/output.json'), '{"scratch":true}\r\n'); age(fresh);
    const preview = await f.preview();
    const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${preview.planHash}.json`), 'utf8'));
    expect(saved.candidates).toHaveLength(2);
    expect(saved.candidates.filter((candidate: { resumed?: boolean }) => candidate.resumed)).toHaveLength(1);
    f.runGit.mockClear();
    const report = await f.confirm(preview.planHash!);
    expect(report.status, report.error).toBe('completed'); expect(f.publish).toHaveBeenCalledOnce();
    expect(normalizePath(f.publish.mock.calls[0][0].path)).toBe(normalizePath(f.paths[1]));
    expect(f.runGit.mock.calls.filter(([, args]) => args.includes('push'))).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(f.reportRoot, 'commissioning.json'), 'utf8'));
    expect(record.refs).toHaveLength(2);
    expect(record.refs).toContainEqual({ ref: published.ref, commitSha: published.commitSha });
    expect(f.paths.every(path => !existsSync(path))).toBe(true);
  });

  it('keeps verified journals bound for every resumable gate but admits a dead lock', async () => {
    const f = publishedFixture(), path = f.paths[0], original = readFileSync(f.journalPath);
    const record = JSON.parse(original.toString('utf8'));
    const child = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' }), pid = child.pid;
    await new Promise<void>((accept, reject) => {
      child.once('error', reject);
      child.once('close', code => code === 0 ? accept() : reject(new Error(`Lock-owner child exited ${code}`)));
    });
    if (pid === undefined) throw new Error('Lock-owner child has no PID');
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    for (const [change, detail] of [
      ['remote changed', 'Snapshot remote verification failed'],
      ['progress', 'Snapshot cannot resume commissioning'],
      ['head changed', 'Snapshot cannot resume commissioning'],
      ['live lock', 'Snapshot journal is in use'],
      ['dead lock', ''],
    ]) {
      if (change === 'remote changed') git(f.remote, 'update-ref', record.ref, f.head);
      if (change === 'progress') writeFileSync(f.journalPath, JSON.stringify({ ...record, progress: { cleaned: [], restored: [] } }));
      if (change === 'head changed') writeFileSync(f.journalPath, JSON.stringify({ ...record, head: f.ancestor }));
      if (change === 'live lock' || change === 'dead lock') writeFileSync(`${f.journalPath}.lock`, String(change === 'live lock' ? process.pid : pid));
      const before = readFileSync(f.journalPath), refs = f.refs(), sourceBefore = bytes(path);
      const preview = await f.preview();
      expect(preview.status, change).toBe('completed');
      const saved = JSON.parse(readFileSync(join(f.reportRoot, `commission-preview-${preview.planHash}.json`), 'utf8'));
      if (change === 'dead lock') {
        expect(saved.excluded, change).toEqual([]);
        expect(saved.candidates, change).toEqual([expect.objectContaining({ path: normalizePath(path), resumed: true })]);
        expect(preview.worktrees.find(row => normalizePath(row.path) === normalizePath(path)), change)
          .toMatchObject({ reasonCode: 'snapshot-resumed' });
        expect(readFileSync(`${f.journalPath}.lock`, 'utf8'), change).toBe(String(pid));
      } else {
        expect(saved.candidates, change).toEqual([]);
        expect(saved.excluded, change).toEqual([{ path: normalizePath(path), reason: 'snapshot-bound', detail }]);
        expect(preview.worktrees, change).toContainEqual(expect.objectContaining({ path: normalizePath(path), detail }));
        if (change === 'progress') {
          const report = await f.confirm(preview.planHash!);
          expect(report.status, change).toBe('failed'); expect(report.error, change).toContain('No candidate published');
          expect(existsSync(join(f.reportRoot, 'commissioning.json')), change).toBe(false);
        }
      }
      expect(f.publish, change).not.toHaveBeenCalled(); expect(f.remove, change).not.toHaveBeenCalled();
      expect(f.runGit.mock.calls.some(([, args]) => args.includes('push')), change).toBe(false);
      expect(readFileSync(f.journalPath), change).toEqual(before); expect(f.refs(), change).toBe(refs);
      expect(bytes(path), change).toEqual(sourceBefore); expect(existsSync(path), change).toBe(true);
      writeFileSync(f.journalPath, original);
      if (change === 'remote changed') git(f.remote, 'update-ref', record.ref, record.commitSha);
      if (change === 'live lock' || change === 'dead lock') rmSync(`${f.journalPath}.lock`);
    }
  });

  it('skips a resumed candidate that fails verification after the plan comparison', async () => {
    const f = publishedFixture(), retry = await f.preview(), refs = f.refs();
    f.publish.mockClear(); f.runGit.mockClear();
    const verify = vi.fn((record: { commitSha: string }): ReturnType<typeof ok> | ReturnType<typeof negative> => ok(record.commitSha))
      .mockImplementationOnce(record => ok(record.commitSha))
      .mockImplementationOnce(() => negative());
    const report = await f.confirm(retry.planHash!, { verifySnapshotRecord: verify });
    expect(report.status).toBe('failed'); expect(report.error).toContain('No candidate published');
    expect(report.worktrees).toContainEqual(expect.objectContaining({ reasonCode: 'snapshot-unverified' }));
    expect(verify).toHaveBeenCalledTimes(2);
    expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(f.refs()).toBe(refs); expect(existsSync(f.paths[0])).toBe(true);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
  });

  it.each(['ref', 'commitSha'] as const)('re-checks the resumed %s after plan comparison and before recovery', async field => {
    const f = publishedFixture(), retry = await f.preview(), refs = f.refs(), journalPath = f.journalPath;
    const sourceBefore = bytes(f.paths[0]);
    let verifications = 0;
    const verify = vi.fn((record: Parameters<typeof verifySnapshotRecord>[0], options: Parameters<typeof verifySnapshotRecord>[1]) => {
      const checked = verifySnapshotRecord(record, options);
      expect(checked.state).toBe('ok');
      // Inject a journal change only in the publish loop, after real remote verification.
      if (++verifications === 2) {
        const mutable = record as unknown as { ref: string; commitSha: string };
        mutable[field] = field === 'ref' ? mutable.ref + '-changed' : f.ancestor;
        writeFileSync(journalPath, JSON.stringify(record));
      }
      return checked;
    });
    f.publish.mockClear(); f.runGit.mockClear();
    const recover = vi.fn(recoverSnapshot), report = await f.confirm(retry.planHash!, { verifySnapshotRecord: verify, recoverSnapshot: recover });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(report.status).toBe('failed'); expect(report.error).toContain('No candidate published and verified');
    expect(report.worktrees).toContainEqual(expect.objectContaining({ reasonCode: 'snapshot-unverified' }));
    expect(recover).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
    expect(bytes(f.paths[0])).toEqual(sourceBefore); expect(f.refs()).toBe(refs);
  });

  it('refuses a resumed plan whose journal changes after preview', async () => {
    const f = publishedFixture(), retry = await f.preview(), journalPath = f.journalPath;
    const record = JSON.parse(readFileSync(journalPath, 'utf8'));
    writeFileSync(journalPath, JSON.stringify({ ...record, head: f.ancestor }));
    f.publish.mockClear(); f.runGit.mockClear();
    const report = await f.confirm(retry.planHash!);
    expect(report.status).toBe('failed'); expect(report.error).toContain('Commissioning preview mismatch');
    expect(f.publish).not.toHaveBeenCalled(); expect(f.remove).not.toHaveBeenCalled();
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  });

  it('keeps a valid record after an interrupted removal and lets nightly finish without another push', async () => {
    const f = commissioningFixture(2), preview = await f.preview();
    f.remove.mockImplementation((plan, snapshot, options) => executeRemovals(plan, snapshot, { ...options,
      onBeforeMutation: event => { if (normalizePath(event.path) === normalizePath(f.paths[1]) && event.kind === 'remove') throw new Error('Injected crash'); } }));
    const report = await f.confirm(preview.planHash!);
    expect(report.status).toBe('failed'); expect(f.gate().state).toBe('ok');
    expect(existsSync(f.paths[0])).toBe(false); expect(existsSync(f.paths[1])).toBe(true);
    f.runGit.mockClear();
    const nightly = await runCleanup({ ...f.options, scheduledNightly: true }, quiet);
    expect(nightly.status, nightly.error).toBe('completed'); expect(existsSync(f.paths[1])).toBe(false);
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
  });

  it('drops admission buffers on a publication veto and writes no record when nothing publishes', async () => {
    const f = commissioningFixture(1, true), preview = await f.preview();
    f.publish.mockImplementation(() => ({ ...negative(), veto: 'fixture-veto', journalState: null, journalPath: null }));
    const report = await f.confirm(preview.planHash!);
    expect(report.status).toBe('failed'); expect(f.remove).not.toHaveBeenCalled(); expect(f.refs()).toBe('');
    expect(existsSync(join(f.reportRoot, 'commissioning.json'))).toBe(false);
    const plan = await f.planner.mock.results.at(-1)!.value;
    if (plan.state !== 'ok') throw new Error('Plan failed');
    expect(plan.value.worktrees.every((tree: object) => !('snapshotPreflight' in tree))).toBe(true);
  });

  it('continues after a veto and removes only the verified candidate', async () => {
    const f = commissioningFixture(2, true), preview = await f.preview();
    f.publish.mockImplementationOnce(() => ({ ...negative(), veto: 'fixture-veto', journalState: null, journalPath: null }));
    const report = await f.confirm(preview.planHash!);
    expect(report.status, report.error).toBe('completed'); expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.gate().state).toBe('ok'); expect(f.refs().split('\n')).toHaveLength(1);
    expect(existsSync(f.paths[0])).toBe(true); expect(existsSync(f.paths[1])).toBe(false);
    expect(report.worktrees.find(row => normalizePath(row.path) === normalizePath(f.paths[0]))).toMatchObject({ disposition: 'hold', reasonCode: 'fixture-veto' });
  });
});

function identifyRelease(f: ReturnType<typeof fixture>, nonce = 'simulated-owner-release') {
  const path = join(coordinationDirectory(f.primary), 'owner.json');
  const owner = { ...JSON.parse(readFileSync(path, 'utf8')), nonce };
  writeFileSync(path, JSON.stringify(owner));
  return owner;
}
function runnerStub(f: ReturnType<typeof fixture>) {
  mkdirSync(join(f.primary, 'scripts'));
  writeFileSync(join(f.primary, 'scripts/worktree-cleanup.mjs'), `
    import { appendFileSync } from 'node:fs'; import { join } from 'node:path';
    import { admitRunLock } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/worktree-cleanup/report.mjs')).href)};
    const args = process.argv.slice(2), root = args[args.indexOf('--report-root') + 1];
    const row = { version: 1, runId: args[args.indexOf('--run-id') + 1], status: 'completed', worktrees: [] };
    let unlock;
    try {
      unlock = await admitRunLock(args[args.indexOf('--repo') + 1], root, 'nightly', {
        waitBudgetMs: process.env.WORKTREE_CLEANUP_TEST_OVERRIDES === '1' && process.env.WORKTREE_CLEANUP_LOCK_WAIT_MS
          ? Number(process.env.WORKTREE_CLEANUP_LOCK_WAIT_MS) : undefined,
      });
    } catch (error) { row.status = 'failed'; row.stage = 'lock'; row.error = error.message; process.exitCode = 1; }
    finally { if (unlock) await unlock(); }
    appendFileSync(join(root, 'journal.jsonl'), JSON.stringify(row) + '\\n');
  `);
  git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'fixture runner'); git(f.primary, 'push', 'origin', 'main');
}
function queued(f: ReturnType<typeof fixture>) {
  const directory = coordinationDirectory(f.primary);
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.ticket.json')) : [];
}
function queueCapability(runner: string) {
  const directory = join(runner, 'scripts/lib/worktree-cleanup');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'report.mjs'), 'export async function admitRunLock() {}\n');
}

describe('owner-release nightly lock handoff', { timeout: 60_000 }, () => {
  it.skipIf(process.platform !== 'win32').each(['fetch', 'checkout'])('preparation lock excludes owner-release admission during %s', async verb => {
    const f = fixture(); runnerStub(f);
    const copy = installed(f), paused = join(f.root, 'refresh-paused'), resume = join(f.root, 'refresh-resume');
    // Pause the real launcher at each refresh mutation, without a production test hook.
    const command = verb === 'fetch' ? "  Invoke-Git @('fetch'," : "    Invoke-Git @('-C', $runner, '-c', 'core.hooksPath=NUL', 'checkout',";
    const source = readFileSync(copy, 'utf8').replace(command, `  [IO.File]::WriteAllText($env:REFRESH_PAUSED, 'paused')
  while (-not [IO.File]::Exists($env:REFRESH_RESUME)) { Start-Sleep -Milliseconds 50 }
${command}`);
    writeFileSync(copy, source);
    const recordPath = join(f.reportRoot, 'installation.json'), record = JSON.parse(readFileSync(recordPath, 'utf8'));
    writeFileSync(recordPath, JSON.stringify({ ...record, launcherSha256: createHash('sha256').update(readFileSync(copy)).digest('hex') }));
    const run = psAsync(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath],
      { REFRESH_PAUSED: paused, REFRESH_RESUME: resume });
    let release: ReturnType<typeof admitRunLock> | undefined, unlock: Awaited<ReturnType<typeof admitRunLock>> | undefined;
    const wait = vi.fn(async () => { await new Promise(accept => setTimeout(accept, 50)); });
    try {
      expect(await waitUntil(() => existsSync(paused) || run.state.exited)).toBe(true);
      expect(existsSync(paused), run.state.stderr).toBe(true);
      release = admitRunLock(f.primary, f.reportRoot, 'owner-release', { wait, waitBudgetMs: 20_000 })
        .then(value => { unlock = value; return value; });
      expect(await waitUntil(() => wait.mock.calls.length > 0 || !!unlock)).toBe(true);
      expect(unlock).toBeUndefined(); expect(queued(f)).toHaveLength(1);
      writeFileSync(resume, 'resume');
      await release; await unlock!(); unlock = undefined;
      expect(await run.result, run.state.stderr).toBe(0);
      expect(journal(f.reportRoot).at(-1)).toMatchObject({ status: 'completed' });
    } finally {
      writeFileSync(resume, 'resume');
      if (release) await release.catch(() => {});
      if (unlock) await unlock();
      if (!run.state.exited) run.child.kill();
      await run.result;
    }
  });
  it('child waits when an owner release wins the preparation-to-child handoff', async () => {
    const f = fixture();
    let held: Awaited<ReturnType<typeof acquireRunLock>> | undefined, clock = Date.now();
    const waitForLock = vi.fn(async (ms: number) => { clock += ms; await held!(); held = undefined; });
    const take = vi.fn(async (repository: string, root: string, kind: string, options: object) => {
      if (take.mock.calls.length === 1) held = await acquireRunLock(repository, root, 'owner-release');
      return acquireRunLock(repository, root, kind, options);
    });
    try {
      const report = await runCleanup({ ...f.options, dryRun: true, now: () => clock }, { ...quiet, acquireRunLock: take, waitForLock });
      expect(waitForLock).toHaveBeenCalledOnce(); expect(take).toHaveBeenCalledTimes(2);
      expect(report.status, report.error).toBe('completed');
      expect(journal(f.reportRoot)).toEqual([expect.objectContaining({ status: 'completed' })]);
      expect(JSON.parse(readFileSync(join(coordinationDirectory(f.primary), 'owner.json'), 'utf8')).kind).toBe('nightly');
    } finally { if (held) await held(); }
  });

  it.each([undefined, 25])('expires the nightly wait budget (%s) with release identity in report and journal', async lockWaitMs => {
    const f = fixture(), held = await acquireRunLock(f.primary, f.reportRoot, 'owner-release');
    const owner = JSON.parse(readFileSync(join(coordinationDirectory(f.primary), 'owner.json'), 'utf8'));
    let clock = Date.now(); const started = clock, budget = lockWaitMs ?? 15 * 60_000;
    const waitForLock = vi.fn(async () => { clock += budget; });
    try {
      const report = await runCleanup({ ...f.options, now: () => clock, ...(lockWaitMs === undefined ? {} : { lockWaitMs }) }, { ...quiet, waitForLock });
      expect(waitForLock).toHaveBeenCalledOnce();
      expect(report).toMatchObject({ status: 'failed', stage: 'lock' });
      expect(report.finishedAt - started).toBe(budget);
      for (const text of [report.error!, journal(f.reportRoot).at(-1).error, readFileSync(report.reportPath!, 'utf8')]) {
        expect(text).toContain('occupied'); expect(text).toContain('owner-release');
        expect(text).toContain(owner.nonce); expect(text).toContain(String(owner.pid));
      }
      expect(f.runGh).not.toHaveBeenCalled();
    } finally { await held(); }
  });

  it.each(['nightly', 'legacy', 'unreadable', 'OWNER-RELEASE'])('bounds the nightly wait for a %s holder', async kind => {
    const f = fixture(), held = await acquireRunLock(f.primary, f.reportRoot);
    const ownerPath = join(coordinationDirectory(f.primary), 'owner.json');
    if (kind === 'legacy') writeFileSync(ownerPath, JSON.stringify({ pid: process.pid }));
    if (kind === 'unreadable') writeFileSync(ownerPath, '{torn');
    if (kind === 'OWNER-RELEASE') writeFileSync(ownerPath, JSON.stringify({ kind }));
    let clock = Date.now();
    const waitForLock = vi.fn(async () => { clock += 900_000; });
    try {
      const report = await runCleanup({ ...f.options, now: () => clock }, { ...quiet, waitForLock });
      expect(report).toMatchObject({ status: 'failed', stage: 'lock', error: expect.stringContaining('occupied') });
      expect(waitForLock).toHaveBeenCalledOnce(); expect(f.runGh).not.toHaveBeenCalled();
    } finally { await held(); }
  });

  it('keeps the nightly wait bounded when a nightly holder replaces a release', async () => {
    const f = fixture(); let held = await acquireRunLock(f.primary, f.reportRoot, 'owner-release');
    let clock = Date.now();
    const waitForLock = vi.fn(async () => {
      if (waitForLock.mock.calls.length === 1) { await held(); held = await acquireRunLock(f.primary, f.reportRoot); }
      clock += 450_000;
    });
    try {
      const report = await runCleanup({ ...f.options, now: () => clock }, { ...quiet, waitForLock });
      expect(waitForLock).toHaveBeenCalledTimes(2); expect(report.error).toContain('occupied');
      expect(report.status).toBe('failed');
    } finally { await held(); }
  });

  it.skipIf(process.platform !== 'win32')('launcher waits for release, then completes one night without a skipped report', async () => {
    const f = fixture('primary checkout'); runnerStub(f);
    const copy = installed(f), held = await acquireRunLock(f.primary, f.reportRoot, 'owner-release');
    let released = false;
    const run = psAsync(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath], { WORKTREE_CLEANUP_LOCK_WAIT_MS: '10000' });
    try {
      expect(await waitUntil(() => run.state.exited || run.state.stdout.includes('Waiting for cleanup preparation lock.'))).toBe(true);
      expect(queued(f)).toEqual([]);
      expect(run.state.exited).toBe(false); expect(existsSync(join(f.reportRoot, 'journal.jsonl'))).toBe(false);
      await held(); released = true;
      expect(await run.result, run.state.stderr).toBe(0);
      expect(journal(f.reportRoot)).toEqual([expect.objectContaining({ status: 'completed' })]);
      expect(queued(f)).toEqual([]);
    } finally {
      if (!released) await held();
      if (!run.state.exited) run.child.kill();
      await run.result;
    }
  });

  it.skipIf(process.platform !== 'win32').each(['owner-release', 'nightly', 'OWNER-RELEASE'] as const)('launcher bounds preparation waiting for its %s holder', async kind => {
    const f = fixture(); runnerStub(f);
    const copy = installed(f), held = await acquireRunLock(f.primary, f.reportRoot, kind === 'owner-release' ? kind : 'nightly'), owner = identifyRelease(f);
    if (kind === 'OWNER-RELEASE') writeFileSync(join(coordinationDirectory(f.primary), 'owner.json'), JSON.stringify({ ...owner, kind }));
    const run = psAsync(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath], { WORKTREE_CLEANUP_LOCK_WAIT_MS: '2500' });
    try {
      expect(await run.result, run.state.stderr).toBe(1);
      const row = journal(f.reportRoot).at(-1);
      expect(row).toMatchObject({ status: 'failed', stage: 'launcher' });
      expect(row.error).toContain('occupied');
      expect(run.state.stdout).toContain('Waiting for cleanup preparation lock.');
      expect(queued(f)).toEqual([]);
    } finally { await held(); if (!run.state.exited) run.child.kill(); await run.result; }
  });

  it.skipIf(process.platform !== 'win32')('ignores a stale old-location owner.json during launcher admission', () => {
    const f = fixture(); runnerStub(f); const copy = installed(f);
    const oldDirectory = join(f.reportRoot, 'locks', `${lockPort(f.primary)}.lock`);
    mkdirSync(oldDirectory, { recursive: true });
    const oldPath = join(oldDirectory, 'owner.json'), old = JSON.stringify({ kind: 'owner-release', pid: process.pid, creationTime: 'stale' });
    writeFileSync(oldPath, old);
    const result = ps(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath]);
    expect(result.status, result.stderr).toBe(0);
    expect(journal(f.reportRoot)).toEqual([expect.objectContaining({ status: 'completed' })]);
    expect(readFileSync(oldPath, 'utf8')).toBe(old);
    expect(JSON.parse(readFileSync(join(coordinationDirectory(f.primary), 'owner.json'), 'utf8')).kind).toBe('nightly');
  });
});

describe('installed owner-release entrypoint', { timeout: 60_000 }, () => {
  it.skipIf(process.platform !== 'win32')('reads the link index from a custom InstallRoot', () => {
    const base = fixture(), f = { ...base, reportRoot: join(base.root, 'custom cleanup state') };
    const target = f.add('target'); installed(f);
    const snapshot = inventory({ repositoryPath: f.primary, runnerPath: f.primary });
    if (snapshot.state !== 'ok') throw new Error('Fixture inventory unavailable');
    writeLinkIndex(f.reportRoot, snapshot.value);
    const runner = join(f.primary, '.worktrees/.worktree-cleanup-runner');
    queueCapability(runner);
    mkdirSync(join(runner, 'scripts'), { recursive: true });
    writeFileSync(join(runner, 'scripts/worktree-cleanup.mjs'), `
      import { main } from ${JSON.stringify(pathToFileURL(resolve('scripts/worktree-cleanup.mjs')).href)};
      import { runRelease } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/worktree-cleanup/release.mjs')).href)};
      const command = process.argv[2];
      if (command === 'release') {
        process.exitCode = await main(process.argv.slice(2), { runRelease: options => runRelease({ ...options,
          ghPath: process.execPath, runGh: () => ({ state: 'unknown', reason: 'fixture PR stop after index' }),
          activityOptions: { homeDirectory: ${JSON.stringify(join(f.root, 'home'))} } }) });
      }
    `);
    const result = ps(join(f.reportRoot, 'release-worktree.ps1'), [target, '-OwnerSession', 'fixture owner', '-NodePath', process.execPath]);
    expect(result.status, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ reasonCode: 'pr-unknown' });
    expect(JSON.parse(readFileSync(join(f.reportRoot, 'owner-release-journal.jsonl'), 'utf8'))).toMatchObject({ reasonCode: 'pr-unknown', mutations: [] });
    expect(existsSync(target)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('installer copies the release entrypoint beside the launcher with exact bytes', () => {
    const f = fixture(); installed(f);
    expect(existsSync(join(f.reportRoot, 'release-worktree.ps1'))).toBe(true);
    expect(readFileSync(join(f.reportRoot, 'release-worktree.ps1'))).toEqual(readFileSync(releaseEntrypoint));
  });

  it.skipIf(process.platform !== 'win32').each(['absent', 'comment-only', 'case-mismatch', 'present'] as const)(
    'installed-entrypoint cutover checks the admission queue marker: %s', mode => {
      const f = fixture(); installed(f);
      const target = f.add('cutover-target'), runner = join(f.primary, '.worktrees/.worktree-cleanup-runner');
      const marker = join(f.root, 'cli-invoked');
      mkdirSync(join(runner, 'scripts'), { recursive: true });
      writeFileSync(join(runner, 'scripts/worktree-cleanup.mjs'), `
        import { writeFileSync } from 'node:fs';
        const command = process.argv[2];
        if (command === 'release') { writeFileSync(${JSON.stringify(marker)}, 'invoked'); console.log('fixture CLI'); }
      `);
      if (mode !== 'absent') {
        queueCapability(runner);
        if (mode !== 'present') writeFileSync(join(runner, 'scripts/lib/worktree-cleanup/report.mjs'),
          mode === 'comment-only' ? '// export async function admitRunLock() {}\n' : 'export async function AdmitRunLock() {}\n');
      }
      const before = bytes(f.primary), targetBefore = bytes(target);
      const result = ps(join(f.reportRoot, 'release-worktree.ps1'), [target, '-NodePath', process.execPath]);
      expect(result.status, result.stderr).toBe(mode === 'present' ? 0 : 3);
      if (mode === 'present') expect(result.stdout.trim()).toBe('fixture CLI');
      else expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: 'refused', reasonCode: 'runner-outdated', exitCode: 3 });
      expect(existsSync(marker)).toBe(mode === 'present');
      expect(bytes(f.primary)).toEqual(before); expect(bytes(target)).toEqual(targetBefore);
      expect(existsSync(join(f.reportRoot, 'owner-release-journal.jsonl'))).toBe(false);
    });

  it.skipIf(process.platform !== 'win32').each(['missing', 'old', 'case-mismatch'])('refuses a %s runner without release support before invoking node', mode => {
    const f = fixture(); installed(f);
    const runner = join(f.primary, '.worktrees/.worktree-cleanup-runner'), marker = join(f.root, 'must-not-run');
    if (mode !== 'missing') {
      mkdirSync(join(runner, 'scripts'), { recursive: true });
      writeFileSync(join(runner, 'scripts/worktree-cleanup.mjs'), `import { writeFileSync } from 'node:fs';\n// release is mentioned, but is not implemented\n${mode === 'case-mismatch' ? "const command = process.argv[2];\nif (command === 'Release') {}\n" : ''}writeFileSync(${JSON.stringify(marker)}, 'invoked');\n`);
    }
    const result = ps(join(f.reportRoot, 'release-worktree.ps1'), [join(f.root, 'target checkout'), '-NodePath', join(f.root, 'missing.exe')]);
    expect(result.status, result.stderr).toBe(3);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ outcome: 'refused', reasonCode: 'runner-outdated' });
    expect(existsSync(marker)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32').each([0, 3, 1])('forwards target, installed repo, runner and owner session; preserves exit %s', exitCode => {
    const f = fixture('primary checkout'); installed(f);
    const runner = join(f.primary, '.worktrees/.worktree-cleanup-runner'), target = join(f.root, 'target checkout');
    queueCapability(runner);
    mkdirSync(join(runner, 'scripts'), { recursive: true });
    writeFileSync(join(runner, 'scripts/worktree-cleanup.mjs'), `
      const args = process.argv.slice(2), command = args[0];
      if (command === 'release') {
        console.log(JSON.stringify({ args, ownerDefault: process.env.OWNER_SESSION_ID })); process.exit(${exitCode});
      }
      process.exit(8);
    `);
    for (const ownerFlag of ['-OwnerSession', '--owner-session', null]) {
      const result = ps(join(f.reportRoot, 'release-worktree.ps1'), [target, '-NodePath', process.execPath, ...(ownerFlag ? [ownerFlag, 'fixture owner'] : [])], { OWNER_SESSION_ID: 'from-env' });
      expect(result.status, result.stderr).toBe(exitCode);
      expect(JSON.parse(result.stdout.trim())).toEqual({ args: ['release', target, '--repo', f.primary, '--runner', runner, '--report-root', f.reportRoot,
        ...(ownerFlag ? ['--owner-session', 'fixture owner'] : [])], ownerDefault: 'from-env' });
    }
  });
});

function sleepingNode(f: ReturnType<typeof fixture>) {
  const fake = join(f.root, 'fake node.exe'), pids = join(f.root, 'node-pids.txt');
  const source = join(f.root, 'node.cs'), compile = join(f.root, 'compile-node.ps1');
  writeFileSync(source, `
    using System;
    using System.Diagnostics;
    using System.IO;
    using System.Threading;
    public class FakeNode {
      public static void Main(string[] args) {
        if (Array.IndexOf(args, "--child") >= 0) { Thread.Sleep(60000); return; }
        var child = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--child") { UseShellExecute = false, CreateNoWindow = true });
        File.WriteAllLines(Environment.GetEnvironmentVariable("FAKE_PIDS"), new string[] { Process.GetCurrentProcess().Id.ToString(), child.Id.ToString() });
        Thread.Sleep(60000);
      }
    }
  `);
  writeFileSync(compile, 'Add-Type -Path $env:FAKE_SOURCE -OutputAssembly $env:FAKE_EXE -OutputType ConsoleApplication\n');
  const compiled = ps(compile, [], { FAKE_SOURCE: source, FAKE_EXE: fake });
  expect(compiled.status, compiled.stderr).toBe(0);
  return { fake, pids };
}
function alive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
}
async function waitUntil(check: () => boolean, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  return check();
}
async function childLifetime(mode: 'timeout' | 'kill-on-close') {
  const f = fixture('primary checkout'), copy = installed(f), { fake, pids } = sleepingNode(f);
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', copy,
    '-NodePath', fake, '-GitPath', gitPath, '-GhPath', process.execPath], {
    env: { ...env, FAKE_PIDS: pids, WORKTREE_CLEANUP_CHILD_TIMEOUT_MS: mode === 'timeout' ? '5000' : '30000' },
    windowsHide: true, stdio: 'ignore',
  });
  let exited = false;
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => { exited = true; resolve(code); });
  });
  let children: number[] = [];
  try {
    expect(await waitUntil(() => existsSync(pids)), 'fake node must start').toBe(true);
    children = readFileSync(pids, 'utf8').trim().split(/\r?\n/).map(Number);
    expect(children).toHaveLength(2);
    expect(children.every(alive)).toBe(true);
    if (mode === 'kill-on-close') child.kill('SIGKILL');
    expect(await waitUntil(() => exited), 'launcher must exit within test deadline').toBe(true);
    const code = await exit;
    expect(await waitUntil(() => children.every(pid => !alive(pid)), 5000), 'no fake node or descendant may survive').toBe(true);
    if (mode === 'timeout') {
      expect(code).toBe(1);
      const row = journal(f.reportRoot).at(-1);
      expect(row).toMatchObject({ status: 'failed', stage: 'timeout', error: expect.stringMatching(/overran.*5000 ms/i) });
      expect(row.finishedAt - row.startedAt).toBeGreaterThanOrEqual(5000);
      expect(row.finishedAt - row.startedAt).toBeLessThan(12_000);
    }
  } finally {
    // Red runs also clean up their intentionally unbounded fixture processes.
    for (const pid of [...children, child.pid].filter((pid): pid is number => pid !== undefined)) {
      if (alive(pid)) spawnSync('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { windowsHide: true });
    }
    await exit;
  }
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Fixture escaped temp directory');
    rmSync(root, { recursive: true, force: true });
  }
});

afterAll(() => {
  for (const { directory } of templates.values()) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep)) throw new Error('Template escaped temp directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('U5b reach observation reports', { timeout: 60_000 }, () => {
  const day = 86_400_000;
  const unresolved = 'Recent transcript unavailable: Unresolved relative command path';
  const zeroCounts = { variable: 0, 'command-substitution': 0, 'chained-cd': 0, 'climb-out': 0,
    'unparsable-exec': 0, 'non-literal-command': 0, other: 0 };
  const residualZeros = 'Residual folder-wide doubt (records, reach rule): variable: 0; command-substitution: 0; chained-cd: 0; climb-out: 0; unparsable-exec: 0; non-literal-command: 0; other: 0.';
  type Activity = Awaited<ReturnType<typeof collectActivity>>[number];
  function observationActivity(overrides: Partial<Activity> = {}): Activity {
    return { lease: negative(), fileActivity: negative(), head: ok('a'.repeat(40)), live: unknown('Activity evidence unknown: transcript'),
      liveReasons: [{ code: 'unresolved-command', state: 'unknown' }],
      transcript: { ...unknown(unresolved), bookkeepingVersion: 1, observed: negative(), residualDoubtCounts: { ...zeroCounts } }, ...overrides };
  }
  const heldRow = (path: string, reasonCode = 'unresolved-command', reason = reasonCode, wouldBeRemovable = true) => ({
    path, action: 'hold', disposition: 'hold', reasonCode, reason, wouldBeRemovable,
  });

  it.each([false, true])('lists only would-release held trees, their signals and additional holds (dry=%s)', dryRun => {
    const f = fixture(), now = Date.now(), idle = join(f.root, 'idle|<tree>\nnext'), both = join(f.root, 'both'),
      control = join(f.root, 'glob-control'), links = join(f.root, 'linked'), files = join(f.root, 'recent-write'),
      lease = join(f.root, 'lease'), removed = join(f.root, 'removed');
    const activityRows = [
      { path: idle, activity: observationActivity() },
      { path: both, activity: observationActivity({ transcript: { ...observationActivity().transcript, observed: unknown(unresolved) } }) },
      { path: control, activity: observationActivity({ transcript: { ...observationActivity().transcript, ...ok({ count: 1 }), observed: ok({ count: 1 }) } }) },
      { path: links, activity: observationActivity() },
      // The JS scan mutates newestMtimeMs inside a callback; its inferred value is never.
      { path: files, activity: observationActivity({ fileActivity: ok({ newestMtimeMs: now - day }) as Activity['fileActivity'],
        liveReasons: [{ code: 'unresolved-command', state: 'unknown' }, { code: 'file-activity', state: 'ok' }] }) },
      { path: lease, activity: observationActivity({ lease: unknown('Lease unavailable'),
        liveReasons: [{ code: 'unresolved-command', state: 'unknown' }, { code: 'lease-unknown', state: 'unknown' }] }) },
      { path: removed, activity: observationActivity() },
    ];
    const report = writeRunReport(f.reportRoot, { runId: 'reach-signals', startedAt: now, finishedAt: now, status: 'completed', stage: 'complete', dryRun,
      worktrees: [heldRow(idle), heldRow(both), heldRow(control, 'transcript'),
        heldRow(links, 'links', 'Forbidden links: <target>|node_modules\nmanual release', false), heldRow(files), heldRow(lease),
        { path: removed, action: 'remove', disposition: 'removed', reasonCode: 'removed' }] }, activityRows);
    const text = readFileSync(report.reportPath, 'utf8'), list = text.split('## Reach rule would-release list\n\n')[1];
    expect(text).toContain('Reach rule (observing; deciding rule: folder, reach version 2): would release 4. Held only by unresolved-command doubt: 1.');
    expect(text).toContain(residualZeros);
    expect(list).toContain(`| ${join(f.root, 'idle\\|&lt;tree&gt; next')} | unresolved-command | negative | none | not-evaluated | none within 72 h |`);
    expect(list).toContain(`| ${links} | links; Forbidden links: &lt;target&gt;\\|node_modules manual release; unresolved-command | negative | none | not-evaluated | none within 72 h |`);
    expect(list).toContain(`| ${files} | unresolved-command; file-activity | negative | 1.0 days ago | not-evaluated | none within 72 h |`);
    expect(list).toContain(`| ${lease} | unresolved-command; lease-unknown | unknown | none | not-evaluated | none within 72 h |`);
    for (const path of [both, control, removed]) expect(list).not.toContain(path);
    expect(report).toMatchObject({ status: 'completed', wouldBeRemovable: 5,
      reasonCounts: { 'unresolved-command': 4, transcript: 1, links: 1 } });
  });

  it.each([false, true])('passes real transcript observation to the report and excludes the live control running a relative glob (dry=%s)', async dryRun => {
    const f = fixture(), idle = f.add('idle'), doubt = f.add('glob-doubt'), control = f.add('glob-control'), now = Date.now();
    const directory = join(f.options.activityOptions.homeDirectory, '.codex/sessions'); mkdirSync(directory, { recursive: true });
    const command = (cmd: string, workdir?: string) => ({ timestamp: new Date(now - 3_600_000).toISOString(), type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify(workdir ? { workdir, cmd } : { cmd }) } });
    writeFileSync(join(directory, 'observation.jsonl'), [
      { type: 'session_meta', timestamp: new Date(now - 73 * 3_600_000).toISOString(), payload: { cwd: f.root } },
      command('git -C primary status'), command('ls docs/*', control), command('ls glob-*'),
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const collected = new Map<string, Activity>();
    const report = await runCleanup({ ...f.options, dryRun, now: () => now,
      activityOptions: { ...f.options.activityOptions, now: () => now } }, { ...quiet,
      collectActivity: async (trees: Parameters<typeof collectActivity>[0], options: Parameters<typeof collectActivity>[1]) => {
        const rows = await collectActivity(trees, options);
        trees.forEach((tree, index) => collected.set(resolve(tree.path), rows[index]));
        return rows;
      } });
    expect(report.status, JSON.stringify(report)).toBe('completed');
    expect(collected.get(idle)?.transcript).toMatchObject({ state: 'unknown', reason: unresolved, observed: { state: 'negative' } });
    expect(collected.get(doubt)?.transcript).toMatchObject({ state: 'unknown', observed: { state: 'unknown' } });
    expect(collected.get(control)?.transcript).toMatchObject({ state: 'ok', observed: { state: 'ok' } });
    expect(report.worktrees.find(tree => resolve(tree.path) === control)?.disposition).toBe('hold');
    const text = readFileSync(report.reportPath!, 'utf8'), list = text.split('## Reach rule would-release list\n\n')[1];
    expect(text).toContain('Reach rule (observing; deciding rule: folder, reach version 2): would release 1. Held only by unresolved-command doubt: 1.');
    expect(text).toContain(residualZeros);
    const reportedPath = (path: string) => report.worktrees.find(tree => resolve(tree.path) === path)?.path;
    expect(list).toContain(`| ${reportedPath(idle)} |`);
    expect(list).not.toContain(`| ${reportedPath(doubt)} |`);
    expect(list).not.toContain(`| ${reportedPath(control)} |`);
  });

  it('prints each residual class once from the per-run counts repeated on transcript evidence', () => {
    const f = fixture(), now = Date.now(), residualDoubtCounts = { variable: 1, 'command-substitution': 2, 'chained-cd': 3, 'climb-out': 4,
      'unparsable-exec': 5, 'non-literal-command': 6, other: 7 };
    const paths = [join(f.root, 'first'), join(f.root, 'second')];
    const report = writeRunReport(f.reportRoot, { runId: 'residual-classes', startedAt: now, finishedAt: now, status: 'completed', stage: 'complete',
      worktrees: paths.map(path => heldRow(path)) }, paths.map(path => ({ path,
      activity: observationActivity({ transcript: { ...observationActivity().transcript, residualDoubtCounts } }) })));
    expect(readFileSync(report.reportPath, 'utf8')).toContain('Residual folder-wide doubt (records, reach rule): variable: 1; command-substitution: 2; chained-cd: 3; climb-out: 4; unparsable-exec: 5; non-literal-command: 6; other: 7.');
  });

  it.each([false, true])('keeps dispositions, reason counts, wouldBeRemovable and the entire journal row identical with observation stripped (dry=%s)', dryRun => {
    const f = fixture(), now = Date.now(), path = join(f.root, 'idle');
    const reportInput = () => ({ runId: 'observation-inert', startedAt: now, finishedAt: now, status: 'completed', stage: 'complete', dryRun,
      worktrees: [heldRow(path)] });
    const activityRows = [{ path, activity: observationActivity() }];
    const withObservation = writeRunReport(f.reportRoot, reportInput(), activityRows);
    const text = readFileSync(withObservation.reportPath, 'utf8');
    rmSync(withObservation.reportPath);
    const stripped = structuredClone(activityRows);
    Reflect.deleteProperty(stripped[0].activity.transcript, 'observed');
    Reflect.deleteProperty(stripped[0].activity.transcript, 'residualDoubtCounts');
    const withoutObservation = writeRunReport(f.reportRoot, reportInput(), stripped);
    expect(withoutObservation).toEqual(withObservation);
    expect(journal(f.reportRoot)).toEqual([withObservation, withObservation]);
    expect(withoutObservation).toMatchObject({ status: 'completed', counts: { hold: 1 }, reasonCounts: { 'unresolved-command': 1 }, wouldBeRemovable: 1,
      worktrees: [{ disposition: 'hold', wouldBeRemovable: true }] });
    expect(text).toContain('would release 1.');
    const strippedText = readFileSync(withoutObservation.reportPath, 'utf8');
    expect(strippedText).toContain('would release 0.');
    expect(strippedText).toContain('Residual folder-wide doubt (records, reach rule): not-evaluated.');
  });
});

describe('U6 launcher and run coordination', { timeout: 60_000 }, () => {
  function seedIdleJournal(f: ReturnType<typeof fixture>) {
    mkdirSync(f.reportRoot, { recursive: true });
    const idlePath = join(f.reportRoot, 'idle-journal.jsonl');
    const activity = { lease: negative(), transcript: negative(), fileActivity: negative(), live: negative(), liveReasons: [], head: ok(git(f.primary, 'rev-parse', 'HEAD')) };
    expect(appendIdleObservation(f.primary, activity, { journalPath: idlePath, gitPath, now: () => Date.now() - 86_400_000 })).toMatchObject({ state: 'ok' });
    return { idlePath, before: readFileSync(idlePath) };
  }
  it.each([
    { flags: ['--scheduled-nightly'], persists: true },
    { flags: ['--manual'], persists: false },
    { flags: ['--dry-run'], persists: false },
    { flags: ['--dry-run', '--scheduled-nightly'], persists: false },
    { flags: ['--dry-run', '--manual'], persists: false },
  ])('U1 owns persistent observations only for live scheduled runs: $flags', async ({ flags, persists }) => {
    const f = fixture(); f.add('first'); f.add('second');
    const { idlePath, before } = seedIdleJournal(f);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {}), append = vi.fn(appendIdleObservation);
    const classify = vi.fn(async (snapshot: Parameters<typeof planWorktrees>[0], options: Parameters<typeof planWorktrees>[1]) => {
      const planned = await planWorktrees(snapshot, { ...options, prSnapshot: ok(f.prs) });
      if (planned.state !== 'ok') return planned;
      return ok({ ...planned.value, worktrees: planned.value.worktrees.map(tree => ({ ...tree, disposition: 'hold' as const, reason: 'Fixture hold' })) });
    });
    const exit = await main(['run', ...flags, '--repo', f.primary, '--runner', f.primary, '--report-root', f.reportRoot, '--git', gitPath, '--gh', process.execPath], {
      ...quiet, inventory, runProbe: probe, appendIdleObservation: append, planWorktrees: classify,
      collectActivity: async (trees: Parameters<typeof collectActivity>[0]) => trees.map(tree => ({ lease: negative(), transcript: negative(), fileActivity: negative(),
        live: negative(), liveReasons: [], head: tree.registration.state === 'ok' && tree.registration.value.head !== null ? ok(tree.registration.value.head) : unknown('Invalid registration') })),
    });
    expect(exit, String(output.mock.calls.at(-1)?.[0])).toBe(0);
    const report = journal(f.reportRoot).at(-1);
    expect(report.phaseDurations).toContainEqual({ phase: 'idle-observations', ms: expect.any(Number) });
    const previewPath = classify.mock.calls[0][1]?.idleJournalOptions?.journalPath;
    expect(previewPath).toEqual(expect.any(String)); expect(previewPath).not.toBe(idlePath);
    expect(existsSync(previewPath!)).toBe(false);
    if (persists) {
      const after = readFileSync(idlePath);
      expect(after.subarray(0, before.length)).toEqual(before);
      expect(after.subarray(before.length).toString('utf8').trim().split(/\r?\n/)).toHaveLength(report.worktrees.length);
      expect(append.mock.calls.map(([path]) => resolve(path)).sort()).toEqual(report.worktrees.map((tree: { path: string }) => resolve(tree.path)).sort());
      for (const [, , options] of append.mock.calls) expect(options?.journalPath).toBe(idlePath);
    } else {
      expect(readFileSync(idlePath)).toEqual(before);
      expect(append).not.toHaveBeenCalled();
    }
  });
  it('U1 keeps the manual projection alive through archive cleanup', async () => {
    const f = fixture(), treePath = f.add('archive');
    writeFileSync(join(treePath, 'notes.txt'), 'private scratch\n'); age(treePath);
    const { idlePath, before } = seedIdleJournal(f), archivePath = join(f.reportRoot, 'fixture-archive');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    let classificationPath: string | undefined;
    const prepare = vi.fn((path: string, snapshot: InventorySnapshot, options: { journalPath: string }) => {
      expect(path).toBe(archivePath); expect(snapshot.worktrees.some(tree => resolve(tree.path) === treePath)).toBe(true);
      expect(options.journalPath).toBe(classificationPath); expect(options.journalPath).not.toBe(idlePath);
      expect(existsSync(options.journalPath)).toBe(true);
      expect(readFileSync(options.journalPath)).not.toEqual(before);
      expect(readFileSync(idlePath)).toEqual(before);
      return ok({ disposition: 'hold' as const, reason: 'Fixture archive recheck', mutations: [] });
    });
    const exit = await main(['run', '--manual', '--repo', f.primary, '--runner', f.primary, '--report-root', f.reportRoot, '--git', gitPath, '--gh', process.execPath], {
      ...quiet, inventory, runProbe: probe, prepareArchivedTree: prepare,
      createArchive: () => ok({ archivePath, restoreCommand: 'fixture restore' }),
      collectActivity: async (trees: Parameters<typeof collectActivity>[0]) => trees.map(tree => ({ lease: negative(), transcript: negative(), fileActivity: negative(),
        live: negative(), liveReasons: [], head: tree.registration.state === 'ok' && tree.registration.value.head !== null ? ok(tree.registration.value.head) : unknown('Invalid registration') })),
      planWorktrees: async (snapshot: Parameters<typeof planWorktrees>[0], options: Parameters<typeof planWorktrees>[1]) => {
        classificationPath = options?.idleJournalOptions?.journalPath;
        const planned = await planWorktrees(snapshot, { ...options, prSnapshot: ok(f.prs) });
        if (planned.state !== 'ok') return planned;
        return ok({ ...planned.value, worktrees: planned.value.worktrees.map(tree => ({ ...tree,
          disposition: resolve(tree.path) === treePath ? 'archive' as const : 'hold' as const, reason: 'Fixture archive candidate' })) });
      },
    });
    expect(exit, String(output.mock.calls.at(-1)?.[0])).toBe(0);
    expect(prepare).toHaveBeenCalledOnce();
    expect(classificationPath).toEqual(expect.any(String));
    expect(prepare.mock.calls[0][2].journalPath).toBe(classificationPath);
    expect(prepare.mock.calls[0][2].journalPath).not.toBe(idlePath);
    expect(prepare.mock.results[0].type).toBe('return');
    expect(existsSync(classificationPath!)).toBe(false);
    expect(readFileSync(idlePath)).toEqual(before);
    expect(existsSync(treePath)).toBe(true);
  });
  it.each([
    { flags: [], message: 'installed launcher must be reinstalled from reviewed code' },
    { flags: ['--scheduled-nightly', '--manual'], message: 'mutually exclusive' },
    { flags: ['--manual', '--scheduled-nightly', '--dry-run'], message: 'mutually exclusive' },
  ])('U1 refuses invalid run origins before work: $flags', async ({ flags, message }) => {
    const f = fixture(), treePath = f.add('untouched');
    const { idlePath, before } = seedIdleJournal(f);
    const treesBefore = [bytes(f.primary), bytes(f.remote), bytes(treePath)], scan = vi.fn(inventory), runProbe = vi.fn(probe);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {}), append = vi.fn(appendIdleObservation);
    expect(await main(['run', ...flags, '--repo', f.primary, '--report-root', f.reportRoot], {
      ...quiet, inventory: scan, runProbe, appendIdleObservation: append,
    })).toBe(1);
    expect(String(error.mock.calls[0]?.[0])).toContain(message);
    expect(scan).not.toHaveBeenCalled(); expect(runProbe).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    expect(readFileSync(idlePath)).toEqual(before);
    expect([bytes(f.primary), bytes(f.remote), bytes(treePath)]).toEqual(treesBefore);
    expect(existsSync(join(f.reportRoot, 'journal.jsonl'))).toBe(false);
  });
  it.each([false, true])('accepts repeated operator releases, preserves other holds and audits outcomes (dry=%s)', async dryRun => {
    const f = fixture(), approved = f.add('approved'), kept = f.add('kept'), held = f.add('held'), unnamed = f.add('unnamed');
    git(kept, 'commit', '--allow-empty', '-m', 'unmerged'); age(kept);
    f.prs.push({ number: 1, state: 'OPEN', isDraft: true, headRefName: 'held', headRefOid: git(held, 'rev-parse', 'HEAD'), baseRefName: 'main', url: 'https://example.invalid/1', body: '' });
    const directory = join(f.options.activityOptions.homeDirectory, '.codex/sessions'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'doubt.jsonl'), [
      { type: 'session_meta', timestamp: new Date(Date.now() - 73 * 3_600_000).toISOString(), payload: { cwd: f.root } },
      { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls docs/*' }) } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const before = [bytes(f.primary), bytes(f.remote), bytes(approved), bytes(kept), bytes(held), bytes(unnamed)];
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const named = [approved, kept, held];
    const dependencies = { ...quiet, inventory, runProbe: probe,
      collectActivity: (trees: Parameters<typeof collectActivity>[0], options: Parameters<typeof collectActivity>[1]) =>
        collectActivity(trees, { ...options, homeDirectory: f.options.activityOptions.homeDirectory }),
      executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) =>
        executeRemovals(plan, snapshot, { ...options, activityOptions: { ...options.activityOptions, homeDirectory: f.options.activityOptions.homeDirectory } }),
      planWorktrees: (snapshot: Parameters<typeof planWorktrees>[0], options: Parameters<typeof planWorktrees>[1]) => planWorktrees(snapshot, { ...options, prSnapshot: ok(f.prs) }) };
    const exit = await main(['run', '--manual', '--repo', f.primary, '--report-root', f.reportRoot, '--git', gitPath, '--gh', process.execPath,
      ...(dryRun ? ['--dry-run'] : []), ...named.flatMap(path => ['--release-unresolved-doubt', path.toUpperCase()]),
      '--release-unresolved-doubt', approved], dependencies);
    expect(exit, String(output.mock.calls.at(-1)?.[0])).toBe(0);
    const row = journal(f.reportRoot).at(-1);
    expect(row).toMatchObject({ status: 'completed', operatorRelease: named.map(normalizePath), outcome: 'completed-with-holds',
      reasonCounts: { exempt: 1, 'open-pr': 1, 'unresolved-command': 1 } });
    expect(row.worktrees.find((tree: { path: string }) => resolve(tree.path) === approved)).toMatchObject({ action: 'remove', disposition: dryRun ? 'planned' : 'removed' });
    expect(row.worktrees.find((tree: { path: string }) => resolve(tree.path) === kept)).toMatchObject({ action: 'remove-keep-branch', disposition: dryRun ? 'planned' : 'removed' });
    expect(row.worktrees.find((tree: { path: string }) => resolve(tree.path) === unnamed)).toMatchObject({ disposition: 'hold', reasonCode: 'unresolved-command' });
    const text = readFileSync(row.reportPath, 'utf8');
    expect(text).toContain(`Operator release of unresolved-command doubt: 3 named; ${dryRun ? 0 : 2} removed; 1 held.`);
    for (const tree of row.worktrees) expect(tree.reason.includes('operator-release')).toBe(named.some(path => resolve(tree.path) === path));
    expect(existsSync(approved)).toBe(dryRun); expect(existsSync(kept)).toBe(dryRun);
    expect(existsSync(held)).toBe(true); expect(existsSync(unnamed)).toBe(true);
    expect(git(f.primary, 'rev-parse', 'kept')).toEqual(expect.any(String));
    if (dryRun) expect([bytes(f.primary), bytes(f.remote), bytes(approved), bytes(kept), bytes(held), bytes(unnamed)]).toEqual(before);
  });
  it.each(['missing', 'non-worktree', 'removed'])('rejects a named %s path before fetch or cleanup mutations', async kind => {
    const f = fixture(), approved = f.add('approved');
    const invalid = kind === 'non-worktree' ? f.options.activityOptions.homeDirectory : kind === 'removed' ? f.add('removed') : join(f.root, 'missing');
    if (kind === 'removed') git(f.primary, 'worktree', 'remove', invalid);
    const before = [bytes(f.primary), bytes(f.remote), bytes(approved)];
    const runProbe = vi.fn(probe), collect = vi.fn(collectActivity), append = vi.fn(appendIdleObservation), remove = vi.fn(executeRemovals);
    const report = await runCleanup({ ...f.options, operatorRelease: [approved, invalid] }, { ...quiet, runProbe, collectActivity: collect, appendIdleObservation: append, executeRemovals: remove });
    expect(report).toMatchObject({ status: 'failed', stage: 'inventory', error: `--release-unresolved-doubt path is not a registered worktree: ${normalizePath(invalid)}` });
    expect(runProbe.mock.calls.some(([, args]) => args.includes('fetch') || args.includes('prune') || args.includes('remove'))).toBe(false);
    expect(collect).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect([bytes(f.primary), bytes(f.remote), bytes(approved)]).toEqual(before);
    expect(journal(f.reportRoot).at(-1)).toMatchObject({ status: 'failed', operatorRelease: [approved, invalid].map(normalizePath) });
  });
  it.each([{ values: [] }, { values: ['relative'] }, { values: ['--dry-run'] }])('rejects incomplete or non-absolute release arguments %j', async ({ values }) => {
    const scan = vi.fn(inventory), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['run', '--manual', '--repo', resolve(tmpdir()), '--release-unresolved-doubt', ...values], { inventory: scan, collectActivity, planWorktrees, runProbe: probe })).toBe(1);
    expect(scan).not.toHaveBeenCalled();
    expect(String(error.mock.calls[0]?.[0])).toContain('--release-unresolved-doubt requires an absolute path');
  });
  it('keeps the unflagged journal bytes, dispositions and reason counts unchanged', () => {
    const f = fixture(), reason = 'unresolved-command', reportPath = join(f.reportRoot, 'reports', 'unflagged.md');
    const report = writeRunReport(f.reportRoot, { runId: 'unflagged', startedAt: 1, finishedAt: 2, status: 'completed', stage: 'complete', dryRun: false,
      worktrees: [{ path: f.primary, action: 'hold', disposition: 'hold', reason, reasonCode: reason, mutations: [], wouldBeRemovable: true }] });
    const expected = { runId: 'unflagged', startedAt: 1, finishedAt: 2, status: 'completed', stage: 'complete', dryRun: false,
      worktrees: [{ path: f.primary, action: 'hold', disposition: 'hold', reason, reasonCode: reason, mutations: [], wouldBeRemovable: true,
        firstHeldAt: 1, initialDisposition: 'hold', finalDisposition: 'hold' }],
      held: { count: 1, oldestAgeMs: 1 }, archives: { count: 0, totalBytes: 0, oldestAgeMs: 0, warnings: [] },
      counts: { hold: 1 }, reasonCounts: { 'unresolved-command': 1 }, refusedAtRemoval: 0, mutationCount: 0, wouldBeRemovable: 1,
      outcome: 'completed-with-holds', reportPath };
    expect(readFileSync(join(f.reportRoot, 'journal.jsonl'), 'utf8')).toBe(JSON.stringify(expected) + '\n');
    expect(report).not.toHaveProperty('operatorRelease');
    expect(readFileSync(reportPath, 'utf8')).not.toContain('operator-release');
    expect(readFileSync(reportPath, 'utf8')).not.toContain('Operator release of unresolved-command doubt:');
  });
  it.each([null, 'shared-target-changed'] as const)('U3 keeps CLI exits and journal status while reporting outcome (stop=%s)', async stopReason => {
    const f = fixture(), first = f.add('first'), second = f.add('second');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dependencies = {
      ...quiet, inventory, runProbe: probe,
      collectActivity: async (trees: Parameters<typeof collectActivity>[0]) => trees.map(tree => ({ lease: negative(), transcript: negative(), fileActivity: negative(),
        live: negative(), liveReasons: [], head: tree.registration.state === 'ok' && tree.registration.value.head !== null ? ok(tree.registration.value.head) : unknown('Invalid registration') })),
      planWorktrees: (snapshot: Parameters<typeof planWorktrees>[0], options: Parameters<typeof planWorktrees>[1]) =>
        planWorktrees(snapshot, { ...options, prSnapshot: ok([]) }),
      executeRemovals: async (plan: CandidatePlan) => ok({ halted: stopReason !== null, worktrees: plan.worktrees.map(tree => ({ path: tree.path,
        disposition: resolve(tree.path) === first ? 'hold' : 'removed', reason: 'Fixture removal evidence',
        stopReason: resolve(tree.path) === first ? stopReason : null,
        mutations: resolve(tree.path) === first ? [] : [{ kind: 'deregister', path: tree.path }] })) }),
    };
    const exit = await main(['run', '--manual', '--repo', f.primary, '--runner', f.primary, '--report-root', f.reportRoot, '--git', gitPath, '--gh', process.execPath], dependencies);
    expect(exit).toBe(stopReason ? 1 : 0);
    const row = journal(f.reportRoot).at(-1);
    expect(row).toMatchObject({ status: stopReason ? 'failed' : 'completed', outcome: stopReason ?? 'completed-with-holds',
      reasonCounts: stopReason ? { exempt: 1, 'shared-target-changed': 2 } : { exempt: 1, 'refused-at-removal': 1 },
      refusedAtRemoval: stopReason ? 2 : 1, mutationCount: stopReason ? 0 : 1 });
    expect(JSON.parse(String(output.mock.calls.at(-1)?.[0]))).toMatchObject({ status: row.status, outcome: row.outcome });
    expect(row.worktrees.map((tree: { path: string }) => resolve(tree.path)).sort()).toEqual([f.primary, first, second].sort());
    for (const tree of row.worktrees) {
      expect(tree.reasonCode).toEqual(expect.any(String));
      expect(tree.initialDisposition).toBe(tree.action);
      expect(tree.finalDisposition).toBe(tree.disposition);
      expect(Array.isArray(tree.mutations)).toBe(true);
    }
    expect(Object.values(row.reasonCounts).reduce((sum: number, count) => sum + Number(count), 0)).toBe(row.held.count);
    const text = readFileSync(row.reportPath, 'utf8');
    expect(text).toContain(`outcome: ${row.outcome}`);
    expect(text).toContain('Held by reason code:');
    expect(text).toContain('Initial disposition | Final disposition | Mutations | wouldBeRemovable');
  });
  it('U3 reports completed when a run has no holds', () => {
    const f = fixture();
    const report = writeRunReport(f.reportRoot, { runId: 'no-holds', startedAt: 1, finishedAt: 2, dryRun: false, status: 'completed', stage: 'complete',
      worktrees: [{ path: f.primary, action: 'remove', disposition: 'removed', reasonCode: 'removed', mutations: [] }] });
    expect(report).toMatchObject({ outcome: 'completed', reasonCounts: {}, refusedAtRemoval: 0, mutationCount: 0 });
    expect(readFileSync(report.reportPath, 'utf8')).toContain('Residual folder-wide doubt (records, reach rule): not-evaluated.');
  });
  it('U3 counts unreadable transcripts separately from unresolved commands and observes clean versus dirty liveness holds', async () => {
    const f = fixture(), clean = f.add('clean'), dirty = f.add('dirty');
    writeFileSync(join(dirty, 'notes.md'), '# Unrescued\n'); age(dirty);
    const report = await runCleanup({ ...f.options, dryRun: true }, { ...quiet, collectActivity: async (trees: Parameters<typeof collectActivity>[0]) => trees.map(tree => ({
      live: unknown('Activity evidence unknown: transcript'), head: tree.registration.state === 'ok' ? ok(tree.registration.value.head) : unknown('Invalid HEAD'),
      liveReasons: [{ code: resolve(tree.path) === dirty ? 'unresolved-command' : 'transcript-unreadable', state: 'unknown' }],
    })) });
    const row = journal(f.reportRoot).at(-1);
    expect(row).toMatchObject({ status: 'completed', outcome: 'completed-with-holds', reasonCounts: { exempt: 1, 'transcript-unreadable': 1, 'unresolved-command': 1 },
      wouldBeRemovable: 1, refusedAtRemoval: 'not-evaluated', mutationCount: 'not-evaluated' });
    expect(report.worktrees.find(tree => resolve(tree.path) === clean)).toMatchObject({ wouldBeRemovable: true, reasonCode: 'transcript-unreadable' });
    expect(report.worktrees.find(tree => resolve(tree.path) === dirty)).toMatchObject({ wouldBeRemovable: false, reasonCode: 'unresolved-command' });
  });
  it.each(['cheap', 'snapshot'])('U3 names unreadable junction target %s evidence in the report', async kind => {
    const f = fixture(), held = f.add('held');
    const report = await runCleanup({ ...f.options, dryRun: true }, { ...quiet, planWorktrees: (snapshot: InventorySnapshot, options: Parameters<typeof planWorktrees>[1]) => planWorktrees({ ...snapshot,
      worktrees: snapshot.worktrees.map(tree => resolve(tree.path) === held ? { ...tree,
        links: ok({ entries: [], forbidden: [], nodeModulesTarget: join(f.root, 'target'),
          nodeModulesTargetEvidence: kind === 'cheap' ? unknown('Lockfile unavailable') : ok({ topLevelCount: 1, lockHash: 'known' }) }),
        targetBaseline: kind === 'snapshot' ? unknown('Full target scan unavailable') : ok({ topLevelCount: 1, lockHash: 'known', count: 0 }),
      } : tree) }, options) });
    expect(report.worktrees.find(tree => resolve(tree.path) === held)).toMatchObject({ reasonCode: 'links',
      reason: kind === 'cheap' ? 'links; Lockfile unavailable' : 'links; Full target scan unavailable' });
  });
  it.skipIf(process.platform !== 'win32')('hard limit kills the node tree and journals timeout', async () => {
    await childLifetime('timeout');
  });
  it.skipIf(process.platform !== 'win32')('kill-on-close removes the node tree when launcher is killed', async () => {
    await childLifetime('kill-on-close');
  });
  it.each(['torn', 'torn-middle', 'invalid-with-newline', 'missing-newline'])('recovers a %s run journal, preserving previous rows and held age', async tail => {
    const f = fixture(), startedAt = Date.now() - 2 * 86_400_000;
    const first = writeRunReport(f.reportRoot, { runId: 'earlier', startedAt, finishedAt: startedAt, status: 'completed', stage: 'complete', dryRun: false,
      worktrees: [{ path: f.primary, action: 'hold', disposition: 'hold', reason: 'exempt' }] });
    const path = join(f.reportRoot, 'journal.jsonl'), before = readFileSync(path, 'utf8');
    const damaged = tail === 'missing-newline' ? before.trimEnd() :
      tail === 'torn-middle' ? before + '{"tornOnly":\n' + JSON.stringify({ ...first, runId: 'after-gap' }) + '\n' :
        before + '{"tornOnly":' + (tail === 'invalid-with-newline' ? '\n' : '');
    writeFileSync(path, damaged);
    const next = await runCleanup({ ...f.options, dryRun: true }, quiet);
    expect(next.status).toBe('completed');
    expect(journal(f.reportRoot)).toHaveLength(tail === 'torn-middle' ? 3 : 2);
    expect(journal(f.reportRoot)[0]).toEqual(first);
    if (tail === 'torn-middle') expect(journal(f.reportRoot)[1]).toEqual({ ...first, runId: 'after-gap' });
    expect(journal(f.reportRoot).at(-1).held.oldestAgeMs).toBeGreaterThanOrEqual(2 * 86_400_000);
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
    expect(readFileSync(path, 'utf8').startsWith(damaged)).toBe(true);
  });
  it('preserves both writers when the second repairs and appends after the first reads a torn tail', () => {
    const f = fixture(), path = join(f.reportRoot, 'journal.jsonl');
    const report = (runId: string) => ({ runId, startedAt: 1, finishedAt: 2, status: 'completed', stage: 'complete', dryRun: false, worktrees: [] });
    writeRunReport(f.reportRoot, report('earlier'));
    const damaged = readFileSync(path, 'utf8') + '{"runId":';
    writeFileSync(path, damaged);
    const realRead = vi.mocked(readFileSync).getMockImplementation()!;
    vi.mocked(readFileSync).mockImplementationOnce((...args) => {
      const snapshot = realRead(...args);
      writeRunReport(f.reportRoot, report('second-writer'));
      return snapshot;
    });
    writeRunReport(f.reportRoot, report('first-writer'));
    expect(journal(f.reportRoot).map(row => row.runId)).toEqual(['earlier', 'second-writer', 'first-writer']);
    expect(readFileSync(path, 'utf8').startsWith(damaged)).toBe(true);
  });
  it.each(['report', 'notification'])('contains a %s failure, writes a minimal failure report, and releases the run lock', async stage => {
    const f = fixture();
    if (stage === 'report') vi.mocked(writeRunReport).mockImplementationOnce(() => { throw new Error('Injected report failure'); });
    const report = await runCleanup({ ...f.options, dryRun: true }, { notifyRun: () => { if (stage === 'notification') throw new Error('Injected notification failure'); } });
    expect(report.status).toBe('failed');
    const failure = journal(f.reportRoot).at(-1);
    expect(failure.status).toBe('failed'); expect(failure.stage).toBe('report');
    expect(readFileSync(failure.reportPath, 'utf8')).toContain('Injected ' + stage + ' failure');
    const release = await acquireRunLock(f.primary, f.reportRoot); await release();
  });
  it.skipIf(process.platform !== 'win32').each(['missing-newline', 'torn'])('separates launcher failure rows from a %s journal', tail => {
    const f = fixture(), copy = installed(f), prior = { runId: 'earlier', worktrees: [] };
    const damaged = JSON.stringify(prior) + (tail === 'torn' ? '\n{"tornOnly":' : '');
    writeFileSync(join(f.reportRoot, 'journal.jsonl'), damaged);
    expect(ps(copy, ['-NodePath', join(f.root, 'missing.exe')]).status).toBe(1);
    expect(journal(f.reportRoot)).toEqual([prior, expect.objectContaining({ status: 'failed', stage: 'launcher' })]);
    expect(readFileSync(join(f.reportRoot, 'journal.jsonl'), 'utf8').startsWith(damaged)).toBe(true);
  });
  it('removes clean and kept-branch trees, rescues exact bytes, and holds an open PR in one real run', async () => {
    const f = fixture(), clean = f.add('clean'), rescue = f.add('rescue'), held = f.add('held'), kept = f.add('kept');
    writeFileSync(join(rescue, 'notes.md'), '# Preserve these bytes\n'); age(rescue);
    writeFileSync(join(kept, 'unique.txt'), 'unmerged\n'); git(kept, 'add', '.'); git(kept, 'commit', '-m', 'unmerged'); age(kept);
    const keptHead = git(kept, 'rev-parse', 'HEAD');
    f.prs.push({ number: 41, state: 'OPEN', isDraft: true, headRefName: 'held', headRefOid: git(held, 'rev-parse', 'HEAD'), baseRefName: 'main', url: 'https://example.invalid/41', body: '' });
    const report = await runCleanup(f.options, quiet);
    expect(report.status, JSON.stringify(report)).toBe('completed');
    expect([existsSync(clean), existsSync(rescue), existsSync(kept), existsSync(held)]).toEqual([false, false, false, true]);
    expect(git(f.primary, 'rev-parse', 'kept')).toBe(keptHead);
    expect(report.worktrees).toHaveLength(5);
    const rows = journal(f.reportRoot)[0];
    expect(rows.counts).toEqual({ hold: 2, remove: 1, rescue: 1, 'remove-keep-branch': 1 });
    expect(rows.prUrl).toMatch(/\/pull\/42$/);
    const publication = JSON.parse(readFileSync(join(f.reportRoot, 'rescue-journal.json'), 'utf8'));
    const rescuedFile = publication.trees[0].files[0];
    expect(git(f.remote, 'show', `${publication.commitSha}:${rescuedFile.rescuedPath}`)).toBe('# Preserve these bytes');
    const text = readFileSync(rows.reportPath, 'utf8');
    for (const tree of report.worktrees) expect(text.split(`| ${tree.path} |`)).toHaveLength(2);
    expect(text).toContain('Held: 2'); expect(text).toContain('Archives: 0'); expect(text).toContain(rows.prUrl);
  });

  it('dry run reports proposed actions without changing checkout bytes, Git metadata, remote, idle history or archives', async () => {
    const f = fixture(), clean = f.add('clean'), rescue = f.add('rescue'), held = f.add('held');
    writeFileSync(join(rescue, 'notes.md'), '# Rescue\n'); age(rescue);
    writeFileSync(join(held, 'code.ts'), 'private code\n'); age(held);
    const before = [bytes(f.primary), bytes(f.remote), bytes(clean), bytes(rescue), bytes(held)];
    const publish = vi.fn(() => { throw new Error('Dry run published'); });
    const remove = vi.fn(() => { throw new Error('Dry run removed'); });
    const archive = vi.fn(() => { throw new Error('Dry run archived'); });
    const report = await runCleanup({ ...f.options, dryRun: true }, { ...quiet, publishRescues: publish, executeRemovals: remove, createArchive: archive });
    expect(report.status, JSON.stringify(report)).toBe('completed');
    expect([bytes(f.primary), bytes(f.remote), bytes(clean), bytes(rescue), bytes(held)]).toEqual(before);
    expect(report.worktrees.every(row => Boolean(row.reason))).toBe(true);
    expect(report).toMatchObject({ refusedAtRemoval: 'not-evaluated', mutationCount: 'not-evaluated' });
    expect(report.worktrees.every(row => row.finalDisposition === 'not-evaluated' && row.mutations === 'not-evaluated')).toBe(true);
    expect(journal(f.reportRoot)[0].counts).toEqual({ hold: 2, remove: 1, rescue: 1 });
    expect(readFileSync(report.reportPath!, 'utf8')).toContain('Snapshot vetoes: secret_material: 0; secret-scan-unsupported: 0; snapshot-file-cap: 0; snapshot-size-cap: 0; snapshot-unsupported-entry: 0; snapshot-unmerged: 0; unknown: 0.');
    expect(readFileSync(report.reportPath!, 'utf8')).toContain('## Snapshot candidates\n\nNone.');
    expect(publish).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled(); expect(archive).not.toHaveBeenCalled();
    expect(existsSync(join(f.reportRoot, 'idle-journal.jsonl'))).toBe(false);
    expect(existsSync(join(f.reportRoot, 'archives'))).toBe(false);
    expect(f.runGh.mock.calls.every(([args]) => args[1] === 'list')).toBe(true);
  });

  it.each(['chain', 'cycle', 'hop-cap'])('renders the rejected junction %s and manual release in the report row', async kind => {
    const f = fixture(), held = f.add('held'), ordinary = f.add('ordinary');
    const hops = kind === 'hop-cap' ? Array.from({ length: 8 }, (_, index) => join(f.root, 'hop-' + index)) : [join(f.root, 'hop1'), join(f.root, 'hop2')];
    const detail = kind === 'cycle' ? 'Link target identity unavailable: Error: Link chain cycle' :
      kind === 'hop-cap' ? 'Link target identity unavailable: Error: Link chain exceeds 8 hops' : '';
    const manualRelease = "unlink this tree's node_modules junction";
    const evidence = ok({ forbidden: ['node_modules', 'other-link'], entries: [{ relativePath: 'node_modules', kind: 'junction', targetChain: hops,
      targetIdentity: detail ? unknown(detail) : ok(hops.at(-1)), manualRelease }] });
    const report = await runCleanup({ ...f.options, dryRun: true }, { ...quiet, planWorktrees: async () => ok({ primaryPath: f.primary,
      worktrees: [{ path: held, disposition: 'hold', reason: 'links', evidence },
        { path: ordinary, disposition: 'hold', reason: 'links', evidence: ok({ entries: [] }) },
        { path: f.primary, disposition: 'hold', reason: 'live', evidence }] }) });
    expect(report.status, JSON.stringify(report)).toBe('completed');
    const reason = 'links: ' + ['node_modules', ...hops].join(' -> ') + (detail ? '; ' + detail : '') + '; ' + manualRelease + '; Forbidden links: other-link';
    expect(report.worktrees.find(tree => tree.path === held)?.reason).toBe(reason);
    expect(report.worktrees.find(tree => tree.path === ordinary)?.reason).toBe('links');
    expect(report.worktrees.find(tree => tree.path === f.primary)?.reason).toBe('live');
    const text = readFileSync(report.reportPath!, 'utf8');
    expect(text).toContain('| ' + held + ' | hold | hold | ' + reason.replaceAll('>', '&gt;') + ' |');
    expect(text).toContain('| ' + ordinary + ' | hold | hold | links |');
    expect(text).toContain('| ' + f.primary + ' | hold | hold | live |');
  });
  it('stops at failed fetch or missing gh, writes an error report, and never inventories or mutates candidates', async () => {
    for (const failure of ['fetch', 'gh']) {
      const f = fixture(), tree = f.add('clean'), before = bytes(tree), scan = vi.fn(() => { throw new Error('Must not inventory'); });
      const runProbe: typeof probe = (executable, args, options) => args.includes('fetch') ? unknown('Fetch denied') : probe(executable, args, options);
      const report = await runCleanup({ ...f.options, ...(failure === 'gh' ? { ghPath: join(f.root, 'missing.exe') } : {}) }, { ...quiet, inventory: scan, runProbe });
      expect(report.status).toBe('failed'); expect(scan).not.toHaveBeenCalled(); expect(bytes(tree)).toEqual(before);
      expect(journal(f.reportRoot)[0].stage).toBe(failure === 'gh' ? 'executables' : 'fetch');
    }
  });

  it('bounds a queued second CLI run across report roots, and releases the OS lock after failure', async () => {
    const f = fixture(), release = await acquireRunLock(f.primary, f.reportRoot);
    let clock = Date.now(); const waitForLock = vi.fn(async (ms: number) => { clock += ms; });
    try {
      const report = await runCleanup({ ...f.options, reportRoot: join(f.root, 'second'), now: () => clock, lockWaitMs: 25 }, { ...quiet, waitForLock });
      expect(report.status).toBe('failed'); expect(report.stage).toBe('lock'); expect(f.runGh).not.toHaveBeenCalled();
      expect(waitForLock).toHaveBeenCalledOnce(); expect(queued(f)).toEqual([]);
    } finally { await release(); }
    const report = await runCleanup({ ...f.options, dryRun: true }, quiet);
    expect(report.status).toBe('completed');
  });

  it('stops all later mutations when rescue verification fails', async () => {
    const f = fixture(), clean = f.add('clean'), rescue = f.add('rescue');
    writeFileSync(join(rescue, 'notes.md'), '# Rescue\n'); age(rescue);
    const before = [bytes(clean), bytes(rescue)], remove = vi.fn(() => { throw new Error('Must not remove'); });
    const report = await runCleanup(f.options, { ...quiet, executeRemovals: remove,
      publishRescues: async () => ok({ journalState: 'pushed_unverified', prUrl: null, worktrees: [{ path: rescue, verified: unknown('readback failed') }] }) });
    expect(report.status).toBe('failed'); expect(report.stage).toBe('rescue'); expect(remove).not.toHaveBeenCalled();
    expect([bytes(clean), bytes(rescue)]).toEqual(before);
  });

  it('previews day fifteen without persisting it, then archives and restores leftovers after clean removal', async () => {
    const f = fixture(), archived = f.add('archive'), clean = f.add('clean'), now = Date.now();
    writeFileSync(join(archived, 'private.txt'), 'local bytes\n'); age(archived);
    for (let day = 15; day >= 1; day--) {
      expect(appendIdleObservation(archived, { head: ok(git(archived, 'rev-parse', 'HEAD')), live: negative() },
        { journalPath: join(f.reportRoot, 'idle-journal.jsonl'), now: () => now - day * 86_400_000 }).state).toBe('ok');
    }
    const history = readFileSync(join(f.reportRoot, 'idle-journal.jsonl'));
    const dry = await runCleanup({ ...f.options, now: () => now, dryRun: true }, quiet);
    expect(dry.status, JSON.stringify(dry)).toBe('completed');
    expect(dry.worktrees.find(row => resolve(row.path) === archived)?.action).toBe('archive');
    expect(readFileSync(join(f.reportRoot, 'idle-journal.jsonl'))).toEqual(history);
    expect(existsSync(join(f.reportRoot, 'archives'))).toBe(false);
    const report = await runCleanup({ ...f.options, now: () => now }, quiet);
    expect(report.status, JSON.stringify(report)).toBe('completed');
    expect(existsSync(clean)).toBe(false); expect(existsSync(archived)).toBe(false);
    const row = report.worktrees.find(row => resolve(row.path) === archived);
    expect(row?.disposition).toBe('removed'); expect(row?.restoreCommand).toContain(' restore ');
    expect(restoreArchive(row!.archivePath!).state).toBe('ok');
    expect(readFileSync(join(archived, 'private.txt'), 'utf8')).toBe('local bytes\n');
  });

  it.each([
    ['removed', 'removed', null, [{ kind: 'deregister' }], true],
    ['removed-prune-deferred', 'removed-prune-deferred', null, [{ kind: 'deregister' }], true],
    ['pre-mutation tree-local hold', 'hold', null, [], true],
    ['child-held', 'hold', null, [], true],
    ['mutated-then-held', 'hold', null, [{ kind: 'unlink-rescued', file: 'notes.md' }], false],
    ['shared target changed', 'hold', 'shared-target-changed', [], false],
    ['half-removed this run', 'hold', 'half-removed', [], false],
    ['prune preview with an unknown entry', 'hold', 'prune-unknown', [], false],
    ['deadline', 'pending', 'deadline', [], false],
    ['rescue verification failure', 'hold', 'rescue-verification-failed', [], false],
  ] as const)('U2 decision table: %s', async (name, disposition, stopReason, mutations, continues) => {
    const f = fixture(), first = f.add('first'), second = f.add('second');
    const remove = vi.fn(async (plan: { worktrees: { path: string }[] }) => ok({ halted: false,
      worktrees: plan.worktrees.map(tree => ({ path: tree.path, disposition: remove.mock.calls.length === 1 ? disposition : 'removed',
        reason: name, stopReason: remove.mock.calls.length === 1 ? stopReason : null, mutations: remove.mock.calls.length === 1 ? mutations : [] })) }));
    const prune = vi.fn(() => ok({ pruned: [], warnings: [], totalBytes: 0 }));
    const report = await runCleanup(f.options, { ...quiet, executeRemovals: remove, pruneArchives: prune,
      planWorktrees: async () => ok({ primaryPath: f.primary, worktrees: [first, second].map(path => ({ path,
        disposition: stopReason === 'rescue-verification-failed' && path === first ? 'rescue' : 'remove' })) }),
      publishRescues: async () => ok({ journalState: 'pushed_unverified', prUrl: null,
        worktrees: [{ path: first, verified: unknown('readback failed') }] }),
    });
    expect(report.status).toBe(continues ? 'completed' : 'failed');
    expect(report.outcome).toBe(continues ? 'completed-with-holds' : stopReason ?? 'mutated-then-held');
    expect(journal(f.reportRoot).at(-1).outcome).toBe(report.outcome);
    expect(new Set(report.worktrees.map(row => resolve(row.path))).size).toBe(3);
    expect(report.worktrees.every(row => typeof row.reasonCode === 'string')).toBe(true);
    expect(remove).toHaveBeenCalledTimes(stopReason === 'rescue-verification-failed' ? 0 : continues ? 2 : 1);
    if (continues) expect(prune).toHaveBeenCalledOnce();
    else {
      expect(prune).not.toHaveBeenCalled();
      expect(report.worktrees.find(row => row.path === second)?.disposition).toBe('pending');
      if (mutations.length) expect(report.worktrees[0]).toMatchObject({ stopReason: 'mutated-then-held', mutations });
    }
  });

  it('continues after an intact Git refusal and counts only the next successful removal', async () => {
    const f = fixture(), first = f.add('first'), second = f.add('second'), before = bytes(first), calls: string[][] = [];
    const runProbe: typeof probe = (exe, args, options) => {
      calls.push(args);
      if (args.includes('remove') && args.includes(first.replaceAll('\\', '/'))) return { ...unknown('Probe failed (exit 128, signal null)',
        'fatal: candidate contains modified or untracked files, use --force to delete it'), exitCode: 128 };
      return probe(exe, args, options);
    };
    const report = await runCleanup(f.options, { ...quiet, runProbe });
    expect(report).toMatchObject({ status: 'completed', outcome: 'completed-with-holds', mutationCount: 1,
      reasonCounts: { exempt: 1, 'git-refused-intact': 1 } });
    expect(report.worktrees.find(row => resolve(row.path) === first)).toMatchObject({ disposition: 'hold', reasonCode: 'git-refused-intact',
      reason: expect.stringContaining('contains modified or untracked files'), stopReason: null, mutations: [] });
    expect(report.worktrees.find(row => resolve(row.path) === second)).toMatchObject({ disposition: 'removed',
      mutations: [{ kind: 'remove-started' }, { kind: 'deregister' }] });
    expect(bytes(first)).toEqual(before); expect(existsSync(second)).toBe(false);
    expect(calls.flat()).not.toContain('--force');
    expect(calls.filter(args => args.includes('remove') && args.includes(first.replaceAll('\\', '/')))).toHaveLength(1);
    expect(journal(f.reportRoot).at(-1).mutationCount).toBe(1);
  });
  it('counts one successful removal while retaining its attempt marker in the report', async () => {
    const f = fixture(), candidate = f.add('candidate');
    const report = await runCleanup(f.options, quiet);
    expect(report).toMatchObject({ status: 'completed', mutationCount: 1 });
    expect(report.worktrees.find(row => resolve(row.path) === candidate)).toMatchObject({ disposition: 'removed',
      mutations: [{ kind: 'remove-started' }, { kind: 'deregister' }] });
    expect(journal(f.reportRoot).at(-1).mutationCount).toBe(1);
  });
  it('counts unproven attempts unless followed by deregistration in their own row', () => {
    const f = fixture(), now = Date.now();
    const report = writeRunReport(f.reportRoot, { runId: 'attempt-counts', startedAt: now, finishedAt: now,
      status: 'failed', stage: 'remove', stopReason: 'mutated-then-held', worktrees: [
        { path: join(f.root, 'unproven'), action: 'remove', disposition: 'hold', mutations: [{ kind: 'remove-started', path: 'unproven' }] },
        { path: join(f.root, 'removed'), action: 'remove', disposition: 'removed',
          mutations: [{ kind: 'remove-started', path: 'removed' }, { kind: 'deregister', path: 'removed' }] },
        { path: join(f.root, 'later-attempt'), action: 'remove', disposition: 'hold',
          mutations: [{ kind: 'deregister', path: 'later-attempt' }, { kind: 'remove-started', path: 'later-attempt' }] },
      ] });
    expect(report.mutationCount).toBe(4);
    expect(journal(f.reportRoot).at(-1).mutationCount).toBe(4);
  });
  it.each(['file-deleted', 'admin-deleted', 'proof-error'])('stops the run after a failed removal with %s', async change => {
    const f = fixture(), first = f.add('first'), second = f.add('second'), before = bytes(first);
    let failed = false;
    const runProbe: typeof probe = (exe, args, options) => {
      if (args.includes('remove')) {
        failed = true;
        if (change === 'file-deleted') rmSync(join(first, 'tracked.md'));
        if (change === 'admin-deleted') {
          const adminPath = join(f.primary, '.git', 'worktrees', 'first');
          expect(isWithin(adminPath, f.root)).toBe(true);
          rmSync(adminPath, { recursive: true });
        }
        return { ...unknown('Probe failed (exit 128, signal null)', 'fatal: candidate contains modified or untracked files, use --force to delete it'), exitCode: 128 };
      }
      if (failed && change === 'proof-error' && args.includes('status')) throw new Error('Intact proof failed');
      return probe(exe, args, options);
    };
    const report = await runCleanup(f.options, { ...quiet, runProbe });
    expect(report).toMatchObject({ status: 'failed', stopReason: 'mutated-then-held', outcome: 'mutated-then-held', mutationCount: 1 });
    expect(journal(f.reportRoot).at(-1).mutationCount).toBe(1);
    expect(report.worktrees.find(row => resolve(row.path) === first)).toMatchObject({ disposition: 'hold',
      mutations: [{ kind: 'remove-started', path: expect.any(String) }] });
    expect(report.worktrees.find(row => resolve(row.path) === second)?.disposition).toBe('pending');
    expect(existsSync(join(second, 'tracked.md'))).toBe(true);
    expect(existsSync(join(first, '.git'))).toBe(true);
    if (change === 'file-deleted') expect(existsSync(join(first, 'tracked.md'))).toBe(false);
    else expect(bytes(first)).toEqual(before);
  });
  it('U2-T8 records a vanished registration observed inside archive creation', async () => {
    const f = fixture(), archived = f.add('archived'), second = f.add('second');
    const prepare = vi.fn(() => { throw new Error('Must not clean archive'); });
    const remove = vi.fn(() => { throw new Error('Must not remove'); });
    const report = await runCleanup(f.options, { ...quiet,
      planWorktrees: async () => ok({ primaryPath: f.primary, worktrees: [
        { path: archived, disposition: 'archive' }, { path: second, disposition: 'remove' },
      ] }),
      createArchive: (path: string, options: Parameters<typeof createArchive>[1]) => {
        const adminPath = join(f.primary, '.git', 'worktrees', 'second');
        expect(isWithin(adminPath, f.root)).toBe(true);
        rmSync(adminPath, { recursive: true });
        return createArchive(path, options);
      },
      prepareArchivedTree: prepare, executeRemovals: remove,
    });
    expect(report).toMatchObject({ status: 'completed' }); expect(report.stopReason).toBeFalsy();
    expect(report.worktrees.find(row => row.path === archived)).toMatchObject({ disposition: 'hold', stopReason: null, mutations: [] });
    expect(report.worktrees.find(row => row.path === second)).toMatchObject({ disposition: 'hold', reasonCode: 'registration-vanished', mutations: [] });
    expect(prepare).toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(existsSync(join(archived, 'tracked.md'))).toBe(true);
    expect(existsSync(join(second, 'tracked.md'))).toBe(true);
  });
  it.each(['coordinator-recheck', 'create-archive'])('U2-fix holds the archive candidate itself vanishing at %s and continues', async stage => {
    const f = fixture(), archived = f.add('a-archived'), second = f.add('b-second');
    const prepare = vi.fn(() => { throw new Error('Must not clean archive'); });
    const archive = vi.fn((path: string, options: Parameters<typeof createArchive>[1]) => {
      git(f.primary, 'worktree', 'remove', archived);
      return createArchive(path, options);
    });
    const retention = vi.fn(() => ok({ pruned: [], warnings: [] }));
    const remove = vi.fn((plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => executeRemovals(plan, snapshot, options));
    const report = await runCleanup(f.options, { ...quiet,
      planWorktrees: async (snapshot: InventorySnapshot, options: Parameters<typeof planWorktrees>[1]) => {
        const planned = await planWorktrees(snapshot, options);
        if (planned.state !== 'ok') throw new Error('Classification failed');
        planned.value.worktrees.find(tree => resolve(tree.path) === archived)!.disposition = 'archive';
        if (stage === 'coordinator-recheck') git(f.primary, 'worktree', 'remove', archived);
        return planned;
      },
      createArchive: archive, prepareArchivedTree: prepare, executeRemovals: remove, pruneArchives: retention,
    });
    expect(report).toMatchObject({ status: 'completed' }); expect(report.stopReason).toBeFalsy();
    const row = report.worktrees.find(row => resolve(row.path) === archived);
    expect(row).toMatchObject({ disposition: 'hold', reasonCode: 'registration-vanished', stopReason: null, mutations: [], wouldBeRemovable: false });
    expect(row?.archivePath).toBeUndefined(); expect(prepare).not.toHaveBeenCalled();
    expect(archive).toHaveBeenCalledTimes(stage === 'create-archive' ? 1 : 0);
    expect(retention).toHaveBeenCalledWith(expect.objectContaining({ currentArchives: [] }));
    expect(remove).toHaveBeenCalledOnce();
    expect(report.worktrees.find(row => resolve(row.path) === second)).toMatchObject({ disposition: 'removed', wouldBeRemovable: true });
    expect(existsSync(second)).toBe(false);
  });
  it.each(['half-removed', 'mutated-then-held'])('U2-fix reports the vanished cause alongside the %s stop', async stopReason => {
    const f = fixture(), first = f.add('a-first'), second = f.add('b-second');
    const remove = vi.fn(async (plan: CandidatePlan) => ok({ halted: true, worktrees: [{ path: plan.worktrees[0].path,
      disposition: 'hold', reason: 'Classification registration vanished', reasonCode: 'registration-vanished',
      stopReason: stopReason === 'half-removed' ? stopReason : null, mutations: [{ kind: 'restore', path: first, file: 'tracked.md' }] }] }));
    const report = await runCleanup(f.options, { ...quiet, executeRemovals: remove });
    expect(report).toMatchObject({ status: 'failed', stopReason });
    expect(report.worktrees.find(row => resolve(row.path) === first)).toMatchObject({ disposition: 'hold', stopReason,
      reason: 'Classification registration vanished', reasonCode: 'registration-vanished', wouldBeRemovable: false });
    expect(report.worktrees.find(row => resolve(row.path) === second)?.disposition).toBe('pending');
    expect(remove).toHaveBeenCalledOnce();
  });
  it('U2-fix keeps an earlier head-changed hold when that tree later vanishes', async () => {
    const f = fixture(), first = f.add('a-first'), second = f.add('b-second'), third = f.add('c-third');
    let calls = 0;
    const report = await runCleanup(f.options, { ...quiet, executeRemovals: (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => {
      if (++calls === 1) return ok({ halted: false, worktrees: [{ path: first, disposition: 'hold', reason: 'HEAD changed at removal',
        reasonCode: 'head-changed', stopReason: null, mutations: [] }] });
      if (calls === 2) git(f.primary, 'worktree', 'remove', first);
      return executeRemovals(plan, snapshot, options);
    } });
    expect(report).toMatchObject({ status: 'completed' }); expect(calls).toBe(3);
    expect(report.worktrees.find(row => resolve(row.path) === first)).toMatchObject({ disposition: 'hold',
      reason: 'HEAD changed at removal', reasonCode: 'head-changed', stopReason: null, mutations: [], wouldBeRemovable: false });
    for (const path of [second, third]) expect(report.worktrees.find(row => resolve(row.path) === path)?.disposition).toBe('removed');
  });
  it('stops with deadline when ancestry exhausts classification time and policy holds every tree', async () => {
    const f = fixture(), candidate = f.add('candidate'), start = Date.now(), softTimeoutMs = 10 * 60_000;
    let clock = start, ancestryCalls = 0;
    const remove = vi.fn(() => { throw new Error('Must not remove'); });
    const report = await runCleanup({ ...f.options, now: () => clock, softTimeoutMs }, { ...quiet,
      planWorktrees: (snapshot: InventorySnapshot, options: Parameters<typeof planWorktrees>[1]) => planWorktrees(snapshot, {
        ...options, prSnapshot: ok([]), ancestorOfMain: () => {
          ancestryCalls++;
          clock = start + softTimeoutMs - 2 * 60_000;
          throw new Error('Soft deadline reached during ancestry');
        },
      }), executeRemovals: remove,
    });
    expect(ancestryCalls).toBe(1);
    expect(report).toMatchObject({ status: 'failed', stage: 'classify', stopReason: 'deadline', outcome: 'deadline' });
    expect(report.worktrees.every(row => row.initialDisposition === 'hold' && row.reasonCode !== 'not-classified')).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(existsSync(join(candidate, 'tracked.md'))).toBe(true);
  });
  it('preserves classified holds and planned actions when classification finishes past the tree deadline', async () => {
    const f = fixture(), candidate = f.add('candidate'), start = Date.now(), softTimeoutMs = 10 * 60_000;
    let clock = start;
    const remove = vi.fn(() => { throw new Error('Must not remove'); });
    const report = await runCleanup({ ...f.options, now: () => clock, softTimeoutMs }, { ...quiet,
      planWorktrees: async () => {
        clock = start + softTimeoutMs - 2 * 60_000 + 1;
        return ok({ primaryPath: f.primary, worktrees: [
          { path: f.primary, disposition: 'hold', reason: 'exempt', reasonCode: 'exempt' },
          { path: candidate, disposition: 'remove', reasonCode: 'remove' },
        ] });
      }, executeRemovals: remove,
    });
    expect(report).toMatchObject({ status: 'failed', stage: 'classify', stopReason: 'deadline' });
    expect(report.worktrees.find(row => resolve(row.path) === f.primary)).toMatchObject({ action: 'hold', disposition: 'hold',
      initialDisposition: 'hold', reasonCode: 'exempt', reason: 'exempt' });
    expect(report.worktrees.find(row => resolve(row.path) === candidate)).toMatchObject({ action: 'remove', disposition: 'pending',
      initialDisposition: 'remove', reasonCode: 'deadline' });
    expect(remove).not.toHaveBeenCalled(); expect(existsSync(join(candidate, 'tracked.md'))).toBe(true);
  });
  it('U2 removes a later real candidate after the first tree-local hold', async () => {
    const f = fixture(), first = f.add('first'), second = f.add('second');
    let calls = 0;
    const report = await runCleanup(f.options, { ...quiet, executeRemovals: async (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => {
      if (++calls === 1) return ok({ halted: false, worktrees: [{ path: plan.worktrees[0].path, disposition: 'hold', reason: 'Tree changed', stopReason: null, mutations: [] }] });
      return executeRemovals(plan, snapshot, options);
    } });
    expect(report.status, JSON.stringify(report)).toBe('completed'); expect(calls).toBe(2);
    expect(existsSync(first)).toBe(true); expect(existsSync(second)).toBe(false);
  });
  it.each(['held', 'candidate', 'recheck-hold'])('U2-T1/T2/T4 run membership survives churn of a %s tree', async kind => {
    const f = fixture(), first = f.add('a-first'), second = f.add('b-second'), third = f.add('c-third'), vanished = f.add('z-vanished');
    if (kind !== 'candidate') utimesSync(join(vanished, 'tracked.md'), new Date(), new Date());
    let added = '', changed = false, carriedLinks: unknown;
    const report = await runCleanup(f.options, { ...quiet,
      executeRemovals: async (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => {
        if (changed) carriedLinks = (snapshot.worktrees as { path: string, links?: unknown }[]).find(tree => resolve(tree.path) === vanished)?.links;
        if (kind === 'recheck-hold' && !changed) {
          changed = true; added = f.add('arrived'); git(f.primary, 'worktree', 'remove', vanished);
          writeFileSync(join(first, 'tracked.md'), 'concurrent edit\n');
        }
        return executeRemovals(plan, snapshot, { ...options, onAfterMutation: event => {
          if (event.kind === 'remove' && !changed) {
            changed = true; added = f.add('arrived'); git(f.primary, 'worktree', 'remove', vanished);
          }
        } });
      },
    });
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed' }); expect(report.stopReason).toBeFalsy();
    for (const path of kind === 'recheck-hold' ? [second, third] : [first, second, third]) {
      expect(['removed', 'removed-prune-deferred']).toContain(report.worktrees.find(row => resolve(row.path) === path)?.disposition);
      expect(report.worktrees.find(row => resolve(row.path) === path)?.wouldBeRemovable).toBe(true);
      expect(existsSync(path)).toBe(false);
    }
    const vanishedRow = report.worktrees.find(row => resolve(row.path) === vanished);
    expect(vanishedRow).toMatchObject({ disposition: 'hold', stopReason: null, mutations: [] });
    if (kind !== 'candidate') expect(vanishedRow?.reasonCode).not.toBe('registration-vanished');
    else expect(vanishedRow?.reasonCode).toBe('registration-vanished');
    expect(carriedLinks).toMatchObject({ state: 'ok' });
    expect(existsSync(added)).toBe(true);
    expect(git(f.primary, 'worktree', 'list', '--porcelain')).toContain(added.replaceAll('\\', '/'));
    expect(report.worktrees.some(row => resolve(row.path) === added)).toBe(false);
    expect(report.worktrees.flatMap(row => Array.isArray(row.mutations) ? row.mutations : []).some(event => resolve(event.path) === added)).toBe(false);
    const deferred = report.worktrees.filter(row => row.disposition === 'removed-prune-deferred').length;
    expect(readFileSync(report.reportPath!, 'utf8')).toContain(`Registration churn: registration-vanished holds: ${kind === 'candidate' ? 1 : 0}; removed-prune-deferred: ${deferred}.`);
  });
  async function vanishedRegistrationRecheck(directoryPresent: boolean, linkType: 'junction' | 'dir') {
    const f = fixture(), first = f.add('a-first'), observer = f.add('b-observer'), target = f.add('c-target'), vanished = f.add('z-vanished');
    utimesSync(join(vanished, 'tracked.md'), new Date(), new Date());
    const before = bytes(target), mutations: string[] = [];
    let deregistered = false, observerRemoved = false;
    const report = await runCleanup(f.options, { ...quiet,
      executeRemovals: (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) =>
        executeRemovals(plan, snapshot, { ...options,
          onBeforeMutation: event => {
            if (resolve(event.path) === target) mutations.push(event.kind);
            return options.onBeforeMutation?.(event);
          },
          onAfterMutation: event => {
            if (event.kind !== 'remove') return;
            if (resolve(event.path) === first) {
              const admin = join(f.primary, '.git', 'worktrees', 'z-vanished');
              expect(isWithin(admin, f.root)).toBe(true); rmSync(admin, { recursive: true });
              if (!directoryPresent) { expect(isWithin(vanished, f.root)).toBe(true); rmSync(vanished, { recursive: true }); }
              deregistered = true;
            } else if (resolve(event.path) === observer) {
              expect(deregistered).toBe(true); expect(existsSync(vanished)).toBe(directoryPresent);
              observerRemoved = true;
              if (directoryPresent) symlinkSync(target, join(vanished, 'cache'), linkType);
            }
          },
        }),
    });
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed' }); expect(report.stopReason).toBeFalsy();
    expect(deregistered).toBe(true); expect(observerRemoved).toBe(true);
    for (const path of [first, observer]) {
      expect(['removed', 'removed-prune-deferred']).toContain(report.worktrees.find(row => resolve(row.path) === path)?.disposition);
      expect(existsSync(path)).toBe(false);
    }
    const targetRow = report.worktrees.find(row => resolve(row.path) === target);
    if (directoryPresent) {
      expect(targetRow).toMatchObject({ disposition: 'hold', reason: 'Inbound link or unknown target', stopReason: null, mutations: [] });
      expect(mutations).toEqual([]); expect(bytes(target)).toEqual(before);
      expect(git(f.primary, 'worktree', 'list', '--porcelain')).toContain(target.replaceAll('\\', '/'));
    } else {
      expect(['removed', 'removed-prune-deferred']).toContain(targetRow?.disposition);
      expect(existsSync(target)).toBe(false);
    }
  }
  it.skipIf(process.platform !== 'win32').each([true, false])('U2b rechecks a vanished registration after membership observation (directoryPresent=%s)', directoryPresent =>
    vanishedRegistrationRecheck(directoryPresent, 'junction'));
  it.skipIf(process.platform === 'win32').each([true, false])('U2b rechecks a vanished registration after membership observation using a directory symlink (directoryPresent=%s)', directoryPresent =>
    vanishedRegistrationRecheck(directoryPresent, 'dir'));
  it.each(['dirty', 'staged', 'unpushed', 'head', 'lease'])('U2-T5 churn does not bless a later candidate with %s changes', async change => {
    const f = fixture(), first = f.add('a-first'), later = f.add('b-later'), vanished = f.add('z-held');
    utimesSync(join(vanished, 'tracked.md'), new Date(), new Date());
    let before: Record<string, string> = {}, changed = false;
    const report = await runCleanup(f.options, { ...quiet,
      executeRemovals: (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) =>
        executeRemovals(plan, snapshot, { ...options, onAfterMutation: event => {
          if (event.kind !== 'remove' || changed) return;
          changed = true; f.add('arrived'); git(f.primary, 'worktree', 'remove', vanished);
          if (['dirty', 'staged', 'unpushed'].includes(change)) writeFileSync(join(later, 'tracked.md'), 'concurrent edit\n');
          if (['staged', 'unpushed'].includes(change)) git(later, 'add', 'tracked.md');
          if (change === 'unpushed') git(later, 'commit', '-m', 'unpushed');
          if (change === 'head') git(later, 'commit', '--allow-empty', '-m', 'advanced HEAD');
          if (change === 'lease') {
            const job = join(f.options.activityOptions.homeDirectory, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
            writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'job', cwd: later, pid: process.pid, started_at: new Date().toISOString() }));
          }
          before = bytes(later);
        } }),
    });
    expect(report).toMatchObject({ status: 'completed' }); expect(report.stopReason).toBeFalsy();
    expect(existsSync(first)).toBe(false);
    expect(report.worktrees.find(row => resolve(row.path) === later)).toMatchObject({ disposition: 'hold', stopReason: null, mutations: [] });
    expect(bytes(later)).toEqual(before);
    expect(git(f.primary, 'worktree', 'list', '--porcelain')).toContain(later.replaceAll('\\', '/'));
  });
  it.each(['directory-gone', 'git-gone'])('U2 coordinator defers final prune for known stale %s', async kind => {
    const f = fixture(), stale = f.add('stale'), clean = f.add('clean');
    if (kind === 'git-gone') rmSync(join(stale, '.git'));
    else { expect(resolve(stale).startsWith(resolve(f.root) + sep)).toBe(true); rmSync(stale, { recursive: true }); }
    const calls: string[][] = [];
    const report = await runCleanup(f.options, { ...quiet, runProbe: ((exe, args, options) => { calls.push(args); return probe(exe, args, options); }) satisfies typeof probe });
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed', pruneDeferred: true });
    expect(report.worktrees.find(row => resolve(row.path) === clean)?.disposition).toBe('removed-prune-deferred');
    expect(report.worktrees.find(row => resolve(row.path) === stale)).toMatchObject({ disposition: 'hold', reason: 'Known-stale registration; prune deferred' });
    expect(report.staleRegistrationSkips?.length).toBeGreaterThan(0);
    expect(calls.some(args => args.slice(-2).join(' ') === 'worktree prune')).toBe(false);
  });
  it.each([false, true])('U2 archive child precedes parent and child-held skips parent before recheck (held=%s)', async held => {
    const f = fixture(), parent = f.add('parent'), child = join(parent, 'coverage', 'child');
    git(f.primary, 'worktree', 'add', '-b', 'nested-child', child); age(child);
    const order: string[] = [];
    const report = await runCleanup(f.options, { ...quiet,
      planWorktrees: async () => ok({ primaryPath: f.primary, worktrees: [{ path: parent, disposition: 'remove' }, { path: child, disposition: 'archive' }] }),
      createArchive: async () => { order.push('archive-child'); return ok({ archivePath: 'fixture-archive', restoreCommand: 'fixture restore' }); },
      prepareArchivedTree: async () => ok({ disposition: held ? 'hold' : 'clean', reason: 'child refused', mutations: [], stopReason: null,
        plan: { primaryPath: f.primary, worktrees: [{ path: child, disposition: 'remove' }] }, snapshot: {} }),
      executeRemovals: async (plan: CandidatePlan) => { order.push(plan.worktrees[0].path); return ok({ halted: false, worktrees: [{ path: plan.worktrees[0].path, disposition: 'removed', mutations: [], stopReason: null }] }); },
    });
    expect(report.status, JSON.stringify(report)).toBe('completed');
    expect(order).toEqual(held ? ['archive-child'] : ['archive-child', child, parent]);
    if (held) expect(report.worktrees[0]).toMatchObject({ disposition: 'hold', reason: `child-held: ${child}` });
  });
  it('U2 archive cleanup mutations survive a later removal refusal', async () => {
    const f = fixture(), path = f.add('archive'), mutations = [{ kind: 'archive-unlink', path, file: 'leftover.txt' }];
    const report = await runCleanup(f.options, { ...quiet,
      planWorktrees: async () => ok({ primaryPath: f.primary, worktrees: [{ path, disposition: 'archive' }] }),
      createArchive: async () => ok({ archivePath: 'fixture-archive', restoreCommand: 'fixture restore' }),
      prepareArchivedTree: async () => ok({ disposition: 'clean', mutations, stopReason: null,
        plan: { primaryPath: f.primary, worktrees: [{ path, disposition: 'remove' }] }, snapshot: {} }),
      executeRemovals: async (_plan: CandidatePlan, _snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => ok({ halted: false, worktrees: [{ path, disposition: 'hold', reason: 'refused', mutations: options.mutations, stopReason: null }] }),
    });
    expect(report.status).toBe('failed'); expect(report.worktrees[0]).toMatchObject({ stopReason: 'mutated-then-held', mutations });
  });
  it('U3-T2 final preview preserves an unknown registration created after all removals', async () => {
    const f = fixture(), candidate = f.add('candidate');
    let arrived = '', removalsDone = false, finalPrunes = 0;
    const perTreePreviews: string[] = [], finalPreviews: string[] = [];
    const report = await runCleanup(f.options, { ...quiet,
      executeRemovals: async (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => {
        const result = await executeRemovals(plan, snapshot, options);
        expect(result).toMatchObject({ state: 'ok', value: { halted: false, worktrees: [{ disposition: 'removed',
          registrationDelta: { added: [], vanished: [], changed: [] } }] } });
        expect(existsSync(candidate)).toBe(false);
        arrived = f.add('arrived');
        expect(resolve(arrived).startsWith(resolve(f.root) + sep)).toBe(true);
        rmSync(arrived, { recursive: true });
        removalsDone = true;
        return result;
      },
      runProbe: ((exe, args, options) => {
        if (removalsDone && args.slice(-2).join(' ') === 'worktree prune') finalPrunes++;
        const output = probe(exe, args, options);
        if (args.includes('--dry-run')) (removalsDone ? finalPreviews : perTreePreviews).push((output.state === 'ok' ? output.value : '') + (output.stderr ?? ''));
        return output;
      }) satisfies typeof probe,
    });
    expect(perTreePreviews).toEqual(['', '']);
    expect(finalPreviews.join('\n')).toContain('Removing worktrees/arrived:');
    expect(git(f.primary, 'worktree', 'list', '--porcelain')).toContain(arrived.replaceAll('\\', '/'));
    expect(finalPrunes).toBe(0);
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed', pruneDeferred: true });
    expect(report.stopReason).toBeFalsy();
    expect(report.unknownPruneEntries).toEqual(finalPreviews[0].trim().split(/\r?\n/));
    expect(readFileSync(report.reportPath!, 'utf8')).toContain('Removing worktrees/arrived:');
    expect(readFileSync(report.reportPath!, 'utf8')).toContain('Prune deferred: yes.');
  });
  it.each(['known-stale-preview', 'empty-with-stale-key', 'empty'])('U3-T4 final %s preview decides prune after per-tree deferral', async kind => {
    const f = fixture(), candidate = f.add('candidate');
    if (kind !== 'empty') {
      const stale = f.add('stale');
      expect(resolve(stale).startsWith(resolve(f.root) + sep)).toBe(true);
      rmSync(stale, { recursive: true });
    }
    let removalsDone = false, prunes = 0;
    const unknownEntry = 'Removing worktrees/unknown: gitdir file points to non-existent location';
    const finalPreviews: string[] = [];
    const report = await runCleanup(f.options, { ...quiet,
      executeRemovals: async (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => {
        const result = await executeRemovals(plan, snapshot, options);
        expect(result).toMatchObject({ state: 'ok', value: { halted: false, worktrees: [{ disposition: 'removed-prune-deferred',
          stopReason: null, unknownPruneEntries: [unknownEntry] }] } });
        removalsDone = true;
        return result;
      },
      runProbe: ((exe, args, options) => {
        if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
        const output = probe(exe, args, options);
        if (!args.includes('--dry-run')) return output;
        if (!removalsDone) return { ...output, stderr: (output.stderr ?? '') + unknownEntry + '\n' };
        const final = kind === 'empty-with-stale-key' ? { ...output, value: '', stderr: '' } : output;
        finalPreviews.push((final.state === 'ok' ? final.value : '') + (final.stderr ?? ''));
        return final;
      }) as typeof probe,
    });
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'completed', pruneDeferred: true, unknownPruneEntries: [unknownEntry] });
    expect(report.worktrees.find(row => resolve(row.path) === candidate)).toMatchObject({ disposition: 'removed-prune-deferred', unknownPruneEntries: [unknownEntry] });
    expect(prunes).toBe(kind === 'empty' ? 1 : 0);
    if (kind === 'known-stale-preview') expect(finalPreviews.join('\n')).toContain('Removing worktrees/stale:');
    else expect(finalPreviews).toEqual(kind === 'empty' ? ['', ''] : ['']);
  });
  it('U3-T3 final prune rereads stderr immediately before live prune', async () => {
    const f = fixture(); let previews = 0, prunes = 0;
    const report = await runCleanup(f.options, { ...quiet, runProbe: ((exe, args, options) => {
      if (args.includes('--dry-run') && ++previews === 2) return { ...probe(exe, args, options), stderr: 'Removing worktrees/unknown: gitdir file points to non-existent location\n' };
      if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
      return probe(exe, args, options);
    }) satisfies typeof probe });
    expect(report).toMatchObject({ status: 'completed', pruneDeferred: true,
      unknownPruneEntries: ['Removing worktrees/unknown: gitdir file points to non-existent location'] });
    expect(report.stopReason).toBeFalsy();
    expect(previews).toBe(2); expect(prunes).toBe(0);
  });

  it('U3-T5 deadline after a removal runs only a read-only final prune preview', async () => {
    const f = fixture(), candidates = [f.add('first'), f.add('second')];
    let clock = 0, removals = 0, prunes = 0;
    const finalPreviews: string[][] = [];
    const report = await runCleanup({ ...f.options, now: () => clock, softTimeoutMs: 10 * 60_000 }, { ...quiet,
      executeRemovals: async (plan: CandidatePlan, snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => {
        const result = await executeRemovals(plan, snapshot, options);
        expect(result).toMatchObject({ state: 'ok', value: { halted: false, worktrees: [{ disposition: 'removed', stopReason: null }] } });
        expect(existsSync(plan.worktrees[0].path)).toBe(false);
        removals++;
        // Exhaust the per-tree budget while leaving the reserved preview tail.
        clock = options.softDeadline!;
        return result;
      },
      runProbe: ((exe, args, options) => {
        if (args.includes('worktree') && args.includes('prune')) {
          if (!args.includes('--dry-run')) prunes++;
          else if (removals) finalPreviews.push(args);
        }
        return probe(exe, args, options);
      }) satisfies typeof probe,
    });
    expect(prunes).toBe(0);
    expect(removals).toBe(1);
    expect(finalPreviews).toHaveLength(1);
    expect(finalPreviews[0].slice(-4)).toEqual(['worktree', 'prune', '--dry-run', '--verbose']);
    expect(report, JSON.stringify(report)).toMatchObject({ status: 'failed', stage: 'remove', stopReason: 'deadline',
      finalPrunePreview: { state: 'ok' } });
    expect(report.worktrees.filter(row => candidates.includes(resolve(row.path))).map(row => row.disposition).sort()).toEqual(['pending', 'removed']);
  });

  it('does not start any mutation after the soft deadline', async () => {
    const f = fixture(); f.add('clean'); let clock = 0;
    const calls: string[][] = [];
    const runProbe: typeof probe = (exe, args, options) => { calls.push(args); return probe(exe, args, options); };
    const report = await runCleanup({ ...f.options, now: () => clock, softTimeoutMs: 1 }, { ...quiet, runProbe,
      acquireRunLock: async (repository: string, root: string) => { const release = await acquireRunLock(repository, root); clock = 2; return release; } });
    expect(report.status).toBe('failed'); expect(report.stage).toBe('fetch'); expect(calls.some(args => args.includes('fetch'))).toBe(false);
  });

  it('keeps the soft budget below child kill and task limit with room for reserve and removal', () => {
    const launcherText = readFileSync(launcher, 'utf8'), installerText = readFileSync(installer, 'utf8');
    const soft = launcherText.match(/\$script:SoftBudgetMs\s*=\s*(\d+)/);
    const child = launcherText.match(/\$childTimeout\s*=\s*\$script:SoftBudgetMs\s*\+\s*(\d+)/);
    const task = installerText.match(/<ExecutionTimeLimit>PT(\d+)M<\/ExecutionTimeLimit>/);
    expect(soft).not.toBeNull(); expect(child).not.toBeNull(); expect(task).not.toBeNull();
    const softMs = Number(soft![1]), childMs = softMs + Number(child![1]), taskMs = Number(task![1]) * 60_000;
    expect(softMs).toBe(4_500_000); expect(childMs).toBe(4_680_000); expect(taskMs).toBe(4_800_000);
    expect(softMs).toBeLessThan(childMs); expect(childMs).toBeLessThan(taskMs);
    expect(softMs - 300_000).toBeGreaterThan(0);
    expect(launcherText).not.toMatch(/2100000|2280000/);
    // The child kill is measured from launcher start, never from child start.
    expect(launcherText.match(/\$started \+ \$childTimeout - \[DateTimeOffset\]::UtcNow\.ToUnixTimeMilliseconds\(\)/g)).toHaveLength(2);
    // Every timing override is read through the sentinel-gated helper.
    expect(launcherText).not.toMatch(/\$env:WORKTREE_CLEANUP_(?!TEST_OVERRIDES|NO_TOAST)/);
  });

  it('fails loudly if the harness ever stops setting the override sentinel', () => {
    expect(env.WORKTREE_CLEANUP_TEST_OVERRIDES).toBe('1');
  });

  it.skipIf(process.platform !== 'win32').each([300_000, 299_999, 0])('records launcher failure without starting cleanup when only %s ms remain', remaining => {
    const f = fixture('primary checkout'), marker = join(f.root, 'cleanup-started');
    mkdirSync(join(f.primary, 'scripts'));
    writeFileSync(join(f.primary, 'scripts/worktree-cleanup.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');\n`);
    git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'fixture runner'); git(f.primary, 'push', 'origin', 'main');
    const copy = installed(f);
    const result = ps(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath], {
      WORKTREE_CLEANUP_REMAINING_MS: String(remaining), WORKTREE_CLEANUP_NO_TOAST: '1',
    });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(1);
    expect(existsSync(marker)).toBe(false);
    const rows = journal(f.reportRoot);
    expect(rows).toEqual([expect.objectContaining({ status: 'failed', stage: 'launcher', worktrees: [],
      error: 'Insufficient soft budget after launcher preparation; more than 300000 ms required for tail reserve and removal floor.' })]);
    expect(readFileSync(rows[0].reportPath, 'utf8')).toContain('No cleanup stages started.');
  });

  it.skipIf(process.platform !== 'win32').each([
    ['starts cleanup when 300001 ms remain', { WORKTREE_CLEANUP_REMAINING_MS: '300001' }],
    ['ignores a stale remaining-budget override without the test sentinel', { WORKTREE_CLEANUP_REMAINING_MS: '0', WORKTREE_CLEANUP_TEST_OVERRIDES: '' }],
  ] as const)('%s', (_name, overrides) => {
    const f = fixture('primary checkout'), marker = join(f.root, 'cleanup-started');
    mkdirSync(join(f.primary, 'scripts'));
    writeFileSync(join(f.primary, 'scripts/worktree-cleanup.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started');
`);
    git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'fixture runner'); git(f.primary, 'push', 'origin', 'main');
    const copy = installed(f);
    ps(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath], { ...overrides, WORKTREE_CLEANUP_NO_TOAST: '1' });
    expect(existsSync(marker)).toBe(true);
  });

  it.skipIf(process.platform !== 'win32')('PrintXml is side-effect free, enabled, and points outside the repository', () => {
    const f = fixture(), result = ps(installer, ['-Repository', f.primary, '-InstallRoot', f.reportRoot, '-PrintXml']);
    expect(result.status, result.stderr).toBe(0);
    for (const text of ['InteractiveToken', 'LeastPrivilege', 'IgnoreNew', '<StartWhenAvailable>true', 'PT80M', '<Enabled>true', 'T03:00:00', 'Context="Owner"']) expect(result.stdout).toContain(text);
    expect(result.stdout).not.toContain('PT40M');
    expect(result.stdout).toContain(join(f.reportRoot, 'run-worktree-cleanup.ps1'));
    // Register-ScheduledTask takes the XML as a UTF-16 string and rejects a
    // declared single-byte encoding, so the declaration must not name one.
    expect(result.stdout).toMatch(/^<\?xml version="1\.0"\?>/);
    expect(existsSync(f.reportRoot)).toBe(false);
    expect(existsSync(join(f.primary, '.worktrees/.worktree-cleanup-runner'))).toBe(false);
    const linked = f.add('linked');
    expect(ps(installer, ['-Repository', linked, '-InstallRoot', f.reportRoot, '-PrintXml']).status).not.toBe(0);
  });

  it.skipIf(process.platform !== 'win32')('InstallOnly creates and refreshes a detached runner at origin/main', () => {
    const f = fixture('primary checkout'), runner = join(f.primary, '.worktrees/.worktree-cleanup-runner');
    installed(f);
    expect(git(runner, 'rev-parse', 'HEAD')).toBe(git(f.primary, 'rev-parse', 'origin/main'));
    expect(git(runner, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    git(runner, 'checkout', '-b', 'old-runner');
    writeFileSync(join(f.primary, 'tracked.md'), '# Refreshed main\n');
    git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'new reviewed main'); git(f.primary, 'push', 'origin', 'main');
    const result = ps(installer, ['-Repository', f.primary, '-InstallRoot', f.reportRoot, '-InstallOnly']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Runner refreshed to detached origin/main.');
    expect(git(runner, 'rev-parse', 'HEAD')).toBe(git(f.primary, 'rev-parse', 'origin/main'));
    expect(git(runner, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    expect(readFileSync(join(runner, 'tracked.md'), 'utf8')).toBe('# Refreshed main\n');
  });

  it.skipIf(process.platform !== 'win32')('InstallOnly refuses a dirty runner without overwriting it and explains deferred refresh', () => {
    const f = fixture(), runner = join(f.primary, '.worktrees/.worktree-cleanup-runner');
    git(f.primary, 'worktree', 'add', '--detach', runner, 'origin/main');
    writeFileSync(join(runner, 'tracked.md'), 'keep tracked changes\n');
    writeFileSync(join(runner, 'leftover.txt'), 'keep untracked files\n');
    git(f.primary, 'remote', 'set-url', 'origin', join(f.root, 'absent.git'));
    const before = bytes(runner), head = git(runner, 'rev-parse', 'HEAD');
    const result = ps(installer, ['-Repository', f.primary, '-InstallRoot', f.reportRoot, '-InstallOnly']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Runner is dirty');
    expect(result.stdout).toContain('The next nightly run will refresh it');
    expect(result.stdout).toContain('releases refuse until then');
    expect(bytes(runner)).toEqual(before); expect(git(runner, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(f.reportRoot, 'run-worktree-cleanup.ps1'))).toEqual(readFileSync(launcher));
  });

  it.skipIf(process.platform !== 'win32')('InstallOnly reports a failed runner fetch without creating a runner', () => {
    const f = fixture(), runner = join(f.primary, '.worktrees/.worktree-cleanup-runner');
    git(f.primary, 'remote', 'set-url', 'origin', join(f.root, 'absent.git'));
    const result = ps(installer, ['-Repository', f.primary, '-InstallRoot', f.reportRoot, '-InstallOnly']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Git command failed: fetch');
    expect(result.stdout).toContain('The next nightly run will refresh it');
    expect(result.stdout).toContain('releases refuse until then');
    expect(existsSync(runner)).toBe(false);
  });

  it.skipIf(process.platform !== 'win32')('installs exact bytes and refuses a tampered launcher before resolving executables', () => {
    const f = fixture(), copy = installed(f), record = JSON.parse(readFileSync(join(f.reportRoot, 'installation.json'), 'utf8'));
    expect(readFileSync(copy)).toEqual(readFileSync(launcher));
    expect(record.launcherSha256).toBe(createHash('sha256').update(readFileSync(copy)).digest('hex'));
    writeFileSync(copy, readFileSync(copy, 'utf8') + '\n# changed\n');
    const before = bytes(f.primary), result = ps(copy, ['-NodePath', join(f.root, 'missing.exe')]);
    expect(result.status).toBe(1); expect(journal(f.reportRoot).at(-1).error).toContain('SHA-256 mismatch'); expect(bytes(f.primary)).toEqual(before);
  });

  it.skipIf(process.platform !== 'win32')('refuses a second launcher while its OS lock is held', async () => {
    const f = fixture(), copy = installed(f), server = createServer();
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: lockPort(f.primary, true), exclusive: true }, accept); });
    try {
      const result = ps(copy, ['-NodePath', join(f.root, 'missing.exe')]);
      expect(result.status).toBe(1); expect(journal(f.reportRoot).at(-1).error).toContain('Single-instance lock');
    } finally { await new Promise<void>(accept => server.close(() => accept())); }
  });

  it.skipIf(process.platform !== 'win32')('reports missing gh and failed launcher fetch without changing the installed runner', () => {
    for (const failure of ['gh', 'fetch']) {
      const f = fixture(), copy = installed(f);
      if (failure === 'fetch') git(f.primary, 'remote', 'set-url', 'origin', join(f.root, 'absent.git'));
      const before = bytes(f.primary);
      const runner = join(f.primary, '.worktrees/.worktree-cleanup-runner'), runnerBefore = bytes(runner);
      const result = ps(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', failure === 'gh' ? join(f.root, 'missing.exe') : process.execPath]);
      expect(result.status).toBe(1);
      expect(journal(f.reportRoot).at(-1).error).toContain(failure === 'gh' ? 'Executable unavailable: gh.exe' : 'Git command failed: fetch');
      expect(bytes(runner)).toEqual(runnerBefore);
      if (failure === 'gh') expect(bytes(f.primary)).toEqual(before);
    }
  });

  it.skipIf(process.platform !== 'win32').each(['fetch', 'rev-parse'])('bounds launcher %s and kills the whole git process tree', verb => {
    const f = fixture('primary checkout'), copy = installed(f), fake = join(f.root, 'fake git.exe'), pids = join(f.root, 'pids.txt');
    const source = join(f.root, 'fake.cs'), compile = join(f.root, 'compile.ps1');
    writeFileSync(source, `
      using System;
      using System.Diagnostics;
      using System.IO;
      using System.Threading;
      public class FakeGit {
        public static void Main(string[] args) {
          if (Array.IndexOf(args, "--child") >= 0) { Thread.Sleep(35000); return; }
          if (Environment.GetEnvironmentVariable("GIT_TERMINAL_PROMPT") != "0") Environment.Exit(7);
          int cwd = Array.IndexOf(args, "-C");
          if (cwd < 0 || args[cwd + 1] != Environment.GetEnvironmentVariable("FAKE_REPOSITORY")) Environment.Exit(8);
          if (Array.IndexOf(args, "worktree") >= 0 && Array.IndexOf(args, "list") >= 0) {
            Console.WriteLine("worktree " + Path.Combine(args[cwd + 1], ".worktrees", ".worktree-cleanup-runner").Replace(Path.DirectorySeparatorChar, '/')); return;
          }
          if (Array.IndexOf(args, "status") >= 0) return;
          if (Array.IndexOf(args, Environment.GetEnvironmentVariable("FAKE_VERB")) < 0) {
            Console.WriteLine(Path.Combine(args[cwd + 1], ".git")); return;
          }
          var child = Process.Start(new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "--child") { UseShellExecute = false, CreateNoWindow = true });
          File.WriteAllLines(Environment.GetEnvironmentVariable("FAKE_PIDS"), new string[] { Process.GetCurrentProcess().Id.ToString(), child.Id.ToString() });
          Console.Out.Write(new string('o', 131072)); Console.Out.Flush();
          Console.Error.Write(new string('e', 131072)); Console.Error.Flush();
          Thread.Sleep(35000);
        }
      }
    `);
    writeFileSync(compile, 'Add-Type -Path $env:FAKE_SOURCE -OutputAssembly $env:FAKE_EXE -OutputType ConsoleApplication\n');
    const compiled = ps(compile, [], { FAKE_SOURCE: source, FAKE_EXE: fake });
    expect(compiled.status, compiled.stderr).toBe(0);
    try {
      const result = ps(copy, ['-NodePath', process.execPath, '-GitPath', fake, '-GhPath', process.execPath], {
        WORKTREE_CLEANUP_GIT_TIMEOUT_MS: '1500', WORKTREE_CLEANUP_NO_TOAST: '1',
        FAKE_PIDS: pids, FAKE_REPOSITORY: f.primary, FAKE_VERB: verb,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(journal(f.reportRoot).at(-1)).toMatchObject({ status: 'failed', stage: 'launcher', error: `Git command timed out: ${verb} (taskkill exit 0)` });
      const children = readFileSync(pids, 'utf8').trim().split(/\r?\n/).map(Number);
      expect(children).toHaveLength(2);
      for (const pid of children) expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
    } finally {
      // Also clean up the intentionally failing red run, whose launcher has no timeout yet.
      if (existsSync(pids)) for (const pid of readFileSync(pids, 'utf8').trim().split(/\r?\n/)) {
        spawnSync('taskkill.exe', ['/T', '/F', '/PID', pid], { windowsHide: true });
      }
    }
  });

  it.skipIf(process.platform !== 'win32')('launches detached origin/main despite a different primary branch, then refuses a dirty runner before fetch', () => {
    const f = fixture('primary checkout');
    mkdirSync(join(f.primary, 'scripts'));
    writeFileSync(join(f.primary, 'scripts/worktree-cleanup.mjs'),
      `import { appendFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';\nconst args = process.argv.slice(2), root = args[args.indexOf('--report-root') + 1]; writeFileSync(join(root, 'invocation.json'), JSON.stringify({ args, cwd: process.cwd() })); appendFileSync(join(root, 'journal.jsonl'), JSON.stringify({ version: 1, runId: args[args.indexOf('--run-id') + 1], status: 'completed', dryRun: false, worktrees: [] }) + '\\n');\n`);
    git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'reviewed runner'); git(f.primary, 'push', 'origin', 'main');
    const reviewed = git(f.primary, 'rev-parse', 'HEAD');
    git(f.primary, 'checkout', '-b', 'different-primary');
    writeFileSync(join(f.primary, 'scripts/worktree-cleanup.mjs'), 'throw new Error("unreviewed primary must not run");\n');
    const copy = installed(f);
    const args = ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath];
    const first = ps(copy, args);
    expect(first.status, first.stderr + first.stdout).toBe(0);
    const runner = join(f.primary, '.worktrees/.worktree-cleanup-runner');
    expect(git(runner, 'rev-parse', 'HEAD')).toBe(reviewed); expect(git(runner, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('HEAD');
    const invocation = JSON.parse(readFileSync(join(f.reportRoot, 'invocation.json'), 'utf8'));
    expect(resolve(invocation.cwd)).toBe(runner); expect(invocation.args[0]).toBe('run');
    expect(invocation.args).toContain('--scheduled-nightly');
    expect(invocation.args).not.toContain('--release-unresolved-doubt');
    writeFileSync(join(runner, 'leftover.txt'), 'keep me');
    git(f.primary, 'remote', 'set-url', 'origin', join(f.root, 'missing.git'));
    const before = bytes(runner), second = ps(copy, args);
    expect(second.status).toBe(1); expect(journal(f.reportRoot).at(-1).error).toContain('Runner is dirty'); expect(bytes(runner)).toEqual(before);
  });

  it.skipIf(process.platform !== 'win32').each(['own-row', 'other-row', 'newline-only', 'smaller-with-own-row'])(
    'checks this run id instead of journal size: %s', mode => {
      const f = fixture(); mkdirSync(join(f.primary, 'scripts'));
      writeFileSync(join(f.primary, 'scripts/worktree-cleanup.mjs'), `
        import { appendFileSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';
        const args = process.argv.slice(2), root = args[args.indexOf('--report-root') + 1];
        const runId = args[args.indexOf('--run-id') + 1], mode = ${JSON.stringify(mode)};
        const row = { version: 1, runId: mode === 'other-row' ? 'unrelated' : runId, status: 'completed', outcome: 'completed-with-holds',
          reasonCounts: { exempt: 1 }, refusedAtRemoval: 0, mutationCount: 0,
          worktrees: [{ path: 'fixture', action: 'hold', disposition: 'hold', initialDisposition: 'hold', finalDisposition: 'hold', reasonCode: 'exempt', mutations: [] }] };
        const path = join(root, 'journal.jsonl');
        const text = mode === 'newline-only' ? '\\n' : JSON.stringify(row) + '\\n';
        (mode === 'smaller-with-own-row' ? writeFileSync : appendFileSync)(path, text);
      `);
      git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'fixture runner'); git(f.primary, 'push', 'origin', 'main');
      const copy = installed(f);
      writeFileSync(join(f.reportRoot, 'journal.jsonl'), JSON.stringify({ runId: 'prior', padding: 'x'.repeat(4000) }) + '\n{"torn":\n');
      const result = ps(copy, ['-NodePath', process.execPath, '-GitPath', gitPath, '-GhPath', process.execPath]);
      const accepted = mode === 'own-row' || mode === 'smaller-with-own-row';
      expect(result.status, result.stderr + result.stdout).toBe(accepted ? 0 : 1);
      if (accepted) expect(journal(f.reportRoot).at(-1)).toMatchObject({ status: 'completed', outcome: 'completed-with-holds', runId: expect.not.stringMatching(/^(prior|run|unrelated)$/) });
      else expect(journal(f.reportRoot).at(-1)).toMatchObject({ stage: 'launcher', error: expect.stringContaining('before writing a report') });
    });

  it('reports held ages across runs and archive count, bytes, age and restore commands', () => {
    const f = fixture(), now = Date.now(), path = join(f.reportRoot, 'archives/saved'); mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'manifest.json'), JSON.stringify({ createdAt: now - 179.5 * 86_400_000 }));
    writeFileSync(join(path, 'data'), 'preserved');
    const first = { runId: 'first', startedAt: now - 2 * 86_400_000, finishedAt: now, status: 'completed', stage: 'complete', dryRun: false,
      worktrees: [{ path: f.primary, action: 'hold', disposition: 'hold', reason: 'live', restoreCommand: 'node scripts/worktree-cleanup.mjs restore "saved"' }] };
    writeRunReport(f.reportRoot, first);
    const next = writeRunReport(f.reportRoot, { ...first, runId: 'second', startedAt: now, finishedAt: now });
    expect(next.held.oldestAgeMs).toBe(2 * 86_400_000); expect(next.archives.count).toBe(1); expect(next.archives.totalBytes).toBeGreaterThan(9);
    const text = readFileSync(next.reportPath, 'utf8');
    expect(text).toContain('2.0 days'); expect(text).toContain('expires within 24 hours'); expect(text).toContain('restore "saved"');
  });
});
