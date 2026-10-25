import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, statfsSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertUnlinkedAncestors } from './safe-path.mjs';
import { allowedDirectories as buildDirectories, allowedFiles as buildFiles, candidateInventory, inventory, isWithin, normalizePath, parseWorktrees, walkDirectory } from './inventory.mjs';
import { removalStopReason } from './remove.mjs';
import { collectActivity } from './activity.mjs';
import { planWorktrees } from './policy.mjs';
import { idleEvidence } from './idle-journal.mjs';
import { boundedTimeout, equal, fingerprint, ok, remainingTime, requireEvidence, resolveExecutable, unknown, withDeadline } from './probe.mjs';

export const MAX_ARCHIVE_BYTES = 2 * 1024 ** 3;
const DAY = 86_400_000, OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/, SHA = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function value(result, label) {
  if (result?.hold) throw Object.assign(new Error(result.hold.reason), { removalResult: result.hold });
  if (result?.stopReason) throw Object.assign(new Error(result.reason ?? label), { stopReason: result.stopReason });
  requireEvidence(result?.state === 'ok', `${label}: ${result?.reason ?? 'unavailable'}`); return result.value;
}
function absent(path) {
  try { return lstatSync(path, { throwIfNoEntry: false }) === undefined; }
  catch (error) { if (error.code === 'ENOTDIR') return true; throw error; }
}
function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git' &&
      !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}
