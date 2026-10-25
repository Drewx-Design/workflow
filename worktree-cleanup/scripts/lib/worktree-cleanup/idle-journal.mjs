import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertUnlinkedAncestors } from './safe-path.mjs';
import { allowedDirectories as buildDirectories, allowedFiles as buildFiles, normalizePath, walkDirectory } from './inventory.mjs';
import { negative, ok, probe, requireEvidence, resolveExecutable, unknown } from './probe.mjs';

const DAY = 86_400_000, OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
/** @typedef {{journalPath?: string, now?: () => number, gitPath?: string, walkTimeout?: number}} IdleOptions */
function journalPath(options) {
  if (options.journalPath) return resolve(options.journalPath);
  requireEvidence(isAbsolute(process.env.LOCALAPPDATA ?? ''), 'LOCALAPPDATA unavailable');
  return join(process.env.LOCALAPPDATA, 'WorkflowTools', 'worktree-cleanup', 'idle-journal.jsonl');
}
function ancestors(path) {
  assertUnlinkedAncestors(path, { missing: 'allow', message: 'Linked journal directory' });
}
function readRows(path) {
  ancestors(dirname(path)); const before = lstatSync(path);
  requireEvidence(before.isFile() && !before.isSymbolicLink(), 'Journal is not a regular file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireEvidence(opened.ino === before.ino && opened.dev === before.dev, 'Journal identity changed');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd)), after = fstatSync(fd);
    requireEvidence(opened.size === after.size && opened.mtimeMs === after.mtimeMs && text.endsWith('\n'), 'Incomplete or changing journal');
    return text.slice(0, -1).split('\n').map(line => {
      const row = JSON.parse(line);
      requireEvidence(row.version === 1 && typeof row.path === 'string' && isAbsolute(row.path) && Number.isFinite(row.observedAt) &&
        ['clear', 'live', 'unknown'].includes(row.signal) && (row.head === null || OID.test(row.head)), 'Invalid observation');
      return row;
    });
  } finally { closeSync(fd); }
}
/** U6 calls once per observed tree per run. Unknown observations are recorded as
 * interruptions, never converted to absence. Multiple observations on one day
 * cannot erase an earlier live/unknown signal. No history is invented/backfilled.
 * @param {string} treePath @param {{head?: object, live?: object}} activity
 * @param {IdleOptions} options
 */
export function appendIdleObservation(treePath, activity, options = {}) {
  try {
    const path = journalPath(options), observedAt = (options.now ?? Date.now)();
    requireEvidence(isAbsolute(treePath) && Number.isFinite(observedAt), 'Invalid observation identity or clock');
    const head = activity?.head?.state === 'ok' && OID.test(activity.head.value ?? '') ? activity.head.value : null;
    const signal = head && activity?.live?.state === 'negative' ? 'clear' : activity?.live?.state === 'ok' ? 'live' : 'unknown';
    const row = { version: 1, path: resolve(treePath), observedAt, head, signal };
    ancestors(dirname(path)); mkdirSync(dirname(path), { recursive: true }); ancestors(dirname(path));
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing) { readRows(path); requireEvidence(existing.isFile() && !existing.isSymbolicLink(), 'Invalid journal'); }
    const fd = openSync(path, constants.O_APPEND | constants.O_WRONLY | (existing ? 0 : constants.O_CREAT | constants.O_EXCL) | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      const opened = fstatSync(fd);
      requireEvidence(opened.isFile() && (!existing || (existing.ino === opened.ino && existing.dev === opened.dev)), 'Journal changed before append');
      const bytes = Buffer.from(JSON.stringify(row) + '\n'); requireEvidence(writeSync(fd, bytes) === bytes.length, 'Incomplete observation append');
    } finally { closeSync(fd); }
    return ok(row);
  } catch { return unknown('Idle observation could not be appended'); }
}
/** Sixteen consecutive UTC days through today must be
 * observed. A missing daily run is unknown; a recent signal/HEAD change or short
 * history is negative. The full file walk also enforces the manifest mtime gate.
 * @param {string} treePath @param {IdleOptions} options
 */
export function idleEvidence(treePath, options = {}) {
  try {
    const now = (options.now ?? Date.now)(); requireEvidence(Number.isFinite(now), 'Invalid idle clock');
    const rows = readRows(journalPath(options)).filter(row => normalizePath(row.path) === normalizePath(treePath));
    requireEvidence(rows.length > 0, 'Missing tree history');
    const git = resolveExecutable(options.gitPath ?? 'git'); requireEvidence(git.state === 'ok', 'Git unavailable');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0' };
    const head = probe(git.value, ['--no-optional-locks', '-C', treePath, 'rev-parse', 'HEAD'], { env });
    requireEvidence(head.state === 'ok' && OID.test(head.value.trim()), 'HEAD unavailable');
    const currentHead = head.value.trim(), days = new Map();
    let previous = -Infinity;
    for (const row of rows) {
      requireEvidence(row.observedAt <= now && row.observedAt >= previous, 'Future or out-of-order observation'); previous = row.observedAt;
      const day = Math.floor(row.observedAt / DAY), prior = days.get(day);
      const clear = row.signal === 'clear' && row.head === currentHead;
      days.set(day, { clear: clear && (prior?.clear ?? true), first: Math.min(row.observedAt, prior?.first ?? Infinity), unknown: row.signal === 'unknown' || (prior?.unknown ?? false) });
    }
    // A late observation on day -14 can be only thirteen elapsed days old.
    // Starting at day -15 guarantees fourteen full days at any run time.
    const today = Math.floor(now / DAY), start = today - 15;
    if (Math.floor(rows[0].observedAt / DAY) > start) return negative();
    for (let day = start; day <= today; day++) {
      const observed = days.get(day); requireEvidence(observed, 'Missing daily observation');
      if (observed.unknown) return unknown('Unknown activity interrupted idle history');
      if (!observed.clear) return negative();
    }
    const tracked = new Set();
    for (const args of [['ls-files', '-z'], ['ls-tree', '--name-only', '-r', '-z', currentHead]]) {
      const listed = probe(git.value, ['--no-optional-locks', '-C', treePath, ...args], { env });
      requireEvidence(listed.state === 'ok' && (!listed.value || listed.value.endsWith('\0')), 'Tracked paths unavailable');
      if (listed.value) for (const path of listed.value.slice(0, -1).split('\0')) tracked.add(path);
    }
    let fresh = false;
    const walk = walkDirectory(resolve(treePath), { timeout: options.walkTimeout, visit: ({ path, directory, name, stat }) => {
      if (name.toLowerCase() === '.git') { requireEvidence(directory === resolve(treePath), 'Nested repository'); return false; }
      const rel = relative(treePath, path).split(sep).join('/');
      // U1 separately validates links, including the sole allowed junction.
      if (directory === resolve(treePath) && buildDirectories.has(name) && ![...tracked].some(path => path.startsWith(name + '/'))) return false;
      requireEvidence(!stat.isSymbolicLink(), 'Linked idle evidence');
      const allowlisted = buildFiles.has(rel) || buildDirectories.has(rel.split('/')[0]);
      if (stat.isFile() && (tracked.has(rel) || !allowlisted)) { requireEvidence(Number.isFinite(stat.mtimeMs), 'Invalid file mtime'); if (stat.mtimeMs > now - 14 * DAY) fresh = true; }
    } });
    requireEvidence(walk.state === 'ok', 'File mtime inventory unavailable');
    return fresh ? negative() : ok({ consecutiveDays: today - start + 1, since: days.get(start).first, head: currentHead });
  } catch { return unknown('Idle journal or file evidence unavailable'); }
}
