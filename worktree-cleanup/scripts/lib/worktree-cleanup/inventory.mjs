import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { assertUnlinkedAncestors } from './safe-path.mjs';
import { boundedTimeout, equal, fingerprint, negative, ok, probe, remainingTime, requireEvidence, resolveExecutable, unknown, windowsPowerShellPath } from './probe.mjs';

/** Case and separator normalization is deliberately conservative on every OS. */
export function normalizePath(path) { return resolve(path).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase(); }
export function isWithin(path, parent) {
  const childKey = normalizePath(path), parentKey = normalizePath(parent);
  return childKey === parentKey || childKey.startsWith(parentKey + '/');
}
// Git's porcelain list omits the admin name. Bind it through the admin gitdir
// file, never through status (which can silently report a parent repository).
function registrationKeys(commonDirectory) {
  const root = join(commonDirectory, 'worktrees');
  if (!lstatSync(root, { throwIfNoEntry: false })) return [];
  noLinkedAncestors(root);
  return readdirSync(root).flatMap(name => {
    const adminPath = join(root, name), gitdirPath = join(adminPath, 'gitdir');
    let bytes, gitdirFingerprint;
    try {
      // Links fail closed; vanished entries and regular files have no admin key.
      const adminStat = lstatSync(adminPath);
      requireEvidence(!adminStat.isSymbolicLink(), 'Worktree path has a link or non-directory ancestor');
      if (!adminStat.isDirectory()) return [];
      noLinkedAncestors(adminPath);
      if (lstatSync(gitdirPath).isDirectory()) return [];
      const file = regularBytes(gitdirPath);
      bytes = file.bytes;
      // Content alone repeats when Git reuses the same worktree/admin paths.
      gitdirFingerprint = createHash('sha256').update(JSON.stringify([file.fingerprint, file.sha256])).digest('hex');
    } catch (error) {
      if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) return [];
      throw error;
    }
    let gitdir;
    try { gitdir = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r?\n$/, ''); }
    catch { return []; }
    // Unidentifiable keys cannot match a frozen stale key; prune still refuses them.
    if (!isAbsolute(gitdir) || gitdir.includes('\0') || !/[\\/]\.git$/.test(gitdir)) return [];
    const path = dirname(gitdir);
    return [{ path, adminPath, key: normalizePath(path) + '\0' + normalizePath(adminPath), gitdirFingerprint }];
  });
}

/** Validate each preview entry against BOTH parts of the frozen stale key. */
export function checkPrunePreview(preview, baseline, { includeUnknownEntries = false } = {}) {
  const known = new Set((baseline.knownStaleRegistrations ?? []).map(entry => entry.key));
  const current = registrationKeys(baseline.commonDirectory.value);
  const lines = preview.trim() ? preview.trim().split(/\r?\n/) : [];
  const unknownEntries = lines.filter(line => {
    const match = /^Removing worktrees\/([^/:\\]+): .+$/.exec(line);
    const entry = match && current.find(entry => normalizePath(entry.adminPath) === normalizePath(join(baseline.commonDirectory.value, 'worktrees', match[1])));
    return !entry || !known.has(entry.key);
  });
  if (unknownEntries.length) return { stopReason: 'prune-unknown', deferred: false, ...(includeUnknownEntries ? { unknownEntries } : {}) };
  return { stopReason: null, deferred: lines.length > 0 || current.some(entry => known.has(entry.key)) };
}
function nulRecords(text) {
  requireEvidence(text === '' || text.endsWith('\0'), 'Incomplete NUL-delimited Git evidence');
  return text === '' ? [] : text.slice(0, -1).split('\0');
}
/** @typedef {{path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean, locked: string|null, prunable: string|null}} Registration */
/** @returns {Registration[]} */
export function parseWorktrees(text) {
  const records = nulRecords(text), result = [];
  let fields = new Map();
  for (const record of records) {
    if (record === '') {
      const path = fields.get('worktree'), head = fields.get('HEAD') ?? null, bare = fields.has('bare');
      requireEvidence(typeof path === 'string' && isAbsolute(path), 'Missing absolute worktree path');
      requireEvidence(bare || (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head ?? '') && fields.has('branch') !== fields.has('detached')), 'Invalid worktree HEAD or branch');
      requireEvidence(!fields.has('branch') || /^refs\/heads\/.+/.test(fields.get('branch')), 'Invalid branch ref');
      result.push({ path, head, branch: fields.get('branch') ?? null, detached: fields.has('detached'), bare,
        locked: fields.get('locked') ?? null, prunable: fields.get('prunable') ?? null });
      fields = new Map();
      continue;
    }
    const space = record.indexOf(' '), key = space < 0 ? record : record.slice(0, space), value = space < 0 ? '' : record.slice(space + 1);
    requireEvidence(['worktree', 'HEAD', 'branch', 'detached', 'bare', 'locked', 'prunable'].includes(key) && !fields.has(key), 'Unknown or duplicate worktree field');
    requireEvidence(fields.size !== 0 || key === 'worktree', 'Worktree record must start with its path');
    requireEvidence(!['bare', 'detached'].includes(key) || value === '', 'Invalid worktree flag');
    fields.set(key, value);
  }
  requireEvidence(fields.size === 0 && result.length > 0, 'Missing worktree record terminator');
  requireEvidence(new Set(result.map((entry) => normalizePath(entry.path))).size === result.length, 'Ambiguous duplicate worktree paths');
  return result;
}
function validRelativePath(path) {
  return path.length > 0 && !isAbsolute(path) && !path.split('/').some((part) => part === '..' || part === '.') &&
    (process.platform !== 'win32' || !path.includes('\\'));
}
/** @typedef {{index: string, worktree: string, path: string, originalPath?: string}} StatusEntry */
/** @returns {StatusEntry[]} */
export function parseStatus(text) {
  const records = nulRecords(text), entries = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index], xy = record.slice(0, 2), path = record.slice(3);
    requireEvidence(record[2] === ' ' && validRelativePath(path) &&
      (['??', '!!', 'DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(xy) ||
        (/^[ MTADRC][ MTADRC]$/.test(xy) && xy !== '  ')), 'Malformed Git status record');
    const entry = { index: xy[0], worktree: xy[1], path };
    if (/[RC]/.test(xy)) {
      const originalPath = records[++index];
      requireEvidence(typeof originalPath === 'string' && validRelativePath(originalPath), 'Missing rename/copy source');
      entries.push({ ...entry, originalPath });
    } else entries.push(entry);
  }
  return entries;
}

