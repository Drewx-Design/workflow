import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { negative, ok, probe, unknown, windowsPowerShellPath } from './probe.mjs';
import { REMOVABLE_DISPOSITIONS } from './policy.mjs';
import { normalizePath } from './inventory.mjs';
import { assertUnlinkedAncestors } from './safe-path.mjs';
import { DECIDING_TRANSCRIPT_RULE, TRANSCRIPT_BOOKKEEPING_VERSION, TRANSCRIPT_REACH_VERSION, doubtClasses, wouldRelease } from './activity.mjs';

/** @typedef {{path: string, action: string, disposition: string, initialDisposition?: string, finalDisposition?: string,
 * reasonCode?: string, wouldBeRemovable?: boolean, reason?: string, branch?: string|null, prUrl?: string, archivePath?: string,
 * restoreCommand?: string, snapshotRef?: string, snapshotCommit?: string, snapshotBound?: boolean, journalPath?: string, snapshotState?: string,
 * mutations?: import('./remove.mjs').Mutation[]|'not-evaluated', stopReason?: string|null, firstHeldAt?: number,
 * snapshotVeto?: string, snapshotPaths?: string[], snapshot?: {gate: string, paths: string[], fileCount?: number,
 * totalBytes?: number, largest?: {path: string, size: number}|null, files?: {path: string, size: number, digest?: string}[]},
 * unknownPruneEntries?: string[], recheckDurations?: {step: string, calls: number, ms: number}[]}} WorktreeReport
 * @typedef {{count?: number, totalBytes?: number, oldestAgeMs?: number, warnings?: string[], error?: string}} ArchiveReport
 * @typedef {{runId: string, startedAt: number, finishedAt: number, status: string, stage: string, worktrees: WorktreeReport[],
 * version?: number, dryRun?: boolean, prUrl?: string|null, rescued?: number, error?: string, stopReason?: string|null,
 * outcome?: string, counts?: Record<string, number>, reasonCounts?: Record<string, number>, snapshotVetoCounts?: Record<string, number>, operatorRelease?: string[],
 * refusedAtRemoval?: number|'not-evaluated', mutationCount?: number|'not-evaluated', wouldBeRemovable?: number,
 * held?: {count: number, oldestAgeMs: number}, archives?: ArchiveReport, reportPath?: string,
 * phaseDurations?: {phase: string, ms: number}[],
 * staleRegistrationSkips?: {path: string, adminPath: string, key: string}[], pruneDeferred?: boolean, unknownPruneEntries?: string[],
 * finalPrunePreview?: import('./probe.mjs').ProbeResult<string>, archivePrune?: {pruned: string[], warnings: string[], totalBytes: number}}} RunReport
 * @typedef {RunReport & {outcome: string, counts: Record<string, number>, reasonCounts: Record<string, number>,
 * refusedAtRemoval: number|'not-evaluated', mutationCount: number|'not-evaluated', wouldBeRemovable: number,
 * held: {count: number, oldestAgeMs: number}, archives: ArchiveReport, reportPath: string}} RenderedRunReport
 * @typedef {{path: string, activity: Awaited<ReturnType<typeof import('./activity.mjs').collectActivity>>[number]}} ReportActivity
 */

const DAY = 86_400_000;
const IDENTITY_PROBE_TIMEOUT_MS = 10_000;
export function defaultReportRoot() {
  if (!isAbsolute(process.env.LOCALAPPDATA ?? '')) throw new Error('LOCALAPPDATA unavailable; supply --report-root');
  return join(process.env.LOCALAPPDATA, 'WorkflowTools', 'worktree-cleanup');
}

// Same fixed endpoint protocol as the installed launcher. Never choose a spare
// port: an occupied endpoint denies admission, including after a process crash.
export function lockPort(repositoryPath, launcher = false) {
  const identity = repositoryIdentity(repositoryPath) + (launcher ? '|launcher' : '');
  return 20000 + createHash('sha256').update(identity).digest().readUInt32BE(0) % 20000;
}
function repositoryIdentity(repositoryPath) {
  return realpathSync(repositoryPath).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
}
export function coordinationDirectory(repositoryPath) {
  return join(defaultReportRoot(), 'coordination', createHash('sha256').update(repositoryIdentity(repositoryPath)).digest('hex'));
}

