import { spawnSync } from 'node:child_process';
import { lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activity, leases } from './activity.mjs';
import { candidateInventory, checkPrunePreview, inventory, isAdmissibleTopLevelNodeModulesJunction, isBuildSelfLink, isDanglingTopLevelNodeModulesJunction, isWithin, normalizePath, parseStatus, readLink, regularBytes, targetSnapshot, topLevelModulesLink, walkDirectory } from './inventory.mjs';
import { boundedTimeout, equal, ok, probe, remainingTime, requireEvidence, resolveExecutable, unknown, windowsPowerShellPath } from './probe.mjs';
import { REMOVABLE_DISPOSITIONS, isOwnerTarget, ownerLivenessReason, refReachability, releasesOwnerLiveness, releasesUnresolvedDoubt } from './policy.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
// Budget for one `git worktree remove`, capped by the soft deadline, and the
// least time left in which one may start. See the call site for why.
const REMOVE_BUDGET_MS = 10 * 60_000;
export const REMOVE_MIN_MS = 3 * 60_000;
const WINDOW_MS = 72 * 60 * 60 * 1000;
const FULL_GATE_MAX_AGE_MS = 2 * 60_000;
const helper = fileURLToPath(new URL('../../remove-worktree-junction.ps1', import.meta.url));
const PRE_DELETION_REFUSALS = [
  'cannot remove a locked working tree', 'lock reason', 'is a main working tree', 'is not a working tree',
  'validation failed, cannot remove working tree', 'contains modified or untracked files, use --force to delete it',
  'working trees containing submodules cannot be moved or removed',
];
function normalFailedExit(result) {
  // probe() currently encodes signal/spawn failures in reason, not separate
  // fields. Only its exact normal-exit envelope is positive exit evidence;
  // also reject explicit interruption fields supplied by a probe implementation.
  return result?.state === 'unknown' && Number.isInteger(result.exitCode) && result.exitCode > 0 &&
    result.reason === `Probe failed (exit ${result.exitCode}, signal null)` &&
    !result.signal && !result.timedOut && !result.timeout && !result.killed && !result.error && !result.spawnError;
}
function preDeletionRefusal(stderr) {
  return typeof stderr === 'string' && PRE_DELETION_REFUSALS.some(message => stderr.toLowerCase().includes(message));
}
function value(result, name) {
  if (result?.stopReason) throw Object.assign(new Error(result.reason ?? name), { stopReason: result.stopReason });
  requireEvidence(result?.state === 'ok', `${name} unavailable`);
  return result.value;
}
function absent(path) { return lstatSync(path, { throwIfNoEntry: false }) === undefined; }

/** The coordinator and batch remover share the R2/R3 decision table. */
export function removalStopReason(result) {
  if (result.stopReason === 'mutation-guard') return 'mutation-guard';
  if (result.stopReason === 'shared-target-changed') return 'shared-target-changed';
  if (result.stopReason === 'half-removed') return 'half-removed';
  if (result.stopReason === 'prune-unknown') return 'prune-unknown';
  if (result.stopReason === 'deadline') return 'deadline';
  if (!['removed', 'removed-prune-deferred', 'clean'].includes(result.disposition) && result.mutations.length) return 'mutated-then-held';
  return null;
}

// The fast inventory deliberately skips real node_modules. Removal cannot:
// inspect every entry, including Windows reparse tags Node may not recognize.
function completeLinkScan(root, allowedJunction, selfLinks, run, timeout = 300_000, bounds = {}) {
  try {
    const dotGit = lstatSync(join(root, '.git'));
    requireEvidence(!dotGit.isSymbolicLink() && (dotGit.isFile() || dotGit.isDirectory()), 'Missing or linked .git');
    for (const link of selfLinks) {
      const fresh = readLink(root, link.path, 'symlink', run, boundedTimeout({ ...bounds, timeout }));
      requireEvidence(isBuildSelfLink(root, fresh) && equal({ ...fresh, selfLink: true }, link), 'Self-link changed during complete scan');
    }
  } catch (error) { return unknown(String(error)); }
  if (process.platform !== 'win32') return walkDirectory(root, {
    ...bounds, timeout, visit: ({ name, directory, stat }) => {
      requireEvidence(!stat.isSymbolicLink(), 'Forbidden link');
      if (directory === root && name.toLowerCase() === '.git') return false;
    },
  });
  const script = `
$ErrorActionPreference = 'Stop'
function ScanPath([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  if ($full.StartsWith('\\\\')) { return '\\\\?\\UNC\\' + $full.Substring(2) }
  return '\\\\?\\' + $full
}
$root = ScanPath $env:WORKTREE_CLEANUP_SCAN_ROOT
$selfLinks = ConvertFrom-Json -InputObject $env:WORKTREE_CLEANUP_ALLOW_SELF_LINKS
$pending = [Collections.Generic.Stack[string]]::new()
$pending.Push($root)
while ($pending.Count) {
  $directory = $pending.Pop()
  if ([IO.File]::GetAttributes($directory) -band [IO.FileAttributes]::ReparsePoint) { throw 'Directory became a reparse point' }
  foreach ($entry in [IO.DirectoryInfo]::new($directory).GetFileSystemInfos()) {
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      if ($directory -ieq $root -and $entry.Name -ceq 'node_modules' -and $env:WORKTREE_CLEANUP_ALLOW_JUNCTION -eq '1' -and
          (Get-Item -LiteralPath $entry.FullName -Force).LinkType -eq 'Junction') { continue }
      $allowed = @($selfLinks | Where-Object { (ScanPath $_.path) -ieq $entry.FullName })
      if ($allowed.Count -eq 1) {
        $identity = Get-Item -LiteralPath $entry.FullName -Force
        $targets = @($identity.Target)
        if ($identity.PSIsContainer -and $identity.LinkType -ceq $allowed[0].linkType -and
            $targets.Count -eq 1 -and $targets[0] -ceq $allowed[0].rawTarget) { continue }
      }
      throw 'Forbidden reparse point'
    }
    if ($directory -ieq $root -and $entry.Name -ieq '.git') { continue }
    if ($entry.Attributes -band [IO.FileAttributes]::Directory) { $pending.Push($entry.FullName) }
  }
}
'clear'
`;
  return run(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    timeout: boundedTimeout({ ...bounds, timeout }), env: { ...process.env, WORKTREE_CLEANUP_SCAN_ROOT: root, WORKTREE_CLEANUP_ALLOW_JUNCTION: allowedJunction ? '1' : '0',
      WORKTREE_CLEANUP_ALLOW_SELF_LINKS: JSON.stringify(selfLinks.map(({ path, linkType, rawTarget }) => ({ path, linkType, rawTarget }))) },
    parse: text => { requireEvidence(text.trim() === 'clear', 'Incomplete link scan'); return null; },
  });
}
function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function rescueFiles(decision, published, baseline) {
  requireEvidence(published && !published.dryRun && Array.isArray(published.worktrees), 'Remote rescue verification missing');
  const matches = published.worktrees.filter(tree => normalizePath(tree.path) === normalizePath(decision.path));
  requireEvidence(matches.length === 1 && matches[0].head === decision.head && matches[0].verified?.state === 'ok', 'Remote rescue verification does not match HEAD');
  const files = decision.files, remote = matches[0].files;
  requireEvidence(Array.isArray(files) && files.length > 0 && Array.isArray(remote) && remote.length === files.length, 'Rescue manifest incomplete');
  const seen = new Set();
  for (const file of files) {
    requireEvidence(safeRelative(file.path) && file.path.endsWith('.md') && OID.test(file.blobSha ?? '') && file.blobSha.length === decision.head.length &&
      ['untracked', 'modified'].includes(file.kind) && !seen.has(file.path.toLowerCase()), 'Unsafe rescue manifest');
    seen.add(file.path.toLowerCase());
    requireEvidence(file.rescuedPath === `docs/rescued/${basename(decision.path)}-${decision.head.slice(0, 7)}/${file.path}`, 'Rescue destination mismatch');
    requireEvidence(remote.filter(other => other.path === file.path && other.kind === file.kind && other.blobSha === file.blobSha && other.rescuedPath === file.rescuedPath).length === 1, 'Remote rescued blob mismatch');
  }
  const expected = files.map(file => ({ index: file.kind === 'untracked' ? '?' : ' ', worktree: file.kind === 'untracked' ? '?' : 'M', path: file.path }));
  const sort = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path));
  requireEvidence(equal(sort(expected), sort(value(baseline.status, 'Classification status').entries)), 'Rescue manifest does not cover status');
  // Work on a copy: neither publication evidence nor the caller's plan is changed.
  return files.map(file => ({ ...file })).sort((a, b) => (a.kind === 'untracked' ? 0 : 1) - (b.kind === 'untracked' ? 0 : 1));
}