// rev-parse has no -z mode. Remove exactly one scalar line terminator rather
// than trimming, which could change spaces in directory names.
function scalarPath(text) {
  requireEvidence(text.endsWith('\n'), 'Unterminated rev-parse path');
  const path = text.replace(/\r?\n$/, '');
  requireEvidence(isAbsolute(path) && !path.includes('\0'), 'Invalid rev-parse path');
  return path;
}
function noLinkedAncestors(path) {
  assertUnlinkedAncestors(path, { message: 'Worktree path has a link or non-directory ancestor' });
}
export const allowedDirectories = new Set(['node_modules', '.next', 'coverage', '.turbo', 'test-results', 'playwright-report']);
export const allowedFiles = new Set(['next-env.d.ts', 'tsconfig.tsbuildinfo', '.eslintcache']);
function allowedIgnored(path) {
  const first = path.split('/')[0];
  return allowedFiles.has(path) || (path.includes('/') && allowedDirectories.has(first));
}

/** @typedef {{path: string, outcome: 'link'|'file'|'directory'|'missing'|'error', code: string|null}} LinkHop */
/** @typedef {{path: string, relativePath: string, kind: string, target: string|null, rawTarget?: string, linkType?: string, directoryLink?: boolean, selfLink?: boolean, targetChain: string[], targetIdentity: import('./probe.mjs').ProbeResult<string>, targetHops?: LinkHop[], targetChainCycle?: boolean, targetChainHopLimit?: boolean, danglingJunction?: boolean, manualRelease?: string}} LinkEntry */
/** Fresh scan evidence only: persisted index entries cannot establish admission.
 * @param {LinkEntry|null|undefined} link
 */
export function isDanglingTopLevelNodeModulesJunction(link) {
  return link?.relativePath === 'node_modules' && link.kind === 'junction' &&
    link.targetChainCycle === false && link.targetChainHopLimit === false &&
    Array.isArray(link.targetHops) && link.targetHops.length > 0 &&
    link.targetHops.at(-1).outcome === 'missing' && link.targetHops.slice(0, -1).every(hop => hop.outcome === 'link');
}
/** @param {LinkEntry|null|undefined} link */
export function isAdmissibleTopLevelNodeModulesJunction(link) {
  return (link?.relativePath === 'node_modules' && link.kind === 'junction' &&
    link.targetIdentity?.state === 'ok' && link.targetChain?.length === 1) || isDanglingTopLevelNodeModulesJunction(link);
}
/** Fresh readLink evidence, including its no-linked-target-ancestor proof.
 * @param {string} root
 * @param {LinkEntry|null|undefined} link
 */
