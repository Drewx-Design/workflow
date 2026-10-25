import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { negative, ok, unknown } from './probe.mjs';

const signatures = [Buffer.from([0xc3, 0xa2, 0xe2, 0x82, 0xac]), Buffer.from([0xc3, 0x83, 0xc2])];
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
const encodingAllowlist = new Set([
  'docs/solutions/workflow-issues/codex-mcp-file-rewrite-encoding-corruption-2026-06-22.md',
  'scripts/lint-encoding-corruption.ts',
]);
const binaryExtension = /\.(png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|jsonl|lockb)$/i;

/** Buffer-only counterpart of inspect(); parity is pinned by shared fixtures.
 * ok means findings, negative means none; neither result performs a file read.
 * @param {string} file @param {Buffer} bytes
 */
export function inspectEncoding(file, bytes) {
  if (!Buffer.isBuffer(bytes)) return unknown('Encoding requires a byte buffer');
  if (encodingAllowlist.has(file) || binaryExtension.test(file) || bytes.length > 5_000_000 || bytes.includes(0)) return negative();
  /** @type {{kind: string, line?: number}[]} */
  const findings = [];
  if (bytes.subarray(0, 3).equals(bom)) findings.push({ kind: 'bom' });
  for (const signature of signatures) {
    const at = bytes.indexOf(signature);
    if (at !== -1) findings.push({ kind: 'mojibake', line: bytes.subarray(0, at).toString('utf8').split('\n').length });
  }
  return findings.length ? ok(findings) : negative();
}

function placeholder(value) {
  try { value = decodeURIComponent(value); } catch { return false; }
  return /^(?:<[^<>\r\n]+>|\.{3}|\$\{[^}]+\}|\{\{[^}]+\}\})$/.test(value);
}
// URL passwords only: docs and issue bodies spell example credentials as words
// (postgres://user:pass@localhost). The words are also common real passwords,
// so one is excused only at an example host (see EXAMPLE_URL_HOSTS).
const urlPasswordWords = new Set(['user', 'pass', 'password', 'username', 'secret', 'token']);
/** Closed list, matched as the whole host. `db` is deliberately absent: it is
 * the commonest real compose/k8s service name (postgres://app:secret@db:5432). */
