import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { assertUnlinkedAncestors } from './safe-path.mjs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isWithin, normalizePath, walkDirectory } from './inventory.mjs';
import { equal, negative, ok, remainingTime, requireEvidence, unknown } from './probe.mjs';
import { creationMs, processSnapshot } from './process-snapshot.mjs';

const WINDOW_MS = 72 * 60 * 60 * 1000;
// Bump when the closed list or the record-time rule changes.
export const TRANSCRIPT_BOOKKEEPING_VERSION = 1;
export const DECIDING_TRANSCRIPT_RULE = 'folder';
export const TRANSCRIPT_REACH_VERSION = 2;
const UNRESOLVED_COMMAND = 'Recent transcript unavailable: Unresolved relative command path';
export const doubtClasses = ['variable', 'command-substitution', 'chained-cd', 'climb-out', 'unparsable-exec', 'non-literal-command', 'other'];
function doubtCounts() { return Object.fromEntries(doubtClasses.map(name => [name, 0])); }
const TRANSCRIPT_BOOKKEEPING_TYPES = new Set([
  'cost-state', 'last-prompt', 'ai-title', 'custom-title', 'mode',
  'permission-mode', 'bridge-session', 'atis-latch', 'history-suppression',
  'artifact-autoreact-ledger', 'artifact-comment-monitor',
]);
// codex-job classify(): a dead wrapper is insufficient while logs are fresh.
const LEASE_GRACE_MS = 60_000;
const excluded = new Set(['.git', 'node_modules', '.next']);
/** @typedef {{homeDirectory?: string, codexJobStateDirectory?: string, now?: () => number, pidAlive?: (pid: number) => boolean, leaseProcessSnapshot?: () => import('./probe.mjs').ProbeResult<Map<number, number>>, leaseMemo?: Set<string>, walkTimeout?: number, softDeadline?: number, deadlineNow?: () => number}} ActivityOptions */
/** @typedef {{path: string, registration: import('./probe.mjs').ProbeResult<{head: string|null}>, activity?: object}} Worktree */
// Times are Unix milliseconds; ambiguous mention times use the run clock.
// Missing session identity stays null for the consumer to classify as foreign.
/** @typedef {{kind: 'claude'|'codex', sessionId: string|null, filePath: string, latestMentionMs: number}} TranscriptMention */
/** @typedef {{kind: 'claude'|'codex', sessionId: string|null, filePath: string, latestRecordMs: number}} TranscriptDoubt */
// Process-local evidence only: never serialize or trust a supplied cache. Results
// retain per-file outcomes for all classification candidates, not transcript text.
const transcriptSessions = new WeakMap();

// JSON parse failures are replaced at the parse boundary so reasons never echo
// transcript bytes. Filesystem errors and our own validation errors are safe.
function reason(prefix, error) { return `${prefix}: ${error instanceof Error ? error.message : 'probe failed'}`; }
function time(options) {
  const now = (options.now ?? Date.now)();
  requireEvidence(Number.isFinite(now), 'Invalid activity clock');
  return now;
}
function deadline(options) { return { end: performance.now() + (options.walkTimeout ?? 120_000), options }; }
function checkDeadline(limit) { remainingTime(limit.options); requireEvidence(performance.now() < limit.end, 'Activity scan timed out'); }
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }

// Validate ancestors before accessing children, including injected evidence roots.
// Missing evidence roots are absence; missing worktrees and entries are failures.
function directory(path, allowMissing = false) {
  return assertUnlinkedAncestors(path, { missing: allowMissing ? 'allow' : 'reject', message: 'Linked or unavailable activity directory' });
}

function* files(root, limit, omit = new Set(), allowMissing = false) {
  if (!directory(root, allowMissing)) return;
  const pending = [root];
  while (pending.length) {
    checkDeadline(limit);
    const path = pending.pop();
    directory(path);
    const before = lstatSync(path), names = readdirSync(path);
    const after = lstatSync(path);
    requireEvidence(after.isDirectory() && !after.isSymbolicLink() && sameFile(before, after), 'Activity directory changed during scan');
    for (const name of names) {
      checkDeadline(limit);
      if (omit.has(name.toLowerCase())) continue;
      const child = join(path, name), stat = lstatSync(child);
      requireEvidence(!stat.isSymbolicLink(), 'Activity scan encountered a link');
      if (stat.isDirectory()) pending.push(child);
      else {
        requireEvidence(stat.isFile() && Number.isFinite(stat.mtimeMs), 'Unsupported activity entry');
        yield { path: child, stat };
      }
    }
  }
}

// Verify the opened identity before reading; on platforms supporting O_NOFOLLOW,
// also reject a final-component link atomically. Never read through a known link.
function openRegular(path, expected) {
  directory(dirname(path));
  const before = expected ?? lstatSync(path);
  requireEvidence(before.isFile() && !before.isSymbolicLink(), 'Evidence is not a regular file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    requireEvidence(opened.isFile() && sameFile(before, opened), 'Evidence identity changed');
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function parseJson(text, reason) {
  try { return JSON.parse(text); } catch { throw new Error(reason); }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw new Error('PID liveness unavailable');
  }
}

// The options object scopes default evidence to a run; callers sharing a memo
// across option copies may inject a process-local Set. Never persist the memo.
const leaseSessions = new WeakMap();
function leaseSession(options) {
  if (!leaseSessions.has(options)) leaseSessions.set(options, { memo: new Set(), ledgers: new Map() });
  return leaseSessions.get(options);
}

function readLeaseLedger(root, session) {
  try {
    const path = join(root, 'ledger.jsonl'), stat = lstatSync(path);
    requireEvidence(stat.isFile() && !stat.isSymbolicLink(), 'Invalid Codex ledger');
    const cached = session.ledgers.get(path);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.evidence;
    const fd = openRegular(path, stat);
    let text;
    try { text = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
    const jobs = new Map();
    for (const line of text.split('\n').filter(line => line.trim())) {
      const entry = parseJson(line, 'Malformed Codex ledger');
      requireEvidence(entry && typeof entry.job === 'string' && typeof entry.state === 'string', 'Invalid Codex ledger entry');
      if (!jobs.has(entry.job)) jobs.set(entry.job, []);
      jobs.get(entry.job).push(entry);
    }
    const evidence = ok(jobs);
    session.ledgers.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, evidence });
    return evidence;
  } catch { return unknown('Codex ledger unavailable'); }
}

function turnEndAnchor(manifest, ledger) {
  if (ledger.state !== 'ok') return null;
  const entries = ledger.value.get(manifest.id) ?? [];
  const running = entries.filter(entry => entry.state === 'running');
  if (running.length !== 1 || running[0].pid !== manifest.pid || entries.some(entry => creationMs(entry.ts) === null)) return null;
  const anchor = creationMs(running[0].ts);
  const cancellation = entries.filter(entry => ['cancelling', 'cancellation-failed', 'cancelled'].includes(entry.state)).at(-1);
  if (['cancelling', 'cancellation-failed'].includes(cancellation?.state)) return null;
  const ended = entries.some(entry => creationMs(entry.ts) > anchor && entry.partial !== true && (
    (['completed', 'failed'].includes(entry.state) && entry.reason === 'terminal event in stream') ||
    (entry.state === 'cancelled' && entry.termination_verified === true && entry.survivors === 0)));
  return ended ? anchor : null;
}

