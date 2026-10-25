import { createHash, randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { inboundLinksFor, normalizePath, scanShallowLinks, scanTreeLinks } from './inventory.mjs';
import { boundedTimeout, ok, remainingTime, requireEvidence, unknown } from './probe.mjs';

/** @typedef {import('./inventory.mjs').LinkEntry} LinkEntry
 * @typedef {Extract<ReturnType<typeof import('./inventory.mjs').inventory>, {state: 'ok'}>['value']} InventorySnapshot
 * @typedef {{path: string, complete: boolean, links?: LinkEntry[]}} LinkEvidence
 * @typedef {LinkEvidence & ({adminPath: string, gitdirFingerprint: string} | {kind: 'primary'})} IndexEntry
 * @typedef {{version: 1, repositoryIdentity: string, observedAt: number, entries: Record<string, IndexEntry>}} LinkIndex
 */
// One missed nightly (24 h cadence) must not block owner release; two must.
export const MAX_AGE_MS = 60 * 60 * 60_000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const absolute = value => typeof value === 'string' && !value.includes('\0') && isAbsolute(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const incarnation = entry => `${normalizePath(entry.path)}\0${normalizePath(entry.adminPath)}\0${entry.gitdirFingerprint}`;
const primaryKey = (path, repositoryIdentity) => `${normalizePath(path)}\0primary\0${repositoryIdentity}`;
/** Resolve a normalized (lowercase) absolute path to its on-disk casing, one component
 * at a time. Returns null when any component is absent; throws when a case-sensitive
 * directory holds two names that differ only by case (ambiguous, so the caller holds).
 * @param {string} normalized
 */
export function existingCasePath(normalized) {
  const drive = /^([a-z]):\//.exec(normalized);
  requireEvidence(drive || (process.platform !== 'win32' && normalized.startsWith('/')), `Unrecognized indexed path ${normalized}`);
  let current = drive ? `${drive[1].toUpperCase()}:/` : '/';
  for (const part of normalized.slice(drive ? 3 : 1).split('/').filter(Boolean)) {
    let names;
    try { names = readdirSync(current); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
    const matches = names.filter(name => name.toLowerCase() === part);
    if (!matches.length) return null;
    requireEvidence(matches.length === 1, `Ambiguous case-variant path under ${current}`);
    current = join(current, matches[0]);
  }
  return current;
}
const rawPathIfPresent = path => {
  try { lstatSync(path); return path; }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
};
const registeredRoots = snapshot => new Set((snapshot.registrations ?? snapshot.worktrees).map(entry => normalizePath(entry.path)));

/** @param {InventorySnapshot} snapshot */
export function scanPrimaryLinks(snapshot, options = {}) {
  try {
    const skipRoots = registeredRoots(snapshot);
    skipRoots.delete(normalizePath(snapshot.primaryPath));
    return scanTreeLinks(snapshot.primaryPath, { ...options, skipRoots, walkTimeout: options.walkTimeout ?? 120_000 });
  } catch (error) { return unknown(`Primary link scan unavailable: ${String(error)}`); }
}

function validLink(link, source) {
  if (!object(link) || !absolute(link.path) || typeof link.relativePath !== 'string' || !link.relativePath ||
      isAbsolute(link.relativePath) || link.relativePath.includes('\\') || link.relativePath.includes('\0') ||
      link.relativePath.split('/').some(part => !part || part === '.' || part === '..') ||
      normalizePath(join(source, link.relativePath)) !== normalizePath(link.path) ||
      !['symlink', 'junction', 'reparse', 'package-lock'].includes(link.kind) ||
      !(link.target === null || absolute(link.target)) || !Array.isArray(link.targetChain) || !link.targetChain.every(absolute)) return false;
  const identity = link.targetIdentity;
  if (!object(identity)) return false;
  if (identity.state === 'ok') {
    if (!absolute(identity.value) || !link.targetChain.length || normalizePath(identity.value) !== normalizePath(link.targetChain.at(-1))) return false;
  } else if (identity.state !== 'unknown' || typeof identity.reason !== 'string') return false;
  return link.target === null ? link.kind === 'package-lock' && link.targetChain.length === 0 && identity.state === 'unknown' :
    link.targetChain.length > 0 && normalizePath(link.target) === normalizePath(link.targetChain[0]);
}

function validateIndex(index, commonDirectory, now) {
  requireEvidence(absolute(commonDirectory) && object(index) && index.version === 1 &&
    index.repositoryIdentity === normalizePath(commonDirectory) && Number.isFinite(now) &&
    Number.isFinite(index.observedAt) && index.observedAt >= 0 && index.observedAt <= now &&
    now - index.observedAt <= MAX_AGE_MS && object(index.entries), 'Invalid or stale link index');
  const paths = new Set();
  // Older indexes have no primary entry and use the live-walk fallback. New
  // projections always include exactly one; multiple primary entries are invalid.
  let primarySeen = false;
  for (const [key, entry] of Object.entries(index.entries)) {
    requireEvidence(object(entry) && absolute(entry.path) && entry.path === normalizePath(entry.path) && !paths.has(entry.path) &&
      typeof entry.complete === 'boolean', 'Invalid index incarnation');
    if (entry.kind === 'primary') {
      requireEvidence(!primarySeen && key === primaryKey(entry.path, index.repositoryIdentity) &&
        !Object.hasOwn(entry, 'adminPath') && !Object.hasOwn(entry, 'gitdirFingerprint'), 'Invalid primary index entry');
      primarySeen = true;
    } else {
      requireEvidence(entry.kind === undefined && absolute(entry.adminPath) && entry.adminPath === normalizePath(entry.adminPath) &&
        digest(entry.gitdirFingerprint) && key === incarnation(entry), 'Invalid index incarnation');
    }
    paths.add(entry.path);
    requireEvidence(entry.complete ? Array.isArray(entry.links) && entry.links.every(link => validLink(link, entry.path)) :
      !Object.hasOwn(entry, 'links'), 'Invalid index link evidence');
  }
  return /** @type {LinkIndex} */ (index);
}

/** Project linked registrations and a separate primary scan that excludes them.
 * Incomplete walks never contribute reusable partial links. The writer supplies
 * its primary scan so it can also report failures without altering the snapshot.
 * HEAD is not an incarnation discriminator.
 * @param {InventorySnapshot} snapshot
 */
export function projectLinkIndex(snapshot, observedAt = Date.now(), primaryLinks = scanPrimaryLinks(snapshot)) {
  requireEvidence(snapshot.commonDirectory?.state === 'ok', 'Repository identity unavailable');
  const repositoryIdentity = normalizePath(snapshot.commonDirectory.value);
  const keys = new Map(snapshot.registrationKeys.map(entry => [normalizePath(entry.path), entry]));
  /** @type {Record<string, IndexEntry>} */
  const entries = {};
  entries[primaryKey(snapshot.primaryPath, repositoryIdentity)] = { path: normalizePath(snapshot.primaryPath), kind: 'primary',
    complete: primaryLinks.state === 'ok', ...(primaryLinks.state === 'ok' ? { links: primaryLinks.value } : {}) };
  for (const tree of snapshot.worktrees) {
    const key = keys.get(normalizePath(tree.path));
    if (!key) continue;
    const complete = tree.links.state === 'ok';
    entries[incarnation(key)] = { path: normalizePath(key.path), adminPath: normalizePath(key.adminPath),
      gitdirFingerprint: key.gitdirFingerprint, complete,
      ...(complete ? { links: tree.links.value.entries } : {}) };
  }
  return validateIndex({ version: 1, repositoryIdentity, observedAt, entries }, repositoryIdentity, observedAt);
}

/** @param {string} root @param {string} commonDirectory */
export function linkIndexPath(root, commonDirectory) {
  requireEvidence(absolute(commonDirectory), 'Repository identity unavailable');
  const repositoryKey = createHash('sha256').update(normalizePath(commonDirectory)).digest('hex');
  return join(root, `link-index-${repositoryKey}.json`);
}

/** Publish only complete JSON; a failed replacement leaves the prior index intact.
 * @param {string} root @param {InventorySnapshot} snapshot
 * @param {{observedAt?: number, onNote?: (note: string) => void, softDeadline?: number, deadlineNow?: () => number, primaryLinks?: import('./probe.mjs').ProbeResult<LinkEntry[]>}} options
 */
export function writeLinkIndex(root, snapshot, { observedAt = Date.now(), onNote, softDeadline, deadlineNow,
  primaryLinks = scanPrimaryLinks(snapshot, { softDeadline, deadlineNow }) } = {}) {
  const index = projectLinkIndex(snapshot, observedAt, primaryLinks);
  if (primaryLinks.state !== 'ok') onNote?.(`Link index primary scan failed: ${primaryLinks.reason}`);
  const path = linkIndexPath(root, index.repositoryIdentity), temporary = `${path}.${randomUUID()}.tmp`;
  const bytes = JSON.stringify(index) + '\n';
  mkdirSync(root, { recursive: true });
  let descriptor, created = false;
  try {
    descriptor = openSync(temporary, 'wx'); created = true;
    writeFileSync(descriptor, bytes, 'utf8');
    closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
    return path;
  } finally {
    try { if (descriptor !== undefined) closeSync(descriptor); }
    finally {
      if (created) try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}

/** Operator-facing refusal text: the index age when known, the limit and the remedy.
 * @param {number | null} ageMs
 */
export function staleIndexMessage(ageMs) {
  const hours = ms => `${(ms / 3_600_000).toFixed(1)} h`;
  const state = ageMs === null ? 'is missing or unusable' : `is ${hours(ageMs)} old`;
  return `Link index ${state} (limit ${hours(MAX_AGE_MS)}); the next scheduled nightly cleanup refreshes it`;
}

/** Missing, unreadable, corrupt, foreign and expired indexes all refuse with
 * reason link-index-stale. ageMs is set only when age is the sole failure.
 * @param {string} root @param {string} commonDirectory @param {{now?: number}} options
 */
export function readLinkIndex(root, commonDirectory, { now = Date.now() } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(linkIndexPath(root, commonDirectory), 'utf8'));
    return ok(validateIndex(parsed, commonDirectory, now));
  } catch {
    let ageMs = null;
    // Revalidate as if read when observed: passing means nothing but age failed.
    try {
      if (object(parsed) && Number.isFinite(now) && now - parsed.observedAt > MAX_AGE_MS &&
          validateIndex(parsed, commonDirectory, parsed.observedAt)) ageMs = now - parsed.observedAt;
    } catch { /* Another invariant failed too; do not attribute the refusal to age. */ }
    return { ...unknown('link-index-stale'), ageMs, detail: staleIndexMessage(ageMs) };
  }
}

/** Build the target's baseline from a fresh candidate snapshot and readLinkIndex's
 * result. The caller assigns inboundLinks before classification; liveWalked is
 * the set of registered source paths whose full walks were attempted.
 * @param {string} targetPath
 * @param {InventorySnapshot} snapshot
 * @param {import('./probe.mjs').ProbeResult<LinkIndex>} index
 * @param {Parameters<typeof import('./inventory.mjs').inventory>[0] & {now?: number}} options
 */
export function buildInboundLinks(targetPath, snapshot, index, options = {}) {
  const liveWalked = new Set();
  const leftoverPaths = [];
  const result = inboundLinks => ({ inboundLinks, liveWalked, leftoverPaths });
  const { now = Date.now(), ...walkOptions } = options;
  let validated;
  try {
    requireEvidence(index.state === 'ok' && snapshot.commonDirectory?.state === 'ok', 'Missing link index');
    validated = validateIndex(index.value, snapshot.commonDirectory.value, now);
  } catch { return result(unknown('link-index-stale')); }
  try {
    remainingTime(walkOptions);
    const target = snapshot.worktrees.find(tree => normalizePath(tree.path) === normalizePath(targetPath));
    requireEvidence(target && snapshot.registrations?.some(entry => normalizePath(entry.path) === normalizePath(targetPath)), 'Target no longer registered');
    requireEvidence(target.links.state === 'ok', 'Target link scan unavailable');
    const keys = new Map(snapshot.registrationKeys.map(entry => [normalizePath(entry.path), entry]));
    const skipRoots = registeredRoots(snapshot);
    const discoveredLinks = new Map([[target.path, target.links.value.entries]]);
    for (const registration of snapshot.registrations) {
      remainingTime(walkOptions);
      if (normalizePath(registration.path) === normalizePath(targetPath)) continue;
      if (registration.prunable !== null && !lstatSync(registration.path, { throwIfNoEntry: false })) continue;
      const key = keys.get(normalizePath(registration.path));
      const entry = normalizePath(registration.path) === normalizePath(snapshot.primaryPath)
        ? validated.entries[primaryKey(snapshot.primaryPath, validated.repositoryIdentity)] : key && validated.entries[incarnation(key)];
      let links;
      if (entry?.complete) links = entry.links;
      else {
        liveWalked.add(registration.path);
        const walk = scanTreeLinks(registration.path, { ...walkOptions, skipRoots,
          walkTimeout: boundedTimeout({ ...walkOptions, timeout: walkOptions.walkTimeout ?? 240_000 }) });
        requireEvidence(walk.state === 'ok', walk.state === 'unknown' ? walk.reason : 'Foreign link walk unavailable');
        links = walk.value;
      }
      // Every foreign tree gets fresh top-level evidence, even after a deep walk.
      const shallow = scanShallowLinks(registration.path, walkOptions);
      requireEvidence(shallow.state === 'ok', shallow.state === 'unknown' ? shallow.reason : 'Foreign link scan unavailable');
      // Retain old positive evidence if a shallow link has changed its target.
      discoveredLinks.set(registration.path, [...new Map([...links, ...shallow.value].map(link => [JSON.stringify(link), link])).values()]);
    }
    // A pruned registration can leave its folder behind. It has no current
    // incarnation to validate the cache against, so always walk it live.
    const registered = new Set(snapshot.registrations.map(entry => normalizePath(entry.path)));
    for (const entry of Object.values(validated.entries)) {
      remainingTime(walkOptions);
      if (registered.has(normalizePath(entry.path))) continue;
      // Index paths are lowercase keys; resolve the on-disk casing so a case-sensitive
      // directory (Linux, or NTFS per-directory case sensitivity) cannot hide a leftover.
      // A component the case walk cannot match (an 8.3 alias, say) still holds if the raw path exists.
      const actualPath = existingCasePath(entry.path) ?? rawPathIfPresent(entry.path);
      if (actualPath === null) continue;
      const stat = lstatSync(actualPath);
      requireEvidence(stat.isDirectory() && !stat.isSymbolicLink(), 'Indexed leftover identity unavailable');
      leftoverPaths.push(actualPath);
      liveWalked.add(actualPath);
      const walk = scanTreeLinks(actualPath, { ...walkOptions, skipRoots,
        walkTimeout: boundedTimeout({ ...walkOptions, timeout: walkOptions.walkTimeout ?? 240_000 }) });
      requireEvidence(walk.state === 'ok', walk.state === 'unknown' ? walk.reason : 'Leftover link walk unavailable');
      const shallow = scanShallowLinks(actualPath, walkOptions);
      requireEvidence(shallow.state === 'ok', shallow.state === 'unknown' ? shallow.reason : 'Leftover link scan unavailable');
      discoveredLinks.set(actualPath, [...new Map([...walk.value, ...shallow.value].map(link => [JSON.stringify(link), link])).values()]);
    }
    remainingTime(walkOptions);
    return result(inboundLinksFor(target.path, target.links, discoveredLinks));
  } catch (error) { return result(unknown(`Inbound link baseline unavailable: ${String(error)}`)); }
}
