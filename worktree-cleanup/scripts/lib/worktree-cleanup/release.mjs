import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, lstatSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, toNamespacedPath } from 'node:path';
import { inventory, isWithin, normalizePath, parseWorktrees } from './inventory.mjs';
import { collectActivity } from './activity.mjs';
import { buildInboundLinks, MAX_AGE_MS as LINK_INDEX_MAX_AGE_MS, readLinkIndex, staleIndexMessage } from './link-index.mjs';
import { planWorktrees, readPrSnapshot } from './policy.mjs';
import { executeRemovals, REMOVE_MIN_MS } from './remove.mjs';
import { readRegular } from './archive.mjs';
import { acquireRunLock, admitRunLock, defaultReportRoot } from './report.mjs';
import { boundedTimeout, ok, probe, resolveExecutable, unknown, withDeadline } from './probe.mjs';

const HARD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PROBE_MS = 15_000;
const FINISH_RESERVE_MS = 1000;
const sleep = ms => new Promise(accept => setTimeout(accept, ms));
const refused = (reasonCode, reason = reasonCode) => Object.assign(new Error(reason), { reasonCode });

/** One target, one repository lock and a separate audit trail. Dependencies are
 * fixture seams, never CLI bypasses. No fetch, rescue, archive or batch report. */
export async function runRelease(options = {}, dependencies = {}) {
  const api = { inventory, collectActivity, buildInboundLinks, readLinkIndex, planWorktrees, executeRemovals,
    acquireRunLock, runProbe: probe, rename: renameSync, sleep, ...dependencies };
  const now = options.now ?? Date.now, startedAt = now();
  let softDeadline = Infinity;
  const ownerSession = [options.ownerSession, process.env.CLAUDE_CODE_SESSION_ID, process.env.CODEX_THREAD_ID]
    .find(session => typeof session === 'string' && session.trim()) ?? null;
  const row = { target: options.targetPath ?? null, branch: null, head: null, ownerSession,
    startedAt, finishedAt: startedAt, outcome: 'error', reasonCode: 'error', reason: '', pruneDeferred: false, overriddenEvidence: null };
  let root, unlock, recovery, mutations = [], exitCode = 1, removalStarted = false;
  const checkTime = (budget = 0) => {
    if (!Number.isFinite(now()) || softDeadline - now() <= budget + FINISH_RESERVE_MS) throw refused('deadline');
  };
  const value = (result, reasonCode) => {
    checkTime();
    if (result?.state !== 'ok') throw refused(reasonCode, result?.reason ?? reasonCode);
    return result.value;
  };
  try {
    root = resolve(options.reportRoot ?? defaultReportRoot());
    if (typeof options.targetPath !== 'string' || !isAbsolute(options.targetPath)) throw refused('absolute-path-required');
    row.target = resolve(options.targetPath);
    if (isWithin(process.cwd(), row.target)) throw refused('invoked-from-target');
    if (!options.repositoryPath) throw new Error('release requires --repo naming the primary checkout');
    const repositoryPath = resolve(options.repositoryPath);
    const runnerPath = resolve(options.runnerPath ?? join(repositoryPath, '.worktrees', '.worktree-cleanup-runner'));
    if (!ownerSession) throw refused('owner-session-required');
    checkTime();
    try { unlock = await admitRunLock(repositoryPath, root, 'owner-release', {
      now, wait: dependencies.waitForLock, identityProbe: dependencies.identityProbe, takeLock: api.acquireRunLock,
      waitBudgetMs: options.lockWaitMs, target: row.target,
    }); }
    catch (error) {
      if (error.code !== 'RUN_LOCK_OCCUPIED') throw error;
      if (error.holderKind === 'unknown') throw refused('lock-held-unknown', 'Cleanup lock admission wait expired; holder unknown');
      throw refused(error.holderKind === 'nightly' ? 'nightly-running' : 'release-running',
        error.holderKind === 'nightly' ? 'Nightly cleanup is running' : 'Owner release admission wait expired');
    }
    softDeadline = now() + Math.min(options.softTimeoutMs ?? HARD_TIMEOUT_MS, HARD_TIMEOUT_MS);
    await withDeadline(softDeadline, now, async () => {
      checkTime();
      const gitPath = value(resolveExecutable(options.gitPath ?? 'git'), 'git-unavailable');
      const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
        GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
      const bounds = { softDeadline, deadlineNow: now };
      const timeout = options.timeout ?? DEFAULT_PROBE_MS;
      let removalTimeout;
      const runProbe = (executable, args, extra = {}) => {
        checkTime();
        const remove = args.includes('worktree') && args.includes('remove');
        const unlink = args.some(arg => /(?:^|[\\/])remove-worktree-junction\.ps1$/i.test(arg));
        // Freeze the removal timeout after its guard, then require that whole
        // timeout to still fit at the subprocess boundary. Never silently
        // shorten a destructive command as the remaining budget runs down.
        if (remove && !Number.isFinite(removalTimeout)) throw refused('deadline');
        const commandTimeout = remove ? removalTimeout : extra.timeout ?? timeout;
        if (remove || unlink) checkTime(commandTimeout);
        // Git remove already deregisters this target. Never prune other trees.
        if (args.slice(-2).join(' ') === 'worktree prune') return ok('');
        if (remove) removalStarted = true;
        return api.runProbe(executable, args, { ...extra, ...bounds,
          timeout: remove || unlink ? commandTimeout : boundedTimeout({ ...bounds, timeout: commandTimeout }) });
      };
      const git = (args, parse) => runProbe(gitPath, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repositoryPath, ...args], { env, timeout, ...(parse ? { parse } : {}) });
      const common = value(git(['rev-parse', '--path-format=absolute', '--git-common-dir']), 'identity').trim();
      if (normalizePath(common) !== normalizePath(join(repositoryPath, '.git'))) throw refused('primary-required');
      const registrations = value(git(['worktree', 'list', '--porcelain', '-z'], parseWorktrees), 'identity');
      if (normalizePath(registrations[0].path) !== normalizePath(repositoryPath)) throw refused('primary-required');
      if (normalizePath(row.target) === normalizePath(repositoryPath)) throw refused('exempt', 'Primary checkout cannot be released');
      const registration = registrations.find(entry => normalizePath(entry.path) === normalizePath(row.target));
      if (!registration) throw refused('not-registered');
      row.branch = registration.branch; row.head = registration.head;
      const checkSnapshotBinding = () => {
        const treePath = normalizePath(row.target);
        for (const reportRoot of new Set([root, resolve(defaultReportRoot())])) {
          const journalPath = join(reportRoot, 'snapshots', createHash('sha256').update(treePath).digest('hex') + '.json');
          try {
            if (!lstatSync(journalPath, { throwIfNoEntry: false })) continue;
            const record = JSON.parse(readRegular(journalPath).bytes.toString('utf8'));
            if (record?.schema === 'worktree-cleanup-snapshot/v1' && record.treePath === treePath && record.state === 'removed') continue;
          } catch { /* Unreadable journals cannot authorize owner release. */ }
          throw refused('snapshot-bound', 'Target has an unfinished or unreadable snapshot journal');
        }
      };
      checkSnapshotBinding();
      const index = api.readLinkIndex(root, common, { now: now() });
      checkTime();
      if (index?.state !== 'ok') throw refused('link-index-stale', index?.detail ?? staleIndexMessage(null));
      const scanOptions = { ...options, ...bounds, timeout, repositoryPath, runnerPath, gitPath, runProbe,
        candidatePath: row.target, fullTargetBaseline: true };
      const snapshot = value(await api.inventory(scanOptions), 'inventory-unknown');
      if (snapshot.worktrees.length !== 1 || normalizePath(snapshot.worktrees[0].path) !== normalizePath(row.target) ||
          snapshot.commonDirectory?.state !== 'ok' || normalizePath(snapshot.commonDirectory.value) !== normalizePath(common)) throw refused('identity');
      const tree = snapshot.worktrees[0];
      if (tree.registration?.value?.head !== row.head || tree.registration?.value?.branch !== row.branch) throw refused('head-changed');
      const inbound = api.buildInboundLinks(row.target, snapshot, index, { ...scanOptions, now: now() });
      checkTime();
      tree.inboundLinks = inbound.inboundLinks;
      if (tree.inboundLinks.state === 'unknown' && tree.inboundLinks.reason === 'link-index-stale') {
        // The index can expire while inventory runs; report its age at this re-check.
        const ageMs = now() - index.value.observedAt;
        throw refused('link-index-stale', staleIndexMessage(ageMs > LINK_INDEX_MAX_AGE_MS ? ageMs : null));
      }
      if (tree.inboundLinks.state === 'unknown') throw refused('links-unknown', tree.inboundLinks.reason);
      // Pin the indexed/live union and its registration incarnations. Rechecks
      // shallow-scan these trees and deep-walk only new/re-created registrations.
      snapshot.scopedInboundBaseline = true;
      snapshot.leftoverPaths = inbound.leftoverPaths;
      // One fresh lease memo per release, never caller-supplied: rechecks spread
      // these options and keep this Set, but no verdict may outlive the release.
      const activityOptions = { ...options.activityOptions, leaseMemo: new Set(), ...bounds, now };
      const activities = await api.collectActivity([tree], activityOptions);
      checkTime(); tree.activity = activities[0];
      row.overriddenEvidence = { authorized: false, fileActivity: tree.activity?.fileActivity?.state ?? 'unknown',
        transcript: tree.activity?.transcript?.state ?? 'unknown', mentions: tree.activity?.transcript?.attributed?.mentions ?? [],
        doubts: tree.activity?.transcript?.attributed?.doubts ?? [] };
      const ownerRelease = { path: row.target, sessionId: ownerSession, homeDirectory: activityOptions.homeDirectory, now };
      // Reuse the existing parser (including its saturation check) while making
      // this coordinator's transport request the complete OPEN set only.
      const prs = () => {
        checkTime();
        return readPrSnapshot(repositoryPath, { state: 'open', ghPath: options.ghPath, timeout: boundedTimeout({ ...bounds, timeout }),
          runProbe: (executable, args, extra) => {
            return options.runGh ? options.runGh(args, { ...extra, ...bounds }) : runProbe(executable, args, extra);
          } });
      };
      const plan = value(await api.planWorktrees(snapshot, { gitPath, ghPath: options.ghPath, timeout, runGit: runProbe,
        ownerRelease, prSnapshot: prs() }), 'classification-unknown');
      if (plan.worktrees.length !== 1 || normalizePath(plan.worktrees[0].path) !== normalizePath(row.target)) throw new Error('Invalid release plan');
      const decision = plan.worktrees[0];
      if (!['remove', 'remove-keep-branch'].includes(decision.disposition)) {
        throw refused(decision.reasonCode ?? 'not-removable', [decision.reason, decision.reasonDetail,
          decision.evidence ? JSON.stringify(decision.evidence) : null].filter(Boolean).join('; '));
      }
      row.overriddenEvidence.authorized = true;
      const beforeMutationGuard = async event => {
        try {
          checkSnapshotBinding();
          const mutationBudget = REMOVE_MIN_MS + FINISH_RESERVE_MS + (event.kind === 'unlink-junction' ? timeout : 0);
          checkTime(mutationBudget);
          const fresh = value(prs(), 'pr-unknown');
          const branch = row.branch?.replace(/^refs\/heads\//, '');
          if (fresh.some(pr => pr.state === 'OPEN' && (branch ? pr.headRefName === branch : pr.headRefOid === row.head))) throw refused('open-pr');
          checkTime(mutationBudget);
          const moved = join(dirname(row.target), `.${basename(row.target)}.release-${randomUUID()}`);
          try { api.rename(toNamespacedPath(row.target), toNamespacedPath(moved)); }
          catch { throw refused('in-use', 'Target directory could not be renamed; it may be in use'); }
          let restored = false;
          for (const delay of [0, 25, 50, 100]) {
            if (delay) await api.sleep(delay);
            try { api.rename(toNamespacedPath(moved), toNamespacedPath(row.target)); restored = true; break; }
            catch { /* Always try to restore, even if the deadline just elapsed. */ }
          }
          if (!restored) {
            const quote = path => "'" + path.replaceAll("'", "''") + "'";
            recovery = `Restore directory ${quote(moved)} to ${quote(row.target)}, then run: git -C ${quote(repositoryPath)} worktree repair ${quote(row.target)}`;
            throw refused('restore-failed', recovery);
          }
          const head = value(runProbe(gitPath, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', row.target,
            'rev-parse', 'HEAD'], { env, timeout }), 'head-unknown').trim();
          if (head !== row.head) throw refused('head-changed');
          checkTime(mutationBudget);
          if (event.kind === 'remove') removalTimeout = softDeadline - now() - 2 * FINISH_RESERVE_MS;
          return ok(true);
        } catch (error) { return { ...unknown(error.message), reasonCode: error.reasonCode ?? 'mutation-guard' }; }
      };
      checkSnapshotBinding();
      const removed = await api.executeRemovals(plan, snapshot, { ...options, ...bounds, now, timeout, gitPath, runnerPath,
        activityOptions, ownerRelease, runProbe, beforeMutationGuard });
      // Record the remover's actual outcome before consulting the clock again:
      // a deadline at return must not erase evidence of completed mutations.
      if (removed?.state !== 'ok') throw new Error(removed?.reason ?? 'Removal outcome unavailable');
      const outcomes = removed.value;
      if (outcomes.worktrees.length !== 1) throw new Error('Invalid release removal result');
      const result = outcomes.worktrees[0];
      row.pruneDeferred = result.disposition === 'removed-prune-deferred';
      mutations = (result.mutations ?? []).filter(event => event.kind !== 'remove-started' || removalStarted);
      if (['removed', 'removed-prune-deferred'].includes(result.disposition)) {
        row.outcome = 'removed'; row.reasonCode = 'removed'; row.reason = result.reason; exitCode = 0;
      } else {
        const code = softDeadline - now() <= FINISH_RESERVE_MS ? 'deadline' : result.reasonCode ?? result.stopReason ?? 'refused-at-removal';
        if (mutations.some(event => ['remove-started', 'deregister'].includes(event.kind))) throw new Error(`${code}: ${result.reason}`);
        throw refused(code, result.reason);
      }
    });
  } catch (error) {
    const reasonCode = error.reasonCode ?? (now() >= softDeadline || error.stopReason === 'deadline' ? 'deadline' : null);
    row.outcome = reasonCode ? 'refused' : 'error'; row.reasonCode = reasonCode ?? 'error'; row.reason = error.message ?? String(error);
    exitCode = reasonCode ? 3 : 1;
  } finally {
    row.finishedAt = now();
    try {
      if (!root) throw new Error('Release journal root unavailable');
      mkdirSync(root, { recursive: true });
      appendFileSync(join(root, 'owner-release-journal.jsonl'), JSON.stringify({ ...row, mutations, ...(recovery ? { recovery } : {}) }) + '\n', 'utf8');
    } catch (error) { row.outcome = 'error'; row.reasonCode = 'journal-error'; row.reason = String(error); exitCode = 1; }
    finally {
      try { if (unlock) await unlock(); }
      catch (error) { row.outcome = 'error'; row.reasonCode = 'lock-release-error'; row.reason = String(error); exitCode = 1; }
    }
  }
  return { ...row, exitCode, mutations, ...(recovery ? { recovery } : {}) };
}