function ancestors(path) {
  remainingTime();
  assertUnlinkedAncestors(path, { message: 'Linked or invalid directory ancestor' });
}
function createDirectory(path) {
  // Validate before mkdir: checking afterward is too late when an existing
  // ancestor is a junction, even if a caller injects a free-space provider.
  let existing = resolve(path);
  while (absent(existing)) existing = dirname(existing);
  ancestors(existing); mkdirSync(path, { recursive: true }); ancestors(path);
}
function regular(path) {
  ancestors(dirname(path));
  const stat = lstatSync(path); requireEvidence(stat.isFile() && !stat.isSymbolicLink(), 'Not a regular file');
  return stat;
}
export function readRegular(path) {
  const before = regular(path), fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    requireEvidence(equal(fingerprint(before), fingerprint(fstatSync(fd))), 'File changed before read');
    const bytes = readFileSync(fd);
    requireEvidence(equal(fingerprint(before), fingerprint(fstatSync(fd))) && equal(fingerprint(before), fingerprint(lstatSync(path))), 'File changed during read');
    return { bytes, sha256: sha256(bytes), stat: before };
  } finally { closeSync(fd); }
}
function writeNew(root, path, bytes) {
  requireEvidence(safeRelative(path), 'Unsafe archive path');
  ancestors(root); createDirectory(dirname(join(root, path)));
  writeFileSync(join(root, path), bytes, { flag: 'wx', mode: 0o600 });
}
export function blobOid(bytes, head) {
  return createHash(head.length === 64 ? 'sha256' : 'sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function gitRunner(options = {}) {
  const executable = value(resolveExecutable(options.gitPath ?? 'git'), 'Git executable');
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
  // Binary specialization of probe: cat-file, bundle and hash-object must never
  // pass through UTF-8 decoding, autocrlf, a shell, or a path-based Git filter.
  return (cwd, args, input = undefined, maxBuffer = MAX_ARCHIVE_BYTES) => {
    const result = spawnSync(executable, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', cwd, ...args],
      { env, input, timeout: boundedTimeout(options, 120_000), maxBuffer, windowsHide: true, shell: false });
    remainingTime(options);
    requireEvidence(!result.error && !result.signal && result.status === 0, `Git ${args[0]} failed: ${result.error?.message ?? result.stderr?.toString('utf8')}`);
    return result.stdout;
  };
}
function text(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function scalar(bytes) { const output = text(bytes); requireEvidence(output.endsWith('\n'), 'Invalid Git scalar'); return output.replace(/\r?\n$/, ''); }
function records(bytes) { const output = text(bytes); requireEvidence(!output || output.endsWith('\0'), 'Incomplete Git records'); return output ? output.slice(0, -1).split('\0') : []; }
function entries(bytes, index = false) {
  const seen = new Set();
  return records(bytes).map(row => {
    const match = index ? /^(100644|100755) ([a-f0-9]{40}|[a-f0-9]{64}) 0\t([\s\S]+)$/.exec(row) : /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(row);
    requireEvidence(match && safeRelative(match[3]) && !seen.has(match[3].toLowerCase()), 'Unsupported, conflicted or ambiguous Git entry');
    seen.add(match[3].toLowerCase()); return { path: match[3], mode: match[1], oid: match[2] };
  }).sort((a, b) => a.path.localeCompare(b.path));
}
function gitState(path, git) {
  const head = scalar(git(path, ['rev-parse', 'HEAD'])); requireEvidence(OID.test(head), 'Invalid HEAD');
  const indexPath = scalar(git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
  requireEvidence(isAbsolute(indexPath), 'Index path is not absolute');
  const indexHash = readRegular(indexPath).sha256;
  const flags = records(git(path, ['ls-files', '-v', '-z']));
  requireEvidence(flags.every(row => row.startsWith('H ')), 'Unmerged, sparse or hidden index entries');
  const diffArgs = ['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff'];
  requireEvidence(git(path, [...diffArgs, '--ita-visible-in-index']).equals(git(path, [...diffArgs, '--ita-invisible-in-index'])), 'Intent-to-add index entries are unsupported');
  const headEntries = entries(git(path, ['ls-tree', '-r', '-z', head]));
  const indexEntries = entries(git(path, ['ls-files', '--stage', '-z']), true);
  const branch = scalar(git(path, ['rev-parse', '--symbolic-full-name', 'HEAD']));
  requireEvidence(branch === 'HEAD' || branch.startsWith('refs/heads/'), 'Invalid branch');
  requireEvidence(readRegular(indexPath).sha256 === indexHash, 'Index changed during inventory');
  return { head, indexPath, indexHash, headEntries, indexEntries, branch: branch === 'HEAD' ? null : branch };
}
function allowed(path) { return buildFiles.has(path) || buildDirectories.has(path.split('/')[0]); }
/** Full no-follow walk, including ignored directories. Only a proven top-level
 * node_modules junction may be skipped; callers supply U1's evidence for it. */
function filesystem(root, tracked, links, timeout) {
  const files = [], directories = [], emptyDirectories = [];
  value(walkDirectory(root, { timeout, visit: ({ path, name, directory, stat }) => {
    const rel = relative(root, path).split(sep).join('/');
    if (name.toLowerCase() === '.git') { requireEvidence(directory === root, 'Nested repository'); return false; }
    requireEvidence(safeRelative(rel), 'Unsafe filesystem path');
    if (stat.isSymbolicLink()) {
      requireEvidence(rel === 'node_modules' && links?.entries?.some(link => link.relativePath === rel && link.kind === 'junction' && link.targetIdentity.state === 'ok'), 'Forbidden filesystem link');
      return false;
    }
    if (stat.isDirectory()) {
      if (!allowed(rel)) { directories.push(rel); if (readdirSync(path).length === 0) emptyDirectories.push(rel); }
    } else if (tracked.has(rel) || !allowed(rel)) files.push({ path: rel, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777 });
  } }), 'Full filesystem inventory');
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), directories: directories.sort(), emptyDirectories: emptyDirectories.sort() };
}
export function defaultArchiveRoot() {
  requireEvidence(isAbsolute(process.env.LOCALAPPDATA ?? ''), 'LOCALAPPDATA unavailable');
  return join(process.env.LOCALAPPDATA, 'WorkflowTools', 'worktree-cleanup', 'archives');
}
function freeSpace(path) {
  while (absent(path)) path = dirname(path);
  ancestors(path); const info = statfsSync(path, { bigint: true }); return Number(info.bavail * info.bsize);
}
function removeArchiveDirectory(path, root, staleBefore) {
  requireEvidence(dirname(resolve(path)) === resolve(root) && resolve(path) !== resolve(root), 'Archive removal escaped root');
  ancestors(path);
  const files = [], dirs = [];
  let newestMtimeMs = lstatSync(path).mtimeMs;
  value(walkDirectory(path, { visit: ({ path: entry, stat }) => {
    requireEvidence(!stat.isSymbolicLink(), 'Linked archive entry');
    newestMtimeMs = Math.max(newestMtimeMs, stat.mtimeMs);
    if (stat.isDirectory()) dirs.push(entry); else files.push(entry);
  } }), 'Archive deletion inventory');
  requireEvidence(Number.isFinite(newestMtimeMs), 'Invalid archive modification time');
  if (staleBefore !== undefined && newestMtimeMs >= staleBefore) return false;
  for (const file of files) { regular(file); unlinkSync(file); }
  for (const dir of dirs.sort((a, b) => b.length - a.length)) { ancestors(dir); rmdirSync(dir); }
  ancestors(path);
  rmdirSync(path);
  return true;
}
function removeStagingDirectory(path, root, staleBefore) {
  const stagingRoot = join(resolve(root), '.staging');
  requireEvidence(dirname(resolve(path)) === stagingRoot, 'Not an archive staging directory');
  // The run may have expired mid-write. Keep no-follow checks and a fresh,
  // bounded cleanup budget; never inherit the expired mutation deadline.
  return withDeadline(performance.now() + 30_000, () => performance.now(), () => removeArchiveDirectory(path, stagingRoot, staleBefore));
}

/** Create and verify a local copy only. This never changes the worktree/index.
 * U6 records observations and classifies first; prepareArchivedTree is the
 * separate, gated cleanup boundary. Buffers are read once and then hashed/written.
 * @param {string} treePath
 * @param {{archiveRoot?: string, gitPath?: string, timeout?: number, walkTimeout?: number, snapshot?: object,
 * now?: () => number, runId?: string, maxArchiveBytes?: number, freeBytes?: (path: string) => number,
 * onBeforeVerify?: (path: string) => void, onRegistrationDelta?: (delta: import('./remove.mjs').RegistrationDelta) => void}} options
 */
export function createArchive(treePath, options = {}) {
  let stagingPath, root;
  try {
    treePath = resolve(treePath);
    const checked = options.snapshot ? candidateInventory(treePath, options.snapshot, options) : null;
    if (checked?.hold) return ok(checked.hold);
    ancestors(treePath);
    root = resolve(options.archiveRoot ?? defaultArchiveRoot());
    requireEvidence(!isWithin(root, treePath) && !isWithin(treePath, root), 'Archive root overlaps worktree');
    const git = gitRunner(options), state = gitState(treePath, git);
    const scan = value(checked ??
      inventory({ repositoryPath: treePath, runnerPath: treePath, gitPath: options.gitPath, walkTimeout: options.walkTimeout }), 'Repository inventory');
    requireEvidence(!scan.registrations.some(tree => isWithin(root, tree.path)), 'Archive root must be outside all repository worktrees');
    const tree = scan.worktrees.find(item => normalizePath(item.path) === normalizePath(treePath));
    requireEvidence(tree?.identity?.state === 'ok' && tree.links?.state === 'ok' && !tree.links.value.forbidden.length &&
      tree.containment?.state === 'ok' && !tree.containment.value.children.length && !tree.containment.value.unregisteredRepositories.length, 'Unsafe archive source');
    const head = new Map(state.headEntries.map(entry => [entry.path, entry])), index = new Map(state.indexEntries.map(entry => [entry.path, entry]));
    const tracked = new Set([...head.keys(), ...index.keys()]);
    const disk = filesystem(treePath, tracked, tree.links.value, options.walkTimeout);
    const limit = Math.min(options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES);
    requireEvidence(Number.isSafeInteger(limit) && limit > 0, 'Invalid archive ceiling');
    // Reject oversized files before allocation. The exact aggregate (including
    // manifest and bundle) is checked again before creating any directory.
    requireEvidence(disk.files.every(file => file.size <= limit), 'Archive exceeds 2 GB ceiling');
    const payloads = new Map(), files = new Map(); let payloadSize = 0;
    function retain(path, bytes) { payloadSize += bytes.length; requireEvidence(payloadSize <= limit, 'Archive exceeds 2 GB ceiling'); payloads.set(path, bytes); }
    for (const file of disk.files) {
      const read = readRegular(join(treePath, file.path));
      requireEvidence(read.stat.size === file.size && read.stat.mtimeMs === file.mtimeMs, 'File changed after inventory');
      const same = head.has(file.path) && blobOid(read.bytes, state.head) === head.get(file.path).oid;
      // A same-HEAD raw file can be rebuilt from HEAD without checkout filters.
      // Record its hash too: LF under autocrlf must not silently become CRLF.
      files.set(file.path, { kind: same ? 'head' : 'file', sha256: read.sha256, size: read.bytes.length, mtimeMs: read.stat.mtimeMs, mode: file.mode });
      if (!same) retain('files/' + file.path, read.bytes);
    }
    const manifestEntries = [];
    for (const path of [...new Set([...tracked, ...files.keys()])].sort()) {
      const h = head.get(path), i = index.get(path);
      let staged = { kind: 'deleted' };
      if (i && h && i.oid === h.oid && i.mode === h.mode) staged = { kind: 'head' };
      else if (i) {
        const size = Number(scalar(git(treePath, ['cat-file', '-s', i.oid])));
        requireEvidence(Number.isSafeInteger(size) && size >= 0 && payloadSize + size <= limit, 'Archive exceeds 2 GB ceiling');
        const bytes = git(treePath, ['cat-file', 'blob', i.oid]);
        requireEvidence(blobOid(bytes, state.head) === i.oid, 'Index blob mismatch');
        retain('staged/' + path, bytes); staged = { kind: 'blob', oid: i.oid, mode: i.mode, sha256: sha256(bytes), size: bytes.length };
      }
      manifestEntries.push({ path, working: files.get(path) ?? { kind: 'deleted' }, index: staged });
    }
    const refs = text(git(treePath, ['for-each-ref', '--format=%(refname)', '--contains', state.head, 'refs/heads', 'refs/tags', 'refs/remotes'])).trim();
    let bundle = null;
    if (!refs) {
      const bytes = git(treePath, ['bundle', 'create', '-', 'HEAD']); retain('HEAD.bundle', bytes);
      bundle = { sha256: sha256(bytes), size: bytes.length };
    }
    const createdAt = (options.now ?? Date.now)(); requireEvidence(Number.isFinite(createdAt), 'Invalid archive clock');
    const manifest = { version: 1, worktreePath: treePath, repositoryPath: resolve(scan.primaryPath), commonDirectory: tree.identity.value.commonDirectory,
      HEAD: state.head, branch: state.branch, branchTip: state.branch ? state.head : null, createdAt, runId: options.runId ?? randomUUID(),
      indexHash: state.indexHash, headEntries: state.headEntries, entries: manifestEntries, directories: disk.directories, emptyDirectories: disk.emptyDirectories, bundle };
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    const totalBytes = payloadSize + manifestBytes.length;
    requireEvidence(totalBytes <= limit, 'Archive exceeds 2 GB ceiling');
    const available = (options.freeBytes ?? freeSpace)(root);
    requireEvidence(Number.isFinite(available) && available >= 2 * totalBytes, 'Free space below twice archive size');
    requireEvidence(equal(state, gitState(treePath, git)), 'HEAD or index changed during archive');
    // Staging is private and excluded from discovery until verified publication.
    createDirectory(root);
    const name = `${basename(treePath)}-${state.head.slice(0, 7)}-${new Date(createdAt).toISOString().slice(0, 10).replaceAll('-', '')}`;
    requireEvidence(name !== '.staging', 'Archive name is reserved for staging');
    const archivePath = join(root, name);
    requireEvidence(absent(archivePath), 'Archive destination already exists');
    const stagingRoot = join(root, '.staging'); createDirectory(stagingRoot);
    const staging = join(stagingRoot, `${randomUUID()}-${name}`);
    mkdirSync(staging); stagingPath = staging;
    for (const [path, bytes] of payloads) writeNew(stagingPath, path, bytes);
    writeNew(stagingPath, 'manifest.json', manifestBytes);
    options.onBeforeVerify?.(stagingPath);
    value(verifyArchive(stagingPath, options), 'Archive verification');
    ancestors(stagingPath);
    requireEvidence(absent(archivePath), 'Archive destination already exists');
    remainingTime(options);
    renameSync(stagingPath, archivePath);
    stagingPath = undefined;
    return ok({ archivePath, manifest, totalBytes, restoreCommand: `node scripts/worktree-cleanup.mjs restore ${JSON.stringify(archivePath)}` });
  } catch (error) {
    let cleanup = '';
    if (stagingPath) { try { removeStagingDirectory(stagingPath, root); } catch (failure) { cleanup = `; partial archive cleanup failed: ${String(failure)}`; } }
    return { ...unknown(`Archive held: ${String(error)}${cleanup}`), stopReason: error.stopReason ?? null };
  }
}
function readManifest(archivePath) {
  ancestors(archivePath);
  const manifest = JSON.parse(text(readRegular(join(archivePath, 'manifest.json')).bytes));
  requireEvidence(manifest.version === 1 && isAbsolute(manifest.worktreePath ?? '') && isAbsolute(manifest.repositoryPath ?? '') &&
    isAbsolute(manifest.commonDirectory ?? '') && OID.test(manifest.HEAD ?? '') && SHA.test(manifest.indexHash ?? '') &&
    Number.isFinite(manifest.createdAt) && typeof manifest.runId === 'string' && manifest.runId.length > 0 &&
    (manifest.branch === null ? manifest.branchTip === null : typeof manifest.branch === 'string' && manifest.branch.startsWith('refs/heads/') && manifest.branchTip === manifest.HEAD), 'Invalid manifest identity');
  requireEvidence(!isWithin(archivePath, manifest.worktreePath) && !isWithin(manifest.worktreePath, archivePath), 'Archive overlaps restore path');
  requireEvidence(Array.isArray(manifest.headEntries) && Array.isArray(manifest.entries) && Array.isArray(manifest.directories) && Array.isArray(manifest.emptyDirectories), 'Invalid manifest collections');
  const head = new Map(), paths = new Set();
  for (const entry of manifest.headEntries) {
    requireEvidence(safeRelative(entry.path) && OID.test(entry.oid ?? '') && ['100644', '100755'].includes(entry.mode) && !head.has(entry.path.toLowerCase()), 'Invalid HEAD entry');
    head.set(entry.path.toLowerCase(), entry);
  }
  for (const entry of manifest.entries) {
    requireEvidence(safeRelative(entry.path) && !paths.has(entry.path.toLowerCase()), 'Unsafe or duplicate manifest entry'); paths.add(entry.path.toLowerCase());
    const w = entry.working, i = entry.index, h = head.get(entry.path.toLowerCase());
    requireEvidence(w && ['head', 'file', 'deleted'].includes(w.kind) && (w.kind !== 'head' || h) &&
      (w.kind === 'deleted' || (SHA.test(w.sha256 ?? '') && Number.isSafeInteger(w.size) && w.size >= 0 && Number.isFinite(w.mtimeMs) && Number.isInteger(w.mode) && w.mode >= 0 && w.mode <= 0o777)), 'Invalid working state');
    requireEvidence(i && ['head', 'blob', 'deleted'].includes(i.kind) && (i.kind !== 'head' || h) &&
      (i.kind !== 'blob' || (OID.test(i.oid ?? '') && SHA.test(i.sha256 ?? '') && Number.isSafeInteger(i.size) && i.size >= 0 && ['100644', '100755'].includes(i.mode))), 'Invalid index state');
  }
  requireEvidence([...head.keys()].every(path => paths.has(path)), 'Manifest omits HEAD entries');
  for (const list of [manifest.directories, manifest.emptyDirectories]) {
    requireEvidence(list.every(safeRelative) && new Set(list.map(path => path.toLowerCase())).size === list.length, 'Invalid directory list');
  }
  requireEvidence(manifest.emptyDirectories.every(path => manifest.directories.includes(path)) &&
    (!manifest.bundle || (SHA.test(manifest.bundle.sha256 ?? '') && Number.isSafeInteger(manifest.bundle.size) && manifest.bundle.size > 0)), 'Invalid bundle or empty directories');
  return manifest;
}
/** @param {string} archivePath @param {{gitPath?: string, timeout?: number}} options */
export function verifyArchive(archivePath, options = {}) {
  try {
    archivePath = resolve(archivePath); const manifest = readManifest(archivePath), git = gitRunner(options);
    const expected = new Map([['manifest.json', null]]), payloads = new Map();
    for (const entry of manifest.entries) {
      if (entry.working.kind === 'file') expected.set('files/' + entry.path, entry.working);
      if (entry.index.kind === 'blob') expected.set('staged/' + entry.path, entry.index);
    }
    if (manifest.bundle) expected.set('HEAD.bundle', manifest.bundle);
    let totalBytes = 0;
    value(walkDirectory(archivePath, { visit: ({ path, stat }) => {
      requireEvidence(!stat.isSymbolicLink(), 'Linked archive entry');
      if (!stat.isFile()) return;
      const rel = relative(archivePath, path).split(sep).join('/'); requireEvidence(expected.has(rel), 'Unexpected archive file');
      totalBytes += stat.size; requireEvidence(totalBytes <= MAX_ARCHIVE_BYTES, 'Archive exceeds ceiling');
      const read = readRegular(path), record = expected.get(rel);
      if (record) requireEvidence(read.sha256 === record.sha256 && read.bytes.length === record.size, 'Archived content hash mismatch');
      if (rel.startsWith('staged/')) requireEvidence(blobOid(read.bytes, manifest.HEAD) === record.oid, 'Staged blob SHA mismatch');
      payloads.set(rel, read.bytes); expected.delete(rel);
    } }), 'Archive readback');
    requireEvidence(expected.size === 0, 'Missing archived payload');
    requireEvidence(equal(manifest, JSON.parse(text(payloads.get('manifest.json')))), 'Manifest changed during readback');
    ancestors(manifest.repositoryPath);
    requireEvidence(normalizePath(scalar(git(manifest.repositoryPath, ['rev-parse', '--path-format=absolute', '--git-common-dir']))) === normalizePath(manifest.commonDirectory), 'Repository identity changed');
    if (manifest.bundle) {
      git(manifest.repositoryPath, ['bundle', 'verify', join(archivePath, 'HEAD.bundle')]);
      requireEvidence(text(git(manifest.repositoryPath, ['bundle', 'list-heads', join(archivePath, 'HEAD.bundle')])).split('\n').some(row => row === `${manifest.HEAD} HEAD`), 'Bundle does not contain recorded HEAD');
    } else requireEvidence(scalar(git(manifest.repositoryPath, ['rev-parse', '--verify', `${manifest.HEAD}^{commit}`])) === manifest.HEAD, 'Recorded HEAD unavailable');
    return ok({ archivePath, manifest, totalBytes, payloads });
  } catch (error) { return unknown(`Archive verification failed: ${String(error)}`); }
}
function writeWorking(root, path, bytes, working) {
  const full = join(root, path); createDirectory(dirname(full));
  if (!absent(full)) { regular(full); unlinkSync(full); }
  writeFileSync(full, bytes, { flag: 'wx', mode: working.mode });
  // User-facing restore is new activity, even though its bytes are historical.
  chmodSync(full, working.mode);
}
/** Restore is detached first, and never moves a branch. A failure leaves the
 * partially restored target and the archive for inspection; it never retries.
 * @param {string} archivePath @param {{gitPath?: string, timeout?: number}} options
 */
export function restoreArchive(archivePath, options = {}) {
  try {
    const { manifest: m, payloads } = value(verifyArchive(archivePath, options), 'Restore verification');
    requireEvidence(absent(m.worktreePath), 'Restore target already exists');
    ancestors(dirname(m.worktreePath)); const git = gitRunner(options);
    if (m.bundle) git(m.repositoryPath, ['bundle', 'unbundle', join(resolve(archivePath), 'HEAD.bundle')]);
    requireEvidence(equal(entries(git(m.repositoryPath, ['ls-tree', '-r', '-z', m.HEAD])), m.headEntries), 'Manifest HEAD tree mismatch');
    // --no-checkout prevents smudge filters or autocrlf from running at all.
    git(m.repositoryPath, ['worktree', 'add', '--detach', '--no-checkout', m.worktreePath, m.HEAD]);
    const root = m.worktreePath;
    git(root, ['read-tree', m.HEAD]);
    const indexPath = scalar(git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])); regular(indexPath);
    if (m.branch) {
      const refs = text(git(m.repositoryPath, ['for-each-ref', '--format=%(refname) %(objectname)', m.branch])).trim().split('\n');
      const listed = text(git(m.repositoryPath, ['worktree', 'list', '--porcelain', '-z']));
      if (refs.includes(`${m.branch} ${m.branchTip}`) && !listed.split('\0').includes('branch ' + m.branch)) git(root, ['symbolic-ref', 'HEAD', m.branch]);
    }
    const head = new Map(m.headEntries.map(entry => [entry.path, entry]));
    // Apply all deletions before additions so directory/file swaps cannot collide
    // with an old child entry still present in the HEAD index.
    for (const entry of m.entries.filter(entry => entry.index.kind === 'deleted' && head.has(entry.path))) git(root, ['update-index', '--force-remove', '--', entry.path]);
    for (const entry of m.entries) {
      const i = entry.index;
      if (i.kind === 'blob') {
        const oid = scalar(git(root, ['hash-object', '-w', '--stdin'], payloads.get('staged/' + entry.path)));
        requireEvidence(oid === i.oid, 'Restored staged blob mismatch');
        git(root, ['update-index', '--add', '--cacheinfo', i.mode, i.oid, entry.path]);
      }
    }
    // No checkout means deletions already exist as absences. Rebuild all working
    // states using raw archive/HEAD bytes; directory/file swaps need no recursion.
    for (const entry of m.entries) {
      const w = entry.working; if (w.kind === 'deleted') continue;
      const bytes = w.kind === 'file' ? payloads.get('files/' + entry.path) : git(root, ['cat-file', 'blob', head.get(entry.path).oid]);
      requireEvidence(sha256(bytes) === w.sha256, 'Restored source hash mismatch'); writeWorking(root, entry.path, bytes, w);
    }
    for (const path of m.emptyDirectories) createDirectory(join(root, path));
    const restored = gitState(root, git), expectedIndex = m.entries.flatMap(entry => entry.index.kind === 'deleted' ? [] : [entry.index.kind === 'head' ? head.get(entry.path) : { path: entry.path, mode: entry.index.mode, oid: entry.index.oid }]).sort((a, b) => a.path.localeCompare(b.path));
    requireEvidence(restored.head === m.HEAD && equal(restored.indexEntries, expectedIndex), 'Restored index differs from manifest');
    for (const entry of m.entries) {
      const path = join(root, entry.path);
      if (entry.working.kind === 'deleted') requireEvidence(absent(path) || lstatSync(path).isDirectory(), 'Restored deletion mismatch');
      else requireEvidence(readRegular(path).sha256 === entry.working.sha256, 'Restored working hash mismatch');
    }
    requireEvidence(m.emptyDirectories.every(path => readdirSync(join(root, path)).length === 0), 'Restored empty directory mismatch');
    return ok({ path: root, HEAD: m.HEAD, branch: restored.branch });
  } catch (error) { return unknown(`Restore held: ${String(error)}`); }
}
/**
 * Clean verified leftovers, then return a fresh U5 plan + classification snapshot.
 * This function never deregisters a worktree. U6 passes a clean result to U5's
 * executeRemovals; hold/pending results must not be passed on. The supplied U1+U2
 * snapshot is the original classification, not an inventory taken after copying.
 * @param {string} archivePath
 * @param {{primaryPath: string, runnerPath: string, worktrees: object[], commonDirectory: object}} baseline
 * @param {{gitPath?: string, timeout?: number, walkTimeout?: number, journalPath?: string, now?: () => number, softDeadline?: number, deadlineNow?: () => number,
 * activityOptions?: import('./activity.mjs').ActivityOptions, prSnapshot?: object, ghPath?: string,
 * onBeforeMutation?: (event: {kind: string, path: string}) => void|Promise<void>,
 * onRegistrationDelta?: (delta: import('./remove.mjs').RegistrationDelta) => void}} options
 */