function coversIgnored(entry, path) { return entry.endsWith('/') ? path.startsWith(entry) : path === entry; }

function snapshotProgress(record) {
  const progress = record.progress;
  const cleaned = new Set(), restored = new Map();
  if (progress === undefined) return { cleaned, restored };
  requireEvidence(progress && Array.isArray(progress.cleaned) && Array.isArray(progress.restored), 'Invalid snapshot progress');
  for (const path of progress.cleaned) {
    requireEvidence(record.files.some(file => file.path === path) && !cleaned.has(path), 'Invalid snapshot cleaned path');
    cleaned.add(path);
  }
  for (const file of progress.restored) {
    requireEvidence(cleaned.has(file.path) && record.files.some(entry => entry.path === file.path && entry.kind === 'modified') &&
      !restored.has(file.path) && Array.isArray(file.fingerprint) && file.fingerprint.length === 6 && file.fingerprint.every(Number.isFinite) &&
      /^[a-f0-9]{64}$/.test(file.sha256 ?? ''), 'Invalid snapshot restored evidence');
    restored.set(file.path, { fingerprint: [...file.fingerprint], sha256: file.sha256 });
  }
  requireEvidence(record.files.every(file => file.kind !== 'modified' || !cleaned.has(file.path) || restored.has(file.path)), 'Missing snapshot restored evidence');
  const inFlight = progress.inFlight;
  requireEvidence(inFlight === undefined || (inFlight && !cleaned.has(inFlight.path) &&
    record.files.some(file => file.path === inFlight.path && file.kind === inFlight.kind)), 'Invalid snapshot in-flight path');
  return { cleaned, restored, inFlight };
}

function snapshotFiles(decision, record, baseline, reconcile) {
  requireEvidence(record?.state === 'published_verified' && typeof record.treePath === 'string' && isAbsolute(record.treePath) &&
    normalizePath(record.treePath) === normalizePath(decision.path) && record.head === decision.head, 'Snapshot verification does not match HEAD or path');
  requireEvidence(Array.isArray(record.files) && record.files.length > 0, 'Snapshot manifest incomplete');
  const seen = new Set();
  for (const file of record.files) {
    requireEvidence(safeRelative(file.path) && OID.test(file.digest ?? '') && file.digest.length === decision.head.length &&
      ['untracked', 'ignored', 'modified'].includes(file.kind) && !seen.has(file.path.toLowerCase()), 'Unsafe snapshot manifest');
    seen.add(file.path.toLowerCase());
  }
  const progress = snapshotProgress(record);
  reconcile(progress);
  const { cleaned } = progress;
  const expected = record.files.filter(file => file.kind !== 'ignored' && !cleaned.has(file.path)).map(file =>
    ({ index: file.kind === 'untracked' ? '?' : ' ', worktree: file.kind === 'untracked' ? '?' : 'M', path: file.path }));
  const sort = rows => [...rows].sort((a, b) => a.path.localeCompare(b.path));
  const entries = value(baseline.status, 'Classification status').entries;
  // Accept either the original evidence or a fresh post-crash inventory. The
  // recheck still proves cleaned paths absent/restored before any mutation.
  requireEvidence(equal(sort(expected), sort(entries.filter(entry => !cleaned.has(entry.path)))) &&
    entries.every(entry => record.files.some(file => file.path === entry.path &&
      (file.kind === 'untracked' ? entry.index === '?' && entry.worktree === '?' :
        file.kind === 'modified' && entry.index === ' ' && entry.worktree === 'M'))), 'Snapshot manifest does not cover status');
  const ignored = value(baseline.ignored, 'Classification ignored files').unexpected;
  requireEvidence(ignored.every(entry => safeRelative(entry.endsWith('/') ? entry.slice(0, -1) : entry) &&
    record.files.some(file => file.kind === 'ignored' && coversIgnored(entry, file.path))) &&
    record.files.filter(file => file.kind === 'ignored').every(file => cleaned.has(file.path) || ignored.some(entry => coversIgnored(entry, file.path))),
  'Snapshot manifest does not cover ignored files');
  return { ...progress, pending: record.files.map(file => ({ ...file })).sort((a, b) => (a.kind === 'modified' ? 1 : 0) - (b.kind === 'modified' ? 1 : 0)) };
}

/** @typedef {{kind: string, path: string, args?: string[], file?: string, files?: string[]}} Mutation
 * @typedef {{added: object[], vanished: object[], changed: object[]}} RegistrationDelta
 * @typedef {{path: string, disposition: string, reason?: string, reasonCode?: string, requestedDisposition?: string, mutations: Mutation[], stopReason: string|null, notes?: string[], registrationDelta?: RegistrationDelta, unknownPruneEntries?: string[], recheckDurations?: {step: string, calls: number, ms: number}[]}} RemovalResult
 * @typedef {{runnerPath?: string, roadmapDataPaths?: string[], gitPath?: string, timeout?: number, walkTimeout?: number, linkScanTimeout?: number,
 * activityOptions?: import('./activity.mjs').ActivityOptions, operatorRelease?: string[], published?: object, softDeadline?: number, now?: () => number, monotonicNow?: () => number, recheckOnly?: boolean,
 * ownerRelease?: import('./policy.mjs').OwnerRelease, reachableFromRef?: (head: string, treePath: string) => object|Promise<object>,
 * verifySnapshot?: (record: object) => object|Promise<object>,
 * onSnapshotProgress?: (update: {treePath: string, cleaned: string[], restored: {path: string, fingerprint: number[], sha256: string}[], inFlight?: {path: string, kind: string}}) => object|void|Promise<object|void>,
 * onSnapshotRemoved?: (treePath: string) => object|void|Promise<object|void>,
 * beforeMutationGuard?: (event: Mutation) => object|Promise<object>,
 * mutations?: Mutation[], onStaleSkip?: (key: object) => void, onRegistrationDelta?: (delta: RegistrationDelta) => void,
 * runProbe?: typeof probe, onBeforeMutation?: (event: Mutation) => void|Promise<void>,
 * onAfterMutation?: (event: Mutation) => void|Promise<void>}} RemovalOptions
 */

