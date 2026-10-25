/** Synchronous runners only: cwd is process-global and must not span an await. */
export function inWorkingDirectory<T>(cwd: string, run: () => T): T {
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    return run();
  } finally {
    process.chdir(originalCwd);
  }
}
