import './worktree-cleanup-test-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inventory, candidateInventory, isWithin, regularBytes } from '../lib/worktree-cleanup/inventory.mjs';
import { runCleanup } from '../worktree-cleanup.mjs';
import { activity, collectActivity, fileActivity } from '../lib/worktree-cleanup/activity.mjs';
import { planWorktrees } from '../lib/worktree-cleanup/policy.mjs';
import { executeRemovals, type RemovalOptions, type RemovalResult } from '../lib/worktree-cleanup/remove.mjs';
import { writeRunReport } from '../lib/worktree-cleanup/report.mjs';
import { preflightSnapshot, publishSnapshot, verifySnapshotRecord, markSnapshotProgress, markSnapshotRemoved, type SnapshotFile } from '../lib/worktree-cleanup/snapshot.mjs';
import { boundedTimeout, ok, probe, unknown } from '../lib/worktree-cleanup/probe.mjs';

const helper = resolve('scripts/remove-worktree-junction.ps1');
const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const roots: string[] = [];
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream), readdirSync: vi.fn(fs.readdirSync), rmdirSync: vi.fn(fs.rmdirSync), lstatSync: vi.fn(fs.lstatSync) };
});
vi.mock('../lib/worktree-cleanup/inventory.mjs', async original => {
  const inventoryModule = await original<typeof import('../lib/worktree-cleanup/inventory.mjs')>();
  return { ...inventoryModule, inventory: vi.fn(inventoryModule.inventory), candidateInventory: vi.fn(inventoryModule.candidateInventory) };
});
vi.mock('../lib/worktree-cleanup/activity.mjs', async original => {
  const activityModule = await original<typeof import('../lib/worktree-cleanup/activity.mjs')>();
  return { ...activityModule, activity: vi.fn(activityModule.activity), fileActivity: vi.fn(activityModule.fileActivity) };
});
const old = new Date(Date.now() - 96 * 60 * 60 * 1000);
const commandEnv: NodeJS.ProcessEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV };
type RescueFile = { path: string; rescuedPath: string; blobSha: string; kind: string; bytes: Buffer };

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', env: commandEnv, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.trim();
}
function hash(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex'); }
function blob(cwd: string, bytes: Buffer) {
  const result = spawnSync('git', ['-C', cwd, 'hash-object', '--stdin'], { input: bytes, env: commandEnv, windowsHide: true });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout.toString().trim();
}
function age(path: string) {
  for (const name of readdirSync(path)) {
    if (name === '.git') continue;
    const child = join(path, name), stat = lstatSync(child);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) age(child);
    else utimesSync(child, old, old);
  }
}
function safeCleanup(path: string) {
  const full = resolve(path);
  if (!isWithin(full, tmpdir()) || full === resolve(tmpdir())) throw new Error('Fixture cleanup escaped tmpdir');
  if (!existsSync(full)) return;
  for (const name of readdirSync(full)) {
    const child = join(full, name), stat = lstatSync(child);
    if (stat.isSymbolicLink()) {
      if (process.platform === 'win32') {
        const code = '[System.IO.Directory]::Delete($env:TEST_JUNCTION, $false)';
        const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', code], { env: { ...process.env, TEST_JUNCTION: child }, windowsHide: true });
        if (result.status !== 0) throw new Error('Could not unlink test junction');
      } else unlinkSync(child);
    } else if (stat.isDirectory()) safeCleanup(child);
  }
  rmSync(full, { recursive: true, force: true });
}
// Junction fixtures unlink through PowerShell; under full-suite load that exceeds the 10 s default.
afterEach(() => { for (const root of roots.splice(0)) safeCleanup(root); }, 60_000);

function fixture(crlf = false) {
  const root = mkdtempSync(join(tmpdir(), 'wt-remove-'));
  roots.push(root);
  const primary = join(root, 'primary'), home = join(root, 'home');
  mkdirSync(primary); mkdirSync(home);
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.name', 'Fixture'); git(primary, 'config', 'user.email', 'fixture@example.invalid');
  git(primary, 'config', 'core.autocrlf', crlf ? 'true' : 'false');
  writeFileSync(join(primary, '.gitignore'), 'node_modules/\ncoverage/\n.next/\n');
  writeFileSync(join(primary, 'tracked.md'), 'original\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'fixture');
  git(primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  function add(name = 'candidate', path = join(root, name)) { git(primary, 'worktree', 'add', '-b', name, path); age(path); return path; }
  const tree = add();
  const options = { repositoryPath: primary, runnerPath: primary, activityOptions: { homeDirectory: home } };
  return { root, primary, home, tree, add, options };
}
type Fixture = ReturnType<typeof fixture>;
async function classify(f: Fixture, operatorRelease: string[] = []) {
  const facts = inventory(f.options);
  expect(facts.state).toBe('ok');
  if (facts.state !== 'ok') throw new Error('Inventory failed');
  const signals = await collectActivity(facts.value.worktrees, f.options.activityOptions);
  const snapshot = { ...facts.value, worktrees: facts.value.worktrees.map((tree, index) => ({ ...tree, activity: signals[index] })) };
  const result = await planWorktrees(snapshot, { prSnapshot: ok([]), ...(operatorRelease.length ? { operatorRelease } : {}) });
  if (result.state !== 'ok') throw new Error('Classification failed');
  return { snapshot, plan: result.value };
}
async function rescue(f: Fixture, crlf = false) {
  if (crlf) git(f.primary, 'config', 'core.autocrlf', 'true');
  writeFileSync(join(f.tree, 'tracked.md'), crlf ? 'edited\r\n' : 'edited\n');
  writeFileSync(join(f.tree, 'new.md'), crlf ? 'new\r\n' : 'new\n');
  age(f.tree);
  const context = await classify(f);
  const decision = context.plan.worktrees.find(tree => tree.path === f.tree || resolve(tree.path) === f.tree);
  expect(decision?.disposition).toBe('rescue');
  const published = { worktrees: [{ path: f.tree, head: decision.head, verified: ok(true), files: (decision.files as RescueFile[]).map(({ bytes: _bytes, ...file }) => file) }] };
  return { ...context, published, decision };
}
async function execute(f: Fixture, context: Awaited<ReturnType<typeof classify>>, extra: RemovalOptions = {}) {
  const result = await executeRemovals(context.plan, context.snapshot, { ...f.options, ...extra });
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error(result.state === 'unknown' ? result.reason : 'Unexpected negative result');
  return result.value;
}
function outcome(result: { worktrees: RemovalResult[] }, path: string) {
  const found = result.worktrees.find(tree => resolve(tree.path) === path);
  if (!found) throw new Error('Missing outcome for ' + path);
  return found;
}
function shared(f: Fixture) {
  const target = join(f.root, 'shared'); mkdirSync(target);
  writeFileSync(join(target, '.package-lock.json'), '{"packages":{}}');
  mkdirSync(join(target, 'package')); writeFileSync(join(target, 'package', 'index.js'), 'safe');
  return target;
}
function danglingChain(f: Fixture, live = false) {
  const removed = join(f.root, 'removed'), target = join(removed, 'node_modules');
  const middle = join(f.root, 'middle'), link = join(f.tree, 'node_modules');
  mkdirSync(target, { recursive: true });
  symlinkSync(target, middle, 'junction'); symlinkSync(middle, link, 'junction');
  if (!live) { rmdirSync(target); rmdirSync(removed); }
  return { target, middle, link };
}

function buildSelfLink(f: Fixture, shape = '.next/node_modules', kind: 'junction' | 'dir' = 'junction', name = 'pkg-hash') {
  const target = join(f.tree, 'node_modules', name), link = join(f.tree, shape, name);
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'keep'), 'safe');
  writeFileSync(join(f.tree, 'node_modules', '.package-lock.json'), '{"packages":{}}');
  mkdirSync(join(f.tree, shape), { recursive: true }); symlinkSync(target, link, kind);
  return { target, link };
}

// U4b calls removal directly: the coordinator still holds snapshot decisions.
async function snapshotContext(f: Fixture, only: boolean | SnapshotFile['kind'] = false, trackedBytes = '{"base":true}\n', extraUntracked = 0) {
  const tracked = 'artifacts/github-issue-roadmap/tracked.json';
  mkdirSync(dirname(join(f.tree, tracked)), { recursive: true });
  writeFileSync(join(f.tree, tracked), trackedBytes);
  writeFileSync(join(f.tree, '.gitignore'), 'node_modules/\ncoverage/\n.next/\n.reproduce-out/\n');
  git(f.tree, 'add', '.'); git(f.tree, 'commit', '-m', 'snapshot base');
  const remote = join(f.root, 'origin.git'); mkdirSync(remote);
  git(remote, 'init', '--bare', '--initial-branch=main'); git(f.primary, 'remote', 'add', 'origin', remote);
  const payloads = [
    { path: '.tmp-intake/untracked.json', kind: 'untracked', bytes: '{"untracked":true}\n' },
    { path: '.reproduce-out/deep/ignored.json', kind: 'ignored', bytes: '{"ignored":true}\n' },
    { path: tracked, kind: 'modified', bytes: '{"modified":true}\n' },
    ...Array.from({ length: extraUntracked }, (_, index) => ({ path: `.tmp-intake/extra-${index}.json`, kind: 'untracked', bytes: `${index}\n` })),
  ].filter(file => !only || file.kind === (only === true ? 'ignored' : only));
  for (const file of payloads) { mkdirSync(dirname(join(f.tree, file.path)), { recursive: true }); writeFileSync(join(f.tree, file.path), file.bytes); }
  age(f.tree);
  const context = await classify(f), baseline = context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)!;
  const options = { reportRoot: join(f.root, 'reports'), remotePath: remote };
  const publication = publishSnapshot(baseline, preflightSnapshot(baseline), options);
  expect(publication.state).toBe('ok');
  if (publication.state !== 'ok') throw new Error('Fixture publication failed');
  const record = publication.value, journalRoot = dirname(record.journalPath);
  const decision = { path: f.tree, head: record.head, branch: record.branch, disposition: 'snapshot', snapshotRecord: record };
  context.plan.worktrees = [decision];
  const callbacks = {
    verifySnapshot: () => verifySnapshotRecord(decision.snapshotRecord, { ...options, repositoryPath: f.primary }),
    onSnapshotProgress: (update: Parameters<NonNullable<RemovalOptions['onSnapshotProgress']>>[0]) => markSnapshotProgress(journalRoot, update),
    onSnapshotRemoved: (path: string) => markSnapshotRemoved(journalRoot, path),
  };
  return { ...context, decision, record, payloads, tracked, remote, options, callbacks, journalRoot };
}

describe('#2522 snapshot file guard', { timeout: 60_000 }, () => {
  it.each([
    ['bytes', 'Snapshot file bytes changed'],
    ['index', 'Index differs from HEAD'],
    ['HEAD', 'HEAD advanced during recheck'],
    ['path link', 'Path link changed'],
    ['lease', 'Lease activity'],
    ['reappeared', 'Cleaned snapshot file reappeared'],
    ['new work', 'Status changed'],
    ['stale transcript', 'Lease, transcript, or HEAD activity'],
    ['stale during intent', 'Lease, transcript, or HEAD activity'],
    ['locked', 'HEAD or registration changed'],
    ['branch switched', 'HEAD or registration changed'],
  ])('refuses the second file after %s changes', async (change, reason) => {
    const f = fixture(), context = await snapshotContext(f), calls: string[][] = [];
    const files = [...context.record.files].sort((a: SnapshotFile, b: SnapshotFile) => (a.kind === 'modified' ? 1 : 0) - (b.kind === 'modified' ? 1 : 0));
    const first = files[0], second = files[1], secondPath = join(f.tree, second.path);
    let expectedBytes = readFileSync(secondPath), clock = 0, injected = false;
    const outside = join(f.root, 'outside-copy');
    // Keep the first ignored file's empty parents so the only mutation is its unlink.
    vi.mocked(rmdirSync).mockImplementationOnce(() => { throw Object.assign(new Error('directory busy'), { code: 'EBUSY' }); });
    const staleTranscript = () => {
      clock += 2 * 60_000 + 1;
      const sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, 'recent.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: f.tree } }) + '\n');
    };
    const result = await execute(f, context, { ...context.callbacks, monotonicNow: () => clock,
      onSnapshotProgress: update => {
        const saved = context.callbacks.onSnapshotProgress(update);
        if (change === 'stale during intent' && injected && update.inFlight?.path === second.path) staleTranscript();
        return saved;
      },
      runProbe: (exe, args, options) => { calls.push(args); return probe(exe, args, options); },
      onAfterMutation: event => {
        if (injected || !['unlink-snapshot', 'restore'].includes(event.kind)) return;
        injected = true; expect(event.file).toBe(first.path);
        if (change === 'bytes') { expectedBytes = Buffer.from('changed bytes\n'); writeFileSync(secondPath, expectedBytes); age(f.tree); }
        if (change === 'index') { writeFileSync(join(f.tree, 'tracked.md'), 'staged edit\n'); git(f.tree, 'add', 'tracked.md'); }
        if (change === 'HEAD') git(f.tree, 'commit', '--allow-empty', '-m', 'advanced');
        if (change === 'path link') {
          mkdirSync(outside); writeFileSync(join(outside, 'untracked.json'), expectedBytes);
          unlinkSync(secondPath); rmdirSync(dirname(secondPath));
          symlinkSync(outside, dirname(secondPath), process.platform === 'win32' ? 'junction' : 'dir');
        }
        if (change === 'lease') {
          const job = join(f.options.activityOptions.homeDirectory, '.claude', 'codex-jobs', 'guard-job'); mkdirSync(job, { recursive: true });
          writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'guard-job', cwd: f.tree, pid: null, started_at: old.toISOString() }));
          writeFileSync(join(job, 'stdout.log'), 'running\n'); writeFileSync(join(job, 'stderr.log'), '');
        }
        if (change === 'reappeared') { writeFileSync(join(f.tree, first.path), 'new work\n'); age(f.tree); }
        if (change === 'new work') { writeFileSync(join(f.tree, 'new-work.txt'), 'keep\n'); age(f.tree); }
        if (change === 'stale transcript') staleTranscript();
        if (change === 'locked') git(f.primary, 'worktree', 'lock', f.tree);
        if (change === 'branch switched') git(f.tree, 'switch', '-c', 'same-commit');
      },
    });
    const row = outcome(result, f.tree);
    expect(injected).toBe(true);
    expect(row).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held', reason,
      mutations: [{ kind: 'unlink-snapshot', path: f.tree, file: first.path }] });
    expect(readFileSync(secondPath)).toEqual(expectedBytes);
    if (change === 'path link') expect(readFileSync(join(outside, 'untracked.json'))).toEqual(expectedBytes);
    expect(calls.some(args => args.includes('worktree') && args.includes('remove'))).toBe(false);
    if (change.startsWith('stale')) expect(row.recheckDurations).toContainEqual({ step: 'candidate inventory', calls: 2, ms: 0 });
  });

  it('keeps the full-gate count constant as the snapshot file count grows', async () => {
    const rows: RemovalResult[] = [];
    for (const extra of [0, 5]) {
      const f = fixture(), context = await snapshotContext(f, false, '{"base":true}\n', extra);
      const row = outcome(await execute(f, context, { ...context.callbacks, monotonicNow: () => 0 }), f.tree);
      expect(row.disposition).toBe('removed'); rows.push(row);
    }
    const gates = rows.map(row => row.recheckDurations?.find(entry => entry.step === 'candidate inventory')?.calls);
    expect(gates).toEqual([2, 2]);
    expect(rows.map(row => row.recheckDurations?.find(entry => entry.step === 'file guard')?.calls)).toEqual([3, 8]);
  });

  it('verifies twice and fuses the post-loop gate with the remove gate', async () => {
    const f = fixture(), context = await snapshotContext(f), verify = vi.fn(context.callbacks.verifySnapshot);
    vi.mocked(candidateInventory).mockClear();
    let afterFiles = 0;
    const atRemoval: number[] = [], atVerification: number[] = [];
    const row = outcome(await execute(f, context, { ...context.callbacks, monotonicNow: () => 0,
      verifySnapshot: () => { atVerification.push(vi.mocked(candidateInventory).mock.calls.length); return verify(); },
      onAfterMutation: event => { if (event.kind === 'restore') afterFiles = vi.mocked(candidateInventory).mock.calls.length; },
      runProbe: (exe, args, options) => {
        if (args.includes('worktree') && args.includes('remove')) atRemoval.push(vi.mocked(candidateInventory).mock.calls.length);
        return probe(exe, args, options);
      },
    }), f.tree);
    expect(row.disposition).toBe('removed'); expect(verify).toHaveBeenCalledTimes(2);
    expect(atVerification).toEqual([0, afterFiles]);
    expect(atRemoval).toEqual([afterFiles + 2]);
    expect(row.recheckDurations?.find(entry => entry.step === 'candidate inventory')?.calls).toBe(2);
  });
});

