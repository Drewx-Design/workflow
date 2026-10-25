import { spawnSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export function requireEvidence(condition, reason) { if (!condition) throw new Error(reason); }
// Scope the run as well as passing explicit deadlines at public scan boundaries.
// This also bounds probes/walks in classification and idle-journal consumers.
const deadlineScope = new AsyncLocalStorage();
/** @template T @param {number} softDeadline @param {() => number} now @param {() => T} action @returns {T} */
export function withDeadline(softDeadline, now, action) { return deadlineScope.run({ softDeadline, deadlineNow: now }, action); }
export function remainingTime(options = {}) {
  let remaining = Infinity;
  for (const bound of [deadlineScope.getStore(), options]) {
    if (bound?.softDeadline === undefined) continue;
    const instant = (bound.deadlineNow ?? Date.now)();
    requireEvidence(Number.isFinite(bound.softDeadline) && Number.isFinite(instant), 'Invalid deadline clock');
    remaining = Math.min(remaining, bound.softDeadline - instant);
  }
  requireEvidence(remaining > 0, 'Soft deadline reached');
  return remaining;
}
export function boundedTimeout(options = {}, fallback = 15_000) {
  return Math.max(1, Math.ceil(Math.min(options.timeout ?? fallback, remainingTime(options))));
}
export const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export function fingerprint(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode]; }
export function windowsPowerShellPath() { return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'); }

/** @template T @typedef {{state: 'ok', value: T, stderr: string, exitCode: number|null} | {state: 'negative', stderr: string, exitCode: number|null} | {state: 'unknown', reason: string, stderr: string, exitCode: number|null}} ProbeResult */
/** @template T @param {T} value @returns {ProbeResult<T>} */
export function ok(value, stderr = '', exitCode = null) { return { state: 'ok', value, stderr, exitCode }; }
/** @returns {ProbeResult<never>} */
export function negative(stderr = '', exitCode = null) { return { state: 'negative', stderr, exitCode }; }
/** @param {string} reason @returns {ProbeResult<never>} */
export function unknown(reason, stderr = '', exitCode = null) { return { state: 'unknown', reason, stderr, exitCode }; }

/** Resolve without a shell, ignoring relative PATH entries and Windows script shims. */
export function resolveExecutable(name, environment = process.env) {
  try {
    const candidates = isAbsolute(name) ? [name] : (environment.PATH ?? environment.Path ?? '').split(delimiter)
      .map((directory) => directory.replace(/^"|"$/g, '')).filter(isAbsolute)
      .flatMap((directory) => (process.platform === 'win32' ? ['', '.exe', '.com'] : ['']).map((extension) => join(directory, name + extension)));
    for (const candidate of candidates) {
      try {
        if (!statSync(candidate).isFile()) continue;
        accessSync(candidate, constants.X_OK);
        if (process.platform === 'win32' && !/\.(exe|com)$/i.test(candidate)) continue;
        return ok(resolve(candidate));
      } catch { /* Try the next absolute PATH entry. */ }
    }
    return unknown(`Executable unavailable: ${name}`);
  } catch (error) { return unknown(String(error)); }
}

/**
 * The only subprocess boundary. A semantic negative requires a successful parse;
 * even conventional exit code 1 is unknown (callers must not treat it as absence).
 * @template [T=string]
 * @param {string} executable
 * @param {string[]} args
 * @param {{cwd?: string, timeout?: number, softDeadline?: number, deadlineNow?: () => number, maxBuffer?: number, env?: NodeJS.ProcessEnv, parse?: (text: string) => T, isNegative?: (value: T) => boolean}} options
 * @returns {ProbeResult<T>}
 */
export function probe(executable, args, options = {}) {
  if (!isAbsolute(executable)) return unknown('Probe executable must be an absolute path');
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) return unknown('Probe arguments must be a string array');
  let stderr = '', exitCode = null;
  try {
    const result = spawnSync(executable, args, { cwd: options.cwd, env: options.env ?? process.env,
      timeout: boundedTimeout(options), maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
      windowsHide: true, shell: false, encoding: 'buffer', stdio: ['ignore', 'pipe', 'pipe'] });
    stderr = result.stderr?.toString('utf8') ?? '';
    exitCode = result.status;
    remainingTime(options);
    if (result.error || result.signal || result.status !== 0) return unknown(
      result.error?.message ?? `Probe failed (exit ${result.status}, signal ${result.signal})`, stderr, exitCode);
    const stdout = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout);
    const value = options.parse ? options.parse(stdout) : /** @type {T} */ (/** @type {unknown} */ (stdout));
    if (value === undefined) return unknown('Probe parser returned no value', stderr, exitCode);
    return options.isNegative?.(value) ? negative(stderr, exitCode) : ok(value, stderr, exitCode);
  } catch (error) { return unknown(`Probe could not parse or execute: ${String(error)}`, stderr, exitCode); }
}
