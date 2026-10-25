import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { classifyScratch, scanSecrets, SECRET_NAME_PATTERNS } from './admission.mjs';
import { blobOid, readRegular } from './archive.mjs';
import { allowedDirectories, allowedFiles, normalizePath, parseStatus, walkDirectory } from './inventory.mjs';
import { boundedTimeout, equal, fingerprint, negative, ok, remainingTime, requireEvidence, resolveExecutable, unknown } from './probe.mjs';
import { runRescueCommand } from './rescue.mjs';
import { assertUnlinkedAncestors } from './safe-path.mjs';

export const SNAPSHOT_MAX_BYTES = 200 * 1024 ** 2;
export const SNAPSHOT_MAX_FILE_BYTES = 50 * 1024 ** 2;
const admissions = new WeakMap();
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SCHEMA = 'worktree-cleanup-snapshot/v1';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** @typedef {{path: string, kind: 'untracked'|'ignored'|'modified', size: number, digest?: string}} SnapshotFile
 * @typedef {{files: SnapshotFile[], totalBytes: number, largest: {path: string, size: number}|null}} SnapshotSummary
 */
function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\:\0]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}

/** Read-only admission. Only the ok result retains buffers, for U4 publication.
 * Veto summaries contain measured metadata, never file contents.
 * @param {object} tree
 * @param {{maxBytes?: number, maxFileBytes?: number, timeout?: number, walkTimeout?: number,
 * softDeadline?: number, deadlineNow?: () => number, readFile?: typeof readRegular}} options
 */
export function preflightSnapshot(tree, options = {}) {
  try {
    remainingTime(options);
    const scratch = classifyScratch(tree);
    requireEvidence(scratch.state === 'ok' && scratch.value.scratch, 'Scratch inventory unavailable');
    const head = tree.registration?.state === 'ok' ? tree.registration.value.head : null;
    requireEvidence(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head ?? ''), 'Snapshot HEAD unavailable');
    requireEvidence(typeof tree.path === 'string' && isAbsolute(tree.path), 'Snapshot root unavailable');
    const root = resolve(tree.path), maxBytes = options.maxBytes ?? SNAPSHOT_MAX_BYTES;
    const maxFileBytes = options.maxFileBytes ?? SNAPSHOT_MAX_FILE_BYTES;
    requireEvidence([maxBytes, maxFileBytes].every(cap => Number.isSafeInteger(cap) && cap >= 0), 'Invalid snapshot cap');
    const candidates = new Map(), unsupported = new Set();
    const checkedDirectory = path => {
      remainingTime(options);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { unsupported.add(relative(root, path).split(sep).join('/') || '.'); return false; }
      return true;
    };
    const add = (path, kind, stat) => {
      remainingTime(options);
      requireEvidence(safeRelative(path), 'Unsafe snapshot path');
      if (stat.isSymbolicLink() || !stat.isFile()) { unsupported.add(path); return; }
      const previous = candidates.get(path.toLowerCase());
      requireEvidence(!previous || previous.path === path, 'Ambiguous snapshot path');
      // Directory entries can overlap an explicitly modified tracked file.
      if (!previous || kind === 'modified') candidates.set(path.toLowerCase(), { path, kind, stat });
    };
    const expand = (entry, kind) => {
      const path = entry.endsWith('/') ? entry.slice(0, -1) : entry;
      requireEvidence(safeRelative(path), 'Unsafe snapshot path');
      let ancestor = root;
      if (!checkedDirectory(ancestor)) return;
      for (const part of path.split('/').slice(0, -1)) {
        ancestor = join(ancestor, part);
        if (!checkedDirectory(ancestor)) return;
      }
      remainingTime(options);
      const full = join(root, path), stat = lstatSync(full);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (kind === 'modified' && stat.isDirectory())) {
        unsupported.add(path); return;
      }
      if (!stat.isDirectory()) { add(path, kind, stat); return; }
      const walked = walkDirectory(full, { timeout: options.walkTimeout ?? options.timeout, softDeadline: options.softDeadline,
        deadlineNow: options.deadlineNow, visit: ({ path: file, name, stat }) => {
          const rel = relative(root, file).split(sep).join('/');
          if (name.toLowerCase() === '.git' || stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
            unsupported.add(rel); return false;
          }
          requireEvidence(safeRelative(rel), 'Unsafe snapshot path');
          if (stat.isFile()) add(rel, kind, stat);
        } });
      requireEvidence(walked.state === 'ok', 'Snapshot walk unavailable');
    };
    for (const entry of tree.status.value.entries) expand(entry.path, entry.index === '?' ? 'untracked' : 'modified');
    for (const path of tree.ignored.value.unexpected) expand(path, 'ignored');
    const entries = [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
    /** @type {SnapshotSummary} */
    const summary = { files: entries.map(({ path, kind, stat }) => ({ path, kind, size: stat.size })),
      totalBytes: entries.reduce((sum, entry) => sum + entry.stat.size, 0),
      largest: entries.reduce((largest, entry) => !largest || entry.stat.size > largest.size ? { path: entry.path, size: entry.stat.size } : largest, null) };
    // A secret veto never reports blob digests: a digest of short secret text is
    // an offline-confirmable fingerprint of its contents.
    const veto = (gate, paths) => ({ ...negative(), veto: gate, paths: [...new Set(paths)].sort(),
      summary: gate === 'secret_material' || gate === 'secret-scan-unsupported'
        ? { ...summary, files: summary.files.map(({ digest: _digest, ...file }) => file) } : summary });
    remainingTime(options);
    if (unsupported.size) return veto('snapshot-unsupported-entry', [...unsupported]);
    const oversized = summary.files.filter(file => file.size > maxFileBytes);
    if (oversized.length) return veto('snapshot-file-cap', oversized.map(file => file.path));
    if (summary.totalBytes > maxBytes) return veto('snapshot-size-cap', summary.files.map(file => file.path));
    const nameHits = summary.files.filter(file => file.kind !== 'modified' && SECRET_NAME_PATTERNS.some(pattern => pattern.test(file.path.split('/').at(-1))));
    // The name gate precedes the content gate (KTD4): a name-gated file is never read.
    if (nameHits.length) return veto('secret_material', nameHits.map(file => file.path));
    const secretPaths = [], unscannable = [], files = [];
    for (const [index, entry] of entries.entries()) {
      remainingTime(options);
      const read = (options.readFile ?? readRegular)(join(root, entry.path));
      requireEvidence(Buffer.isBuffer(read.bytes) && equal(fingerprint(entry.stat), fingerprint(read.stat)) && read.bytes.length === entry.stat.size, 'Snapshot file changed');
      remainingTime(options);
      const digest = blobOid(read.bytes, head);
      summary.files[index].digest = digest;
      let supported = !read.bytes.includes(0);
      if (supported) {
        try { new TextDecoder('utf-8', { fatal: true }).decode(read.bytes); }
        catch { supported = false; }
      }
      if (!supported) unscannable.push(entry.path);
      else {
        const secrets = scanSecrets(read.bytes);
        if (secrets.state === 'unknown') unscannable.push(entry.path);
        else if (secrets.state === 'ok') secretPaths.push(entry.path);
      }
      files.push({ ...summary.files[index], digest, bytes: read.bytes });
      remainingTime(options);
    }
    if (secretPaths.length) return veto('secret_material', secretPaths);
    if (unscannable.length) return veto('secret-scan-unsupported', unscannable);
    const admitted = { files, totalBytes: summary.totalBytes, largest: summary.largest };
    // Bind the in-memory admission to the evidence it scanned without changing
    // its public shape or persisting buffers (or a caller-mutable HEAD).
    admissions.set(admitted, { treePath: normalizePath(root), head, branch: tree.registration.value.branch ?? null,
      files: files.map(({ path, kind, digest }) => ({ path, kind, digest })) });
    return ok(admitted);
  } catch { return unknown('Snapshot evidence unreadable, changed or deadline exceeded'); }
}

