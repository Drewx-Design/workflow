import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { copyFileSync, existsSync, lstatSync, mkdtempSync, rmSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { candidateInventory, checkPrunePreview, inventory, isWithin, normalizePath } from './lib/worktree-cleanup/inventory.mjs';
import { collectActivity } from './lib/worktree-cleanup/activity.mjs';
import { boundedTimeout, equal, ok, probe, resolveExecutable, unknown, withDeadline } from './lib/worktree-cleanup/probe.mjs';
import { planWorktrees, REMOVABLE_DISPOSITIONS, snapshotFallback } from './lib/worktree-cleanup/policy.mjs';
import { readCommissioning, preflightSnapshot, publishSnapshot, verifySnapshotRecord, markSnapshotProgress, markSnapshotRemoved, reconcileSnapshots, recoverSnapshot, writeCommissioningArtifact, readResumableSnapshot, markSnapshotRecoveryFailure } from './lib/worktree-cleanup/snapshot.mjs';
import { publishRescues, rescueDryRun, runRescueCommand } from './lib/worktree-cleanup/rescue.mjs';
import { blobOid, createArchive, prepareArchivedTree, pruneArchives, readRegular, restoreArchive } from './lib/worktree-cleanup/archive.mjs';
import { executeRemovals, removalStopReason, REMOVE_MIN_MS } from './lib/worktree-cleanup/remove.mjs';
import { appendIdleObservation } from './lib/worktree-cleanup/idle-journal.mjs';
import { scanPrimaryLinks, writeLinkIndex } from './lib/worktree-cleanup/link-index.mjs';
import { runRelease } from './lib/worktree-cleanup/release.mjs';
import { acquireRunLock, admitRunLock, defaultReportRoot, notifyRun, writeCommissionPreviewReport, writeFailureReport, writeRunReport } from './lib/worktree-cleanup/report.mjs';

// Two minutes allow several 15-second Git probes plus about a minute for retention/report I/O.
const TAIL_RESERVE_MS = 2 * 60_000;
const PRIMARY_SCAN_MAX_MS = 3 * 60_000;

const snapshotReportFields = record => record ? { snapshotRef: record.ref, snapshotCommit: record.commitSha,
  restoreCommand: `node scripts/worktree-cleanup.mjs recover --ref ${record.ref} --dest <ABSOLUTE_DIR>` } : {};

/** Coordinate the existing safety boundaries. Injectable transports and clocks
 * are for disposable fixtures; the CLI exposes no publication bypasses. */
export async function runCleanup(options = {}, dependencies = {}) {
  const now = options.now ?? Date.now, startedAt = now();
  const softDeadline = startedAt + (options.softTimeoutMs ?? 35 * 60_000);
  return withDeadline(softDeadline, now, () => runWithinDeadline({ ...options, startedAt, softDeadline, deadlineNow: now }, dependencies));
}
async function runWithinDeadline(options, dependencies) {
  const api = { inventory, collectActivity, planWorktrees, readCommissioning, preflightSnapshot, publishSnapshot, verifySnapshotRecord,
    markSnapshotProgress, markSnapshotRemoved, reconcileSnapshots, snapshotFallback, publishRescues, executeRemovals, createArchive,
    prepareArchivedTree, pruneArchives, appendIdleObservation, runProbe: probe, runRescueCommand,
    acquireRunLock, notifyRun, scanPrimaryLinks, writeLinkIndex, ...dependencies };
  const now = options.now ?? Date.now, startedAt = options.startedAt;
  const root = resolve(options.reportRoot ?? defaultReportRoot());
  const repositoryPath = resolve(options.repositoryPath ?? process.cwd());
  const runnerPath = resolve(options.runnerPath ?? repositoryPath);
  const operatorRelease = [...new Set((options.operatorRelease ?? []).map(path => {
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(`--release-unresolved-doubt requires an absolute path: ${path}`);
    return normalizePath(path);
  }))];
  if (operatorRelease.length) options = { ...options, operatorRelease };
  if (options.runId !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,127}$/.test(options.runId)) throw new Error('Invalid run id');
  /** @type {import('./lib/worktree-cleanup/report.mjs').RunReport} */
  const report = { version: 1, runId: options.runId ?? `${new Date(startedAt).toISOString().replaceAll(':', '-')}-${randomUUID()}`,
    startedAt, finishedAt: startedAt, dryRun: options.dryRun === true, status: 'completed', stage: 'lock',
    worktrees: [], phaseDurations: [], prUrl: null, rescued: 0, ...(operatorRelease.length ? { operatorRelease } : {}) };
  /** @template T @param {string} phase @param {() => T|Promise<T>} run @returns {Promise<T>} */
  const measurePhase = async (phase, run) => {
    const phaseStartedAt = now();
    // Named releases split fetch around inventory; retain one ordered duration.
    let duration = report.phaseDurations.find(entry => entry.phase === phase);
    if (!duration) { duration = { phase, ms: 0 }; report.phaseDurations.push(duration); }
    try { return await run(); }
    finally { duration.ms += now() - phaseStartedAt; }
  };
  const softDeadline = options.softDeadline;
  const treeDeadline = softDeadline - TAIL_RESERVE_MS;
  const stop = (stopReason, message) => Object.assign(new Error(message), { stopReason });
  const guard = () => { if (now() >= softDeadline) throw stop('deadline', 'Soft deadline reached; no new mutations'); };
  const treeGuard = () => { if (now() >= treeDeadline) throw stop('deadline', 'Per-tree deadline reached; tail reserved'); };
  const value = (result, stage) => { if (result?.state !== 'ok') throw stop(result?.stopReason ?? null, `${stage}: ${result?.reason ?? 'unknown result'}`); return result.value; };
  let release, idlePreviewDirectory, linkIndexSnapshot, primaryLinks;
  let reportActivities = [];
  try {
    release = await measurePhase('lock-wait', () => admitRunLock(repositoryPath, root, 'nightly', {
      now, wait: dependencies.waitForLock, waitBudgetMs: options.lockWaitMs, takeLock: api.acquireRunLock,
      identityProbe: dependencies.identityProbe,
    }));
    report.stage = 'executables';
    const { gitPath, ghPath, git } = await measurePhase('executables', () => {
      const gitPath = value(resolveExecutable(options.gitPath ?? 'git'), 'Git unavailable');
      const ghPath = value(resolveExecutable(options.ghPath ?? 'gh'), 'GitHub CLI unavailable');
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
      const git = args => api.runProbe(gitPath, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repositoryPath, ...args], { env, timeout: boundedTimeout(options) });
      return { gitPath, ghPath, git };
    });
    report.stage = 'fetch';
    await measurePhase('fetch', () => {
      guard();
      const common = value(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'Primary repository validation').trim();
      if (normalizePath(common) !== normalizePath(join(repositoryPath, '.git'))) throw new Error('--repo must name the primary checkout');
      if (!report.dryRun && !operatorRelease.length) { guard(); value(git(['fetch', '--no-recurse-submodules', 'origin', 'main']), 'Fetch failed'); }
    });
    report.stage = 'inventory';
    let snapshot = value(await measurePhase('inventory', () => withDeadline(treeDeadline, now, () => api.inventory({ ...options, softDeadline: treeDeadline, repositoryPath, runnerPath, gitPath }))), 'Inventory');
    linkIndexSnapshot = snapshot;
    report.worktrees = snapshot.worktrees.map(tree => ({ path: tree.path, action: 'hold', disposition: 'hold',
      initialDisposition: 'not-evaluated', reasonCode: 'not-classified', reason: 'Not classified', mutations: [] }));
    const registeredPaths = new Set(snapshot.worktrees.map(tree => normalizePath(tree.path)));
    for (const path of operatorRelease) if (!registeredPaths.has(path)) throw new Error(`--release-unresolved-doubt path is not a registered worktree: ${path}`);
    // Journals and reports must never live inside a tree this run may remove.
    if (snapshot.worktrees.some(tree => normalizePath(tree.path) !== normalizePath(repositoryPath) && isWithin(root, tree.path))) {
      throw new Error('Cleanup report root must be outside candidate worktrees');
    }
    report.stage = 'snapshot-eligibility';
    const snapshotOptions = { ...options, reportRoot: root, repositoryPath, gitPath, softDeadline: treeDeadline, deadlineNow: now };
    // Shared by manual and scheduled runs, evaluated once under the run lock.
    const snapshotMutationsEnabled = !report.dryRun && (await measurePhase('snapshot-eligibility', () =>
      withDeadline(treeDeadline, now, () => api.readCommissioning(root, snapshotOptions))))?.state === 'ok';
    report.stage = 'snapshot-reconcile';
    const reconciled = value(await measurePhase('snapshot-reconcile', () => withDeadline(treeDeadline, now, () => api.reconcileSnapshots(snapshot, {
      ...snapshotOptions, snapshotMutationsEnabled,
    }))), 'Snapshot reconciliation');
    const snapshotBindings = new Map(reconciled.worktrees.map(tree => [normalizePath(tree.path), tree]));
    // Retain holds even if a later activity probe or ordinary planner fails.
    for (const bound of reconciled.worktrees) {
      const row = report.worktrees.find(tree => normalizePath(tree.path) === normalizePath(bound.path));
      const held = { path: bound.path, action: 'hold', disposition: 'hold', initialDisposition: 'hold',
        reasonCode: bound.reasonCode, reason: bound.reason, snapshotBound: true, journalPath: bound.journalPath,
        ...snapshotReportFields(bound.snapshotRecord), mutations: [] };
      if (row) Object.assign(row, held); else report.worktrees.push(held);
    }
    if (reconciled.records.length) report.notes = reconciled.records.map(record =>
      `Snapshot journal: ${record.journalPath} (${report.dryRun && record.state === 'removed' ? 'would be removed' : record.reasonCode ?? record.state})`);
    report.stage = 'inventory';
    // Reserve the advisory scan's budget before decisions, retaining its result
    // even when removals later consume the entire per-tree budget.
    const primaryDeadline = Math.min(treeDeadline, now() + PRIMARY_SCAN_MAX_MS);
    try {
      primaryLinks = await measurePhase('primary-scan', () => withDeadline(primaryDeadline, now, () => api.scanPrimaryLinks(snapshot, {
        softDeadline: primaryDeadline, deadlineNow: now, walkTimeout: PRIMARY_SCAN_MAX_MS,
      })));
    } catch (error) { primaryLinks = unknown(`Primary link scan unavailable: ${String(error)}`); }
    // A named-path error must precede even fetch; scheduled runs keep their order.
    if (!report.dryRun && operatorRelease.length) {
      report.stage = 'fetch';
      await measurePhase('fetch', () => { guard(); value(git(['fetch', '--no-recurse-submodules', 'origin', 'main']), 'Fetch failed'); });
      report.stage = 'inventory';
    }
    treeGuard();
    // One fresh lease memo per run, never caller-supplied: rechecks spread these
    // options and keep this Set, but no verdict may outlive the run.
    const activityOptions = { ...options.activityOptions, leaseMemo: new Set(), softDeadline: treeDeadline, deadlineNow: now };
    const activities = await measurePhase('activity', () => withDeadline(treeDeadline, now, () => api.collectActivity(snapshot.worktrees, activityOptions)));
    reportActivities = snapshot.worktrees.map((tree, index) => ({ path: tree.path, activity: activities[index] }));
    treeGuard();
    snapshot = { ...snapshot, worktrees: snapshot.worktrees.map((tree, i) => ({ ...tree, activity: activities[i] })) };
    const idleOptions = { journalPath: join(root, 'idle-journal.jsonl'), now, gitPath, walkTimeout: options.walkTimeout, softDeadline: treeDeadline, deadlineNow: now };
    let previewPath;
    report.stage = 'classify';
    const plan = await measurePhase('classify', async () => {
      guard();
      // U7 requires an observation for today. Classify using a private projection
      // containing this scan. Only a live scheduled run persists observations
      // at the next stage; manual runs retain the projection through cleanup.
      idlePreviewDirectory = mkdtempSync(join(tmpdir(), 'worktree-cleanup-idle-'));
      previewPath = join(idlePreviewDirectory, 'idle.jsonl');
      if (existsSync(idleOptions.journalPath)) {
        const stat = lstatSync(idleOptions.journalPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid idle journal');
        copyFileSync(idleOptions.journalPath, previewPath);
      }
      for (const tree of snapshot.worktrees) { guard(); value(appendIdleObservation(tree.path, tree.activity, { ...idleOptions, journalPath: previewPath }), 'Idle preview'); }
      const ordinary = { ...snapshot, worktrees: snapshot.worktrees.filter(tree => !snapshotBindings.has(normalizePath(tree.path))) };
      const plan = value(await withDeadline(treeDeadline, now, () => api.planWorktrees(ordinary, { gitPath, ghPath, timeout: options.timeout,
        runGh: options.runGh ? (_executable, args, extra) => { guard(); return options.runGh(args, { ...extra, timeout: boundedTimeout(extra) }); } : undefined,
        idleJournalOptions: { ...idleOptions, journalPath: previewPath }, observeLiveness: true,
        ...(operatorRelease.length ? { operatorRelease } : {}) })), 'Classification');
      // Binding wins even over an injected planner's stale ordinary decision.
      plan.worktrees = [...plan.worktrees.filter(tree => !snapshotBindings.has(normalizePath(tree.path))),
        ...reconciled.worktrees.filter(tree => snapshot.worktrees.some(entry => normalizePath(entry.path) === normalizePath(tree.path)))];
      const reasons = { remove: 'Merged work is preserved; remove the worktree and retain its branch',
        'remove-keep-branch': 'Preserve unmerged commits on the kept branch and remove the clean worktree',
        rescue: 'Publish admitted markdown, verify remote bytes, then remove the worktree',
        snapshot: snapshotMutationsEnabled ? 'Publish and verify a scratch snapshot, then remove the worktree and retain its branch' : 'Scratch snapshot eligible; publication is deferred',
        archive: 'Archive and verify idle leftovers locally before removal', hold: 'Safety evidence does not authorize removal' };
      const plannedPaths = new Set();
      for (const tree of plan.worktrees) {
        const key = normalizePath(tree.path);
        if (plannedPaths.has(key) || !snapshot.worktrees.some(entry => normalizePath(entry.path) === key)) throw new Error('Invalid classification worktree set');
        plannedPaths.add(key);
      }
      for (const [index, tree] of plan.worktrees.entries()) {
        if (tree.disposition !== 'snapshot' || tree.snapshotBound) continue;
        const facts = snapshot.worktrees.find(entry => normalizePath(entry.path) === normalizePath(tree.path));
        const checked = await withDeadline(treeDeadline, now, () => api.preflightSnapshot(facts, {
          softDeadline: treeDeadline, deadlineNow: now, walkTimeout: options.walkTimeout,
        }));
        const summary = checked.state === 'ok' ? checked.value : checked.summary;
        const candidate = { gate: checked.state === 'ok' ? 'eligible' : checked.state === 'negative' ? checked.veto : 'unknown',
          ...(summary ? { fileCount: summary.files.length, totalBytes: summary.totalBytes, largest: summary.largest,
            files: summary.files.map(({ path, size, digest }) => ({ path, size, digest })) } : {}),
          paths: checked.paths ?? [] };
        if (checked.state === 'ok') {
          // Publication consumes these buffers; the report receives only the projection.
          plan.worktrees[index] = { ...tree, snapshotPreflight: checked.value, snapshot: candidate };
        } else if (checked.state === 'negative') {
          plan.worktrees[index] = { ...await api.snapshotFallback(facts, { reason: 'leftovers' }, {
            idleJournalOptions: { ...idleOptions, journalPath: previewPath },
          }), snapshotVeto: checked.veto, snapshotPaths: checked.paths, snapshot: candidate };
        } else {
          plan.worktrees[index] = { ...tree, disposition: 'hold', reason: 'unknown', reasonCode: 'unknown',
            snapshotVeto: 'unknown', snapshotPaths: [], snapshot: candidate };
        }
      }
      const unclassified = report.worktrees.filter(tree => !plannedPaths.has(normalizePath(tree.path)));
      report.worktrees = [...plan.worktrees.map(tree => {
        const link = tree.disposition === 'hold' && tree.reason === 'links' && tree.evidence?.state === 'ok'
          ? tree.evidence.value.entries.find(entry => entry.relativePath === 'node_modules' && entry.kind === 'junction' && entry.manualRelease) : undefined;
        const detail = link?.targetIdentity?.state === 'unknown' ? `; ${link.targetIdentity.reason}` : '';
        const linkDetails = tree.disposition === 'hold' && tree.reason === 'links'
          ? [tree.reasonDetail, tree.evidence?.state === 'unknown' ? tree.evidence.reason : null,
            tree.evidence?.value?.forbidden?.filter(path => !link || path !== 'node_modules').length
              ? `Forbidden links: ${tree.evidence.value.forbidden.filter(path => !link || path !== 'node_modules').join(', ')}` : null].filter(Boolean) : [];
        const reason = [link ? `links: ${['node_modules', ...link.targetChain].join(' -> ')}${detail}; ${link.manualRelease}` : tree.reason ?? reasons[tree.disposition], ...linkDetails].join('; ');
        const stale = !tree.snapshotBound && snapshot.knownStaleRegistrations?.find(entry => normalizePath(entry.path) === normalizePath(tree.path));
        const snapshotHold = tree.disposition === 'snapshot' && !snapshotMutationsEnabled;
        return { path: tree.path, branch: tree.branch, action: stale || snapshotHold ? 'hold' : tree.disposition,
          disposition: stale || snapshotHold || tree.disposition === 'hold' ? 'hold' : 'planned', reason: stale ? 'Known-stale registration; prune deferred' : reason,
          initialDisposition: stale ? 'hold' : tree.disposition, reasonCode: stale ? 'known-stale-registration' : snapshotHold ? 'snapshot-eligible' : tree.reasonCode ?? tree.reason ?? tree.disposition,
          wouldBeRemovable: !stale && tree.disposition === 'hold' && tree.reason === 'live' && tree.wouldBeRemovable === true,
          ...(tree.snapshotBound ? { snapshotBound: true, journalPath: tree.journalPath, snapshotState: tree.snapshotRecord?.state,
            ...snapshotReportFields(tree.snapshotRecord) } : {}),
          ...(tree.snapshot || tree.snapshotVeto ? { snapshot: tree.snapshot ?? { gate: tree.snapshotVeto, paths: tree.nameHits ?? [] },
            ...(tree.snapshotVeto ? { snapshotVeto: tree.snapshotVeto, snapshotPaths: tree.snapshotPaths ?? tree.nameHits ?? [] } : {}) } : {}),
          mutations: [], stopReason: null };
      }), ...unclassified];
      treeGuard();
      return plan;
    });
    report.stage = 'idle-observations';
    await measurePhase('idle-observations', () => {
      if (!report.dryRun && options.scheduledNightly === true) {
        for (const tree of snapshot.worktrees) { guard(); value(api.appendIdleObservation(tree.path, tree.activity, idleOptions), 'Idle observation'); }
      }
    });
    if (report.dryRun) { report.stage = 'dry-run-complete'; }
    else {
      report.stage = 'rescue';
      let published;
      await measurePhase('rescue', async () => {
        const rescueJournal = join(root, 'rescue-journal.json');
        if (plan.worktrees.some(tree => tree.disposition === 'rescue') || existsSync(rescueJournal)) {
          guard();
          published = value(await withDeadline(treeDeadline, now, () => api.publishRescues(plan, { journalPath: rescueJournal, gitPath, ghPath,
            remotePath: options.remotePath, runGh: async (args, extra) => { guard(); const bounded = { ...extra, timeout: boundedTimeout(extra) }; return options.runGh ? options.runGh(args, bounded) : api.runProbe(ghPath, args, bounded); },
            timeout: options.timeout, now: new Date(now()).toISOString(),
            runGit: (executable, args, extra) => { treeGuard(); return api.runRescueCommand(executable, args, { ...extra, timeout: boundedTimeout(extra) }); } })), 'Rescue');
          report.prUrl = published.prUrl;
          for (const result of published.worktrees) {
            const row = report.worktrees.find(tree => normalizePath(tree.path) === normalizePath(result.path));
            if (row && result.verified?.state === 'ok') { row.prUrl = published.prUrl; report.rescued++; }
          }
          if (published.worktrees.some(tree => tree.verified?.state !== 'ok') || published.journalState !== 'published_verified' || !published.prUrl) {
            throw stop('rescue-verification-failed', 'Rescue publication or remote readback failed; no removals started');
          }
        }
      });
      // U5 has an internal prune. Defer just that command to our final stage;
      // retain its dry-run validation and all its other probes unchanged.
      const removalProbe = (executable, args, extra) => args.slice(-2).join(' ') === 'worktree prune' ? ok('') : api.runProbe(executable, args, extra);
      const completed = new Set();
      const classified = new Map(snapshot.registrations.map(entry => [normalizePath(entry.path), entry]));
      const membership = new Map(classified), arrived = new Set(), vanished = new Set();
      const observeMembership = delta => {
        if (!delta) return;
        for (const entry of [...delta.added, ...delta.changed]) {
          const key = normalizePath(entry.path);
          membership.set(key, entry);
          if (!classified.has(key)) arrived.add(key);
        }
        for (const entry of delta.vanished) {
          const key = normalizePath(entry.path);
          membership.delete(key); vanished.add(key);
          const row = report.worktrees.find(row => normalizePath(row.path) === key);
          if (row && !completed.has(key) && !row.mutations.length && ['planned', 'pending'].includes(row.disposition))
            Object.assign(row, { disposition: 'hold', reason: 'Classification registration vanished', reasonCode: 'registration-vanished', stopReason: null, wouldBeRemovable: false });
        }
      };
      report.staleRegistrationSkips = [];
      const treeOptions = { ...options, softDeadline: treeDeadline, deadlineNow: now, now, activityOptions,
        onBeforeMutation: treeGuard, onStaleSkip: entry => report.staleRegistrationSkips.push(entry), onRegistrationDelta: observeMembership };
      // Membership evolves; vanished entries and their links remain frozen evidence.
      const baseline = () => ({ ...snapshot, registrationMembership: membership, worktrees: snapshot.worktrees.filter(tree => !completed.has(normalizePath(tree.path))).map(tree => ({ ...tree,
        containment: tree.containment?.state === 'ok' ? ok({ ...tree.containment.value, children: tree.containment.value.children.filter(path => !completed.has(normalizePath(path))) }) : tree.containment })) });
      const currentArchives = [];
      let stopped;
      const candidates = plan.worktrees.filter(tree => REMOVABLE_DISPOSITIONS.includes(tree.disposition) || tree.disposition === 'archive' ||
        (snapshotMutationsEnabled && tree.disposition === 'snapshot'))
        .sort((a, b) => normalizePath(b.path).split('/').length - normalizePath(a.path).split('/').length);
      await measurePhase('remove', async () => {
        for (const tree of candidates) {
          const row = report.worktrees.find(row => normalizePath(row.path) === normalizePath(tree.path));
          if (row.disposition === 'hold' || vanished.has(normalizePath(tree.path)) || arrived.has(normalizePath(tree.path))) continue;
          report.stage = tree.disposition === 'archive' ? 'archive' : 'remove';
          let result;
          try {
            result = await withDeadline(treeDeadline, now, async () => {
              treeGuard();
              if (treeDeadline - now() < REMOVE_MIN_MS) throw stop('deadline', 'Not enough time left to remove safely; tail reserved');
              const child = report.worktrees.find(child => child.disposition === 'hold' && normalizePath(child.path) !== normalizePath(tree.path) && isWithin(child.path, tree.path));
              if (child) return { disposition: 'hold', reason: `child-held: ${child.path}`, reasonCode: 'child-held', mutations: [], stopReason: null };
              let treePlan = { ...plan, worktrees: [tree] }, facts = baseline();
              if (tree.disposition === 'snapshot' && !tree.snapshotBound) {
                const source = facts.worktrees.find(entry => normalizePath(entry.path) === normalizePath(tree.path));
                let published;
                try {
                  published = await api.publishSnapshot(source, ok(tree.snapshotPreflight), {
                    ...snapshotOptions, snapshotMutationsEnabled, now: new Date(now()).toISOString(),
                  });
                } finally { delete tree.snapshotPreflight; }
                if (published?.state !== 'ok' || published.value.state !== 'published_verified') {
                  const veto = published?.veto ?? 'snapshot-unverified';
                  Object.assign(row, { snapshotVeto: veto, snapshot: { ...row.snapshot, gate: veto },
                    journalPath: published?.journalPath, snapshotState: published?.journalState });
                  return { disposition: 'hold', reason: veto, reasonCode: veto, mutations: [], stopReason: null };
                }
                const record = published.value;
                Object.assign(row, { ...snapshotReportFields(record), journalPath: record.journalPath, snapshotState: record.state });
                treePlan = { ...plan, worktrees: [{ ...tree, snapshotRecord: record }] };
              }
              if (tree.disposition === 'archive') {
                const checked = candidateInventory(tree.path, facts, { ...treeOptions, gitPath });
                if (checked.hold) return checked.hold;
                const fresh = value(checked, 'Archive recheck');
                const original = facts.worktrees.find(entry => normalizePath(entry.path) === normalizePath(tree.path));
                const links = fresh.worktrees[0]?.links;
                if (original.links?.state === 'ok' && original.links.value.nodeModulesTarget && links?.state === 'ok' &&
                    links.value.nodeModulesTarget === original.links.value.nodeModulesTarget &&
                    !equal(links.value.nodeModulesTargetEvidence, original.links.value.nodeModulesTargetEvidence)) {
                  throw stop('shared-target-changed', 'Junction target changed before archiving');
                }
                const archived = value(await api.createArchive(tree.path, { ...treeOptions, snapshot: facts, gitPath, archiveRoot: join(root, 'archives'), runId: report.runId }), 'Archive');
                if (archived.reasonCode === 'registration-vanished') return archived;
                currentArchives.push(archived.archivePath);
                Object.assign(row, { archivePath: archived.archivePath, restoreCommand: archived.restoreCommand });
                treeGuard();
                const prepared = value(await api.prepareArchivedTree(archived.archivePath, facts, { ...idleOptions, ...treeOptions,
                  journalPath: options.scheduledNightly === true ? idleOptions.journalPath : previewPath, gitPath, ghPath, prSnapshot: plan.prSnapshot }), 'Archive cleanup');
                row.mutations = prepared.mutations;
                if (prepared.disposition !== 'clean') return prepared;
                treePlan = prepared.plan; facts = prepared.snapshot;
              }
              const outcomes = value(await api.executeRemovals(treePlan, facts, { ...treeOptions, gitPath, runnerPath, published,
                verifySnapshot: record => api.verifySnapshotRecord(record, snapshotOptions),
                onSnapshotProgress: update => api.markSnapshotProgress(join(root, 'snapshots'), update),
                onSnapshotRemoved: async path => {
                  const marked = await api.markSnapshotRemoved(join(root, 'snapshots'), path);
                  if (marked?.state === 'ok') row.snapshotState = 'removed';
                  return marked;
                },
                mutations: row.mutations, runProbe: removalProbe }), 'Removal');
              if (outcomes.worktrees.length !== 1) throw new Error('Incomplete per-tree removal result');
              return outcomes.worktrees[0];
            });
          } catch (error) {
            result = { disposition: now() >= treeDeadline || error.stopReason === 'deadline' ? 'pending' : 'hold',
              reason: error.message, mutations: row.mutations, stopReason: error.stopReason ?? (now() >= treeDeadline ? 'deadline' : null) };
            if (!result.stopReason && snapshot.worktrees.find(entry => normalizePath(entry.path) === normalizePath(tree.path))?.identity?.state === 'ok' &&
                (!lstatSync(tree.path, { throwIfNoEntry: false }) || !lstatSync(join(tree.path, '.git'), { throwIfNoEntry: false }))) result.stopReason = 'half-removed';
          }
          result.stopReason = removalStopReason(result);
          observeMembership(result.registrationDelta);
          if (result.disposition === 'removed-prune-deferred') report.pruneDeferred = true;
          if (result.unknownPruneEntries?.length) report.unknownPruneEntries = [...new Set([...(report.unknownPruneEntries ?? []), ...result.unknownPruneEntries])];
          Object.assign(row, { disposition: result.disposition, reason: result.reason, mutations: result.mutations, stopReason: result.stopReason,
            unknownPruneEntries: result.unknownPruneEntries, recheckDurations: result.recheckDurations,
            wouldBeRemovable: ['removed', 'removed-prune-deferred'].includes(result.disposition),
            reasonCode: result.reasonCode === 'registration-vanished' ? result.reasonCode :
              result.stopReason ?? result.reasonCode ?? (['removed', 'removed-prune-deferred'].includes(result.disposition) ? result.disposition : 'refused-at-removal') });
          if (['removed', 'removed-prune-deferred'].includes(result.disposition)) {
            completed.add(normalizePath(tree.path)); membership.delete(normalizePath(tree.path));
          }
          if (result.stopReason) { stopped = stop(result.stopReason, `${result.stopReason}: ${result.reason}`); break; }
        }
      });
      // A deadline stop still gets a read-only final preview within the tail.
      if (stopped) {
        if (stopped.stopReason === 'deadline') await measurePhase('prune', () => { guard(); report.finalPrunePreview = git(['worktree', 'prune', '--dry-run', '--verbose']); });
        throw stopped;
      }
      report.stage = 'prune';
      report.pruneDeferred ??= false;
      await measurePhase('prune', () => {
        guard();
        const preview = () => {
          const output = git(['worktree', 'prune', '--dry-run', '--verbose']);
          const checked = checkPrunePreview(value(output, 'Prune preview') + (output.stderr ?? ''), snapshot, { includeUnknownEntries: true });
          if (checked.unknownEntries?.length) report.unknownPruneEntries = [...new Set([...(report.unknownPruneEntries ?? []), ...checked.unknownEntries])];
          const deferred = checked.deferred || Boolean(checked.stopReason);
          if (deferred) report.pruneDeferred = true;
          return deferred;
        };
        if (!preview()) { guard(); if (!preview()) value(git(['worktree', 'prune']), 'Prune'); }
        guard(); report.archivePrune = value(api.pruneArchives({ archiveRoot: join(root, 'archives'), now, gitPath, softDeadline, deadlineNow: now, currentRunId: report.runId, currentArchives }), 'Archive retention');
      });
      report.stage = 'complete';
    }
  } catch (error) {
    report.status = 'failed'; report.error = error instanceof Error ? error.message : String(error);
    report.stopReason = error.stopReason ?? (now() >= treeDeadline ? 'deadline' : null);
    for (const row of report.worktrees) if (row.disposition === 'planned') {
      row.disposition = 'pending'; row.reason = `Run stopped at ${report.stage}: ${report.error}`; row.reasonCode = report.stopReason ?? 'run-stopped';
    }
  } finally {
    // Publish the original inventory with the already collected primary scan.
    // Use the run's start as a conservative observation time for a long scan.
    if (linkIndexSnapshot) {
      const indexNotes = [];
      try { await measurePhase('link-index-write', () => api.writeLinkIndex(root, linkIndexSnapshot, { observedAt: startedAt,
        primaryLinks: primaryLinks ?? unknown('Primary link scan not reached'), softDeadline: treeDeadline, deadlineNow: now, onNote: note => indexNotes.push(note) })); }
      catch (error) { indexNotes.push(`Link index write failed: ${String(error)}`); }
      if (indexNotes.length) Object.assign(report, { notes: [...(report.notes ?? []), ...indexNotes] });
    }
    report.finishedAt = now();
    try {
      try {
        if (idlePreviewDirectory) {
          const path = join(idlePreviewDirectory, 'idle.jsonl');
          if (existsSync(path)) unlinkSync(path);
          rmdirSync(idlePreviewDirectory);
        }
      } catch { report.status = 'failed'; report.error ??= 'Could not remove private idle preview'; }
      try { writeRunReport(root, report, reportActivities); api.notifyRun(report); }
      catch (error) {
        report.status = 'failed';
        report.error = [report.error, `Reporting failure: ${error instanceof Error ? error.message : String(error)}`].filter(Boolean).join('; ');
        try { writeFailureReport(root, report); }
        catch { console.error('Worktree cleanup failed to persist its failure report.'); }
      }
    }
    finally { if (release) await release(); }
  }
  return report;
}