function rootInstanceGone(manifest, anchor, snapshot) {
  if (snapshot?.state !== 'ok' || !(snapshot.value instanceof Map)) return false;
  const current = snapshot.value.get(manifest.pid);
  if (!Number.isSafeInteger(current)) return false;
  if (manifest.pid_created_at == null || manifest.pid_created_at === 'unknown') return current - anchor > LEASE_GRACE_MS;
  const recorded = creationMs(manifest.pid_created_at);
  return recorded !== null && Math.abs(current - recorded) > LEASE_GRACE_MS;
}

function readLeases(options) {
  try {
    const now = time(options), limit = deadline(options);
    const root = resolve(options.codexJobStateDirectory ?? join(options.homeDirectory ?? homedir(), '.claude', 'codex-jobs'));
    if (!directory(root, true)) return ok([]);
    const live = [], session = leaseSession(options), memo = options.leaseMemo ?? session.memo;
    let ledger, snapshot, snapshotTaken = false;
    for (const name of readdirSync(root)) {
      checkDeadline(limit);
      const job = join(root, name), stat = lstatSync(job);
      requireEvidence(!stat.isSymbolicLink(), 'Linked Codex job entry');
      if (!stat.isDirectory()) { requireEvidence(stat.isFile(), 'Unsupported Codex job entry'); continue; }
      const fd = openRegular(join(job, 'manifest.json'));
      let manifest, manifestText;
      try { manifestText = readFileSync(fd, 'utf8'); manifest = parseJson(manifestText, 'Malformed Codex manifest'); }
      finally { closeSync(fd); }
      requireEvidence(manifest && manifest.id === name && typeof manifest.cwd === 'string' && isAbsolute(manifest.cwd) &&
        (manifest.pid === null || (Number.isSafeInteger(manifest.pid) && manifest.pid > 0)) &&
        typeof manifest.started_at === 'string' && Number.isFinite(Date.parse(manifest.started_at)), 'Invalid Codex manifest fields');
      let newest = null;
      for (const log of ['stdout.log', 'stderr.log']) {
        const metadata = lstatSync(join(job, log), { throwIfNoEntry: false });
        if (!metadata) continue;
        requireEvidence(metadata.isFile() && !metadata.isSymbolicLink() && Number.isFinite(metadata.mtimeMs), 'Invalid Codex log metadata');
        newest = Math.max(newest ?? -Infinity, metadata.mtimeMs);
      }
      const alive = manifest.pid === null ? false : (options.pidAlive ?? processAlive)(manifest.pid);
      requireEvidence(typeof alive === 'boolean', 'Invalid PID liveness result');
      if (now - (newest ?? Date.parse(manifest.started_at)) <= LEASE_GRACE_MS) { live.push(manifest.cwd); continue; }
      if (!alive) continue;
      const key = JSON.stringify([manifest.id, manifest.pid, createHash('sha256').update(manifestText).digest('hex')]);
      if (memo.has(key)) continue;
      ledger ??= readLeaseLedger(root, session);
      const anchor = turnEndAnchor(manifest, ledger);
      if (anchor === null) { live.push(manifest.cwd); continue; }
      if (!snapshotTaken) {
        snapshotTaken = true;
        try { snapshot = (options.leaseProcessSnapshot ?? processSnapshot)({ softDeadline: options.softDeadline, deadlineNow: options.deadlineNow }); }
        catch { snapshot = unknown('Codex process snapshot unavailable'); }
      }
      if (rootInstanceGone(manifest, anchor, snapshot)) memo.add(key);
      else live.push(manifest.cwd);
    }
    return ok(live);
  } catch (error) { return unknown(reason('Codex lease evidence unavailable', error)); }
}
function leaseFor(path, evidence) {
  if (evidence.state !== 'ok') return evidence;
  // A parent lease covers children; a job inside a tree also prevents its removal.
  const count = evidence.value.filter((cwd) => isWithin(path, cwd) || isWithin(cwd, path)).length;
  return count ? ok({ count }) : negative();
}
/** @param {string} path @param {ActivityOptions} options */
export function leases(path, options = {}) { return leaseFor(path, readLeases(options)); }