export function isBuildSelfLink(root, link) {
  try {
    if (!link?.relativePath.startsWith('.next/') || link.directoryLink !== true ||
        typeof link.linkType !== 'string' || !['Junction', 'SymbolicLink'].includes(link.linkType) || typeof link.rawTarget !== 'string' ||
        link.targetIdentity?.state !== 'ok' || link.targetChainCycle !== false || link.targetChainHopLimit !== false ||
        link.targetChain?.length !== 1 || link.targetHops?.length !== 1 ||
        !['directory', 'file'].includes(link.targetHops[0].outcome)) return false;
    const next = lstatSync(join(root, '.next'));
    if (!next.isDirectory() || next.isSymbolicLink()) return false;
    const source = win32.relative(win32.resolve(root, '.next').toLowerCase(), win32.resolve(link.path).toLowerCase());
    if (!source || win32.isAbsolute(source) || source.split('\\').includes('..')) return false;
    const target = win32.resolve(win32.dirname(link.path), link.rawTarget).toLowerCase();
    const modules = win32.resolve(root, 'node_modules').toLowerCase();
    const inside = win32.relative(modules, target);
    return !win32.isAbsolute(inside) && !inside.split('\\').includes('..') &&
      win32.resolve(link.targetHops[0].path).toLowerCase() === target;
  } catch { return false; }
}
/** @returns {LinkEntry[]|null} null requires a full walk of a lockless directory. */
function packageLockLinks(root, modules) {
  const lockPath = join(modules, '.package-lock.json');
  try {
    // Only a real (non-link) empty directory is link-free; never follow a link to decide.
    const modulesStat = lstatSync(modules);
    if (modulesStat.isDirectory() && !modulesStat.isSymbolicLink() && readdirSync(modules).length === 0) return [];
    let stat;
    try { stat = lstatSync(lockPath); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    requireEvidence(stat.isFile() && !stat.isSymbolicLink(), 'Not a regular lockfile');
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    requireEvidence(isObject(lock) && isObject(lock.packages), 'Missing or invalid packages map');
    /** @type {LinkEntry[]} */
    const links = [];
    for (const [name, entry] of Object.entries(lock.packages)) {
      requireEvidence(isObject(entry) && (entry.link === undefined || typeof entry.link === 'boolean'), 'Invalid package entry');
      if (entry.link !== true) continue;
      requireEvidence(validRelativePath(name) && name.startsWith('node_modules/'), 'Invalid linked package path');
      const path = join(dirname(modules), name);
      links.push({ path, relativePath: relative(root, path).replaceAll('\\', '/'), kind: 'package-lock', target: null, targetChain: [],
        targetIdentity: unknown('Package lock declares a link without verified target identity') });
    }
    return links;
  } catch (error) { throw new Error(`Package lock unavailable (${lockPath}): ${String(error)}`); }
}
function linkTargetIdentity(path, target) {
  const targetChain = [], seen = new Set([normalizePath(path)]);
  /** @type {LinkHop[]} */
  const targetHops = [];
  let targetChainCycle = false, targetChainHopLimit = false;
  /** @type {'ancestors'|'lstat'|'readlink'|'assert'} */
  let op = 'assert';
  try {
    // The source readlink is hop one. Inspect each next entry without following it.
    for (let hops = 1; ; hops++) {
      op = 'assert';
      targetChain.push(target);
      /** @type {LinkHop} */
      const hop = { path: target, outcome: 'error', code: null };
      targetHops.push(hop);
      const key = normalizePath(target);
      targetChainCycle = seen.has(key);
      requireEvidence(!targetChainCycle, 'Link chain cycle');
      seen.add(key);
      op = 'ancestors';
      noLinkedAncestors(dirname(target));
      op = 'lstat';
      const stat = lstatSync(target);
      op = 'assert';
      if (!stat.isSymbolicLink()) {
        const file = stat.isFile();
        requireEvidence(file || stat.isDirectory(), 'Unsupported link target entry');
        hop.outcome = file ? 'file' : 'directory';
        return { targetChain, targetIdentity: ok(target), targetHops, targetChainCycle, targetChainHopLimit };
      }
      hop.outcome = 'link';
      targetChainHopLimit = hops >= 8;
      requireEvidence(!targetChainHopLimit, 'Link chain exceeds 8 hops');
      op = 'readlink';
      target = resolve(dirname(target), readlinkSync(target));
    }
  } catch (error) {
    const reason = String(error), hop = targetHops.at(-1);
    // A capped hop remains a proven link; the flag records why traversal stopped.
    if (hop && (op !== 'assert' || hop.outcome !== 'link')) {
      const errorPath = typeof error?.path === 'string' ? win32.normalize(error.path) : null;
      const missing = (op === 'ancestors' || op === 'lstat') &&
        (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') &&
        errorPath !== null && win32.isAbsolute(errorPath) && !/^\\\\[?.]\\/.test(errorPath) &&
        errorPath !== win32.parse(errorPath).root;
      hop.outcome = missing ? 'missing' : 'error';
      hop.code = error?.code ?? reason;
    }
    return { targetChain, targetIdentity: unknown(`Link target identity unavailable: ${reason}`), targetHops, targetChainCycle, targetChainHopLimit };
  }
}
/**
 * @param {string} root
 * @param {string} path
 * @param {string} [kind]
 * @param {typeof probe | null} [runProbe]
 * @param {number} [timeout]
 * @returns {LinkEntry}
 */
export function readLink(root, path, kind = 'symlink', runProbe = null, timeout) {
  noLinkedAncestors(dirname(path));
  const rawTarget = readlinkSync(path), target = resolve(dirname(path), rawTarget);
  const link = { path, relativePath: relative(root, path).replaceAll('\\', '/'), kind, rawTarget, target, ...linkTargetIdentity(path, target) };
  // Each probe spawns PowerShell. Only admission evidence for the tree being
  // classified or removed needs one; foreign-tree readers pass none.
  if (runProbe && process.platform === 'win32' && (link.relativePath === 'node_modules' || link.relativePath.startsWith('.next/'))) {
    const script = "$ErrorActionPreference = 'Stop'; $entry = Get-Item -LiteralPath $env:WORKTREE_CLEANUP_LINK -Force; [ordered]@{ linkType = $entry.LinkType; directoryLink = [bool]($entry.PSIsContainer -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) } | ConvertTo-Json -Compress";
    const result = runProbe(windowsPowerShellPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      timeout, env: { ...process.env, WORKTREE_CLEANUP_LINK: path }, parse: text => {
        const value = JSON.parse(text);
        requireEvidence(['Junction', 'SymbolicLink'].includes(value.linkType) && typeof value.directoryLink === 'boolean', 'Unrecognized link type');
        return value;
      },
    });
    link.kind = result.state === 'ok' ? result.value.linkType === 'Junction' ? 'junction' : 'symlink' : 'reparse';
    if (result.state === 'ok') Object.assign(link, result.value);
  }
  return link;
}
export function topLevelModulesLink(root, runProbe, timeout) {
  try {
    noLinkedAncestors(root);
    const path = join(root, 'node_modules');
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isSymbolicLink()) return ok(null);
    return ok(readLink(root, path, 'symlink', runProbe, timeout));
  } catch (error) { return unknown(`Top-level node_modules link unavailable: ${String(error)}`); }
}
/**
 * Visit entries without descending through links. Returning false skips a subtree.
 * Excluded names also skip .git files and node_modules links, before inspecting them.
 * @param {string} root
 * @param {{timeout?: number, softDeadline?: number, deadlineNow?: () => number, now?: () => number, skipDirectories?: Set<string>, continueOnError?: boolean, visit: (entry: {path: string, name: string, directory: string, stat: import('node:fs').Stats}) => boolean|void}} options
 */