/**
 * Execute U3's plan.value with the U1+U2 inventory used to classify it. Pass U4's
 * publication.value as options.published; dry-run publications cannot authorize
 * cleanup. Snapshot decisions carry snapshotRecord, including its progress;
 * verifySnapshot, onSnapshotProgress and onSnapshotRemoved are required before snapshot mutation.
 * U7 must supply a new clean classification snapshot after archiving.
 *
 * Only the planned transitions (rescued file cleanup, junction unlink, completed
 * child removal) are subtracted from the baseline. Never replace it wholesale
 * with a later scan: that would bless concurrent changes. Full gates refresh
 * candidate facts, shallow foreign links and incremental transcript evidence;
 * snapshot files between fresh gates get a synchronous file guard. The optional mutation
 * observers are fault-injection seams for temp fixtures, not authorization hooks.
 * beforeMutationGuard is a separate refusing gate: return {state: 'ok'} to
 * authorize, or {state: 'negative'|'unknown', reasonCode, reason?} to hold and
 * halt. Throws and malformed results refuse as mutation-guard. It runs after
 * the recheck for unlink-junction, unlink-self-links and remove, never rescue cleanup or prune.
 *
 * softDeadline is an absolute epoch millisecond time, checked inside scans and
 * before mutations; subprocess timeouts are capped by its remaining budget.
 * No branch or stash is deleted. recheckOnly runs one gate without mutations.
 * ok envelopes contain per-tree removed/hold/pending outcomes; halted means no
 * further candidates may be started (notably after target-snapshot divergence).
 * @param {{primaryPath: string, worktrees: object[]}} plan
 * @param {{primaryPath: string, runnerPath: string, commonDirectory: object, worktrees: object[]}} snapshot
 * @param {RemovalOptions} options
 */
