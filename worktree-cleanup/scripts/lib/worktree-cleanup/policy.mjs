import { admitRescue, classifyScratch } from './admission.mjs';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { normalizePath, regularBytes } from './inventory.mjs';
import { assertUnlinkedAncestors } from './safe-path.mjs';
import { negative, ok, probe, resolveExecutable, unknown } from './probe.mjs';
import { idleEvidence } from './idle-journal.mjs';
export { idleEvidence } from './idle-journal.mjs';

export const REMOVABLE_DISPOSITIONS = ['remove', 'remove-keep-branch', 'rescue'];
const OWNER_FOREIGN_SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;

/** Release only named, doubt-only evidence; incomplete or other unknown signals hold.
 * @param {string} path @param {object} activity @param {string[]} operatorRelease
 */
export function releasesUnresolvedDoubt(path, activity, operatorRelease = []) {
  return operatorRelease.some(named => normalizePath(named) === normalizePath(path)) &&
    activity?.liveReasons?.length === 1 && activity.liveReasons[0].code === 'unresolved-command' &&
    activity.liveReasons[0].state === 'unknown' && activity.live?.state === 'unknown' &&
    activity.head?.state === 'ok' && activity.lease?.state === 'negative' &&
    activity.transcript?.state === 'unknown' && activity.transcript.reason === 'Recent transcript unavailable: Unresolved relative command path' &&
    // Folder doubt can mask a literal transcript hit in the deciding rollup.
    activity.transcript.literalMatches === 0 &&
    activity.transcript.observed?.literalMatches === 0 &&
    activity.transcript.observed.state !== 'ok' && activity.fileActivity?.state === 'negative';
}

/** @typedef {{path: string, sessionId?: string, homeDirectory?: string, now?: () => number,
 * readJobManifests?: () => object[]}} OwnerRelease
 */
export function isOwnerTarget(path, ownerRelease) {
  return typeof path === 'string' && typeof ownerRelease?.path === 'string' &&
    ownerRelease.path.length > 0 && normalizePath(ownerRelease.path) === normalizePath(path);
}

// Read only manifest identities. A shared cwd is never dispatcher evidence.
function ownerJobManifests(ownerRelease) {
  const root = join(ownerRelease.homeDirectory ?? homedir(), '.claude', 'codex-jobs');
  if (!assertUnlinkedAncestors(root, { missing: 'allow' })) return [];
  const manifests = [];
  for (const name of readdirSync(root)) {
    const job = join(root, name), stat = lstatSync(job);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Invalid job entry');
    if (!stat.isDirectory()) continue;
    const manifest = JSON.parse(regularBytes(join(job, 'manifest.json')).bytes.toString('utf8'));
    if (!manifest || manifest.id !== name) throw new Error('Invalid job manifest');
    manifests.push(manifest);
  }
  return manifests;
}

/** Null means complete owner liveness evidence; otherwise a stable hold code.
 * The caller still owns the unchanged-HEAD comparison against its registration.
 * @param {object} activity @param {OwnerRelease} ownerRelease @param {string} expectedHead
 */