/** Supervised commissioning uses the ordinary planner and snapshot remover.
 * Publication is strictly after the locked preview comparison; removal is
 * strictly after the raw-blob round trip and durable commissioning record.
 */
export async function runCommission(options, dependencies = {}) {
  const api = { inventory, collectActivity, planWorktrees, reconcileSnapshots, preflightSnapshot, publishSnapshot, recoverSnapshot,
    verifySnapshotRecord, readResumableSnapshot, markSnapshotRecoveryFailure,
    executeRemovals, markSnapshotProgress, markSnapshotRemoved, writeCommissioningArtifact,
    acquireRunLock, runProbe: probe, ...dependencies };
  const now = options.now ?? Date.now, startedAt = now();
  const root = resolve(options.reportRoot ?? defaultReportRoot());
  const repositoryPath = resolve(options.repositoryPath);
  const softDeadline = startedAt + (options.softTimeoutMs ?? 35 * 60_000);
  const bounds = { ...options, reportRoot: root, repositoryPath, runnerPath: options.runnerPath ?? repositoryPath,
    softDeadline, deadlineNow: now };
  const report = { version: 1, runId: `${new Date(startedAt).toISOString().replaceAll(':', '-')}-${randomUUID()}`,
    startedAt, finishedAt: startedAt, dryRun: options.preview === true, status: 'completed', stage: 'lock', worktrees: [], notes: [] };
  let unlock, recoveryDirectory, plan;
  const value = result => {
    if (result?.state !== 'ok') throw new Error(result?.reason ?? 'Commissioning evidence unavailable');
    return result.value;
  };
  try {
    unlock = await admitRunLock(repositoryPath, root, 'nightly', { now, takeLock: api.acquireRunLock,
      wait: dependencies.waitForLock, waitBudgetMs: options.lockWaitMs, identityProbe: dependencies.identityProbe });
    await withDeadline(softDeadline, now, async () => {
      bounds.gitPath = value(resolveExecutable(options.gitPath ?? 'git'));
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
      const common = value(api.runProbe(bounds.gitPath, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repositoryPath,
        'rev-parse', '--path-format=absolute', '--git-common-dir'], { env, timeout: boundedTimeout(bounds) })).trim();
      if (normalizePath(common) !== normalizePath(join(repositoryPath, '.git'))) throw new Error('--repo must name the primary checkout');
      report.stage = 'preview';
      const snapshot = value(await api.inventory(bounds));
      // Artifact writes must never become dirt inside a removal candidate.
      if (snapshot.worktrees.some(tree => normalizePath(tree.path) !== normalizePath(repositoryPath) && isWithin(root, tree.path))) {
        throw new Error('Commissioning report root must be outside candidate worktrees');
      }
      // Only untouched, verified publications can join fresh admissions.
      // All other unfinished journals remain bound to nightly reconciliation.
      const reconciled = value(await api.reconcileSnapshots(snapshot, { ...bounds, snapshotMutationsEnabled: false, dryRun: true }));
      const snapshotBindings = new Set(reconciled.worktrees.map(tree => normalizePath(tree.path)));
      const resumable = new Map(), resumeDetails = new Map();
      const copySet = files => files.map(({ path, kind, digest }) => ({ path, kind, digest }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const resume = async (binding, facts) => {
        const result = await api.readResumableSnapshot(binding, facts);
        if (result?.state !== 'ok') return { state: 'negative', veto: 'snapshot-unverified',
          reason: result?.reason || 'Snapshot cannot resume commissioning' };
        const verification = await api.verifySnapshotRecord(result.value, bounds);
        if (verification?.state !== 'ok') return { state: 'negative', veto: 'snapshot-unverified',
          reason: verification?.reason || 'Snapshot remote verification failed' };
        const checked = await api.preflightSnapshot(facts, bounds);
        if (checked?.state !== 'ok') return { state: 'negative', veto: 'snapshot-unverified',
          reason: `Snapshot copy-set preflight failed: ${checked?.reason || checked?.veto || 'evidence unavailable'}` };
        if (!equal(copySet(checked.value.files), copySet(result.value.files))) return { state: 'negative',
          veto: 'snapshot-unverified', reason: 'Snapshot copy set no longer matches journal' };
        return result;
      };
      for (const binding of reconciled.worktrees) {
        const facts = snapshot.worktrees.find(tree => normalizePath(tree.path) === normalizePath(binding.path));
        const result = await resume(binding, facts);
        if (result.state === 'ok') resumable.set(normalizePath(binding.path), { binding, facts, record: result.value });
        else resumeDetails.set(normalizePath(binding.path), result.reason);
      }
      const eligible = { ...snapshot, worktrees: snapshot.worktrees.filter(tree => !snapshotBindings.has(normalizePath(tree.path))) };
      const activityOptions = { ...options.activityOptions, leaseMemo: new Set(), softDeadline, deadlineNow: now };
      const activityTrees = snapshot.worktrees.filter(tree => !snapshotBindings.has(normalizePath(tree.path)) || resumable.has(normalizePath(tree.path)));
      const activities = await api.collectActivity(activityTrees, activityOptions);
      // Preserve activity on the full inventory used for removal rechecks.
      for (const [index, tree] of activityTrees.entries()) tree.activity = activities[index];
      plan = value(await api.planWorktrees(eligible, { gitPath: bounds.gitPath, ghPath: options.ghPath, timeout: options.timeout,
        runGh: options.runGh ? (_executable, args, extra) => options.runGh(args, extra) : undefined,
        idleJournalOptions: { journalPath: join(root, 'idle-journal.jsonl'), now, gitPath: bounds.gitPath } }));
      const hasExactMergedHead = head => plan.prSnapshot?.state === 'ok' && plan.prSnapshot.value.some(pr =>
        pr.state === 'MERGED' && pr.baseRefName === 'main' && pr.headRefOid === head);
      for (const [path, { record }] of resumable) {
        if (hasExactMergedHead(record.head)) continue;
        resumable.delete(path);
        resumeDetails.set(path, plan.prSnapshot?.state !== 'ok' ? 'Merged PR evidence unavailable' :
          'Snapshot HEAD is not the exact head of a PR merged into main');
      }
      const excluded = reconciled.worktrees.filter(tree => !resumable.has(normalizePath(tree.path)))
        .map(tree => ({ path: normalizePath(tree.path), reason: 'snapshot-bound', detail: resumeDetails.get(normalizePath(tree.path)) }))
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const candidates = [];
      const date = new Date(now()).toISOString().slice(0, 10);
      const selected = [];
      for (const [path, { facts, record }] of resumable) {
        selected.push({ path: facts.path, head: record.head, branch: record.branch, disposition: 'snapshot',
          snapshotBound: true, resumed: true });
        candidates.push({ path, head: record.head, ref: record.ref, commitSha: record.commitSha, resumed: true,
          files: copySet(record.files) });
      }
      for (const tree of plan.worktrees) {
        const facts = eligible.worktrees.find(entry => normalizePath(entry.path) === normalizePath(tree.path));
        if (tree.disposition !== 'snapshot' || !facts || tree.head !== facts.registration?.value?.head ||
          !hasExactMergedHead(tree.head)) continue;
        const checked = await api.preflightSnapshot(facts, bounds);
        if (checked?.state !== 'ok') continue;
        tree.snapshotPreflight = checked.value;
        selected.push(tree);
        candidates.push({ path: normalizePath(tree.path), head: tree.head, 'ref-stem': `rescue/${basename(tree.path)}-${date}`,
          files: copySet(checked.value.files) });
      }
      candidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      selected.sort((a, b) => normalizePath(a.path) < normalizePath(b.path) ? -1 : 1);
      const canonical = JSON.stringify(candidates);
      const planHash = createHash('sha256').update(canonical).digest('hex');
      const preview = { schema: 'worktree-cleanup-commission-preview/v1', planHash, candidates, excluded };
      report.planHash = planHash;
      report.commissionPreview = preview;
      report.worktrees = [
        ...excluded.map(tree => ({ ...tree, action: 'hold', disposition: 'hold', initialDisposition: 'hold',
          reasonCode: 'snapshot-bound', snapshotBound: true, mutations: [] })),
        ...selected.map(tree => ({ path: tree.path, branch: tree.branch, action: 'snapshot', disposition: 'hold',
          initialDisposition: 'snapshot', reasonCode: tree.resumed ? 'snapshot-resumed' : 'snapshot-eligible',
          reason: tree.resumed ? 'Supervised snapshot retry' : 'Supervised snapshot candidate', resumed: tree.resumed === true, mutations: [] })),
      ];
      if (options.preview) {
        api.writeCommissioningArtifact(root, `commission-preview-${planHash}.json`, preview);
        report.reportPath = writeCommissionPreviewReport(root, { ...preview, candidates: candidates.map(candidate =>
          candidate.resumed ? { ...candidate, 'ref-stem': `Resumed ${candidate.ref} (commit ${candidate.commitSha})` } : candidate) });
        return;
      }
      if (!/^[a-f0-9]{64}$/.test(options.confirm ?? '')) throw new Error('Invalid commissioning hash');
      let saved;
      try { saved = JSON.parse(readRegular(join(root, `commission-preview-${options.confirm}.json`)).bytes.toString('utf8')); }
      catch { throw new Error('Unknown commissioning hash; nothing pushed'); }
      if (options.confirm !== planHash || saved.schema !== preview.schema || saved.planHash !== planHash ||
        JSON.stringify(saved.candidates) !== canonical) throw new Error('Commissioning preview mismatch; nothing pushed');
      report.stage = 'publish';
      const resumeInventory = selected.some(tree => tree.resumed) ? await api.inventory(bounds) : undefined;
      const published = [];
      for (const tree of selected) {
        const facts = eligible.worktrees.find(entry => normalizePath(entry.path) === normalizePath(tree.path));
        let result;
        try {
          if (tree.resumed) {
            const saved = resumable.get(normalizePath(tree.path));
            const facts = resumeInventory?.state === 'ok' ? resumeInventory.value.worktrees.find(entry =>
              normalizePath(entry.path) === normalizePath(tree.path)) : undefined;
            result = resumeInventory?.state !== 'ok' ?
              { state: 'negative', veto: 'snapshot-unverified', reason: resumeInventory?.reason || 'Current snapshot inventory unavailable' } :
              facts ? await resume(saved.binding, facts) :
                { state: 'negative', veto: 'snapshot-unverified', reason: 'Snapshot worktree missing from current inventory' };
          } else {
            result = await api.publishSnapshot(facts, ok(tree.snapshotPreflight), { ...bounds,
              snapshotMutationsEnabled: true, now: `${date}T00:00:00.000Z` });
          }
        } finally { delete tree.snapshotPreflight; }
        const row = report.worktrees.find(row => row.path === tree.path);
        if (result?.state !== 'ok' || result.value.state !== 'published_verified') {
          Object.assign(row, { reason: result?.reason ?? result?.veto ?? 'snapshot-unverified', reasonCode: result?.veto ?? 'snapshot-unverified' });
          continue;
        }
        const record = result.value;
        Object.assign(row, snapshotReportFields(record), { journalPath: record.journalPath, snapshotState: record.state });
        const expected = candidates.find(candidate => candidate.path === normalizePath(tree.path));
        const recordedFiles = copySet(record.files);
        if (record.head !== tree.head || !equal(expected.files, recordedFiles) ||
          (tree.resumed ? record.ref !== expected.ref || record.commitSha !== expected.commitSha :
            (await api.verifySnapshotRecord(record, bounds))?.state !== 'ok')) {
          Object.assign(row, { reason: 'snapshot-unverified', reasonCode: 'snapshot-unverified' }); continue;
        }
        published.push({ ...tree, snapshotRecord: record });
      }
      if (!published.length) throw new Error('No candidate published and verified; no commissioning record written and nothing removed');
      report.stage = 'recover-check';
      const first = published[0].snapshotRecord;
      let recovered, recoveryReason;
      try {
        recoveryDirectory = mkdtempSync(join(tmpdir(), 'worktree-commission-recovery-'));
        recovered = await api.recoverSnapshot({ ...bounds, ref: first.ref, dest: recoveryDirectory });
      }
      catch (error) { recoveryReason = error.message; }
      if (recovered?.state !== 'ok') recoveryReason ||= recovered?.reason || 'Recovery result unavailable';
      else if (recovered.value?.commitSha !== first.commitSha) {
        recoveryReason = `Recovery commit mismatch for snapshot containing ${first.files.map(file => file.path).join(', ')}`;
      } else for (const file of first.files) {
        try {
          if (blobOid(readRegular(join(recoveryDirectory, file.path)).bytes, first.commitSha) !== file.digest) {
            recoveryReason = `Recovery digest mismatch: ${file.path}`;
          }
        } catch { recoveryReason = `Recovery file unreadable: ${file.path}`; }
        if (recoveryReason) break;
      }
      if (recoveryReason) {
        const reason = `Recovery check failed: ${recoveryReason}; refs remain, no commissioning record written and nothing removed`;
        const row = report.worktrees.find(row => normalizePath(row.path) === first.treePath);
        if (row) Object.assign(row, { reason, reasonCode: 'snapshot-recovery-failed' });
        const recorded = await api.markSnapshotRecoveryFailure(join(root, 'snapshots'),
          { treePath: first.treePath, time: new Date(now()).toISOString(), reason });
        throw new Error(reason + (recorded?.state === 'ok' ? '' : '; recovery failure journal update refused'));
      }
      report.stage = 'commissioning-record';
      api.writeCommissioningArtifact(root, 'commissioning.json', { schema: 'worktree-cleanup-commissioning/v1', planHash,
        createdAt: new Date(now()).toISOString(), refs: published.map(({ snapshotRecord: { ref, commitSha } }) => ({ ref, commitSha })) });
      await dependencies.afterCommissioningWrite?.();
      report.stage = 'remove';
      const outcomes = value(await api.executeRemovals({ ...plan, worktrees: published }, snapshot, { ...bounds, now, activityOptions,
        verifySnapshot: record => api.verifySnapshotRecord(record, bounds),
        onSnapshotProgress: update => api.markSnapshotProgress(join(root, 'snapshots'), update),
        onSnapshotRemoved: path => api.markSnapshotRemoved(join(root, 'snapshots'), path), runProbe: api.runProbe }));
      for (const outcome of outcomes.worktrees) {
        const row = report.worktrees.find(row => normalizePath(row.path) === normalizePath(outcome.path));
        Object.assign(row, outcome, { reasonCode: outcome.stopReason ?? outcome.reasonCode ?? outcome.disposition });
        if (['removed', 'removed-prune-deferred'].includes(outcome.disposition)) row.snapshotState = 'removed';
        if (removalStopReason(outcome)) throw new Error(`Commissioned removal stopped: ${outcome.reason}`);
      }
      report.stage = 'complete';
    });
  } catch (error) { report.status = 'failed'; report.error = error.message; }
  finally {
    for (const tree of plan?.worktrees ?? []) delete tree.snapshotPreflight;
    report.finishedAt = now();
    try {
      if (recoveryDirectory && dirname(resolve(recoveryDirectory)) === resolve(tmpdir()) && basename(recoveryDirectory).startsWith('worktree-commission-recovery-')) {
        rmSync(recoveryDirectory, { recursive: true, force: true });
      }
      if (!options.preview) writeRunReport(root, report);
    } catch (error) { report.status = 'failed'; report.error ??= error.message; }
    finally { await unlock?.(); }
  }
  return report;
}

async function snapshotCommand(command, args, dependencies) {
  const options = {}, seen = new Set();
  const names = { '--repo': 'repositoryPath', '--report-root': 'reportRoot', '--git': 'gitPath', '--gh': 'ghPath',
    ...(command === 'commission' ? { '--confirm': 'confirm' } : { '--ref': 'ref', '--dest': 'dest' }) };
  try {
    while (args.length) {
      const flag = args.shift();
      if (seen.has(flag)) throw new Error(`Duplicate ${command} option: ${flag}`);
      seen.add(flag);
      if (command === 'commission' && flag === '--preview') { options.preview = true; continue; }
      const name = names[flag], value = args.shift();
      if (!name || !value || value.startsWith('--')) throw new Error(`Invalid or incomplete ${command} option: ${flag}`);
      options[name] = value;
    }
    if (command === 'commission') {
      if (!options.repositoryPath || Boolean(options.preview) === Boolean(options.confirm)) throw new Error('commission requires --repo PATH and exactly one of --preview or --confirm HASH');
      const report = await (dependencies.runCommission ?? runCommission)(options, dependencies);
      if (options.preview && report.status === 'completed') console.log(report.planHash);
      else console.log(JSON.stringify(report, null, 2));
      return report.status === 'completed' ? 0 : 1;
    }
    if (!options.ref || !options.dest || !isAbsolute(options.dest)) throw new Error('recover requires --ref REF --dest ABSOLUTE_DIR');
    options.reportRoot ??= defaultReportRoot();
    const result = await (dependencies.recoverSnapshot ?? recoverSnapshot)(options);
    console.log(JSON.stringify(result, null, 2));
    return result.state === 'ok' ? 0 : 1;
  } catch (error) { console.error(String(error)); return 1; }
}

async function runCommand(args, dependencies) {
  const options = {}, names = { '--repo': 'repositoryPath', '--runner': 'runnerPath', '--git': 'gitPath', '--gh': 'ghPath',
    '--report-root': 'reportRoot', '--run-id': 'runId', '--timeout-ms': 'timeout', '--walk-timeout-ms': 'walkTimeout', '--soft-timeout-ms': 'softTimeoutMs' };
  const seen = new Set();
  try {
    while (args.length) {
      const flag = args.shift();
      if (flag === '--release-unresolved-doubt') {
        const path = args.shift();
        if (!path || !isAbsolute(path)) throw new Error(`--release-unresolved-doubt requires an absolute path: ${path ?? '(missing)'}`);
        (options.operatorRelease ??= []).push(normalizePath(path));
        continue;
      }
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      seen.add(flag);
      if (flag === '--dry-run') { options.dryRun = true; continue; }
      if (flag === '--scheduled-nightly') { options.scheduledNightly = true; continue; }
      if (flag === '--manual') { options.manual = true; continue; }
      const name = names[flag], value = args.shift();
      if (!name || !value || value.startsWith('--')) throw new Error(`Invalid or incomplete option: ${flag}`);
      if (flag.endsWith('-ms')) {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid timeout: ${flag}`);
        options[name] = Number(value);
      } else options[name] = value;
    }
    if (!options.repositoryPath) throw new Error('Implicit repository selection is not implemented for run; supply --repo PATH naming the primary checkout');
    if (options.scheduledNightly && options.manual) throw new Error('--scheduled-nightly and --manual are mutually exclusive');
    if (!options.dryRun && !options.scheduledNightly && !options.manual) {
      throw new Error('Live run requires --scheduled-nightly or --manual; the installed launcher must be reinstalled from reviewed code before the next nightly run');
    }
    const report = await runCleanup(options, dependencies);
    console.log(JSON.stringify(report, null, 2));
    return report.status === 'completed' ? 0 : 1;
  } catch (error) { console.error(String(error)); return 1; }
}

async function releaseCommand(args, dependencies) {
  const options = { targetPath: args.shift() }, seen = new Set();
  const names = { '--repo': 'repositoryPath', '--runner': 'runnerPath', '--owner-session': 'ownerSession', '--git': 'gitPath', '--gh': 'ghPath',
    '--report-root': 'reportRoot', '--timeout-ms': 'timeout', '--walk-timeout-ms': 'walkTimeout', '--soft-timeout-ms': 'softTimeoutMs' };
  try {
    if (!options.targetPath || options.targetPath.startsWith('--')) throw new Error('release requires exactly one absolute target path');
    while (args.length) {
      const flag = args.shift(), name = names[flag], value = args.shift();
      if (!name || !value || value.startsWith('--') || seen.has(flag)) throw new Error(`Invalid, duplicate or incomplete release option: ${flag}`);
      seen.add(flag);
      if (flag.endsWith('-ms')) {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid release timeout: ${flag}`);
        options[name] = Number(value);
      } else options[name] = value;
    }
    if (!options.repositoryPath) throw new Error('release requires --repo PATH naming the primary checkout');
    const result = await (dependencies.runRelease ?? runRelease)(options, dependencies);
    console.log(JSON.stringify(result));
    return result.exitCode;
  } catch (error) { console.error(String(error)); return 1; }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  dependencies = { inventory, collectActivity, planWorktrees, runProbe: probe, ...dependencies };
  args = [...args];
  const command = args.shift();
  if (command === 'commission' || command === 'recover') return snapshotCommand(command, args, dependencies);
  if (command === 'release') return releaseCommand(args, dependencies);
  if (command === 'restore') {
    if (args.length !== 1 || args[0].startsWith('--')) {
      console.error('Usage: node scripts/worktree-cleanup.mjs restore <archive>'); return 1;
    }
    const result = restoreArchive(args[0]);
    console.log(JSON.stringify(result, null, 2));
    return result.state === 'ok' ? 0 : 1;
  }
  if (command === 'run') {
    return runCommand(args, dependencies);
  }
  if (!['inventory', 'plan', 'rescue-dry-run'].includes(command)) {
    console.error('Usage: node scripts/worktree-cleanup.mjs release ABSOLUTE_PATH --repo PRIMARY [--owner-session ID] [--runner PATH] [--report-root PATH] [--git PATH] [--gh PATH] [--timeout-ms N] [--walk-timeout-ms N] [--soft-timeout-ms N] | run --repo PATH (--scheduled-nightly | --manual | --dry-run) [--dry-run] [--report-root PATH] [--release-unresolved-doubt ABSOLUTE_PATH (repeatable)] | restore ARCHIVE | inventory|plan|rescue-dry-run [--repo PATH] [--runner PATH] [--git PATH] [--gh PATH] [--timeout-ms N] [--walk-timeout-ms N] [--fetch (plan only)] [--remote-path LOCAL_BARE_REPO --journal-path PATH (rescue-dry-run only; PRs simulated)]'); return 1;
  }
  const options = { repositoryPath: process.cwd(), runnerPath: command === 'inventory' ? resolve(dirname(fileURLToPath(import.meta.url)), '..') : undefined };
  const names = { '--repo': 'repositoryPath', '--runner': 'runnerPath', '--git': 'gitPath', '--gh': 'ghPath', '--timeout-ms': 'timeout', '--walk-timeout-ms': 'walkTimeout' };
  if (command === 'rescue-dry-run') Object.assign(names, { '--remote-path': 'remotePath', '--journal-path': 'journalPath' });
  let fetch = false;
  try {
    while (args.length) {
      const flag = args.shift();
      if (flag === '--fetch' && command === 'plan' && !fetch) { fetch = true; continue; }
      const name = names[flag], value = args.shift();
      if (!name || !value) throw new Error(`Invalid or incomplete option: ${flag}`);
      if (name === 'timeout' || name === 'walkTimeout') {
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid timeout: ${flag}`);
        options[name] = Number(value);
      } else options[name] = value;
    }
    // A read-only planner is not U6's dedicated removal runner. An explicit
    // --runner marks that future runner; otherwise only the repo is exempt.
    options.runnerPath ??= options.repositoryPath;
    if (command === 'rescue-dry-run' && !options.remotePath) throw new Error('rescue-dry-run requires --remote-path LOCAL_BARE_REPO');
    let result = dependencies.inventory(options);
    if (result.state === 'ok') {
      const activities = await dependencies.collectActivity(result.value.worktrees);
      result.value.worktrees = result.value.worktrees.map((tree, index) => ({ ...tree, activity: activities[index] }));
      if (command === 'plan' || command === 'rescue-dry-run') {
        const fetchMain = fetch ? (primaryPath) => {
          const executable = resolveExecutable(options.gitPath ?? 'git');
          if (executable.state !== 'ok') return executable;
          const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
          env.GIT_TERMINAL_PROMPT = '0';
          return dependencies.runProbe(executable.value, ['-C', primaryPath, 'fetch', 'origin', 'main'], { timeout: options.timeout, env });
        } : undefined;
        result = await dependencies.planWorktrees(result.value, { ghPath: options.ghPath, gitPath: options.gitPath, timeout: options.timeout, fetchMain,
          ...(command === 'rescue-dry-run' ? { prSnapshot: ok([]) } : {}) });
        if (result.state === 'ok' && command === 'rescue-dry-run') {
          result = await rescueDryRun(result.value, options);
          console.log(JSON.stringify(result, null, 2));
          return result.state === 'ok' && result.value.worktrees.every((tree) => tree.verified.state === 'ok') ? 0 : 1;
        }
        if (result.state === 'ok') {
          const counts = {}, holdReasons = {};
          result.value.worktrees = result.value.worktrees.map(({ files, ...tree }) => {
            counts[tree.disposition] = (counts[tree.disposition] ?? 0) + 1;
            if (tree.disposition === 'hold') holdReasons[tree.reasonCode] = (holdReasons[tree.reasonCode] ?? 0) + 1;
            return { ...tree, ...(files ? { files: files.map(({ bytes, ...file }) => ({ ...file, byteLength: bytes.length })) } : {}) };
          });
          result.value.counts = counts; result.value.holdReasons = holdReasons;
        }
      }
    }
    console.log(JSON.stringify(result, null, 2));
    return result.state === 'ok' ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify(unknown(String(error)))); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main();
