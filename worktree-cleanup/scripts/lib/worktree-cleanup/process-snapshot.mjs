import { ok, probe, requireEvidence, unknown, windowsPowerShellPath } from './probe.mjs';

// CIM in Windows PowerShell 5.1 emits /Date(ms)/; newer manifests use ISO.
export function creationMs(value) {
  if (typeof value !== 'string') return null;
  const legacy = /^\/Date\((-?\d+)(?:[+-]\d+)?\)\/$/.exec(value);
  // Only the supervisor's ISO-8601 form; Date.parse('12') would read a year.
  if (!legacy && !/^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(value)) return null;
  const time = legacy ? Number(legacy[1]) : Date.parse(value);
  return Number.isSafeInteger(time) ? time : null;
}

/** @param {{runner?: (executable: string, args: string[], options: {timeout: number, softDeadline?: number, deadlineNow?: () => number}) => import('./probe.mjs').ProbeResult<string>, timeout?: number, softDeadline?: number, deadlineNow?: () => number}} options */
export function processSnapshot(options = {}) {
  if (process.platform !== 'win32' && !options.runner) return unknown('CIM process snapshot unavailable on this platform');
  try {
    const result = (options.runner ?? probe)(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,CreationDate | ConvertTo-Json -Compress'],
    { timeout: options.timeout ?? 10_000, softDeadline: options.softDeadline, deadlineNow: options.deadlineNow });
    if (result.state !== 'ok') return unknown('CIM process snapshot failed');
    const parsed = JSON.parse(result.value);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const processes = new Map();
    for (const row of rows) {
      requireEvidence(row && Number.isSafeInteger(row.ProcessId) && row.ProcessId >= 0, 'Invalid CIM process id');
      const created = creationMs(row.CreationDate);
      // Unavailable system-process stamps must not poison unrelated PIDs.
      // A missing stamp leaves that PID absent, which holds its job as doubt.
      if (created !== null) processes.set(row.ProcessId, created);
    }
    return ok(processes);
  } catch { return unknown('CIM process snapshot could not be read or parsed'); }
}