describe('U4b verified snapshot cleanup', { timeout: 60_000 }, () => {
  it.each([false, true])('cleans the committed copy set before non-forced removal, retaining the branch (ignored-only=%s)', async ignoredOnly => {
    const f = fixture(), context = await snapshotContext(f, ignoredOnly), progress: string[][] = [], calls: string[][] = [];
    const verify = vi.fn(context.callbacks.verifySnapshot), removed = vi.fn(context.callbacks.onSnapshotRemoved);
    const result = await execute(f, context, { ...context.callbacks, verifySnapshot: verify, onSnapshotRemoved: removed,
      onSnapshotProgress: update => { progress.push([...update.cleaned]); return context.callbacks.onSnapshotProgress(update); },
      runProbe: (exe, args, options) => {
        calls.push(args);
        if (args.includes('remove')) {
          for (const file of context.payloads.filter(file => file.path !== context.tracked)) expect(existsSync(join(f.tree, file.path))).toBe(false);
          expect(readFileSync(join(f.tree, context.tracked), 'utf8')).toBe('{"base":true}\n');
          expect(git(f.tree, 'status', '--porcelain=v1', '--ignored=matching')).toBe('');
        }
        return probe(exe, args, options);
      },
    });
    expect(outcome(result, f.tree), JSON.stringify(result)).toMatchObject({ disposition: 'removed' });
    expect(existsSync(f.tree)).toBe(false); expect(git(f.primary, 'rev-parse', 'refs/heads/candidate')).toBe(context.record.head);
    expect(verify).toHaveBeenCalledTimes(2); expect(removed).toHaveBeenCalledWith(f.tree);
    expect(progress).toHaveLength(2 * context.payloads.length); expect(progress.at(-1)?.sort()).toEqual(context.payloads.map(file => file.path).sort());
    expect(calls.flat()).not.toContain('--force'); expect(JSON.parse(readFileSync(context.record.journalPath, 'utf8')).state).toBe('removed');
  });

  it.skipIf(process.platform !== 'win32')('hands off to junction unlink after snapshot cleanup and preserves the shared target', async () => {
    const f = fixture(), target = shared(f), before = targetSnapshot(target), order: string[] = [];
    symlinkSync(target, join(f.tree, 'node_modules'), 'junction');
    const context = await snapshotContext(f);
    const result = await execute(f, context, { ...context.callbacks, onBeforeMutation: event => {
      order.push(event.kind);
      if (event.kind === 'unlink-junction') {
        for (const file of context.payloads.filter(file => file.path !== context.tracked)) expect(existsSync(join(f.tree, file.path))).toBe(false);
        expect(readFileSync(join(f.tree, context.tracked), 'utf8')).toBe('{"base":true}\n');
      }
    } });
    expect(outcome(result, f.tree), JSON.stringify(result)).toMatchObject({ disposition: 'removed' });
    expect(order).toEqual(['unlink-snapshot', 'unlink-snapshot', 'restore', 'unlink-junction', 'remove', 'prune']);
    expect(targetSnapshot(target)).toEqual(before); expect(git(f.primary, 'rev-parse', 'candidate')).toBe(context.record.head);
  });

  it.each(['HEAD', 'path', 'state', 'duplicate', 'unsafe path', 'digest length', 'missing ignored', 'missing status', 'extra ignored record'])(
    'refuses a mismatched or unsafe record: %s', async change => {
      const f = fixture(), context = await snapshotContext(f), record = structuredClone(context.record);
      if (change === 'HEAD') record.head = '1'.repeat(40);
      if (change === 'path') record.treePath = f.primary;
      if (change === 'state') record.state = 'pushed_unverified';
      if (change === 'duplicate') record.files.push({ ...record.files[0], path: record.files[0].path.toUpperCase() });
      if (change === 'unsafe path') record.files[0].path = '../outside';
      if (change === 'digest length') record.files[0].digest = '1'.repeat(64);
      if (change === 'missing ignored') record.files = record.files.filter((file: SnapshotFile) => file.kind !== 'ignored');
      if (change === 'missing status') record.files = record.files.filter((file: SnapshotFile) => file.kind !== 'untracked');
      if (change === 'extra ignored record') record.files.push({ ...record.files.find((file: SnapshotFile) => file.kind === 'ignored'), path: 'outside.json' });
      context.decision.snapshotRecord = record;
      const result = await execute(f, context, context.callbacks);
      expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
      for (const file of context.payloads) expect(readFileSync(join(f.tree, file.path), 'utf8')).toBe(file.bytes);
    },
  );

  it.each(['deleted', 'moved', 'missing verifier', 'throws', 'malformed', 'missing persistence', 'missing removal persistence'])('refuses unverified snapshots without touching files: %s', async failure => {
    const f = fixture(), context = await snapshotContext(f), callbacks: RemovalOptions = { ...context.callbacks };
    if (failure === 'deleted') git(context.remote, 'update-ref', '-d', context.record.ref);
    if (failure === 'moved') git(context.remote, 'update-ref', context.record.ref, context.record.head);
    if (failure === 'missing verifier') callbacks.verifySnapshot = undefined;
    if (failure === 'throws') callbacks.verifySnapshot = () => { throw new Error('unavailable'); };
    if (failure === 'malformed') callbacks.verifySnapshot = () => ({});
    if (failure === 'missing persistence') callbacks.onSnapshotProgress = undefined;
    if (failure === 'missing removal persistence') callbacks.onSnapshotRemoved = undefined;
    expect(outcome(await execute(f, context, callbacks), f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'snapshot-unverified', mutations: [] });
    for (const file of context.payloads) expect(readFileSync(join(f.tree, file.path), 'utf8')).toBe(file.bytes);
  });

  it.each(['moved', 'deleted', 'throws', 'missing verifier', 'malformed'])('refuses a snapshot that becomes unverified during cleanup: %s', async failure => {
    const f = fixture(true), context = await snapshotContext(f);
    const verify = vi.fn<NonNullable<RemovalOptions['verifySnapshot']>>(context.callbacks.verifySnapshot);
    const removed = vi.fn(context.callbacks.onSnapshotRemoved), calls: string[][] = [];
    const callbacks: RemovalOptions = { ...f.options, ...context.callbacks, verifySnapshot: verify, onSnapshotRemoved: removed,
      runProbe: (exe, args, options) => { calls.push(args); return probe(exe, args, options); } };
    callbacks.onAfterMutation = event => {
      if (event.kind !== 'restore') return;
      if (failure === 'moved') git(context.remote, 'update-ref', context.record.ref, context.record.head);
      if (failure === 'deleted') git(context.remote, 'update-ref', '-d', context.record.ref);
      if (failure === 'throws') verify.mockImplementationOnce(() => { throw new Error('unavailable'); });
      if (failure === 'missing verifier') callbacks.verifySnapshot = undefined;
      if (failure === 'malformed') verify.mockImplementationOnce(() => ({}));
    };
    const result = await executeRemovals(context.plan, context.snapshot, callbacks);
    expect(result.state).toBe('ok');
    if (result.state !== 'ok') throw new Error('Unexpected removal result');
    expect(outcome(result.value, f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'snapshot-unverified', stopReason: 'mutated-then-held' });
    expect(verify).toHaveBeenCalledTimes(failure === 'missing verifier' ? 1 : 2);
    expect(verify.mock.results[0].value).toMatchObject({ state: 'ok' });
    if (failure === 'moved' || failure === 'deleted') expect(verify.mock.results[1].value).toMatchObject({ state: 'negative' });
    expect(calls.some(args => args.includes('remove'))).toBe(false);
    expect(removed).not.toHaveBeenCalled(); expect(existsSync(f.tree)).toBe(true); expect(existsSync(join(f.tree, '.git'))).toBe(true);
    const journal = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
    expect(journal.state).toBe('published_verified'); expect(journal.progress.inFlight).toBeUndefined();
    expect(journal.progress.cleaned.sort()).toEqual(context.record.files.map((file: SnapshotFile) => file.path).sort());
    const { fingerprint, sha256 } = regularBytes(join(f.tree, context.tracked));
    expect(journal.progress.restored).toEqual([{ path: context.tracked, fingerprint, sha256 }]);
    expect(readFileSync(join(f.tree, context.tracked), 'utf8')).toBe('{"base":true}\r\n');
    for (const file of context.payloads.filter(file => file.path !== context.tracked)) expect(existsSync(join(f.tree, file.path))).toBe(false);
  });

  it('rechecks the clean gate after the second asynchronous remote verification', async () => {
    const f = fixture(true), context = await snapshotContext(f, true), file = context.payloads[0].path;
    const verify = vi.fn<NonNullable<RemovalOptions['verifySnapshot']>>(context.callbacks.verifySnapshot);
    const removed = vi.fn(context.callbacks.onSnapshotRemoved), calls: string[][] = [];
    verify.mockImplementationOnce(context.callbacks.verifySnapshot).mockImplementationOnce(async () => {
      const verified = context.callbacks.verifySnapshot();
      await Promise.resolve();
      mkdirSync(dirname(join(f.tree, file)), { recursive: true }); writeFileSync(join(f.tree, file), 'new ignored work'); age(f.tree);
      return verified;
    });
    const result = await execute(f, context, { ...context.callbacks, verifySnapshot: verify, onSnapshotRemoved: removed,
      runProbe: (exe, args, options) => { calls.push(args); return probe(exe, args, options); } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held' });
    expect(verify).toHaveBeenCalledTimes(2); expect(removed).not.toHaveBeenCalled();
    expect(calls.some(args => args.includes('remove'))).toBe(false);
    expect(existsSync(f.tree)).toBe(true); expect(readFileSync(join(f.tree, file), 'utf8')).toBe('new ignored work');
  });

  it('refuses changed raw bytes before touching the copy set even with unchanged status and old mtimes', async () => {
    const f = fixture(), context = await snapshotContext(f);
    writeFileSync(join(f.tree, context.tracked), '{"later":true}\n'); age(f.tree);
    expect(outcome(await execute(f, context, context.callbacks), f.tree)).toMatchObject({ disposition: 'hold', reason: 'Snapshot file bytes changed', mutations: [] });
    expect(readFileSync(join(f.tree, context.tracked), 'utf8')).toBe('{"later":true}\n');
    for (const file of context.payloads.filter(file => file.path !== context.tracked)) expect(readFileSync(join(f.tree, file.path), 'utf8')).toBe(file.bytes);
  });

  it.each(['ignored', 'untracked'])('refuses new %s files after verification', async kind => {
    const f = fixture(), context = await snapshotContext(f), extra = kind === 'ignored' ? '.reproduce-out/deep/extra.json' : 'extra.txt';
    const result = await execute(f, context, { ...context.callbacks, verifySnapshot: () => {
      const verified = context.callbacks.verifySnapshot(); writeFileSync(join(f.tree, extra), 'keep'); age(f.tree); return verified;
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: kind === 'ignored' ? 'Snapshot ignored directory scan unavailable' : 'Status changed', mutations: [] });
    expect(readFileSync(join(f.tree, extra), 'utf8')).toBe('keep'); expect(existsSync(f.tree)).toBe(true);
  });

  it('resumes two cleaned paths including a restored file with fresh mtime, using a new inventory', async () => {
    const f = fixture(), context = await snapshotContext(f), untracked = context.payloads[0].path, mutations: string[] = [];
    unlinkSync(join(f.tree, untracked)); git(f.tree, 'restore', '--source=HEAD', '--staged', '--worktree', '--', context.tracked);
    const { fingerprint, sha256 } = regularBytes(join(f.tree, context.tracked));
    const progress = { cleaned: [untracked, context.tracked], restored: [{ path: context.tracked, fingerprint, sha256 }] };
    expect(markSnapshotProgress(context.journalRoot, { treePath: f.tree, ...progress }).state).toBe('ok');
    context.decision.snapshotRecord.progress = JSON.parse(readFileSync(context.record.journalPath, 'utf8')).progress;
    const fresh = await classify(f); context.snapshot = fresh.snapshot;
    const result = await execute(f, context, { ...context.callbacks, onBeforeMutation: event => { mutations.push(event.kind); } });
    expect(outcome(result, f.tree), JSON.stringify(result)).toMatchObject({ disposition: 'removed' });
    expect(mutations).toEqual(['unlink-snapshot', 'remove', 'prune']);
  });

  it('resumes after every file was cleaned and verifies the remote before removing the clean tree', async () => {
    const f = fixture(), context = await snapshotContext(f);
    const first = await execute(f, context, { ...context.callbacks, onAfterMutation: event => { if (event.kind === 'restore') throw new Error('crash'); } });
    expect(outcome(first, f.tree)).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held' });
    context.decision.snapshotRecord.progress = JSON.parse(readFileSync(context.record.journalPath, 'utf8')).progress;
    context.snapshot = (await classify(f)).snapshot;
    git(context.remote, 'update-ref', '-d', context.record.ref);
    expect(outcome(await execute(f, context, context.callbacks), f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'snapshot-unverified', mutations: [] });
    git(context.remote, 'update-ref', context.record.ref, context.record.commitSha);
    expect(outcome(await execute(f, context, context.callbacks), f.tree)).toMatchObject({ disposition: 'removed' });
  });

  it.each(['fingerprint changed', 'restored evidence missing', 'cleaned path reappeared'])(
    'refuses unsafe resumed progress: %s', async change => {
      const f = fixture(), context = await snapshotContext(f), untracked = context.payloads[0].path;
      unlinkSync(join(f.tree, untracked)); git(f.tree, 'restore', '--source=HEAD', '--staged', '--worktree', '--', context.tracked);
      const { fingerprint, sha256 } = regularBytes(join(f.tree, context.tracked));
      context.decision.snapshotRecord.progress = { cleaned: [untracked, context.tracked], restored: [{ path: context.tracked, fingerprint, sha256 }] };
      if (change === 'fingerprint changed') utimesSync(join(f.tree, context.tracked), old, old);
      if (change === 'restored evidence missing') context.decision.snapshotRecord.progress.restored = [];
      if (change === 'cleaned path reappeared') { writeFileSync(join(f.tree, untracked), 'keep'); age(f.tree); }
      context.snapshot = (await classify(f)).snapshot;
      expect(outcome(await execute(f, context, context.callbacks), f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
      expect(existsSync(join(f.tree, context.payloads[1].path))).toBe(true);
    },
  );

  it('rechecks a fully cleaned tree after the first asynchronous remote verification', async () => {
    const f = fixture(), context = await snapshotContext(f, true), file = context.payloads[0].path;
    unlinkSync(join(f.tree, file)); rmdirSync(dirname(join(f.tree, file))); rmdirSync(join(f.tree, '.reproduce-out'));
    context.decision.snapshotRecord.progress = { cleaned: [file], restored: [] };
    context.snapshot = (await classify(f)).snapshot;
    const result = await execute(f, context, { ...context.callbacks, verifySnapshot: async () => {
      const verified = context.callbacks.verifySnapshot(); mkdirSync(dirname(join(f.tree, file)), { recursive: true }); writeFileSync(join(f.tree, file), 'new ignored work'); age(f.tree); return verified;
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
    expect(readFileSync(join(f.tree, file), 'utf8')).toBe('new ignored work');
  });

  it('refuses owner release and a failed intent write without mutation', async () => {
    const f = fixture(), context = await snapshotContext(f);
    expect(outcome(await execute(f, context, { ...context.callbacks, ownerRelease: { path: f.tree, sessionId: 'owner', homeDirectory: f.home } }), f.tree))
      .toMatchObject({ disposition: 'hold', reasonCode: 'snapshot-owner-release', mutations: [] });
    const result = await execute(f, context, { ...context.callbacks, onSnapshotProgress: () => unknown('write failed') });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
    for (const file of context.payloads) expect(readFileSync(join(f.tree, file.path), 'utf8')).toBe(file.bytes);
    expect(readFileSync(join(f.tree, context.tracked), 'utf8')).toBe('{"modified":true}\n');
  });

  it.each(['untracked', 'ignored', 'modified'])('restarts after a failed post-mutation progress write for %s', async kind => {
    const f = fixture(), context = await snapshotContext(f);
    const file = context.record.files.find((file: SnapshotFile) => file.kind === kind)!;
    const outside = regularBytes(join(f.tree, 'tracked.md'));
    const first = await execute(f, context, { ...context.callbacks, onSnapshotProgress: update => {
      if (!update.inFlight && update.cleaned.includes(file.path)) return unknown('post-mutation write failed');
      return context.callbacks.onSnapshotProgress(update);
    } });
    expect(outcome(first, f.tree)).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held' });
    const durable = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
    expect(durable.progress.inFlight).toEqual({ path: file.path, kind });
    expect(durable.progress.cleaned).not.toContain(file.path);
    if (kind === 'modified') expect(readFileSync(join(f.tree, file.path), 'utf8')).toBe('{"base":true}\n');
    else expect(existsSync(join(f.tree, file.path))).toBe(false);
    expect(regularBytes(join(f.tree, 'tracked.md'))).toEqual(outside);
    context.decision.snapshotRecord = durable;
    context.snapshot = (await classify(f)).snapshot;
    const second = await execute(f, context, { ...context.callbacks, onBeforeMutation: event => {
      if (event.kind === 'remove') expect(regularBytes(join(f.tree, 'tracked.md'))).toEqual(outside);
    } });
    expect(outcome(second, f.tree), JSON.stringify(second)).toMatchObject({ disposition: 'removed' });
    expect(existsSync(f.tree)).toBe(false);
    expect(git(f.primary, 'rev-parse', 'refs/heads/candidate')).toBe(context.record.head);
    const done = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
    expect(done.state).toBe('removed'); expect(done.progress.inFlight).toBeUndefined();
    expect(done.progress.cleaned.sort()).toEqual(context.record.files.map((file: SnapshotFile) => file.path).sort());
    expect(readFileSync(join(f.primary, 'tracked.md'), 'utf8')).toBe('original\n');
  });

  it.each(['untracked', 'ignored', 'modified'] as const)('restarts a crash after intent but before the %s mutation', async kind => {
    // Copy-set order is ignored, untracked, modified: the modified row keeps every file so its
    // intent crash follows already-cleaned files.
    const f = fixture(), context = await snapshotContext(f, kind === 'modified' ? false : kind), file = context.record.files.find((file: SnapshotFile) => file.kind === kind)!;
    const first = await execute(f, context, { ...context.callbacks, onSnapshotProgress: update => {
      const saved = context.callbacks.onSnapshotProgress(update);
      if (update.inFlight?.path === file.path) { expect(saved.state).toBe('ok'); throw new Error('crash after intent'); }
      return saved;
    } });
    expect(outcome(first, f.tree).disposition).toBe('hold');
    expect(readFileSync(join(f.tree, file.path), 'utf8')).toBe(context.payloads.find(entry => entry.path === file.path)!.bytes);
    context.decision.snapshotRecord = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
    expect(context.decision.snapshotRecord.progress.inFlight).toEqual({ path: file.path, kind });
    context.snapshot = (await classify(f)).snapshot;
    const second = await execute(f, context, context.callbacks);
    expect(outcome(second, f.tree), JSON.stringify(second)).toMatchObject({ disposition: 'removed' });
    expect(git(f.primary, 'rev-parse', 'refs/heads/candidate')).toBe(context.record.head);
  });

  it('refuses different bytes in a still-present in-flight untracked file', async () => {
    const f = fixture(), context = await snapshotContext(f), file = context.record.files.find((file: SnapshotFile) => file.kind === 'untracked')!;
    expect(markSnapshotProgress(context.journalRoot, { treePath: f.tree, cleaned: [], restored: [],
      inFlight: { path: file.path, kind: file.kind } }).state).toBe('ok');
    writeFileSync(join(f.tree, file.path), 'new work'); age(f.tree);
    context.decision.snapshotRecord = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
    context.snapshot = (await classify(f)).snapshot;
    expect(outcome(await execute(f, context, context.callbacks), f.tree)).toMatchObject({ disposition: 'hold', mutations: [], reason: 'Snapshot file bytes changed' });
    expect(readFileSync(join(f.tree, file.path), 'utf8')).toBe('new work');
  });

  it.each([
    { autocrlf: false, bytes: '{"base":true}\n\n', clean: true, reason: null },
    { autocrlf: true, bytes: '{"base":true}\r\n\r\n', clean: true, reason: null },
    { autocrlf: true, bytes: '{"base":true}\n\n', clean: true, reason: null },
    { autocrlf: false, bytes: 'different bytes\n', clean: false, reason: 'Snapshot file bytes changed' },
    // Mixed endings normalize to HEAD, but match neither accepted byte form.
    { autocrlf: true, bytes: '{"base":true}\r\n\n', clean: true, reason: 'In-flight restore differs from HEAD' },
  ])('in-flight modified restore acceptance', async ({ autocrlf, bytes, clean, reason }) => {
    const f = fixture(autocrlf), raw = Buffer.from('{"base":true}\n\n'), filtered = Buffer.from('{"base":true}\r\n\r\n');
    expect(git(f.tree, 'config', '--local', '--get', 'core.autocrlf')).toBe(String(autocrlf));
    const context = await snapshotContext(f, 'modified', raw.toString('utf8')), full = join(f.tree, context.tracked);
    expect(blob(f.tree, raw)).toBe(git(f.tree, 'rev-parse', `${context.record.head}:${context.tracked}`));
    const first = await execute(f, context, { ...context.callbacks, onSnapshotProgress: update => {
      if (!update.inFlight && update.cleaned.includes(context.tracked)) return unknown('post-mutation write failed');
      return context.callbacks.onSnapshotProgress(update);
    } });
    expect(outcome(first, f.tree)).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held',
      reason: 'Snapshot progress was not persisted' });
    expect(outcome(first, f.tree).mutations.at(-1)).toMatchObject({ kind: 'restore', file: context.tracked });
    expect(readFileSync(full)).toEqual(autocrlf ? filtered : raw);
    const afterCrash = Buffer.from(bytes);
    if (!readFileSync(full).equals(afterCrash)) {
      writeFileSync(full, afterCrash);
      // Refresh the index's byte-size cache for the intentionally clean forms.
      if (clean) git(f.tree, 'add', '--', context.tracked);
    }
    expect(git(f.tree, 'rev-parse', `:${context.tracked}`)).toBe(blob(f.tree, raw));
    // The dirty row must reach digest verification rather than the activity gate.
    if (!clean) age(f.tree);
    expect(git(f.tree, 'status', '--porcelain=v1', '--', context.tracked)).toBe(clean ? '' : `M ${context.tracked}`);
    const journalBefore = readFileSync(context.record.journalPath);
    context.decision.snapshotRecord = JSON.parse(journalBefore.toString('utf8'));
    expect(context.decision.snapshotRecord.progress.inFlight).toEqual({ path: context.tracked, kind: 'modified' });
    expect(context.decision.snapshotRecord.progress.cleaned).not.toContain(context.tracked);
    if (reason) {
      expect(afterCrash.equals(raw)).toBe(false); expect(afterCrash.equals(filtered)).toBe(false);
      expect(blob(f.tree, afterCrash)).not.toBe(context.record.files.find((file: SnapshotFile) => file.path === context.tracked)!.digest);
    }
    context.snapshot = (await classify(f)).snapshot;
    const progress = vi.fn(context.callbacks.onSnapshotProgress), mutation = vi.fn();
    const second = await execute(f, context, { ...context.callbacks, onSnapshotProgress: progress, onBeforeMutation: mutation });
    if (reason) {
      expect(outcome(second, f.tree)).toMatchObject({ disposition: 'hold', mutations: [], reason });
      expect(progress).not.toHaveBeenCalled(); expect(mutation).not.toHaveBeenCalled();
      expect(readFileSync(full)).toEqual(afterCrash);
      expect(readFileSync(context.record.journalPath)).toEqual(journalBefore);
    } else {
      expect(outcome(second, f.tree), JSON.stringify(second)).toMatchObject({ disposition: 'removed' });
      expect(mutation.mock.calls.map(([event]) => event.kind)).toEqual(['remove', 'prune']);
      expect(existsSync(f.tree)).toBe(false);
      const done = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
      expect(done.state).toBe('removed'); expect(done.progress.inFlight).toBeUndefined();
      expect(done.progress.cleaned).toContain(context.tracked);
    }
    expect(git(f.primary, 'rev-parse', 'refs/heads/candidate')).toBe(context.record.head);
  });

  it('leaves an empty parent after an lstat failure and completes removal', async () => {
    const f = fixture(), context = await snapshotContext(f, true), file = context.payloads[0].path;
    const result = await execute(f, context, { ...context.callbacks, onSnapshotProgress: update => {
      const saved = context.callbacks.onSnapshotProgress(update);
      if (update.cleaned.includes(file)) {
        expect(saved.state).toBe('ok');
        vi.mocked(lstatSync).mockImplementationOnce(() => { throw Object.assign(new Error('lstat busy'), { code: 'EBUSY' }); });
      }
      return saved;
    } });
    expect(outcome(result, f.tree), JSON.stringify(result)).toMatchObject({ disposition: 'removed', notes: [expect.stringContaining('lstat busy')] });
    expect(JSON.parse(readFileSync(context.record.journalPath, 'utf8')).state).toBe('removed');
  });

  it('holds new ignored bytes left behind by failed parent cleanup', async () => {
    const f = fixture(), context = await snapshotContext(f, true), extra = join(f.tree, '.reproduce-out/deep/new.json');
    vi.mocked(rmdirSync).mockImplementationOnce(() => {
      writeFileSync(extra, 'keep');
      throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' });
    });
    const result = await execute(f, context, context.callbacks);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held', notes: [expect.stringContaining('directory not empty')] });
    expect(readFileSync(extra, 'utf8')).toBe('keep');
    const durable = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
    expect(durable.progress).toEqual({ cleaned: [context.payloads[0].path], restored: [] });
    expect(durable.state).toBe('published_verified');
  });

  it.each(['EBUSY', 'EPERM'])('persists unlink progress before non-fatal empty-parent failure %s', async code => {
    const f = fixture(), context = await snapshotContext(f, true), file = context.payloads[0].path;
    vi.mocked(rmdirSync).mockImplementationOnce(() => {
      const durable = JSON.parse(readFileSync(context.record.journalPath, 'utf8'));
      expect(durable.progress).toEqual({ cleaned: [file], restored: [] });
      expect(existsSync(join(f.tree, file))).toBe(false);
      throw Object.assign(new Error('directory busy'), { code });
    });
    const result = await execute(f, context, { ...context.callbacks, onBeforeMutation: event => {
      if (event.kind === 'remove') {
        expect(existsSync(dirname(join(f.tree, file)))).toBe(true);
        expect(readdirSync(dirname(join(f.tree, file)))).toEqual([]);
      }
    } });
    expect(outcome(result, f.tree), JSON.stringify(result)).toMatchObject({ disposition: 'removed', notes: [expect.stringContaining('directory busy')] });
    expect(JSON.parse(readFileSync(context.record.journalPath, 'utf8')).state).toBe('removed');
  });

});

describe('Next build self-link U3 removal', { timeout: 60_000 }, () => {
  it.skipIf(process.platform !== 'win32').each(['.next/node_modules', '.next/standalone/.next/node_modules', '.next/dev/node_modules'])(
    'U3-T1 unlinks every %s junction before Git and preserves each target', async shape => {
      const f = fixture(), links = [buildSelfLink(f, shape), buildSelfLink(f, shape, 'junction', 'second-hash')];
      const context = await classify(f), guards: string[] = [], helpers: string[][] = [];
      expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition).toBe('remove');
      const result = await execute(f, context, {
        beforeMutationGuard: event => { guards.push(event.kind); return ok(null); },
        runProbe: (executable, args, options) => {
          if (args.includes(helper)) {
            helpers.push(args);
            expect(args).toContain('-ExpectedLinkType'); expect(args).toContain('-ExpectedTarget');
          }
          if (args.includes('worktree') && args.includes('remove')) for (const { link } of links) expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
          return probe(executable, args, options);
        },
        onAfterMutation: event => {
          if (event.kind !== 'unlink-self-links') return;
          const unlinked = links.find(({ link }) => link === event.file)!;
          expect(lstatSync(unlinked.link, { throwIfNoEntry: false })).toBeUndefined();
          expect(readFileSync(join(unlinked.target, 'keep'), 'utf8')).toBe('safe');
        },
      });
      expect(outcome(result, f.tree), JSON.stringify(result)).toMatchObject({ disposition: 'removed' });
      expect(outcome(result, f.tree).mutations.map(event => event.kind)).toEqual(['unlink-self-links', 'unlink-self-links', 'remove-started', 'deregister']);
      expect(guards).toEqual(['unlink-self-links', 'remove']); expect(helpers).toHaveLength(2);
    },
  );
  it.skipIf(process.platform !== 'win32')('U3-T6 refuses a target swapped outside the tree after the unlink hook', async () => {
    const f = fixture(), self = buildSelfLink(f), context = await classify(f), outside = shared(f), calls: string[][] = [];
    const hook = vi.fn((event: { kind: string }) => {
      if (event.kind === 'unlink-self-links') { rmdirSync(self.link); symlinkSync(outside, self.link, 'junction'); }
    });
    const result = await execute(f, context, { onBeforeMutation: hook, runProbe: (executable, args, options) => {
      if (args.includes(helper)) calls.push(args); return probe(executable, args, options);
    } });
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unlink-self-links' }));
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Self-link changed', mutations: [] });
    expect(calls).toEqual([]); expect(readFileSync(join(outside, 'package', 'index.js'), 'utf8')).toBe('safe');
  });
  it.skipIf(process.platform !== 'win32')('U3-T6 re-proves every self-link before unlinking when the hook retargets the second', async () => {
    const f = fixture(), links = [buildSelfLink(f), buildSelfLink(f, '.next/node_modules', 'junction', 'second-hash')];
    const context = await classify(f), outside = shared(f), helpers: string[][] = [];
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition).toBe('remove');
    const hook = vi.fn((event: { kind: string }) => {
      if (event.kind !== 'unlink-self-links') return;
      rmdirSync(links[1].link); symlinkSync(outside, links[1].link, 'junction');
    });
    const result = await execute(f, context, { onBeforeMutation: hook, runProbe: (executable, args, options) => {
      if (args.includes(helper)) helpers.push(args); return probe(executable, args, options);
    } });
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ kind: 'unlink-self-links', files: links.map(({ link }) => link) }));
    expect.soft(helpers).toEqual([]);
    expect.soft(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Self-link changed', mutations: [], stopReason: null });
    for (const { link, target } of links) {
      expect.soft(lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink()).toBe(true);
      expect(readFileSync(join(target, 'keep'), 'utf8')).toBe('safe');
    }
    expect(readFileSync(join(outside, 'package', 'index.js'), 'utf8')).toBe('safe');
    expect(existsSync(f.tree)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('U3-T6 calls the after hook when a self-link helper reports failure after unlinking', async () => {
    const f = fixture(), self = buildSelfLink(f), context = await classify(f), after = vi.fn();
    const result = await execute(f, context, { onAfterMutation: after, runProbe: (executable, args, options) => {
      const checked = probe(executable, args, options);
      if (!args.includes(helper)) return checked;
      expect(checked.state).toBe('ok');
      return unknown('Injected helper failure after unlink');
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Self-link unlink unavailable',
      stopReason: 'mutated-then-held', mutations: [{ kind: 'unlink-self-links', file: self.link }] });
    expect(after).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'unlink-self-links', file: self.link }));
    expect(lstatSync(self.link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readFileSync(join(self.target, 'keep'), 'utf8')).toBe('safe');
    expect(existsSync(f.tree)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('U3-T7 owner release removes a build self-link tree', async () => {
    const f = fixture(); buildSelfLink(f);
    const sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'owner.jsonl'), JSON.stringify({ type: 'session_meta', timestamp: new Date().toISOString(), payload: { id: 'owner', cwd: f.tree } }) + '\n');
    utimesSync(join(f.tree, 'tracked.md'), new Date(), new Date());
    const context = await classify(f), ownerRelease = { path: f.tree, sessionId: 'owner', homeDirectory: f.home };
    const planned = await planWorktrees(context.snapshot, { prSnapshot: ok([]), ownerRelease });
    if (planned.state !== 'ok') throw new Error('Owner plan failed'); context.plan = planned.value;
    expect(outcome(await execute(f, context, { ownerRelease }), f.tree).disposition).toBe('removed');
  });
  it.skipIf(process.platform !== 'win32').each([{ id: 8, mode: 'injected' }, { id: 9, mode: 'recreated' }])('U3-T$id real complete scan refuses an inventory-hidden $mode link', async ({ mode }) => {
    const f = fixture(), self = mode === 'recreated' ? buildSelfLink(f) : null, context = await classify(f);
    const baseline = context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)!;
    const links = baseline.links;
    if (links.state !== 'ok') throw new Error('Links unavailable');
    let unlinked = false;
    if (!self) {
      mkdirSync(join(f.tree, '.next')); symlinkSync(f.primary, join(f.tree, '.next', 'hidden'), 'junction');
    }
    const realInventory = vi.mocked(candidateInventory).getMockImplementation()!;
    vi.mocked(candidateInventory).mockImplementation((): ReturnType<typeof candidateInventory> => {
      if (self && unlinked && !lstatSync(self.link, { throwIfNoEntry: false })) symlinkSync(self.target, self.link, 'junction');
      return { ...ok({ ...context.snapshot, skippedStaleRegistrations: [], worktrees: [{ ...baseline,
        links: unlinked ? ok({ ...links.value, entries: [] }) : links }] }),
        registrationDelta: { added: [], vanished: [], changed: [] } };
    });
    const gitRemove = vi.fn(() => unknown('Git must not run'));
    try {
      const result = await execute(f, context, {
        onAfterMutation: event => {
          if (event.kind === 'unlink-self-links' && self) unlinked = true;
        },
        runProbe: (executable, args, options) => args.includes('worktree') && args.includes('remove') ? gitRemove() : probe(executable, args, options),
      });
      expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Pre-removal link scan unavailable' });
      if (self) expect(outcome(result, f.tree).mutations).toEqual([expect.objectContaining({ kind: 'unlink-self-links' })]);
      expect(gitRemove).not.toHaveBeenCalled();
    } finally { vi.mocked(candidateInventory).mockImplementation(realInventory); }
  });
  it.skipIf(process.platform !== 'win32').each(['guard', 'hook'].flatMap(timing => ['self', 'dangling'].map(kind => ({ id: timing === 'guard' ? 11 : 12, timing, kind }))))(
    'U3-T$id pre-Git absence refuses a $kind path recreated by the $timing', async ({ timing, kind }) => {
      const f = fixture(), entry = kind === 'self' ? buildSelfLink(f) : danglingChain(f), context = await classify(f);
      const recreate = (event: { kind: string }) => { if (event.kind === 'remove') symlinkSync(entry.target, entry.link, 'junction'); };
      const gitRemove = vi.fn(() => unknown('Git must not run'));
      const result = await execute(f, context, {
        beforeMutationGuard: event => { if (timing === 'guard') recreate(event); return ok(null); },
        onBeforeMutation: event => { if (timing === 'hook') recreate(event); },
        runProbe: (executable, args, options) => args.includes('worktree') && args.includes('remove') ? gitRemove() : probe(executable, args, options),
      });
      expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Unlinked path reappeared before Git', stopReason: 'mutated-then-held' });
      expect(lstatSync(entry.link).isSymbolicLink()).toBe(true); expect(gitRemove).not.toHaveBeenCalled();
    },
  );
  it.skipIf(process.platform !== 'win32')('U3-T13 unlinks a standalone directory symbolic link and preserves its target', async test => {
    const f = fixture(); let self: ReturnType<typeof buildSelfLink>;
    try { self = buildSelfLink(f, '.next/standalone/.next/node_modules', 'dir'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') test.skip('Windows directory symlink privilege unavailable (EPERM)'); throw error; }
    const context = await classify(f);
    const result = await execute(f, context, { onAfterMutation: event => {
      if (event.kind === 'unlink-self-links') expect(readFileSync(join(self.target, 'keep'), 'utf8')).toBe('safe');
    } });
    expect(outcome(result, f.tree).disposition).toBe('removed');
    expect(outcome(result, f.tree).mutations[0]).toMatchObject({ kind: 'unlink-self-links', file: self.link });
  });
  it.skipIf(process.platform !== 'win32').for(['file', 'real', 'dangling-symlink', 'live-symlink', 'wrong-type', 'wrong-target', 'missing-type', 'missing-target'])(
    'U3-T14 helper refuses %s without deleting the entry or target', (kind, test) => {
      const f = fixture(), target = join(f.root, 'target'), link = join(f.tree, '.next', 'entry');
      mkdirSync(join(f.tree, '.next'));
      if (kind === 'file') writeFileSync(target, 'safe'); else { mkdirSync(target); writeFileSync(join(target, 'keep'), 'safe'); }
      try {
        if (kind === 'real') { mkdirSync(link); writeFileSync(join(link, 'keep'), 'safe'); }
        else symlinkSync(target, link, kind === 'file' ? 'file' : kind.endsWith('symlink') ? 'dir' : 'junction');
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') test.skip('Windows symlink privilege unavailable (EPERM)'); throw error; }
      if (kind === 'dangling-symlink') { unlinkSync(join(target, 'keep')); rmdirSync(target); }
      const type = kind === 'file' || kind.endsWith('symlink') ? 'SymbolicLink' : 'Junction';
      const args = ['-NoProfile', '-NonInteractive', '-File', helper, '-EventKind', kind.endsWith('symlink') ? 'unlink-junction' : 'unlink-self-links'];
      if (kind !== 'missing-type') args.push('-ExpectedLinkType', kind === 'wrong-type' ? 'SymbolicLink' : type);
      if (kind !== 'missing-target') args.push('-ExpectedTarget', kind === 'wrong-target' ? join(f.root, 'wrong') : kind === 'real' ? target : readlinkSync(link));
      args.push(link);
      try {
        const result = spawnSync(powershell, args, { encoding: 'utf8', windowsHide: true });
        expect(result.status).not.toBe(0); expect(lstatSync(link)).toBeDefined();
        expect(result.stderr).toMatch(kind === 'missing-type' || kind === 'missing-target' ? /Expected LinkType and raw target are required/ :
          kind === 'wrong-type' || kind === 'wrong-target' ? /LinkType or raw target changed/ : /exact entry must be a directory junction/);
        if (kind === 'dangling-symlink') expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
        else expect(readFileSync(kind === 'file' ? target : join(target, 'keep'), 'utf8')).toBe('safe');
        if (kind === 'real') expect(readFileSync(join(link, 'keep'), 'utf8')).toBe('safe');
      } finally { if (kind === 'file') unlinkSync(link); }
    },
  );
});

describe('dangling junction U2', { timeout: 30_000 }, () => {
  it.skipIf(process.platform !== 'win32')('U2-T1 unlinks only the candidate junction through real rechecks and scans before removal', async () => {
    const f = fixture(), chain = danglingChain(f), context = await classify(f);
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)).toMatchObject({ disposition: 'remove' });
    const scans: string[] = [], helpers: string[][] = [], guards: string[] = [];
    const result = await execute(f, context, {
      beforeMutationGuard: ({ kind }) => { guards.push(kind); return ok(null); },
      runProbe: (executable, args, options) => {
        if (options?.env?.WORKTREE_CLEANUP_SCAN_ROOT) scans.push(options.env.WORKTREE_CLEANUP_ALLOW_JUNCTION!);
        if (args.includes(helper)) helpers.push(args);
        return probe(executable, args, options);
      },
      onAfterMutation: ({ kind }) => {
        if (kind === 'unlink-junction') {
          expect(lstatSync(chain.link, { throwIfNoEntry: false })).toBeUndefined();
          expect(lstatSync(chain.middle).isSymbolicLink()).toBe(true);
        }
      },
    });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'removed' });
    expect(outcome(result, f.tree).mutations.map(event => event.kind)).toEqual(['unlink-junction', 'remove-started', 'deregister']);
    expect(guards).toEqual(['unlink-junction', 'remove']);
    expect(scans).toEqual(['1', '1', '0']);
    expect(helpers).toHaveLength(1); expect(helpers[0].at(-1)).toBe(chain.link);
    expect(lstatSync(chain.middle).isSymbolicLink()).toBe(true); expect(existsSync(f.tree)).toBe(false);
  });
  it.skipIf(process.platform !== 'win32')('U2-T2 keeps a chain with a live directory held and never invokes the helper', async () => {
    const f = fixture(), chain = danglingChain(f, true), context = await classify(f), helpers: string[][] = [];
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)).toMatchObject({ disposition: 'hold', reason: 'links' });
    const result = await execute(f, context, { runProbe: (executable, args, options) => {
      if (args.includes(helper)) helpers.push(args);
      return probe(executable, args, options);
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
    expect(helpers).toEqual([]); expect(lstatSync(chain.target).isDirectory()).toBe(true);
  });
  it.skipIf(process.platform !== 'win32').each(['before-recheck', 'after-hook', 'changed-missing-hop'])(
    'U2-T5 refuses a recreated or changed hop with no mutation (%s)', async timing => {
      const f = fixture(), chain = danglingChain(f), context = await classify(f), helpers: string[][] = [];
      expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)).toMatchObject({ disposition: 'remove' });
      const mutate = () => {
        if (timing === 'changed-missing-hop') {
          rmdirSync(chain.middle); symlinkSync(join(f.root, 'different-missing'), chain.middle, 'junction');
        } else mkdirSync(chain.target, { recursive: true });
      };
      if (timing === 'before-recheck') mutate();
      let hookRan = false;
      const result = await execute(f, context, {
        onBeforeMutation: ({ kind }) => { if (kind === 'unlink-junction') { hookRan = true; mutate(); } },
        runProbe: (executable, args, options) => {
          if (args.includes(helper)) helpers.push(args);
          return probe(executable, args, options);
        },
      });
      expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
      expect(hookRan).toBe(timing !== 'before-recheck'); expect(helpers).toEqual([]);
      expect(lstatSync(chain.link).isSymbolicLink()).toBe(true); expect(existsSync(f.tree)).toBe(true);
    },
  );
  it.skipIf(process.platform !== 'win32')('U2-T10 refuses when the hook swaps the dangling junction for a live junction', async () => {
    const f = fixture(), chain = danglingChain(f), context = await classify(f), helpers: string[][] = [];
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)).toMatchObject({ disposition: 'remove' });
    const live = join(f.root, 'live-modules');
    mkdirSync(live); writeFileSync(join(live, 'keep.txt'), 'keep');
    let hookRan = false;
    const result = await execute(f, context, {
      onBeforeMutation: ({ kind }) => {
        if (kind !== 'unlink-junction') return;
        hookRan = true; rmdirSync(chain.link); symlinkSync(live, chain.link, 'junction');
      },
      runProbe: (executable, args, options) => {
        if (args.includes(helper)) helpers.push(args);
        return probe(executable, args, options);
      },
    });
    expect(hookRan).toBe(true);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
    expect(helpers).toEqual([]);
    expect(lstatSync(chain.link).isSymbolicLink()).toBe(true); expect(existsSync(join(chain.link, 'keep.txt'))).toBe(true);
    expect(existsSync(join(live, 'keep.txt'))).toBe(true); expect(existsSync(f.tree)).toBe(true);
  });
});
function targetSnapshot(path: string) {
  let count = 0;
  function walk(dir: string) { for (const name of readdirSync(dir)) { count++; const entry = join(dir, name); const stat = lstatSync(entry); if (stat.isDirectory() && !stat.isSymbolicLink()) walk(entry); } }
  walk(path);
  return { count, lock: hash(readFileSync(join(path, '.package-lock.json'))) };
}
const dirtyRefusal = 'fatal: candidate contains modified or untracked files, use --force to delete it';
function refusedRemove(stderr = dirtyRefusal) { return { ...unknown('Probe failed (exit 128, signal null)', stderr), exitCode: 128 }; }
const interruptedRemove = (fields: object) => ({ ...refusedRemove(), ...fields });
type RefusalCase = {
  name: string; probeResult: ReturnType<typeof unknown>;
  proof: 'passes' | 'fails' | 'errors' | 'half-removed' | 'not-attempted'; continues: boolean;
};
const refusalCases: RefusalCase[] = [
  ...[
    'cannot remove a locked working tree', 'lock reason', 'is a main working tree', 'is not a working tree',
    'validation failed, cannot remove working tree', 'contains modified or untracked files, use --force to delete it',
    'working trees containing submodules cannot be moved or removed',
  ].map(message => ({ name: `normal refusal: ${message}`, probeResult: refusedRemove(`FATAL: ${message.toUpperCase()}\n${'detail '.repeat(50)}`),
    proof: 'passes' as const, continues: true })),
  { name: 'normal known refusal, changed inventory', probeResult: refusedRemove(), proof: 'fails', continues: false },
  { name: 'normal known refusal, proof error', probeResult: refusedRemove(), proof: 'errors', continues: false },
  { name: 'normal known refusal, missing .git', probeResult: refusedRemove(), proof: 'half-removed', continues: false },
  { name: 'normal unknown failure, unchanged inventory', probeResult: refusedRemove('fatal: deletion failed'), proof: 'not-attempted', continues: false },
  { name: 'normal unknown failure, proof would error', probeResult: refusedRemove('fatal: deletion failed'), proof: 'not-attempted', continues: false },
  { name: 'normal failure, missing stderr', probeResult: interruptedRemove({ stderr: undefined }), proof: 'not-attempted', continues: false },
  { name: 'timeout with refusal stderr', probeResult: interruptedRemove({ timedOut: true }), proof: 'not-attempted', continues: false },
  { name: 'signal with refusal stderr', probeResult: interruptedRemove({ signal: 'SIGTERM' }), proof: 'not-attempted', continues: false },
  { name: 'killed with refusal stderr', probeResult: interruptedRemove({ killed: true }), proof: 'not-attempted', continues: false },
  { name: 'spawn error with refusal stderr', probeResult: interruptedRemove({ error: new Error('spawn failed') }), proof: 'not-attempted', continues: false },
  { name: 'spawnError with refusal stderr', probeResult: interruptedRemove({ spawnError: new Error('spawn failed') }), proof: 'not-attempted', continues: false },
  { name: 'probe timeout envelope', probeResult: unknown('spawnSync git ETIMEDOUT', dirtyRefusal), proof: 'not-attempted', continues: false },
  { name: 'probe signal envelope', probeResult: unknown('Probe failed (exit null, signal SIGTERM)', dirtyRefusal), proof: 'not-attempted', continues: false },
  { name: 'probe spawn-error envelope with exit code', probeResult: { ...unknown('spawnSync git ENOBUFS', dirtyRefusal), exitCode: 128 }, proof: 'not-attempted', continues: false },
  { name: 'missing exit code', probeResult: interruptedRemove({ exitCode: undefined }), proof: 'not-attempted', continues: false },
  { name: 'unknown exit code', probeResult: interruptedRemove({ exitCode: null }), proof: 'not-attempted', continues: false },
  { name: 'unreadable result', probeResult: undefined as unknown as ReturnType<typeof unknown>, proof: 'not-attempted', continues: false },
];