export async function prepareArchivedTree(archivePath, baseline, options = {}) {
  let changed = false;
  let sourcePath;
  const mutations = [];
  const outcome = result => {
    const structured = { ...result, mutations, stopReason: result.stopReason ?? null };
    structured.stopReason = removalStopReason(structured);
    return ok(structured);
  };
  try {
    const { manifest: m } = value(verifyArchive(archivePath, options), 'Cleanup archive verification');
    const path = m.worktreePath, git = gitRunner(options);
    sourcePath = path;
    requireEvidence(baseline && normalizePath(baseline.primaryPath) === normalizePath(m.repositoryPath) && Array.isArray(baseline.worktrees), 'Missing classification snapshot');
    const original = baseline.worktrees.find(tree => normalizePath(tree.path) === normalizePath(path));
    requireEvidence(original?.registration?.state === 'ok' && original.registration.value.head === m.HEAD &&
      original.activity?.live?.state === 'negative' && original.activity?.head?.state === 'ok' && original.activity.head.value === m.HEAD, 'Classification is not archive-safe');
    const facts = await scan();
    const idle = value(idleEvidence(path, options), 'Idle evidence');
    requireEvidence(m.entries.every(entry => entry.working.kind === 'deleted' || entry.working.mtimeMs <= (options.now ?? Date.now)() - 14 * DAY), 'Manifest contains recent files');
    async function scan() {
      const current = value(candidateInventory(path, baseline, options), 'Fresh inventory');
      const activities = await collectActivity(current.worktrees.map(tree => ({ ...tree, activity: original.activity })),
        { ...options.activityOptions, softDeadline: options.softDeadline, deadlineNow: options.deadlineNow ?? options.now });
      return { ...current, worktrees: current.worktrees.map((tree, i) => ({ ...tree, activity: activities[i] })) };
    }
    function safety(facts, compareStatus = true) {
      requireEvidence(equal(facts.commonDirectory, baseline.commonDirectory), 'Common directory changed');
      const tree = facts.worktrees.find(item => normalizePath(item.path) === normalizePath(path));
      if (original.links?.state === 'ok' && original.links.value.nodeModulesTarget && tree?.links?.state === 'ok' &&
          tree.links.value.nodeModulesTarget === original.links.value.nodeModulesTarget &&
          !equal(tree.links.value.nodeModulesTargetEvidence, original.links.value.nodeModulesTargetEvidence)) {
        throw Object.assign(new Error('Junction target changed'), { stopReason: 'shared-target-changed' });
      }
      requireEvidence(tree && ['registration', 'identity', 'links', 'containment', 'inboundLinks', 'exemption'].every(name => equal(tree[name], original[name])), 'Identity, registration, links or nesting changed');
      requireEvidence(tree.exemption.state === 'negative' && tree.inboundLinks.state === 'negative' && tree.links.state === 'ok' && !tree.links.value.forbidden.length &&
        tree.containment.state === 'ok' && !tree.containment.value.children.length && !tree.containment.value.unregisteredRepositories.length, 'Exempt, linked or nested tree');
      requireEvidence(tree.activity.live.state === 'negative' && tree.activity.head.state === 'ok' && tree.activity.head.value === m.HEAD, 'Live or unknown activity');
      if (compareStatus) requireEvidence(equal(tree.status, original.status) && equal(tree.ignored, original.ignored), 'Status changed since classification');
      return tree;
    }
    const deleted = new Set();
    function unchanged() {
      const current = gitState(path, git);
      requireEvidence(current.head === m.HEAD && current.branch === m.branch && current.indexHash === m.indexHash, 'HEAD or index changed since archive');
      for (const entry of m.entries) {
        const full = join(path, entry.path);
        if (deleted.has(entry.path)) requireEvidence(absent(full), 'Removed file reappeared');
        else if (entry.working.kind === 'deleted') requireEvidence(absent(full) || (m.directories.includes(entry.path) && lstatSync(full).isDirectory()), 'Deleted file reappeared');
        else {
          const current = readRegular(full);
          requireEvidence(current.sha256 === entry.working.sha256 && (current.stat.mode & 0o777) === entry.working.mode, 'File changed since archive verification');
        }
      }
    }
    safety(facts);
    const classified = value(await planWorktrees(facts, { prSnapshot: options.prSnapshot, ghPath: options.ghPath, gitPath: options.gitPath,
      idleJournalOptions: options }), 'Archive reclassification');
    requireEvidence(classified.worktrees.find(tree => normalizePath(tree.path) === normalizePath(path))?.disposition === 'archive', 'Reclassification does not authorize archive cleanup');
    unchanged();
    await options.onBeforeMutation?.({ kind: 'cleanup', path });
    safety(await scan()); unchanged();
    // KTD14.1: only enumerated, verified working payloads are deleted. A HEAD
    // state has no leftover bytes to remove; its copy is the kept commit/bundle.
    for (const entry of m.entries.filter(entry => entry.working.kind === 'file')) {
      const full = join(path, entry.path);
      await options.onBeforeMutation?.({ kind: 'unlink', path: full });
      safety(await scan(), false); unchanged();
      requireEvidence(scalar(git(path, ['rev-parse', 'HEAD'])) === m.HEAD && readRegular(scalar(git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))).sha256 === m.indexHash, 'HEAD or index changed before deletion');
      requireEvidence(readRegular(full).sha256 === entry.working.sha256, 'File changed before deletion');
      remainingTime(options);
      unlinkSync(full); deleted.add(entry.path); changed = true;
      mutations.push({ kind: 'archive-unlink', path, file: entry.path });
    }
    // KTD14.2: NUL pathspec stdin handles large deletion sets and Unicode without
    // command-line limits. Include index-only additions so they leave the index.
    const tracked = [...new Set([...m.headEntries.map(entry => entry.path), ...m.entries.filter(entry => entry.index.kind === 'blob').map(entry => entry.path)])];
    await options.onBeforeMutation?.({ kind: 'restore', path });
    // Recheck activity and every remaining/reappeared path after asynchronous
    // boundaries. Git restore must never overwrite a concurrent writer's bytes.
    safety(await scan(), false); unchanged();
    requireEvidence(scalar(git(path, ['rev-parse', 'HEAD'])) === m.HEAD && readRegular(scalar(git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']))).sha256 === m.indexHash, 'HEAD or index changed before restore');
    if (tracked.length) {
      remainingTime(options);
      const indexPath = scalar(git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']));
      const state = () => [indexPath, ...tracked.map(file => join(path, file))].map(file => {
        const stat = lstatSync(file, { throwIfNoEntry: false });
        return stat ? fingerprint(stat) : null;
      });
      const beforeRestore = state(); let restored = false;
      try {
        git(path, ['restore', '--source=HEAD', '--staged', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], Buffer.from(tracked.join('\0') + '\0'));
        restored = true;
      } finally {
        try { restored ||= !equal(beforeRestore, state()); } catch { restored = true; }
        if (restored) { mutations.push({ kind: 'archive-restore', path, files: tracked }); changed = true; }
      }
    }
    // Preserve the observation time of known bytes we just reconstructed. For
    // recorded deletions the generated HEAD file has no original mtime: use the
    // verified idle interval's start. Otherwise U5 would mistake our own restore
    // for a new user edit. Never backdate an unenumerated path.
    const workingStates = new Map(m.entries.map(entry => [entry.path, entry.working]));
    for (const entry of m.headEntries) {
      const full = join(path, entry.path), current = readRegular(full), prior = workingStates.get(entry.path);
      const time = prior.kind === 'deleted' ? idle.since : prior.mtimeMs;
      requireEvidence(equal(fingerprint(current.stat), fingerprint(lstatSync(full))), 'Restored file changed before timestamp preservation');
      utimesSync(full, new Date(time), new Date(time));
      mutations.push({ kind: 'archive-timestamp', path, file: entry.path });
    }
    // KTD14.3: non-recursive only. ENOTEMPTY is intentionally left for the final
    // full walk; it can be a tracked parent or a newly created ignored file.
    for (const dir of [...m.directories].sort((a, b) => b.split('/').length - a.split('/').length)) {
      const full = join(path, dir); if (absent(full)) continue;
      requireEvidence(!lstatSync(full).isSymbolicLink(), 'Directory became a link');
      if (!lstatSync(full).isDirectory()) continue; // HEAD file replaced a directory.
      ancestors(full);
      try { rmdirSync(full); mutations.push({ kind: 'archive-rmdir', path, file: dir }); } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
    }
    // KTD14.4: git status alone misses additions inside ignored directories.
    const headPaths = new Set(m.headEntries.map(entry => entry.path));
    const fresh = filesystem(path, headPaths, original.links.value, options.walkTimeout);
    const legitimateDirectories = new Set();
    for (const file of headPaths) { let dir = dirname(file).replaceAll('\\', '/'); while (dir !== '.') { legitimateDirectories.add(dir); dir = dirname(dir).replaceAll('\\', '/'); } }
    if (fresh.files.some(file => !headPaths.has(file.path)) || fresh.directories.some(dir => !legitimateDirectories.has(dir))) return outcome({ disposition: 'pending', reason: 'Unexpected entry after archive cleanup', archivePath });
    const cleaned = await scan(), tree = safety(cleaned, false);
    requireEvidence(tree.status.state === 'ok' && tree.status.value.clean && tree.ignored.state === 'ok' && !tree.ignored.value.unexpected.length, 'Tree is not clean after archive');
    const state = gitState(path, git); requireEvidence(equal(state.headEntries, state.indexEntries), 'Index not restored to HEAD');
    // The verified archive (including a bundle for an unreferenced HEAD) is the
    // preservation proof for this handoff. U5 rechecks this clean snapshot again.
    return outcome({ disposition: 'clean', archivePath, snapshot: { ...cleaned, registrationMembership: baseline.registrationMembership, knownStaleRegistrations: baseline.knownStaleRegistrations ?? [], worktrees: baseline.worktrees.map(entry => normalizePath(entry.path) === normalizePath(path) ? { ...tree, targetBaseline: original.targetBaseline } : entry) },
      plan: { primaryPath: baseline.primaryPath, worktrees: [{ path, head: m.HEAD, branch: m.branch, disposition: 'remove' }] } });
  } catch (error) {
    if (error.removalResult && !mutations.length) return outcome({ ...error.removalResult, archivePath });
    let stopReason = error.stopReason ?? ((options.deadlineNow ?? options.now ?? Date.now)() >= (options.softDeadline ?? Infinity) ? 'deadline' : null);
    if (!stopReason && sourcePath && baseline?.worktrees?.find(tree => normalizePath(tree.path) === normalizePath(sourcePath))?.identity?.state === 'ok' &&
        (absent(sourcePath) || absent(join(sourcePath, '.git')))) stopReason = 'half-removed';
    return outcome({ disposition: changed ? 'pending' : 'hold', archivePath, reason: error.removalResult?.reason ?? String(error),
      ...(error.removalResult ? { reasonCode: error.removalResult.reasonCode } : {}), stopReason });
  }
}

/** @param {{archiveRoot?: string, now?: () => number, currentRunId: string,
 * currentArchives?: string[], maxTotalBytes?: number, gitPath?: string, softDeadline?: number, deadlineNow?: () => number}} options */
export function pruneArchives(options) {
  const pruned = [], warnings = [];
  try {
    requireEvidence(typeof options?.currentRunId === 'string' && options.currentRunId.length > 0, 'Current run identity required');
    const root = resolve(options.archiveRoot ?? defaultArchiveRoot()), now = (options.now ?? Date.now)(), limit = options.maxTotalBytes ?? 10 * 1024 ** 3;
    requireEvidence(Number.isFinite(now) && Number.isSafeInteger(limit) && limit >= 0, 'Invalid prune clock or limit');
    if (absent(root)) return ok({ pruned, warnings, totalBytes: 0 });
    ancestors(root);
    const git = gitRunner(options);
    const sourceProtected = manifest => !absent(manifest.worktreePath) ||
      parseWorktrees(git(manifest.repositoryPath, ['worktree', 'list', '--porcelain', '-z']).toString('utf8'))
        .some(entry => normalizePath(entry.path) === normalizePath(manifest.worktreePath));
    const names = readdirSync(root);
    if (names.includes('.staging')) {
      const stagingRoot = join(root, '.staging'); ancestors(stagingRoot);
      for (const name of readdirSync(stagingRoot)) {
        remainingTime();
        const path = join(stagingRoot, name);
        if (!removeStagingDirectory(path, root, now - 3_600_000)) warnings.push(`${path}: recent staging retained (newest mtime is not more than one hour old)`);
      }
    }
    const archives = names.filter(name => name !== '.staging').map(name => {
      const path = join(root, name), manifest = readManifest(path); let size = 0;
      requireEvidence(manifest.createdAt <= now, 'Future archive date');
      value(walkDirectory(path, { visit: ({ stat }) => { requireEvidence(!stat.isSymbolicLink(), 'Linked archive'); if (stat.isFile()) size += stat.size; } }), 'Prune inventory');
      const protectedArchive = manifest.runId === options.currentRunId || options.currentArchives?.some(entry => normalizePath(entry) === normalizePath(path)) || sourceProtected(manifest);
      return { path, manifest, createdAt: manifest.createdAt, size, protectedArchive };
    }).sort((a, b) => a.createdAt - b.createdAt || a.path.localeCompare(b.path));
    let totalBytes = archives.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of archives) if (now - entry.createdAt >= 179 * DAY && now - entry.createdAt < 180 * DAY) warnings.push(entry.path);
    // Age pruning is completed first; size pruning then consumes oldest-first.
    const expired = archives.filter(entry => !entry.protectedArchive && now - entry.createdAt >= 180 * DAY);
    for (const entry of [...expired, ...archives.filter(entry => !entry.protectedArchive && !expired.includes(entry))]) {
      if (!expired.includes(entry) && totalBytes <= limit) continue;
      if (sourceProtected(entry.manifest)) continue;
      removeArchiveDirectory(entry.path, root); pruned.push(entry.path); totalBytes -= entry.size;
    }
    return ok({ pruned, warnings, totalBytes });
  } catch (error) { return { ...unknown(`Archive pruning held: ${String(error)}`), pruned, warnings }; }
}