export const EXAMPLE_URL_HOSTS = Object.freeze({
  names: Object.freeze(['localhost', '127.0.0.1', '::1', 'host', 'hostname', 'example', 'server', 'example.com', 'example.org', 'example.net']),
  suffixes: Object.freeze(['.example', '.invalid', '.test', '.localhost', '.example.com', '.example.org', '.example.net']),
});
// The host must end the authority as a URL parser sees it, or the regex
// capture may not be the whole password (pass@localhost;x@prod) or host. So
// the host is followed by a character a parser ends the authority on or
// rejects in a host (raw tab/CR/LF are stripped, so they do not count; JSON
// escapes other than \u do), and no @ appears before the authority ends.
const exampleAuthority = /^(\[::1\]|::1|[a-z0-9.-]+)(?::\d{1,5})?(?=$|[/?# "'`)\]>]|\\[nrt"/])/i;
function urlPasswordPlaceholderWord(password, afterAt) {
  try { if (!urlPasswordWords.has(decodeURIComponent(password).toLowerCase())) return false; } catch { return false; }
  const authority = exampleAuthority.exec(afterAt);
  if (!authority || afterAt.slice(authority[0].length).split(/[/?#\\]/, 1)[0].includes('@')) return false;
  const host = authority[1].toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return EXAMPLE_URL_HOSTS.names.includes(host) || EXAMPLE_URL_HOSTS.suffixes.some(suffix => host.endsWith(suffix));
}
function entropy(value) {
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  return [...counts.values()].reduce((sum, count) => sum - count / value.length * Math.log2(count / value.length), 0);
}
function unmark(value) {
  let start = 0, end = value.length;
  const markers = '*_`"\'';
  while (start < end && markers.includes(value[start])) start++;
  while (end > start && markers.includes(value[end - 1])) end--;
  return value.slice(start, end);
}
function highEntropy(value) { return value.length >= 20 && !placeholder(value) && entropy(value) >= 3.5; }
// Entropy rules only (#2409). Quoted code (xs.some((token)...) and Markdown
// prose cells are not credentials, but a token written beside them still is.
// A value holding whitespace, or starting as a member call, is judged by its
// whitespace-free segments. A segment is skipped when it is shaped like words
// and no word part mixes lower case, upper case and digits: split on
// non-alphanumerics (which also covers JSON escapes and parentheses), each
// part is a number or camelCase/CAPS words (a two-letter word needs a vowel,
// and no one word or number reaches 20 characters) with optional trailing
// digits. Identifiers, slugs, paths and URLs fit;
// random tokens do not. Any other value, parentheses included, is judged
// whole. Decision table and recorded residuals: the #2409 policy tests.
const memberCall = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\(/;
function wordPart(part) {
  const tokens = part.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|[0-9]+/g) ?? [];
  return tokens.every((token, index) => token.length < 20 && (/^[0-9]+$/.test(token)
    ? index === tokens.length - 1 : !/^[A-Z][a-z]$/.test(token) || /[AEIOUYaeiouy]/.test(token)));
}
function wordParts(segment) { return segment.split(/[^A-Za-z0-9]+/).filter(Boolean); }
function mixesClasses(part) { return /[a-z]/.test(part) && /[A-Z]/.test(part) && /[0-9]/.test(part); }
function secretSegment(segment) {
  if (!highEntropy(segment)) return false;
  const parts = wordParts(segment);
  return !parts.every(wordPart) || parts.some(mixesClasses);
}
function secretValue(value) {
  if (!/\s/.test(value) && !memberCall.test(value)) return highEntropy(value);
  return value.split(/\s+/).some(secretSegment);
}
/** No findings include matched content: reports must not become secret copies.
 * @param {Buffer} bytes
 */
export function scanSecrets(bytes) {
  if (!Buffer.isBuffer(bytes)) return unknown('Secret scan requires a byte buffer');
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return unknown('Secret scan requires valid UTF-8'); }
  const patterns = [
    ['private-key', /-----BEGIN [^\r\n]*PRIVATE KEY-----/],
    ['token-prefix', /\b(?:ghp_|gho_|github_pat_|sk-|(?:sk|rk|pk)_(?:live|test)_|whsec_|npg_|AKIA|xox[bp]-|re_[A-Za-z0-9]{8,}_|signkey-(?:prod|test|branch)-|phx_)[A-Za-z0-9_=-]+/],
    ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ];
  for (const [kind, pattern] of patterns) if (pattern.test(text)) return ok({ kind });
  for (const match of text.matchAll(/Authorization\s*:\s*Bearer\s+([^\s"'`]+)/gi)) {
    if (!placeholder(match[1])) return ok({ kind: 'bearer' });
  }
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]+)@/gi)) {
    if (!placeholder(match[1]) && !urlPasswordPlaceholderWord(match[1], text.slice(match.index + match[0].length))) return ok({ kind: 'url-credentials' });
  }
  // Shell, JSON, YAML and Markdown examples; quoted names/values included.
  // Bound the name and require its start boundary so a long word cannot retry
  // the assignment pattern at every character. Scan the entire document.
  for (const match of text.matchAll(/(?<![a-z0-9_.-])([a-z_][a-z0-9_.-]{0,255})[*_"'`]{0,8}\s*[:=]\s*["'`*_]{0,8}([^\s"'`,;]+)/gi)) {
    const name = unmark(match[1]), value = unmark(match[2]);
    if (/(token|secret|key|password)/i.test(name) && secretValue(value)) {
      return ok({ kind: 'high-entropy-assignment' });
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const cells = line.split('|');
    for (let index = 0; index < cells.length - 1; index++) {
      const value = unmark(cells[index + 1].trim());
      if (/(token|secret|key|password)/i.test(unmark(cells[index].trim())) && secretValue(value)) {
        return ok({ kind: 'high-entropy-table' });
      }
    }
  }
  return negative();
}

function safeRelative(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\:\0]/.test(path) &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino; }
/** Validate all ancestors and the opened file before the single byte read. */
function readCandidate(root, path) {
  const full = resolve(root, path), directory = dirname(full), volume = parse(directory).root;
  let current = volume;
  for (const part of ['', ...relative(volume, directory).split(sep).filter(Boolean)]) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Linked or unavailable rescue directory');
  }
  const before = lstatSync(full);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Rescue entry is not a regular file');
  const fd = openSync(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFile(before, opened)) throw new Error('Rescue file identity changed');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (!sameFile(opened, after) || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw new Error('Rescue file changed during read');
    return bytes;
  } finally { closeSync(fd); }
}

function reject(reason) { return { ...negative(), reason }; }
/**
 * Admission is all-or-nothing. U4 must publish these buffers/recorded blobs,
 * never re-read an admitted path to obtain upload bytes. Hashing is read-only;
 * U4 will write the same buffer using hash-object -w --stdin and verify its SHA.
 * @param {object} tree
 * @param {{readFile?: (root: string, path: string) => Buffer}} options
 */
export function admitRescue(tree, options = {}) {
  try {
    if (tree.registration?.state !== 'ok' || tree.status?.state !== 'ok' || tree.ignored?.state !== 'ok') return unknown('Admission inventory unavailable');
    const { head } = tree.registration.value, entries = tree.status.value.entries;
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head ?? '') || !Array.isArray(entries)) return unknown('Admission HEAD or entries unavailable');
    if (entries.some((entry) => entry.index !== ' ' && !(entry.index === '?' && entry.worktree === '?'))) return reject('staged');
    if (tree.ignored.value.unexpected.length || !entries.length || entries.some((entry) =>
      entry.originalPath !== undefined || !((entry.index === '?' && entry.worktree === '?') || (entry.index === ' ' && entry.worktree === 'M')) || !entry.path.endsWith('.md'))) return reject('leftovers');
    if (entries.some((entry) => !safeRelative(entry.path)) || new Set(entries.map((entry) => entry.path.toLowerCase())).size !== entries.length) return unknown('Unsafe or duplicate rescue path');
    const treeName = basename(resolve(tree.path));
    const destinations = entries.map((entry) => `docs/rescued/${treeName}-${head.slice(0, 7)}/${entry.path}`);
    if (destinations.some((path) => 38 + 1 + path.length >= 240)) return reject('path-budget');
    const files = [];
    for (const [index, entry] of entries.entries()) {
      let bytes;
      try { bytes = (options.readFile ?? readCandidate)(tree.path, entry.path); }
      catch { return unknown('Rescue file read failed'); }
      if (!Buffer.isBuffer(bytes)) return unknown('Rescue file read did not return bytes');
      // inspect() skips binaries/large files. Such a skip is insufficient proof
      // for publication, so admission holds instead of treating it as clean.
      if (bytes.length > 5_000_000 || bytes.includes(0)) return unknown('Rescue encoding scan cannot cover these bytes');
      // Do not inherit the source linter allowlist for publication destinations.
      const encoding = inspectEncoding(destinations[index], bytes);
      if (encoding.state === 'unknown') return encoding;
      if (encoding.state === 'ok') return reject('encoding');
      const secrets = scanSecrets(bytes);
      if (secrets.state === 'unknown') return secrets;
      if (secrets.state === 'ok') return reject('secret-shape');
      const blobSha = createHash(head.length === 64 ? 'sha256' : 'sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
      files.push({ path: entry.path, rescuedPath: destinations[index], kind: entry.index === '?' ? 'untracked' : 'modified', bytes, blobSha });
    }
    return ok({ files });
  } catch { return unknown('Rescue admission evidence unavailable'); }
}

export const SCRATCH_PATHS = Object.freeze(['artifacts/github-issue-roadmap/', '.reproduce-out/', '.tmp-intake/']);
export const SECRET_NAME_PATTERNS = Object.freeze([
  /^\.env(?:\..*)?$/i,
  /\.pem(?:\.(?:backup|bak|orig))?$/i,
  /\.key(?:\.(?:backup|bak|orig))?$/i,
  /\.p12(?:\.(?:backup|bak|orig))?$/i,
  /\.pfx(?:\.(?:backup|bak|orig))?$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
]);

/** Classify inventory paths only; byte scanning belongs to snapshot preflight.
 * @param {object} tree
 */
export function classifyScratch(tree) {
  try {
    if (tree.status?.state !== 'ok' || tree.ignored?.state !== 'ok') return unknown('Scratch inventory unavailable');
    const entries = tree.status.value.entries, ignored = tree.ignored.value.unexpected;
    if (!Array.isArray(entries) || !Array.isArray(ignored) || tree.status.value.clean !== (entries.length === 0)) return unknown('Scratch entries unavailable');
    const normalize = path => {
      if (typeof path !== 'string') throw new Error('Missing scratch path');
      const normalized = path;
      if (!safeRelative(normalized.endsWith('/') ? normalized.slice(0, -1) : normalized)) throw new Error('Unsafe scratch path');
      return normalized;
    };
    const paths = entries.map(entry => normalize(entry.path)), ignoredPaths = ignored.map(normalize);
    if (entries.some(entry => typeof entry.index !== 'string' || typeof entry.worktree !== 'string')) return unknown('Scratch status unavailable');
    const inside = path => SCRATCH_PATHS.some(prefix => path.toLowerCase().startsWith(prefix));
    const scratch = (entries.length > 0 || ignored.length > 0) && entries.every((entry, index) =>
      entry.originalPath === undefined && ((entry.index === '?' && entry.worktree === '?') || (entry.index === ' ' && entry.worktree === 'M')) && inside(paths[index])) && ignoredPaths.every(inside);
    if (!scratch) return ok({ scratch: false, nameHits: [] });
    // Ignored directories arrive as trailing-slash entries. Only these entries
    // are visible here; U3 expands directories and re-applies the name gate per file.
    const candidates = [...paths.filter((_path, index) => entries[index].index === '?'), ...ignoredPaths];
    const nameHits = [...new Set(candidates.filter(path => {
      const name = path.replace(/\/$/, '').split('/').at(-1);
      return SECRET_NAME_PATTERNS.some(pattern => pattern.test(name));
    }))];
    return ok({ scratch: true, nameHits });
  } catch { return unknown('Scratch path evidence unavailable'); }
}