describe('owner release removal (temp repositories only)', { timeout: 60_000 }, () => {
  function transcript(f: Fixture, sessionId = 'owner', text?: string) {
    const sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, sessionId + '.jsonl'), text ?? JSON.stringify({ type: 'session_meta',
      timestamp: new Date().toISOString(), payload: { id: sessionId, cwd: f.tree } }) + '\n');
  }
  async function ownerContext(f: Fixture) {
    transcript(f); utimesSync(join(f.tree, 'tracked.md'), new Date(), new Date());
    const context = await classify(f);
    const ownerRelease = { path: f.tree, sessionId: 'owner', homeDirectory: f.home };
    const planned = await planWorktrees(context.snapshot, { prSnapshot: ok([]), ownerRelease });
    if (planned.state !== 'ok') throw new Error('Owner plan failed');
    context.plan = planned.value;
    expect(context.plan.worktrees.find(t => resolve(t.path) === f.tree)?.disposition).toMatch(/^remove/);
    return { context, ownerRelease };
  }
  it('removes recent owner activity, retains the branch, and never guards prune', async () => {
    const f = fixture(), { context, ownerRelease } = await ownerContext(f), guards: string[] = [];
    const result = await execute(f, context, { ownerRelease, beforeMutationGuard: event => { guards.push(event.kind); return ok(true); } });
    expect(outcome(result, f.tree).disposition).toBe('removed');
    expect(guards).toEqual(['remove']); expect(git(f.primary, 'branch', '--list', 'candidate')).toContain('candidate');
  });
  it.each(['lease', 'lease-unknown', 'foreign', 'malformed', 'head-changed'])('refuses %s arriving after owner classification', async change => {
    const f = fixture(), { context, ownerRelease } = await ownerContext(f), guard = vi.fn(() => ok(true));
    if (change.startsWith('lease')) {
      const job = join(f.home, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
      writeFileSync(join(job, 'manifest.json'), change === 'lease-unknown' ? '{' : JSON.stringify({ id: 'job', cwd: f.tree, pid: process.pid, started_at: new Date().toISOString() }));
    } else if (change === 'foreign') transcript(f, 'foreign');
    else if (change === 'malformed') transcript(f, 'bad', '{\n');
    else git(f.tree, 'commit', '--allow-empty', '-m', 'advanced');
    const result = outcome(await execute(f, context, { ownerRelease, beforeMutationGuard: guard }), f.tree);
    expect(result).toMatchObject({ disposition: 'hold', mutations: [], reasonCode: change === 'foreign' ? 'foreign-session-recent' : change === 'malformed' ? 'transcript-unreadable' : change });
    expect(guard).not.toHaveBeenCalled(); expect(existsSync(f.tree)).toBe(true);
  });
  it.each(['lease', 'incomplete', 'foreign', 'unnamed'])('refuses bad %s evidence at the classification gate even with a negative live rollup', async change => {
    const f = fixture(), { context, ownerRelease } = await ownerContext(f);
    const baseline = context.snapshot.worktrees.find(t => resolve(t.path) === f.tree)!;
    Object.assign(baseline.activity, { live: { state: 'negative' } });
    if (change === 'lease') Object.assign(baseline.activity, { lease: ok(true) });
    if (change === 'incomplete') baseline.activity.transcript.attributed.complete = false;
    if (change === 'foreign') baseline.activity.transcript.attributed.mentions[0].sessionId = 'foreign';
    expect(outcome(await execute(f, context, { ownerRelease: change === 'unnamed' ? { ...ownerRelease, path: f.primary } : ownerRelease }), f.tree))
      .toMatchObject({ disposition: 'hold', mutations: [] });
  });
  it('does not accept an owner rescue decision or clean up its files', async () => {
    const f = fixture(), context = await rescue(f), ownerRelease = { path: f.tree, sessionId: 'owner', homeDirectory: f.home };
    const result = outcome(await execute(f, context, { ownerRelease, published: context.published }), f.tree);
    expect(result).toMatchObject({ disposition: 'hold', reasonCode: 'dirty', mutations: [] });
    expect(readFileSync(join(f.tree, 'tracked.md'), 'utf8')).toBe('edited\n');
    expect(existsSync(join(f.tree, 'new.md'))).toBe(true);
  });
  it.each(['local', 'remote', 'tag'])('removes a detached HEAD contained by a %s ref and keeps that ref', async kind => {
    const f = fixture(); git(f.tree, 'commit', '--allow-empty', '-m', 'unmerged');
    const head = git(f.tree, 'rev-parse', 'HEAD'), ref = kind === 'local' ? 'refs/heads/candidate' : kind === 'remote' ? 'refs/remotes/origin/review' : 'refs/tags/review';
    git(f.tree, 'checkout', '--detach');
    if (kind !== 'local') { git(f.primary, 'update-ref', ref, head); git(f.primary, 'branch', '-D', 'candidate'); }
    const { context, ownerRelease } = await ownerContext(f);
    expect(context.plan.worktrees.find(t => resolve(t.path) === f.tree)?.disposition).toBe('remove');
    expect(outcome(await execute(f, context, { ownerRelease }), f.tree).disposition).toBe('removed');
    expect(git(f.primary, 'rev-parse', ref)).toBe(head);
  });
  it('rechecks detached reachability if its last containing ref disappears', async () => {
    const f = fixture(); git(f.tree, 'commit', '--allow-empty', '-m', 'unmerged'); git(f.tree, 'checkout', '--detach');
    const { context, ownerRelease } = await ownerContext(f); git(f.primary, 'branch', '-D', 'candidate');
    expect(outcome(await execute(f, context, { ownerRelease }), f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'unmerged-detached', mutations: [] });
  });
  it.each(['refuse', 'unknown', 'throw', 'invalid'])('halts further candidates when the mutation guard returns %s', async mode => {
    const f = fixture(), second = f.add('second'), context = await classify(f), events: string[] = [];
    const beforeMutationGuard = vi.fn(() => {
      if (mode === 'throw') throw new Error('Guard unavailable');
      if (mode === 'invalid') return undefined as unknown as object;
      return { state: mode === 'refuse' ? 'negative' : 'unknown', reasonCode: 'open-pr', reason: 'Fresh PR check refused' };
    });
    const result = await execute(f, context, { beforeMutationGuard, onBeforeMutation: e => { events.push(e.kind); } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', mutations: [], reasonCode: ['refuse', 'unknown'].includes(mode) ? 'open-pr' : 'mutation-guard' });
    expect(result.halted).toBe(true); expect(outcome(result, second).disposition).toBe('pending');
    expect(beforeMutationGuard).toHaveBeenCalledOnce(); expect(events).toEqual([]);
    expect(existsSync(f.tree) && existsSync(second)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32').each(['allow', 'unlink-junction', 'remove'])('guards owner junction mutations (%s) and preserves target packages', async refusal => {
    const f = fixture(), target = shared(f), bytes = targetSnapshot(target);
    symlinkSync(target, join(f.tree, 'node_modules'), 'junction');
    const { context, ownerRelease } = await ownerContext(f), guards: string[] = [], mutations: string[] = [];
    const result = await execute(f, context, { ownerRelease,
      beforeMutationGuard: e => { guards.push(e.kind); return e.kind === refusal ? { state: 'negative', reasonCode: 'in-use' } : ok(true); },
      onAfterMutation: e => { mutations.push(e.kind); },
    });
    expect(targetSnapshot(target)).toEqual(bytes);
    expect(guards).toEqual(refusal === 'unlink-junction' ? ['unlink-junction'] : ['unlink-junction', 'remove']);
    if (refusal === 'allow') {
      expect(outcome(result, f.tree).disposition).toBe('removed'); expect(mutations).toEqual(['unlink-junction', 'remove', 'prune']);
    } else {
      expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'in-use' });
      expect(result.halted).toBe(true); expect(existsSync(f.tree)).toBe(true);
      expect(mutations).toEqual(refusal === 'remove' ? ['unlink-junction'] : []);
      expect(existsSync(join(f.tree, 'node_modules'))).toBe(refusal === 'unlink-junction');
    }
  });
});