const pathKeys = new Set(['cwd', 'workdir', 'working_directory', 'path', 'paths', 'file_path', 'filePath', 'filepath', 'directory', 'root', 'target_file']);
const commandKeys = new Set(['cmd', 'command', 'commands', 'code', 'script']);
function normalizedText(text) {
  // Preserve a UNC root, but collapse JSON-escaped separators inside paths.
  return text.replace(/\\+/g, (slashes, offset) => slashes.length >= 2 &&
    (offset === 0 || /[\s"'`=([{,;]/.test(text[offset - 1])) ? '//' : '/').toLowerCase();
}
function candidateIndex(paths) {
  const sorted = paths.map((path, index) => ({ path: normalizePath(path), index }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const byPath = new Map(), prefixes = { children: new Map(), path: null };
  for (const entry of sorted) {
    if (!byPath.has(entry.path)) byPath.set(entry.path, []);
    byPath.get(entry.path).push(entry.index);
    for (const spelling of new Set([entry.path, entry.path.replace(/^([a-z]):\//, '/$1/')])) {
      let node = prefixes;
      // Use UTF-16 units, like the indexed command text (including emoji paths).
      for (let offset = 0; offset < spelling.length; offset++) {
        const character = spelling[offset];
        if (!node.children.has(character)) node.children.set(character, { children: new Map(), path: null });
        node = node.children.get(character);
      }
      node.path = entry.path;
    }
  }
  return {
    // Literal absolute mentions historically count even before shell parsing
    // (including quoted spaces, malformed quotes and paths followed by /..).
    // Walk only indexed prefixes at token boundaries, never all candidates.
    // A colon is a boundary because PowerShell binds -Path:<tree> like -Path <tree>;
    // it only widens matching to indexed paths, so it can only add holds.
    absoluteReferences(text, output) {
      const starts = /(?:^|[\s"'`=([{,;:])(?=[a-z]:|\/)/g;
      for (const match of text.matchAll(starts)) {
        let node = prefixes, offset = match.index + match[0].length;
        while (node) {
          if (node.path !== null && (!text[offset] || /[\s/"'`;|&<>)}\],]/.test(text[offset]))) output.add(node.path);
          node = node.children.get(text[offset++]);
        }
      }
    },
    *ancestors(path) {
      for (;;) {
        yield* byPath.get(path) ?? [];
        const slash = path.lastIndexOf('/');
        if (slash < 0) break;
        path = path.slice(0, slash);
      }
    },
    *descendants(cwd) {
      yield* byPath.get(cwd) ?? [];
      const prefix = cwd + '/';
      let low = 0, high = sorted.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sorted[middle].path < prefix) low = middle + 1;
        else high = middle;
      }
      for (; low < sorted.length && sorted[low].path.startsWith(prefix); low++) yield sorted[low].index;
    },
    *startingWith(prefix) {
      let low = 0, high = sorted.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (sorted[middle].path < prefix) low = middle + 1;
        else high = middle;
      }
      for (; low < sorted.length && sorted[low].path.startsWith(prefix); low++) yield sorted[low].index;
    },
  };
}
// Only a whole, literal owner release exempts its target. Keep every other byte
// and argv element so ordinary path evidence and expansion doubts survive.
function withoutReleaseTarget(input) {
  // Comments, escape-sensitive backslashes (before whitespace, a quote or the
  // end) and any character a shell may split on differently from JavaScript
  // (non-ASCII or control whitespace) change word boundaries: never qualify.
  if (!input.command || input.absoluteOnly || /[;|<>(){}`#]|[^\x20-\x7e]|\\(?=\s|["']|$)/.test(input.text)) return input;
  const matches = input.tokens ? null : [...input.text.matchAll(/"[^"]*"|'[^']*'|[^\s"']+/g)];
  if (matches && (!matches.length || input.text.slice(0, matches[0].index).trim() || matches.some((match, index) =>
    index > 0 && !/^\s+$/.test(input.text.slice(matches[index - 1].index + matches[index - 1][0].length, match.index))) ||
    input.text.slice(matches.at(-1).index + matches.at(-1)[0].length).trim())) return input;
  const raw = input.tokens ?? matches.map(match => match[0]);
  const unquote = token => token.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, double, single) => double ?? single);
  if (raw.some(token => !/^(?:"[^"]*"|'[^']*'|[^"']+)$/.test(token))) return input;
  // Shell argv elements are literal: a quote character there is part of the word.
  const word = index => input.tokens ? raw[index] : unquote(raw[index] ?? '');
  const tokens = raw.map((_, index) => normalizedText(word(index)));
  // `&` is PowerShell's call operator only in shell text; in argv it is a program name.
  const call = !input.tokens && raw[0] === '&';
  if (tokens.slice(call ? 1 : 0).some(token => token.includes('&'))) return input;
  let index = call ? 1 : 0, target = -1, script = -1;
  const segment = token => token?.split('/').at(-1);
  const executable = segment(tokens[index]);
  const seen = new Set();
  if (!call && /^(?:powershell|pwsh)(?:\.exe)?$/.test(executable)) {
    index++;
    while (tokens[index] !== '-file') {
      const flag = tokens[index++];
      if (!['-noprofile', '-noninteractive', '-executionpolicy'].includes(flag) || seen.has(flag)) return input;
      seen.add(flag);
      if (flag === '-executionpolicy' && tokens[index++] !== 'bypass') return input;
    }
    index++;
  }
  if (segment(tokens[index]) === 'release-worktree.ps1') {
    script = index++;
    seen.clear();
    while (index < tokens.length) {
      const position = index++, token = tokens[position];
      if (!token.startsWith('-')) {
        if (target !== -1) return input;
        target = position;
        continue;
      }
      const flag = ['-ownersession', '-owner-session', '--owner-session'].includes(token) ? '-ownersession' : token;
      if (!['-path', '-ownersession', '-nodepath'].includes(flag) || seen.has(flag) || !tokens[index] || tokens[index].startsWith('-')) return input;
      seen.add(flag);
      // The call runs this program against the target; only node is the reviewed release.
      if (flag === '-nodepath' && !/^node(?:\.exe)?$/.test(segment(tokens[index]))) return input;
      if (flag === '-path') {
        if (target !== -1) return input;
        target = index;
      }
      index++;
    }
  } else if (!call && /^(?:node)(?:\.exe)?$/.test(executable) && !tokens[index + 1]?.startsWith('-') &&
      segment(tokens[index + 1]) === 'worktree-cleanup.mjs' && word(index + 2) === 'release') {
    script = index + 1;
    target = index + 3;
    index += 4;
    while (index < tokens.length) {
      // The CLI matches its option names case-sensitively; so does this rule.
      const flag = word(index++);
      if (!['--repo', '--owner-session', '--runner', '--git', '--gh', '--report-root', '--timeout-ms', '--walk-timeout-ms', '--soft-timeout-ms'].includes(flag) ||
          seen.has(flag) || !tokens[index] || tokens[index].startsWith('-')) return input;
      // Mirror releaseCommand: a timeout it rejects never reaches release.
      if (flag.endsWith('-ms') && (!/^[1-9][0-9]*$/.test(word(index)) || !Number.isSafeInteger(Number(word(index))))) return input;
      // The call runs these programs against the target; only git and gh are the reviewed release.
      if (flag === '--git' && !/^git(?:\.exe)?$/.test(segment(tokens[index]))) return input;
      if (flag === '--gh' && !/^gh(?:\.exe)?$/.test(segment(tokens[index]))) return input;
      seen.add(flag);
      index++;
    }
    if (!seen.has('--repo')) return input;
  } else return input;
  const path = tokens[target];
  // Keep this charset disjoint from every doubt trigger: dropping the target must
  // never drop a doubt, so widening it (to ~, %, + ...) needs its own review.
  if (!path || !/^(?:[a-z]:\/|\/)[a-z0-9_./ -]*$/.test(path) || path.split('/').includes('..')) return input;
  // A POSIX shell strips an unquoted backslash (\--import is --import), and one
  // before $ ` " \ inside double quotes, while Windows reads it as a separator.
  // Recognition must hold under both readings, so no other word may carry one.
  // Shell argv is literal; a target backslash can only retarget away from it.
  if (!input.tokens && raw.some((token, index) => index !== target &&
      (token.startsWith('"') ? /\\[$`"\\]/.test(token.slice(1, -1)) : !token.startsWith("'") && token.includes('\\')))) return input;
  // Every other word must be literal, or an expansion could become an option
  // ("$x/worktree-cleanup.mjs" with x=--import=.). The one exception is the
  // documented PowerShell call of the installed script, double-quoted so it
  // expands; in a POSIX shell a leading & is a syntax error, so it never runs
  // there. `@` (splatting) and `=` (an assignment word) are not literal.
  if (raw.some((token, index) => index !== target && !(call && index === 0) && !/^[a-z0-9_./:\\ +-]*$/i.test(word(index)) &&
      !(call && index === script && token.startsWith('"') && /^\$env:localappdata[\\/][a-z0-9_./\\ -]*$/i.test(word(index))))) return input;
  if (input.tokens) {
    const tokens = input.tokens.filter((_, index) => index !== target);
    return { ...input, text: tokens.join(' '), tokens };
  }
  const match = matches[target];
  return { ...input, text: input.text.slice(0, match.index) + input.text.slice(match.index + match[0].length) };
}

function resolveInput(input, cwd, candidates) {
  const { text, command } = withoutReleaseTarget(input);
  const value = normalizedText(text);
  const result = { paths: new Set(), unresolved: false };
  if (!command) {
    if (isAbsolute(value) || cwd) result.paths.add(normalizePath(isAbsolute(value) ? value : resolve(cwd, value)));
    return result;
  }
  candidates.absoluteReferences(value, result.paths);
  // Unresolved tokens only hold candidates at or below cwd. Without cwd they
  // contribute nothing, because their uncertainty cannot be scoped.
  if (!cwd) return result;
  // Resolve literal shell arguments, including bare paths and quoted paths with
  // spaces. This is not a shell evaluator: expansion, escapes and compound cwd
  // changes must never become evidence that an otherwise uncertain tree is idle.
  const tokenPattern = /(?:"[^"]*"|'[^']*'|[^\s"';&|<>()])+|[;&|<>()]/g;
  const tokens = value.match(tokenPattern) ?? [];
  if (value.replace(tokenPattern, '').trim() !== '' || /\\\s/.test(text)) {
    result.unresolved = true;
    return result;
  }
  for (const raw of tokens) {
    let token = raw;
    if (/^[;&|<>()]$/.test(token)) continue;
    token = token.replace(/["']/g, '');
    if (/[$`*?{}\[\]~%]/.test(token)) {
      // Standalone braces are grouping syntax; every expansion-bearing token
      // is uncertain regardless of its position or the preceding verb/flag.
      if (token !== '{' && token !== '}') result.unresolved = true;
      continue;
    }
    if (/^[a-z]:[^/]/.test(token)) { result.unresolved = true; continue; }
    token = token.replace(/^[^=/]+=/, '');
    if (process.platform === 'win32') token = token.replace(/^\/([a-z])\//, '$1:/');
    if (token) result.paths.add(normalizePath(resolve(cwd, token)));
  }
  result.unresolved ||= /(?:^|[\s;&|])(?:cd|set-location|pushd)\s/i.test(value) && /[;&|\r\n]/.test(value);
  return result;
}
function inputValues(input, name, output) {
  if (typeof input === 'string') {
    // Freeform patches contain prose too: only their file headers are evidence.
    if (/(?:^|[._])apply_patch$/.test(name)) {
      for (const line of input.split(/\r?\n/)) {
        const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
        if (match) output.push({ text: match[1], command: false });
      }
    } else if (/(?:^|[._])(?:exec|exec_command|shell_command|bash)$/i.test(name)) output.push({ text: input, command: true });
    return;
  }
  requireEvidence(input && typeof input === 'object' && !Array.isArray(input), 'Invalid tool input');
  const workingDirectory = input.workdir ?? input.cwd ?? input.working_directory;
  requireEvidence(workingDirectory === undefined || typeof workingDirectory === 'string', 'Invalid tool working directory');
  for (const [key, value] of Object.entries(input)) {
    if (pathKeys.has(key) || commandKeys.has(key)) {
      const values = Array.isArray(value) ? value : [value];
      for (const text of values) {
        requireEvidence(typeof text === 'string' || text === null, 'Invalid tool path or command');
        if (typeof text === 'string') output.push({ text, command: commandKeys.has(key),
          ...(!['workdir', 'cwd', 'working_directory'].includes(key) ? { workingDirectory } : {}) });
      }
    }
    // Known tool dispatch envelopes; do not recursively search arbitrary text.
    if (key === 'tool_uses' && Array.isArray(value)) {
      for (const tool of value) inputValues(tool.parameters, tool.recipient_name ?? '', output);
    }
  }
}
function recordInputs(record) {
  requireEvidence(record && typeof record === 'object' && !Array.isArray(record), 'Invalid transcript record');
  const inputs = [];
  if (record.cwd !== undefined) {
    requireEvidence(typeof record.cwd === 'string', 'Invalid transcript cwd');
    inputs.push({ text: record.cwd, command: false });
  }
  if (record.type === 'worktree-state' && record.worktreeSession?.worktreePath !== undefined) {
    requireEvidence(typeof record.worktreeSession.worktreePath === 'string', 'Invalid transcript worktree path');
    inputs.push({ text: record.worktreeSession.worktreePath, command: false });
  }
  const payload = record.payload;
  if ((['session_meta', 'turn_context'].includes(record.type) || TRANSCRIPT_BOOKKEEPING_TYPES.has(record.type)) && payload?.cwd !== undefined) {
    requireEvidence(typeof payload.cwd === 'string', 'Invalid session cwd');
    inputs.push({ text: payload.cwd, command: false });
  }
  if ((record.type === 'assistant' || TRANSCRIPT_BOOKKEEPING_TYPES.has(record.type)) && Array.isArray(record.message?.content)) {
    for (const block of record.message.content) if (block.type === 'tool_use') inputValues(block.input, block.name ?? '', inputs);
  }
  if ((record.type === 'response_item' || TRANSCRIPT_BOOKKEEPING_TYPES.has(record.type)) && payload?.type === 'function_call') {
    requireEvidence(typeof payload.arguments === 'string', 'Invalid function arguments');
    inputValues(parseJson(payload.arguments, 'Malformed function arguments'), payload.name ?? '', inputs);
  }
  if ((record.type === 'response_item' || TRANSCRIPT_BOOKKEEPING_TYPES.has(record.type)) && payload?.type === 'custom_tool_call') inputValues(payload.input, payload.name ?? '', inputs);
  return inputs;
}

// Observation has its own parser: do not teach the folder rule new record shapes.
// Accept only a single call and a flat literal options object, never evaluate JS.
function execInputs(text) {
  // A failed JS parse must not erase literal absolute evidence from the raw call.
  const bad = doubt => [...(typeof text === 'string' ? [{ text, command: true, absoluteOnly: true }] : []), { doubt }];
  if (typeof text !== 'string') return bad('unparsable-exec');
  const call = /^\s*(?:text\(\s*(?:await\s+)?tools\.exec_command\(\s*(\{[\s\S]*\})\s*\)\s*\)|(?:await\s+)?tools\.exec_command\(\s*(\{[\s\S]*\})\s*\))\s*;?\s*$/.exec(text);
  if (!call) return bad('unparsable-exec');
  const syntax = text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if ((syntax.match(/\bexec_command\s*\(/g) ?? []).length !== 1) return bad('unparsable-exec');
  let rest = (call[1] ?? call[2]).slice(1, -1).trim();
  const fields = new Map();
  while (rest) {
    const key = /^("(?:[^"\\\r\n]|\\.)*"|[a-zA-Z_][\w]*)\s*:\s*/.exec(rest);
    if (!key) return bad('unparsable-exec');
    let name;
    try { name = key[1].startsWith('"') ? JSON.parse(key[1]) : key[1]; }
    catch { return bad('unparsable-exec'); }
    if (fields.has(name)) return bad('unparsable-exec');
    rest = rest.slice(key[0].length);
    const literal = /^("(?:[^"\\\r\n]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)(?=\s*(?:,|$))/.exec(rest);
    if (!literal) return bad(name === 'cmd' ? 'non-literal-command' : 'unparsable-exec');
    try { fields.set(name, JSON.parse(literal[0])); }
    catch { return bad('unparsable-exec'); }
    rest = rest.slice(literal[0].length).trim();
    if (rest) rest = rest.slice(1).trim(); // The literal's lookahead verified the comma.
  }
  if (typeof fields.get('cmd') !== 'string') return bad('non-literal-command');
  const workingDirectory = fields.get('workdir');
  if (fields.has('workdir') && typeof workingDirectory !== 'string') return bad('unparsable-exec');
  return [...(workingDirectory === undefined ? [] : [{ text: workingDirectory, command: false }]),
    { text: fields.get('cmd'), command: true, workingDirectory }];
}

function reachInputs(record, inputs) {
  const payload = record.payload;
  if ((record.type === 'response_item' || TRANSCRIPT_BOOKKEEPING_TYPES.has(record.type)) &&
      payload?.type === 'custom_tool_call' && payload.name === 'exec') {
    return [...recordInputs({ ...record, payload: undefined }), ...execInputs(payload.input)];
  }
  if (record.type === 'event_msg' && payload?.type === 'item_completed' && payload.item?.type === 'CommandExecution') {
    const item = payload.item;
    let workingDirectory;
    try {
      if (typeof item.cwd !== 'string' || !/^file:\/\//i.test(item.cwd)) throw new Error('Invalid command cwd URL');
      workingDirectory = fileURLToPath(item.cwd);
      if (!isAbsolute(workingDirectory)) throw new Error('Non-absolute command cwd');
    } catch { return [...inputs, { doubt: 'other' }]; }
    const argv = item.command;
    const bad = () => [...inputs, { doubt: 'non-literal-command', workingDirectory, literalWorkingDirectory: true }];
    if (!Array.isArray(argv) || !argv.length || !argv.every(token => typeof token === 'string')) return bad();
    const executable = normalizedText(argv[0]).split('/').at(-1).replace(/\.exe$/, '');
    const shell = /^(?:powershell|pwsh|cmd|bash|sh)$/.test(executable);
    const flag = executable === 'cmd' ? /^\/c$/i : /^(?:powershell|pwsh)$/.test(executable) ? /^-(?:command|c)$/i : /^-(?:c|lc)$/;
    if (shell && (argv.length !== 3 || !flag.test(argv[1]))) return bad();
    return [...inputs, { text: workingDirectory, command: false },
      { text: shell ? argv[2] : argv.join(' '), tokens: shell ? undefined : argv,
        command: true, workingDirectory, literalWorkingDirectory: true }];
  }
  return inputs;
}

function expansionDoubts(value) {
  const doubts = new Set();
  if (/`|\$\(/.test(value)) doubts.add('command-substitution');
  if (/\$(?!\()|%[^%]+%/.test(value)) doubts.add('variable');
  if (/~/.test(value) || /%/.test(value.replace(/%[^%]+%/g, ''))) doubts.add('other');
  return doubts;
}

function climbsOut(token) {
  let depth = 0;
  for (const part of token.split('/')) {
    if (part === '..') { if (depth === 0) return true; depth--; }
    else if (part && part !== '.') depth++;
  }
  return false;
}

function resolveReachInput(input, cwd, candidates) {
  input = withoutReleaseTarget(input);
  const result = { paths: new Set(), prefixes: new Map(), doubts: new Set() };
  if (!input.command) return { ...result, paths: resolveInput(input, cwd, candidates).paths };
  const value = normalizedText(input.text);
  candidates.absoluteReferences(value, result.paths);
  if (input.absoluteOnly) return result;
  const tokenPattern = /\d*[<>]&(?:\d+|-)|(?:"[^"]*"|'[^']*'|[^\s"';&|<>()])+|[;&|<>()]/g;
  const tokens = input.tokens?.map(normalizedText) ?? value.match(tokenPattern) ?? [];
  result.doubts = expansionDoubts(value);
  if (!input.tokens && (value.replace(tokenPattern, '').trim() !== '' || /\\\s/.test(input.text))) result.doubts.add('other');
  if (!input.tokens && /(?:^|[;&|()\r\n])\s*(?:cd|chdir|sl|set-location|pushd|push-location|popd|pop-location)(?=\s|[;&|()]|$)/i.test(value) &&
      /[;&|\r\n]/.test(value)) result.doubts.add('chained-cd');
  for (const raw of tokens) {
    if (!input.tokens && (/^[;&|<>()]$/.test(raw) || /^\d*[<>]&(?:\d+|-)$/.test(raw))) continue;
    let token = raw.replace(/^(?:"([^"]*)"|'([^']*)')$/, (_, double, single) => double ?? single);
    if (process.platform === 'win32') token = token.replace(/^\/([a-z])\//, '$1:/');
    if (/[$`~%]/.test(token)) continue; // Already classified above.
    if (token === '--' || /^--?[a-z][a-z0-9-]*$/.test(token)) continue; // Plain flags carry no path.
    // Only recognized paths can narrow doubt. Colon flag values, assignments,
    // drive-relative paths and unfamiliar punctuation deliberately fall back.
    const path = token.replace(/^[a-z]:\//, '/');
    if (!path || token.startsWith('-') || !/^[a-z0-9_./ *?\[\]{},-]+$/.test(path) || /[\r\n]/.test(token)) {
      result.doubts.add('other'); continue;
    }
    const glob = token.search(/[*?\[\]{}]/);
    const prefix = glob < 0 ? token : token.slice(0, glob);
    if (prefix.includes(',') || (glob < 0 && token.includes(','))) { result.doubts.add('other'); continue; }
    // Keep a literal hit even when its parent traversal also requires doubt.
    if (glob < 0 && (cwd || isAbsolute(token))) result.paths.add(normalizePath(resolve(cwd ?? '', token)));
    // A wildcard segment before '..' cannot establish a bounded traversal.
    if (climbsOut(prefix) || (glob >= 0 && token.slice(glob).includes('..')) ||
        (isAbsolute(prefix) && prefix.split('/').includes('..') && (!cwd || !isWithin(resolve(prefix), cwd)))) {
      result.doubts.add('climb-out'); continue;
    }
    if (glob >= 0) {
      if (!prefix || token === '{' || token === '[') { result.doubts.add('other'); continue; }
      if (!cwd && !isAbsolute(prefix)) continue;
      // Preserve a trailing separator and partial last segment: bt-* is not bt/*.
      // Resolve only the directory portion: the '.' in '.*' is a literal prefix.
      const slash = prefix.lastIndexOf('/');
      const folder = slash < 0 ? cwd : resolve(cwd ?? '', prefix.slice(0, slash + 1));
      result.prefixes.set(normalizePath(folder).replace(/\/$/, '') + '/' + prefix.slice(slash + 1), normalizePath(folder));
    }
  }
  return result;
}

function observeRecord(record, inputs, cwd, candidates, observation) {
  const recordDoubts = new Set();
  for (const input of reachInputs(record, inputs)) {
    const workdirDoubts = input.workingDirectory === undefined || input.literalWorkingDirectory ? new Set() : expansionDoubts(input.workingDirectory);
    const effectiveCwd = input.workingDirectory === undefined || workdirDoubts.size ? cwd : resolve(cwd ?? '', normalizedText(input.workingDirectory));
    const previous = observation.previous;
    const resolved = input.doubt ? { paths: new Set(), prefixes: new Map(), doubts: new Set([input.doubt]) }
      : previous?.text === input.text && previous.command === input.command && previous.cwd === effectiveCwd &&
          previous.tokens === input.tokens && previous.absoluteOnly === input.absoluteOnly
        ? previous.resolved : resolveReachInput(input, effectiveCwd, candidates);
    if (!input.doubt) observation.previous = { text: input.text, command: input.command, cwd: effectiveCwd,
      tokens: input.tokens, absoluteOnly: input.absoluteOnly, resolved };
    for (const path of resolved.paths) for (const index of candidates.ancestors(path)) observation.matched.add(index);
    for (const [prefix, folder] of resolved.prefixes) for (const index of [...candidates.ancestors(folder), ...candidates.startingWith(prefix)]) {
      if (!observation.matched.has(index)) observation.uncertain.add(index);
    }
    const doubts = new Set([...resolved.doubts, ...workdirDoubts]);
    const roots = new Set([effectiveCwd, cwd].filter(Boolean).map(root => normalizePath(root)));
    if (doubts.size && roots.size) {
      for (const doubt of doubts) recordDoubts.add(doubt);
      for (const root of roots) for (const index of candidates.descendants(root)) {
        if (!observation.matched.has(index)) observation.uncertain.add(index);
      }
    }
  }
  // Count records per class, not tokens, candidates, or overlapping doubt roots.
  for (const doubt of recordDoubts) observation.residual[doubt]++;
}

export function wouldRelease(evidence) {
  return evidence?.state === 'unknown' && evidence.reason === UNRESOLVED_COMMAND && evidence.observed?.state === 'negative';
}

function recordTimestamp(record) {
  // Only a full ISO date-time with an explicit zone establishes a mention time.
  if (typeof record.timestamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(record.timestamp)) return null;
  const timestamp = Date.parse(record.timestamp);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function recentRecord(record, cutoff) {
  if (record.timestamp === undefined) {
    const carriesInput = record.cwd !== undefined || record.payload?.cwd !== undefined ||
      (Array.isArray(record.message?.content) && record.message.content.some(block => block?.type === 'tool_use')) ||
      ['function_call', 'custom_tool_call'].includes(record.payload?.type);
    return !TRANSCRIPT_BOOKKEEPING_TYPES.has(record.type) || carriesInput;
  }
  const timestamp = recordTimestamp(record);
  return timestamp === null || timestamp >= cutoff;
}

const tornTail = Symbol('torn transcript tail');
async function* transcriptRecords(stream) {
  // Streaming decode keeps a split character across chunks; '\n' never occurs
  // inside a UTF-8 sequence, so splitting the decoded text is byte-exact.
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let start = 0, end;
    while ((end = pending.indexOf('\n', start)) !== -1) {
      const line = pending.slice(start, end);
      if (line.trim()) yield parseJson(line, 'Malformed transcript JSONL');
      start = end + 1;
    }
    pending = pending.slice(start);
  }
  // The bounded prefix can end inside a JSON record or a UTF-8 character.
  // Keep raw literal evidence and scoped doubt from an incomplete segment;
  // failing the whole pass here would unnecessarily hold every tree.
  let tail;
  try { tail = pending + decoder.decode(); }
  catch { yield { [tornTail]: pending }; return; }
  if (!tail.trim()) return;
  let record;
  try { record = JSON.parse(tail); }
  catch { yield { [tornTail]: tail }; return; }
  yield record;
}

function transcriptFingerprint(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]; }
function unchangedPrefix(opened, current) {
  return current.isFile() && !current.isSymbolicLink() && sameFile(opened, current) &&
    current.size >= opened.size && (current.size > opened.size ||
      (current.mtimeMs === opened.mtimeMs && current.ctimeMs === opened.ctimeMs));
}

class TranscriptChanged extends Error {}

function claudeSessionId(root, path) {
  const parts = relative(root, path).split(/[\\/]/);
  // Main transcripts are <project>/<session>.jsonl; subagent transcripts belong
  // to <project>/<session>/subagents/, rather than to the agent filename.
  if (parts.length === 2) return parts[1].slice(0, -6) || null;
  return parts.length >= 4 && parts[2] === 'subagents' ? parts[1] || null : null;
}

async function readTranscripts(paths, options, session = { files: new Map(), observed: new Set() }) {
  const counts = paths.map(() => 0);
  const attributed = paths.map(() => /** @type {TranscriptMention[]} */ ([]));
  const attributedDoubts = paths.map(() => /** @type {TranscriptDoubt[]} */ ([]));
  const observedCounts = paths.map(() => 0), observedUncertain = new Set(), residual = doubtCounts();
  const candidates = candidateIndex(paths);
  const uncertain = new Set();
  let failure = null;
  const seen = new Set();
  try {
    const now = time(options), limit = deadline(options), home = options.homeDirectory ?? homedir();
    // Earlier evidence remains in scope throughout classification and rechecks.
    session.cutoff ??= now - WINDOW_MS;
    for (const [kind, root] of [['claude', join(home, '.claude', 'projects')], ['codex', join(home, '.codex', 'sessions')]]) {
      try {
        for (const file of files(root, limit, new Set(), true)) {
          if (!file.path.toLowerCase().endsWith('.jsonl') || file.stat.mtimeMs < session.cutoff) continue;
          seen.add(file.path);
          session.observed.add(file.path);
          for (let attempt = 0; attempt < 2; attempt++) {
            const cached = attempt === 0 ? session.files.get(file.path) : undefined;
            let stream, fd, timer, opened;
            const matched = new Set();
            const latestMentions = new Map();
            const unknownMentionTimes = new Set();
            const doubtTargets = new Set();
            let latestRecordMs = null, unknownRecordTime = false;
            let sessionId = kind === 'claude' ? claudeSessionId(root, file.path) : null;
            let validSessionId = true;
            const fileUncertain = new Set();
            const observation = { matched: new Set(), uncertain: new Set(), residual: doubtCounts(), previous: undefined };
            let cwd, previousInput;
            try {
              checkDeadline(limit);
              if (attempt) file.stat = lstatSync(file.path);
              fd = openRegular(file.path, file.stat);
              checkDeadline(limit);
              opened = fstatSync(fd);
              if (cached && cached.ruleVersion === TRANSCRIPT_BOOKKEEPING_VERSION && cached.reachVersion === TRANSCRIPT_REACH_VERSION && cached.cutoff === session.cutoff &&
                  equal(cached.fingerprint, transcriptFingerprint(opened)) && paths.every(path => cached.results.has(normalizePath(path)))) {
                sessionId = cached.sessionId;
                latestRecordMs = cached.latestRecordMs;
                unknownRecordTime = cached.unknownRecordTime;
                for (let index = 0; index < paths.length; index++) {
                  const result = cached.results.get(normalizePath(paths[index]));
                  if (result.matched) matched.add(index);
                  if (result.mention) {
                    latestMentions.set(index, result.mention.latestMentionMs);
                    if (result.mention.unknownTime) unknownMentionTimes.add(index);
                  }
                  if (result.uncertain) fileUncertain.add(index);
                  if (result.doubt) doubtTargets.add(index);
                  if (result.observed.matched) observation.matched.add(index);
                  if (result.observed.uncertain) observation.uncertain.add(index);
                }
                Object.assign(observation.residual, cached.residual);
              } else if (opened.size > 0) {
              stream = createReadStream(file.path, { fd, autoClose: false, start: 0, end: opened.size - 1 });
              // A stalled stream must not outlive the run just because no next
              // line arrives at which to check the clock.
              timer = setTimeout(() => stream.destroy(new Error('Activity scan timed out')),
                Math.max(1, Math.min(limit.end - performance.now(), remainingTime(options))));
              for await (const record of transcriptRecords(stream)) {
                checkDeadline(limit);
                if (record?.[tornTail] !== undefined) {
                  unknownRecordTime = true;
                  // Keep the nightly rule's literals and doubt; attribute literal
                  // tail mentions conservatively to the current run time.
                  const literals = new Set();
                  candidates.absoluteReferences(normalizedText(record[tornTail]), literals);
                  for (const path of literals) for (const index of candidates.ancestors(path)) {
                    matched.add(index);
                    observation.matched.add(index);
                    latestMentions.set(index, latestMentions.get(index) ?? null);
                    unknownMentionTimes.add(index);
                  }
                  if (cwd) {
                    for (const index of candidates.descendants(cwd)) {
                      doubtTargets.add(index);
                      if (!matched.has(index)) fileUncertain.add(index);
                      if (!observation.matched.has(index)) observation.uncertain.add(index);
                    }
                    observation.residual.other++;
                  }
                  continue;
                }
                requireEvidence(record && typeof record === 'object' && !Array.isArray(record), 'Invalid transcript record');
                const recordTime = recordTimestamp(record);
                if (recordTime === null) unknownRecordTime = true;
                else latestRecordMs = Math.max(latestRecordMs ?? -Infinity, recordTime);
                // Identity comes from the rollout itself, including old metadata.
                // Missing or conflicting IDs affect attribution only.
                if (kind === 'codex' && record.type === 'session_meta') {
                  const id = typeof record.payload?.id === 'string' && record.payload.id.trim() ? record.payload.id : null;
                  validSessionId &&= id !== null && (sessionId === null || sessionId === id);
                  sessionId ??= id;
                }
                // Old records still establish context for later relative inputs.
                const recordedCwd = record.cwd !== undefined ? record.cwd
                  : (['session_meta', 'turn_context'].includes(record.type) || TRANSCRIPT_BOOKKEEPING_TYPES.has(record.type)) ? record.payload?.cwd : undefined;
                if (recordedCwd !== undefined) {
                  requireEvidence(typeof recordedCwd === 'string', 'Invalid transcript cwd');
                  requireEvidence(isAbsolute(normalizedText(recordedCwd)), 'Transcript cwd is not absolute');
                  cwd = resolve(normalizedText(recordedCwd)).replaceAll('\\', '/').toLowerCase();
                }
                if (!recentRecord(record, session.cutoff)) continue;
                const inputs = recordInputs(record);
                const mentionTimestamp = recordTimestamp(record);
                observeRecord(record, inputs, cwd, candidates, observation);
                // JSONL is always validated; old tool inputs emit no paths or doubt.
                if (!inputs.length) continue;
                // Resolve each input once. Preserve input order: an earlier doubt
                // survives a later hit, but an already matched tree skips doubts.
                for (const input of inputs) {
                  const effectiveCwd = input.workingDirectory === undefined ? cwd : resolve(cwd ?? '', normalizedText(input.workingDirectory));
                  // Consecutive identical commands often recur in polling logs.
                  // Reuse only this pure path parse, after validating each record;
                  // cwd and the candidate index remain part of its context.
                  const resolved = previousInput?.text === input.text && previousInput.command === input.command && previousInput.cwd === effectiveCwd
                    ? previousInput.resolved : resolveInput(input, effectiveCwd, candidates);
                  previousInput = { text: input.text, command: input.command, cwd: effectiveCwd, resolved };
                  for (const path of resolved.paths) {
                    for (const index of candidates.ancestors(path)) {
                      matched.add(index);
                      const previous = latestMentions.get(index);
                      if (mentionTimestamp === null) unknownMentionTimes.add(index);
                      latestMentions.set(index, mentionTimestamp === null ? previous ?? null
                        : Math.max(previous ?? -Infinity, mentionTimestamp));
                    }
                  }
                  // A variable or glob can expand outside the tool's workdir, so
                  // doubt covers the session cwd too, not only the tool workdir.
                  const doubtRoots = new Set([effectiveCwd, cwd].filter(Boolean).map((root) => normalizePath(root)));
                  if (resolved.unresolved) {
                    for (const root of doubtRoots) {
                      for (const index of candidates.descendants(root)) {
                        doubtTargets.add(index);
                        if (!matched.has(index)) fileUncertain.add(index);
                      }
                    }
                  }
                }
              }
              }
              checkDeadline(limit);
              if ((stream && stream.bytesRead !== opened.size) || !unchangedPrefix(opened, fstatSync(fd)) ||
                  !unchangedPrefix(opened, lstatSync(file.path))) throw new TranscriptChanged('Transcript changed during read');
              // Cache only the prefix we actually read, never the grown file's metadata.
              session.files.set(file.path, { fingerprint: transcriptFingerprint(opened), ruleVersion: TRANSCRIPT_BOOKKEEPING_VERSION,
                reachVersion: TRANSCRIPT_REACH_VERSION, cutoff: session.cutoff, residual: observation.residual,
                sessionId: validSessionId ? sessionId : null,
                latestRecordMs, unknownRecordTime,
                results: new Map(paths.map((path, index) => [normalizePath(path), {
                  matched: matched.has(index), uncertain: fileUncertain.has(index), doubt: doubtTargets.has(index),
                  // Retain the marker so cached rechecks use their current clock.
                  mention: latestMentions.has(index) ? { latestMentionMs: latestMentions.get(index), unknownTime: unknownMentionTimes.has(index) } : null,
                  observed: { matched: observation.matched.has(index), uncertain: observation.uncertain.has(index) },
                }])) });
            } catch (error) {
              session.files.delete(file.path);
              // Retry a replaced, truncated or rewritten file once. Growth alone
              // cannot repair a malformed complete line or a genuine read failure.
              let changed = error instanceof TranscriptChanged;
              if (!changed && attempt === 0) {
                try { changed = !unchangedPrefix(opened ?? file.stat, lstatSync(file.path)); } catch { changed = false; }
              }
              if (changed && attempt === 0) continue;
              failure ??= reason('Recent transcript unavailable', error);
            }
            finally {
              clearTimeout(timer);
              if (stream) await new Promise(resolve => stream.close(resolve));
              else if (fd !== undefined) closeSync(fd);
            }
            for (const [index, latestMentionMs] of latestMentions) {
              const identity = validSessionId ? sessionId : null;
              attributed[index].push({ kind, sessionId: identity, filePath: file.path,
                latestMentionMs: unknownMentionTimes.has(index) ? Math.max(latestMentionMs ?? -Infinity, now) : latestMentionMs });
            }
            // Attribute doubt independently of literal hits; a prior hit must not
            // hide a later unresolved command. The nightly rollups stay unchanged.
            for (const index of doubtTargets) attributedDoubts[index].push({ kind,
              sessionId: validSessionId ? sessionId : null, filePath: file.path,
              latestRecordMs: unknownRecordTime || latestRecordMs === null ? Math.max(latestRecordMs ?? -Infinity, now) : latestRecordMs });
            for (const index of fileUncertain) uncertain.add(index);
            for (const index of matched) counts[index]++;
            for (const index of observation.uncertain) observedUncertain.add(index);
            for (const index of observation.matched) observedCounts[index]++;
            for (const name of doubtClasses) residual[name] += observation.residual[name];
            break;
          }
        }
      } catch (error) { failure ??= reason('Transcript directory unavailable', error); }
    }
    // Disappearance or aging-out during a run cannot erase earlier evidence.
    for (const path of session.observed) requireEvidence(seen.has(path), 'Previously scanned transcript disappeared');
    checkDeadline(limit);
  } catch (error) { failure ??= reason('Transcript evidence unavailable', error); }
  // Cache eviction or later recovery cannot repair lost evidence within this run.
  failure = session.failure ??= failure;
  const verdict = (count, doubt) => ({
    ...(failure ? unknown(failure) : doubt ? unknown(UNRESOLVED_COMMAND) : count ? ok({ count }) : negative()),
    literalMatches: count,
  });
  return counts.map((count, index) => {
    const observed = verdict(observedCounts[index], observedUncertain.has(index));
    return { ...(DECIDING_TRANSCRIPT_RULE === 'reach' ? observed : verdict(count, uncertain.has(index))),
      bookkeepingVersion: TRANSCRIPT_BOOKKEEPING_VERSION, observed,
      // Shared per-run counts, repeated on evidence for single-tree recheck consumers.
      residualDoubtCounts: { ...residual },
      attributed: { complete: !failure, mentions: attributed[index], doubts: attributedDoubts[index] } };
  });
}
/** @param {string} path @param {ActivityOptions} options */
export async function transcripts(path, options = {}) { return (await readTranscripts([path], options))[0]; }

/** @param {string} path @param {ActivityOptions} options */
export function fileActivity(path, options = {}) {
  try {
    const now = time(options);
    let newestMtimeMs = null;
    const walk = walkDirectory(path, { softDeadline: options.softDeadline, deadlineNow: options.deadlineNow, timeout: options.walkTimeout, skipDirectories: excluded, visit: ({ stat }) => {
      requireEvidence(!stat.isSymbolicLink(), 'Activity scan encountered a link');
      if (stat.isFile()) {
        requireEvidence(Number.isFinite(stat.mtimeMs), 'Invalid file modification time');
        newestMtimeMs = Math.max(newestMtimeMs ?? -Infinity, stat.mtimeMs);
      }
    } });
    if (walk.state !== 'ok') return walk;
    return newestMtimeMs !== null && newestMtimeMs >= now - WINDOW_MS ? ok({ newestMtimeMs }) : negative();
  } catch (error) { return unknown(reason('File activity unavailable', error)); }
}

/**
 * U3 consumes live: only negative releases R8; ok and unknown both hold.
 * HEAD is U1's classification snapshot, for U5 to compare again before action.
 * Each call refreshes leases and filesystem metadata. Batch collection shares
 * one transcript pass; rechecks reuse unchanged verified file outcomes without
 * retaining tool input or conversation content.
 * @param {Worktree[]} trees @param {ActivityOptions} options
 */
export async function collectActivity(trees, options = {}) {
  const home = resolve(options.homeDirectory ?? homedir());
  const inherited = trees.map(tree => tree.activity && transcriptSessions.get(tree.activity)).find(Boolean);
  const session = inherited?.home === home ? inherited : { home, files: new Map(), observed: new Set(), paths: [] };
  session.paths = [...new Set([...session.paths, ...trees.map(tree => normalizePath(tree.path))])];
  const leaseEvidence = readLeases(options);
  const transcriptEvidence = await readTranscripts(session.paths, options, session);
  return trees.map(tree => {
    const headValue = tree.registration.state === 'ok' ? tree.registration.value.head : null;
    const head = typeof headValue === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(headValue)
      ? ok(headValue) : unknown('Classification HEAD unavailable');
    const signals = { lease: leaseFor(tree.path, leaseEvidence), transcript: transcriptEvidence[session.paths.indexOf(normalizePath(tree.path))], fileActivity: fileActivity(tree.path, options) };
    const doubts = Object.entries({ ...signals, head }).filter(([, result]) => result.state === 'unknown').map(([name]) => name);
    const reasons = Object.entries(signals).filter(([, result]) => result.state === 'ok').map(([name]) => name);
    const live = doubts.length ? unknown('Activity evidence unknown: ' + doubts.join(', ')) : reasons.length ? ok({ reasons }) : negative();
    const liveReasons = Object.entries({ ...signals, head }).filter(([, result]) => result.state !== 'negative').map(([name, result]) => {
      const signal = name === 'fileActivity' ? 'file-activity' : name;
      const code = result.state === 'unknown' && name === 'transcript'
        ? result.reason === 'Recent transcript unavailable: Unresolved relative command path' ? 'unresolved-command' : 'transcript-unreadable'
        : result.state === 'unknown' ? `${signal}-unknown` : signal;
      return { code, state: result.state };
    }).filter(entry => entry.code !== 'head');
    const result = { ...signals, head, live, liveReasons };
    transcriptSessions.set(result, session);
    return result;
  });
}
/** @param {Worktree} tree @param {ActivityOptions} options */
export async function activity(tree, options = {}) { return (await collectActivity([tree], options))[0]; }