export async function executeRemovals(plan, snapshot, options = {}) {
  if (!plan || !snapshot || typeof plan.primaryPath !== 'string' || !isAbsolute(plan.primaryPath) ||
      typeof snapshot.primaryPath !== 'string' || !isAbsolute(snapshot.primaryPath) || !Array.isArray(plan.worktrees) || !Array.isArray(snapshot.worktrees) ||
      normalizePath(plan.primaryPath) !== normalizePath(snapshot.primaryPath) || snapshot.commonDirectory?.state !== 'ok' ||
      (options.softDeadline !== undefined && !Number.isFinite(options.softDeadline))) return unknown('Invalid removal plan or classification snapshot');
  const executable = resolveExecutable(options.gitPath ?? 'git');
  if (executable.state !== 'ok') return executable;
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_LITERAL_PATHSPECS: '1' };
  const bounds = { softDeadline: options.softDeadline, deadlineNow: options.now ?? Date.now };
  const run = (executable, args, extra = {}) => (options.runProbe ?? probe)(executable, args, { ...extra, ...bounds, timeout: boundedTimeout({ ...bounds, timeout: extra.timeout }) });
  const git = (cwd, args) => value(run(executable.value, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { timeout: options.timeout, env }), 'Git ' + args[0]);
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  function expired() {
    const instant = now(); requireEvidence(Number.isFinite(instant), 'Invalid deadline clock');
    return instant >= (options.softDeadline ?? Infinity);
  }
  const keys = plan.worktrees.map(tree => typeof tree?.path === 'string' && isAbsolute(tree.path) ? normalizePath(tree.path) : null);
  if (keys.includes(null) || new Set(keys).size !== keys.length) return unknown('Invalid or duplicate candidate paths');
  if (snapshot.worktrees.some(tree => typeof tree?.path !== 'string' || !isAbsolute(tree.path))) return unknown('Invalid classification paths');
  const baselines = new Map(snapshot.worktrees.map(tree => [normalizePath(tree.path), tree]));
  if (baselines.size !== snapshot.worktrees.length) return unknown('Duplicate classification paths');
  const completed = new Set();
  /** @type {RemovalResult[]} */
  const worktrees = [];
  let halted = false;
  function scan(path) {
    const checked = candidateInventory(path, snapshot, { ...bounds, runnerPath: options.runnerPath ?? snapshot.runnerPath,
      roadmapDataPaths: options.roadmapDataPaths, gitPath: executable.value, timeout: options.timeout, walkTimeout: options.walkTimeout, runProbe: run,
      onStaleSkip: options.onStaleSkip, onRegistrationDelta: options.onRegistrationDelta }, completed);
    if (checked.hold) throw Object.assign(new Error(checked.hold.reason), { removalResult: checked.hold });
    const fresh = value(checked, 'Fresh inventory');
    requireEvidence(normalizePath(fresh.primaryPath) === normalizePath(plan.primaryPath) &&
      equal(value(fresh.commonDirectory, 'Fresh common directory'), value(snapshot.commonDirectory, 'Classification common directory')), 'Repository identity changed');
    return fresh;
  }
  function indexClean(path) {
    requireEvidence(git(path, ['diff-index', '--cached', '--no-ext-diff', '--no-renames', '--raw', '-z', 'HEAD', '--']) === '', 'Index differs from HEAD');
    const flags = git(path, ['ls-files', '-v', '-z']);
    requireEvidence(flags === '' || (flags.endsWith('\0') && flags.slice(0, -1).split('\0').every(row => row.startsWith('H '))), 'Unmerged, sparse, or hidden index entries');
  }
  function rawBlob(path, file = regularBytes(path)) {
    // probe's read-only interface has no stdin; use an equally bounded, shell-free
    // subprocess for this single raw-byte operation. No -w, --path, or filters.
    const result = spawnSync(executable.value, ['-C', plan.primaryPath, 'hash-object', '--stdin'], {
      input: file.bytes, env, timeout: boundedTimeout({ ...bounds, timeout: options.timeout }), maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
    });
    requireEvidence(!result.error && !result.signal && result.status === 0, 'Raw blob probe failed');
    const output = result.stdout.toString('utf8');
    requireEvidence(/^(?:[a-f0-9]{40}|[a-f0-9]{64})\r?\n$/.test(output), 'Invalid raw blob');
    return output.trim();
  }
  const candidates = [...plan.worktrees].sort((a, b) => normalizePath(b.path).split('/').length - normalizePath(a.path).split('/').length);
  for (const decision of candidates) {
    const path = decision.path, key = normalizePath(path);
    const ownerTarget = isOwnerTarget(path, options.ownerRelease);
    function refuse(reasonCode, reason = reasonCode) { throw Object.assign(new Error(reason), { reasonCode }); }
    /** @type {{step: string, calls: number, ms: number}[]} */
    const recheckDurations = [];
    const result = { path, requestedDisposition: decision.disposition, disposition: 'hold', reason: 'Not authorized for removal', mutations: [...(options.mutations ?? [])], stopReason: null, recheckDurations };
    worktrees.push(result);
    const isSnapshot = decision.disposition === 'snapshot';
    if (!isSnapshot && !REMOVABLE_DISPOSITIONS.includes(decision.disposition)) continue;
    if (halted) { result.disposition = 'pending'; result.reason = 'Run halted'; continue; }
    // Timing is advisory: a failing clock loses the sample, never the check's
    // own result or error.
    function sample() { try { const instant = monotonicNow(); return Number.isFinite(instant) ? instant : null; } catch { return null; } }
    function startStep(step) {
      const startedAt = sample();
      let duration = recheckDurations.find(entry => entry.step === step);
      if (!duration) { duration = { step, calls: 0, ms: 0 }; recheckDurations.push(duration); }
      duration.calls++;
      return () => { const finishedAt = sample(); if (startedAt !== null && finishedAt !== null) duration.ms += finishedAt - startedAt; };
    }
    function measureStep(step, run) {
      const finish = startStep(step);
      try { return run(); } finally { finish(); }
    }
    async function measureAsyncStep(step, run) {
      const finish = startStep(step);
      try { return await run(); } finally { finish(); }
    }
    let deregistered = false;
    try {
      if (expired()) { result.disposition = 'pending'; result.reason = 'Soft deadline reached'; result.stopReason = 'deadline'; continue; }
      const baseline = baselines.get(key);
      requireEvidence(baseline && OID.test(decision.head ?? ''), 'Missing classification evidence');
      const registration = value(baseline.registration, 'Classification registration');
      requireEvidence(registration.head === decision.head && registration.branch === decision.branch, 'Decision differs from classification');
      requireEvidence(decision.disposition !== 'remove-keep-branch' || (!registration.detached && registration.branch), 'Unmerged detached HEAD');
      if (isSnapshot && ownerTarget) refuse('snapshot-owner-release', 'Snapshot cleanup cannot use owner release');
      const ownerClassified = ownerTarget && releasesOwnerLiveness(path, baseline.activity, options.ownerRelease, decision.head);
      if (ownerTarget && !ownerClassified)
        refuse(ownerLivenessReason(baseline.activity, options.ownerRelease, decision.head));
      const { pending: snapshotPending, cleaned, restored, inFlight } = isSnapshot
        ? snapshotFiles(decision, decision.snapshotRecord, baseline, progress => {
          const flight = progress.inFlight;
          if (!flight) return;
          const full = join(path, flight.path);
          if (flight.kind === 'modified') {
            // A clean status may hide filters or stat-cache effects. Require
            // raw HEAD bytes or the exact filtered bytes restore would write.
            if (git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', flight.path]) !== '') return;
            const current = regularBytes(full);
            if (rawBlob(full, current) !== git(path, ['rev-parse', `${decision.head}:${flight.path}`]).trim()) {
              const filtered = spawnSync(executable.value, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', path,
                'cat-file', '--filters', `${decision.head}:${flight.path}`], {
                env, timeout: boundedTimeout({ ...bounds, timeout: options.timeout }), maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: false,
              });
              requireEvidence(!filtered.error && !filtered.signal && filtered.status === 0, 'Filtered HEAD probe failed');
              requireEvidence(current.bytes.equals(filtered.stdout), 'In-flight restore differs from HEAD');
            }
            progress.restored.set(flight.path, { fingerprint: current.fingerprint, sha256: current.sha256 });
          } else if (!absent(full)) return;
          progress.cleaned.add(flight.path);
        }) : { pending: [], cleaned: new Set(), restored: new Map() };
      let recoveredProgress = Boolean(inFlight && cleaned.has(inFlight.path));
      const resumedRestore = isSnapshot && restored.size > 0 && baseline.activity?.lease?.state === 'negative' &&
        baseline.activity?.transcript?.state === 'negative' && baseline.activity?.fileActivity?.state !== 'unknown';
      requireEvidence(baseline.activity?.head?.state === 'ok' && baseline.activity.head.value === decision.head &&
        ((baseline.activity.live?.state === 'negative' && ['lease', 'transcript', 'fileActivity'].every(name => baseline.activity[name]?.state === 'negative')) ||
          releasesUnresolvedDoubt(path, baseline.activity, options.operatorRelease) ||
          ownerClassified || resumedRestore), 'Classification activity unavailable');
      if (ownerTarget) {
        const status = value(baseline.status, 'Classification status'), ignored = value(baseline.ignored, 'Classification ignored files');
        if (!status.clean || status.entries.length || ignored.unexpected.length || decision.disposition === 'rescue') refuse('dirty');
        const nesting = value(baseline.containment, 'Classification containment');
        if (nesting.children.length || nesting.unregisteredRepositories.length) refuse('nesting');
      }
      const pending = decision.disposition === 'rescue' ? rescueFiles(decision, options.published, baseline) : snapshotPending;
      requireEvidence(pending.length || value(baseline.status, 'Classification status').clean, 'Non-rescue tree is dirty');
      let junctionRemoved = false;
      const unlinkedPaths = new Set();
      const selfLinks = value(baseline.links, 'Classification links').entries.filter(link => link.selfLink === true);
      let currentGate = false, snapshotVerified = false, removeVerified = false, fullGateAt = null, fullGateWallAt = null;
      let lastInventory;
      const emptyIgnored = new Set();
      async function saveProgress(inFlight) {
        const saved = await options.onSnapshotProgress({ treePath: path, cleaned: [...cleaned],
          restored: [...restored].map(([path, { fingerprint, sha256 }]) => ({ path, fingerprint: [...fingerprint], sha256 })),
          ...(inFlight ? { inFlight: { path: inFlight.path, kind: inFlight.kind } } : {}) });
        requireEvidence(saved === undefined || saved?.state === 'ok', 'Snapshot progress was not persisted');
      }
      function checkTargetEvidence(links) {
        const originalLinks = value(baseline.links, 'Classification links');
        if (!junctionRemoved && originalLinks.nodeModulesTarget && links.nodeModulesTarget === originalLinks.nodeModulesTarget) {
          const classifiedTarget = value(baseline.targetBaseline, 'Classification junction target snapshot');
          const expected = { topLevelCount: classifiedTarget.topLevelCount, lockHash: classifiedTarget.lockHash };
          if (links.nodeModulesTargetEvidence?.state !== 'ok' || !equal(links.nodeModulesTargetEvidence.value, expected)) {
            result.stopReason = 'shared-target-changed';
            throw new Error('Junction target changed');
          }
        }
      }
      function expectedStatusEntries() {
        return value(baseline.status, 'Classification status').entries.filter(entry => !cleaned.has(entry.path) &&
          ![...completed].some(child => isWithin(join(path, entry.path), child)));
      }
      function checkCleanedAbsent() {
        for (const file of pending) if (cleaned.has(file.path) && file.kind !== 'modified')
          requireEvidence(absent(join(path, file.path)), 'Cleaned snapshot file reappeared');
      }
      function checkRestored() {
        for (const [file, expected] of restored) {
          const current = regularBytes(join(path, file));
          requireEvidence(equal(current.fingerprint, expected.fingerprint) && current.sha256 === expected.sha256, 'Restored file changed');
        }
      }
      async function reverify() {
        let verified;
        try { verified = await options.verifySnapshot?.(decision.snapshotRecord); } catch { /* Unavailable evidence refuses. */ }
        if (verified?.state !== 'ok') refuse('snapshot-unverified');
        currentGate = false; // Re-establish the clean gate after the async remote read.
        fullGateAt = null;
      }
      async function recheck() {
        remainingTime(bounds);
        if (ownerTarget) {
          let head;
          try { head = measureStep('blob/index/HEAD checks', () => git(path, ['rev-parse', 'HEAD']).trim()); }
          catch { measureStep('candidate inventory', () => scan(path)); refuse('head-unknown'); }
          if (head !== decision.head) refuse('head-changed');
        }
        const fresh = measureStep('candidate inventory', () => scan(path)), tree = fresh.worktrees.find(entry => normalizePath(entry.path) === key);
        requireEvidence(tree, 'Worktree no longer registered');
        requireEvidence(tree.exemption?.state === 'negative' && baseline.exemption?.state === 'negative', 'Exempt worktree');
        requireEvidence(equal(value(tree.registration, 'Registration'), registration) && registration.locked === null && registration.prunable === null && !registration.bare, 'HEAD or registration changed');
        requireEvidence(equal(value(tree.identity, 'Identity'), value(baseline.identity, 'Classification identity')), 'Identity changed');
        const links = value(tree.links, 'Links'), originalLinks = value(baseline.links, 'Classification links');
        const junction = links.entries.find(link => link.relativePath === 'node_modules');
        requireEvidence(!junction || (isAdmissibleTopLevelNodeModulesJunction(junction) &&
          (!originalLinks.nodeModulesTarget || junction.danglingJunction !== true)), 'Unproven junction target');
        checkTargetEvidence(links);
        requireEvidence(tree.inboundLinks?.state === 'negative' && baseline.inboundLinks?.state === 'negative', 'Inbound link or unknown target');
        const expectedLinks = { ...originalLinks, entries: originalLinks.entries.filter(link => !(junctionRemoved && link.relativePath === 'node_modules') &&
          !unlinkedPaths.has(link.path) &&
          ![...completed].some(child => isWithin(link.path, child))), nodeModulesTarget: junctionRemoved ? null : originalLinks.nodeModulesTarget,
          nodeModulesTargetEvidence: junctionRemoved ? null : originalLinks.nodeModulesTargetEvidence };
        requireEvidence(!links.forbidden.length && equal(links, expectedLinks), 'Links changed or forbidden');
        const nesting = value(tree.containment, 'Containment'), originalNesting = value(baseline.containment, 'Classification containment');
        requireEvidence(!nesting.children.length && !nesting.unregisteredRepositories.length &&
          equal(nesting, { ...originalNesting, children: originalNesting.children.filter(child => !completed.has(normalizePath(child))) }), 'Children changed or kept');
        const status = value(tree.status, 'Status');
        const entries = expectedStatusEntries();
        requireEvidence(equal(status, { clean: entries.length === 0, entries }), 'Status changed');
        const ignored = value(tree.ignored, 'Ignored files'), originalIgnored = value(baseline.ignored, 'Classification ignored files');
        const expectedIgnored = originalIgnored.entries.filter(entry => !(junctionRemoved && /^node_modules\/?$/.test(entry)) &&
          !(completed.size && !ignored.entries.includes(entry) && [...completed].some(child => isWithin(child, join(path, entry)) || isWithin(join(path, entry), child))));
        if (isSnapshot) {
          const finished = entry => pending.filter(file => file.kind === 'ignored' && coversIgnored(entry, file.path)).every(file => cleaned.has(file.path));
          const removedIgnored = originalIgnored.unexpected.filter(finished);
          emptyIgnored.clear();
          for (const entry of ignored.unexpected.filter(entry => removedIgnored.includes(entry) && entry.endsWith('/'))) {
            value(walkDirectory(join(path, entry), { ...bounds, timeout: options.walkTimeout, visit: ({ stat }) => {
              requireEvidence(stat.isDirectory() && !stat.isSymbolicLink(), 'Cleaned ignored directory contains a file or link');
            } }), 'Snapshot empty directory scan');
            emptyIgnored.add(entry);
          }
          requireEvidence(equal(ignored.unexpected.filter(entry => !emptyIgnored.has(entry)), originalIgnored.unexpected.filter(entry => !finished(entry))) &&
            equal(ignored.entries.filter(entry => !emptyIgnored.has(entry)), expectedIgnored.filter(entry => !removedIgnored.includes(entry))), 'Ignored files changed');
        } else requireEvidence(!ignored.unexpected.length && !originalIgnored.unexpected.length && equal(ignored.entries, expectedIgnored), 'Ignored files changed');
        const live = await measureAsyncStep('activity', () => activity({ ...tree, activity: baseline.activity }, { ...options.activityOptions, ...bounds }));
        const ownerReleased = ownerTarget && releasesOwnerLiveness(path, live, options.ownerRelease, decision.head);
        if (ownerTarget && !ownerReleased) refuse(ownerLivenessReason(live, options.ownerRelease, decision.head));
        requireEvidence(live.head?.state === 'ok' && live.head.value === decision.head && live.lease?.state === 'negative' &&
          (ownerReleased || live.transcript?.state === 'negative' || releasesUnresolvedDoubt(path, live, options.operatorRelease)), 'Lease, transcript, or HEAD activity');
        if (!ownerReleased) requireEvidence(live.fileActivity?.state !== 'unknown', 'File activity unknown');
        const files = ownerReleased ? null : live.fileActivity;
        if (!ownerReleased) requireEvidence(files.state !== 'unknown', 'File activity unknown');
        if (restored.size) measureStep('restored-file checks', checkRestored);
        if (!ownerReleased && files.state !== 'negative') {
          requireEvidence(restored.size > 0, 'Recent file activity');
          measureStep('activity', () => {
            const instant = (options.activityOptions?.now ?? Date.now)();
            value(walkDirectory(path, { ...bounds, timeout: options.walkTimeout, skipDirectories: new Set(['.git', 'node_modules', '.next']), visit: ({ path: file, stat }) => {
              requireEvidence(!stat.isSymbolicLink(), 'Activity link');
              if (stat.isFile() && stat.mtimeMs >= instant - WINDOW_MS) requireEvidence(restored.has(relative(path, file).replaceAll('\\', '/')), 'New file activity after restore');
            } }), 'Post-restore activity');
          });
        }
        // Repeat the inventory after the async transcript read, then check raw
        // blobs and index last, as close to the mutation as these probes permit.
        const finalTree = measureStep('final inventory', () => scan(path)).worktrees.find(entry => normalizePath(entry.path) === key);
        if (finalTree?.links?.state === 'ok') checkTargetEvidence(finalTree.links.value);
        requireEvidence(finalTree && ['registration', 'identity', 'status', 'ignored', 'links', 'containment', 'inboundLinks', 'exemption'].every(name => equal(finalTree[name], tree[name])), 'Evidence changed during recheck');
        if (isSnapshot) {
          const finished = entry => pending.filter(file => file.kind === 'ignored' && coversIgnored(entry, file.path)).every(file => cleaned.has(file.path));
          // --ignored=matching collapses directories. Expand them on every gate:
          // an extra child must never disappear into an unchanged dir/ entry.
          for (const entry of originalIgnored.unexpected.filter(entry => entry.endsWith('/'))) {
            const directory = join(path, entry);
            if (absent(directory)) { requireEvidence(finished(entry), 'Ignored directory vanished'); continue; }
            value(walkDirectory(directory, { ...bounds, timeout: options.walkTimeout, visit: ({ path: full, stat }) => {
              requireEvidence(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'Ignored entry is not regular');
              if (stat.isFile()) {
                const name = relative(path, full).replaceAll('\\', '/');
                requireEvidence(pending.some(file => file.kind === 'ignored' && file.path === name && !cleaned.has(name)), 'Ignored files changed');
              }
            } }), 'Snapshot ignored directory scan');
          }
          checkCleanedAbsent();
        }
        measureStep('blob/index/HEAD checks', () => {
          for (const file of pending) if (!cleaned.has(file.path)) requireEvidence(rawBlob(join(path, file.path)) === (isSnapshot ? file.digest : file.blobSha), isSnapshot ? 'Snapshot file bytes changed' : 'Rescued file bytes changed');
          indexClean(path);
          const finalHead = git(path, ['rev-parse', 'HEAD']).trim();
          if (ownerTarget && finalHead !== decision.head) refuse('head-changed');
          requireEvidence(finalHead === decision.head, 'HEAD advanced during recheck');
        });
        if (ownerTarget && registration.detached) {
          let reachable;
          try { reachable = await measureAsyncStep('reachability', () => (options.reachableFromRef ?? (head => refReachability(plan.primaryPath, head,
            { gitPath: executable.value, runProbe: run, timeout: options.timeout })))(decision.head, path)); }
          catch { refuse('unknown', 'Ref reachability unavailable'); }
          if (reachable?.state !== 'ok') refuse(reachable?.state === 'negative' ? 'unmerged-detached' : 'unknown', 'Detached HEAD is not proven reachable');
        }
        measureStep('complete link scan', () => value(completeLinkScan(path, Boolean(links.nodeModulesTarget) ||
          (!junctionRemoved && junction?.danglingJunction === true && isDanglingTopLevelNodeModulesJunction(junction)),
        selfLinks.filter(link => !unlinkedPaths.has(link.path)), run, options.linkScanTimeout, bounds), 'Pre-removal link scan'));
        remainingTime(bounds);
        lastInventory = fresh;
        fullGateAt = sample();
        try { fullGateWallAt = now(); } catch { fullGateWallAt = null; }
        return tree;
      }
      function fullGateFresh() {
        const instant = sample();
        let wall;
        try { wall = now(); } catch { return false; }
        // Both clocks must agree: a monotonic counter may pause across sleep.
        return fullGateAt !== null && instant !== null && instant >= fullGateAt && instant - fullGateAt <= FULL_GATE_MAX_AGE_MS &&
          Number.isFinite(fullGateWallAt) && Number.isFinite(wall) && wall >= fullGateWallAt && wall - fullGateWallAt <= FULL_GATE_MAX_AGE_MS;
      }
      function fileGuard(file) {
        measureStep('file guard', () => {
          remainingTime(bounds);
          requireEvidence(leases(path, { ...options.activityOptions, ...bounds }).state === 'negative', 'Lease activity');
          requireEvidence(git(path, ['rev-parse', 'HEAD']).trim() === decision.head, 'HEAD advanced during recheck');
          requireEvidence(git(path, ['rev-parse', '--symbolic-full-name', 'HEAD']).trim() === (registration.branch ?? 'HEAD'), 'HEAD or registration changed');
          indexClean(path);
          const admin = lastInventory?.registrationKeys.find(entry => normalizePath(entry.path) === key);
          requireEvidence(admin && absent(join(admin.adminPath, 'locked')), 'HEAD or registration changed');
          try {
            const dotGit = lstatSync(join(path, '.git'));
            requireEvidence(!dotGit.isSymbolicLink() && (dotGit.isFile() || dotGit.isDirectory()), 'Path link changed');
            let directory = path;
            for (const part of ['', ...file.path.split('/').slice(0, -1)]) {
              directory = join(directory, part);
              const stat = lstatSync(directory);
              requireEvidence(stat.isDirectory() && !stat.isSymbolicLink(), 'Path link changed');
            }
          } catch { requireEvidence(false, 'Path link changed'); }
          requireEvidence(rawBlob(join(path, file.path)) === file.digest, 'Snapshot file bytes changed');
          checkCleanedAbsent();
          checkRestored();
          const entries = parseStatus(git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'])).filter(entry => entry.index !== '!');
          requireEvidence(equal(entries, expectedStatusEntries()), 'Status changed');
        });
      }
      async function before(event) {
        if (isSnapshot && !snapshotVerified) {
          let verified;
          try { verified = await options.verifySnapshot?.(decision.snapshotRecord); } catch { /* Unavailable evidence refuses. */ }
          if (verified?.state !== 'ok' || typeof options.onSnapshotProgress !== 'function' ||
              typeof options.onSnapshotRemoved !== 'function') refuse('snapshot-unverified');
          snapshotVerified = true;
          currentGate = false; // The async remote read invalidates any earlier clean gate.
          fullGateAt = null;
        }
        if (isSnapshot && event.kind === 'remove' && !(currentGate && removeVerified)) await reverify();
        if (isSnapshot && ['unlink-snapshot', 'restore'].includes(event.kind)) {
          if (!fullGateFresh()) await recheck();
        } else if (event.kind !== 'remove' || !currentGate) await recheck();
        if (recoveredProgress) {
          await saveProgress();
          recoveredProgress = false;
          await recheck();
        }
        currentGate = false;
        if (options.beforeMutationGuard && ['unlink-junction', 'unlink-self-links', 'remove'].includes(event.kind)) {
          let guard;
          try { guard = await options.beforeMutationGuard(event); } catch { /* An unavailable guard refuses. */ }
          if (guard?.state !== 'ok') {
            result.stopReason = 'mutation-guard';
            refuse(typeof guard?.reasonCode === 'string' && guard.reasonCode ? guard.reasonCode : 'mutation-guard',
              typeof guard?.reason === 'string' ? guard.reason : 'Pre-mutation guard refused');
          }
        }
        if (options.onBeforeMutation) await options.onBeforeMutation(event);
        remainingTime(bounds);
      }
      async function after(event) { if (options.onAfterMutation) await options.onAfterMutation(event); }
      // Read-only timing/diagnostics use the identical gate and stop before any
      // rescue cleanup, junction unlink, worktree removal or prune can start.
      if (options.recheckOnly) { await recheck(); result.reason = 'Read-only recheck passed'; continue; }
      for (const file of pending) {
        if (cleaned.has(file.path)) continue;
        // --staged too: under core.autocrlf a worktree-only restore writes CRLF
        // over an index entry recorded at the LF size, and git then reports a
        // phantom modification by size alone. Rescue admits no staged change,
        // so resetting this one path's index entry to HEAD changes nothing else.
        const args = file.kind === 'modified' ? ['restore', '--source=HEAD', '--staged', '--worktree', '--', file.path] : undefined;
        const event = { kind: file.kind === 'modified' ? 'restore' : isSnapshot ? 'unlink-snapshot' : 'unlink-rescued', path, file: file.path, args };
        await before(event);
        if (isSnapshot) {
          // Intent must be durable before touching the file. Guard after the
          // async journal write so it cannot bless concurrently changed bytes.
          await saveProgress(file);
          if (!fullGateFresh()) await recheck();
          fileGuard(file);
        }
        if (args) {
          const indexPath = git(path, ['rev-parse', '--path-format=absolute', '--git-path', 'index']).trim();
          const beforeFile = regularBytes(join(path, file.path)), beforeIndex = regularBytes(indexPath);
          let changed = false;
          try { git(path, args); changed = true; }
          finally {
            // A refused restore is local only if both file and index stayed put.
            try { changed ||= !equal(beforeFile, regularBytes(join(path, file.path))) || !equal(beforeIndex, regularBytes(indexPath)); }
            catch { changed = true; } // A partial write may have made a path unreadable.
            if (changed) result.mutations.push(event);
          }
          restored.set(file.path, regularBytes(join(path, file.path)));
        } else {
          unlinkSync(join(path, file.path)); result.mutations.push(event);
        }
        cleaned.add(file.path);
        if (isSnapshot) await saveProgress();
        if (isSnapshot && file.kind === 'ignored') {
          // Parent pruning is best-effort housekeeping, after durable progress.
          // Leave failures for the final gate, which proves any leftovers empty.
          try {
            const entry = baseline.ignored.value.unexpected.find(entry => entry.endsWith('/') && coversIgnored(entry, file.path));
            if (entry) {
              const boundary = join(path, entry);
              for (let directory = dirname(join(path, file.path)); isWithin(directory, boundary); directory = dirname(directory)) {
                remainingTime(bounds);
                const stat = lstatSync(directory);
                requireEvidence(stat.isDirectory() && !stat.isSymbolicLink(), 'Ignored directory changed');
                rmdirSync(directory);
                result.mutations.push({ kind: 'rmdir-snapshot', path, file: relative(path, directory).replaceAll('\\', '/') });
                if (normalizePath(directory) === normalizePath(boundary)) break;
              }
            }
          } catch (error) {
            (result.notes ??= []).push(`Empty-parent cleanup left directory for ${file.path}: ${String(error)}`);
          }
        }
        await after(event);
      }
      if (isSnapshot) { await reverify(); removeVerified = true; }
      const tree = await recheck();
      requireEvidence(tree.status.value.clean, 'Rescue cleanup did not leave clean status');
      if (isSnapshot) requireEvidence(tree.ignored.value.unexpected.every(entry => emptyIgnored.has(entry)), 'Snapshot cleanup left ignored files');
      const target = tree.links.value.nodeModulesTarget;
      const dangling = tree.links.value.entries.find(link => link.danglingJunction === true);
      // Only this clean gate can be reused; before() consumes it before mutation.
      currentGate = tree.status.value.clean && !target && !dangling && !selfLinks.length;
      if (dangling) {
        requireEvidence(process.platform === 'win32', 'Junction helper requires Windows');
        const classified = value(baseline.links, 'Classification links').entries.find(link => link.relativePath === 'node_modules');
        requireEvidence(isDanglingTopLevelNodeModulesJunction(classified), 'Unproven dangling junction');
        const event = { kind: 'unlink-junction', path, file: join(path, 'node_modules') };
        await before(event);
        const powershell = resolveExecutable(windowsPowerShellPath());
        value(powershell, 'Junction helper');
        // The guard and hook have finished. Re-read the source kind, ordinary
        // ancestors and every target hop immediately before unlinking only it.
        const fresh = value(topLevelModulesLink(path, run, options.timeout), 'Dangling junction');
        requireEvidence(isDanglingTopLevelNodeModulesJunction(fresh) &&
          equal(fresh.targetHops.map(hop => hop.path), classified.targetHops.map(hop => hop.path)), 'Dangling junction changed');
        const unlinkResult = run(powershell.value, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
          '-ExpectedLinkType', fresh.linkType, '-ExpectedTarget', fresh.rawTarget, event.file], { timeout: options.timeout, env });
        if (absent(event.file)) { result.mutations.push(event); unlinkedPaths.add(event.file); }
        await after(event);
        value(unlinkResult, 'Junction unlink');
        requireEvidence(absent(event.file), 'Junction still present');
        junctionRemoved = true;
      }
      if (target) {
        requireEvidence(process.platform === 'win32', 'Junction helper requires Windows');
        const link = tree.links.value.entries.find(entry => entry.relativePath === 'node_modules');
        requireEvidence(isAdmissibleTopLevelNodeModulesJunction(link), 'Unproven junction target');
        const event = { kind: 'unlink-junction', path, file: join(path, 'node_modules') };
        await before(event);
        let beforeTarget;
        try {
          beforeTarget = targetSnapshot(target, options.walkTimeout, bounds);
          const classifiedTarget = value(baseline.targetBaseline, 'Classification junction target snapshot');
          requireEvidence(beforeTarget.count === classifiedTarget.count && beforeTarget.lockHash === classifiedTarget.lockHash, 'Junction target changed');
        } catch (error) { result.stopReason = expired() ? 'deadline' : 'shared-target-changed'; throw error; }
        const powershell = resolveExecutable(windowsPowerShellPath());
        const fresh = value(topLevelModulesLink(path, run, options.timeout), 'Junction');
        requireEvidence(isAdmissibleTopLevelNodeModulesJunction(fresh) && equal(fresh, link), 'Junction changed');
        const unlinkResult = powershell.state === 'ok' ? run(powershell.value, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
          '-ExpectedLinkType', fresh.linkType, '-ExpectedTarget', fresh.rawTarget, event.file], { timeout: options.timeout, env }) : powershell;
        if (absent(event.file)) { result.mutations.push(event); unlinkedPaths.add(event.file); }
        // Even a failed helper might have partially acted: always compare its target.
        try {
          await after(event);
          requireEvidence(equal(beforeTarget, targetSnapshot(target, options.walkTimeout, bounds)), 'Junction target changed');
        } catch (error) { result.stopReason = expired() ? 'deadline' : 'shared-target-changed'; throw error; }
        value(unlinkResult, 'Junction unlink');
        requireEvidence(absent(event.file), 'Junction still present');
        junctionRemoved = true;
      }
      if (selfLinks.length) {
        requireEvidence(process.platform === 'win32', 'Self-link helper requires Windows');
        const event = { kind: 'unlink-self-links', path, files: selfLinks.map(link => link.path) };
        await before(event);
        const powershell = resolveExecutable(windowsPowerShellPath());
        value(powershell, 'Self-link helper');
        const freshLinks = selfLinks.map(link => {
          const fresh = readLink(path, link.path, 'symlink', run, options.timeout);
          requireEvidence(isBuildSelfLink(path, fresh) && equal({ ...fresh, selfLink: true }, link), 'Self-link changed');
          return fresh;
        });
        for (const fresh of freshLinks) {
          const mutation = { kind: event.kind, path, file: fresh.path };
          const unlinkResult = run(powershell.value, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper,
            '-EventKind', event.kind, '-ExpectedLinkType', fresh.linkType, '-ExpectedTarget', fresh.rawTarget, fresh.path], { timeout: options.timeout, env });
          if (absent(fresh.path)) { result.mutations.push(mutation); unlinkedPaths.add(fresh.path); }
          await after(mutation);
          value(unlinkResult, 'Self-link unlink');
          requireEvidence(absent(fresh.path), 'Self-link still present');
          const target = lstatSync(fresh.target);
          requireEvidence(!target.isSymbolicLink() && (target.isDirectory() || target.isFile()), 'Self-link target missing or linked');
        }
      }
      const event = { kind: 'remove', path, args: ['worktree', 'remove', path] };
      if (expired()) { result.disposition = 'pending'; result.reason = 'Soft deadline reached'; result.stopReason = 'deadline'; continue; }
      await before(event);
      if (expired()) { result.disposition = 'pending'; result.reason = 'Soft deadline reached'; result.stopReason = 'deadline'; continue; }
      // `git worktree remove` deletes every file, including a real node_modules
      // (tens of thousands of files under real-time scanning on Windows). Killed
      // by a short probe timeout it leaves a half-removed tree, so never start it
      // without a real budget, and give it that budget.
      if (remainingTime(bounds) < REMOVE_MIN_MS) { result.disposition = 'pending'; result.reason = 'Not enough time left to remove safely'; result.stopReason = 'deadline'; continue; }
      for (const unlinked of unlinkedPaths) requireEvidence(absent(unlinked), 'Unlinked path reappeared before Git');
      // Git can delete files and its admin directory even when removal fails.
      result.mutations.push({ kind: 'remove-started', path });
      const removal = run(executable.value, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', plan.primaryPath, ...event.args],
        { timeout: REMOVE_BUDGET_MS, env });
      if (removal?.stopReason) throw Object.assign(new Error(removal.reason ?? 'Git worktree unavailable'), { stopReason: removal.stopReason });
      if (removal?.state !== 'ok') {
        const error = new Error(removal?.reason ?? 'Git worktree unavailable');
        // Equal inventory cannot prove deletion never started. The intact checks
        // are secondary to a normal exit with a known pre-deletion refusal.
        if (!normalFailedExit(removal) || !preDeletionRefusal(removal.stderr)) throw error;
        try {
          remainingTime(bounds);
          const beforeTree = lastInventory.worktrees.find(entry => normalizePath(entry.path) === key);
          const admin = lastInventory.registrationKeys.find(entry => normalizePath(entry.path) === key);
          requireEvidence(admin, 'Pre-removal admin identity unavailable');
          const dotGit = lstatSync(join(path, '.git')), adminStat = lstatSync(admin.adminPath);
          requireEvidence(dotGit.isFile() && !dotGit.isSymbolicLink() && adminStat.isDirectory() && !adminStat.isSymbolicLink(), 'Removal identity missing or linked');
          const intact = scan(path), afterTree = intact.worktrees.find(entry => normalizePath(entry.path) === key);
          requireEvidence(intact.registrations.some(entry => normalizePath(entry.path) === key && entry.head === decision.head), 'Removal changed registration or HEAD');
          requireEvidence(intact.registrationKeys.some(entry => entry.key === admin.key), 'Removal changed admin identity');
          requireEvidence(beforeTree && afterTree && ['registration', 'identity', 'status', 'ignored', 'links', 'containment', 'inboundLinks', 'exemption']
            .every(name => equal(afterTree[name], beforeTree[name])), 'Removal changed candidate inventory');
          remainingTime(bounds);
          // Clear only the attempt marker. Earlier cleanup mutations still halt.
          result.mutations.pop();
          result.reason = 'Git refused removal before deletion; intact checks passed: ' + removal.stderr.replace(/\s+/g, ' ').trim().slice(0, 200);
          result.reasonCode = 'git-refused-intact';
          continue;
        } catch (proofError) {
          // Failed proof retains the attempt marker and any vanished cause.
          if (proofError.removalResult) error.removalResult = proofError.removalResult;
        }
        throw error;
      }
      deregistered = true;
      result.mutations.push({ kind: 'deregister', path });
      await after(event);
      if (isSnapshot && absent(path)) {
        const saved = await options.onSnapshotRemoved(path);
        requireEvidence(saved === undefined || saved?.state === 'ok', 'Snapshot removal was not persisted');
      }
      result.disposition = absent(path) ? 'removed' : 'pending';
      result.reason = result.disposition === 'pending' ? 'Directory remains after deregistration; no retry' : 'Worktree removed; branch retained';
      if (expired()) {
        result.stopReason = 'deadline';
        if (result.disposition === 'removed') completed.add(key);
        continue;
      }
      // Prune touches repository metadata. Prove the candidate stayed absent and
      // the primary identity is intact; unrelated churn defers this tree's prune.
      const afterRemoval = value(inventory({ ...bounds, repositoryPath: plan.primaryPath, candidatePath: plan.primaryPath,
        metadataOnly: true, gitPath: executable.value, runProbe: run, timeout: options.timeout }), 'Post-removal registration');
      requireEvidence(equal(afterRemoval.commonDirectory, snapshot.commonDirectory), 'Repository identity changed');
      const primary = afterRemoval.worktrees.find(entry => normalizePath(entry.path) === normalizePath(plan.primaryPath));
      value(primary?.identity, 'Primary identity before prune');
      const admin = lastInventory.registrationKeys.find(entry => normalizePath(entry.path) === key);
      try { requireEvidence(admin, 'Registration key missing before prune'); }
      catch (error) { throw Object.assign(error, { stopReason: 'prune-unknown' }); }
      if (afterRemoval.registrations.some(entry => normalizePath(entry.path) === key) ||
          afterRemoval.registrationKeys.some(entry => normalizePath(entry.path) === key || normalizePath(entry.adminPath) === normalizePath(admin.adminPath)))
        throw Object.assign(new Error('Registration changed before prune'), { stopReason: 'prune-unknown' });
      const previous = new Map(lastInventory.registrations.filter(entry => normalizePath(entry.path) !== key).map(entry => [normalizePath(entry.path), entry]));
      const current = new Map(afterRemoval.registrations.map(entry => [normalizePath(entry.path), entry]));
      const previousKeys = new Map(lastInventory.registrationKeys.map(entry => [normalizePath(entry.path), entry]));
      const currentKeys = new Map(afterRemoval.registrationKeys.map(entry => [normalizePath(entry.path), entry]));
      result.registrationDelta = {
        added: [...current].filter(([path]) => !previous.has(path)).map(([, entry]) => entry),
        vanished: [...previous].filter(([path]) => !current.has(path)).map(([, entry]) => entry),
        changed: [...current].filter(([path, entry]) => previous.has(path) &&
          (!equal(entry, previous.get(path)) || !equal(currentKeys.get(path), previousKeys.get(path)))).map(([, entry]) => entry),
      };
      if (Object.values(result.registrationDelta).some(entries => entries.length)) {
        if (result.disposition === 'removed') { result.disposition = 'removed-prune-deferred'; completed.add(key); }
        continue;
      }
      const preview = () => {
        const output = run(executable.value, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', plan.primaryPath, 'worktree', 'prune', '--dry-run', '--verbose'], { timeout: options.timeout, env });
        const checked = checkPrunePreview(value(output, 'Prune preview') + (output.stderr ?? ''), snapshot, { includeUnknownEntries: true });
        if (checked.stopReason) {
          result.unknownPruneEntries = [...new Set([...(result.unknownPruneEntries ?? []), ...checked.unknownEntries])];
          return { ...checked, deferred: true };
        }
        return checked;
      };
      if (preview().deferred) {
        if (result.disposition === 'removed') { result.disposition = 'removed-prune-deferred'; completed.add(key); }
        continue;
      }
      const prune = { kind: 'prune', path, args: ['worktree', 'prune'] };
      if (options.onBeforeMutation) await options.onBeforeMutation(prune);
      remainingTime(bounds);
      if (preview().deferred) {
        if (result.disposition === 'removed') { result.disposition = 'removed-prune-deferred'; completed.add(key); }
        continue;
      }
      git(plan.primaryPath, prune.args);
      await after(prune);
      if (result.disposition === 'removed') completed.add(key);
    } catch (error) {
      if (error.removalResult && !result.mutations.length) {
        Object.assign(result, error.removalResult);
        continue;
      }
      result.disposition = deregistered || expired() ? 'pending' : 'hold';
      result.reason = error.removalResult?.reason ?? (expired() ? 'Soft deadline reached' : error instanceof Error ? error.message : 'Removal evidence unavailable');
      if (error.removalResult?.reasonCode ?? error.reasonCode) result.reasonCode = error.removalResult?.reasonCode ?? error.reasonCode;
      result.stopReason ??= error.stopReason ?? (expired() ? 'deadline' : null);
      // Interrupted Git removal can lose .git before its command reports success.
      if (!result.stopReason && baselines.get(key)?.identity?.state === 'ok' && (absent(path) || absent(join(path, '.git')))) result.stopReason = 'half-removed';
    } finally {
      result.stopReason = removalStopReason(result);
      if (result.stopReason) halted = true;
    }
  }
  return ok({ worktrees, halted });
}