describe('U5 removal fixtures (temp repositories only)', { timeout: 30_000 }, () => {
  it.each(refusalCases)('U2 pre-deletion refusal decision table: $name', async row => {
    const f = fixture(), second = f.add('second');
    mkdirSync(join(f.tree, 'node_modules'));
    writeFileSync(join(f.tree, 'node_modules', '.package-lock.json'), '{"packages":{}}');
    writeFileSync(join(f.tree, 'node_modules', 'first.js'), 'first');
    writeFileSync(join(f.tree, 'node_modules', 'second.js'), 'second');
    const context = await classify(f);
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition).toBe('remove');
    let failed = false, postFailureProbes = 0;
    const result = await execute(f, context, { runProbe: (exe, args, options) => {
      if (args.includes('remove') && args.includes(f.tree.replaceAll('\\', '/'))) {
        failed = true;
        if (row.proof === 'fails') unlinkSync(join(f.tree, 'tracked.md'));
        if (row.proof === 'half-removed') unlinkSync(join(f.tree, '.git'));
        // These bytes are invisible to the compared inventory fields. A killed
        // removal must stop even when its secondary intact checks would pass.
        if (row.name === 'signal with refusal stderr') unlinkSync(join(f.tree, 'node_modules', 'first.js'));
        return row.probeResult;
      }
      if (failed) {
        postFailureProbes++;
        if (row.proof === 'errors' || row.name === 'normal unknown failure, proof would error') throw new Error('Intact proof unavailable');
      }
      return probe(exe, args, options);
    } });
    const first = outcome(result, f.tree);
    expect(failed, JSON.stringify(first)).toBe(true);
    expect(first.disposition).toBe('hold');
    expect(first.reasonCode).toBe(row.continues ? 'git-refused-intact' : undefined);
    expect(first.mutations).toEqual(row.continues ? [] : [{ kind: 'remove-started', path: f.tree.replaceAll('\\', '/') }]);
    expect(first.stopReason).toBe(row.continues ? null : row.proof === 'half-removed' ? 'half-removed' : 'mutated-then-held');
    expect(result.halted).toBe(!row.continues);
    expect(outcome(result, second).disposition).toBe(row.continues ? 'removed' : 'pending');
    expect(existsSync(second)).toBe(!row.continues);
    if (row.continues) {
      const excerpt = row.probeResult.stderr.replace(/\s+/g, ' ').trim().slice(0, 200);
      expect(excerpt).toHaveLength(200);
      expect(first.reason).toBe('Git refused removal before deletion; intact checks passed: ' + excerpt);
    }
    if (row.proof === 'not-attempted') expect(postFailureProbes).toBe(0);
    else if (row.proof !== 'half-removed') expect(postFailureProbes).toBeGreaterThan(0);
  });
  it.each(['added', 'vanished', 'changed'] as const)('U1 unrelated registration %s after removal defers prune without stopping', async change => {
    const f = fixture(), other = change === 'added' ? join(f.root, 'other') : f.add('other'), context = await classify(f);
    context.plan.worktrees = context.plan.worktrees.filter(tree => resolve(tree.path) === f.tree);
    let previews = 0, prunes = 0;
    const result = await execute(f, context, {
      onAfterMutation: ({ kind }) => {
        if (kind !== 'remove') return;
        if (change === 'added') f.add('other');
        if (change === 'vanished') git(f.primary, 'worktree', 'remove', other);
        if (change === 'changed') git(other, 'commit', '--allow-empty', '-m', 'concurrent commit');
      },
      runProbe: (exe, args, options) => {
        if (args.includes('--dry-run')) previews++;
        if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
        return probe(exe, args, options);
      },
    });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'removed-prune-deferred', stopReason: null,
      registrationDelta: { added: [], vanished: [], changed: [], [change]: [expect.objectContaining({ path: other.replaceAll('\\', '/') })] } });
    expect(result.halted).toBe(false); expect(existsSync(f.tree)).toBe(false);
    expect(prunes).toBe(0); expect(previews).toBe(0);
  });
  it('U1 candidate re-registered after removal still stops before prune', async () => {
    const f = fixture(), context = await classify(f); let prunes = 0;
    const result = await execute(f, context, {
      onAfterMutation: ({ kind }) => { if (kind === 'remove') git(f.primary, 'worktree', 'add', f.tree, 'candidate'); },
      runProbe: (exe, args, options) => {
        if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
        return probe(exe, args, options);
      },
    });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'pending', stopReason: 'prune-unknown' });
    expect(result.halted).toBe(true); expect(existsSync(f.tree)).toBe(true); expect(prunes).toBe(0);
  });
  it('U1 candidate admin directory reused at a different path stops before prune', async () => {
    const f = fixture(), context = await classify(f), replacement = join(f.root, 'relocated', 'candidate');
    const original = context.snapshot.registrationKeys.find(entry => resolve(entry.path) === f.tree)!;
    mkdirSync(join(f.root, 'relocated'));
    let previews = 0, prunes = 0;
    const result = await execute(f, context, {
      onAfterMutation: ({ kind }) => {
        if (kind !== 'remove') return;
        // Git names the admin directory from the target basename, so a different
        // parent with the same basename reuses the removed candidate's admin name.
        f.add('replacement', replacement);
        expect(resolve(git(replacement, 'rev-parse', '--git-dir'))).toBe(resolve(original.adminPath));
      },
      runProbe: (exe, args, options) => {
        if (args.includes('--dry-run')) previews++;
        if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
        return probe(exe, args, options);
      },
    });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'pending', stopReason: 'prune-unknown', reason: 'Registration changed before prune' });
    expect(result.halted).toBe(true); expect(existsSync(f.tree)).toBe(false); expect(existsSync(replacement)).toBe(true);
    expect(previews).toBe(0); expect(prunes).toBe(0);
  });
  it('U1 primary identity unavailable after removal still stops before prune', async () => {
    const f = fixture(), context = await classify(f); let removed = false, prunes = 0;
    const result = await execute(f, context, {
      onAfterMutation: ({ kind }) => { if (kind === 'remove') removed = true; },
      runProbe: (exe, args, options) => {
        if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
        if (removed && args.includes('rev-parse') && args.includes('--show-toplevel') &&
            args.includes('-C') && resolve(args[args.indexOf('-C') + 1]) === f.primary) return unknown('Primary identity changed');
        return probe(exe, args, options);
      },
    });
    expect(removed).toBe(true);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'pending',
      reason: expect.stringContaining('Primary identity before prune') });
    expect(result.halted).toBe(true); expect(prunes).toBe(0);
  });
  it('U1 missing registration key stops before prune', async () => {
    const f = fixture(), context = await classify(f);
    let prunes = 0, omitted = 0;
    const result = await execute(f, context, {
      onAfterMutation: ({ kind }) => {
        if (kind !== 'remove') return;
        // Drop the key from collected evidence after the final candidate recheck.
        for (const record of [...vi.mocked(inventory).mock.results, ...vi.mocked(candidateInventory).mock.results]) {
          if (record.type !== 'return' || record.value.state !== 'ok') continue;
          const facts = record.value.value;
          const keys = facts.registrationKeys.filter((entry: { path: string }) => resolve(entry.path) !== f.tree);
          omitted += facts.registrationKeys.length - keys.length;
          facts.registrationKeys = keys;
        }
      },
      runProbe: (exe, args, options) => {
        if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
        return probe(exe, args, options);
      },
    });
    expect(omitted).toBeGreaterThan(0);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'pending', stopReason: 'prune-unknown',
      reason: 'Registration key missing before prune', mutations: [{ kind: 'remove-started' }, { kind: 'deregister' }] });
    expect(result.halted).toBe(true); expect(prunes).toBe(0);
  });
  it.each([false, true])('U1 candidate reincarnation is held before mutation (scoped release=%s)', async scoped => {
    const f = fixture(), context = await classify(f);
    if (scoped) Object.assign(context.snapshot, { scopedInboundBaseline: true,
      worktrees: context.snapshot.worktrees.filter(tree => resolve(tree.path) === f.tree) });
    git(f.primary, 'worktree', 'remove', f.tree);
    git(f.primary, 'worktree', 'add', f.tree, 'candidate'); age(f.tree);
    const mutations: string[] = [];
    const result = await execute(f, context, { onBeforeMutation: ({ kind }) => { mutations.push(kind); } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Fresh inventory unavailable', stopReason: null, mutations: [] });
    expect(result.halted).toBe(false); expect(mutations).toEqual([]); expect(existsSync(f.tree)).toBe(true);
  });
  it('U1 empty registration delta retains both previews and live prune', async () => {
    const f = fixture(), context = await classify(f); let previews = 0, prunes = 0;
    const result = await execute(f, context, { runProbe: (exe, args, options) => {
      if (args.includes('--dry-run')) previews++;
      if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
      return probe(exe, args, options);
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'removed', stopReason: null,
      registrationDelta: { added: [], vanished: [], changed: [] } });
    expect(result.halted).toBe(false); expect(previews).toBe(2); expect(prunes).toBe(1);
  });
  it('U1 ordinary Git use in an unrelated worktree keeps its gitdir fingerprint stable and permits prune', async () => {
    const f = fixture(), other = f.add('other'), context = await classify(f);
    context.plan.worktrees = context.plan.worktrees.filter(tree => resolve(tree.path) === f.tree);
    const registration = context.snapshot.registrationKeys.find(entry => resolve(entry.path) === other)!;
    const gitdirPath = join(registration.adminPath, 'gitdir'), before = regularBytes(gitdirPath);
    writeFileSync(join(other, 'tracked.md'), 'ordinary edit\n');
    for (const args of [['status', '--porcelain'], ['add', 'tracked.md'], ['commit', '-m', 'ordinary work'], ['log', '-1', '--oneline']]) {
      git(other, ...args);
      const after = regularBytes(gitdirPath), command = `git ${args.join(' ')}`;
      expect(after.fingerprint, `${command} changed gitdir metadata`).toEqual(before.fingerprint);
      expect(after.sha256, `${command} changed gitdir content`).toBe(before.sha256);
    }
    let prunes = 0;
    const result = await execute(f, context, { runProbe: (exe, args, options) => {
      if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
      return probe(exe, args, options);
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'removed', stopReason: null,
      registrationDelta: { added: [], vanished: [], changed: [] } });
    expect(result.halted).toBe(false); expect(existsSync(f.tree)).toBe(false); expect(prunes).toBe(1);
  });
  it.each(['directory-gone', 'git-gone'])('U2 known stale %s defers prune without blocking removal', async kind => {
    const f = fixture(), stale = f.add('stale');
    if (kind === 'git-gone') unlinkSync(join(stale, '.git'));
    else { safeCleanup(stale); }
    const context = await classify(f), calls: string[][] = [], skips: object[] = [];
    expect(context.snapshot.knownStaleRegistrations).toHaveLength(1);
    const result = await execute(f, context, { onStaleSkip: key => { skips.push(key); },
      runProbe: (exe, args, options) => { calls.push(args); return probe(exe, args, options); } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'removed-prune-deferred', stopReason: null });
    expect(skips.length).toBeGreaterThan(0);
    expect(outcome(result, stale).disposition).toBe('hold');
    expect(calls.some(args => args.slice(-2).join(' ') === 'worktree prune')).toBe(false);
    expect(git(f.primary, 'worktree', 'list', '--porcelain')).toContain(stale.replaceAll('\\', '/'));
  });
  it.each(['file-deleted', 'admin-deleted', 'proof-error', 'proof-timeout', 'head-changed'])('U2 failed removal stops later candidates when %s', async change => {
    const f = fixture(), second = f.add('second'), context = await classify(f), before = readFileSync(join(f.tree, 'tracked.md'));
    let failed = false;
    const runProbe: typeof probe = (exe, args, options) => {
      if (args.includes('remove')) {
        failed = true;
        if (change === 'file-deleted') unlinkSync(join(f.tree, 'tracked.md'));
        if (change === 'admin-deleted') {
          const adminPath = join(f.primary, '.git', 'worktrees', 'candidate');
          expect(isWithin(adminPath, f.root)).toBe(true);
          rmSync(adminPath, { recursive: true });
        }
        if (change === 'head-changed') git(f.tree, 'commit', '--allow-empty', '-m', 'advanced');
        return refusedRemove();
      }
      if (failed && args.includes('status')) {
        if (change === 'proof-error') throw new Error('Intact proof failed');
        if (change === 'proof-timeout') return probe(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeout: 30 });
      }
      return probe(exe, args, options);
    };
    const result = await execute(f, context, { runProbe });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held',
      mutations: [{ kind: 'remove-started', path: expect.any(String) }] });
    expect(result.halted).toBe(true);
    expect(outcome(result, second).disposition).toBe('pending');
    expect(existsSync(join(second, 'tracked.md'))).toBe(true);
    expect(existsSync(join(f.tree, '.git'))).toBe(true);
    if (change === 'file-deleted') expect(existsSync(join(f.tree, 'tracked.md'))).toBe(false);
    else expect(readFileSync(join(f.tree, 'tracked.md'))).toEqual(before);
    expect(git(f.primary, 'worktree', 'list', '--porcelain').includes(f.tree.replaceAll('\\', '/'))).toBe(change !== 'admin-deleted');
  });
  it('U2 interrupted removal detects half-removal without trusting git status', async () => {
    const f = fixture(), second = f.add('second'), context = await classify(f);
    const result = await execute(f, context, { runProbe: (exe, args, options) => {
      if (args.includes('remove')) { unlinkSync(join(f.tree, '.git')); return unknown('interrupted'); }
      return probe(exe, args, options);
    } });
    expect(outcome(result, f.tree)).toMatchObject({ stopReason: 'half-removed', mutations: [{ kind: 'remove-started' }] });
    expect(result.halted).toBe(true); expect(outcome(result, second).disposition).toBe('pending');
  });
  it.each(['deadline', 'half-removed', 'prune-unknown', 'shared-target-changed'])('U2 preserves an explicit %s stop despite an intact refusal', async stopReason => {
    const f = fixture(), second = f.add('second'), context = await classify(f);
    const result = await execute(f, context, { runProbe: (exe, args, options) =>
      args.includes('remove') ? { ...unknown('Explicit run stop'), stopReason } : probe(exe, args, options) });
    expect(outcome(result, f.tree)).toMatchObject({ stopReason, mutations: [{ kind: 'remove-started' }] });
    expect(result.halted).toBe(true); expect(outcome(result, second).disposition).toBe('pending');
    expect(existsSync(join(f.tree, 'tracked.md'))).toBe(true);
  });
  it.each([1, 2])('U3-T1 unknown entry at per-tree preview %s defers prune and continues', async site => {
    const f = fixture(), second = f.add('second'), context = await classify(f); let previews = 0, prunes = 0;
    const unknownEntries = ['Removing worktrees/unknown: gitdir file points to non-existent location',
      'Removing worktrees/another: gitdir file points to non-existent location'];
    const result = await execute(f, context, { runProbe: (exe, args, options) => {
      if (args.includes('--dry-run') && ++previews % site === 0) return { ...probe(exe, args, options),
        stderr: [...unknownEntries, unknownEntries[0]].join('\n') + '\n' };
      if (args.slice(-2).join(' ') === 'worktree prune') prunes++;
      return probe(exe, args, options);
    } });
    for (const path of [f.tree, second]) {
      expect(outcome(result, path)).toMatchObject({ disposition: 'removed-prune-deferred', stopReason: null,
        unknownPruneEntries: unknownEntries, mutations: [{ kind: 'remove-started' }, { kind: 'deregister' }] });
      expect(existsSync(path)).toBe(false);
    }
    expect(result.halted).toBe(false); expect(prunes).toBe(0); expect(previews).toBe(site * 2);
  });
  it.skipIf(process.platform !== 'win32')('U2 recent activity after junction unlink is mutated-then-held', async () => {
    const f = fixture(), target = shared(f), second = f.add('second');
    symlinkSync(target, join(f.tree, 'node_modules'), 'junction');
    const context = await classify(f);
    const result = await execute(f, context, { onAfterMutation: ({ kind }) => {
      if (kind === 'unlink-junction') utimesSync(join(f.tree, 'tracked.md'), new Date(), new Date());
    } });
    expect(outcome(result, f.tree)).toMatchObject({ reason: 'Recent file activity', stopReason: 'mutated-then-held', mutations: [{ kind: 'unlink-junction' }] });
    expect(result.halted).toBe(true); expect(outcome(result, second).disposition).toBe('pending');
  });
  it('U2 removal floor stops the batch once and leaves later trees pending', async () => {
    const f = fixture(), second = f.add('second'), context = await classify(f);
    const result = await execute(f, context, { now: () => 0, softDeadline: 179_999 });
    expect(outcome(result, f.tree)).toMatchObject({ stopReason: 'deadline', mutations: [] });
    expect(outcome(result, second)).toMatchObject({ disposition: 'pending', reason: 'Run halted', mutations: [] });
    expect(result.halted).toBe(true);
  });
  it('holds B in a removal batch after A evicts a malformed transcript that then disappears', async () => {
    const f = fixture(), second = f.add('second'), sessions = join(f.home, '.codex', 'sessions');
    mkdirSync(sessions, { recursive: true });
    const path = join(sessions, 'recent.jsonl');
    writeFileSync(path, JSON.stringify({ timestamp: new Date().toISOString(), type: 'event_msg' }) + '\n');
    const context = await classify(f);
    const first = context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)!;
    const next = context.snapshot.worktrees.find(tree => resolve(tree.path) === second)!;
    expect([first.activity.live.state, next.activity.live.state]).toEqual(['negative', 'negative']);
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === second)?.disposition).toBe('remove');
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: second } }) + '\n{\n');
    expect((await activity(first, f.options.activityOptions)).transcript.state).toBe('unknown');
    unlinkSync(path);
    expect.soft((await activity(next, f.options.activityOptions)).transcript.state).toBe('unknown');
    const mutations: string[] = [];
    const result = await execute(f, context, { onBeforeMutation: ({ kind }) => { mutations.push(kind); } });
    expect.soft(outcome(result, second).disposition).toBe('hold');
    expect.soft(existsSync(second)).toBe(true);
    expect(mutations).toEqual([]);
  });
  it('bounded read-only recheck exercises the removal gate without a mutation', async () => {
    const f = fixture(), context = await classify(f), mutations: string[] = [];
    const result = await execute(f, context, { recheckOnly: true, onBeforeMutation: event => { mutations.push(event.kind); } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Read-only recheck passed' });
    expect(mutations).toEqual([]); expect(existsSync(f.tree)).toBe(true);
  });
  it('bounded recheck walks only each candidate, never another registered tree', async () => {
    const f = fixture(), second = f.add('second');
    mkdirSync(join(f.primary, 'noncandidate-deep'));
    const context = await classify(f);
    vi.mocked(readdirSync).mockClear();
    const result = await execute(f, context);
    expect(outcome(result, f.tree).disposition).toBe('removed');
    expect(outcome(result, second).disposition).toBe('removed');
    expect(vi.mocked(readdirSync).mock.calls.map(args => resolve(String(args[0])))).not.toContain(join(f.primary, 'noncandidate-deep'));
  });
  it('bounded recheck holds a newly added direct-child inbound link', async () => {
    const f = fixture(), other = f.add('other'), context = await classify(f);
    symlinkSync(f.tree, join(other, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');
    const fresh = candidateInventory(f.tree, context.snapshot, f.options);
    expect(fresh.state).toBe('ok');
    if (fresh.state !== 'ok') throw new Error('Scoped inventory failed');
    expect(fresh.value.worktrees[0].inboundLinks.state).toBe('ok');
    expect(outcome(await execute(f, context), f.tree).disposition).toBe('hold');
    expect(existsSync(f.tree)).toBe(true);
  });
  it.each(['head', 'branch', 'lock'])('scoped registration recheck ignores another tree changing %s', async change => {
    const f = fixture(), other = f.add('other'), context = await classify(f);
    if (change === 'head') git(other, 'commit', '--allow-empty', '-m', 'concurrent commit');
    if (change === 'branch') git(other, 'checkout', '-b', 'other-renamed');
    if (change === 'lock') git(f.primary, 'worktree', 'lock', other);
    expect(outcome(await execute(f, context), f.tree).disposition).toBe('removed');
    expect(existsSync(f.tree)).toBe(false);
  });
  it.each([false, true])('scoped registration recheck walks a new tree (deep inbound=%s)', async inbound => {
    const f = fixture(), context = await classify(f), added = f.add('new-unrelated');
    const deep = join(added, 'nested', 'cache'); mkdirSync(deep, { recursive: true });
    if (inbound) symlinkSync(f.tree, join(deep, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    vi.mocked(readdirSync).mockClear();
    const result = await execute(f, context);
    expect(vi.mocked(readdirSync).mock.calls.map(args => resolve(String(args[0])))).toContain(deep);
    expect(outcome(result, f.tree)).toMatchObject(inbound ? { disposition: 'hold', reason: 'Inbound link or unknown target' } : { disposition: 'removed' });
    expect(existsSync(f.tree)).toBe(inbound);
    expect(existsSync(added)).toBe(true);
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])('scoped registration recheck limits dangling foreign links (under candidate=%s, added later=%s)', async (inbound, later) => {
    const f = fixture(), other = f.add('other');
    const target = join(inbound ? f.tree : f.root, 'missing-target');
    const addLink = () => symlinkSync(target, join(other, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir');
    if (!later) addLink();
    const context = await classify(f);
    expect(context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)?.inboundLinks.state).toBe(inbound && !later ? 'unknown' : 'negative');
    if (later) addLink();
    // Run the gate even when classification already knows this target is unsafe.
    context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)!.disposition = 'remove';
    expect(outcome(await execute(f, context), f.tree).disposition).toBe(inbound ? 'hold' : 'removed');
    expect(existsSync(f.tree)).toBe(inbound);
  });
  it.each(['head', 'branch'])('scoped registration recheck still holds the candidate changing %s', async change => {
    const f = fixture(), context = await classify(f);
    if (change === 'head') git(f.tree, 'commit', '--allow-empty', '-m', 'candidate commit');
    else git(f.tree, 'checkout', '-b', 'candidate-renamed');
    const mutations: string[] = [];
    expect(outcome(await execute(f, context, { onBeforeMutation: event => { mutations.push(event.kind); } }), f.tree).disposition).toBe('hold');
    expect(mutations).toEqual([]); expect(existsSync(f.tree)).toBe(true);
  });
  it.each([false, true])('U2-T3 recheck continues after a foreign registration vanishes (scoped=%s)', async scoped => {
    const f = fixture(), other = f.add('other'), context = await classify(f);
    if (scoped) Object.assign(context.snapshot, { scopedInboundBaseline: true,
      worktrees: context.snapshot.worktrees.filter(tree => resolve(tree.path) === f.tree) });
    context.plan.worktrees = context.plan.worktrees.filter(tree => resolve(tree.path) === f.tree);
    git(f.primary, 'worktree', 'remove', other);
    expect(outcome(await execute(f, context), f.tree)).toMatchObject({ disposition: 'removed', stopReason: null });
    expect(existsSync(f.tree)).toBe(false);
  });
  describe('U2b vanished registration inbound evidence', () => {
    async function runVanished(scoped: boolean, change: (source: string, candidate: string) => void) {
      const f = fixture(), candidate = scoped ? f.tree : f.add('later'), other = f.add('vanished'), context = await classify(f);
      if (scoped) Object.assign(context.snapshot, { scopedInboundBaseline: true,
        worktrees: context.snapshot.worktrees.filter(tree => resolve(tree.path) === candidate) });
      context.plan.worktrees = context.plan.worktrees.filter(tree => resolve(tree.path) !== other);
      expect(context.snapshot.worktrees.find(tree => resolve(tree.path) === candidate)?.inboundLinks.state).toBe('negative');
      expect(context.plan.worktrees.find(tree => resolve(tree.path) === candidate)?.disposition).toBe('remove');
      const before = ['tracked.md', '.git'].map(name => readFileSync(join(candidate, name)));
      const mutations: string[] = [];
      let vanished = false;
      const deregister = () => {
        const admin = join(f.primary, '.git', 'worktrees', 'vanished');
        expect(isWithin(admin, f.root)).toBe(true); rmSync(admin, { recursive: true });
        vanished = true; change(other, candidate);
      };
      const result = await execute(f, context, {
        runProbe: (exe, args, options) => {
          if (scoped && !vanished && args.includes('worktree') && args.includes('list')) deregister();
          return probe(exe, args, options);
        },
        onAfterMutation: ({ kind, path }) => {
          if (!scoped && !vanished && kind === 'remove' && resolve(path) === f.tree) deregister();
        },
        onBeforeMutation: ({ kind, path }) => { if (resolve(path) === candidate) mutations.push(kind); },
      });
      expect(vanished).toBe(true); expect(result.halted).toBe(false);
      if (!scoped) {
        expect(['removed', 'removed-prune-deferred']).toContain(outcome(result, f.tree).disposition);
        expect(existsSync(f.tree)).toBe(false);
      }
      return { f, candidate, other, context, result, mutations, before };
    }
    function expectUntouched(run: Awaited<ReturnType<typeof runVanished>>) {
      expect(outcome(run.result, run.candidate)).toMatchObject({ disposition: 'hold', stopReason: null, mutations: [] });
      expect(run.mutations).toEqual([]);
      expect(['tracked.md', '.git'].map(name => readFileSync(join(run.candidate, name)))).toEqual(run.before);
      expect(git(run.f.primary, 'worktree', 'list', '--porcelain')).toContain(run.candidate.replaceAll('\\', '/'));
    }
    async function inboundTest(scoped: boolean) {
      const run = await runVanished(scoped, (source, candidate) => {
        symlinkSync(candidate, join(source, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');
      });
      expect(outcome(run.result, run.candidate).reason).toBe('Inbound link or unknown target');
      expectUntouched(run);
      const fresh = candidateInventory(run.candidate, run.context.snapshot, run.f.options);
      expect(fresh.state).toBe('ok');
      if (fresh.state !== 'ok') throw new Error('Candidate inventory failed');
      expect(fresh.value.worktrees[0].inboundLinks).toMatchObject({ state: 'ok', value: [expect.objectContaining({ sourceTree: run.other.replaceAll('\\', '/') })] });
    }
    it.skipIf(process.platform !== 'win32').each([false, true])('U2-T6 holds a new inbound junction from a vanished registration (scoped=%s)', inboundTest);
    it.skipIf(process.platform === 'win32').each([false, true])('U2-T6 holds a new inbound symlink from a vanished registration (scoped=%s)', inboundTest);
    it.each([false, true])('U2-T7 holds when a vanished directory shallow scan fails (scoped=%s)', async scoped => {
      const realRead = vi.mocked(readdirSync).getMockImplementation()!;
      let reads = 0;
      try {
        const run = await runVanished(scoped, source => {
          vi.mocked(readdirSync).mockImplementation((...args) => {
            if (resolve(String(args[0])) === source) { reads++; throw new Error('Unreadable vanished directory fixture'); }
            return realRead(...args);
          });
        });
        expect(outcome(run.result, run.candidate).reason).toBe('Fresh inventory unavailable');
        expectUntouched(run); expect(reads).toBeGreaterThan(0);
        expect(candidateInventory(run.candidate, run.context.snapshot, run.f.options)).toMatchObject({
          state: 'unknown', reason: expect.stringContaining('Unreadable vanished directory fixture'),
        });
      } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
    });
    it.each([false, true])('U2b an absent vanished directory causes no hold (scoped=%s)', async scoped => {
      const run = await runVanished(scoped, source => { safeCleanup(source); });
      expect(outcome(run.result, run.candidate)).toMatchObject({ disposition: 'removed', stopReason: null });
      expect(existsSync(run.candidate)).toBe(false);
    });
    it.each([false, true].flatMap(scoped => ['before-read', 'during-scan', 'after-scan'].map(timing => ({ scoped, timing }))))('U2b a vanished directory disappearing $timing causes no hold (scoped=$scoped)', async ({ scoped, timing }) => {
      const realRead = vi.mocked(readdirSync).getMockImplementation()!;
      let disappeared = false;
      try {
        const run = await runVanished(scoped, (source, candidate) => {
          if (timing === 'after-scan') symlinkSync(candidate, join(source, 'cache'), process.platform === 'win32' ? 'junction' : 'dir');
          vi.mocked(readdirSync).mockImplementation((...args) => {
            if (!disappeared && resolve(String(args[0])) === source) {
              const entries = timing === 'before-read' ? undefined : realRead(...args);
              if (timing === 'after-scan') {
                const iterate = entries![Symbol.iterator].bind(entries);
                return Object.assign(entries!, { *[Symbol.iterator]() {
                  yield* iterate(); disappeared = true; safeCleanup(source);
                } });
              }
              disappeared = true; safeCleanup(source);
              return entries ?? realRead(...args);
            }
            return realRead(...args);
          });
        });
        expect(disappeared).toBe(true);
        expect(outcome(run.result, run.candidate)).toMatchObject({ disposition: 'removed', stopReason: null });
        expect(existsSync(run.other)).toBe(false); expect(existsSync(run.candidate)).toBe(false);
      } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
    });
    it.each([false, true])('U2b a missing entry in a surviving vanished directory still holds (scoped=%s)', async scoped => {
      const realRead = vi.mocked(readdirSync).getMockImplementation()!;
      let disappeared = false;
      try {
        const run = await runVanished(scoped, source => {
          vi.mocked(readdirSync).mockImplementation((...args) => {
            const entries = realRead(...args);
            if (!disappeared && resolve(String(args[0])) === source) {
              disappeared = true; unlinkSync(join(source, 'tracked.md'));
            }
            return entries;
          });
        });
        expect(disappeared).toBe(true); expect(existsSync(run.other)).toBe(true);
        expect(outcome(run.result, run.candidate).reason).toBe('Fresh inventory unavailable');
        expectUntouched(run);
      } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
    });
    it.each([false, true])('U2b a surviving plain directory without links causes no hold (scoped=%s)', async scoped => {
      const run = await runVanished(scoped, () => {});
      expect(outcome(run.result, run.candidate)).toMatchObject({ disposition: 'removed', stopReason: null });
      expect(existsSync(run.other)).toBe(true); expect(existsSync(run.candidate)).toBe(false);
    });
    it.each([false, true])('U2b holds a vanished path replaced by a file (scoped=%s)', async scoped => {
      const run = await runVanished(scoped, source => { safeCleanup(source); writeFileSync(source, 'unavailable'); });
      expectUntouched(run);
      expect(candidateInventory(run.candidate, run.context.snapshot, run.f.options)).toMatchObject({
        state: 'unknown', reason: expect.stringContaining('Vanished registration directory unavailable'),
      });
      unlinkSync(run.other);
    });
    it.skipIf(process.platform !== 'win32').each([false, true])('U2b holds a vanished path replaced by a junction (scoped=%s)', async scoped => {
      const run = await runVanished(scoped, (source, candidate) => { safeCleanup(source); symlinkSync(candidate, source, 'junction'); });
      expectUntouched(run);
      expect(candidateInventory(run.candidate, run.context.snapshot, run.f.options)).toMatchObject({
        state: 'unknown', reason: expect.stringContaining('Vanished registration directory unavailable'),
      });
    });
  });
  it('U2-T2 current vanished candidate is a structured non-stop hold', async () => {
    const f = fixture(), second = f.add('second'), context = await classify(f);
    git(f.primary, 'worktree', 'remove', f.tree);
    const result = await execute(f, context);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'registration-vanished', stopReason: null, mutations: [] });
    expect(outcome(result, second).disposition).toBe('removed');
    expect(result.halted).toBe(false);
  });
  it('U2-fix emits no membership delta when repository identity changes', async () => {
    const f = fixture(), context = await classify(f), foreign = fixture(), observed = vi.fn();
    const checked = candidateInventory(f.tree, { ...context.snapshot, primaryPath: foreign.primary, runnerPath: foreign.primary },
      { ...f.options, onRegistrationDelta: observed });
    expect(checked).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Repository identity changed') });
    expect(checked.registrationDelta).toBeUndefined(); expect(observed).not.toHaveBeenCalled();
  });
  it.each([false, true])('U2-fix preserves the vanished cause after rescue mutation (missing .git=%s)', async missingGit => {
    const f = fixture(), second = f.add('second'), context = await rescue(f);
    const result = await execute(f, context, { published: context.published, onAfterMutation: event => {
      if (event.kind !== 'unlink-rescued') return;
      const admin = join(f.primary, '.git', 'worktrees', 'candidate');
      expect(isWithin(admin, f.root)).toBe(true); rmSync(admin, { recursive: true });
      if (missingGit) unlinkSync(join(f.tree, '.git'));
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Classification registration vanished',
      reasonCode: 'registration-vanished', stopReason: missingGit ? 'half-removed' : 'mutated-then-held', mutations: [{ kind: 'unlink-rescued' }] });
    expect(result.halted).toBe(true); expect(outcome(result, second).disposition).toBe('pending');
  });
  it('U2-fix preserves a vanished hold during failed-removal intact proof', async () => {
    const f = fixture(), second = f.add('second'), context = await classify(f);
    let refused = false, vanished = false;
    const result = await execute(f, context, { runProbe: (exe, args, options) => {
      if (args.slice(-3, -1).join(' ') === 'worktree remove') { refused = true; return refusedRemove(); }
      if (refused && !vanished && args.includes('worktree') && args.includes('list')) {
        vanished = true;
        const admin = join(f.primary, '.git', 'worktrees', 'candidate');
        expect(isWithin(admin, f.root)).toBe(true); rmSync(admin, { recursive: true });
      }
      return probe(exe, args, options);
    } });
    expect(vanished).toBe(true);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Classification registration vanished',
      reasonCode: 'registration-vanished', stopReason: 'mutated-then-held', mutations: [{ kind: 'remove-started' }] });
    expect(result.halted).toBe(true); expect(outcome(result, second).disposition).toBe('pending');
  });
  it('U2 keeps the half-removed stop for a registered tree even when the current candidate vanished', async () => {
    const f = fixture(), second = f.add('second'), context = await classify(f);
    git(f.primary, 'worktree', 'remove', f.tree); unlinkSync(join(second, '.git'));
    expect(candidateInventory(f.tree, context.snapshot, f.options)).toMatchObject({ state: 'unknown', stopReason: 'half-removed' });
  });
  it('scoped registration recheck holds an unexpectedly disappeared classification child', async () => {
    const f = fixture(), child = f.add('child', join(f.tree, 'coverage', 'child')), context = await classify(f);
    git(f.primary, 'worktree', 'remove', child);
    expect(candidateInventory(f.tree, context.snapshot, f.options)).toMatchObject({ state: 'unknown', stopReason: null,
      registrationDelta: { vanished: [expect.objectContaining({ path: child.replaceAll('\\', '/') })] } });
    expect(existsSync(f.tree)).toBe(true);
  });
  it('scoped registration recheck finds a new tree link inside real node_modules', async () => {
    const f = fixture(), context = await classify(f), added = f.add('new-modules');
    const modules = join(added, 'node_modules'); mkdirSync(join(modules, 'pkg'), { recursive: true });
    writeFileSync(join(modules, '.package-lock.json'), '{"packages":{}}');
    symlinkSync(join(f.tree, 'missing'), join(modules, 'pkg', 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(outcome(await execute(f, context), f.tree)).toMatchObject({ disposition: 'hold', reason: 'Inbound link or unknown target' });
    expect(existsSync(f.tree)).toBe(true);
  });
  it.each(['unreadable', 'deadline'])('scoped registration recheck holds a new tree with an incomplete walk: %s', async failure => {
    const f = fixture(), context = await classify(f), added = f.add('new-incomplete');
    const deep = join(added, 'nested'); mkdirSync(deep);
    const realRead = vi.mocked(readdirSync).getMockImplementation()!;
    let clock = 100;
    const deadline = clock + 120_000;
    vi.mocked(readdirSync).mockImplementation((...args) => {
      if (resolve(String(args[0])) === deep) {
        if (failure === 'unreadable') throw new Error('Unreadable new tree fixture');
        clock = deadline;
      }
      return realRead(...args);
    });
    try {
      const options = { ...f.options, softDeadline: deadline, deadlineNow: () => clock };
      expect(boundedTimeout(options)).toBeGreaterThanOrEqual(15_000);
      expect(candidateInventory(f.tree, context.snapshot, options)).toMatchObject({
        state: 'unknown', reason: expect.stringContaining(failure === 'unreadable' ? 'Unreadable new tree fixture' : 'Soft deadline reached'),
      });
      expect(existsSync(f.tree)).toBe(true);
    } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
  });
  it('bounded recheck stops inside a scan and runCleanup writes its report', async () => {
    const f = fixture(), context = await classify(f), reportRoot = join(f.root, 'reports');
    let clock = Date.now(), expire = false, candidateReads = 0;
    const started = clock, mutations: string[] = [];
    const realRead = vi.mocked(readdirSync).getMockImplementation()!;
    vi.mocked(readdirSync).mockImplementation((...args) => {
      const result = realRead(...args);
      if (expire && resolve(String(args[0])) === f.tree) { candidateReads++; clock = started + 600_000; }
      return result;
    });
    try {
      const report = await runCleanup({ ...f.options, reportRoot, now: () => clock, softTimeoutMs: 720_000, gitPath: process.execPath, ghPath: process.execPath }, {
        inventory: () => ok(context.snapshot), collectActivity: async () => context.snapshot.worktrees.map(tree => tree.activity),
        planWorktrees: async () => { expire = true; return ok({ ...context.plan, worktrees: context.plan.worktrees.filter(tree => resolve(tree.path) === f.tree) }); },
        runProbe: (_exe: string, args: string[]) => args.includes('rev-parse') ? ok(join(f.primary, '.git') + '\n') : ok(''),
        executeRemovals: (plan: Parameters<typeof executeRemovals>[0], snapshot: Parameters<typeof executeRemovals>[1], options: RemovalOptions) => executeRemovals(plan, snapshot, { ...options, gitPath: 'git', runProbe: probe,
          onBeforeMutation: event => { mutations.push(event.kind); } }),
        notifyRun: () => {},
      });
      expect(report.worktrees[0]).toMatchObject({ disposition: 'pending', reason: 'Soft deadline reached' });
      expect(report).toMatchObject({ status: 'failed', stopReason: 'deadline', finalPrunePreview: { state: 'ok' } });
      expect(mutations).toEqual([]);
      expect(candidateReads).toBe(1);
      expect(existsSync(f.tree)).toBe(true);
      expect(readdirSync(reportRoot, { recursive: true }).some(name => String(name).endsWith('.json'))).toBe(true);
      expect(readdirSync(reportRoot, { recursive: true }).some(name => String(name).endsWith('.jsonl'))).toBe(true);
      expect(clock - started).toBe(600_000);
    } finally { vi.mocked(readdirSync).mockImplementation(realRead); }
  });
  it.each(['complete', 'activity-deadline'])('U3-T4: records ordered phase durations with the injected clock: %s', async outcome => {
    const f = fixture(), context = await classify(f), reportRoot = join(f.root, 'reports');
    const snapshot = { ...context.snapshot, worktrees: context.snapshot.worktrees.filter(tree => resolve(tree.path) === f.tree) };
    const plan = { ...context.plan, worktrees: context.plan.worktrees.filter(tree => resolve(tree.path) === f.tree).map(tree => ({ ...tree, disposition: 'remove' })) };
    let clock = 1_000, activityElapsed = 0;
    const report = await runCleanup({ ...f.options, reportRoot, now: () => clock, softTimeoutMs: 2_000_000,
      gitPath: process.execPath, ghPath: process.execPath, scheduledNightly: true }, {
      inventory: () => { clock += 749_000; return ok(snapshot); },
      scanPrimaryLinks: () => { clock += 3_000; return ok([]); },
      collectActivity: async (_trees: unknown, options: { softDeadline: number }) => {
        const started = clock;
        if (outcome === 'activity-deadline') {
          clock = options.softDeadline; activityElapsed = clock - started;
          throw Object.assign(new Error('Soft deadline reached'), { stopReason: 'deadline' });
        }
        clock += 5_000;
        return snapshot.worktrees.map(tree => tree.activity);
      },
      planWorktrees: async () => { clock += 7_000; return ok(plan); },
      appendIdleObservation: () => { clock += 8_000; return ok(null); },
      executeRemovals: () => {
        clock += 10_000;
        return ok({ worktrees: [{ path: f.tree, disposition: 'removed', reason: 'Removed', mutations: [], stopReason: null }] });
      },
      pruneArchives: () => { clock += 11_000; return ok({ pruned: [], warnings: [], totalBytes: 0 }); },
      writeLinkIndex: () => { clock += 4_000; },
      runProbe: (_exe: string, args: string[]) => {
        if (args.includes('rev-parse')) { clock += 2_000; return ok(join(f.primary, '.git') + '\n'); }
        clock += args.includes('fetch') ? 3_000 : 1_000;
        return ok('');
      },
      notifyRun: () => {},
    });
    const beforeActivity = [
      { phase: 'lock-wait', ms: 0 }, { phase: 'executables', ms: 0 }, { phase: 'fetch', ms: 5_000 },
      { phase: 'inventory', ms: 749_000 }, { phase: 'snapshot-eligibility', ms: 0 }, { phase: 'snapshot-reconcile', ms: 0 }, { phase: 'primary-scan', ms: 3_000 },
    ];
    expect(report.phaseDurations).toEqual(outcome === 'complete' ? [...beforeActivity,
      { phase: 'activity', ms: 5_000 }, { phase: 'classify', ms: 7_000 }, { phase: 'idle-observations', ms: 8_000 },
      { phase: 'rescue', ms: 0 }, { phase: 'remove', ms: 10_000 }, { phase: 'prune', ms: 14_000 },
      { phase: 'link-index-write', ms: 4_000 },
    ] : [...beforeActivity, { phase: 'activity', ms: activityElapsed }, { phase: 'link-index-write', ms: 4_000 }]);
    expect(report).toMatchObject(outcome === 'complete' ? { status: 'completed', stage: 'complete' }
      : { status: 'failed', stage: 'inventory', stopReason: 'deadline' });
    if (outcome === 'activity-deadline') expect(activityElapsed).toBeGreaterThan(0);
    expect(report.worktrees.every(row => row.recheckDurations === undefined)).toBe(true);
    const markdown = readFileSync(report.reportPath!, 'utf8');
    expect(markdown).toMatch(/wall time: \d+ ms\.\nPhase durations: lock-wait 0\.0 s; executables 0\.0 s; fetch 5\.0 s; inventory 749\.0 s; snapshot-eligibility 0\.0 s; snapshot-reconcile 0\.0 s; primary-scan 3\.0 s; activity /);
    const journal = JSON.parse(readFileSync(join(reportRoot, 'journal.jsonl'), 'utf8').trim());
    expect(journal.phaseDurations).toEqual(report.phaseDurations);
  });
  it.skipIf(process.platform !== 'win32').each(['cache', '.git'])('holds an unlisted %s junction deep inside real node_modules at removal recheck', async name => {
    const f = fixture(), target = shared(f), before = targetSnapshot(target);
    const modules = join(f.tree, 'node_modules');
    mkdirSync(join(modules, 'pkg'), { recursive: true });
    writeFileSync(join(modules, '.package-lock.json'), '{"packages":{}}');
    symlinkSync(target, join(modules, 'pkg', name), 'junction');
    const context = await classify(f), mutations: string[] = [];
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree).disposition).toBe('remove');
    const result = await execute(f, context, { onBeforeMutation: ({ kind }) => {
      mutations.push(kind);
      throw new Error('Fixture guard: never attempt removal through the hidden junction');
    } });
    expect(outcome(result, f.tree).disposition).toBe('hold');
    expect(mutations).toEqual([]);
    expect(outcome(result, f.tree).reason).toMatch(/pre-removal link scan/i);
    expect(existsSync(f.tree)).toBe(true); expect(targetSnapshot(target)).toEqual(before);
  });
  it('removes real node_modules with nested directories and no links', async () => {
    const f = fixture(), modules = join(f.tree, 'node_modules');
    mkdirSync(join(modules, 'pkg', 'cache'), { recursive: true });
    writeFileSync(join(modules, '.package-lock.json'), '{"packages":{}}');
    writeFileSync(join(modules, 'pkg', 'cache', 'entry'), 'disposable');
    const result = await execute(f, await classify(f));
    expect(outcome(result, f.tree).disposition, JSON.stringify(result)).toBe('removed');
    expect(existsSync(f.tree)).toBe(false);
  });
  it('gives git worktree remove a real budget, not the short probe default', async () => {
    // A 15 s default killed `git worktree remove` mid-delete on real trees with
    // a full node_modules and left them half-removed.
    const f = fixture(), context = await classify(f), timeouts: number[] = [];
    const result = await execute(f, context, { runProbe: (executable, args, options) => {
      if (args.includes('worktree') && args.includes('remove')) timeouts.push(options!.timeout!);
      return probe(executable, args, options);
    } });
    expect(outcome(result, f.tree).disposition, JSON.stringify(result)).toBe('removed');
    expect(timeouts).toEqual([600_000]);
  });
  it('leaves a tree pending rather than start a removal it may not finish', async () => {
    const f = fixture(), context = await classify(f), removals: string[][] = [];
    const result = await execute(f, context, { softDeadline: Date.now() + 120_000, runProbe: (executable, args, options) => {
      if (args.includes('worktree') && args.includes('remove')) removals.push(args);
      return probe(executable, args, options);
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'pending', reason: 'Not enough time left to remove safely' });
    expect(removals).toEqual([]); expect(existsSync(f.tree)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32').each(['timeout', 'error'])('holds before mutation when the complete link scan returns %s', async failure => {
    const f = fixture(), context = await classify(f), mutations: string[] = [], timeouts: number[] = [];
    const result = await execute(f, context, { runProbe: (executable, args, options) => {
      if (options?.env?.WORKTREE_CLEANUP_SCAN_ROOT) {
        timeouts.push(options.timeout!); return unknown(failure);
      }
      return probe(executable, args, options);
    }, onBeforeMutation: ({ kind }) => { mutations.push(kind); } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Pre-removal link scan unavailable' });
    expect(timeouts).toEqual([300_000]); expect(mutations).toEqual([]); expect(existsSync(f.tree)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('classification and removal use two full target walks plus the existing post-unlink comparison as a third', async () => {
    const f = fixture(), target = shared(f), before = targetSnapshot(target);
    symlinkSync(target, join(f.tree, 'node_modules'), 'junction');
    vi.mocked(readdirSync).mockClear();
    const fullWalks = () => vi.mocked(readdirSync).mock.calls.filter(args => resolve(String(args[0])) === join(target, 'package')).length;
    const context = await classify(f);
    expect(fullWalks()).toBe(1);
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)).toMatchObject({ disposition: 'remove' });
    expect(context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)).toMatchObject({
      targetBaseline: { state: 'ok', value: { count: before.count, topLevelCount: 2, lockHash: before.lock } },
      links: { state: 'ok', value: { nodeModulesTargetEvidence: { state: 'ok', value: { topLevelCount: 2, lockHash: before.lock } } } },
    });
    const result = await execute(f, context, {
      runProbe: (executable, args, options) => {
        if (args.includes(helper)) expect(fullWalks()).toBe(2);
        return probe(executable, args, options);
      },
      onAfterMutation: ({ kind }) => { if (kind === 'unlink-junction') expect(fullWalks()).toBe(2); },
    });
    expect(outcome(result, f.tree).disposition, JSON.stringify(result)).toBe('removed');
    expect(existsSync(f.tree)).toBe(false);
    expect(fullWalks()).toBe(3);
    expect(targetSnapshot(target)).toEqual(before);
  });
  it.skipIf(process.platform !== 'win32')('candidate rechecks read cheap target evidence without any full target walk', async () => {
    const f = fixture(), target = shared(f);
    symlinkSync(target, join(f.tree, 'node_modules'), 'junction');
    const context = await classify(f);
    vi.mocked(readdirSync).mockClear();
    const fresh = candidateInventory(f.tree, context.snapshot, f.options);
    if (fresh.state !== 'ok') throw new Error('Candidate inventory failed');
    expect(fresh.value.worktrees[0]).not.toHaveProperty('targetBaseline');
    expect(fresh.value.worktrees[0].links).toEqual(context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)!.links);
    expect(fresh).toMatchObject({ state: 'ok', value: { worktrees: [{ links: { state: 'ok', value: {
      nodeModulesTargetEvidence: { state: 'ok', value: { topLevelCount: 2, lockHash: hash(readFileSync(join(target, '.package-lock.json'))) } },
    } } }] } });
    const result = await execute(f, context, { recheckOnly: true });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Read-only recheck passed' });
    expect(vi.mocked(readdirSync).mock.calls.map(args => resolve(String(args[0])))).not.toContain(join(target, 'package'));
    expect(existsSync(f.tree)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32').each(['two-hop', 'unknown'])('refuses a newly %s junction locally with the shared predicate', async kind => {
    const f = fixture(), target = shared(f), link = join(f.tree, 'node_modules');
    symlinkSync(target, link, 'junction');
    const context = await classify(f), replacement = join(f.root, 'replacement');
    if (kind === 'two-hop') symlinkSync(target, replacement, 'junction');
    rmdirSync(link); symlinkSync(replacement, link, 'junction');
    const result = await execute(f, context);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Unproven junction target' });
    expect(result.halted).toBe(false); expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
  it.skipIf(process.platform !== 'win32').each([
    ['lockfile', 'before-recheck'], ['entries', 'before-recheck'], ['deleted-package', 'before-recheck'],
    ['lockfile', 'before-unlink'], ['nested-entry', 'before-unlink'],
  ])('halts before unlink when target %s changes %s', async (change, timing) => {
    const f = fixture(), second = f.add('second'), target = shared(f), link = join(f.tree, 'node_modules');
    symlinkSync(target, link, 'junction');
    const context = await classify(f), helpers: string[][] = [];
    const mutate = () => {
      if (change === 'lockfile') writeFileSync(join(target, '.package-lock.json'), '{"packages":{},"changed":true}');
      else if (change === 'deleted-package') { unlinkSync(join(target, 'package', 'index.js')); rmdirSync(join(target, 'package')); }
      else if (change === 'nested-entry') writeFileSync(join(target, 'package', 'new-entry'), 'changed');
      else writeFileSync(join(target, 'new-entry'), 'changed');
    };
    if (timing === 'before-recheck') mutate();
    const result = await execute(f, context, {
      onBeforeMutation: ({ kind }) => { if (timing === 'before-unlink' && kind === 'unlink-junction') mutate(); },
      runProbe: (executable, args, options) => { if (args.includes(helper)) helpers.push(args); return probe(executable, args, options); },
    });
    expect(result.halted).toBe(true);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Junction target changed' });
    expect(outcome(result, second)).toMatchObject({ disposition: 'pending', reason: 'Run halted' });
    expect(lstatSync(link).isSymbolicLink()).toBe(true); expect(existsSync(second)).toBe(true);
    expect(helpers).toEqual([]);
  });
  it.skipIf(process.platform !== 'win32')('helper refuses a real directory and leaves its contents intact', () => {
    const f = fixture(), target = shared(f), before = targetSnapshot(target);
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', helper, '-ExpectedLinkType', 'Junction', '-ExpectedTarget', target, target], { encoding: 'utf8', windowsHide: true });
    expect(result.status).not.toBe(0); expect(result.stderr).toMatch(/exact entry.*junction/i);
    expect(targetSnapshot(target)).toEqual(before);
  });
  it.skipIf(process.platform !== 'win32')('holds a newly targeted tree and preserves the junction target', async () => {
    const f = fixture(), other = f.add('other');
    const modules = join(f.tree, 'node_modules'); mkdirSync(modules); writeFileSync(join(modules, '.package-lock.json'), '{"packages":{}}');
    const before = targetSnapshot(modules), context = await classify(f);
    symlinkSync(modules, join(other, 'node_modules'), 'junction');
    const result = await execute(f, context);
    expect(outcome(result, f.tree).disposition).toBe('hold'); expect(targetSnapshot(modules)).toEqual(before);
  });
  describe('U3 recheck timing', () => {
    async function timedCleanup(f: Fixture, context: Awaited<ReturnType<typeof classify>>, removalOptions: RemovalOptions,
      startedAt = Date.now()) {
      const snapshot = { ...context.snapshot, worktrees: context.snapshot.worktrees.filter(tree => resolve(tree.path) === f.tree) };
      const plan = { ...context.plan, worktrees: context.plan.worktrees.filter(tree => resolve(tree.path) === f.tree).map(tree => ({ ...tree, disposition: 'remove' })) };
      return runCleanup({ ...f.options, reportRoot: join(f.root, 'reports'), now: () => startedAt, softTimeoutMs: 2_000_000,
        gitPath: process.execPath, ghPath: process.execPath, ...removalOptions }, {
        inventory: () => ok(snapshot), scanPrimaryLinks: () => ok([]),
        collectActivity: async () => snapshot.worktrees.map(tree => tree.activity),
        planWorktrees: async () => ok(plan), appendIdleObservation: () => ok(null),
        executeRemovals: (treePlan: Parameters<typeof executeRemovals>[0], facts: Parameters<typeof executeRemovals>[1], options: Parameters<typeof executeRemovals>[2]) =>
          executeRemovals(treePlan, facts, { ...options, gitPath: 'git', runProbe: probe }),
        pruneArchives: () => ok({ pruned: [], warnings: [], totalBytes: 0 }),
        writeLinkIndex: () => {}, notifyRun: () => {},
        runProbe: (_exe: string, args: string[]) => ok(args.includes('rev-parse') ? join(f.primary, '.git') + '\n' : ''),
      });
    }
    const cleanSteps = ['candidate inventory', 'activity', 'final inventory', 'blob/index/HEAD checks', 'complete link scan'];
    it.each(['removed', 'guard-refused', 'activity-refused'])('U3-T1: journals steps that ran with call counts: %s', async disposition => {
      const f = fixture(), context = await classify(f);
      let clock = 0;
      if (disposition === 'activity-refused') vi.mocked(activity).mockRejectedValueOnce(new Error('Timed activity failed'));
      const report = await timedCleanup(f, context, { monotonicNow: () => { clock += 1_500; return clock; },
        ...(disposition === 'guard-refused' ? { beforeMutationGuard: () => ({ state: 'negative', reasonCode: 'test-hold' }) } : {}) });
      const row = report.worktrees[0];
      expect(row.disposition).toBe(disposition === 'removed' ? 'removed' : 'hold');
      const expected = (disposition === 'activity-refused' ? cleanSteps.slice(0, 2) : cleanSteps)
        .map(step => ({ step, calls: 1, ms: 1_500 }));
      expect(row.recheckDurations).toEqual(expected);
      const journal = JSON.parse(readFileSync(join(f.root, 'reports', 'journal.jsonl'), 'utf8').trim());
      expect(journal.worktrees[0].recheckDurations).toEqual(expected);
      expect(row.mutations).toEqual(disposition === 'removed' ? [
        { kind: 'remove-started', path: expect.any(String) }, { kind: 'deregister', path: expect.any(String) },
      ] : []);
    });
    it.skipIf(process.platform !== 'win32')('U3-T1: accumulates repeated junction rechecks per step', async () => {
      const f = fixture(); symlinkSync(shared(f), join(f.tree, 'node_modules'), 'junction');
      const context = await classify(f);
      vi.mocked(activity).mockClear();
      let clock = 0;
      const report = await timedCleanup(f, context, { monotonicNow: () => { clock += 1_500; return clock; } });
      const calls = vi.mocked(activity).mock.calls.length;
      expect(report.worktrees[0].disposition).toBe('removed');
      expect(calls).toBeGreaterThan(1);
      expect(report.worktrees[0].recheckDurations).toEqual(cleanSteps.map(step => ({ step, calls, ms: calls * 1_500 })));
    });
    it('U3-T1: counts restored-file checks and post-restore activity in rescue rechecks', async () => {
      const f = fixture(), context = await rescue(f);
      vi.mocked(activity).mockClear();
      let clock = 0;
      const result = await execute(f, context, { published: context.published, monotonicNow: () => { clock += 1_500; return clock; } });
      const row = outcome(result, f.tree), activityCalls = vi.mocked(activity).mock.calls.length;
      expect(row.disposition).toBe('removed');
      expect(row.recheckDurations).toContainEqual({ step: 'restored-file checks', calls: expect.any(Number), ms: expect.any(Number) });
      const refreshed = row.recheckDurations?.find(entry => entry.step === 'activity');
      expect(refreshed?.calls).toBeGreaterThan(activityCalls);
      for (const duration of row.recheckDurations ?? []) expect(duration.ms).toBe(duration.calls * 1_500);
      expect(row.recheckDurations?.some(entry => entry.step === 'reachability')).toBe(false);
    });
    it('U3-T5: each step time covers only its own work, including the awaited activity', async () => {
      const f = fixture(), context = await classify(f);
      let clock = 0;
      const real = vi.mocked(activity).getMockImplementation();
      vi.mocked(activity).mockImplementationOnce(async (...args) => { const live = await real!(...args); clock += 7_000; return live; });
      const report = await timedCleanup(f, context, { monotonicNow: () => clock });
      expect(report.worktrees[0].disposition).toBe('removed');
      expect(report.worktrees[0].recheckDurations).toEqual(cleanSteps.map(step => ({ step, calls: 1, ms: step === 'activity' ? 7_000 : 0 })));
    });
    it('U3-T5: a throwing clock loses only the timing sample, never the removal or a refusal', async () => {
      const f = fixture(), context = await classify(f);
      const report = await timedCleanup(f, context, { monotonicNow: () => { throw new Error('clock broke'); },
        beforeMutationGuard: () => ({ state: 'negative', reasonCode: 'test-hold' }) });
      expect(report.worktrees[0].disposition).toBe('hold');
      expect(report.worktrees[0].reasonCode).toBe('mutation-guard');
      expect(report.worktrees[0].recheckDurations).toEqual(cleanSteps.map(step => ({ step, calls: 1, ms: 0 })));
    });
    it('gives every run a fresh lease memo, even when the caller supplies one', async () => {
      const f = fixture(), context = await classify(f);
      const supplied = new Set(['stale-verdict']);
      const memos: unknown[] = [];
      const snapshot = { ...context.snapshot, worktrees: context.snapshot.worktrees.filter(tree => resolve(tree.path) === f.tree) };
      for (let run = 0; run < 2; run++) {
        await runCleanup({ ...f.options, reportRoot: join(f.root, 'reports-' + run), now: () => Date.now(), softTimeoutMs: 2_000_000,
          gitPath: process.execPath, ghPath: process.execPath, dryRun: true, activityOptions: { leaseMemo: supplied } }, {
          inventory: () => ok(snapshot), scanPrimaryLinks: () => ok([]),
          collectActivity: async (_trees: unknown, options: { leaseMemo?: unknown }) => { memos.push(options.leaseMemo); return snapshot.worktrees.map(tree => tree.activity); },
          planWorktrees: async () => ok({ ...context.plan, worktrees: [] }), appendIdleObservation: () => ok(null),
          writeLinkIndex: () => {}, notifyRun: () => {},
          runProbe: (_exe: string, args: string[]) => ok(args.includes('rev-parse') ? join(f.primary, '.git') + '\n' : ''),
        });
      }
      expect(memos).toHaveLength(2);
      for (const memo of memos) { expect(memo).toBeInstanceOf(Set); expect(memo).not.toBe(supplied); expect((memo as Set<string>).size).toBe(0); }
      expect(memos[0]).not.toBe(memos[1]);
    });
    it('U3-T2: renders compact timings and preserves a row without timing exactly', async () => {
      const f = fixture(), context = await classify(f);
      let clock = 0;
      const report = await timedCleanup(f, context, { monotonicNow: () => { clock += 1_500; return clock; } });
      const legacyPath = join(f.root, 'legacy');
      const rendered = writeRunReport(join(f.root, 'rendered'), { ...report, worktrees: [report.worktrees[0],
        { path: legacyPath, action: 'hold', disposition: 'hold', reason: 'Keep for review', reasonCode: 'legacy-hold', mutations: [] },
      ] });
      const markdown = readFileSync(rendered.reportPath, 'utf8');
      expect(markdown.split('\n').find(line => line.startsWith(`| ${report.worktrees[0].path} |`)))
        .toContain('recheck: ' + cleanSteps.map(step => `${step} 1x1.5 s`).join('; '));
      expect(markdown.split('\n').find(line => line.startsWith(`| ${legacyPath} |`)))
        .toBe(`| ${legacyPath} | hold | hold | Keep for review |  | legacy-hold | hold | hold | [] | false |`);
    });
    it('U3-T3: reads an old journal row and retains held age alongside new timing', async () => {
      const f = fixture(), context = await classify(f), startedAt = Date.now(), firstHeldAt = startedAt - 86_400_000;
      const reportRoot = join(f.root, 'reports'); mkdirSync(reportRoot);
      writeFileSync(join(reportRoot, 'journal.jsonl'), JSON.stringify({ version: 1, runId: 'legacy', dryRun: false,
        worktrees: [{ path: f.tree, disposition: 'hold', firstHeldAt }],
      }) + '\n');
      let clock = 0;
      const report = await timedCleanup(f, context, { monotonicNow: () => { clock += 1_500; return clock; },
        beforeMutationGuard: () => ({ state: 'negative', reasonCode: 'test-hold' }),
      }, startedAt);
      expect(report.worktrees[0]).toMatchObject({ disposition: 'hold', firstHeldAt });
      expect(report.held).toEqual({ count: 1, oldestAgeMs: 86_400_000 });
      const journal = readFileSync(join(reportRoot, 'journal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(journal[0].worktrees[0]).not.toHaveProperty('recheckDurations');
      expect(journal[1].worktrees[0].recheckDurations).toEqual(cleanSteps.map(step => ({ step, calls: 1, ms: 1_500 })));
    });
  });
  describe('U2 recheck trim', () => {
    function observeRechecks() {
      vi.mocked(candidateInventory).mockClear();
      vi.mocked(activity).mockClear();
      vi.mocked(fileActivity).mockClear();
      // collectActivity computes fileActivity once per refresh; the exported
      // probe spy counts any additional walk requested directly by removal.
      return () => ({
        rechecks: vi.mocked(activity).mock.calls.length,
        inventories: vi.mocked(candidateInventory).mock.calls.length,
        fileWalks: vi.mocked(activity).mock.calls.length + vi.mocked(fileActivity).mock.calls.length,
      });
    }
    it('U2-T1: reuses one clean no-junction recheck before git removal', async () => {
      const f = fixture(), context = await classify(f), counts = observeRechecks();
      const atRemoval: ReturnType<typeof counts>[] = [];
      const result = await execute(f, context, { runProbe: (executable, args, options) => {
        if (args.includes('worktree') && args.includes('remove')) atRemoval.push(counts());
        return probe(executable, args, options);
      } });
      expect(outcome(result, f.tree)).toMatchObject({ disposition: 'removed', mutations: [
        { kind: 'remove-started', path: expect.any(String) }, { kind: 'deregister', path: expect.any(String) },
      ] });
      expect(atRemoval).toEqual([{ rechecks: 1, inventories: 2, fileWalks: 1 }]);
    });
    it.skipIf(process.platform !== 'win32')('U2-T2: keeps junction gates before unlink and after unlink', async () => {
      const f = fixture(), target = shared(f), bytes = targetSnapshot(target);
      symlinkSync(target, join(f.tree, 'node_modules'), 'junction');
      const context = await classify(f), counts = observeRechecks();
      const gates: { kind: string; rechecks: number; inventories: number; fileWalks: number }[] = [];
      const result = await execute(f, context, { onBeforeMutation: ({ kind }) => {
        if (kind === 'unlink-junction' || kind === 'remove') gates.push({ kind, ...counts() });
      } });
      expect(outcome(result, f.tree).disposition).toBe('removed');
      expect(targetSnapshot(target)).toEqual(bytes);
      expect(gates).toEqual([
        { kind: 'unlink-junction', rechecks: 2, inventories: 4, fileWalks: 2 },
        { kind: 'remove', rechecks: 3, inventories: 6, fileWalks: 3 },
      ]);
    });
    it('U2-T3: rechecks before each rescue mutation and the final removal', async () => {
      const f = fixture(), context = await rescue(f), counts = observeRechecks();
      const gates: { kind: string; rechecks: number; inventories: number; fileWalks: number }[] = [];
      const result = await execute(f, context, { published: context.published, onBeforeMutation: ({ kind }) => {
        if (kind !== 'prune') gates.push({ kind, ...counts() });
      } });
      expect(outcome(result, f.tree).disposition).toBe('removed');
      expect(outcome(result, f.tree).mutations.map(event => event.kind)).toEqual(['unlink-rescued', 'restore', 'remove-started', 'deregister']);
      expect(gates).toEqual([
        { kind: 'unlink-rescued', rechecks: 1, inventories: 2, fileWalks: 1 },
        { kind: 'restore', rechecks: 2, inventories: 4, fileWalks: 2 },
        { kind: 'remove', rechecks: 3, inventories: 6, fileWalks: 3 },
      ]);
    });
    it.each(['allow', 'refuse'])('U2-T4: preserves reused-gate guard and hook ordering (%s)', async mode => {
      const f = fixture(), second = f.add('second'), context = await classify(f), counts = observeRechecks();
      const order: string[] = [], gates: ReturnType<typeof counts>[] = [];
      const result = await execute(f, context, {
        beforeMutationGuard: ({ kind }) => {
          if (kind === 'remove') { order.push('guard'); gates.push(counts()); }
          return mode === 'allow' ? ok(true) : { state: 'negative', reasonCode: 'open-pr' };
        },
        onBeforeMutation: ({ kind }) => { if (kind === 'remove') order.push('hook'); },
        runProbe: (executable, args, options) => {
          if (args.includes('worktree') && args.includes('remove')) order.push('remove');
          return probe(executable, args, options);
        },
      });
      if (mode === 'allow') {
        expect(outcome(result, f.tree).disposition).toBe('removed');
        expect(outcome(result, second).disposition).toBe('removed');
        expect(order).toEqual(['guard', 'hook', 'remove', 'guard', 'hook', 'remove']);
        expect(gates).toEqual([
          { rechecks: 1, inventories: 2, fileWalks: 1 }, { rechecks: 2, inventories: 4, fileWalks: 2 },
        ]);
      } else {
        expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'open-pr', mutations: [] });
        expect(result.halted).toBe(true);
        expect(outcome(result, second).disposition).toBe('pending');
        expect(existsSync(f.tree) && existsSync(second)).toBe(true);
        expect(order).toEqual(['guard']);
        expect(gates).toEqual([{ rechecks: 1, inventories: 2, fileWalks: 1 }]);
      }
    });
    it.each(['lease', 'transcript', 'file-activity'])('U2-T5: catches %s after a completed read-only gate', async signal => {
      const f = fixture(), context = await classify(f), counts = observeRechecks();
      const first = await execute(f, context, { recheckOnly: true });
      expect(outcome(first, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Read-only recheck passed', mutations: [] });
      const firstGate = counts();
      if (signal === 'lease') {
        const job = join(f.home, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
        writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'job', cwd: f.tree, pid: process.pid, started_at: new Date().toISOString() }));
      } else if (signal === 'transcript') {
        const sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
        writeFileSync(join(sessions, 'recent.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: f.tree } }) + '\n');
      } else utimesSync(join(f.tree, 'tracked.md'), new Date(), new Date());
      expect(outcome(await execute(f, context), f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
      expect(existsSync(f.tree)).toBe(true);
      expect(firstGate).toEqual({ rechecks: 1, inventories: 2, fileWalks: 1 });
    });
    it('U2-T6: performs one file-activity walk per full recheck', async () => {
      const f = fixture(), context = await classify(f), counts = observeRechecks();
      const result = await execute(f, context, { recheckOnly: true });
      expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reason: 'Read-only recheck passed', mutations: [] });
      expect(counts()).toEqual({ rechecks: 1, inventories: 2, fileWalks: 1 });
      expect(existsSync(f.tree)).toBe(true);
    });
  });
  it('removes clean merged worktrees, prunes, and keeps branches', async () => {
    const f = fixture(), context = await classify(f), calls: string[][] = [];
    const result = await execute(f, context, { onBeforeMutation: ({ args }) => { calls.push(args ?? []); } });
    expect(outcome(result, f.tree).disposition).toBe('removed');
    expect(outcome(result, f.tree).mutations).toEqual([{ kind: 'remove-started', path: expect.any(String) }, { kind: 'deregister', path: expect.any(String) }]);
    expect(existsSync(f.tree)).toBe(false); expect(git(f.primary, 'branch', '--list', 'candidate')).toContain('candidate');
    expect(calls.some(args => args.includes('prune'))).toBe(true);
    expect(calls.flat()).not.toContain('--force');
  });
  it('keeps the named branch and unmerged commit', async () => {
    const f = fixture(); writeFileSync(join(f.tree, 'code.txt'), 'unmerged'); git(f.tree, 'add', '.'); git(f.tree, 'commit', '-m', 'unmerged'); age(f.tree);
    const head = git(f.tree, 'rev-parse', 'HEAD'), context = await classify(f);
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree).disposition).toBe('remove-keep-branch');
    expect(outcome(await execute(f, context), f.tree).disposition).toBe('removed');
    expect(git(f.primary, 'rev-parse', 'candidate')).toBe(head);
  });
  it.each([false, true])('removes verified rescue docs with raw bytes (CRLF=%s)', async crlf => {
    const f = fixture(crlf), context = await rescue(f, crlf), mutations: string[] = [];
    for (const file of context.decision.files) expect(blob(f.tree, readFileSync(join(f.tree, file.path)))).toBe(file.blobSha);
    const result = await execute(f, context, { published: context.published, onBeforeMutation: ({ kind }) => { mutations.push(kind); } });
    expect(outcome(result, f.tree).disposition, JSON.stringify(result)).toBe('removed');
    expect(mutations).toContain('unlink-rescued'); expect(mutations).toContain('restore');
    expect(mutations).toContain('remove'); expect(existsSync(f.tree)).toBe(false);
    expect(outcome(result, f.tree).mutations.map(event => event.kind)).toEqual(['unlink-rescued', 'restore', 'remove-started', 'deregister']);
  });
  it('removes a rescued tree whose modified doc was indexed with LF under core.autocrlf', async () => {
    // Real trees written by tools often hold LF files indexed at their LF size.
    // Under autocrlf, restoring a modified doc writes CRLF; a worktree-only
    // restore then leaves a stale index size and a phantom modification that
    // held the first real run.
    const f = fixture(true);
    writeFileSync(join(f.tree, 'tracked.md'), 'original\n');
    git(f.tree, 'add', 'tracked.md');
    expect(git(f.tree, 'status', '--porcelain')).toBe('');
    const context = await rescue(f, false);
    const result = await execute(f, context, { published: context.published });
    expect(outcome(result, f.tree).disposition, JSON.stringify(result)).toBe('removed');
    expect(existsSync(f.tree)).toBe(false);
  });
  it.each(['new-file', 'doc-bytes', 'head', 'staged', 'deleted', 'ignored', 'unregistered-child'])('holds rescue after %s changes without deleting docs', async change => {
    const f = fixture(), context = await rescue(f);
    if (change === 'new-file') writeFileSync(join(f.tree, 'later.md'), 'later');
    if (change === 'doc-bytes') { writeFileSync(join(f.tree, 'tracked.md'), 'later'); age(f.tree); }
    if (change === 'head') { git(f.tree, 'commit', '--allow-empty', '-m', 'later'); }
    if (change === 'staged') git(f.tree, 'add', 'tracked.md');
    if (change === 'deleted') unlinkSync(join(f.tree, 'tracked.md'));
    if (change === 'ignored') { writeFileSync(join(f.tree, '.git', '..', '.ignore-me'), 'secret'); git(f.tree, 'config', 'core.excludesFile', join(f.root, 'excludes')); writeFileSync(join(f.root, 'excludes'), '.ignore-me\n'); }
    if (change === 'unregistered-child') { mkdirSync(join(f.tree, 'nested')); git(join(f.tree, 'nested'), 'init'); }
    const mutations: string[] = [];
    const result = await execute(f, context, { published: context.published, onBeforeMutation: ({ kind }) => { mutations.push(kind); } });
    expect(outcome(result, f.tree).disposition).toBe('hold'); expect(existsSync(join(f.tree, 'new.md'))).toBe(true);
    expect(context.published.worktrees[0].verified.state).toBe('ok');
    if (change === 'staged') expect(git(f.tree, 'show', ':tracked.md')).toBe('edited');
    expect(mutations).toEqual([]);
  });
  it.each(['absent', 'unknown', 'head', 'blob', 'missing-file', 'extra-file', 'dry-run'])('rejects %s remote verification', async change => {
    const f = fixture(), context = await rescue(f), publication = structuredClone(context.published);
    if (change === 'unknown') publication.worktrees[0].verified = unknown('readback failed');
    if (change === 'head') publication.worktrees[0].head = '0'.repeat(40);
    if (change === 'blob') publication.worktrees[0].files[0].blobSha = '0'.repeat(40);
    if (change === 'missing-file') publication.worktrees[0].files.pop();
    if (change === 'extra-file') publication.worktrees[0].files.push({ ...publication.worktrees[0].files[0], path: 'extra.md' });
    const result = await execute(f, context, { published: change === 'absent' ? undefined : { ...publication, dryRun: change === 'dry-run' } });
    expect(outcome(result, f.tree).disposition).toBe('hold'); expect(readFileSync(join(f.tree, 'tracked.md'), 'utf8')).toBe('edited\n');
    expect(outcome(result, f.tree)).toMatchObject({ stopReason: null, mutations: [] });
  });
  it.each([2, 73])('U4 removal recheck uses record time after bookkeeping appends (%i hours)', async ageHours => {
    const f = fixture(), context = await classify(f);
    const sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'recent.jsonl'), [
      { type: 'session_meta', timestamp: new Date(Date.now() - ageHours * 3_600_000).toISOString(), payload: { cwd: f.tree } },
      { type: 'cost-state' }, { type: 'last-prompt' },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    expect(outcome(await execute(f, context), f.tree).disposition).toBe(ageHours <= 72 ? 'hold' : 'removed');
    expect(existsSync(f.tree)).toBe(ageHours <= 72);
  });
  it.each(['none', 'lease', 'transcript', 'malformed-transcript', 'file-activity', 'head-changed', 'unnamed'])('rechecks a doubt-only release with %s arriving before removal', async signal => {
    const f = fixture(), sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'doubt.jsonl'), [
      { type: 'session_meta', timestamp: new Date(Date.now() - 73 * 3_600_000).toISOString(), payload: { cwd: f.root } },
      { timestamp: new Date().toISOString(), type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'ls docs/*' }) } },
    ].map(record => JSON.stringify(record)).join('\n') + '\n');
    const context = await classify(f, [f.tree]);
    expect(context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)?.activity.liveReasons).toEqual([{ code: 'unresolved-command', state: 'unknown' }]);
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition).toBe('remove');
    if (signal === 'lease') {
      const job = join(f.home, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
      writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'job', cwd: f.tree, pid: process.pid, started_at: new Date().toISOString() }));
    } else if (signal.includes('transcript')) {
      writeFileSync(join(sessions, 'new.jsonl'), signal === 'transcript' ? JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: f.tree } }) + '\n' : '{\n');
    } else if (signal === 'file-activity') utimesSync(join(f.tree, 'tracked.md'), new Date(), new Date());
    else if (signal === 'head-changed') git(f.tree, 'commit', '--allow-empty', '-m', 'new head');
    const result = outcome(await execute(f, context, { operatorRelease: signal === 'unnamed' ? [] : [f.tree] }), f.tree);
    expect(result).toMatchObject({ disposition: signal === 'none' ? 'removed' : 'hold', stopReason: null });
    expect(existsSync(f.tree)).toBe(signal !== 'none');
    if (signal !== 'none') expect(result.mutations).toEqual([]);
  });
  it.each([false, true])('holds a named release at classification with doubt and a literal Read (literal first=%s)', async literalFirst => {
    const f = fixture(), sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
    const doubt = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat $TREE/file' }) } };
    const read = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(f.tree, 'tracked.md') } }] } };
    writeFileSync(join(sessions, 'doubt.jsonl'), [{ cwd: f.root }, ...(literalFirst ? [read, doubt] : [doubt, read])]
      .map(record => JSON.stringify(record)).join('\n') + '\n');
    const context = await classify(f, [f.tree]);
    expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)).toMatchObject({ disposition: 'hold', reason: 'live' });
    const baseline = context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)!;
    expect(baseline.activity.transcript).toMatchObject({ literalMatches: 1, observed: { literalMatches: 1 } });
    expect(outcome(await execute(f, context, { operatorRelease: [f.tree] }), f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
    expect(existsSync(f.tree)).toBe(true);
  });
  it.each([[false, false], [false, true], [true, false], [true, true]])
    ('holds a released tree at transcript recheck with a literal Read (literal first=%s, cached=%s)', async (literalFirst, cached) => {
      const f = fixture(), sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
      const file = join(sessions, 'doubt.jsonl');
      const cwd = { cwd: f.root };
      const doubt = { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd: 'cat $TREE/file' }) } };
      const read = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(f.tree, 'tracked.md') } }] } };
      writeFileSync(file, [cwd, doubt].map(record => JSON.stringify(record)).join('\n') + '\n');
      const context = await classify(f, [f.tree]);
      expect(context.plan.worktrees.find(tree => resolve(tree.path) === f.tree)?.disposition).toBe('remove');
      writeFileSync(file, [cwd, ...(literalFirst ? [read, doubt] : [doubt, read])].map(record => JSON.stringify(record)).join('\n') + '\n');
      if (cached) {
        const baseline = context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)!;
        expect((await activity(baseline, f.options.activityOptions)).transcript).toMatchObject({ literalMatches: 1, observed: { literalMatches: 1 } });
      }
      vi.mocked(createReadStream).mockClear();
      expect(outcome(await execute(f, context, { operatorRelease: [f.tree] }), f.tree))
        .toMatchObject({ disposition: 'hold', reason: 'Lease, transcript, or HEAD activity', mutations: [] });
      expect(createReadStream).toHaveBeenCalledTimes(cached ? 0 : 1);
      expect(existsSync(f.tree)).toBe(true);
    });
  it('holds a quiescent torn transcript literal during a cached removal recheck', async () => {
    const f = fixture(), context = await classify(f), sessions = join(f.home, '.codex', 'sessions');
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, 'torn.jsonl'), '{"file_path":' + JSON.stringify(join(f.tree, 'tracked.md')));
    const baseline = context.snapshot.worktrees.find(tree => resolve(tree.path) === f.tree)!;
    expect((await activity(baseline, f.options.activityOptions)).transcript).toMatchObject({ state: 'ok', literalMatches: 1 });
    vi.mocked(createReadStream).mockClear();
    expect(outcome(await execute(f, context), f.tree)).toMatchObject({ disposition: 'hold', mutations: [] });
    expect(createReadStream).not.toHaveBeenCalled();
    expect(existsSync(f.tree)).toBe(true);
  });
  it.each(['lease', 'transcript', 'malformed-transcript', 'file-activity'])('rechecks %s before removal', async signal => {
    const f = fixture(), context = await classify(f);
    if (signal === 'lease') {
      const job = join(f.home, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
      writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'job', cwd: f.tree, pid: process.pid, started_at: new Date().toISOString() }));
    } else if (signal.includes('transcript')) {
      const sessions = join(f.home, '.codex', 'sessions'); mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, 'recent.jsonl'), signal === 'transcript' ? JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { cwd: f.tree } }) + '\n' : '{\n');
    } else utimesSync(join(f.tree, 'tracked.md'), new Date(), new Date());
    expect(outcome(await execute(f, context), f.tree).disposition).toBe('hold'); expect(existsSync(f.tree)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('holds a new outbound junction and preserves its target', async () => {
    const f = fixture(), target = shared(f), before = targetSnapshot(target), context = await classify(f);
    symlinkSync(target, join(f.tree, 'outbound'), 'junction');
    expect(outcome(await execute(f, context), f.tree).disposition).toBe('hold'); expect(targetSnapshot(target)).toEqual(before);
  });
  it('holds a newly registered child', async () => {
    const f = fixture(), context = await classify(f); f.add('child', join(f.tree, 'coverage', 'child'));
    expect(outcome(await execute(f, context), f.tree).disposition).toBe('hold'); expect(existsSync(f.tree)).toBe(true);
  });
  it('removes a nested child before its parent and rescans the parent', async () => {
    const f = fixture(), child = f.add('child', join(f.tree, 'coverage', 'child')), context = await classify(f), removed: string[] = [];
    const result = await execute(f, context, { onBeforeMutation: ({ kind, path }) => { if (kind === 'remove') removed.push(path); } });
    expect(removed.map(resolvePath)).toEqual([child, f.tree]);
    expect(outcome(result, child).disposition).toBe('removed'); expect(outcome(result, f.tree).disposition).toBe('removed');
  });
  it('holds a parent if new work appears after removing its child', async () => {
    const f = fixture(), child = f.add('child', join(f.tree, 'coverage', 'child')), context = await classify(f);
    const result = await execute(f, context, { onBeforeMutation: ({ kind, path }) => { if (kind === 'prune' && resolve(path) === child) writeFileSync(join(f.tree, 'late.md'), 'keep'); } });
    expect(outcome(result, f.tree).disposition).toBe('hold'); expect(readFileSync(join(f.tree, 'late.md'), 'utf8')).toBe('keep');
  });
  it.each(['modified', 'untracked'])('continues after real Git refuses a transiently %s dirty tree, without force', async kind => {
    const f = fixture(), second = f.add('second'), context = await classify(f), calls: string[][] = [], before = readFileSync(join(f.tree, 'tracked.md'));
    const result = await execute(f, context, { runProbe: (exe, args, options) => {
      calls.push(args);
      if (args.includes('remove') && args.includes(f.tree.replaceAll('\\', '/'))) {
        const dirtyPath = join(f.tree, kind === 'modified' ? 'tracked.md' : 'late.txt');
        writeFileSync(dirtyPath, 'concurrent work\n');
        const refused = probe(exe, args, options);
        expect(refused).toMatchObject({ state: 'unknown', exitCode: 128, stderr: expect.stringContaining('contains modified or untracked files') });
        // The concurrent writer reverts its edit after Git refuses. The real
        // refusal and unchanged post-command inventory permit the local hold.
        if (kind === 'modified') writeFileSync(dirtyPath, before);
        else unlinkSync(dirtyPath);
        return refused;
      }
      return probe(exe, args, options);
    } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'git-refused-intact', stopReason: null, mutations: [] });
    expect(result.halted).toBe(false); expect(calls.flat()).not.toContain('--force');
    expect(calls.filter(args => args.includes('remove') && args.includes(f.tree.replaceAll('\\', '/')))).toHaveLength(1);
    expect(readFileSync(join(f.tree, 'tracked.md'))).toEqual(before);
    expect(outcome(result, second).disposition).toBe('removed'); expect(existsSync(second)).toBe(false);
  });
  it('continues after real Git refuses a worktree with submodule admin data', async () => {
    const f = fixture(), second = f.add('second');
    mkdirSync(join(f.primary, '.git', 'worktrees', 'candidate', 'modules'));
    const context = await classify(f), result = await execute(f, context);
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'git-refused-intact', stopReason: null, mutations: [] });
    expect(result.halted).toBe(false); expect(outcome(result, second).disposition).toBe('removed');
    expect(existsSync(join(f.tree, 'tracked.md'))).toBe(true);
  });
  it('keeps prior rescue mutations when Git refuses an otherwise intact tree', async () => {
    const f = fixture(), second = f.add('second'), context = await rescue(f);
    const result = await execute(f, context, { published: context.published, runProbe: (exe, args, options) =>
      args.includes('remove') ? refusedRemove() : probe(exe, args, options) });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', reasonCode: 'git-refused-intact', stopReason: 'mutated-then-held',
      mutations: [{ kind: 'unlink-rescued' }, { kind: 'restore' }] });
    expect(result.halted).toBe(true); expect(outcome(result, second).disposition).toBe('pending');
  });
  it('stops when Git refuses removal after a concurrent file appears', async () => {
    const f = fixture(), context = await classify(f), calls: string[][] = [];
    const result = await execute(f, context, { onBeforeMutation: ({ kind, path, args }) => { calls.push(args ?? []); if (kind === 'remove') writeFileSync(join(path, 'late.txt'), 'keep'); } });
    expect(outcome(result, f.tree)).toMatchObject({ disposition: 'hold', stopReason: 'mutated-then-held', mutations: [{ kind: 'remove-started' }] });
    expect(result.halted).toBe(true); expect(calls.flat()).not.toContain('--force');
    expect(calls.filter(args => args.includes('remove'))).toHaveLength(1); expect(existsSync(join(f.tree, 'late.txt'))).toBe(true);
  });
  it('reports pending when a successful deregistration leaves a directory', async () => {
    const f = fixture(), context = await classify(f);
    const result = await execute(f, context, { onAfterMutation: ({ kind, path }) => { if (kind === 'remove') { mkdirSync(path); writeFileSync(join(path, 'locked'), 'leave'); } } });
    expect(outcome(result, f.tree).disposition).toBe('pending'); expect(readFileSync(join(f.tree, 'locked'), 'utf8')).toBe('leave');
  });
  it.each(['head', 'staged', 'transcript', 'new-file'])('rechecks between rescue mutations: %s', async change => {
    const f = fixture(), context = await rescue(f);
    const result = await execute(f, context, { published: context.published, onAfterMutation: ({ kind }) => {
      if (kind !== 'unlink-rescued') return;
      if (change === 'head') git(f.tree, 'commit', '--allow-empty', '-m', 'advanced');
      if (change === 'staged') git(f.tree, 'add', 'tracked.md');
      if (change === 'new-file') writeFileSync(join(f.tree, 'later.md'), 'keep');
      if (change === 'transcript') { const dir = join(f.home, '.codex', 'sessions'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'late.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), cwd: f.tree })); }
    } });
    expect(outcome(result, f.tree).disposition).toBe('hold'); expect(readFileSync(join(f.tree, 'tracked.md'), 'utf8')).toBe('edited\n');
    expect(outcome(result, f.tree)).toMatchObject({ stopReason: 'mutated-then-held', mutations: [{ kind: 'unlink-rescued', file: 'new.md' }] });
  });
  it('does not mask activity on a doc after its own restore', async () => {
    const f = fixture(), context = await rescue(f);
    const result = await execute(f, context, { published: context.published, onAfterMutation: ({ kind }) => { if (kind === 'restore') writeFileSync(join(f.tree, 'tracked.md'), 'new work'); } });
    expect(outcome(result, f.tree).disposition).toBe('hold'); expect(readFileSync(join(f.tree, 'tracked.md'), 'utf8')).toBe('new work');
  });
  it('stops starting candidates after its soft deadline', async () => {
    const f = fixture(), second = f.add('second'), context = await classify(f); let now = 10;
    // Leave more than the minimum removal budget, then expire after the first removal.
    const result = await execute(f, context, { softDeadline: 600_010, now: () => now, onAfterMutation: ({ kind }) => { if (kind === 'remove') now = 600_011; } });
    expect(outcome(result, f.tree).disposition).toBe('removed'); expect(outcome(result, second).disposition).toBe('pending'); expect(existsSync(second)).toBe(true);
  });
  it('does nothing when the deadline has already passed', async () => {
    const f = fixture(), context = await classify(f);
    expect(outcome(await execute(f, context, { softDeadline: 0 }), f.tree).disposition).toBe('pending'); expect(existsSync(f.tree)).toBe(true);
  });
  it('checks the deadline again after the final recheck', async () => {
    const f = fixture(), context = await classify(f); let now = 10;
    const result = await execute(f, context, { softDeadline: 120_010, now: () => now, onBeforeMutation: ({ kind }) => { if (kind === 'remove') now = 120_011; } });
    expect(outcome(result, f.tree).disposition).toBe('pending'); expect(existsSync(f.tree)).toBe(true);
  });
  it('removes a clean worktree with an empty HEAD tree', async () => {
    const f = fixture(); git(f.tree, 'rm', '-r', '.'); git(f.tree, 'commit', '-m', 'empty');
    const context = await classify(f);
    expect(outcome(await execute(f, context), f.tree).disposition).toBe('removed');
    expect(existsSync(f.tree)).toBe(false);
  });
  it.each(['primary', 'runner', 'unregistered', 'identity', 'locked'])('holds %s despite a removable decision', async changed => {
    const f = fixture(), context = await classify(f);
    let path = f.tree;
    if (changed === 'primary') { path = f.primary; const decision = context.plan.worktrees.find(tree => resolve(tree.path) === path); decision.disposition = 'remove'; }
    if (changed === 'unregistered') git(f.primary, 'worktree', 'remove', f.tree);
    if (changed === 'identity') unlinkSync(join(f.tree, '.git'));
    if (changed === 'locked') git(f.primary, 'worktree', 'lock', f.tree);
    const result = await execute(f, context, changed === 'runner' ? { runnerPath: f.tree } : {});
    expect(outcome(result, path).disposition).toBe('hold');
  });
  it('holds unknown probe results without mutation', async () => {
    const f = fixture(), context = await classify(f);
    expect(outcome(await execute(f, context, { runProbe: () => unknown('timeout') }), f.tree).disposition).toBe('hold'); expect(existsSync(f.tree)).toBe(true);
  });
  it.skipIf(process.platform !== 'win32')('halts the entire run if a junction target snapshot changes', async () => {
    const f = fixture(), second = f.add('second'), target = shared(f), before = targetSnapshot(target);
    symlinkSync(target, join(f.tree, 'node_modules'), 'junction');
    const context = await classify(f);
    const result = await execute(f, context, { onAfterMutation: ({ kind }) => { if (kind === 'unlink-junction') writeFileSync(join(target, '.package-lock.json'), '{"packages":{},"changed":true}'); } });
    expect(result.halted).toBe(true); expect(existsSync(f.tree)).toBe(true); expect(existsSync(second)).toBe(true);
    // Restore the deliberate fault, then enforce the same sacrificial-target invariant.
    writeFileSync(join(target, '.package-lock.json'), '{"packages":{}}'); expect(targetSnapshot(target)).toEqual(before);
  });
});
function resolvePath(path: string) { return resolve(path); }
