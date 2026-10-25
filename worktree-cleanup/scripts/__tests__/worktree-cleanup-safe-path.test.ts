import './worktree-cleanup-test-env';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertUnlinkedAncestors } from '../lib/worktree-cleanup/safe-path.mjs';

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-safe-path-')); roots.push(root);
  const directory = join(root, 'directory'); mkdirSync(directory);
  return { root, directory };
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Fixture escaped temp directory');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('symlink-free ancestor walk', () => {
  it('accepts plain directories including the leaf', () => {
    expect(assertUnlinkedAncestors(fixture().directory)).toBe(true);
  });
  it('refuses a linked ancestor before inspecting its missing child', () => {
    const { root, directory } = fixture(), link = join(root, 'link');
    symlinkSync(directory, link, 'dir');
    expect(() => assertUnlinkedAncestors(join(link, 'missing'), { missing: 'allow', message: 'Linked journal directory' })).toThrow('Linked journal directory');
  });
  it.skipIf(process.platform !== 'win32')('refuses a junction ancestor', () => {
    const { root, directory } = fixture(), link = join(root, 'junction');
    symlinkSync(directory, link, 'junction');
    expect(() => assertUnlinkedAncestors(join(link, 'missing'))).toThrow('Linked or invalid directory ancestor');
  });
  it.each([true, false])('handles a leaf link with includeLeaf=%s', includeLeaf => {
    const { root, directory } = fixture(), link = join(root, 'link');
    symlinkSync(directory, link, 'dir');
    if (includeLeaf) expect(() => assertUnlinkedAncestors(link, { includeLeaf })).toThrow('Linked or invalid directory ancestor');
    else expect(assertUnlinkedAncestors(link, { includeLeaf })).toBe(true);
  });
  it('excludes a file leaf but refuses a non-directory ancestor', () => {
    const path = join(fixture().root, 'file'); writeFileSync(path, 'bytes');
    expect(assertUnlinkedAncestors(path, { includeLeaf: false })).toBe(true);
    expect(() => assertUnlinkedAncestors(path)).toThrow('Linked or invalid directory ancestor');
    expect(() => assertUnlinkedAncestors(join(path, 'child'), { missing: 'allow' })).toThrow('Linked or invalid directory ancestor');
  });
  it('preserves the native missing-path error by default', () => {
    expect(() => assertUnlinkedAncestors(join(fixture().root, 'missing'))).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });
  it('returns false for an allowed missing ancestor', () => {
    expect(assertUnlinkedAncestors(join(fixture().root, 'missing/child'), { missing: 'allow' })).toBe(false);
  });
  it('uses the call-site message when missing paths are rejected', () => {
    expect(() => assertUnlinkedAncestors(join(fixture().root, 'missing'), { missing: 'reject', message: 'Linked or unavailable activity directory' })).toThrow('Linked or unavailable activity directory');
  });
  it('does not inspect a missing leaf when excluded', () => {
    expect(assertUnlinkedAncestors(join(fixture().directory, 'missing'), { includeLeaf: false })).toBe(true);
  });
});