function snapshotSha(raw) {
  const sha = raw.trim();
  requireEvidence(OID.test(sha), 'Invalid snapshot object identity');
  return sha;
}

function saveSnapshot(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(record, null, 2) + '\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

function lockSnapshot(path) {
  const lock = `${path}.lock`;
  if (existsSync(lock)) {
    const pid = Number(readRegular(lock).bytes.toString('utf8'));
    requireEvidence(Number.isSafeInteger(pid) && pid > 0, 'Unknown snapshot lock owner');
    try { process.kill(pid, 0); throw new Error('Snapshot journal is in use'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lock);
  }
  const fd = openSync(lock, 'wx', 0o600);
  try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); }
  finally { closeSync(fd); }
  return () => unlinkSync(lock);
}

function readSnapshot(path, treePath, identity) {
  if (!existsSync(path)) return null;
  const record = JSON.parse(readRegular(path).bytes.toString('utf8'));
  requireEvidence(record.schema === SCHEMA && record.treePath === treePath && record.identity === identity &&
    ['not_pushed', 'pushed_unverified', 'published_verified', 'removed'].includes(record.state) &&
    [record.head, record.commitSha, record.treeSha].every(sha => OID.test(sha ?? '')) &&
    [record.commitSha, record.treeSha].every(sha => sha.length === record.head.length) &&
    (record.branch === null || typeof record.branch === 'string') &&
    typeof record.ref === 'string' && record.ref.startsWith('refs/heads/rescue/') &&
    Array.isArray(record.files) && record.files.length > 0, 'Invalid or foreign snapshot journal');
  const seen = new Set();
  for (const file of record.files) {
    requireEvidence(safeRelative(file.path) && !seen.has(file.path.toLowerCase()) &&
      ['untracked', 'ignored', 'modified'].includes(file.kind) && ['100644', '100755'].includes(file.mode) &&
      OID.test(file.digest ?? '') && file.digest.length === record.head.length && !('bytes' in file), 'Invalid snapshot journal file');
    seen.add(file.path.toLowerCase());
  }
  if (record.progress !== undefined) {
    const { cleaned, restored, inFlight } = record.progress;
    const files = new Map(record.files.map(file => [file.path, file]));
    requireEvidence(Array.isArray(cleaned) && Array.isArray(restored) &&
      new Set(cleaned).size === cleaned.length && cleaned.every(path => files.has(path)) &&
      new Set(restored.map(file => file.path)).size === restored.length, 'Invalid snapshot progress');
    requireEvidence(restored.every(file => cleaned.includes(file.path) && files.get(file.path)?.kind === 'modified' &&
      Array.isArray(file.fingerprint) && file.fingerprint.length === 6 && file.fingerprint.every(Number.isFinite) &&
      /^[a-f0-9]{64}$/.test(file.sha256 ?? '')) &&
      cleaned.filter(path => files.get(path).kind === 'modified').every(path => restored.some(file => file.path === path)),
    'Invalid snapshot restore evidence');
    requireEvidence(inFlight === undefined || (inFlight && !cleaned.includes(inFlight.path) &&
      files.has(inFlight.path) && files.get(inFlight.path).kind === inFlight.kind), 'Invalid snapshot cleanup intent');
  }
  if (record.recoveryFailure !== undefined) {
    requireEvidence(typeof record.recoveryFailure?.time === 'string' &&
      Number.isFinite(Date.parse(record.recoveryFailure.time)) &&
      typeof record.recoveryFailure.reason === 'string' && record.recoveryFailure.reason.length > 0,
    'Invalid snapshot recovery failure');
  }
  return record;
}