export function walkDirectory(root, { timeout = 120_000, softDeadline, deadlineNow, now, skipDirectories = new Set(), continueOnError = false, visit }) {
  try {
    const bounds = { softDeadline, deadlineNow: deadlineNow ?? now };
    remainingTime(bounds);
    noLinkedAncestors(root);
    const failures = [];
    const failed = (path, error) => {
      if (!continueOnError) throw error;
      failures.push(`${path}: ${String(error)}`);
    };
    const deadline = Date.now() + timeout;
    const pending = [root];
    while (pending.length) {
      remainingTime(bounds);
      requireEvidence(Date.now() < deadline, 'Filesystem inventory timed out');
      const directory = pending.pop();
      let names;
      try { noLinkedAncestors(directory); names = readdirSync(directory).sort(); }
      catch (error) { failed(directory, error); continue; }
      for (const name of names) {
        remainingTime(bounds);
        requireEvidence(Date.now() < deadline, 'Filesystem inventory timed out');
        if (skipDirectories.has(name.toLowerCase())) continue;
        const path = join(directory, name);
        let stat;
        try { stat = lstatSync(path); }
        catch (error) { failed(path, error); continue; }
        try { if (visit({ path, name, directory, stat }) === false) continue; }
        catch (error) { failed(path, error); }
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) pending.push(path);
        else if (!stat.isFile()) failed(path, new Error('Unsupported filesystem entry'));
      }
    }
    remainingTime(bounds);
    return failures.length ? unknown('Filesystem inventory incomplete: ' + failures.join('; ')) : ok(null);
  } catch (error) { return unknown(`Filesystem inventory unavailable: ${String(error)}`); }
}
// Do not read a rescued file or lockfile through a link, including its ancestors.
export function regularBytes(path) {
  const full = resolve(path);
  assertUnlinkedAncestors(full, { includeLeaf: false, message: 'Linked file ancestor' });
  const before = lstatSync(full);
  requireEvidence(before.isFile() && !before.isSymbolicLink(), 'Not a regular file');
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireEvidence(equal(fingerprint(before), fingerprint(opened)), 'File identity changed before read');
    const bytes = readFileSync(fd);
    requireEvidence(equal(fingerprint(opened), fingerprint(fstatSync(fd))) && equal(fingerprint(opened), fingerprint(lstatSync(full))), 'File changed during read');
    return { bytes, fingerprint: fingerprint(opened), sha256: createHash('sha256').update(bytes).digest('hex') };
  } finally { closeSync(fd); }
}
/** Shared by full snapshots and cheap rechecks. */
function targetLockHash(target) { return regularBytes(resolve(target, '.package-lock.json')).sha256; }
function targetEvidence(target, bounds = {}) {
  remainingTime(bounds);
  noLinkedAncestors(target);
  const topLevelCount = readdirSync(target).length, lockHash = targetLockHash(target);
  remainingTime(bounds);
  return { topLevelCount, lockHash };
}
/** Full walk: used at classification and just before junction unlink. Candidate rechecks use targetEvidence instead. */
export function targetSnapshot(target, timeout, bounds = {}) {
  let count = 0, topLevelCount = 0;
  const walk = walkDirectory(target, { ...bounds, timeout, visit: ({ directory }) => {
    count++;
    if (directory === target) topLevelCount++;
  } });
  requireEvidence(walk.state === 'ok', walk.state === 'unknown' ? walk.reason : 'Junction target scan unavailable');
  const snapshot = { count, topLevelCount, lockHash: targetLockHash(target) };
  remainingTime(bounds);
  return snapshot;
}
/** @param {LinkEntry[]} links Retained by the caller even when this walk fails. */
function walkTree(root, topLink, timeout, links, options, skipRoots = new Set()) {
  const repositories = [];
  const rootKey = normalizePath(root);
  const walk = walkDirectory(root, { ...options, timeout, continueOnError: true, visit: ({ path, name, directory, stat }) => {
    if (stat.isDirectory() && normalizePath(path) !== rootKey && skipRoots.has(normalizePath(path))) return false;
    const topModules = normalizePath(directory) === rootKey && name.toLowerCase() === 'node_modules';
    if (stat.isSymbolicLink()) {
      const top = topModules && topLink.state === 'ok' && topLink.value ? topLink.value : null;
      // topLevelModulesLink already probed the top-level link type; reuse it.
      const link = readLink(root, path, top ? top.kind : 'symlink', top ? null : options.runProbe ?? probe, boundedTimeout(options));
      if (top) for (const key of ['linkType', 'directoryLink']) if (key in top) link[key] = top[key];
      links.push(link);
    } else if (name.toLowerCase() === '.git') {
      if (normalizePath(directory) !== normalizePath(root)) repositories.push(directory);
      return false;
    } else if (stat.isDirectory() && topModules) {
      // An absent lock walks the directory itself. An invalid or unreadable lock
      // throws: walkDirectory records the failure (unknown) and still descends,
      // so a junction inside it remains inbound evidence for its target.
      const lockLinks = packageLockLinks(root, path);
      if (lockLinks === null) return;
      links.push(...lockLinks);
      return false;
    }
  } });
  return walk.state === 'ok' ? ok({ links, repositories }) : walk;
}

