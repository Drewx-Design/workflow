import './worktree-cleanup-test-env';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, lstatSync, rmSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { scanSecrets, SCRATCH_PATHS } from '../lib/worktree-cleanup/admission.mjs';
import { readRegular } from '../lib/worktree-cleanup/archive.mjs';
import { normalizePath, parseStatus, regularBytes } from '../lib/worktree-cleanup/inventory.mjs';
import * as inventoryModule from '../lib/worktree-cleanup/inventory.mjs';
import { appendIdleObservation } from '../lib/worktree-cleanup/idle-journal.mjs';
import { writeLinkIndex } from '../lib/worktree-cleanup/link-index.mjs';
import { snapshotFallback } from '../lib/worktree-cleanup/policy.mjs';
import { negative, ok, probe, unknown, withDeadline } from '../lib/worktree-cleanup/probe.mjs';
import { writeFailureReport } from '../lib/worktree-cleanup/report.mjs';
import { runRescueCommand } from '../lib/worktree-cleanup/rescue.mjs';
import { readCommissioning, preflightSnapshot, publishSnapshot, reconcileSnapshots, verifySnapshotRecord, markSnapshotProgress, markSnapshotRemoved, recoverSnapshot, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_FILE_BYTES, type SnapshotFile } from '../lib/worktree-cleanup/snapshot.mjs';
import { main, runCleanup } from '../worktree-cleanup.mjs';

type PublishedSnapshotFile = SnapshotFile & { digest: string; mode: string };
// Cleanup adds journal notes at runtime, beyond its declared RunReport fields.
type CleanupReportWithNotes = Awaited<ReturnType<typeof runCleanup>> & { notes: string[] };