function snapshotRemote(root, options) {
  const executable = resolveExecutable(options.gitPath ?? 'git');
  requireEvidence(executable.state === 'ok', 'Git unavailable');
  const inspectionEnv = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const env = { ...inspectionEnv,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'Workflow tools Snapshot Publisher', GIT_AUTHOR_EMAIL: 'snapshot@localhost.invalid',
    GIT_COMMITTER_NAME: 'Workflow tools Snapshot Publisher', GIT_COMMITTER_EMAIL: 'snapshot@localhost.invalid',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_LITERAL_PATHSPECS: '1' };
  const run = (args, extra = {}) => (options.runGit ?? runRescueCommand)(executable.value,
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args],
    { cwd: root, env, timeout: boundedTimeout(options, 30_000), ...extra });
  const git = (args, extra = {}) => {
    const result = run(args, extra);
    requireEvidence(result?.state === 'ok' && typeof result.value === 'string', 'Snapshot command unavailable');
    return result.value;
  };
  let remote;
  if (options.remotePath !== undefined) {
    requireEvidence(isAbsolute(options.remotePath), 'Local remote must be an injected absolute path');
    remote = resolve(options.remotePath);
    assertUnlinkedAncestors(remote);
    requireEvidence(git(['-C', remote, 'rev-parse', '--is-bare-repository']).trim() === 'true', 'Local remote must be bare');
  } else {
    const repository = options.repository ?? 'example-org/example-repo';
    requireEvidence(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository), 'Invalid repository identity');
    remote = `https://github.com/${repository}.git`;
  }
  requireEvidence(git(['remote', 'get-url', 'origin']).trim() === remote, 'Origin does not match snapshot remote');
  const network = ['-c', 'protocol.allow=never', '-c', `protocol.${options.remotePath !== undefined ? 'file' : 'https'}.allow=always`,
    '-c', 'credential.helper=', ...(options.remotePath === undefined ? ['-c', 'credential.helper=!gh auth git-credential'] : [])];
  const remoteHead = ref => {
    const raw = git([...network, 'ls-remote', '--heads', remote, ref]).trim();
    if (!raw) return null;
    const rows = raw.split('\n'), parts = rows[0].split('\t');
    requireEvidence(rows.length === 1 && parts.length === 2 && parts[1] === ref, 'Ambiguous snapshot remote ref');
    return snapshotSha(parts[0]);
  };
  return { inspectionEnv, env, run, git, remote, network, remoteHead };
}

/** Read the commissioning gate with fresh remote evidence, never a cached ref.
 * Missing, malformed or unverifiable records leave snapshot mutations disabled.
 * @param {string} reportRoot
 * @param {{repositoryPath: string, remotePath?: string, repository?: string, gitPath?: string, timeout?: number,
 * softDeadline?: number, deadlineNow?: () => number, runGit?: typeof runRescueCommand}} options
 */
export function readCommissioning(reportRoot, options) {
  try {
    remainingTime(options);
    requireEvidence(typeof reportRoot === 'string' && isAbsolute(reportRoot), 'Invalid commissioning root');
    const record = JSON.parse(readRegular(join(reportRoot, 'commissioning.json')).bytes.toString('utf8'));
    requireEvidence(record?.schema === 'worktree-cleanup-commissioning/v1' &&
      Object.keys(record).every(key => ['schema', 'planHash', 'createdAt', 'refs'].includes(key)) &&
      typeof record.planHash === 'string' && /^[a-f0-9]{64}$/.test(record.planHash) &&
      typeof record.createdAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(record.createdAt) && Number.isFinite(Date.parse(record.createdAt)) &&
      Date.parse(record.createdAt) <= (options.deadlineNow ?? Date.now)() + 5 * 60_000 &&
      Array.isArray(record.refs) && record.refs.length > 0, 'Invalid commissioning record');
    const seen = new Set();
    for (const entry of record.refs) {
      requireEvidence(typeof entry?.ref === 'string' && entry.ref.startsWith('refs/heads/rescue/') && !seen.has(entry.ref) &&
        typeof entry.commitSha === 'string' && OID.test(entry.commitSha), 'Invalid commissioning ref');
      seen.add(entry.ref);
    }
    requireEvidence(typeof options?.repositoryPath === 'string' && isAbsolute(options.repositoryPath), 'Invalid commissioning repository');
    const root = resolve(options.repositoryPath);
    assertUnlinkedAncestors(root);
    const { git, remoteHead } = snapshotRemote(root, options);
    for (const { ref, commitSha } of record.refs) {
      remainingTime(options);
      git(['check-ref-format', ref]);
      const first = remoteHead(ref), second = remoteHead(ref);
      if (first !== commitSha || second !== commitSha) return negative();
    }
    remainingTime(options);
    return ok(record);
  } catch { return unknown('Commissioning record missing, invalid or unverifiable'); }
}

/** Atomic, fsynced commissioning artifacts. No admitted buffers are persisted. */
export function writeCommissioningArtifact(reportRoot, name, record) {
  requireEvidence(isAbsolute(reportRoot) && /^(?:commissioning|commission-preview-[a-f0-9]{64})\.json$/.test(name), 'Invalid commissioning artifact');
  assertUnlinkedAncestors(reportRoot, { missing: 'allow' });
  mkdirSync(reportRoot, { recursive: true });
  assertUnlinkedAncestors(reportRoot);
  saveSnapshot(join(reportRoot, name), record);
}

/** Restore the copy set from raw blobs, never checkout/restore conversions.
 * Origin is fetched into a temporary private ref. Journals retain the exact
 * copy set; a fresh clone can reconstruct it from the single-parent commit.
 */