function identityProbeBounds(options) {
  const remaining = options.softDeadline === undefined ? Infinity : options.softDeadline - (options.deadlineNow ?? Date.now)();
  return { ...options, timeout: Math.min(IDENTITY_PROBE_TIMEOUT_MS, remaining) };
}

// ESRCH proves absence; permissions, timeouts and parse failures prove nothing.
let ownCreationTime;
export function processIdentity(pid, options = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return unknown('Invalid process id');
  if (pid === process.pid && ownCreationTime) return ok(ownCreationTime);
  try { process.kill(pid, 0); }
  catch (error) { return error.code === 'ESRCH' ? negative() : unknown(String(error)); }
  const result = process.platform === 'win32'
    ? probe(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`],
    { ...options, parse: text => { const value = text.trim(); if (!/^\d+$/.test(value)) throw new Error('Invalid creation time'); return value; } })
    : probe('/bin/ps', ['-p', String(pid), '-o', 'lstart='],
      { ...options, parse: text => { const value = text.trim(); if (!value) throw new Error('Missing creation time'); return value; } });
  if (pid === process.pid && result.state === 'ok') ownCreationTime = result.value;
  return result;
}
function coordinationError(error) {
  return Object.assign(new Error(`coordination-unavailable: ${error.message ?? error}`), { reasonCode: 'coordination-unavailable' });
}
function removeFile(path) {
  try { unlinkSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
function publish(path, record) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(record) + '\n', { flag: 'wx' }); renameSync(temporary, path); }
  finally { removeFile(temporary); }
}
function identityStale(record, identity) {
  return identity.state === 'negative' || (identity.state === 'ok' && record.creationTime != null && identity.value !== record.creationTime);
}
function writeHolder(directory, port, kind, creationTime, now) {
  publish(join(directory, 'owner.json'), { pid: process.pid, creationTime, port, kind, acquiredAt: now(), nonce: randomUUID() });
}

// The port alone authorizes mutation. Admission calls this only when first in
// the queue; direct callers remain useful for lock fixtures and diagnostics.
export async function acquireRunLock(repositoryPath, root, kind = 'nightly', options = {}) {
  if (!['nightly', 'owner-release'].includes(kind)) throw new Error('Invalid cleanup lock kind');
  const directory = coordinationDirectory(repositoryPath), identity = options.identityProbe ?? processIdentity;
  const port = lockPort(repositoryPath), server = createServer(socket => socket.destroy());
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => { server.removeListener('error', reject); accept(); });
  }).catch(async error => {
    let holderKind = 'unknown';
    let holder;
    try {
      const owner = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'));
      if (['owner-release', 'nightly'].includes(owner?.kind) && Number.isSafeInteger(owner.pid) && owner.pid > 0 &&
          typeof owner.creationTime === 'string' && owner.creationTime && !identityStale(owner, await identity(owner.pid, identityProbeBounds(options)))) {
        holderKind = owner.kind;
        holder = owner;
      }
    } catch { /* Missing/legacy metadata must not grant admission. */ }
    const detail = holder ? `; holder: ${JSON.stringify(holder)}` : '';
    throw Object.assign(new Error(`Single-instance lock occupied; no run started${detail}`), {
      code: error.code === 'EADDRINUSE' ? 'RUN_LOCK_OCCUPIED' : error.code, holderKind,
    });
  });
  try {
    mkdirSync(directory, { recursive: true });
    let creationTime = options.creationTime;
    if (creationTime == null) {
      const result = await identity(process.pid, identityProbeBounds(options));
      if (result.state !== 'ok') throw new Error(`Process creation time unavailable: ${result.reason ?? result.state}`);
      creationTime = result.value;
    }
    if (!creationTime) throw new Error('Process creation time unavailable');
    if (!options.deferHolder) writeHolder(directory, port, kind, creationTime, options.now ?? Date.now);
  } catch (error) { await new Promise(accept => server.close(accept)); throw coordinationError(error); }
  return () => new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
}

let ticketSequence = 0;
const compareTickets = (a, b) => a.enqueuedAtMs - b.enqueuedAtMs || (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0);
/**
 * @param {string} repositoryPath
 * @param {string} root
 * @param {string} kind 'nightly' or 'owner-release'; anything else throws.
 * @param {{now?: () => number, wait?: (ms: number) => Promise<unknown>, waitBudgetMs?: number,
 *   identityProbe?: (pid: number, options?: object) => any, takeLock?: (...args: any[]) => Promise<any>, target?: string}} [options]
 */
export async function admitRunLock(repositoryPath, root, kind, {
  now = Date.now, wait = ms => new Promise(accept => setTimeout(accept, ms)), waitBudgetMs,
  identityProbe = processIdentity, takeLock = acquireRunLock, target = repositoryPath,
} = {}) {
  if (!['nightly', 'owner-release'].includes(kind)) throw new Error('Invalid cleanup lock kind');
  const maximum = (kind === 'owner-release' ? 10 : 15) * 60_000;
  waitBudgetMs ??= maximum;
  if (!Number.isSafeInteger(waitBudgetMs) || waitBudgetMs < 0) throw new Error('Invalid cleanup lock wait budget');
  const enqueuedAtMs = now(), deadline = enqueuedAtMs + Math.min(waitBudgetMs, maximum);
  const bounds = { softDeadline: deadline, deadlineNow: now, timeout: 1000 };
  const tieBreaker = ++ticketSequence;
  const ticketId = `${String(tieBreaker).padStart(16, '0')}-${randomUUID()}`;
  const identities = new Map();
  const identityKey = entry => JSON.stringify([entry.pid, entry.creationTime]);
  const ticketIdentity = async entry => {
    const key = identityKey(entry);
    const cached = identities.get(key);
    if (cached?.state === 'ok') {
      try { process.kill(entry.pid, 0); }
      catch (error) { return error.code === 'ESRCH' ? negative() : unknown(String(error)); }
      return cached;
    }
    const identity = await identityProbe(entry.pid, identityProbeBounds(bounds));
    if (identity.state === 'ok') identities.set(key, identity);
    return identity;
  };
  let ticketPath, unlock;
  let occupied = Object.assign(new Error('Single-instance lock occupied; admission wait expired'), { code: 'RUN_LOCK_OCCUPIED', holderKind: 'owner-release' });
  try {
    let directory, ticket;
    try {
      directory = coordinationDirectory(repositoryPath);
      mkdirSync(directory, { recursive: true });
      const identity = await identityProbe(process.pid, identityProbeBounds(bounds));
      if (identity.state !== 'ok') throw new Error(`Process creation time unavailable: ${identity.reason ?? identity.state}`);
      ticket = { ticketId, pid: process.pid, creationTime: identity.value, enqueuedAtMs, tieBreaker, kind, target };
      identities.set(identityKey(ticket), identity);
      ticketPath = join(directory, `${ticketId}.ticket.json`);
      publish(ticketPath, ticket);
    } catch (error) { throw coordinationError(error); }
    const oldest = async () => {
      const live = [];
      let names;
      try { names = readdirSync(directory); } catch (error) { throw coordinationError(error); }
      for (const name of names) {
        if (!name.endsWith('.ticket.json')) continue;
        const path = join(directory, name);
        let entry;
        try { entry = JSON.parse(readFileSync(path, 'utf8')); }
        catch (error) {
          if (error.code === 'ENOENT') continue;
          if (!(error instanceof SyntaxError)) throw coordinationError(error);
        }
        if (!entry || !Number.isFinite(entry.enqueuedAtMs) || typeof entry.ticketId !== 'string' || !entry.ticketId ||
            !Number.isSafeInteger(entry.pid) || entry.pid <= 0 || !['owner-release', 'nightly'].includes(entry.kind)) {
          try { renameSync(path, `${path}.invalid`); }
          catch (error) { if (error.code !== 'ENOENT') throw coordinationError(error); }
          continue;
        }
        // Do not start another query once our wait deadline has elapsed.
        if (now() >= deadline) throw occupied;
        // Even a suspended live waiter must eventually surrender its slot.
        if (now() - entry.enqueuedAtMs > (entry.kind === 'owner-release' ? 20 : 30) * 60_000) {
          removeFile(path); continue;
        }
        const identity = await ticketIdentity(entry);
        if (identityStale(entry, identity) ||
            ((identity.state === 'unknown' || entry.creationTime == null) && now() - entry.enqueuedAtMs > 16 * 60_000)) removeFile(path);
        else live.push(entry);
      }
      return live.sort(compareTickets)[0];
    };
    while (now() < deadline) {
      const first = await oldest();
      if (first?.ticketId === ticketId) {
        try {
          unlock = await takeLock(repositoryPath, root, kind, { ...bounds, now, identityProbe, creationTime: ticket.creationTime, deferHolder: true });
        } catch (error) {
          if (error.code !== 'RUN_LOCK_OCCUPIED') throw error;
          occupied = error;
          if (error.holderKind === 'nightly' && kind === 'owner-release') throw error;
        }
        if (unlock) {
          // A publisher may have been suspended between timestamp and rename.
          const confirmed = await oldest();
          if (confirmed?.ticketId === ticketId && now() < deadline) {
            try { writeHolder(directory, lockPort(repositoryPath), kind, ticket.creationTime, now); }
            catch (error) { throw coordinationError(error); }
            removeFile(ticketPath); ticketPath = undefined;
            const admitted = unlock; unlock = undefined; return admitted;
          }
          await unlock(); unlock = undefined;
        }
      }
      const remaining = deadline - now();
      if (remaining > 0) await wait(Math.min(1000, remaining));
    }
    throw occupied;
  } finally {
    try { if (unlock) await unlock(); }
    finally { if (ticketPath) removeFile(ticketPath); }
  }
}

export function archiveSummary(root, now = Date.now()) {
  const path = join(root, 'archives');
  if (!existsSync(path)) return { count: 0, totalBytes: 0, oldestAgeMs: 0, warnings: [] };
  let count = 0, totalBytes = 0, oldestAgeMs = 0;
  const warnings = [];
  function size(dir) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw new Error('Linked archive in report inventory');
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) throw new Error('Unsupported archive entry');
    return readdirSync(dir).reduce((sum, name) => sum + size(join(dir, name)), 0);
  }
  if (lstatSync(path).isSymbolicLink()) throw new Error('Linked archive root');
  for (const name of readdirSync(path)) {
    if (name === '.staging') continue;
    const directory = join(path, name), bytes = size(directory);
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    if (!Number.isFinite(manifest.createdAt) || manifest.createdAt > now) throw new Error('Invalid archive date');
    const age = now - manifest.createdAt;
    count++; totalBytes += bytes; oldestAgeMs = Math.max(oldestAgeMs, age);
    if (age >= 179 * DAY) warnings.push(`${directory}: ${age >= 180 * DAY ? 'eligible for expiry' : 'expires within 24 hours'}`);
  }
  return { count, totalBytes, oldestAgeMs, warnings };
}

const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const age = milliseconds => `${(milliseconds / DAY).toFixed(1)} days`;
function commissionPreviewLines(preview) {
  if (!preview) return [];
  return ['## Commissioning preview', '', `Plan hash: ${cell(preview.planHash)}`, '',
    '| Worktree | HEAD | Ref stem | Copy-set files (kind, digest) |', '| --- | --- | --- | --- |',
    ...preview.candidates.map(candidate => `| ${[candidate.path, candidate.head, candidate['ref-stem'],
      candidate.files.map(file => `${file.path} (${file.kind}, ${file.digest})`).join('; ')].map(cell).join(' | ')} |`),
    ...(preview.candidates.length ? [] : ['No supervised candidates.']), ''];
}
/** Preview reports are read-only observations: they never append a run journal. */
export function writeCommissionPreviewReport(root, preview) {
  assertUnlinkedAncestors(join(root, 'reports'), { missing: 'allow' });
  mkdirSync(join(root, 'reports'), { recursive: true });
  assertUnlinkedAncestors(join(root, 'reports'));
  const path = join(root, 'reports', `commission-preview-${preview.planHash}.md`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const excluded = preview.excluded?.length ? ['## Excluded worktrees', '',
      ...preview.excluded.map(tree => `- ${JSON.stringify(tree.path)}: ${tree.reason}`), ''] : [];
    writeFileSync(temporary, ['# Worktree cleanup', '', ...commissionPreviewLines(preview), ...excluded].join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  return path;
}
const snapshotGates = ['secret_material', 'secret-scan-unsupported', 'snapshot-file-cap', 'snapshot-size-cap',
  'snapshot-unsupported-entry', 'snapshot-unmerged', 'unknown'];
/** @param {RunReport} report */
function snapshotLines(report) {
  const candidates = report.worktrees.filter(tree => tree.snapshot || tree.snapshotVeto);
  const counts = Object.fromEntries(snapshotGates.map(gate => [gate, candidates.filter(tree => tree.snapshotVeto === gate).length]));
  if (candidates.length) report.snapshotVetoCounts = counts;
  return [
    `Snapshot vetoes: ${snapshotGates.map(gate => `${gate}: ${counts[gate]}`).join('; ')}.`, '',
    '## Snapshot candidates', '',
    ...(candidates.length ? [
      '| Worktree | Files | Total bytes | Largest file | Gate | Offending paths |',
      '| --- | --- | --- | --- | --- | --- |',
      ...candidates.map(tree => {
        const snapshot = tree.snapshot, largest = snapshot?.largest;
        return `| ${[tree.path, snapshot?.fileCount ?? 'not-evaluated', snapshot?.totalBytes ?? 'not-evaluated',
          largest ? `${largest.path} (${largest.size} bytes)` : snapshot?.fileCount === 0 ? 'none' : 'not-evaluated',
          tree.snapshotVeto ?? snapshot?.gate, (tree.snapshotPaths ?? snapshot?.paths ?? []).join(', ')].map(cell).join(' | ')} |`;
      }),
      ...candidates.flatMap(tree => (tree.snapshot?.files ?? []).map(file =>
        `Snapshot file: ${cell(tree.path)} / ${cell(file.path)}; ${file.size} bytes; digest: ${cell(file.digest ?? 'not-evaluated')}.`)),
    ] : ['None.']), '',
    ...report.worktrees.filter(tree => tree.snapshotRef).map(tree =>
      `Snapshot recovery: ${cell(tree.path)}; ref: ${cell(tree.snapshotRef)}; commit: ${cell(tree.snapshotCommit)}; ${cell(tree.restoreCommand)}.`),
  ];
}
function readRunJournal(journal) {
  if (!existsSync(journal)) return [];
  const text = readFileSync(journal, 'utf8'), lines = text.split('\n'), rows = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
    } catch { /* A torn append anywhere does not erase subsequent valid rows. */ }
  }
  // Repair only by appending. Another writer may have appended since our read;
  // an extra blank line is harmless, whereas truncating would destroy its row.
  if (text && !text.endsWith('\n')) appendFileSync(journal, '\n', 'utf8');
  return rows;
}

/** @param {RunReport} report */
function summarizeReport(report) {
  report.counts = {};
  report.reasonCounts = {};
  const held = report.worktrees.filter(tree => ['hold', 'pending'].includes(tree.disposition));
  for (const tree of report.worktrees) {
    tree.initialDisposition ??= tree.action;
    tree.finalDisposition = report.dryRun ? 'not-evaluated' : tree.disposition;
    tree.reasonCode ??= tree.disposition === 'hold' ? tree.reason ?? 'unknown' : tree.disposition;
    if (report.operatorRelease?.includes(normalizePath(tree.path)) && !tree.reason?.split('; ').includes('operator-release')) {
      tree.reason = [tree.reason, 'operator-release'].filter(Boolean).join('; ');
    }
    tree.mutations = report.dryRun ? 'not-evaluated' : tree.mutations ?? [];
    report.counts[tree.action] = (report.counts[tree.action] ?? 0) + 1;
  }
  for (const tree of held) report.reasonCounts[tree.reasonCode] = (report.reasonCounts[tree.reasonCode] ?? 0) + 1;
  report.refusedAtRemoval = report.dryRun ? 'not-evaluated' : report.worktrees.filter(tree =>
    [...REMOVABLE_DISPOSITIONS, 'archive'].includes(tree.initialDisposition) && !['removed', 'removed-prune-deferred'].includes(tree.finalDisposition)).length;
  report.mutationCount = report.dryRun ? 'not-evaluated' : report.worktrees.reduce((sum, tree) =>
    sum + (Array.isArray(tree.mutations) ? tree.mutations.filter((mutation, index, mutations) => mutation.kind !== 'remove-started' ||
      !mutations.slice(index + 1).some(later => later.kind === 'deregister')).length : 0), 0);
  report.wouldBeRemovable = held.filter(tree => tree.wouldBeRemovable === true).length;
  report.outcome = report.status === 'failed' ? report.stopReason ?? 'failed' : held.length ? 'completed-with-holds' : 'completed';
}

/** @param {RunReport} report */
function operatorReleaseLines(report) {
  if (!report.operatorRelease?.length) return [];
  const named = report.worktrees.filter(tree => report.operatorRelease.includes(normalizePath(tree.path)));
  const removed = named.filter(tree => ['removed', 'removed-prune-deferred'].includes(tree.finalDisposition)).length;
  const held = named.filter(tree => ['hold', 'pending'].includes(tree.disposition)).length;
  return [`Operator release of unresolved-command doubt: ${report.operatorRelease.length} named; ${removed} removed; ${held} held.`];
}

/** @param {RunReport} report @param {ReportActivity[]} activityRows */
function reachObservationLines(report, activityRows) {
  const byPath = new Map(activityRows.map(row => [resolve(row.path).toLowerCase(), row.activity]));
  const released = report.worktrees.filter(tree => ['hold', 'pending'].includes(tree.disposition))
    .map(tree => ({ tree, activity: byPath.get(resolve(tree.path).toLowerCase()) }))
    .filter(row => wouldRelease(row.activity?.transcript));
  const onlyDoubt = released.filter(({ tree, activity }) => tree.reasonCode === 'unresolved-command' && tree.wouldBeRemovable === true &&
    activity?.liveReasons?.length === 1 && activity.liveReasons[0].code === 'unresolved-command').length;
  const residual = activityRows.find(row => row.activity?.transcript?.residualDoubtCounts)?.activity.transcript.residualDoubtCounts;
  return {
    summary: [
      `Reach rule (observing; deciding rule: ${DECIDING_TRANSCRIPT_RULE}, reach version ${TRANSCRIPT_REACH_VERSION}): would release ${released.length}. Held only by unresolved-command doubt: ${onlyDoubt}.`,
      `Residual folder-wide doubt (records, reach rule): ${residual ? doubtClasses.map(name => `${name}: ${residual[name]}`).join('; ') : 'not-evaluated'}.`,
    ],
    details: ['## Reach rule would-release list', '', ...(released.length ? [
      '| Worktree | Held reason | Lease state | Newest file write in window | HEAD changed since previous run | Last resolvable record |',
      '| --- | --- | --- | --- | --- | --- |',
      ...released.map(({ tree, activity }) => {
        const file = activity?.fileActivity, newest = file?.state === 'ok' ? file.value.newestMtimeMs : undefined;
        const writeAge = typeof newest === 'number' && Number.isFinite(newest) ? `${age(Math.max(0, report.finishedAt - newest))} ago` :
          file?.state === 'negative' ? 'none' : file?.state === 'unknown' ? `unknown (${file.reason})` : 'not-evaluated';
        const reasons = [...new Set([tree.reasonCode, tree.reason, ...(activity?.liveReasons ?? []).map(signal => signal.code)].filter(Boolean))].join('; ');
        return `| ${[tree.path, reasons, activity?.lease?.state ?? 'not-evaluated', writeAge, 'not-evaluated', 'none within 72 h'].map(cell).join(' | ')} |`;
      }),
    ] : ['None.']), ''],
  };
}

// Independent of normal report rendering so a reporting error can still leave
// the same minimal durable failure record as the installed launcher.
/** @param {string} root @param {RunReport} report */
export function writeFailureReport(root, report) {
  mkdirSync(join(root, 'reports'), { recursive: true });
  const failure = { ...report, status: 'failed', stage: 'report',
    reportPath: join(root, 'reports', `${report.runId}-report-failure.md`) };
  summarizeReport(failure);
  report.outcome = failure.outcome;
  report.reportPath = failure.reportPath;
  const snapshots = snapshotLines(failure).join('\n');
  report.snapshotVetoCounts = failure.snapshotVetoCounts;
  writeFileSync(failure.reportPath, `# Worktree cleanup\n\nOutcome: ${cell(failure.outcome)}\nHeld: unknown; oldest held: unknown.\nArchives: unknown; total size: unknown; oldest: unknown.\nRescue PR: ${report.prUrl ?? 'none'}\n${operatorReleaseLines(failure).map(line => line + '\n').join('')}\n${snapshots}\nReporting failed after stage ${cell(report.stage)}: ${cell(report.error)}\n`, { encoding: 'utf8', flag: 'wx' });
  const journal = join(root, 'journal.jsonl');
  readRunJournal(journal);
  appendFileSync(journal, JSON.stringify(failure) + '\n', 'utf8');
}
/** @param {string} root @param {RunReport} report @param {ReportActivity[]} activityRows @returns {RenderedRunReport} */
export function writeRunReport(root, report, activityRows = []) {
  mkdirSync(join(root, 'reports'), { recursive: true });
  const journal = join(root, 'journal.jsonl');
  const previous = readRunJournal(journal).filter(row => !row.dryRun && row.worktrees?.length).at(-1)?.worktrees ?? [];
  const seen = new Set();
  for (const tree of report.worktrees) {
    const key = resolve(tree.path).toLowerCase();
    if (seen.has(key)) throw new Error('Duplicate report worktree');
    seen.add(key);
    if (tree.disposition === 'hold' || tree.disposition === 'pending') {
      tree.firstHeldAt = previous.find(old => resolve(old.path).toLowerCase() === key)?.firstHeldAt ?? report.startedAt;
    }
  }
  const held = report.worktrees.filter(tree => tree.firstHeldAt !== undefined);
  report.held = { count: held.length, oldestAgeMs: Math.max(0, ...held.map(tree => report.finishedAt - tree.firstHeldAt)) };
  try { report.archives = archiveSummary(root, report.finishedAt); }
  catch (error) { report.archives = { error: String(error) }; report.status = 'failed'; report.error ??= String(error); }
  summarizeReport(report);
  report.reportPath = join(root, 'reports', `${report.runId}.md`);
  // Observation is rendered separately; it never enters the durable journal row.
  const observation = reachObservationLines(report, activityRows);
  const lines = ['# Worktree cleanup', '',
    `Outcome: ${report.outcome.replaceAll('-', ' ')} (outcome: ${report.outcome}).`,
    `Held: ${report.held.count}; oldest held: ${age(report.held.oldestAgeMs)} (since first observed hold).`,
    `Held by reason code: ${Object.entries(report.reasonCounts).sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => `${cell(code)}: ${count}`).join('; ') || 'none'}.`,
    `Registration churn: registration-vanished holds: ${report.reasonCounts['registration-vanished'] ?? 0}; removed-prune-deferred: ${report.worktrees.filter(tree => tree.disposition === 'removed-prune-deferred').length}.`,
    `Prune deferred: ${report.pruneDeferred ? 'yes' : 'no'}.`,
    ...(report.unknownPruneEntries ?? []).map(entry => `Unknown prune entry: ${cell(entry)}`),
    `refused-at-removal: ${report.refusedAtRemoval}; liveness-only wouldBeRemovable: ${report.wouldBeRemovable}; mutations: ${report.mutationCount}.`,
    report.archives.error ? `Archives: unknown (${cell(report.archives.error)}).` : `Archives: ${report.archives.count}; total size: ${report.archives.totalBytes} bytes; oldest: ${age(report.archives.oldestAgeMs)}.`,
    `Transcript bookkeeping list version: ${TRANSCRIPT_BOOKKEEPING_VERSION}.`,
    ...observation.summary,
    ...operatorReleaseLines(report),
    `Rescue PR: ${report.prUrl ?? 'none'}`, '',
    `Run: ${report.runId}; ${report.dryRun ? 'dry run' : 'live'}; ${report.status}; stage: ${report.stage}; wall time: ${report.finishedAt - report.startedAt} ms.`,
    `Phase durations: ${report.phaseDurations?.length ? report.phaseDurations.map(({ phase, ms }) => `${phase} ${(ms / 1000).toFixed(1)} s`).join('; ') : 'none recorded.'}`,
    ...(report.dryRun ? ['Dry run uses the current origin/main; fetch and persistent idle observations are skipped. Actions below are proposals, subject to live re-verification.'] : []),
    ...(report.error ? [`Error: ${cell(report.error)}`] : []), '',
    '| Worktree | Would do | Outcome | Reason | Recovery | Reason code | Initial disposition | Final disposition | Mutations | wouldBeRemovable |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.worktrees.map(tree => `| ${[tree.path, tree.action, tree.disposition,
      tree.recheckDurations?.length ? [tree.reason, `recheck: ${tree.recheckDurations.map(({ step, calls, ms }) => `${step} ${calls}x${(ms / 1000).toFixed(1)} s`).join('; ')}`].filter(Boolean).join('; ') : tree.reason,
      tree.restoreCommand ?? tree.prUrl ?? tree.branch ?? '',
      tree.reasonCode, tree.initialDisposition, tree.finalDisposition, report.dryRun ? 'not-evaluated' : JSON.stringify(tree.mutations), tree.wouldBeRemovable ?? false].map(cell).join(' | ')} |`), '',
    ...snapshotLines(report),
    ...commissionPreviewLines(report.commissionPreview),
    ...observation.details,
    ...(report.archives.warnings ?? []).map(warning => `Archive warning: ${cell(warning)}`),
  ];
  writeFileSync(report.reportPath, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'wx' });
  appendFileSync(journal, JSON.stringify(report) + '\n', { encoding: 'utf8' });
  return report;
}

/** @param {RunReport} report */
export function notifyRun(report) {
  if (process.platform !== 'win32' || process.env.WORKTREE_CLEANUP_NO_TOAST === '1' || (report.status !== 'failed' && !report.rescued)) return;
  // Notification failure cannot change the cleanup verdict. No report/user text
  // is interpolated into PowerShell or XML.
  const code = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null
    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml('<toast><visual><binding template="ToastText02"><text id="1">Workflow tools worktree cleanup</text><text id="2">Cleanup rescued documents or encountered an error. Read the latest cleanup report.</text></binding></visual></toast>')
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Workflow tools worktree cleanup').Show([Windows.UI.Notifications.ToastNotification]::new($xml))`;
  spawnSync(windowsPowerShellPath(),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { windowsHide: true, timeout: 10_000, stdio: 'ignore' });
}