/** Nightly traversal rules, optionally excluding independently collected trees.
 * skipRoots contains normalized absolute paths; a link at such a path is still
 * collected, and the root itself is always walked.
 * @param {string} root
 * @param {Parameters<typeof inventory>[0] & {skipRoots?: Set<string>}} options
 */
export function scanTreeLinks(root, { skipRoots = new Set(), ...options } = {}) {
  const runProbe = options.runProbe ?? probe;
  const boundedProbe = (executable, args, extra) => runProbe(executable, args, { ...extra, timeout: boundedTimeout({ ...options, timeout: extra?.timeout }) });
  const topLink = topLevelModulesLink(root, boundedProbe, options.timeout);
  const walk = walkTree(root, topLink, options.walkTimeout ?? 120_000, [], options, skipRoots);
  return walk.state === 'ok' ? ok(walk.value.links) : walk;
}

/** Live shallow scan shared by release classification and candidate rechecks. */
export function scanShallowLinks(root, options = {}) {
  try {
    remainingTime(options);
    noLinkedAncestors(root);
    const links = [];
    for (const name of readdirSync(root)) {
      remainingTime(options);
      const path = join(root, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) links.push(readLink(root, path));
      else requireEvidence(stat.isFile() || stat.isDirectory(), 'Unsupported foreign entry');
    }
    return ok(links);
  } catch (error) { return unknown(`Foreign shallow link scan unavailable: ${String(error)}`); }
}

/** Shared inbound union; callers can inject indexed and live source evidence.
 * @param {string} path
 * @param {import('./probe.mjs').ProbeResult<unknown>} ownLinks
 * @param {Map<string, LinkEntry[]>} discoveredLinks
 */
export function inboundLinksFor(path, ownLinks, discoveredLinks) {
  if (ownLinks.state !== 'ok') return unknown('Inbound map unavailable: ' + (ownLinks.state === 'unknown' ? ownLinks.reason : 'Missing link scan'));
  const knownLinks = [...discoveredLinks].flatMap(([sourceTree, links]) => links.map(link => ({ sourceTree, ...link })));
  const targetsTree = link => link.targetChain.some(target => isWithin(target, path) || isWithin(path, target));
  const sameTree = source => normalizePath(source) === normalizePath(path);
  const inbound = knownLinks.filter(link => !sameTree(link.sourceTree) && targetsTree(link));
  const unresolved = knownLinks.find(link => link.targetIdentity.state !== 'ok' &&
    !(sameTree(link.sourceTree) && link.danglingJunction === true) && (sameTree(link.sourceTree) || targetsTree(link)));
  return unresolved ? unknown('Inbound map unresolved: ' + (unresolved.targetIdentity.state === 'unknown' ? unresolved.targetIdentity.reason : 'negative target identity')) :
    inbound.length ? ok(inbound) : negative();
}

function exemptionFor(path, primary, runner, roadmapDataPaths) {
  const reasons = [], key = normalizePath(path);
  if (key === normalizePath(primary)) reasons.push('primary');
  if (key === normalizePath(runner)) reasons.push('runner');
  if (/(?:^|\/)\.worktrees\/\.roadmap-shadow-scheduled-[^/]+(?:\/|$)/i.test(key)) reasons.push('scheduled-roadmap-collector');
  // Conservative roadmap-named data roots plus any configured data paths.
  if (key.split('/').some((part) => /^\.?roadmap(?:[-_]|$)/i.test(part)) || roadmapDataPaths.some((root) => isWithin(path, root))) reasons.push('roadmap-data');
  return reasons.length ? ok({ reasons }) : negative();
}

/**
 * U1 facts, not U3 removal decisions. U3 must resolve registered child
 * dispositions before releasing containment. Incomplete link scans hold their
 * source tree without making unrelated inbound-link results unknown.
 * @param {{repositoryPath?: string, runnerPath?: string, gitPath?: string, roadmapDataPaths?: string[], timeout?: number, walkTimeout?: number, softDeadline?: number, deadlineNow?: () => number, candidatePath?: string, fullTargetBaseline?: boolean, metadataOnly?: boolean, runProbe?: typeof probe}} options
 */