export function ownerLivenessReason(activity, ownerRelease, expectedHead) {
  if (activity?.head?.state !== 'ok' || !oidPattern.test(activity.head.value ?? '')) return 'head-unknown';
  if (activity.head.value !== expectedHead) return 'head-changed';
  if (activity.lease?.state !== 'negative') return activity.lease?.state === 'ok' ? 'lease' : 'lease-unknown';
  const attributed = activity.transcript?.attributed;
  if (attributed?.complete !== true || !Array.isArray(attributed.mentions) ||
      !Array.isArray(attributed.doubts)) return 'transcript-unreadable';
  try {
    const now = (ownerRelease.now ?? Date.now)();
    if (!Number.isFinite(now)) return 'transcript-unreadable';
    const owner = typeof ownerRelease.sessionId === 'string' && ownerRelease.sessionId.trim() ? ownerRelease.sessionId : null;
    let manifests;
    for (const mention of [...attributed.mentions, ...(attributed.doubts ?? []).map(doubt =>
      doubt && ({ ...doubt, latestMentionMs: doubt.latestRecordMs }))]) {
      if (!mention || !['claude', 'codex'].includes(mention.kind) || !Number.isFinite(mention.latestMentionMs)) return 'transcript-unreadable';
      if (mention.latestMentionMs < now - OWNER_FOREIGN_SESSION_WINDOW_MS) continue;
      if (owner && mention.sessionId === owner) continue;
      if (owner && mention.kind === 'codex' && typeof mention.sessionId === 'string' && mention.sessionId) {
        manifests ??= (ownerRelease.readJobManifests ?? (() => ownerJobManifests(ownerRelease)))();
        if (!Array.isArray(manifests)) return 'transcript-unreadable';
        const matches = manifests.filter(manifest => manifest?.session_id === mention.sessionId);
        if (matches.length && matches.every(manifest => manifest.owner_session === owner)) continue;
      }
      return 'foreign-session-recent';
    }
    return null;
  } catch { return 'transcript-unreadable'; }
}

/** Release only this target, with an explicit negative lease and unchanged HEAD.
 * File activity (including unknown) is deliberately irrelevant on this route.
 * @param {string} path @param {object} activity @param {OwnerRelease} ownerRelease @param {string} expectedHead
 */
export function releasesOwnerLiveness(path, activity, ownerRelease, expectedHead = activity?.head?.value) {
  return isOwnerTarget(path, ownerRelease) && ownerLivenessReason(activity, ownerRelease, expectedHead) === null;
}

function livenessReasonCode(activity, head) {
  if (activity?.head?.state !== 'ok') return 'head-unknown';
  if (activity.head.value !== head) return 'head-changed';
  const reasons = activity.liveReasons ?? [];
  const selected = reasons.find(reason => reason.state === 'unknown') ?? reasons.find(reason => reason.state === 'ok');
  if (selected) return selected.code;
  // Older/injected evidence may have only the original positive rollup.
  const signal = activity.live?.state === 'ok' ? activity.live.value?.reasons?.[0] : null;
  return signal === 'fileActivity' ? 'file-activity' : ['lease', 'transcript'].includes(signal) ? signal : activity.live?.state === 'ok' ? 'live-positive' : 'live-unknown';
}

const PR_LIMIT = 10000;
/** Raw-output specialization of U1's probe; no parser is used at this boundary.
 * @typedef {(executable: string, args: string[], options?: {cwd?: string, timeout?: number, env?: NodeJS.ProcessEnv}) => import('./probe.mjs').ProbeResult<string>} RawProbe
 */
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const gitEnvironment = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' });

function parseSnapshot(text) {
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('Unparseable PR snapshot'); }
  if (!Array.isArray(rows) || rows.length >= PR_LIMIT) throw new Error('Incomplete PR snapshot');
  const numbers = new Set();
  for (const row of rows) {
    if (!row || !Number.isSafeInteger(row.number) || row.number <= 0 || numbers.has(row.number) ||
      typeof row.headRefName !== 'string' || !row.headRefName || !oidPattern.test(row.headRefOid ?? '') ||
      !['OPEN', 'CLOSED', 'MERGED'].includes(row.state) || typeof row.baseRefName !== 'string' || !row.baseRefName) throw new Error('Invalid PR record');
    numbers.add(row.number);
  }
  return rows;
}
/** One snapshot per run, all-state by default. Stubs return probe's raw-output tri-state.
 * @param {string} primaryPath
 * @param {{ghPath?: string, runProbe?: RawProbe, timeout?: number, state?: 'all'|'open'}} options
 */
