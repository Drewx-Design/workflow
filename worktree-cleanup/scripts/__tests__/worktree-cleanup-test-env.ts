import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

// Imported by every cleanup test file before its fixtures capture process.env.
const previousLocalAppData = process.env.LOCALAPPDATA;
const previousNoToast = process.env.WORKTREE_CLEANUP_NO_TOAST;
const localAppData = mkdtempSync(join(tmpdir(), 'wt-test-localappdata-'));
process.env.LOCALAPPDATA = localAppData;
process.env.WORKTREE_CLEANUP_NO_TOAST = '1';

afterAll(() => {
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  if (previousNoToast === undefined) delete process.env.WORKTREE_CLEANUP_NO_TOAST;
  else process.env.WORKTREE_CLEANUP_NO_TOAST = previousNoToast;
  if (!resolve(localAppData).startsWith(resolve(tmpdir()) + sep)) throw new Error('Test environment escaped temp directory');
  rmSync(localAppData, { recursive: true, force: true });
});
