import { lstatSync } from 'node:fs';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { requireEvidence } from './probe.mjs';

/** Check from the volume root down before accessing any child through a link.
 * Missing paths either throw the native lstat error, return false, or throw the
 * caller's validation message. Only ENOENT is absence; other I/O errors escape.
 * @param {string} path
 * @param {{includeLeaf?: boolean, missing?: 'throw'|'allow'|'reject', message?: string}} options
 */
export function assertUnlinkedAncestors(path, { includeLeaf = true, missing = 'throw', message = 'Linked or invalid directory ancestor' } = {}) {
  const full = includeLeaf ? resolve(path) : dirname(resolve(path)), root = parse(full).root;
  let current = root;
  for (const part of ['', ...relative(root, full).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: missing === 'throw' });
    if (!stat && missing === 'allow') return false;
    requireEvidence(stat?.isDirectory() && !stat.isSymbolicLink(), message);
  }
  return true;
}