export function recoverSnapshot(options) {
  let cleanup, result;
  try {
    remainingTime(options);
    requireEvidence(typeof options.dest === 'string' && isAbsolute(options.dest), 'Recovery destination must be absolute');
    const dest = resolve(options.dest);
    assertUnlinkedAncestors(dest, { missing: 'allow' });
    const existing = lstatSync(dest, { throwIfNoEntry: false });
    requireEvidence(!existing || (existing.isDirectory() && !existing.isSymbolicLink() && readdirSync(dest).length === 0), 'Recovery destination must be empty');
    const root = resolve(options.repositoryPath ?? process.cwd());
    assertUnlinkedAncestors(root);
    const ref = options.ref?.startsWith('rescue/') ? `refs/heads/${options.ref}` : options.ref;
    requireEvidence(typeof ref === 'string' && ref.startsWith('refs/heads/rescue/'), 'Invalid recovery ref');
    const { git, env, network } = snapshotRemote(root, options);
    git(['check-ref-format', ref]);
    const executable = resolveExecutable(options.gitPath ?? 'git');
    requireEvidence(executable.state === 'ok', 'Git unavailable');
    const temporaryRef = `refs/worktree-cleanup/recover/${randomUUID()}`;
    // Cleanup must also run after the recovery deadline expires.
    cleanup = () => requireEvidence((options.runGit ?? runRescueCommand)(executable.value,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NULL_DEVICE}`, '-C', root,
        'update-ref', '-d', temporaryRef],
      { cwd: root, env, windowsHide: true, timeout: 30_000 })?.state === 'ok', 'Recovery temporary ref cleanup failed');
    git([...network, '-c', `core.hooksPath=${NULL_DEVICE}`, 'fetch', '--no-recurse-submodules', '--no-write-fetch-head',
      '--no-tags', '--refmap=', 'origin', `${ref}:${temporaryRef}`]);
    const commitSha = snapshotSha(git(['rev-parse', '--verify', `${temporaryRef}^{commit}`]));
    let record;
    const journalRoot = options.reportRoot;
    if (journalRoot) {
      const directory = join(resolve(journalRoot), 'snapshots');
      assertUnlinkedAncestors(directory, { missing: 'allow' });
      if (existsSync(directory)) for (const name of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
        const path = join(directory, name);
        let saved;
        try { saved = JSON.parse(readRegular(path).bytes.toString('utf8')); }
        catch { continue; }
        if (saved?.ref !== ref) continue;
        const found = readSnapshot(path, saved.treePath, saved.identity);
        requireEvidence(found.commitSha === commitSha && (!record || equal(record.files, found.files)), 'Recovery journal disagrees with ref');
        record = found;
      }
    }
    const tree = new Map();
    const raw = git(['ls-tree', '-r', '-z', commitSha]);
    requireEvidence(raw.endsWith('\0'), 'Recovery tree unavailable');
    for (const row of raw.slice(0, -1).split('\0')) {
      const match = /^(\d+) (\S+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
      requireEvidence(match, 'Invalid recovery tree');
      tree.set(match[4], { path: match[4], mode: match[1], type: match[2], digest: match[3] });
    }
    let files = record?.files;
    if (!files) {
      const parents = git(['rev-list', '--parents', '-n', '1', commitSha]).trim().split(' ');
      requireEvidence(parents.length === 2 && OID.test(parents[1]), 'Recovery requires a single-parent snapshot');
      const changed = git(['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', parents[1], commitSha]);
      requireEvidence(changed.endsWith('\0'), 'Recovery copy set unavailable');
      files = changed.slice(0, -1).split('\0').map(path => tree.get(path));
    }
    const seen = new Set();
    requireEvidence(files.length > 0, 'Recovery copy set empty');
    for (const file of files) {
      const path = file?.path;
      requireEvidence(safeRelative(path) && !/[\x00-\x1f\x7f<>"|?*]/.test(path) &&
        path.split('/').every(part => !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part)) &&
        !seen.has(path.toLowerCase()), 'Unsafe recovery path');
      const entry = tree.get(path);
      requireEvidence(entry?.type === 'blob' && ['100644', '100755'].includes(entry.mode) &&
        OID.test(file.digest ?? '') && entry.digest === file.digest, 'Recovery manifest mismatch');
      seen.add(path.toLowerCase());
    }
    for (const path of seen) requireEvidence(path.split('/').slice(0, -1).every((_, index, parts) =>
      !seen.has(parts.slice(0, index + 1).join('/'))), 'Conflicting recovery paths');
    // Validate the entire manifest before creating the destination or writing bytes.
    mkdirSync(dest, { recursive: true }); assertUnlinkedAncestors(dest);
    requireEvidence(readdirSync(dest).length === 0, 'Recovery destination changed');
    for (const file of files) {
      remainingTime(options);
      const result = spawnSync(executable.value, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root,
        'cat-file', 'blob', `${commitSha}:${file.path}`], { env, windowsHide: true, shell: false,
        timeout: boundedTimeout(options, 30_000), maxBuffer: SNAPSHOT_MAX_FILE_BYTES + 1, encoding: 'buffer' });
      requireEvidence(!result.error && !result.signal && result.status === 0 && Buffer.isBuffer(result.stdout) &&
        blobOid(result.stdout, commitSha) === file.digest, 'Recovery blob mismatch');
      const path = join(dest, file.path);
      assertUnlinkedAncestors(dirname(path), { missing: 'allow' });
      mkdirSync(dirname(path), { recursive: true }); assertUnlinkedAncestors(dirname(path));
      writeFileSync(path, result.stdout, { flag: 'wx' });
    }
    result = ok({ ref, commitSha, dest, files: files.map(({ path, digest }) => ({ path, digest })) });
  } catch (error) { result = unknown(`Recovery refused: ${error.message}`); }
  finally {
    try { cleanup?.(); }
    catch (error) { result = unknown(`Recovery refused: ${error.message}`); }
  }
  return result;
}

/** Fresh remote evidence for removal. Uses the publisher's origin, protocol and
 * environment restrictions; neither read may be replaced by a cached result.
 * @param {object} record
 * @param {{repositoryPath?: string, remotePath?: string, repository?: string, gitPath?: string, timeout?: number,
 * softDeadline?: number, deadlineNow?: () => number, runGit?: typeof runRescueCommand}} options
 */
export function verifySnapshotRecord(record, options = {}) {
  try {
    requireEvidence(record?.state === 'published_verified' && typeof record.treePath === 'string' && isAbsolute(record.treePath) &&
      OID.test(record.commitSha ?? '') && typeof record.ref === 'string' && record.ref.startsWith('refs/heads/rescue/'), 'Invalid snapshot record');
    // treePath is a normalized journal key. A caller on a case-sensitive host
    // can supply the repository's actual path for Git's working directory.
    const root = options.repositoryPath ?? record.treePath;
    requireEvidence(typeof root === 'string' && isAbsolute(root), 'Invalid snapshot repository path');
    assertUnlinkedAncestors(root);
    const { git, remoteHead } = snapshotRemote(resolve(root), options);
    git(['check-ref-format', record.ref]);
    const first = remoteHead(record.ref), second = remoteHead(record.ref);
    requireEvidence(first === record.commitSha && second === record.commitSha, 'Snapshot remote changed');
    requireEvidence(Array.isArray(record.files) && record.files.length > 0, 'Snapshot files missing');
    const raw = git(['ls-tree', '-r', '-z', record.commitSha]);
    requireEvidence(raw.endsWith('\0'), 'Snapshot tree unavailable');
    const blobs = new Map();
    for (const row of raw.slice(0, -1).split('\0')) {
      const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(row);
      if (match) blobs.set(match[3], match[2]);
    }
    requireEvidence(record.files.every(file => safeRelative(file.path) && OID.test(file.digest ?? '') &&
      blobs.get(file.path) === file.digest), 'Snapshot files differ from committed blobs');
    return ok(record.commitSha);
  } catch { return { ...negative(), veto: 'snapshot-unverified' }; }
}

// journalRoot is the publisher's <reportRoot>/snapshots directory. Never create
// a missing record, and serialize updates with the publication lock.
function updateSnapshot(journalRoot, treePath, update) {
  let release;
  try {
    requireEvidence(typeof journalRoot === 'string' && isAbsolute(journalRoot) &&
      typeof treePath === 'string' && isAbsolute(treePath), 'Invalid snapshot journal paths');
    const root = resolve(journalRoot), key = normalizePath(treePath);
    requireEvidence(normalizePath(root) !== key && !normalizePath(root).startsWith(key + '/'), 'Journal is inside source tree');
    assertUnlinkedAncestors(root);
    const path = join(root, createHash('sha256').update(key).digest('hex') + '.json');
    release = lockSnapshot(path);
    const saved = JSON.parse(readRegular(path).bytes.toString('utf8'));
    const record = readSnapshot(path, key, saved.identity);
    requireEvidence(record?.state === 'published_verified', 'Snapshot is not verified');
    update(record);
    saveSnapshot(path, record);
    return ok(record);
  } catch { return { ...negative(), veto: 'snapshot-journal-update-refused' }; }
  finally { release?.(); }
}

/** Read a supervised retry without acquiring or changing the journal lock. */
export function readResumableSnapshot(binding, tree) {
  try {
    requireEvidence(binding?.record && tree?.registration?.state === 'ok', 'Snapshot registration unavailable');
    const record = readSnapshot(binding.journalPath, normalizePath(tree.path), binding.record.identity);
    requireEvidence(record?.state === 'published_verified' && record.progress === undefined &&
      record.head === tree.registration.value.head, 'Snapshot cannot resume commissioning');
    const lock = `${binding.journalPath}.lock`;
    if (existsSync(lock)) {
      const pid = Number(readRegular(lock).bytes.toString('utf8'));
      requireEvidence(Number.isSafeInteger(pid) && pid > 0, 'Unknown snapshot lock owner');
      try { process.kill(pid, 0); throw new Error('Snapshot journal is in use'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return ok({ ...record, journalPath: binding.journalPath });
  } catch (error) { return { ...negative(), veto: 'snapshot-unverified', reason: error.message }; }
}

/** Persist the recovery check's diagnostic without altering publication evidence. */
export function markSnapshotRecoveryFailure(journalRoot, update) {
  return updateSnapshot(journalRoot, update?.treePath, record => {
    requireEvidence(typeof update.time === 'string' && Number.isFinite(Date.parse(update.time)) &&
      typeof update.reason === 'string' && update.reason.length > 0, 'Invalid snapshot recovery failure');
    record.recoveryFailure = { time: update.time, reason: update.reason };
  });
}

/** Persist cumulative cleanup metadata; buffers are never journaled. */
export function markSnapshotProgress(journalRoot, update) {
  return updateSnapshot(journalRoot, update?.treePath, record => {
    const { cleaned, restored, inFlight } = update;
    requireEvidence(Array.isArray(cleaned) && Array.isArray(restored) &&
      new Set(cleaned).size === cleaned.length && new Set(restored.map(file => file.path)).size === restored.length, 'Invalid cleanup progress');
    const files = new Map(record.files.map(file => [file.path, file]));
    requireEvidence(cleaned.every(path => files.has(path)) &&
      (record.progress?.cleaned ?? []).every(path => cleaned.includes(path)), 'Cleanup progress regressed or escaped manifest');
    for (const file of restored) requireEvidence(cleaned.includes(file.path) && files.get(file.path)?.kind === 'modified' &&
      Array.isArray(file.fingerprint) && file.fingerprint.length === 6 && file.fingerprint.every(Number.isFinite) &&
      /^[a-f0-9]{64}$/.test(file.sha256 ?? ''), 'Invalid restored-file evidence');
    requireEvidence(cleaned.filter(path => files.get(path).kind === 'modified').every(path => restored.some(file => file.path === path)) &&
      (record.progress?.restored ?? []).every(previous => restored.some(file => file.path === previous.path &&
        equal(file.fingerprint, previous.fingerprint) && file.sha256 === previous.sha256)), 'Restored-file evidence missing or changed');
    requireEvidence(inFlight === undefined || (inFlight && !cleaned.includes(inFlight.path) &&
      files.has(inFlight.path) && files.get(inFlight.path).kind === inFlight.kind), 'Invalid cleanup intent');
    const previous = record.progress?.inFlight;
    requireEvidence(!previous || cleaned.includes(previous.path) ||
      (inFlight?.path === previous.path && inFlight.kind === previous.kind), 'Unresolved cleanup intent');
    record.progress = { cleaned: [...cleaned], restored: restored.map(({ path, fingerprint, sha256 }) => ({ path, fingerprint, sha256 })),
      ...(inFlight ? { inFlight: { path: inFlight.path, kind: inFlight.kind } } : {}) };
  });
}

/** Called only after successful worktree removal. Keeps the snapshot and history. */
export function markSnapshotRemoved(journalRoot, treePath) {
  return updateSnapshot(journalRoot, treePath, record => {
    requireEvidence(record.files.every(file => record.progress?.cleaned.includes(file.path)), 'Snapshot cleanup incomplete');
    record.state = 'removed';
  });
}

/** Reconcile durable publication before ordinary classification. Only unfinished
 * records bind trees; unknown journals fail closed, including now-clean trees.
 * Decisions retain progress on snapshotRecord for the removal consumer.
 * @param {{primaryPath: string, worktrees: object[]}} inventory
 * @param {{reportRoot: string, repositoryPath?: string, remotePath?: string, repository?: string,
 * gitPath?: string, timeout?: number, softDeadline?: number, deadlineNow?: () => number,
 * runGit?: typeof runRescueCommand, snapshotMutationsEnabled?: boolean, dryRun?: boolean}} options
 */
export function reconcileSnapshots(inventory, options) {
  const worktrees = new Map(), records = [];
  try {
    const directory = join(resolve(options.reportRoot), 'snapshots');
    if (!lstatSync(directory, { throwIfNoEntry: false })) return ok({ worktrees: [], records });
    assertUnlinkedAncestors(directory);
    const registered = new Map(inventory.worktrees.map(tree => [normalizePath(tree.path), tree]));
    const filename = path => createHash('sha256').update(path).digest('hex') + '.json';
    const root = resolve(options.repositoryPath ?? inventory.primaryPath);
    let identity;
    const enabled = options.snapshotMutationsEnabled === true && options.dryRun !== true;
    for (const name of readdirSync(directory).filter(name => name.endsWith('.json')).sort()) {
      remainingTime(options);
      const journalPath = join(directory, name);
      let record, release;
      let failureReason = 'unknown';
      const matched = [...registered.values()].filter(tree => filename(normalizePath(tree.path)) === name);
      const hold = (path, reasonCode, saved = record) => ({ path, disposition: 'hold', snapshotBound: true,
        reasonCode, reason: `${reasonCode}: ${journalPath}`, journalPath,
        ...(saved ? { head: saved.head, branch: saved.branch, record: saved, snapshotRecord: saved } : {}) });
      const continuation = path => ({ path, head: record.head, branch: record.branch, disposition: 'snapshot',
        snapshotBound: true, record, snapshotRecord: record, journalPath });
      try {
        const saved = JSON.parse(readRegular(journalPath).bytes.toString('utf8'));
        if (typeof saved?.treePath === 'string' && isAbsolute(saved.treePath)) {
          const tree = registered.get(normalizePath(saved.treePath));
          if (tree && !matched.includes(tree)) matched.push(tree);
          else if (!tree && lstatSync(saved.treePath, { throwIfNoEntry: false })) matched.push({ path: saved.treePath });
        }
        requireEvidence(typeof saved?.treePath === 'string' && isAbsolute(saved.treePath) &&
          normalizePath(saved.treePath) === saved.treePath && filename(saved.treePath) === name,
        'Invalid snapshot tree binding');
        record = readSnapshot(journalPath, saved.treePath, saved.identity);
        if (record.state === 'removed') continue;
        if (!identity) {
          try {
            const { git, remote } = snapshotRemote(root, options);
            const common = normalizePath(resolve(root, git(['rev-parse', '--git-common-dir']).trim()));
            identity = ok(JSON.stringify([common, remote]));
          } catch { identity = unknown('Snapshot remote unavailable'); }
        }
        if (identity.state !== 'ok') {
          failureReason = 'snapshot-unverified';
          throw new Error(identity.reason);
        }
        record = readSnapshot(journalPath, saved.treePath, identity.value);
        const tree = registered.get(record.treePath), path = tree?.path ?? record.treePath;
        let decision;
        if (!tree) {
          // A directory still present without registration is never proof of removal.
          // lstat distinguishes absence from inaccessible paths and dangling links.
          if (record.state === 'published_verified' && !lstatSync(path, { throwIfNoEntry: false })) {
            if (!options.dryRun) release = lockSnapshot(journalPath);
            record = readSnapshot(journalPath, saved.treePath, identity.value);
            requireEvidence(record.state === 'published_verified' &&
              !lstatSync(path, { throwIfNoEntry: false }), 'Snapshot removal evidence changed');
            record.state = 'removed';
            if (!options.dryRun) saveSnapshot(journalPath, record);
            records.push({ journalPath, treePath: path, state: record.state });
            continue;
          }
          decision = hold(path, 'snapshot-unverified');
        } else if (record.state === 'published_verified') {
          // Consult the same lock as publication and journal callbacks. A live
          // or unreadable owner holds; lockSnapshot can recover a stale owner.
          try { if (enabled) release = lockSnapshot(journalPath); }
          catch { decision = hold(path, 'snapshot-pending'); }
          if (!decision) {
            const verified = verifySnapshotRecord(record, { ...options, repositoryPath: root });
            decision = verified.state !== 'ok' ? hold(path, 'snapshot-unverified') :
              enabled ? continuation(path) :
                hold(path, 'snapshot-pending');
          }
        } else {
          // U4a owns push/advance/read-back and its empty-ref lease. Never allocate
          // another ref, rebuild from new dirt, or duplicate that resume protocol.
          const resumed = options.dryRun ? { ...negative(), veto: 'snapshot-pending' } :
            publishSnapshot(tree, null, { ...options, snapshotMutationsEnabled: enabled });
          if (resumed.state === 'ok') record = resumed.value;
          else record = readSnapshot(journalPath, saved.treePath, identity.value);
          requireEvidence(record.state !== 'removed', 'Snapshot binding changed during reconciliation');
          decision = resumed.state !== 'ok' ? hold(path, resumed.veto === 'snapshot-pending' ? 'snapshot-pending' : 'snapshot-unverified') :
            enabled ? continuation(path) :
              hold(path, 'snapshot-pending');
        }
        // An invalid duplicate record cannot be overwritten by a valid record.
        if (worktrees.get(normalizePath(path))?.reasonCode !== 'unknown') worktrees.set(normalizePath(path), decision);
        records.push({ journalPath, treePath: path, state: record.state, reasonCode: decision.reasonCode ?? 'snapshot' });
      } catch {
        records.push({ journalPath, reasonCode: failureReason });
        // Only the hashed filename and parsed tree path can bind a journal.
        // Stray journals remain report notes without holding unrelated trees.
        for (const tree of matched) {
          if (worktrees.get(normalizePath(tree.path))?.reasonCode !== 'unknown') {
            worktrees.set(normalizePath(tree.path), hold(tree.path, failureReason, null));
          }
        }
      } finally { release?.(); }
    }
    return ok({ worktrees: [...worktrees.values()], records });
  } catch { return unknown('Snapshot reconciliation unavailable'); }
}

/** Publish one preflightSnapshot ok result. A pending journal takes precedence
 * over admission; resume may pass null and never reads source files. The returned
 * ok value is the byte-free journal record plus journalPath. Ref is fully qualified.
 * Pending and published_verified records ignore the passed preflight by design.
 * No coordinator or cleanup is invoked here.
 * @param {object} tree
 * @param {ReturnType<typeof preflightSnapshot>|null} preflight
 * @param {{reportRoot: string, remotePath?: string, repository?: string, gitPath?: string,
 * now?: string, timeout?: number, softDeadline?: number, deadlineNow?: () => number,
 * runGit?: typeof runRescueCommand, afterPush?: () => void, snapshotMutationsEnabled?: boolean, dryRun?: boolean}} options
 */
export function publishSnapshot(tree, preflight, options) {
  let release, scratch, record, journalPath;
  const hold = (veto) => ({ ...negative(), veto, journalState: record?.state ?? null, journalPath: journalPath ?? null });
  try {
    requireEvidence(typeof tree?.path === 'string' && isAbsolute(tree.path) &&
      typeof options?.reportRoot === 'string' && isAbsolute(options.reportRoot), 'Snapshot paths unavailable');
    const root = resolve(tree.path), treePath = normalizePath(root);
    const directory = join(resolve(options.reportRoot), 'snapshots'), journalDirectory = normalizePath(directory);
    requireEvidence(journalDirectory !== treePath && !journalDirectory.startsWith(treePath + '/'), 'Journal must be outside the source tree');
    assertUnlinkedAncestors(root);
    const { inspectionEnv, env, run, git, remote, network, remoteHead } = snapshotRemote(root, options);
    let ancestor = directory;
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    assertUnlinkedAncestors(ancestor);
    mkdirSync(directory, { recursive: true }); assertUnlinkedAncestors(directory);
    journalPath = join(directory, createHash('sha256').update(treePath).digest('hex') + '.json');
    if (!options.dryRun) release = lockSnapshot(journalPath);
    const common = normalizePath(resolve(root, git(['rev-parse', '--git-common-dir']).trim()));
    const identity = JSON.stringify([common, remote]);
    record = readSnapshot(journalPath, treePath, identity);
    const save = () => { if (!options.dryRun) saveSnapshot(journalPath, record); };
    const result = () => ok({ ...record, journalPath });
    if (record?.state === 'removed' && preflight == null) return result();

    scratch = mkdtempSync(join(tmpdir(), 'worktree-snapshot-index-'));
    const privateEnv = { ...env, GIT_INDEX_FILE: join(scratch, 'index') };
    const buildTree = (head, files) => {
      git(['read-tree', head], { env: privateEnv });
      for (const file of files) git(['update-index', '--add', '--cacheinfo', file.mode, file.digest, file.path], { env: privateEnv });
      return snapshotSha(git(['write-tree'], { env: privateEnv }));
    };
    if (!record || record.state === 'removed') {
      const admitted = preflight?.state === 'ok' ? preflight.value : null, evidence = admissions.get(admitted);
      requireEvidence(evidence?.treePath === treePath && admitted.files.length > 0 &&
        equal(evidence.files, admitted.files.map(({ path, kind, digest }) => ({ path, kind, digest }))), 'Snapshot admission unavailable or changed');
      const { head, branch } = evidence;
      const history = record ? [...(record.history ?? []), { ref: record.ref, commitSha: record.commitSha, head: record.head }] : [];
      const now = options.now ?? new Date().toISOString();
      requireEvidence(typeof now === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(now) && Number.isFinite(Date.parse(now)), 'Invalid snapshot date');
      const name = basename(root), stem = `rescue/${name}-${new Date(now).toISOString().slice(0, 10)}`;
      for (const candidate of [name, stem]) {
        const check = run(['check-ref-format', '--branch', candidate]);
        if (check.state !== 'ok') {
          if (check.exitCode === 128 || check.exitCode === 1) return hold('snapshot-invalid-ref-name');
          throw new Error('Ref validation unavailable');
        }
      }
      const files = admitted.files.map(file => {
        requireEvidence(Buffer.isBuffer(file.bytes) && snapshotSha(git(['hash-object', '-w', '--stdin'], { input: file.bytes })) === file.digest,
          'Snapshot buffer integrity failed');
        let mode;
        if (file.kind === 'modified') {
          const raw = git(['ls-tree', '-z', head, '--', file.path]);
          const match = /^(100644|100755) blob [a-f0-9]+\t([^\0]+)\0$/.exec(raw);
          requireEvidence(match?.[2] === file.path, 'Tracked snapshot mode unavailable');
          mode = match[1];
        } else mode = process.platform !== 'win32' && (lstatSync(join(root, file.path)).mode & 0o111) ? '100755' : '100644';
        return { path: file.path, kind: file.kind, digest: file.digest, mode };
      });
      const treeSha = buildTree(head, files);
      // Fresh status discovers additions outside the originally scanned directories
      // too. Reuse the inventory's disposable sets, then re-run U3's secret gate.
      const status = parseStatus(git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], { env: inspectionEnv }));
      const entries = status.filter(entry => entry.index !== '!');
      const ignored = status.filter(entry => entry.index === '!').map(entry => entry.path);
      const fresh = preflightSnapshot({ ...tree, registration: ok({ head, branch }), status: ok({ clean: entries.length === 0, entries }),
        ignored: ok({ entries: ignored, unexpected: ignored.filter(path => !allowedFiles.has(path) &&
          !(path.includes('/') && allowedDirectories.has(path.split('/')[0]))) }) },
      { timeout: options.timeout, softDeadline: options.softDeadline, deadlineNow: options.deadlineNow });
      requireEvidence(fresh.state === 'ok' && equal(evidence.files,
        fresh.value.files.map(({ path, kind, digest }) => ({ path, kind, digest }))), 'Snapshot source freshness failed');
      for (const file of files) requireEvidence(blobOid(readRegular(join(root, file.path)).bytes, head) === file.digest, 'Snapshot source freshness failed');
      requireEvidence(snapshotSha(git(['rev-parse', 'HEAD'], { env: inspectionEnv })) === head, 'Snapshot HEAD changed');
      const commitSha = snapshotSha(git(['-c', 'commit.gpgSign=false', 'commit-tree', treeSha, '-p', head],
        { input: `Snapshot worktree ${root}\n\nSource branch: ${branch ?? '(detached)'}\nSource HEAD: ${head}\n` }));
      let ref;
      for (let suffix = 1; suffix <= 1000; suffix++) {
        const candidate = `refs/heads/${stem}${suffix === 1 ? '' : `-${suffix}`}`;
        if (history.some(previous => previous.ref === candidate)) continue;
        if (remoteHead(candidate) === null) { ref = candidate; break; }
      }
      requireEvidence(ref, 'No unused snapshot ref');
      record = { schema: SCHEMA, treePath, identity, head, branch, ref, commitSha, treeSha, files, state: 'not_pushed',
        ...(history.length ? { history } : {}) };
      save();
    }
    git(['check-ref-format', record.ref]);
    // Validate durable objects, ancestry and the entire tree before resuming.
    // Source paths and new admission buffers are deliberately not consulted.
    for (const file of record.files) requireEvidence(git(['cat-file', '-t', file.digest]).trim() === 'blob', 'Snapshot blob missing');
    requireEvidence(git(['rev-list', '--parents', '-n', '1', record.commitSha]).trim() === `${record.commitSha} ${record.head}` &&
      snapshotSha(git(['rev-parse', `${record.commitSha}^{tree}`])) === record.treeSha &&
      buildTree(record.head, record.files) === record.treeSha, 'Snapshot journal commit mismatch');
    if (record.state === 'not_pushed') {
      const remoteSha = remoteHead(record.ref);
      if (remoteSha !== null && remoteSha !== record.commitSha) return hold('snapshot-unverified');
      if (remoteSha === null && (options.snapshotMutationsEnabled === false || options.dryRun)) return hold('snapshot-pending');
      if (remoteSha === null) git([...network, '-c', `core.hooksPath=${NULL_DEVICE}`, 'push', '--porcelain',
        `--force-with-lease=${record.ref}:`, remote, `${record.commitSha}:${record.ref}`]);
      record.state = 'pushed_unverified'; save();
      options.afterPush?.();
    }
    // Never substitute a cached allocation/push observation for either read.
    const firstRemoteSha = remoteHead(record.ref), secondRemoteSha = remoteHead(record.ref);
    if (firstRemoteSha !== record.commitSha || secondRemoteSha !== record.commitSha) return hold('snapshot-unverified');
    record.state = 'published_verified'; save();
    return result();
  } catch {
    // Command errors can contain paths, credentials or content. Report only the
    // bounded veto and durable state, never command stderr or admitted buffers.
    return hold(record ? 'snapshot-unverified' : 'snapshot-publication-refused');
  } finally {
    try {
      if (scratch && dirname(resolve(scratch)) === resolve(tmpdir()) && basename(scratch).startsWith('worktree-snapshot-index-')) {
        rmSync(scratch, { recursive: true, force: true });
      }
    } catch { /* Only the private index remains. */ }
    try { release?.(); } catch { /* A retained lock holds a later call. */ }
  }
}