export function readPrSnapshot(primaryPath, options = {}) {
  try {
    const executable = resolveExecutable(options.ghPath ?? 'gh');
    if (executable.state !== 'ok') return executable;
    const result = (options.runProbe ?? probe)(executable.value,
      ['pr', 'list', '--state', options.state ?? 'all', '--limit', String(PR_LIMIT), '--json', 'number,headRefName,headRefOid,state,baseRefName'],
      { cwd: primaryPath, timeout: options.timeout, env: gitEnvironment() });
    if (result.state !== 'ok') return result.state === 'unknown' ? result : unknown('PR snapshot unavailable');
    return ok(parseSnapshot(result.value), result.stderr, result.exitCode);
  } catch { return unknown('PR snapshot could not be read or parsed'); }
}

/** Successful rev-list output provides both answers; exit code 1 stays unknown.
 * @param {string} primaryPath @param {string} head
 * @param {{gitPath?: string, runProbe?: RawProbe, timeout?: number}} options
 */
export function ancestry(primaryPath, head, options = {}) {
  try {
    if (!oidPattern.test(head)) return unknown('Invalid ancestry HEAD');
    const executable = resolveExecutable(options.gitPath ?? 'git');
    if (executable.state !== 'ok') return executable;
    const result = (options.runProbe ?? probe)(executable.value,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', primaryPath, 'rev-list', '--count', head, '--not', 'origin/main', '--'],
      { timeout: options.timeout, env: gitEnvironment() });
    if (result.state !== 'ok') return result.state === 'unknown' ? result : unknown('Ancestry probe unavailable');
    if (!/^(?:0|[1-9][0-9]*)\r?\n$/.test(result.value)) return unknown('Invalid ancestry count');
    return result.value.trim() === '0' ? ok(true, result.stderr, result.exitCode) : negative(result.stderr, result.exitCode);
  } catch { return unknown('Ancestry probe failed'); }
}

/** Any containing local branch, remote-tracking ref or tag preserves a detached HEAD.
 * @param {string} primaryPath @param {string} head
 * @param {{gitPath?: string, runProbe?: RawProbe, timeout?: number}} options
 */
export function refReachability(primaryPath, head, options = {}) {
  try {
    if (!oidPattern.test(head)) return unknown('Invalid reachability HEAD');
    const executable = resolveExecutable(options.gitPath ?? 'git');
    if (executable.state !== 'ok') return executable;
    const result = (options.runProbe ?? probe)(executable.value,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', primaryPath, 'for-each-ref', '--contains=' + head,
        '--format=%(refname)', 'refs/heads/', 'refs/remotes/', 'refs/tags/'],
      { timeout: options.timeout, env: gitEnvironment() });
    if (result.state !== 'ok') return unknown('Ref reachability unavailable');
    if (result.value === '') return negative();
    if (!/^(?:refs\/(?:heads|remotes|tags)\/[^\s]+\r?\n)+$/.test(result.value)) return unknown('Invalid containing refs');
    return ok(true);
  } catch { return unknown('Ref reachability failed'); }
}