export function inventory(options = {}) {
  try { return inventoryWithinDeadline(options); }
  catch (error) { return unknown(String(error)); }
}
/** @param {Parameters<typeof inventory>[0]} options */
function inventoryWithinDeadline(options) {
  remainingTime(options);
  const repositoryPath = resolve(options.repositoryPath ?? process.cwd()), runnerPath = resolve(options.runnerPath ?? process.cwd());
  const runProbe = options.runProbe ?? probe, executable = resolveExecutable(options.gitPath ?? 'git');
  if (executable.state !== 'ok') return executable;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_OPTIONAL_LOCKS = '0'; env.GIT_TERMINAL_PROMPT = '0';
  const boundedProbe = (executable, args, extra) => runProbe(executable, args, { ...extra, timeout: boundedTimeout({ ...options, timeout: extra?.timeout }) });
  const git = (cwd, args, parser) => boundedProbe(executable.value, ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env, timeout: options.timeout, parse: parser });
  const listed = git(repositoryPath, ['worktree', 'list', '--porcelain', '-z'], parseWorktrees);
  if (listed.state !== 'ok') return listed;
  const registrations = /** @type {Registration[]} */ (listed.value), primary = registrations[0].path;
  const common = git(primary, ['rev-parse', '--path-format=absolute', '--git-common-dir'], scalarPath);
  const keys = common.state === 'ok' ? registrationKeys(common.value) : [];
  const knownStaleRegistrations = keys.filter(key => registrations.some(entry => normalizePath(entry.path) === normalizePath(key.path) && entry.prunable !== null));
  const discoveredLinks = new Map();
  const targetSnapshots = new Map();
  const worktrees = registrations.filter(entry => !options.candidatePath || normalizePath(entry.path) === normalizePath(options.candidatePath)).map((registration) => {
    remainingTime(options);
    const path = registration.path;
    let identity;
    try {
      requireEvidence(!registration.bare, 'Bare repository has no worktree identity');
      noLinkedAncestors(path);
      const dotGit = lstatSync(join(path, '.git'));
      requireEvidence(!dotGit.isSymbolicLink() && (dotGit.isFile() || dotGit.isDirectory()), 'Missing or linked .git');
      requireEvidence(common.state === 'ok', 'Primary common directory unavailable');
      const top = git(path, ['rev-parse', '--show-toplevel'], scalarPath);
      const ownCommon = git(path, ['rev-parse', '--path-format=absolute', '--git-common-dir'], scalarPath);
      if (top.state !== 'ok') identity = top;
      else if (ownCommon.state !== 'ok') identity = ownCommon;
      else {
        requireEvidence(normalizePath(top.value) === normalizePath(path), 'Git toplevel differs from registered path');
        requireEvidence(normalizePath(ownCommon.value) === normalizePath(common.value), 'Git common directory differs from primary');
        identity = ok({ topLevel: top.value, commonDirectory: ownCommon.value });
      }
    } catch (error) { identity = unknown(`Identity unproven: ${String(error)}`); }
    const statusProbe = identity.state === 'ok' && !options.metadataOnly
      ? git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], parseStatus)
      : unknown('Status skipped: identity unproven');
    const statusEntries = statusProbe.state === 'ok' ? /** @type {StatusEntry[]} */ (statusProbe.value) : [];
    const entries = statusEntries.filter((entry) => entry.index !== '!'), ignored = statusEntries.filter((entry) => entry.index === '!').map((entry) => entry.path);
    const topLink = options.metadataOnly ? ok(null) : topLevelModulesLink(path, boundedProbe, options.timeout);
    /** @type {LinkEntry[]} */
    const collected = [];
    discoveredLinks.set(path, collected);
    const walk = identity.state === 'ok' && !options.metadataOnly ? walkTree(path, topLink, options.walkTimeout ?? 120_000, collected, options) : unknown('Walk skipped: identity unproven or metadata-only');
    if (topLink.state === 'ok' && topLink.value && !collected.some(link => normalizePath(link.path) === normalizePath(topLink.value.path))) collected.push(topLink.value);
    // Only this run's no-follow walk supplies admission evidence, never the index.
    if (walk.state === 'ok') for (const link of walk.value.links) {
      if (isDanglingTopLevelNodeModulesJunction(link)) link.danglingJunction = true;
      if (isBuildSelfLink(path, link)) link.selfLink = true;
    }
    const accepted = walk.state === 'ok' ? walk.value.links.find(isAdmissibleTopLevelNodeModulesJunction) : null;
    const nodeModulesTarget = accepted?.danglingJunction ? null : accepted?.target ?? null;
    if (nodeModulesTarget && !targetSnapshots.has(normalizePath(nodeModulesTarget))) {
      let snapshot;
      try { snapshot = ok(options.candidatePath && !options.fullTargetBaseline ? targetEvidence(nodeModulesTarget, options) : targetSnapshot(nodeModulesTarget, options.walkTimeout, options)); }
      catch (error) { snapshot = unknown(`Junction target snapshot unavailable: ${String(error)}`); }
      targetSnapshots.set(normalizePath(nodeModulesTarget), snapshot);
    }
    for (const link of collected) if (link.relativePath === 'node_modules' && link.kind === 'junction' && !isAdmissibleTopLevelNodeModulesJunction(link)) {
      link.manualRelease = "unlink this tree's node_modules junction";
    }
    const snapshot = nodeModulesTarget ? targetSnapshots.get(normalizePath(nodeModulesTarget)) : null;
    const links = walk.state === 'ok' ? ok({ entries: walk.value.links,
      forbidden: walk.value.links.filter((link) => !isAdmissibleTopLevelNodeModulesJunction(link) && !link.selfLink).map((link) => link.relativePath),
      nodeModulesTarget,
      nodeModulesTargetEvidence: snapshot?.state === 'ok' ? ok({ topLevelCount: snapshot.value.topLevelCount, lockHash: snapshot.value.lockHash }) : snapshot }) : walk;
    const containment = walk.state === 'ok' ? ok({
      parents: registrations.filter((entry) => entry.path !== path && isWithin(path, entry.path)).map((entry) => entry.path),
      children: registrations.filter((entry) => entry.path !== path && isWithin(entry.path, path)).map((entry) => entry.path),
      unregisteredRepositories: walk.value.repositories.filter((nested) => !registrations.some((entry) => normalizePath(entry.path) === normalizePath(nested))),
    }) : walk;
    return { path, registration: ok(registration), identity,
      status: statusProbe.state === 'ok' ? ok({ clean: entries.length === 0, entries }, statusProbe.stderr, statusProbe.exitCode) : statusProbe,
      ignored: statusProbe.state === 'ok' ? ok({ entries: ignored, unexpected: ignored.filter((path) => !allowedIgnored(path)) }, statusProbe.stderr, statusProbe.exitCode) : statusProbe,
      // Keep full classification snapshots outside the link evidence compared by candidate scans.
      ...(options.candidatePath && !options.fullTargetBaseline ? {} : { targetBaseline: snapshot }),
      links, containment, exemption: exemptionFor(path, primary, runnerPath, options.roadmapDataPaths ?? []),
      inboundLinks: negative(), holdReasons: /** @type {string[]} */ ([]),
    };
  });
  // A failed scan still proves the links already discovered. Preserve those
  // inbound holds along with the independently probed top-level junction.
  for (const entry of worktrees) {
    entry.inboundLinks = inboundLinksFor(entry.path, entry.links, discoveredLinks);
    if (entry.exemption.state !== 'negative') entry.holdReasons.push('exempt');
    if (entry.identity.state !== 'ok') entry.holdReasons.push('identity');
    if (entry.status.state !== 'ok') entry.holdReasons.push('status');
    if (entry.ignored.state !== 'ok' || entry.ignored.value.unexpected.length) entry.holdReasons.push('ignored');
    if (entry.links.state !== 'ok' || entry.links.value.forbidden.length) entry.holdReasons.push('links');
    if (entry.containment.state !== 'ok' || entry.containment.value.children.length || entry.containment.value.unregisteredRepositories.length) entry.holdReasons.push('containment');
    if (entry.inboundLinks.state !== 'negative') entry.holdReasons.push('inbound-links');
    if (entry.registration.state === 'ok' && entry.registration.value.locked !== null) entry.holdReasons.push('locked');
  }
  const incompleteScans = worktrees.filter(tree => tree.links.state === 'unknown').map(tree => ({ path: tree.path, reason: tree.links.reason }));
  remainingTime(options);
  return ok({ primaryPath: primary, runnerPath, commonDirectory: common, worktrees, incompleteScans, registrationKeys: keys, knownStaleRegistrations,
    .../** @type {{registrations?: Registration[]}} */ ({ registrations }) });
}