const roots: string[] = [], DAY = 86_400_000;
const templates = new Map<string, { root: string; template: string }>();
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV,
  GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', cwd, ...args],
    { env, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout.replace(/\r?\n$/, '');
}
function put(root: string, path: string, bytes: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
}
function fixtureAt(root: string) {
  const primary = join(root, 'primary');
  const add = (name = 'candidate') => {
    const path = join(root, name); git(primary, 'worktree', 'add', '-b', name, path); return path;
  };
  return { root, primary, add };
}
function fixture() { return restoreFixture('base'); }
function restoreFixture(variant: string, setup?: (f: ReturnType<typeof fixtureAt>) => void) {
  let saved = templates.get(variant);
  // Each variant has one root: restoring it again deletes the previous fixture of that variant.
  if (!saved) {
    const root = mkdtempSync(join(tmpdir(), 'wt-snapshot-')); roots.push(root);
    const primary = join(root, 'primary'); mkdirSync(primary);
    git(primary, 'init', '-b', 'main');
    git(primary, 'config', 'user.name', 'Fixture'); git(primary, 'config', 'user.email', 'fixture@example.invalid');
    git(primary, 'config', 'core.autocrlf', 'false');
    put(primary, '.gitignore', '.reproduce-out/\n');
    put(primary, 'artifacts/github-issue-roadmap/tracked.json', '{"base":true}\n');
    put(primary, '.tmp-intake/.env.local.example', 'EXAMPLE=placeholder\n');
    git(primary, 'add', '.'); git(primary, 'commit', '-m', 'base');
    git(primary, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    setup?.(fixtureAt(root));
    saved = { root, template: root + '-template' }; templates.set(variant, saved);
    cpSync(root, saved.template, { recursive: true, preserveTimestamps: true });
  }
  // Copy setup bytes only; every production read must observe the restored files.
  safeCleanup(saved.root); cpSync(saved.template, saved.root, { recursive: true, preserveTimestamps: true });
  if (!roots.includes(saved.root)) roots.push(saved.root);
  return fixtureAt(saved.root);
}
function tree(path: string) {
  const head = git(path, 'rev-parse', 'HEAD');
  const all = parseStatus(git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignored=matching'));
  const entries = all.filter(entry => entry.index !== '!'), ignored = all.filter(entry => entry.index === '!').map(entry => entry.path);
  return { path, registration: ok({ path, head, branch: 'refs/heads/candidate', detached: false, bare: false, locked: null, prunable: null }),
    status: ok({ clean: entries.length === 0, entries }), ignored: ok({ entries: ignored, unexpected: ignored }),
    links: ok({ entries: [], forbidden: [], nodeModulesTarget: null }) };
}
function value<T extends { state: 'ok', value: unknown } | { state: 'negative' | 'unknown' }>(result: T): Extract<T, { state: 'ok' }>['value'];
function value(result: { state: 'ok', value: unknown } | { state: 'negative' | 'unknown' }) {
  expect(result.state).toBe('ok');
  if (result.state !== 'ok') throw new Error('Expected admitted snapshot');
  return result.value;
}
function savedState(path: string) {
  return { head: git(path, 'rev-parse', 'HEAD'), index: readFileSync(git(path, 'rev-parse', '--path-format=absolute', '--git-path', 'index')),
    objects: git(path, 'count-objects', '-v'), status: git(path, 'status', '--porcelain=v1', '-z', '--ignored=matching') };
}
function age(root: string, now: number) {
  for (const name of readdirSync(root)) {
    if (name === '.git') continue;
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isDirectory()) age(path, now);
    else utimesSync(path, new Date(now - 30 * DAY), new Date(now - 30 * DAY));
  }
}
function safeCleanup(root: string) {
  if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
  rmSync(root, { recursive: true, force: true });
}
afterEach(() => { for (const root of roots.splice(0)) safeCleanup(root); });
afterAll(() => { for (const { template } of templates.values()) safeCleanup(template); });

describe('U3 read-only snapshot preflight', { timeout: 60_000 }, () => {
  it('expands the exact copy set, retains scanned bytes and Git blob digests, and leaves Git unchanged', () => {
    const f = fixture(), path = f.add();
    const payloads = [
      { path: '.tmp-intake/deep/untracked.json', kind: 'untracked', bytes: Buffer.from('{"untracked":true}\r\n') },
      { path: '.reproduce-out/deep/ignored.json', kind: 'ignored', bytes: Buffer.from('{"ignored":true}\n') },
      { path: 'artifacts/github-issue-roadmap/tracked.json', kind: 'modified', bytes: Buffer.from('{"changed":true}\n') },
    ];
    for (const file of payloads) put(path, file.path, file.bytes);
    const facts = tree(path); expect(value(facts.ignored).unexpected).toEqual(['.reproduce-out/']);
    const before = savedState(path), admitted = value(preflightSnapshot(facts));
    expect(admitted.files).toEqual([...payloads].sort((a, b) => a.path.localeCompare(b.path)).map(file => ({ ...file, size: file.bytes.length,
      digest: createHash('sha1').update(`blob ${file.bytes.length}\0`).update(file.bytes).digest('hex') })));
    expect(admitted.totalBytes).toBe(payloads.reduce((sum, file) => sum + file.bytes.length, 0));
    expect(admitted.largest).toEqual({ path: payloads[0].path, size: payloads[0].bytes.length });
    expect(savedState(path)).toEqual(before);
  });

  it('uses the SHA-256 Git blob format when HEAD is a SHA-256 oid', () => {
    const f = fixture(), path = f.add(); put(path, '.tmp-intake/data.json', '{}');
    const facts = tree(path); value(facts.registration).head = 'a'.repeat(64);
    expect(value(preflightSnapshot(facts)).files[0].digest).toBe(createHash('sha256').update('blob 2\0{}').digest('hex'));
  });

  it.each(['.tmp-intake/', '.reproduce-out/'])('refuses a symlink file expanded inside %s without opening any copy-set files', prefix => {
    const f = fixture(), path = f.add(), target = join(f.root, 'outside.json');
    writeFileSync(target, '{"outside":true}'); mkdirSync(join(path, prefix), { recursive: true });
    symlinkSync(target, join(path, prefix, 'linked.json'), 'file');
    const readFile = vi.fn(readRegular);
    expect(preflightSnapshot(tree(path), { readFile })).toMatchObject({ state: 'negative', veto: 'snapshot-unsupported-entry', paths: [prefix + 'linked.json'] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform !== 'win32').each(SCRATCH_PATHS)('refuses a real directory junction under %s without reading behind it', prefix => {
    const f = fixture(), path = f.add(), target = join(f.root, 'outside');
    put(target, 'never-open.json', '{"outside":true}'); mkdirSync(join(path, prefix), { recursive: true });
    symlinkSync(target, join(path, prefix, 'junction'), 'junction');
    const readFile = vi.fn(readRegular), facts = tree(path);
    expect(preflightSnapshot(facts, { readFile })).toMatchObject({ state: 'negative', veto: 'snapshot-unsupported-entry', paths: [prefix + 'junction'] });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('refuses a tracked modified directory (submodule shape)', () => {
    const f = fixture(), path = f.add(); mkdirSync(join(path, '.tmp-intake/module'));
    const facts = tree(path); facts.status = ok({ clean: false, entries: [{ index: ' ', worktree: 'M', path: '.tmp-intake/module' }] });
    expect(preflightSnapshot(facts)).toMatchObject({ state: 'negative', veto: 'snapshot-unsupported-entry', paths: ['.tmp-intake/module'] });
  });

  it('pins real caps and refuses a 51 MiB file before reading it', () => {
    expect(SNAPSHOT_MAX_BYTES).toBe(200 * 1024 ** 2); expect(SNAPSHOT_MAX_FILE_BYTES).toBe(50 * 1024 ** 2);
    const f = fixture(), path = f.add(), file = '.tmp-intake/large.json';
    put(path, file, ''); truncateSync(join(path, file), 51 * 1024 ** 2);
    const readFile = vi.fn(readRegular);
    expect(preflightSnapshot(tree(path), { readFile })).toMatchObject({ state: 'negative', veto: 'snapshot-file-cap', paths: [file],
      summary: { totalBytes: 51 * 1024 ** 2, largest: { path: file, size: 51 * 1024 ** 2 } } });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('refuses the aggregate cap while every file is within its cap, and admits the exact boundary', () => {
    const f = fixture(), path = f.add(); put(path, '.tmp-intake/a.json', '{}\n'); put(path, '.tmp-intake/b.json', '{}\n');
    const facts = tree(path), readFile = vi.fn(readRegular);
    expect(preflightSnapshot(facts, { maxBytes: 5, maxFileBytes: 3, readFile })).toMatchObject({ state: 'negative', veto: 'snapshot-size-cap',
      paths: ['.tmp-intake/a.json', '.tmp-intake/b.json'], summary: { totalBytes: 6 } });
    expect(readFile).not.toHaveBeenCalled();
    expect(value(preflightSnapshot(facts, { maxBytes: 6, maxFileBytes: 3 })).totalBytes).toBe(6);
  });

  it.each(['.tmp-intake/.env.local', '.reproduce-out/deep/.env.local'])('names the expanded untracked/ignored name hit %s without returning its contents', file => {
    const f = fixture(), path = f.add(), contents = 'name-gated-content-marker'; put(path, file, contents);
    const result = preflightSnapshot(tree(path));
    expect(result).toMatchObject({ state: 'negative', veto: 'secret_material', paths: [file] });
    expect(JSON.stringify(result)).not.toContain(contents); expect(JSON.stringify(result)).not.toContain('"bytes"');
  });

  it('names a secret-name hit before any unscannable content, without reading or digesting it', () => {
    const f = fixture(), path = f.add();
    put(path, '.tmp-intake/.env.local', 'DB_PASSWORD=hunter2\n'); put(path, '.tmp-intake/bin.dat', Buffer.from('a\0b'));
    const readFile = vi.fn(readRegular);
    const result = preflightSnapshot(tree(path), { readFile });
    expect(result).toMatchObject({ state: 'negative', veto: 'secret_material', paths: ['.tmp-intake/.env.local'] });
    expect(readFile).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('"digest"');
  });

  it('reports no blob digests for a content-gated veto', () => {
    const f = fixture(), path = f.add();
    put(path, '.tmp-intake/key.json', '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----');
    put(path, '.tmp-intake/plain.json', '{"ok":true}');
    const result = preflightSnapshot(tree(path));
    expect(result).toMatchObject({ state: 'negative', veto: 'secret_material', paths: ['.tmp-intake/key.json'] });
    expect(JSON.stringify(result)).not.toContain('"digest"');
  });

  it('holds when the read file identity differs from the walked file', () => {
    const f = fixture(), path = f.add(); put(path, '.tmp-intake/a.json', '{"a":1}');
    const readFile = vi.fn((file: string) => { const read = readRegular(file); return { ...read, stat: { ...read.stat, mtimeMs: read.stat.mtimeMs + 1000 } }; });
    expect(preflightSnapshot(tree(path), { readFile: readFile as unknown as typeof readRegular })).toMatchObject({ state: 'unknown' });
  });

  it('skips the name gate for modified tracked templates, but scans their contents', () => {
    const f = fixture(), path = f.add(), file = '.tmp-intake/.env.local.example'; put(path, file, 'EXAMPLE=changed\n');
    expect(value(preflightSnapshot(tree(path))).files[0]).toMatchObject({ path: file, kind: 'modified' });
    put(path, file, '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----');
    expect(preflightSnapshot(tree(path))).toMatchObject({ state: 'negative', veto: 'secret_material', paths: [file] });
  });

  it('admits roadmap intake data whose only secret-shaped text is a placeholder URL credential, and vetoes a real-looking one', () => {
    const f = fixture(), path = f.add(), file = 'artifacts/github-issue-roadmap/intake-snapshot.json';
    put(path, file, JSON.stringify({ issues: [{ body: 'Connect with `postgres://user:pass@localhost:5432/db` first.' }] }));
    expect(value(preflightSnapshot(tree(path))).files.map(entry => entry.path)).toEqual([file]);
    put(path, file, JSON.stringify({ issues: [{ body: 'Connect with `postgres://user:Xk7mQ2pL9vR4tW8z@localhost:5432/db` first.' }] }));
    expect(preflightSnapshot(tree(path))).toMatchObject({ state: 'negative', veto: 'secret_material', paths: [file] });
    put(path, file, JSON.stringify({ issues: [{ body: 'Connect with `postgres://app:Password@2024@db.example.com/app` first.' }] }));
    expect(preflightSnapshot(tree(path))).toMatchObject({ state: 'negative', veto: 'secret_material', paths: [file] });
  });

  it('admits synthesized roadmap intake and census data whose issue bodies quote code and carry Markdown tables (#2409)', () => {
    // Shapes taken from the primary checkout's intake files, with synthetic text:
    // a quoted predicate named like a token, and table rows (escaped newlines in
    // one JSON line) whose key-named cell is followed by a prose cell.
    const body = ['Repro:', '```ts', 'const hasTokenInText = issueBodies.some((token) => token.length);', '```',
      '| Secret | Owner | Rotation |', '| --- | --- | --- |',
      '| API key | Platform team (see the vault runbook) | Rotate quarterly; never paste the value into an issue body |',
      '| session token | Auth service | Expires after 30 days of inactivity, then the user signs in again |'].join('\n');
    const f = fixture(), path = f.add(), files = ['artifacts/github-issue-roadmap/file-findings/census/intake-snapshot.json', 'artifacts/github-issue-roadmap/census.json'];
    put(path, files[0], JSON.stringify({ issues: [{ number: 1, title: 'Synthetic', body }] }));
    put(path, files[1], JSON.stringify({ census: [{ number: 1, body, url: 'postgres://user:pass@localhost:5432/db' }] }, null, 2));
    expect(value(preflightSnapshot(tree(path))).files.map(entry => entry.path).sort()).toEqual([...files].sort());
    // A real token beside a note in a key-named cell still vetoes the file.
    put(path, files[1], JSON.stringify({ census: [{ number: 1, body: body + '\n| signing_key | ' + createHash('sha256').update('e2e').digest('base64').slice(0, 40) + ' (rotated weekly) |' }] }));
    expect(preflightSnapshot(tree(path))).toMatchObject({ state: 'negative', veto: 'secret_material', paths: [files[1]] });
  });

  it('refuses a private-key block in an untracked JSON file', () => {
    const f = fixture(), path = f.add(), file = '.tmp-intake/key-block.json';
    put(path, file, JSON.stringify({ material: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----' }));
    expect(preflightSnapshot(tree(path))).toMatchObject({ state: 'negative', veto: 'secret_material', paths: [file] });
  });

  it.each([
    { name: 'UTF-16LE token', bytes: Buffer.from(("ghp_" + "A".repeat(36)), 'utf16le') },
    { name: 'NUL bytes', bytes: Buffer.from('ordinary\0text') },
    { name: 'invalid UTF-8', bytes: Buffer.from([0xff, 0xfe, 0x61]) },
  ])('refuses $name as unscannable', ({ bytes }) => {
    const f = fixture(), path = f.add(), file = '.tmp-intake/unsupported.json'; put(path, file, bytes);
    expect(preflightSnapshot(tree(path))).toMatchObject({ state: 'negative', veto: 'secret-scan-unsupported', paths: [file] });
  });

  it('pins the observed no-finding outcome for a JSON document of SHA-256 fingerprints', () => {
    const bytes = Buffer.from(JSON.stringify({ fingerprints: ['first', 'second'].map(text => createHash('sha256').update(text).digest('hex')) }));
    expect(scanSecrets(bytes)).toMatchObject({ state: 'negative' });
    const f = fixture(), path = f.add(); put(path, '.tmp-intake/fingerprints.json', bytes);
    expect(value(preflightSnapshot(tree(path))).files[0].bytes).toEqual(bytes);
  });

  it('holds unreadable evidence and deadlines reached before or during a read', () => {
    const f = fixture(), path = f.add(), file = '.tmp-intake/data.json'; put(path, file, '{}'); const facts = tree(path);
    expect(preflightSnapshot(facts, { softDeadline: 1, deadlineNow: () => 1 })).toMatchObject({ state: 'unknown' });
    let clock = 0;
    expect(withDeadline(1, () => clock, () => preflightSnapshot(facts, { readFile: full => {
      const read = readRegular(full); clock = 1; return read;
    } }))).toMatchObject({ state: 'unknown' });
    unlinkSync(join(path, file)); expect(preflightSnapshot(facts)).toMatchObject({ state: 'unknown' });
  });
});

function publicationFixture(name = 'candidate') {
  const payloads = [
    { path: '.tmp-intake/untracked.json', kind: 'untracked', bytes: Buffer.from('{"untracked":true}\r\n') },
    { path: '.reproduce-out/deep/ignored.json', kind: 'ignored', bytes: Buffer.from('{"ignored":true}\n') },
    { path: 'artifacts/github-issue-roadmap/tracked.json', kind: 'modified', bytes: Buffer.from('{"modified":true}\n') },
  ];
  const f = restoreFixture('publication:' + name, f => {
    const remote = join(f.root, 'origin.git'); mkdirSync(remote);
    git(remote, 'init', '--bare', '--initial-branch=main');
    git(f.primary, 'remote', 'add', 'origin', remote); git(f.primary, 'push', 'origin', 'main');
    // A tracked executable must retain its HEAD mode even on Windows.
    git(f.primary, 'update-index', '--chmod=+x', 'artifacts/github-issue-roadmap/tracked.json');
    git(f.primary, 'commit', '-m', 'executable tracked file');
    const path = join(f.root, name); git(f.primary, 'worktree', 'add', '--detach', path, 'HEAD');
    git(path, 'config', 'core.autocrlf', 'true');
    for (const file of payloads) put(path, file.path, file.bytes);
  });
  const remote = join(f.root, 'origin.git'), path = join(f.root, name);
  const facts = tree(path); facts.registration = ok({ ...value(facts.registration), branch: null as unknown as string, detached: true });
  const preflight = preflightSnapshot(facts), runGit = vi.fn(runRescueCommand);
  const options = { reportRoot: join(f.root, 'reports'), remotePath: remote, now: '2026-10-13T02:00:00.000Z', runGit };
  const journalPath = join(options.reportRoot, 'snapshots', createHash('sha256').update(normalizePath(path)).digest('hex') + '.json');
  return { ...f, path, remote, facts, payloads, preflight, options, journalPath, runGit,
    publish: () => publishSnapshot(facts, preflight, options),
    journal: () => JSON.parse(readFileSync(journalPath, 'utf8')),
    refs: () => git(remote, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/rescue/'),
    pushes: () => runGit.mock.calls.filter(([, args]) => args.includes('push')) };
}

function sourceState(path: string) {
  const { head, index, status } = savedState(path); return { head, index, status };
}

function finishCopySet(f: ReturnType<typeof publicationFixture>) {
  const record = f.journal(), restored = [];
  for (const file of record.files) {
    if (file.kind === 'modified') {
      git(f.path, 'restore', '--source=HEAD', '--staged', '--worktree', '--', file.path);
      const { fingerprint, sha256 } = regularBytes(join(f.path, file.path));
      restored.push({ path: file.path, fingerprint, sha256 });
    } else unlinkSync(join(f.path, file.path));
  }
  const progress = { cleaned: record.files.map((file: { path: string }) => file.path), restored };
  expect(markSnapshotProgress(dirname(f.journalPath), { treePath: f.path, ...progress }).state).toBe('ok');
  expect(value(tree(f.path).status).clean).toBe(true);
  return progress;
}

describe('U5a commissioning record reader', { timeout: 60_000 }, () => {
  function commissioned() {
    const f = publicationFixture(), published = value(f.publish());
    const record = { schema: 'worktree-cleanup-commissioning/v1', planHash: 'a'.repeat(64), createdAt: f.options.now,
      refs: [{ ref: published.ref, commitSha: published.commitSha }] };
    const path = join(f.options.reportRoot, 'commissioning.json');
    const save = () => writeFileSync(path, JSON.stringify(record));
    save(); f.runGit.mockClear();
    return { ...f, record, commissioningPath: path, save,
      read: () => readCommissioning(f.options.reportRoot, { ...f.options, repositoryPath: f.primary }) };
  }

  it('validates every ref through fresh independent ls-remote reads and writes nothing', () => {
    const f = commissioned(), other = 'refs/heads/rescue/second';
    git(f.remote, 'update-ref', other, f.record.refs[0].commitSha);
    f.record.refs.push({ ref: other, commitSha: f.record.refs[0].commitSha }); f.save();
    const before = readFileSync(f.commissioningPath), source = sourceState(f.path);
    expect(f.read()).toMatchObject({ state: 'ok', value: f.record });
    const reads = f.runGit.mock.calls.filter(([, args]) => args.includes('ls-remote')).map(([, args]) => args.at(-1));
    expect(reads).toEqual(f.record.refs.flatMap(({ ref }) => [ref, ref]));
    expect(f.pushes()).toHaveLength(0); expect(sourceState(f.path)).toEqual(source);
    expect(readFileSync(f.commissioningPath)).toEqual(before);
  });

  it.each(['deleted', 'moved', 'second read moved', 'unavailable'])('refuses remote evidence that is %s', change => {
    const f = commissioned(), entry = f.record.refs[0];
    if (change === 'deleted') git(f.remote, 'update-ref', '-d', entry.ref);
    if (change === 'moved') git(f.remote, 'update-ref', entry.ref, git(f.primary, 'rev-parse', 'HEAD'));
    let reads = 0;
    f.runGit.mockImplementation((exe, args, options) => {
      if (change === 'unavailable' && args.includes('ls-remote')) return unknown('Offline');
      const result = runRescueCommand(exe, args, options);
      if (change === 'second read moved' && args.includes('ls-remote') && ++reads === 1)
        git(f.remote, 'update-ref', entry.ref, git(f.primary, 'rev-parse', 'HEAD'));
      return result;
    });
    expect(f.read().state).not.toBe('ok'); expect(f.pushes()).toHaveLength(0);
  });

  it.each(['missing', 'directory', 'symlink', 'JSON', 'schema', 'hash', 'date', 'refs', 'ref', 'sha', 'duplicate', 'unknown key', 'future date', 'missing hash'])('refuses a %s record', corruption => {
    const f = commissioned();
    if (corruption === 'unknown key') Object.assign(f.record, { unexpected: true });
    if (corruption === 'future date') f.record.createdAt = new Date(Date.now() + 6 * 60_000).toISOString();
    if (corruption === 'missing hash') Reflect.deleteProperty(f.record, 'planHash');
    if (corruption === 'schema') f.record.schema = 'unknown';
    if (corruption === 'hash') f.record.planHash = 'unbound';
    if (corruption === 'date') f.record.createdAt = 'not-a-date';
    if (corruption === 'refs') f.record.refs = [];
    if (corruption === 'ref') f.record.refs[0].ref = 'refs/heads/main';
    if (corruption === 'sha') f.record.refs[0].commitSha = 'bad';
    if (corruption === 'duplicate') f.record.refs.push(f.record.refs[0]);
    f.save();
    if (corruption === 'JSON') writeFileSync(f.commissioningPath, '{broken');
    if (['missing', 'directory', 'symlink'].includes(corruption)) unlinkSync(f.commissioningPath);
    if (corruption === 'directory') mkdirSync(f.commissioningPath);
    if (corruption === 'symlink') { const target = join(f.root, 'gate.json'); writeFileSync(target, JSON.stringify(f.record)); symlinkSync(target, f.commissioningPath, 'file'); }
    expect(f.read().state).not.toBe('ok');
    expect(f.runGit).not.toHaveBeenCalled();
  });
});

describe('U5b raw-blob recovery', { timeout: 60_000 }, () => {
  function recoveryFixture() {
    const payloads = [
      { path: '.tmp-intake/crlf.json', bytes: Buffer.from('{"crlf":true}\r\n') },
      { path: '.reproduce-out/lf.json', bytes: Buffer.from('{"lf":true}\n') },
      { path: 'artifacts/github-issue-roadmap/calibration/attributes.json', bytes: Buffer.from('{"attributes":true}\r\n') },
      { path: 'artifacts/github-issue-roadmap/tracked.json', bytes: Buffer.from('{"modified":true}\n') },
    ];
    const f = restoreFixture('recovery', f => {
      const remote = join(f.root, 'remote.git'); mkdirSync(remote);
      put(f.primary, '.gitattributes', 'artifacts/github-issue-roadmap/calibration/** text eol=lf\n');
      git(f.primary, 'add', '.'); git(f.primary, 'commit', '-m', 'LF attributes');
      git(remote, 'init', '--bare', '-b', 'main'); git(f.primary, 'remote', 'add', 'origin', remote); git(f.primary, 'push', 'origin', 'main');
      const path = f.add(); git(path, 'config', 'core.autocrlf', 'true');
      for (const file of payloads) put(path, file.path, file.bytes);
    });
    const remote = join(f.root, 'remote.git'), path = join(f.root, 'candidate');
    const facts = tree(path), options = { repositoryPath: f.primary, reportRoot: join(f.root, 'reports'), remotePath: remote };
    const record = value(publishSnapshot(facts, preflightSnapshot(facts), options));
    const dest = join(f.root, 'recovered');
    return { ...f, path, remote, payloads, options, record, dest };
  }

  it.each(['journal', 'fresh clone'])('recovers exact LF and CRLF bytes under autocrlf=true using %s evidence', async source => {
    const f = recoveryFixture(); let repositoryPath = f.primary;
    if (source === 'fresh clone') {
      repositoryPath = join(f.root, 'clone'); git(f.root, 'clone', '--no-checkout', f.remote, repositoryPath);
      git(repositoryPath, 'config', 'core.autocrlf', 'true');
    }
    const runGit = vi.fn(runRescueCommand), output = vi.spyOn(console, 'log').mockImplementation(() => {});
    output.mockClear();
    const options = { ...f.options, repositoryPath, ...(source === 'fresh clone' ? { reportRoot: join(f.root, 'absent') } : {}), runGit };
    expect(await main(['recover', '--ref', f.record.ref, '--dest', f.dest, '--repo', repositoryPath], {
      recoverSnapshot: (parsed: { ref: string; dest: string; repositoryPath?: string }) => recoverSnapshot({ ...parsed, ...options }),
    })).toBe(0);
    expect(output).toHaveBeenCalledOnce();
    for (const file of f.payloads) {
      expect(readFileSync(join(f.dest, file.path))).toEqual(file.bytes);
      const digest = f.record.files.find((entry: PublishedSnapshotFile) => entry.path === file.path)!.digest;
      expect(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${file.bytes.length}\0`), readFileSync(join(f.dest, file.path))])).digest('hex')).toBe(digest);
    }
    const fetches = runGit.mock.calls.filter(([, args]) => args.includes('fetch'));
    expect(fetches).toHaveLength(1); expect(fetches[0][1]).toContain(`core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
    const temporaryRef = fetches[0][1].at(-1)!.split(':')[1];
    expect(temporaryRef).toMatch(/^refs\/worktree-cleanup\/recover\/[a-f0-9-]+$/);
    expect(fetches[0][1]).toContain('--refmap=');
    expect(runGit.mock.calls.filter(([, args]) => args.includes('update-ref')).map(([, args]) => args.slice(-3))).toEqual([['update-ref', '-d', temporaryRef]]);
    expect(runGit.mock.calls.find(([, args]) => args.includes('update-ref'))![1]).toContain(`core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
    expect(git(repositoryPath, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(git(repositoryPath, 'for-each-ref', 'refs/worktree-cleanup/recover')).toBe('');
    expect(git(f.primary, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(fetches[0][2]?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
    expect(runGit.mock.calls.some(([, args]) => args.includes('checkout') || args.includes('restore'))).toBe(false);
    output.mockRestore();
  });

  it('refuses a non-empty or relative destination before fetching or writing', () => {
    const f = recoveryFixture(), runGit = vi.fn(runRescueCommand);
    mkdirSync(f.dest); put(f.dest, 'keep.txt', 'keep\r\n');
    expect(recoverSnapshot({ ...f.options, ref: f.record.ref, dest: f.dest, runGit })).toMatchObject({ state: 'unknown', reason: expect.stringContaining('empty') });
    expect(readFileSync(join(f.dest, 'keep.txt'), 'utf8')).toBe('keep\r\n'); expect(readdirSync(f.dest)).toEqual(['keep.txt']);
    expect(recoverSnapshot({ ...f.options, ref: f.record.ref, dest: 'relative', runGit }).state).toBe('unknown');
    expect(runGit).not.toHaveBeenCalled();
  });

  it('refuses an unsafe journal path before creating the destination', () => {
    const f = recoveryFixture();
    const saved = JSON.parse(readFileSync(f.record.journalPath, 'utf8')); saved.files[0].path = '../escape';
    writeFileSync(f.record.journalPath, JSON.stringify(saved));
    expect(recoverSnapshot({ ...f.options, ref: f.record.ref, dest: f.dest }).state).toBe('unknown');
    expect(existsSync(f.dest)).toBe(false); expect(existsSync(join(f.root, 'escape'))).toBe(false);
    expect(git(f.primary, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(git(f.primary, 'for-each-ref', 'refs/worktree-cleanup/recover')).toBe('');
  });

  it.each(['fetch failure', 'deadline'])('removes its temporary ref after a %s following fetch', failure => {
    const f = recoveryFixture(); let clock = 0;
    const runGit = vi.fn((exe: string, args: string[], options: Parameters<typeof runRescueCommand>[2]) => {
      const result = runRescueCommand(exe, args, options);
      if (args.includes('fetch')) {
        if (failure === 'fetch failure') return unknown('Injected failure after fetch');
        clock = 1000;
      }
      return result;
    });
    expect(recoverSnapshot({ ...f.options, ref: f.record.ref, dest: f.dest, runGit, softDeadline: 1000, deadlineNow: () => clock }).state).toBe('unknown');
    expect(runGit.mock.calls.filter(([, args]) => args.includes('fetch'))).toHaveLength(1);
    expect(runGit.mock.calls.filter(([, args]) => args.includes('update-ref'))).toHaveLength(1);
    expect(existsSync(f.dest)).toBe(false);
    expect(git(f.primary, 'for-each-ref', 'refs/heads/rescue')).toBe('');
    expect(git(f.primary, 'for-each-ref', 'refs/worktree-cleanup/recover')).toBe('');
  });
});

describe('U4c unfinished snapshot reconciliation', { timeout: 60_000 }, () => {
  it.each(['live', 'empty', 'unparseable', 'stale'])('checks a published continuation journal lock with a %s owner', owner => {
    const f = publicationFixture(); f.publish();
    const lock = `${f.journalPath}.lock`, before = readFileSync(f.journalPath), source = sourceState(f.path);
    const pid = owner === 'live' ? String(process.pid) : owner === 'empty' ? '' : owner === 'unparseable' ? 'unknown' :
      spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }).stdout;
    writeFileSync(lock, pid); f.runGit.mockClear();
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [f.facts] }, { ...f.options, snapshotMutationsEnabled: true }));
    expect(result.worktrees[0]).toMatchObject(owner === 'stale' ? { disposition: 'snapshot', snapshotBound: true } :
      { disposition: 'hold', snapshotBound: true, reasonCode: 'snapshot-pending' });
    if (owner === 'stale') expect(existsSync(lock)).toBe(false);
    else expect(readFileSync(lock, 'utf8')).toBe(pid);
    expect(readFileSync(f.journalPath)).toEqual(before); expect(sourceState(f.path)).toEqual(source); expect(f.pushes()).toHaveLength(0);
  });

  it.each(['live owner', 'empty owner'])('does not bind unrelated trees when a gone journal has a lock with %s', owner => {
    const f = publicationFixture(); f.publish(); finishCopySet(f);
    git(f.primary, 'worktree', 'remove', f.path);
    const unrelated = f.add('unrelated'), lock = `${f.journalPath}.lock`;
    writeFileSync(lock, owner === 'live owner' ? String(process.pid) : '');
    const before = readFileSync(f.journalPath), lockBefore = readFileSync(lock);
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [tree(unrelated)] }, f.options));
    expect(result.worktrees).toEqual([]);
    expect(result.records).toEqual([{ journalPath: f.journalPath, reasonCode: 'unknown' }]);
    expect(readFileSync(f.journalPath)).toEqual(before); expect(readFileSync(lock)).toEqual(lockBefore);
  });

  it.each([
    { state: 'not_pushed', remotes: ['absent'], outcome: 'verified', push: true },
    { state: 'not_pushed', remotes: ['equal'], outcome: 'verified', push: false },
    { state: 'not_pushed', remotes: ['other'], outcome: 'hold', push: false },
    { state: 'pushed_unverified', remotes: ['equal'], outcome: 'verified', push: false },
    { state: 'pushed_unverified', remotes: ['absent', 'other'], outcome: 'hold', push: false },
    { state: 'published_verified', remotes: ['equal'], outcome: 'verified', push: false },
    { state: 'published_verified', remotes: ['absent', 'other'], outcome: 'hold', push: false },
    { state: 'removed', remotes: ['absent', 'equal', 'other'], outcome: 'none', push: false },
  ])('$state / $remotes follows the decision table with and without mutation authority', ({ state, remotes, outcome, push }) => {
    for (const remote of remotes) for (const enabled of [false, true]) {
      const f = publicationFixture(), published = value(f.publish());
      const record = { ...f.journal(), state };
      writeFileSync(f.journalPath, JSON.stringify(record));
      if (remote === 'absent') git(f.remote, 'update-ref', '-d', record.ref);
      if (remote === 'other') git(f.remote, 'update-ref', record.ref, record.head);
      const before = sourceState(f.path), refsBefore = f.refs(), journalBefore = readFileSync(f.journalPath);
      f.runGit.mockClear();
      const observedStates: string[] = [];
      f.runGit.mockImplementation((exe, args, options) => {
        if (args.includes('ls-remote')) observedStates.push(f.journal().state);
        return runRescueCommand(exe, args, options);
      });
      const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [tree(f.path)] },
        { ...f.options, snapshotMutationsEnabled: enabled }));
      expect(f.pushes()).toHaveLength(enabled && push ? 1 : 0);
      expect(f.refs()).not.toContain(record.ref + '-2');
      expect(sourceState(f.path)).toEqual(before);
      expect(f.runGit.mock.calls.some(([, args]) => args.includes('remove'))).toBe(false);
      if (outcome === 'none') {
        expect(result.worktrees).toEqual([]); expect(result.records).toEqual([]);
        expect(observedStates).toEqual([]); expect(readFileSync(f.journalPath)).toEqual(journalBefore);
      } else {
        const verified = outcome === 'verified' && (enabled || !push);
        expect(result.worktrees).toHaveLength(1);
        expect(result.worktrees[0]).toMatchObject({ path: f.path, snapshotBound: true, journalPath: f.journalPath,
          disposition: verified && enabled ? 'snapshot' : 'hold',
          head: published.head, branch: published.branch, snapshotRecord: { ref: published.ref, commitSha: published.commitSha } });
        if (!enabled || !verified) expect(result.worktrees[0].reasonCode).toBe(outcome === 'hold' ? 'snapshot-unverified' : 'snapshot-pending');
        expect(f.journal().state).toBe(verified ? 'published_verified' : state);
        if (outcome === 'hold') expect(readFileSync(f.journalPath)).toEqual(journalBefore);
        if (verified) {
          // The not_pushed/equal row advances without a push, then U4a's resume
          // performs its two independent reads at pushed_unverified.
          expect(observedStates.slice(-2)).toEqual([state === 'published_verified' ? state : 'pushed_unverified',
            state === 'published_verified' ? state : 'pushed_unverified']);
        }
      }
      expect(f.refs()).toBe(enabled && push ? `${record.ref} ${record.commitSha}` : refsBefore);
    }
  });

  it.each(['pushed_unverified', 'published_verified'])('holds %s when only the second read diverges', state => {
    const f = publicationFixture(), published = value(f.publish());
    writeFileSync(f.journalPath, JSON.stringify({ ...f.journal(), state })); f.runGit.mockClear();
    let reads = 0;
    f.runGit.mockImplementation((exe, args, options) => {
      const result = runRescueCommand(exe, args, options);
      if (args.includes('ls-remote') && ++reads === 1) git(f.remote, 'update-ref', published.ref, published.head);
      return result;
    });
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [f.facts] }, { ...f.options, snapshotMutationsEnabled: true }));
    expect(result.worktrees[0]).toMatchObject({ disposition: 'hold', reasonCode: 'snapshot-unverified' });
    expect(reads).toBe(2); expect(f.pushes()).toHaveLength(0); expect(f.refs()).not.toContain(published.ref + '-2');
    expect(f.journal().state).toBe(state);
  });

  it('defaults to no publication and retains the journaled commit when its ref is absent', () => {
    const f = publicationFixture(), record = value(f.publish());
    git(f.remote, 'update-ref', '-d', record.ref);
    writeFileSync(f.journalPath, JSON.stringify({ ...f.journal(), state: 'not_pushed' })); f.runGit.mockClear();
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [f.facts] }, f.options));
    expect(result.worktrees[0]).toMatchObject({ disposition: 'hold', snapshotBound: true, reasonCode: 'snapshot-pending',
      snapshotRecord: { state: 'not_pushed', commitSha: record.commitSha } });
    expect(f.pushes()).toHaveLength(0); expect(f.refs()).toBe(''); expect(f.journal().state).toBe('not_pushed');
  });

  it('carries persisted cleanup progress to the snapshot removal decision', () => {
    const f = publicationFixture(), record = value(f.publish()), progress = finishCopySet(f);
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [tree(f.path)] },
      { ...f.options, snapshotMutationsEnabled: true }));
    expect(result.worktrees[0]).toMatchObject({ disposition: 'snapshot', snapshotBound: true, head: record.head, branch: record.branch,
      snapshotRecord: { state: 'published_verified', progress } });
    expect(result.worktrees[0].record).toBe(result.worktrees[0].snapshotRecord);
  });

  it.each(['not_pushed', 'pushed_unverified', 'published_verified'])('keeps dry-run %s journals byte-identical without object or index writes', state => {
    const f = publicationFixture(); f.publish();
    writeFileSync(f.journalPath, JSON.stringify({ ...f.journal(), state }));
    const before = readFileSync(f.journalPath), sourceBefore = savedState(f.path); f.runGit.mockClear();
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [f.facts] },
      { ...f.options, snapshotMutationsEnabled: true, dryRun: true }));
    expect(result.worktrees[0]).toMatchObject({ disposition: 'hold', reasonCode: 'snapshot-pending' });
    expect(readFileSync(f.journalPath)).toEqual(before); expect(f.pushes()).toHaveLength(0);
    expect(savedState(f.path)).toEqual(sourceBefore);
    expect(f.runGit.mock.calls.some(([, args]) => ['read-tree', 'update-index', 'write-tree', 'hash-object', 'commit-tree', 'update-ref']
      .some(command => args.includes(command)))).toBe(false);
    expect(existsSync(`${f.journalPath}.lock`)).toBe(false);
  });

  it.each(['JSON', 'schema', 'state', 'identity', 'foreign path', 'progress'])('holds a malformed or foreign %s record without changing it', corruption => {
    const f = publicationFixture(); f.publish();
    const record = f.journal();
    if (corruption === 'schema') record.schema = 'unknown';
    if (corruption === 'state') record.state = 'finished';
    if (corruption === 'identity') record.identity = JSON.stringify(['other repository', f.remote]);
    if (corruption === 'foreign path') record.treePath = normalizePath(join(f.root, 'foreign'));
    if (corruption === 'progress') record.progress = { cleaned: ['outside-copy-set.json'], restored: [] };
    writeFileSync(f.journalPath, corruption === 'JSON' ? '{broken' : JSON.stringify(record));
    const before = readFileSync(f.journalPath), source = sourceState(f.path); f.runGit.mockClear();
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [f.facts] }, f.options));
    expect(result.worktrees[0]).toMatchObject({ path: f.path, disposition: 'hold', snapshotBound: true,
      reasonCode: 'unknown', journalPath: f.journalPath });
    expect(result.records).toContainEqual({ journalPath: f.journalPath, reasonCode: 'unknown' });
    expect(readFileSync(f.journalPath)).toEqual(before); expect(f.pushes()).toHaveLength(0);
    expect(sourceState(f.path)).toEqual(source);
  });

  // normalizePath lowercases on every OS, so a present directory resolves from
  // its journal path only on case-insensitive Windows, the tool's sole platform.
  it.each(process.platform === 'win32' ? [false, true] : [false])('marks an unregistered tree removed only when its directory is absent: exists=%s', present => {
    const f = publicationFixture(); f.publish(); finishCopySet(f);
    git(f.primary, 'worktree', 'remove', f.path);
    if (present) mkdirSync(f.path);
    const before = readFileSync(f.journalPath); f.runGit.mockClear();
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [] }, f.options));
    expect(f.journal().state).toBe(present ? 'published_verified' : 'removed');
    expect(f.pushes()).toHaveLength(0); expect(existsSync(f.journalPath)).toBe(true);
    if (present) {
      expect(result.worktrees[0]).toMatchObject({ disposition: 'hold', reasonCode: 'snapshot-unverified' });
      expect(readFileSync(f.journalPath)).toEqual(before); expect(existsSync(f.path)).toBe(true);
    } else expect(result.worktrees).toEqual([]);
  });

  // Same reason: the lowercased journal path finds the directory only on Windows.
  it.skipIf(process.platform !== 'win32')('reports an existing foreign tree as unknown, including its record path', () => {
    const f = publicationFixture(); f.publish();
    const foreign = join(f.root, 'foreign'); mkdirSync(foreign);
    writeFileSync(f.journalPath, JSON.stringify({ ...f.journal(), treePath: normalizePath(foreign) }));
    const before = readFileSync(f.journalPath);
    const result = value(reconcileSnapshots({ primaryPath: f.primary, worktrees: [f.facts] }, f.options));
    expect(result.worktrees).toContainEqual(expect.objectContaining({ path: normalizePath(foreign),
      disposition: 'hold', reasonCode: 'unknown', journalPath: f.journalPath }));
    expect(existsSync(foreign)).toBe(true); expect(readFileSync(f.journalPath)).toEqual(before);
  });
});

describe('U4b snapshot verification and journal helpers', { timeout: 60_000 }, () => {
  it.each(['equal', 'deleted', 'moved', 'second read moved', 'not_pushed', 'pushed_unverified', 'removed'])(
    'requires two independent reads of a published record: %s', state => {
      const f = publicationFixture(), record = value(f.publish()), before = sourceState(f.path);
      if (state === 'deleted') git(f.remote, 'update-ref', '-d', record.ref);
      if (state === 'moved') git(f.remote, 'update-ref', record.ref, record.head);
      if (['not_pushed', 'pushed_unverified', 'removed'].includes(state)) record.state = state;
      f.runGit.mockClear();
      let reads = 0;
      f.runGit.mockImplementation((exe, args, options) => {
        const result = runRescueCommand(exe, args, options);
        if (args.includes('ls-remote') && ++reads === 1 && state === 'second read moved') git(f.remote, 'update-ref', record.ref, record.head);
        return result;
      });
      const result = verifySnapshotRecord(record, { ...f.options, repositoryPath: f.primary });
      expect(result.state).toBe(state === 'equal' ? 'ok' : 'negative');
      expect(reads).toBe(record.state === 'published_verified' ? 2 : 0);
      expect(sourceState(f.path)).toEqual(before);
      for (const [, args, options] of f.runGit.mock.calls.filter(([, args]) => args.includes('ls-remote'))) {
        expect(args).toContain('protocol.allow=never'); expect(args).toContain('protocol.file.allow=always');
        expect(args).toContain('credential.helper='); expect(args).toContain(record.ref);
        expect(options?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' });
      }
      expect(f.runGit.mock.calls.some(([, args]) => args.includes('push'))).toBe(false);
    },
  );

  it.each(['digest', 'path'])('rejects a record %s absent from the verified commit tree', change => {
    const f = publicationFixture(), record = value(f.publish()), before = sourceState(f.path);
    if (change === 'digest') record.files[0].digest = git(f.primary, 'rev-parse', `${record.head}:artifacts/github-issue-roadmap/tracked.json`);
    else record.files[0].path = '.tmp-intake/not-committed.json';
    f.runGit.mockClear();
    expect(verifySnapshotRecord(record, { ...f.options, repositoryPath: f.primary })).toMatchObject({ state: 'negative', veto: 'snapshot-unverified' });
    const trees = f.runGit.mock.calls.filter(([, args]) => args.includes('ls-tree'));
    expect(trees).toHaveLength(1);
    expect(trees[0][1]).toEqual(expect.arrayContaining(['ls-tree', '-r', '-z', record.commitSha]));
    expect(trees[0][2]?.env).toMatchObject({ GIT_NO_REPLACE_OBJECTS: '1', GIT_CONFIG_NOSYSTEM: '1' });
    expect(sourceState(f.path)).toEqual(before);
  });

  it('persists intent, preserves it on retry, and clears it only with completed progress', () => {
    const f = publicationFixture(), record = value(f.publish()), root = dirname(f.journalPath);
    const file = record.files.find((file: PublishedSnapshotFile) => file.kind === 'ignored')!;
    const intent = { treePath: f.path, cleaned: [], restored: [], inFlight: { path: file.path, kind: file.kind } };
    expect(markSnapshotProgress(root, intent).state).toBe('ok');
    expect(f.journal().progress).toEqual({ cleaned: [], restored: [], inFlight: intent.inFlight });
    expect(markSnapshotProgress(root, intent).state).toBe('ok');
    const before = readFileSync(f.journalPath);
    for (const inFlight of [undefined, { path: '../other', kind: 'ignored' }, { path: file.path, kind: 'modified' },
      { path: record.files.find((other: PublishedSnapshotFile) => other.path !== file.path)!.path, kind: 'untracked' }]) {
      expect(markSnapshotProgress(root, { ...intent, inFlight }).state).toBe('negative');
      expect(readFileSync(f.journalPath)).toEqual(before);
    }
    expect(markSnapshotProgress(root, { ...intent, cleaned: [file.path] }).state).toBe('negative');
    expect(markSnapshotProgress(root, { treePath: f.path, cleaned: [file.path], restored: [] }).state).toBe('ok');
    expect(f.journal().progress).toEqual({ cleaned: [file.path], restored: [] });
  });

  it('atomically records cumulative progress and removal without buffers, preserving publication metadata', () => {
    const f = publicationFixture(), record = value(f.publish()), root = dirname(f.journalPath);
    const plain = record.files.filter((file: PublishedSnapshotFile) => file.kind !== 'modified').map((file: PublishedSnapshotFile) => file.path);
    const modified = record.files.find((file: PublishedSnapshotFile) => file.kind === 'modified')!;
    for (const path of plain) unlinkSync(join(f.path, path));
    expect(markSnapshotProgress(root, { treePath: f.path, cleaned: plain, restored: [] }).state).toBe('ok');
    git(f.path, 'restore', '--source=HEAD', '--staged', '--worktree', '--', modified.path);
    const { fingerprint, sha256 } = regularBytes(join(f.path, modified.path));
    const progress = { cleaned: [...plain, modified.path], restored: [{ path: modified.path, fingerprint, sha256 }] };
    expect(markSnapshotProgress(root, { treePath: f.path, ...progress }).state).toBe('ok');
    const metadata = { ...record }; delete metadata.journalPath;
    expect(f.journal()).toEqual({ ...metadata, progress });
    expect(readFileSync(f.journalPath, 'utf8')).not.toContain('"bytes"');
    git(f.primary, 'worktree', 'remove', f.path);
    expect(markSnapshotRemoved(root, f.path).state).toBe('ok');
    expect(f.journal()).toEqual({ ...metadata, progress, state: 'removed' });
    expect(readdirSync(root)).toEqual([f.journalPath.split(sep).at(-1)]);
  });

  it.each(['unknown path', 'duplicate', 'missing fingerprint', 'wrong state', 'locked', 'incomplete removal', 'regression', 'changed fingerprint'])(
    'refuses invalid journal updates without changing the record: %s', failure => {
      const f = publicationFixture(), record = value(f.publish()), root = dirname(f.journalPath);
      const modified = record.files.find((file: PublishedSnapshotFile) => file.kind === 'modified')!;
      const { fingerprint, sha256 } = regularBytes(join(f.path, modified.path));
      let update = { treePath: f.path, cleaned: [record.files[0].path], restored: [] as { path: string, fingerprint: number[], sha256: string }[] };
      if (failure === 'unknown path') update.cleaned = ['../other'];
      if (failure === 'duplicate') update.cleaned.push(update.cleaned[0]);
      if (failure === 'missing fingerprint') update.cleaned = [modified.path];
      if (failure === 'wrong state') writeFileSync(f.journalPath, JSON.stringify({ ...f.journal(), state: 'pushed_unverified' }));
      if (failure === 'locked') writeFileSync(f.journalPath + '.lock', String(process.pid));
      if (failure === 'regression' || failure === 'changed fingerprint') {
        const saved = { treePath: f.path, cleaned: [modified.path], restored: [{ path: modified.path, fingerprint, sha256 }] };
        expect(markSnapshotProgress(root, saved).state).toBe('ok');
        update = failure === 'regression' ? { treePath: f.path, cleaned: [], restored: [] } :
          { ...saved, restored: [{ ...saved.restored[0], sha256: '0'.repeat(64) }] };
      }
      const before = readFileSync(f.journalPath);
      const result = failure === 'incomplete removal' ? markSnapshotRemoved(root, f.path) : markSnapshotProgress(root, update);
      expect(result.state).toBe('negative'); expect(readFileSync(f.journalPath)).toEqual(before);
      if (failure === 'locked') unlinkSync(f.journalPath + '.lock');
      expect(readdirSync(root)).toHaveLength(1);
    },
  );
});

describe('U4a snapshot publication to a local bare origin', { timeout: 60_000 }, () => {
  it('publishes exactly HEAD plus scanned blobs, preserves byte endings and source state, and journals metadata only', () => {
    const f = publicationFixture(), before = sourceState(f.path), admitted = value(f.preflight), published = value(f.publish());
    expect(published).toMatchObject({ state: 'published_verified', head: before.head, branch: null,
      ref: 'refs/heads/rescue/candidate-2026-10-13', treePath: normalizePath(f.path), journalPath: f.journalPath });
    expect(f.refs()).toBe(`${published.ref} ${published.commitSha}`);
    const base = new Map(git(f.path, 'ls-tree', '-r', before.head).split('\n').map(line => [line.split('\t')[1], line]));
    for (const file of admitted.files) {
      const mode = file.kind === 'modified' ? '100755' : '100644';
      base.set(file.path, `${mode} blob ${file.digest}\t${file.path}`);
      const blob = spawnSync('git', ['-C', f.remote, 'cat-file', 'blob', `${published.commitSha}:${file.path}`], { env, windowsHide: true });
      expect(blob.status).toBe(0); expect(blob.stdout).toEqual(file.bytes);
      expect(readFileSync(join(f.path, file.path))).toEqual(file.bytes);
    }
    expect(git(f.remote, 'ls-tree', '-r', published.commitSha).split('\n').sort()).toEqual([...base.values()].sort());
    expect(git(f.remote, 'rev-list', '--parents', '-n', '1', published.commitSha)).toBe(`${published.commitSha} ${before.head}`);
    const message = git(f.remote, 'show', '-s', '--format=%B', published.commitSha);
    expect(message).toContain(f.path); expect(message).toContain('(detached)'); expect(message).toContain(before.head);
    expect(git(f.remote, 'show', '-s', '--format=%an <%ae>|%cn <%ce>', published.commitSha))
      .toBe('Workflow tools Snapshot Publisher <snapshot@localhost.invalid>|Workflow tools Snapshot Publisher <snapshot@localhost.invalid>');
    expect(sourceState(f.path)).toEqual(before);
    const journal = readFileSync(f.journalPath, 'utf8');
    expect(f.journal().state).toBe('published_verified'); expect(journal).not.toContain('"bytes"');
    for (const file of f.payloads) expect(journal).not.toContain(file.bytes.toString().trim());
    const pushIndex = f.runGit.mock.calls.findIndex(([, args]) => args.includes('push'));
    expect(f.runGit.mock.calls.slice(pushIndex + 1).filter(([, args]) => args.includes('ls-remote'))).toHaveLength(2);
    expect(f.pushes()[0][1]).toContain(`core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`);
    expect(f.pushes()[0][1]).toContain(`--force-with-lease=${published.ref}:`);
    expect(f.runGit.mock.calls.every(([, args]) => !args.includes('--force'))).toBe(true);
  });

  it('checks source freshness with the same global config as inventory, while keeping publication isolated', () => {
    const f = publicationFixture(), home = join(f.root, 'home'), config = join(home, '.gitconfig'), excludes = join(home, 'excludes');
    mkdirSync(home); writeFileSync(excludes, 'global.json\n');
    git(f.path, 'config', '--file', config, 'core.autocrlf', 'true');
    git(f.path, 'config', '--file', config, 'core.excludesFile', excludes);
    git(f.path, 'config', '--unset', 'core.autocrlf');
    vi.stubEnv('GIT_CONFIG_GLOBAL', config);
    // Inventory strips every GIT_* variable, including the explicit config path.
    // HOME locates that same temporary global config after sanitizing the environment.
    vi.stubEnv('HOME', home); vi.stubEnv('XDG_CONFIG_HOME', home);
    try {
      const inspectionEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), NODE_ENV: process.env.NODE_ENV,
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
      const inspect = (...args: string[]) => {
        const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', f.path, ...args],
          { env: inspectionEnv, encoding: 'utf8', windowsHide: true });
        expect(result.status, result.stderr).toBe(0); return result.stdout;
      };
      put(f.path, 'tracked.txt', 'tracked CRLF checkout\r\n');
      inspect('add', 'tracked.txt'); inspect('commit', '-m', 'tracked CRLF checkout');
      expect(readFileSync(join(f.path, 'tracked.txt'), 'utf8')).toBe('tracked CRLF checkout\r\n');
      expect(inspect('show', 'HEAD:tracked.txt')).toBe('tracked CRLF checkout\n');
      put(f.path, '.tmp-intake/global.json', '{"global":true}\n');
      const statusArgs = ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'];
      const forceRehash = () => {
        const indexMtime = lstatSync(git(f.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index')).mtimeMs;
        const afterIndex = new Date(indexMtime + 10_000);
        utimesSync(join(f.path, 'tracked.txt'), afterIndex, afterIndex);
      };
      forceRehash();
      const status = parseStatus(inspect(...statusArgs)), facts = tree(f.path);
      const entries = status.filter(entry => entry.index !== '!'), ignored = status.filter(entry => entry.index === '!').map(entry => entry.path);
      facts.status = ok({ clean: entries.length === 0, entries }); facts.ignored = ok({ entries: ignored, unexpected: ignored });
      expect(status.some(entry => entry.path === 'tracked.txt')).toBe(false);
      expect(status).toContainEqual({ index: '!', worktree: '!', path: '.tmp-intake/global.json' });
      forceRehash();
      const isolated = spawnSync('git', ['-C', f.path, ...statusArgs], { encoding: 'utf8', windowsHide: true,
        env: { ...inspectionEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } });
      expect(isolated.status, isolated.stderr).toBe(0);
      const isolatedStatus = parseStatus(isolated.stdout);
      // The former freshness environment invents a tracked edit outside scratch
      // and changes the globally ignored file's kind, so it refuses this admission.
      expect(isolatedStatus).toContainEqual({ index: ' ', worktree: 'M', path: 'tracked.txt' });
      expect(isolatedStatus).toContainEqual({ index: '?', worktree: '?', path: '.tmp-intake/global.json' });
      expect(value(publishSnapshot(facts, preflightSnapshot(facts), f.options)).state).toBe('published_verified');
      const freshness = f.runGit.mock.calls.find(([, args]) => args.includes('status'))!;
      expect(freshness[2]?.env).toEqual(inspectionEnv);
      for (const [, args, options] of f.runGit.mock.calls) {
        if (!args.some(arg => ['hash-object', 'read-tree', 'update-index', 'write-tree', 'commit-tree', 'check-ref-format', 'ls-remote', 'push'].includes(arg))) continue;
        expect(options?.env).toMatchObject({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' });
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it('publishes a recreated worktree on a new HEAD and preserves removed snapshot history and refs', () => {
    const f = publicationFixture(), first = value(f.publish());
    writeFileSync(f.journalPath, JSON.stringify({ ...f.journal(), state: 'removed' }));
    git(f.primary, 'worktree', 'remove', '--force', f.path);
    git(f.primary, 'commit', '--allow-empty', '-m', 'new worktree base');
    git(f.primary, 'worktree', 'add', '--detach', f.path, 'HEAD');
    const file = '.tmp-intake/new.json', contents = '{"new":true}\n'; put(f.path, file, contents);
    const facts = tree(f.path), published = value(publishSnapshot(facts, preflightSnapshot(facts), f.options));
    expect(published).toMatchObject({ ref: `${first.ref}-2`, state: 'published_verified', head: value(facts.registration).head,
      history: [{ ref: first.ref, commitSha: first.commitSha, head: first.head }] });
    expect(published.head).not.toBe(first.head); expect(published.commitSha).not.toBe(first.commitSha);
    expect(git(f.remote, 'rev-parse', first.ref)).toBe(first.commitSha);
    expect(git(f.remote, 'rev-parse', published.ref)).toBe(published.commitSha);
    expect(git(f.remote, 'show', `${published.ref}:${file}`)).toBe(contents.trimEnd());
    expect(f.journal().history).toEqual(published.history);
  });

  it('skips the removed snapshot history even when its old remote ref was deleted', () => {
    const f = publicationFixture(), first = value(f.publish());
    writeFileSync(f.journalPath, JSON.stringify({ ...f.journal(), state: 'removed' }));
    git(f.remote, 'update-ref', '-d', first.ref);
    git(f.primary, 'worktree', 'remove', '--force', f.path);
    git(f.primary, 'commit', '--allow-empty', '-m', 'new worktree base');
    git(f.primary, 'worktree', 'add', '--detach', f.path, 'HEAD');
    const file = '.tmp-intake/new.json', contents = '{"new":true}\n'; put(f.path, file, contents);
    const facts = tree(f.path), published = value(publishSnapshot(facts, preflightSnapshot(facts), f.options));
    expect(published).toMatchObject({ ref: `${first.ref}-2`, state: 'published_verified', head: value(facts.registration).head,
      history: [{ ref: first.ref, commitSha: first.commitSha, head: first.head }] });
    expect(published.head).not.toBe(first.head); expect(published.commitSha).not.toBe(first.commitSha);
    expect(f.refs()).toBe(`${published.ref} ${published.commitSha}`);
    expect(git(f.remote, 'rev-parse', published.ref)).toBe(published.commitSha);
    expect(git(f.remote, 'show', `${published.ref}:${file}`)).toBe(contents.trimEnd());
    expect(f.journal().history).toEqual(published.history);
  });

  it('returns a removed record unchanged with null admission', () => {
    const f = publicationFixture(); f.publish();
    const removed = { ...f.journal(), state: 'removed' }; writeFileSync(f.journalPath, JSON.stringify(removed));
    for (const file of f.payloads) unlinkSync(join(f.path, file.path));
    f.runGit.mockClear();
    expect(value(publishSnapshot(f.facts, null, f.options))).toEqual({ ...removed, journalPath: f.journalPath });
    expect(f.journal()).toEqual(removed);
    expect(f.runGit.mock.calls.some(([, args]) => args.some(arg => ['status', 'hash-object', 'commit-tree', 'ls-remote', 'push'].includes(arg)))).toBe(false);
  });

  it('allocates -2 without changing an existing ref, using the UTC date', () => {
    const f = publicationFixture(), head = git(f.remote, 'rev-parse', 'main'), original = 'refs/heads/rescue/candidate-2026-10-13';
    git(f.remote, 'update-ref', original, head); f.options.now = '2026-10-12T22:00:00-04:00';
    expect(value(f.publish()).ref).toBe(`${original}-2`); expect(git(f.remote, 'rev-parse', original)).toBe(head);
  });

  it('vetoes an invalid tree-name without pushing any objects', () => {
    const f = publicationFixture('invalid..name'), before = git(f.remote, 'count-objects', '-v');
    expect(f.publish()).toMatchObject({ state: 'negative', veto: 'snapshot-invalid-ref-name' });
    expect(f.refs()).toBe(''); expect(f.pushes()).toHaveLength(0); expect(existsSync(f.journalPath)).toBe(false);
    expect(git(f.remote, 'count-objects', '-v')).toBe(before);
  });

  it.each(['source bytes', 'buffer bytes', 'HEAD', 'new path', 'deleted path', 'new outside path'])('refuses changed %s before publication', change => {
    const f = publicationFixture(), admitted = value(f.preflight);
    if (change === 'source bytes') put(f.path, admitted.files[0].path, '{"different":true}\n');
    if (change === 'buffer bytes') admitted.files[0].bytes.fill(0x61);
    if (change === 'HEAD') git(f.path, 'commit', '--allow-empty', '-m', 'new HEAD');
    if (change === 'new path') put(f.path, '.tmp-intake/new.json', '{}');
    if (change === 'deleted path') unlinkSync(join(f.path, admitted.files[0].path));
    if (change === 'new outside path') put(f.path, 'outside.json', '{}');
    expect(f.publish()).toMatchObject({ state: 'negative', veto: 'snapshot-publication-refused' });
    expect(f.refs()).toBe(''); expect(f.pushes()).toHaveLength(0); expect(existsSync(f.journalPath)).toBe(false);
  });

  it('checks freshness immediately before commit-tree, after writing the private tree', () => {
    const f = publicationFixture();
    f.runGit.mockImplementation((executable, args, options) => {
      const result = runRescueCommand(executable, args, options);
      if (args.includes('write-tree')) put(f.path, f.payloads[0].path, '{"changed":true}');
      return result;
    });
    expect(f.publish()).toMatchObject({ state: 'negative' });
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('commit-tree'))).toBe(false); expect(f.refs()).toBe('');
  });

  it('keeps not_pushed on push failure and resumes the same commit without rereading source or allocating -2', () => {
    const f = publicationFixture();
    f.runGit.mockImplementation((executable, args, options) => args.includes('push') ? unknown('injected failure') : runRescueCommand(executable, args, options));
    expect(f.publish()).toMatchObject({ veto: 'snapshot-unverified', journalState: 'not_pushed' });
    const pending = f.journal(); expect(f.refs()).toBe('');
    for (const file of f.payloads) unlinkSync(join(f.path, file.path));
    f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear();
    expect(value(publishSnapshot(f.facts, null, f.options))).toMatchObject({ commitSha: pending.commitSha, ref: pending.ref, state: 'published_verified' });
    expect(f.pushes()).toHaveLength(1); expect(f.refs()).toBe(`${pending.ref} ${pending.commitSha}`);
    expect(f.runGit.mock.calls.some(([, args]) => args.includes('status') || args.includes('hash-object') || args.includes('commit-tree'))).toBe(false);
  });

  it('rejects a ref created between allocation and push, then holds the divergent pending snapshot', () => {
    const f = publicationFixture(), other = git(f.remote, 'rev-parse', 'main');
    let pushResult: ReturnType<typeof runRescueCommand> | undefined;
    f.runGit.mockImplementation((executable, args, options) => {
      if (args.includes('push')) {
        const pending = f.journal(); expect(pending.state).toBe('not_pushed');
        expect(git(f.path, 'merge-base', '--is-ancestor', other, pending.commitSha)).toBe('');
        // Without the empty lease this is a valid fast-forward and overwrites the racing ref.
        git(f.remote, 'update-ref', pending.ref, other);
        pushResult = runRescueCommand(executable, args, options); return pushResult;
      }
      return runRescueCommand(executable, args, options);
    });
    expect(f.publish()).toMatchObject({ veto: 'snapshot-unverified', journalState: 'not_pushed' });
    expect(pushResult).toBeDefined(); expect(pushResult?.state).not.toBe('ok');
    const pending = f.journal(); expect(pending.state).toBe('not_pushed');
    expect(f.refs()).toBe(`${pending.ref} ${other}`);
    f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear();
    expect(publishSnapshot(f.facts, null, f.options)).toMatchObject({ veto: 'snapshot-unverified', journalState: 'not_pushed' });
    expect(f.journal()).toEqual(pending); expect(f.pushes()).toHaveLength(0); expect(f.refs()).toBe(`${pending.ref} ${other}`);
  });

  it('resumes a crash after push and before read-back without a second push', () => {
    const f = publicationFixture(), afterPush = () => { throw new Error('stop after durable push state'); };
    expect(publishSnapshot(f.facts, f.preflight, { ...f.options, afterPush })).toMatchObject({ journalState: 'pushed_unverified' });
    const pending = f.journal(); expect(pending.state).toBe('pushed_unverified');
    const pushIndex = f.runGit.mock.calls.findIndex(([, args]) => args.includes('push'));
    expect(f.runGit.mock.calls.slice(pushIndex + 1).some(([, args]) => args.includes('ls-remote'))).toBe(false);
    f.runGit.mockClear();
    expect(value(f.publish())).toMatchObject({ state: 'published_verified', commitSha: pending.commitSha, ref: pending.ref });
    expect(f.pushes()).toHaveLength(0);
    expect(f.runGit.mock.calls.filter(([, args]) => args.includes('ls-remote'))).toHaveLength(2);
  });

  it('resumes a crash during push with the ref present but not_pushed still durable', () => {
    const f = publicationFixture();
    f.runGit.mockImplementation((executable, args, options) => {
      const result = runRescueCommand(executable, args, options);
      if (args.includes('push')) { expect(result.state).toBe('ok'); throw new Error('crash during push'); }
      return result;
    });
    expect(f.publish()).toMatchObject({ journalState: 'not_pushed' });
    const pending = f.journal(); expect(f.refs()).toBe(`${pending.ref} ${pending.commitSha}`);
    f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear();
    expect(value(f.publish())).toMatchObject({ state: 'published_verified', ref: pending.ref, commitSha: pending.commitSha });
    expect(f.pushes()).toHaveLength(0);
  });

  it.each(['not_pushed', 'pushed_unverified'])('holds a divergent remote ref at %s', state => {
    const f = publicationFixture();
    if (state === 'not_pushed') f.runGit.mockImplementation((executable, args, options) => args.includes('push') ? unknown('push failed') : runRescueCommand(executable, args, options));
    publishSnapshot(f.facts, f.preflight, { ...f.options, afterPush: () => { throw new Error('stop'); } });
    const pending = f.journal(); expect(pending.state).toBe(state);
    const other = git(f.remote, 'rev-parse', 'main'); git(f.remote, 'update-ref', pending.ref, other);
    f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear();
    expect(f.publish()).toMatchObject({ state: 'negative', veto: 'snapshot-unverified', journalState: state });
    expect(f.journal()).toEqual(pending); expect(f.pushes()).toHaveLength(0); expect(f.refs()).toBe(`${pending.ref} ${other}`);
  });

  it('holds when the second independent read disagrees', () => {
    const f = publicationFixture(); let pushed = false, reads = 0;
    f.runGit.mockImplementation((executable, args, options) => {
      if (pushed && args.includes('ls-remote') && ++reads === 2) return ok(`${'a'.repeat(40)}\t${args.at(-1)}\n`);
      const result = runRescueCommand(executable, args, options);
      if (args.includes('push')) pushed = true;
      return result;
    });
    expect(f.publish()).toMatchObject({ veto: 'snapshot-unverified', journalState: 'pushed_unverified' });
    expect(reads).toBe(2); expect(f.journal().state).toBe('pushed_unverified');
  });

  it('never republishes a deleted pushed_unverified ref under any name', () => {
    const f = publicationFixture();
    publishSnapshot(f.facts, f.preflight, { ...f.options, afterPush: () => { throw new Error('stop'); } });
    const pending = f.journal(); git(f.remote, 'update-ref', '-d', pending.ref); f.runGit.mockClear();
    expect(f.publish()).toMatchObject({ veto: 'snapshot-unverified', journalState: 'pushed_unverified' });
    expect(f.journal()).toEqual(pending); expect(f.pushes()).toHaveLength(0); expect(f.refs()).toBe('');
  });

  it('reads twice and holds a deleted published_verified ref without changing its state', () => {
    const f = publicationFixture(); f.publish(); const published = f.journal();
    expect(published.state).toBe('published_verified');
    git(f.remote, 'update-ref', '-d', published.ref); f.runGit.mockClear();
    expect(publishSnapshot(f.facts, null, f.options)).toMatchObject({ veto: 'snapshot-unverified', journalState: 'published_verified' });
    expect(f.runGit.mock.calls.filter(([, args]) => args.includes('ls-remote'))).toHaveLength(2);
    expect(f.journal()).toEqual(published); expect(f.pushes()).toHaveLength(0); expect(f.refs()).toBe('');
  });

  it('holds a pending journal if its recorded blob is missing, without re-reading the admitted bytes', () => {
    const f = publicationFixture();
    f.runGit.mockImplementation((executable, args, options) => args.includes('push') ? unknown('push failed') : runRescueCommand(executable, args, options));
    f.publish(); const pending = f.journal(), digest = pending.files[0].digest;
    const object = join(f.primary, '.git', 'objects', digest.slice(0, 2), digest.slice(2));
    chmodSync(object, 0o600); unlinkSync(object); f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear();
    expect(f.publish()).toMatchObject({ veto: 'snapshot-unverified', journalState: 'not_pushed' });
    expect(f.pushes()).toHaveLength(0); expect(f.journal()).toEqual(pending);
  });

  it('rejects ambiguous ls-remote rows and a mismatched origin', () => {
    const f = publicationFixture();
    f.runGit.mockImplementation((executable, args, options) => args.includes('ls-remote')
      ? ok(`${'a'.repeat(40)}\t${args.at(-1)}\n${'b'.repeat(40)}\t${args.at(-1)}\n`) : runRescueCommand(executable, args, options));
    expect(f.publish()).toMatchObject({ state: 'negative' }); expect(f.pushes()).toHaveLength(0);
    f.runGit.mockImplementation(runRescueCommand); git(f.path, 'remote', 'set-url', 'origin', f.primary);
    expect(f.publish()).toMatchObject({ state: 'negative' }); expect(f.pushes()).toHaveLength(0);
  });

  it('binds admission to the HEAD it actually scanned even if the caller updates registration', () => {
    const f = publicationFixture(); git(f.path, 'commit', '--allow-empty', '-m', 'moved');
    value(f.facts.registration).head = git(f.path, 'rev-parse', 'HEAD');
    expect(f.publish()).toMatchObject({ state: 'negative' }); expect(f.pushes()).toHaveLength(0);
  });

  it('holds live journal locks and recovers a dead owner without changing the pending commit', () => {
    const f = publicationFixture();
    f.runGit.mockImplementation((executable, args, options) => args.includes('push') ? unknown('push failed') : runRescueCommand(executable, args, options));
    f.publish(); const pending = f.journal(), lock = `${f.journalPath}.lock`;
    writeFileSync(lock, String(process.pid)); f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear();
    expect(f.publish()).toMatchObject({ state: 'negative' }); expect(f.pushes()).toHaveLength(0); expect(f.journal()).toEqual(pending);
    writeFileSync(lock, '2147483647');
    expect(value(f.publish())).toMatchObject({ state: 'published_verified', commitSha: pending.commitSha });
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dirname(f.journalPath))).toEqual([f.journalPath.split(sep).at(-1)]);
  });

  it('refuses a journal under the source tree and a linked source file introduced after preflight', () => {
    const f = publicationFixture(), before = sourceState(f.path);
    expect(publishSnapshot(f.facts, f.preflight, { ...f.options, reportRoot: f.path })).toMatchObject({ state: 'negative' });
    expect(sourceState(f.path)).toEqual(before); expect(existsSync(join(f.path, 'snapshots'))).toBe(false);
    const file = f.payloads[0], target = join(f.root, 'target.json'); writeFileSync(target, file.bytes);
    unlinkSync(join(f.path, file.path)); symlinkSync(target, join(f.path, file.path), 'file');
    expect(f.publish()).toMatchObject({ state: 'negative' }); expect(f.pushes()).toHaveLength(0); expect(f.refs()).toBe('');
  });

  it('does not push a journal whose recorded file set no longer describes its commit', () => {
    const f = publicationFixture();
    f.runGit.mockImplementation((executable, args, options) => args.includes('push') ? unknown('push failed') : runRescueCommand(executable, args, options));
    f.publish(); const pending = f.journal(); pending.files.pop(); writeFileSync(f.journalPath, JSON.stringify(pending));
    f.runGit.mockImplementation(runRescueCommand); f.runGit.mockClear();
    expect(f.publish()).toMatchObject({ veto: 'snapshot-unverified' }); expect(f.pushes()).toHaveLength(0);
  });

  it.skipIf(process.platform === 'win32')('keeps executable POSIX modes for untracked and ignored files', () => {
    const f = publicationFixture();
    for (const file of f.payloads.filter(file => file.kind !== 'modified')) chmodSync(join(f.path, file.path), 0o755);
    expect(value(f.publish()).files.every((file: PublishedSnapshotFile) => file.mode === '100755')).toBe(true);
  });
});

function coordinator(f: ReturnType<typeof fixture>, paths: string[], extra = {}) {
  const facts = paths.map(tree);
  const planWorktrees = vi.fn(async (_inventory: object, _options: { idleJournalOptions?: object }) => ok({ primaryPath: f.primary,
    worktrees: facts.map(tree => ({ path: tree.path, head: value(tree.registration).head, disposition: 'snapshot', reasonCode: 'snapshot' })) }));
  const fallback = vi.fn(snapshotFallback), remove = vi.fn(() => { throw new Error('Snapshot removed'); });
  const runProbe: typeof probe<string> = (executable, args, options) => args.includes('fetch') || args.slice(-2).join(' ') === 'worktree prune'
    ? ok('') : probe(executable, args, options);
  const dependencies = { inventory: () => ok({ primaryPath: f.primary, commonDirectory: ok(join(f.primary, '.git')),
    registrations: facts.map(tree => value(tree.registration)), worktrees: facts }),
    collectActivity: () => facts.map(tree => ({ head: ok(value(tree.registration).head), live: negative() })),
    planWorktrees, snapshotFallback: fallback, executeRemovals: remove,
    scanPrimaryLinks: () => ok({}), writeLinkIndex: () => {}, notifyRun: () => {}, identityProbe: () => ok('fixture-start'),
    runProbe,
    pruneArchives: () => ok({ pruned: [], warnings: [], totalBytes: 0 }), ...extra };
  return { dependencies, planWorktrees, fallback, remove,
    options: { repositoryPath: f.primary, runnerPath: f.primary, reportRoot: join(f.root, 'reports'), ghPath: process.execPath } };
}

describe('U4c coordinator snapshot binding', { timeout: 60_000 }, () => {
  it('reports a stray journal without binding unrelated trees or disturbing a valid record', async () => {
    const f = publicationFixture(); f.publish(); finishCopySet(f);
    const unrelated = f.add('unrelated'), stray = join(dirname(f.journalPath), 'notes.json');
    writeFileSync(stray, '{}');
    const ordinary = vi.fn(async (inventory: { worktrees: { path: string }[] }) => ok({ primaryPath: f.primary,
      worktrees: inventory.worktrees.map(tree => ({ path: tree.path, disposition: 'remove', reasonCode: 'remove' })) }));
    const c = coordinator(f, [f.path, unrelated], { planWorktrees: ordinary });
    const result = value(reconcileSnapshots(value(c.dependencies.inventory()), f.options));
    expect(result.records).toContainEqual({ journalPath: stray, reasonCode: 'unknown' });
    expect(result.worktrees).toHaveLength(1);
    expect(result.worktrees[0]).toMatchObject({ path: f.path, reasonCode: 'snapshot-pending' });
    const report = await runCleanup({ ...c.options, remotePath: f.remote, dryRun: true }, c.dependencies);
    expect(report.status, report.error).toBe('completed');
    expect(ordinary).toHaveBeenCalledWith(expect.objectContaining({ worktrees: [expect.objectContaining({ path: unrelated })] }), expect.any(Object));
    const row = report.worktrees.find(tree => tree.path === unrelated);
    expect(row).toMatchObject({ action: 'remove', initialDisposition: 'remove' });
    expect(row).not.toHaveProperty('snapshotBound');
    expect(report.worktrees.find(tree => tree.path === f.path)).toMatchObject({ snapshotBound: true, reasonCode: 'snapshot-pending' });
    expect((report as unknown as CleanupReportWithNotes).notes).toContain(`Snapshot journal: ${stray} (unknown)`);
  });

  it.each(['removed', 'published_verified'])('contains an origin change to the bound tree for a %s record', async state => {
    const f = publicationFixture(); f.publish(); finishCopySet(f);
    if (state === 'removed') expect(markSnapshotRemoved(dirname(f.journalPath), f.path).state).toBe('ok');
    const unrelated = f.add('unrelated'), before = readFileSync(f.journalPath);
    git(f.primary, 'remote', 'set-url', 'origin', f.primary); f.runGit.mockClear();
    const ordinary = vi.fn(async (inventory: { worktrees: { path: string }[] }) => ok({ primaryPath: f.primary,
      worktrees: inventory.worktrees.map(tree => ({ path: tree.path, disposition: 'hold', reasonCode: 'fixture-ordinary' })) }));
    const c = coordinator(f, [f.path, unrelated], { planWorktrees: ordinary });
    const report = await runCleanup({ ...c.options, remotePath: f.remote, runGit: f.runGit, manual: true }, c.dependencies);
    expect(report.status, report.error).toBe('completed');
    const bound = report.worktrees.filter(tree => tree.snapshotBound);
    if (state === 'removed') {
      expect(bound).toEqual([]); expect(f.runGit).not.toHaveBeenCalled();
    } else {
      expect(bound).toHaveLength(1);
      expect(bound[0]).toMatchObject({ path: f.path, action: 'hold', reasonCode: 'snapshot-unverified' });
    }
    expect(ordinary).toHaveBeenCalledWith(expect.objectContaining({ worktrees: state === 'removed'
      ? [expect.objectContaining({ path: f.path }), expect.objectContaining({ path: unrelated })]
      : [expect.objectContaining({ path: unrelated })] }), expect.any(Object));
    expect(report.worktrees.find(tree => tree.path === unrelated)).not.toHaveProperty('snapshotBound');
    expect(readFileSync(f.journalPath)).toEqual(before);
  });

  it('reports would be removed for a gone published record in a dry run without writing it', async () => {
    const f = publicationFixture(); f.publish(); finishCopySet(f);
    git(f.primary, 'worktree', 'remove', f.path);
    const before = readFileSync(f.journalPath), c = coordinator(f, []);
    const report = await runCleanup({ ...c.options, remotePath: f.remote, dryRun: true }, c.dependencies);
    expect(report.status, report.error).toBe('completed');
    expect((report as unknown as CleanupReportWithNotes).notes).toContain(`Snapshot journal: ${f.journalPath} (would be removed)`);
    expect(readFileSync(f.journalPath)).toEqual(before);
  });

  it.each(['named path', 'reconciliation'])('never scans primary links from finally after an early %s failure', async failure => {
    const f = fixture(), path = f.add(), scanPrimaryLinks = vi.fn(() => ok([])), write = vi.fn(writeLinkIndex);
    const scanTreeLinks = vi.spyOn(inventoryModule, 'scanTreeLinks');
    try {
      const c = coordinator(f, [path], { scanPrimaryLinks, writeLinkIndex: write,
        ...(failure === 'reconciliation' ? { reconcileSnapshots: () => unknown('Fixture reconciliation failure') } : {}) });
      const inventory = c.dependencies.inventory;
      c.dependencies.inventory = () => ok({ ...value(inventory()), registrationKeys: [] });
      const report = await runCleanup({ ...c.options, manual: true,
        ...(failure === 'named path' ? { operatorRelease: [join(f.root, 'missing')] } : {}) }, c.dependencies);
      expect(report.status).toBe('failed');
      expect(report.error).toContain(failure === 'named path' ? 'not a registered worktree' : 'Fixture reconciliation failure');
      expect(write).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledWith(c.options.reportRoot, expect.any(Object), expect.objectContaining({
        primaryLinks: unknown('Primary link scan not reached'),
      }));
      expect(scanPrimaryLinks).not.toHaveBeenCalled(); expect(scanTreeLinks).not.toHaveBeenCalled();
    } finally { scanTreeLinks.mockRestore(); }
  });

  it.each(['verified', 'deleted ref', 'new dirt'])('binds a crash after final cleanup before worktree remove: %s', async scenario => {
    const f = publicationFixture(), published = value(f.publish()), progress = finishCopySet(f);
    if (scenario === 'deleted ref') git(f.remote, 'update-ref', '-d', published.ref);
    if (scenario === 'new dirt') put(f.path, 'outside-copy-set.json', '{"new":true}\r\n');
    const before = sourceState(f.path), preflight = vi.fn(preflightSnapshot);
    const ordinary = vi.fn(async () => ok({ primaryPath: f.primary, worktrees: [{ path: f.path, disposition: 'remove' }] }));
    const c = coordinator(f, [f.path], { planWorktrees: ordinary, preflightSnapshot: preflight });
    f.runGit.mockClear();
    const report = await runCleanup({ ...c.options, remotePath: f.remote, runGit: f.runGit, manual: true }, c.dependencies);
    expect(report.status, report.error).toBe('completed');
    expect(report.worktrees).toHaveLength(1);
    expect(report.worktrees[0]).toMatchObject({ path: f.path, disposition: 'hold', action: 'hold', snapshotBound: true,
      journalPath: f.journalPath, reasonCode: scenario === 'deleted ref' ? 'snapshot-unverified' : 'snapshot-pending' });
    expect(ordinary).toHaveBeenCalledWith(expect.objectContaining({ worktrees: [] }), expect.any(Object));
    expect(c.remove).not.toHaveBeenCalled(); expect(preflight).not.toHaveBeenCalled(); expect(c.fallback).not.toHaveBeenCalled();
    expect(f.pushes()).toHaveLength(0); expect(f.journal().progress).toEqual(progress); expect(sourceState(f.path)).toEqual(before);
    expect(readFileSync(report.reportPath!, 'utf8')).toContain(f.journalPath);
  });

  it('lets a removed record return to ordinary classification', async () => {
    const f = publicationFixture(); f.publish(); finishCopySet(f);
    expect(markSnapshotRemoved(dirname(f.journalPath), f.path).state).toBe('ok');
    const ordinary = vi.fn(async () => ok({ primaryPath: f.primary, worktrees: [{ path: f.path, disposition: 'remove', reasonCode: 'remove' }] }));
    const c = coordinator(f, [f.path], { planWorktrees: ordinary }), before = readFileSync(f.journalPath);
    const report = await runCleanup({ ...c.options, remotePath: f.remote, dryRun: true }, c.dependencies);
    expect(report.status, report.error).toBe('completed');
    expect(ordinary).toHaveBeenCalledWith(expect.objectContaining({ worktrees: [expect.objectContaining({ path: f.path })] }), expect.any(Object));
    expect(report.worktrees[0]).toMatchObject({ action: 'remove', initialDisposition: 'remove' });
    expect(report.worktrees[0]).not.toHaveProperty('snapshotBound'); expect(readFileSync(f.journalPath)).toEqual(before);
  });

  it('reports a corrupt record as an unknown hold before ordinary planning', async () => {
    const f = publicationFixture(); f.publish(); finishCopySet(f);
    writeFileSync(f.journalPath, '{invalid'); const before = readFileSync(f.journalPath);
    const ordinary = vi.fn(async () => ok({ primaryPath: f.primary, worktrees: [{ path: f.path, disposition: 'remove' }] }));
    const c = coordinator(f, [f.path], { planWorktrees: ordinary });
    const report = await runCleanup({ ...c.options, remotePath: f.remote, manual: true }, c.dependencies);
    expect(report.status, report.error).toBe('completed');
    expect(report.worktrees[0]).toMatchObject({ action: 'hold', disposition: 'hold', reasonCode: 'unknown', journalPath: f.journalPath });
    expect(c.remove).not.toHaveBeenCalled(); expect(readFileSync(f.journalPath)).toEqual(before);
  });
});

describe('U3 coordinator snapshot gates and reports', { timeout: 60_000 }, () => {
  it('includes candidate metadata and veto counts in the fallback failure report', () => {
    const f = fixture(), report = { runId: 'failed-snapshot', startedAt: 1, finishedAt: 2, status: 'failed', stage: 'classify', dryRun: true,
      worktrees: [{ path: f.primary, action: 'hold', disposition: 'hold', reasonCode: 'leftovers', snapshotVeto: 'secret_material',
        snapshot: { gate: 'secret_material', fileCount: 1, totalBytes: 2, largest: { path: '.tmp-intake/.env', size: 2 }, paths: ['.tmp-intake/.env'] } }] };
    writeFailureReport(join(f.root, 'reports'), report);
    const text = readFileSync(join(f.root, 'reports/reports/failed-snapshot-report-failure.md'), 'utf8');
    expect(text).toContain('Snapshot vetoes: secret_material: 1');
    expect(text).toContain(`| ${f.primary} | 1 | 2 | .tmp-intake/.env (2 bytes) | secret_material | .tmp-intake/.env |`);
  });

  it.each([true, false])('keeps an eligible snapshot as an eligible-only hold, dryRun=%s', async dryRun => {
    const f = fixture(), path = f.add(), contents = 'unique-content-never-in-report'; put(path, '.tmp-intake/data.json', contents);
    const c = coordinator(f, [path]), before = savedState(path);
    const report = await runCleanup({ ...c.options, dryRun }, c.dependencies);
    expect(report.status, report.error).toBe('completed'); expect(savedState(path)).toEqual(before);
    expect(report.worktrees[0]).toMatchObject({ action: 'hold', disposition: 'hold', reasonCode: 'snapshot-eligible',
      snapshot: { gate: 'eligible', fileCount: 1, totalBytes: Buffer.byteLength(contents), files: [{ path: '.tmp-intake/data.json' }] } });
    expect(c.remove).not.toHaveBeenCalled(); expect(c.fallback).not.toHaveBeenCalled();
    const text = readFileSync(report.reportPath!, 'utf8'), journal = readFileSync(join(c.options.reportRoot, 'journal.jsonl'), 'utf8');
    expect(text).toContain(`| ${path} | 1 | ${Buffer.byteLength(contents)} | .tmp-intake/data.json (${Buffer.byteLength(contents)} bytes) | eligible |`);
    expect(text).toContain('Snapshot vetoes: secret_material: 0');
    for (const output of [text, journal, JSON.stringify(report)]) { expect(output).not.toContain(contents); expect(output).not.toContain('"bytes"'); }
  });

  it.each([false, true])('applies the same projected-journal leftovers fallback with idle=%s', async idle => {
    const f = fixture(), path = f.add(), file = '.tmp-intake/.env.local'; put(path, file, 'name-gated-report-marker');
    const c = coordinator(f, [path]), now = Date.now(); age(path, now);
    if (idle) for (let day = 15; day >= 1; day--) {
      expect(appendIdleObservation(path, { head: ok(git(path, 'rev-parse', 'HEAD')), live: negative() },
        { journalPath: join(c.options.reportRoot, 'idle-journal.jsonl'), now: () => now - day * DAY }).state).toBe('ok');
    }
    const report = await runCleanup({ ...c.options, dryRun: true, now: () => now }, c.dependencies);
    expect(report.status, report.error).toBe('completed');
    expect(report.worktrees[0]).toMatchObject({ action: idle ? 'archive' : 'hold', reasonCode: 'leftovers',
      snapshotVeto: 'secret_material', snapshotPaths: [file], snapshot: { fileCount: 1, gate: 'secret_material' } });
    expect(c.fallback).toHaveBeenCalledOnce();
    expect(c.fallback.mock.calls[0][2]?.idleJournalOptions).toEqual(c.planWorktrees.mock.calls[0][1].idleJournalOptions);
    const text = readFileSync(report.reportPath!, 'utf8'); expect(text).toContain('Snapshot vetoes: secret_material: 1');
    expect(text).toContain(`| secret_material | ${file} |`); expect(text).not.toContain('name-gated-report-marker');
  });

  it('counts every vetoed candidate when one gate rejects the entire run', async () => {
    const f = fixture(), paths = ['one', 'two', 'three'].map(name => f.add(name));
    for (const path of paths) put(path, '.tmp-intake/.env.local', 'private-report-marker');
    const c = coordinator(f, paths), report = await runCleanup({ ...c.options, dryRun: true }, c.dependencies);
    expect(report.status, report.error).toBe('completed'); expect(report.snapshotVetoCounts?.secret_material).toBe(paths.length);
    const text = readFileSync(report.reportPath!, 'utf8'); expect(text).toContain(`Snapshot vetoes: secret_material: ${paths.length}`);
    for (const path of paths) expect(text).toContain(`| ${path} | 1 |`);
    expect(JSON.stringify(report)).not.toContain('"bytes"'); expect(text).not.toContain('private-report-marker');
  });

  it('holds an unknown preflight and reports classification-time U2 vetoes without scanning them', async () => {
    const f = fixture(), path = f.add(); put(path, '.tmp-intake/data.json', '{}');
    const preflight = vi.fn(() => unknown('Deadline reached')), c = coordinator(f, [path], { preflightSnapshot: preflight });
    let report = await runCleanup({ ...c.options, dryRun: true }, c.dependencies);
    expect(report.worktrees[0]).toMatchObject({ disposition: 'hold', reasonCode: 'unknown', snapshotVeto: 'unknown' });
    expect(report.snapshotVetoCounts?.unknown).toBe(1); expect(c.fallback).not.toHaveBeenCalled();
    preflight.mockClear();
    const second = coordinator(f, [path], { preflightSnapshot: preflight,
      planWorktrees: async () => ok({ primaryPath: f.primary, worktrees: [{ path, disposition: 'hold', reasonCode: 'leftovers',
        snapshotVeto: 'secret_material', nameHits: ['.tmp-intake/.env.local'] }] }) });
    report = await runCleanup({ ...second.options, dryRun: true }, second.dependencies);
    expect(preflight).not.toHaveBeenCalled(); expect(report.snapshotVetoCounts?.secret_material).toBe(1);
    expect(readFileSync(report.reportPath!, 'utf8')).toContain(`| ${path} | not-evaluated | not-evaluated | not-evaluated | secret_material | .tmp-intake/.env.local |`);
  });
});