function evidence(result) {
  return result && ['ok', 'negative', 'unknown'].includes(result.state) ? result : unknown('Invalid tri-state evidence');
}
async function invoke(fn, ...args) {
  try { return evidence(await fn(...args)); } catch { return unknown('Evidence provider failed'); }
}
function openPr(snapshot, registration) {
  if (snapshot.state !== 'ok') return unknown('PR snapshot unavailable');
  const name = registration.branch?.replace(/^refs\/heads\//, '');
  // A detached worktree matching an open head is also protected when the
  // snapshot is available; no PR snapshot is required for clean detached trees.
  const found = snapshot.value.filter((pr) => pr.state === 'OPEN' && (name ? pr.headRefName === name : pr.headRefOid === registration.head));
  return found.length ? ok(found.map((pr) => pr.number)) : negative();
}

/**
 * Results are facts for U4/U5/U7, never authorization to skip their rechecks.
 * All predicates use U1 tri-states; unknown evidence always produces a hold.
 * Registered children are classified first, but output stays in inventory order.
 * @param {{primaryPath: string, worktrees: object[]}} inventory
 * @param {{prSnapshot?: object, ghPath?: string, gitPath?: string, timeout?: number,
 * runGh?: RawProbe, runGit?: RawProbe, fetchMain?: (primaryPath: string) => object|Promise<object>,
 * ancestorOfMain?: (head: string, treePath: string) => object|Promise<object>,
 * reachableFromRef?: (head: string, treePath: string) => object|Promise<object>, ownerRelease?: OwnerRelease,
 * idleEvidence?: (treePath: string) => object|Promise<object>, idleJournalOptions?: import('./idle-journal.mjs').IdleOptions,
 * readFile?: (root: string, path: string) => Buffer, observeLiveness?: boolean, operatorRelease?: string[]}} options
 */
export async function planWorktrees(inventory, options = {}) {
  if (!inventory || !Array.isArray(inventory.worktrees) || typeof inventory.primaryPath !== 'string') return unknown('Inventory unavailable');
  const needsMergeProof = !options.ownerRelease || inventory.worktrees.some(tree => !isOwnerTarget(tree.path, options.ownerRelease));
  const freshness = options.fetchMain && needsMergeProof ? await invoke(options.fetchMain, inventory.primaryPath) : ok({ source: 'current-origin/main' });
  let snapshot = options.prSnapshot ?? readPrSnapshot(inventory.primaryPath, { ghPath: options.ghPath, runProbe: options.runGh, timeout: options.timeout });
  // Validate injected snapshots too: test seams must not create a fail-open path.
  try { if (snapshot.state === 'ok') snapshot = ok(parseSnapshot(JSON.stringify(snapshot.value))); else snapshot = evidence(snapshot); }
  catch { snapshot = unknown('Invalid PR snapshot'); }
  const ancestorOfMain = options.ancestorOfMain ?? ((head) => ancestry(inventory.primaryPath, head, { gitPath: options.gitPath, runProbe: options.runGit, timeout: options.timeout }));
  const reachableFromRef = options.reachableFromRef ?? ((head) => refReachability(inventory.primaryPath, head, { gitPath: options.gitPath, runProbe: options.runGit, timeout: options.timeout }));
  const decisions = new Map(), visiting = new Set();
  const trees = new Map();
  for (const tree of inventory.worktrees) {
    if (typeof tree.path !== 'string' || trees.has(normalizePath(tree.path))) return unknown('Missing or duplicate worktree path');
    trees.set(normalizePath(tree.path), tree);
  }
  async function classify(tree, cache = decisions, active = visiting, withoutLiveness = null, allowOwnerRelease = true) {
    const key = normalizePath(tree.path);
    if (cache.has(key)) return cache.get(key);
    if (active.has(key)) return { path: tree.path, disposition: 'hold', reason: 'nesting', reasonCode: 'nesting' };
    active.add(key);
    const registration = tree.registration?.state === 'ok' ? tree.registration.value : null;
    const ownerTarget = allowOwnerRelease && isOwnerTarget(tree.path, options.ownerRelease);
    const base = { path: tree.path, head: registration?.head ?? null, branch: registration?.branch ?? null };
    const hold = (reason, detail = undefined, reasonCode = reason) => ({ ...base, disposition: 'hold', reason, reasonCode, ...(detail ? { evidence: detail } : {}) });
    async function decide() {
      if (tree.exemption?.state !== 'negative') return hold('exempt', tree.exemption);
      if (!registration || tree.identity?.state !== 'ok' || !oidPattern.test(registration.head ?? '') ||
        registration.bare || registration.prunable !== null || registration.locked !== null ||
        (registration.detached ? registration.branch !== null : !/^refs\/heads\/.+/.test(registration.branch ?? ''))) return hold('identity');
      const ownerReleased = ownerTarget && releasesOwnerLiveness(tree.path, tree.activity, options.ownerRelease, registration.head);
      if (ownerTarget && !ownerReleased) return hold('live', tree.activity?.live, ownerLivenessReason(tree.activity, options.ownerRelease, registration.head));
      const live = ownerReleased || key === withoutLiveness || releasesUnresolvedDoubt(tree.path, tree.activity, options.operatorRelease) ? negative() : tree.activity?.live;
      if (live?.state !== 'negative' || tree.activity?.head?.state !== 'ok' || tree.activity.head.value !== registration.head) return hold('live', live, livenessReasonCode(tree.activity, registration.head));
      if (tree.links?.state !== 'ok' || tree.links.value.forbidden.length) return hold('links', tree.links);
      if (tree.links.value.nodeModulesTarget && (tree.links.value.nodeModulesTargetEvidence?.state !== 'ok' ||
          (Object.hasOwn(tree, 'targetBaseline') && tree.targetBaseline?.state !== 'ok'))) return { ...hold('links', tree.links),
        reasonDetail: [tree.links.value.nodeModulesTargetEvidence?.state !== 'ok' ? tree.links.value.nodeModulesTargetEvidence?.reason ?? 'Junction target evidence unavailable' : null,
          Object.hasOwn(tree, 'targetBaseline') && tree.targetBaseline?.state !== 'ok' ? tree.targetBaseline?.reason ?? 'Junction target snapshot unavailable' : null].filter(Boolean).join('; ') };
      if (tree.inboundLinks?.state !== 'negative') return hold('shared', tree.inboundLinks);
      if (tree.containment?.state !== 'ok' || tree.containment.value.unregisteredRepositories.length) return hold('nesting', tree.containment);
      if (ownerTarget && tree.containment.value.children.length) return hold('nesting');
      for (const childPath of tree.containment.value.children) {
        const child = trees.get(normalizePath(childPath));
        if (!child) return hold('nesting');
        // Releasing a child must not grant its non-owner parent new permission.
        // Use a private nightly decision so neither classification cache is polluted.
        const childDecision = allowOwnerRelease && isOwnerTarget(child.path, options.ownerRelease)
          ? await classify(child, new Map(), new Set(), withoutLiveness, false)
          : await classify(child, cache, active, withoutLiveness, allowOwnerRelease);
        if (childDecision.disposition === 'hold') return hold('nesting');
      }
      if (tree.status?.state !== 'ok' || tree.ignored?.state !== 'ok') return hold('unknown');
      const clean = tree.status.value.entries.length === 0;
      if (tree.status.value.clean !== clean) return hold('unknown');
      const dirty = !clean || tree.ignored.value.unexpected.length > 0;
      if (ownerTarget && dirty) return hold('dirty');
      let admitted, scratch;
      if (dirty) {
        scratch = classifyScratch(tree);
        if (scratch.state === 'unknown') return hold('unknown', scratch);
        if (!scratch.value.scratch) {
          admitted = admitRescue(tree, { readFile: options.readFile });
          if (admitted.state === 'unknown') return hold('unknown', admitted);
        }
      }
      const open = openPr(snapshot, registration);
      if (open.state === 'ok') return hold('open-pr', open);
      // Clean detached ancestry is the sole PR-snapshot-independent route.
      if (open.state === 'unknown' && (ownerTarget || !registration.detached || dirty)) return hold('pr-unknown', open);
      if (ownerTarget) {
        if (registration.detached) {
          const reachable = await invoke(reachableFromRef, registration.head, tree.path);
          if (reachable.state !== 'ok') return hold(reachable.state === 'negative' ? 'unmerged-detached' : 'unknown', reachable);
        }
        const disposition = registration.detached ? 'remove' : 'remove-keep-branch';
        return { ...base, disposition, reasonCode: disposition, ownerRelease: { sessionId: options.ownerRelease.sessionId ?? null } };
      }
      if (freshness.state !== 'ok') return hold('unknown', freshness);
      if (scratch?.value.scratch) {
        if (scratch.value.nameHits.length) return { ...await snapshotFallback(tree, { reason: 'leftovers' }, options),
          snapshotVeto: 'secret_material', nameHits: scratch.value.nameHits };
        const merged = await mergeProof(registration, snapshot, dirty, ancestorOfMain, tree.path);
        // R3a keeps every tree lacking affirmative merge proof on the leftovers route.
        if (merged.state !== 'ok') return { ...await snapshotFallback(tree, { reason: 'leftovers' }, options), snapshotVeto: 'snapshot-unmerged' };
        return { ...base, disposition: 'snapshot', reasonCode: 'snapshot' };
      }
      if (admitted?.state === 'negative') return snapshotFallback(tree, admitted, options);
      const merged = await mergeProof(registration, snapshot, dirty, ancestorOfMain, tree.path);
      if (merged.state === 'unknown') return hold('unknown', merged);
      if (merged.state === 'negative' && registration.detached) return hold('unmerged-detached');
      if (admitted?.state === 'ok') return { ...base, disposition: 'rescue', reasonCode: 'rescue', files: admitted.value.files };
      const disposition = merged.state === 'ok' ? 'remove' : 'remove-keep-branch';
      return { ...base, disposition, reasonCode: disposition };
    }
    let decision;
    try { decision = await decide(); } catch { decision = hold('unknown'); }
    active.delete(key); cache.set(key, decision); return decision;
  }
  let worktrees = [];
  for (const tree of inventory.worktrees) worktrees.push(await classify(tree));
  if (options.observeLiveness) {
    const observations = [];
    for (const decision of worktrees) {
      if (decision.disposition !== 'hold' || decision.reason !== 'live') { observations.push(decision); continue; }
      const key = normalizePath(decision.path);
      // Private decisions and the captured PR/freshness evidence keep this
      // observation out of the deciding cache and leave the inventory intact.
      const observed = await classify(trees.get(key), new Map(), new Set(), key);
      observations.push({ ...decision, wouldBeRemovable: ['remove', 'remove-keep-branch'].includes(observed.disposition) });
    }
    worktrees = observations;
  }
  return ok({ primaryPath: inventory.primaryPath, freshness, prSnapshot: snapshot, worktrees });
}

/** Preserve the existing idle leftovers decision for admission and snapshot vetoes.
 * @param {object} tree
 * @param {{reason: string}} admitted
 * @param {{idleEvidence?: (treePath: string) => object|Promise<object>, idleJournalOptions?: import('./idle-journal.mjs').IdleOptions}} options
 */
export async function snapshotFallback(tree, admitted, options = {}) {
  const registration = tree.registration?.state === 'ok' ? tree.registration.value : null;
  const base = { path: tree.path, head: registration?.head ?? null, branch: registration?.branch ?? null };
  const idle = await invoke(options.idleEvidence ?? ((path) => idleEvidence(path, options.idleJournalOptions)), tree.path);
  if (idle.state === 'ok' && tree.links.value.entries.some(link => link.selfLink === true || link.danglingJunction === true)) {
    return { ...base, disposition: 'hold', reason: 'links', reasonCode: 'links', evidence: tree.links };
  }
  return { ...base, disposition: idle.state === 'ok' ? 'archive' : 'hold', reason: admitted.reason, reasonCode: admitted.reason, idleEvidence: idle };
}

async function mergeProof(registration, snapshot, dirty, ancestorOfMain, treePath) {
  // Clean detached HEADs require ancestry. Dirty trees may also use exact-HEAD
  // merged-main proof, including snapshots and rescue; never branch-name proof.
  if ((!registration.detached || dirty) && snapshot.state === 'ok' && snapshot.value.some(pr =>
    pr.state === 'MERGED' && pr.baseRefName === 'main' && pr.headRefOid === registration.head)) return ok(true);
  return invoke(ancestorOfMain, registration.head, treePath);
}