/** Fresh candidate facts plus shallow foreign-link checks. Deep inbound evidence
 * remains pinned to classification; a new deep foreign link is the accepted
 * residual window. Never substitute cached facts for the candidate's own walk.
 * Newly registered trees have no pinned evidence and need a full link walk. */
export function candidateInventory(path, baseline, options = {}, completed = new Set()) {
  let stopReason = null;
  let registrationDelta;
  try {
    const fresh = inventory({ ...options, repositoryPath: baseline.primaryPath, runnerPath: options.runnerPath ?? baseline.runnerPath, candidatePath: path });
    requireEvidence(fresh.state === 'ok', fresh.state === 'unknown' ? fresh.reason : 'Candidate inventory unavailable');
    requireEvidence(equal(fresh.value.commonDirectory, baseline.commonDirectory), 'Repository identity changed');
    // A release inventories only its target, but has classified inbound links
    // from every registration. Pin those registration incarnations so an absent
    // index entry is walked once at classification, not at every recheck.
    const pinned = baseline.scopedInboundBaseline
      ? baseline.registrations.map(registration => ({ path: registration.path, registration: ok(registration) })) : baseline.worktrees;
    const expected = new Map(pinned.filter(tree => !completed.has(normalizePath(tree.path))).map(tree => {
      requireEvidence(tree.registration?.state === 'ok', 'Classification registration unavailable');
      return [normalizePath(tree.path), tree.registration.value];
    }));
    const registeredPaths = new Set(fresh.value.registrations.map(entry => normalizePath(entry.path)));
    const membership = new Map([...(baseline.registrationMembership ?? expected).values()]
      .filter(entry => !completed.has(normalizePath(entry.path))).map(entry => [normalizePath(entry.path), entry]));
    registrationDelta = {
      added: fresh.value.registrations.filter(entry => !membership.has(normalizePath(entry.path))),
      vanished: [...membership.values()].filter(entry => !registeredPaths.has(normalizePath(entry.path))),
      changed: fresh.value.registrations.filter(entry => membership.has(normalizePath(entry.path)) && !equal(entry, membership.get(normalizePath(entry.path)))),
    };
    for (const previous of baseline.worktrees.filter(entry => !completed.has(normalizePath(entry.path)))) {
      if (!registeredPaths.has(normalizePath(previous.path))) continue;
      if (previous.identity?.state === 'ok' && (!lstatSync(previous.path, { throwIfNoEntry: false }) || !lstatSync(join(previous.path, '.git'), { throwIfNoEntry: false }))) {
        stopReason = 'half-removed'; throw new Error('Tree became half-removed: ' + previous.path);
      }
    }
    if (expected.has(normalizePath(path)) && !registeredPaths.has(normalizePath(path))) return {
      ...ok(fresh.value), registrationDelta,
      hold: { disposition: 'hold', reason: 'Classification registration vanished', reasonCode: 'registration-vanished', mutations: [], stopReason: null },
    };
    const tree = fresh.value.worktrees[0], original = baseline.worktrees.find(entry => normalizePath(entry.path) === normalizePath(path));
    requireEvidence(tree && original, 'Worktree no longer registered');
    requireEvidence(equal(tree.registration, original.registration), 'HEAD or registration changed');
    const originalKey = baseline.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(path));
    const candidateKey = fresh.value.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(path));
    requireEvidence(originalKey && candidateKey && normalizePath(candidateKey.adminPath) === normalizePath(originalKey.adminPath) &&
      candidateKey.gitdirFingerprint === originalKey.gitdirFingerprint, 'HEAD or registration changed');
    const registered = new Set(fresh.value.registrations.map(entry => normalizePath(entry.path)));
    requireEvidence(original.containment?.state === 'ok', 'Classification containment unavailable');
    requireEvidence(original.containment.value.children.every(child => completed.has(normalizePath(child)) || registered.has(normalizePath(child))),
      'Classification child no longer registered');
    const inbound = [];
    const skippedStaleRegistrations = [];
    const collectLink = (sourceTree, entry) => {
      // readLink must still succeed. An unresolved chain holds only the trees
      // it could target, using the same containment rule as classification.
      const link = readLink(sourceTree, entry);
      if (link.targetChain.some(target => isWithin(target, path) || isWithin(path, target))) inbound.push({ sourceTree, ...link });
    };
    for (const registration of fresh.value.registrations) {
      remainingTime(options);
      if (normalizePath(registration.path) === normalizePath(path)) continue;
      if (baseline.scopedInboundBaseline && registration.prunable !== null && !lstatSync(registration.path, { throwIfNoEntry: false })) continue;
      const key = fresh.value.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(registration.path));
      if (!baseline.scopedInboundBaseline && registration.prunable !== null && key && baseline.knownStaleRegistrations?.some(entry => entry.key === key.key)) {
        skippedStaleRegistrations.push(key);
        options.onStaleSkip?.(key);
        continue;
      }
      let previous = expected.get(normalizePath(registration.path));
      if (baseline.scopedInboundBaseline && previous && normalizePath(registration.path) !== normalizePath(baseline.primaryPath)) {
        const originalKey = baseline.registrationKeys.find(entry => normalizePath(entry.path) === normalizePath(registration.path));
        if (!key || !originalKey || key.key !== originalKey.key || key.gitdirFingerprint !== originalKey.gitdirFingerprint) previous = undefined;
      }
      if (!previous) {
        // Use the no-follow inventory walker, including real node_modules:
        // no classification-time link evidence exists for this new tree.
        const walk = baseline.scopedInboundBaseline ? scanTreeLinks(registration.path, { ...options, skipRoots: registeredPaths }) : walkDirectory(registration.path, { ...options, timeout: options.walkTimeout ?? 120_000, visit: ({ path: entry, name, stat }) => {
          if (stat.isSymbolicLink()) collectLink(registration.path, entry);
          else if (name.toLowerCase() === '.git') return false;
        } });
        requireEvidence(walk.state === 'ok', walk.state === 'unknown' ? walk.reason : 'New worktree link walk unavailable');
        if (!baseline.scopedInboundBaseline) continue;
        for (const link of walk.value) if (link.targetChain.some(target => isWithin(target, path) || isWithin(path, target))) inbound.push({ sourceTree: registration.path, ...link });
      }
      // Foreign commits, branch changes and locks do not affect this candidate.
      requireEvidence(!previous || (registration.bare === previous.bare && (registration.prunable !== null) === (previous.prunable !== null)),
        'Foreign registration flags changed');
      const shallow = scanShallowLinks(registration.path, options);
      requireEvidence(shallow.state === 'ok', shallow.state === 'unknown' ? shallow.reason : 'Foreign link scan unavailable');
      for (const link of shallow.value) if (link.targetChain.some(target => isWithin(target, path) || isWithin(path, target))) {
        inbound.push({ sourceTree: registration.path, ...link });
      }
    }
    // Deregistration can leave a directory that gains new inbound links after
    // classification. Use frozen registrations so every later recheck inspects
    // surviving directories even after run membership observes their absence.
    // Unavailable evidence holds in both modes.
    const vanishedRegistrations = [...expected.values()].filter(entry => !registeredPaths.has(normalizePath(entry.path)));
    for (const registration of vanishedRegistrations) {
      remainingTime(options);
      if (normalizePath(registration.path) === normalizePath(path)) continue;
      const stat = lstatSync(registration.path, { throwIfNoEntry: false });
      if (!stat) continue;
      requireEvidence(!stat.isSymbolicLink() && stat.isDirectory(), 'Vanished registration directory unavailable');
      const shallow = scanShallowLinks(registration.path, options);
      // A root that disappeared during or just after the scan has no live links.
      if (!lstatSync(registration.path, { throwIfNoEntry: false })) continue;
      requireEvidence(shallow.state === 'ok', shallow.state === 'unknown' ? shallow.reason : 'Vanished registration link scan unavailable');
      for (const link of shallow.value) if (link.targetChain.some(target => isWithin(target, path) || isWithin(path, target))) {
        inbound.push({ sourceTree: registration.path, ...link });
      }
    }
    // Indexed folders that lost their registrations still need live top-level
    // evidence before each owner-release mutation. An unavailable scan holds.
    if (baseline.scopedInboundBaseline) for (const sourceTree of baseline.leftoverPaths ?? []) {
      const shallow = scanShallowLinks(sourceTree, options);
      requireEvidence(shallow.state === 'ok', shallow.state === 'unknown' ? shallow.reason : 'Leftover link scan unavailable');
      for (const link of shallow.value) if (link.targetChain.some(target => isWithin(target, path) || isWithin(path, target))) {
        inbound.push({ sourceTree, ...link });
      }
    }
    // Positive or unknown classification evidence is never released by a
    // shallow scan, including links discovered before a failed deep walk.
    tree.inboundLinks = original.inboundLinks?.state !== 'negative' ? original.inboundLinks ?? unknown('Classification inbound evidence missing') :
      tree.inboundLinks.state !== 'negative' ? tree.inboundLinks : inbound.length ? ok(inbound) : negative();
    remainingTime(options);
    return { ...ok({ ...fresh.value, knownStaleRegistrations: baseline.knownStaleRegistrations ?? [], skippedStaleRegistrations }), registrationDelta };
  } catch (error) { return { ...unknown(`Candidate recheck unavailable: ${String(error)}`), stopReason, registrationDelta }; }
  finally { if (registrationDelta) options.onRegistrationDelta?.(registrationDelta); }
}
