import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { negative, ok, resolveExecutable, unknown } from './probe.mjs';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GENERATION = /^chore\/rescued-docs-[0-9]{8}(?:-[2-9][0-9]*|-[1-9][0-9]+)?$/;
const SCHEMA = 'worktree-cleanup-rescue/v1';
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null';

/** Subprocess boundary, including buffer stdin (U1's read-only probe has no stdin).
 * @param {string} executable @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, input?: Buffer|string, timeout?: number}} options
 * @returns {import('./probe.mjs').ProbeResult<string>}
 */
export function runRescueCommand(executable, args, options = {}) {
  if (!isAbsolute(executable)) return unknown('Publisher executable must be absolute');
  try {
    const result = spawnSync(executable, args, { ...options, input: typeof options.input === 'string' ? Buffer.from(options.input) : options.input, shell: false, windowsHide: true,
      timeout: options.timeout ?? 30_000, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer' });
    const stderr = result.stderr?.toString('utf8') ?? '';
    if (result.error || result.signal || result.status !== 0) return unknown('Publisher command failed', stderr, result.status);
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(result.stdout), stderr, result.status);
  } catch { return unknown('Publisher command could not execute or parse'); }
}
function checked(result) {
  if (result?.state !== 'ok' || typeof result.value !== 'string') throw new Error('Publisher command unavailable');
  return result.value;
}
function sha(value) {
  const text = value.trim();
  if (!OID.test(text)) throw new Error('Invalid Git object identity');
  return text;
}
function parseJson(text) {
  try { return JSON.parse(text); } catch { throw new Error('Invalid publication JSON'); }
}
function safePath(path) {
  return typeof path === 'string' && path.length > 0 && !/[\\:\x00-\x1f\x7f]/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git');
}
function normalizeTree(tree, withBytes) {
  if (!tree || typeof tree.path !== 'string' || !isAbsolute(tree.path) || !OID.test(tree.head ?? '') ||
      !(tree.branch === null || typeof tree.branch === 'string') || !Array.isArray(tree.files) || !tree.files.length) throw new Error('Invalid rescue disposition');
  const name = basename(resolve(tree.path));
  const seen = new Set();
  const files = tree.files.map((file) => {
    const path = file.path?.replaceAll('\\', '/');
    const rescuedPath = file.rescuedPath?.replaceAll('\\', '/');
    if (!safePath(path) || !safePath(rescuedPath) || !path.endsWith('.md') ||
        rescuedPath !== `docs/rescued/${name}-${tree.head.slice(0, 7)}/${path}` ||
        !OID.test(file.blobSha ?? '') || file.blobSha.length !== tree.head.length ||
        !['untracked', 'modified'].includes(file.kind) || seen.has(rescuedPath.toLowerCase()) ||
        (withBytes && !Buffer.isBuffer(file.bytes))) throw new Error('Unsafe or incomplete admitted file');
    seen.add(rescuedPath.toLowerCase());
    return { path, rescuedPath, kind: file.kind, blobSha: file.blobSha, ...(withBytes ? { bytes: file.bytes } : {}) };
  });
  return { path: tree.path, head: tree.head, branch: tree.branch, sourcePr: tree.sourcePr ?? null,
    runDate: tree.runDate, files };
}
function manifest(trees) {
  // The manifest is cumulative across every commit in this generation.
  return 'Rescued worktree documents. Review these copies before merging.\n\n' +
    trees.map((tree) => `Worktree: ${tree.path}\nBranch: ${tree.branch ?? '(detached)'}\nSource PR: ${tree.sourcePr ?? '(none)'}\nRun date: ${tree.runDate}\n` +
      tree.files.map((file) => `- ${file.path} → ${file.rescuedPath} (${file.blobSha})`).join('\n')).join('\n\n');
}
function readJournal(path, identity) {
  if (!existsSync(path)) return null;
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Journal must be a regular file');
  const value = parseJson(readFileSync(path, 'utf8'));
  if (value.schema !== SCHEMA || value.identity !== identity || !GENERATION.test(value.generation ?? '') ||
      !['not_pushed', 'pushed_unverified', 'published_verified'].includes(value.state) ||
      !OID.test(value.baseSha ?? '') || !OID.test(value.commitSha ?? '') || !OID.test(value.treeSha ?? '') ||
      !Array.isArray(value.trees) || !value.trees.length || typeof value.prConfirmed !== 'boolean' ||
      !Array.isArray(value.admittedPaths) || !value.admittedPaths.length ||
      value.admittedPaths.some((path) => !safePath(path) || !path.startsWith('docs/rescued/') || !path.endsWith('.md'))) throw new Error('Invalid or foreign rescue journal');
  value.trees = value.trees.map((tree) => normalizeTree(tree, false));
  const paths = value.trees.flatMap((tree) => tree.files.map((file) => file.rescuedPath));
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length ||
      value.admittedPaths.some((path) => !paths.includes(path))) throw new Error('Ambiguous journal paths');
  return value;
}
function saveJournal(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + '\n', 'utf8'); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function lockJournal(path) {
  // A killed process leaves a recoverable lock; an alive or ambiguous owner holds.
  const lock = `${path}.lock`;
  if (existsSync(lock)) {
    const stat = lstatSync(lock);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe journal lock');
    const pid = Number(readFileSync(lock, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Unknown journal lock owner');
    try { process.kill(pid, 0); throw new Error('Rescue journal is in use'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    unlinkSync(lock);
  }
  const fd = openSync(lock, 'wx', 0o600);
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  return () => unlinkSync(lock);
}
function parseTree(raw) {
  const entries = new Map();
  if (raw && !raw.endsWith('\0')) throw new Error('Incomplete tree readback');
  for (const row of raw.split('\0').filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}|[a-f0-9]{64})\t([\s\S]+)$/.exec(row);
    if (!match || entries.has(match[4])) throw new Error('Invalid tree readback');
    entries.set(match[4], { mode: match[1], type: match[2], sha: match[3] });
  }
  return entries;
}
function matchesFiles(entries, trees) {
  return trees.every((tree) => tree.files.every((file) => {
    const entry = entries.get(file.rescuedPath);
    return entry?.mode === '100644' && entry.type === 'blob' && entry.sha === file.blobSha;
  }));
}
function assertCommit(git, record) {
  const parents = git(['rev-list', '--parents', '-n', '1', record.commitSha]).trim().split(' ');
  if (parents.length !== 2 || parents[0] !== record.commitSha || parents[1] !== record.baseSha ||
      sha(git(['rev-parse', `${record.commitSha}^{tree}`])) !== record.treeSha) throw new Error('Journal commit ancestry or tree mismatch');
  const raw = git(['diff-tree', '--no-commit-id', '--no-renames', '--name-only', '-r', '-z', record.baseSha, record.commitSha, '--']);
  if (raw && !raw.endsWith('\0')) throw new Error('Incomplete commit diff');
  const allowed = new Set(record.admittedPaths);
  if (raw.split('\0').filter(Boolean).some((path) => !path.startsWith('docs/rescued/') || !path.endsWith('.md') || !allowed.has(path))) {
    throw new Error('Commit diff escapes admitted rescue paths');
  }
  if (!matchesFiles(parseTree(git(['ls-tree', '-r', '-z', record.commitSha])), record.trees)) throw new Error('Commit does not contain admitted blobs');
}

/**
 * Publish U3's in-memory rescue dispositions. Never reads a source document.
 * The envelope is ok when per-tree results are available; U5 must require
 * worktrees[i].verified.state === 'ok', then perform its own current-byte check.
 * unknown/negative never authorize removal. Empty input recovers pending work.
 * A journal is bound to one repository/remote; callers must retain it across runs.
 * runGh(args, options) and runGit(executable, args, options) return U1 tri-states.
 * @param {{primaryPath: string, worktrees: object[]}} plan
 * @param {{journalPath: string, remotePath?: string, repository?: string, gitPath?: string, ghPath?: string,
 * now?: string, timeout?: number, runGit?: typeof runRescueCommand,
 * runGh?: (args: string[], options: object) => object|Promise<object>}} options
 */
export async function publishRescues(plan, options) {
  let record = null, requested = [], release, scratch;
  const result = (verification) => ok({ generation: record?.generation ?? null, journalState: record?.state ?? null,
    prUrl: record?.prConfirmed ? record.prUrl : null,
    worktrees: requested.map((tree) => ({ path: tree.path, head: tree.head, verified: verification,
      files: tree.files.map(({ bytes, ...file }) => file) })) });
  try {
    if (!plan || typeof plan.primaryPath !== 'string' || !isAbsolute(plan.primaryPath) || !Array.isArray(plan.worktrees) || !options?.journalPath) return unknown('Publisher requires a plan and journal path');
    try { requested = plan.worktrees.filter((tree) => tree?.disposition === 'rescue').map((tree) => normalizeTree(tree, true)); }
    catch { return unknown('Invalid rescue dispositions'); }
    const now = options.now ?? new Date().toISOString();
    if (!/^\d{4}-\d{2}-\d{2}T/.test(now) || !Number.isFinite(Date.parse(now))) throw new Error('Invalid publication date');
    const executable = resolveExecutable(options.gitPath ?? 'git');
    if (executable.state !== 'ok') throw new Error('Git unavailable');
    const repository = options.repository ?? 'example-org/example-repo';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository identity');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
      GIT_AUTHOR_NAME: 'Workflow tools Rescue Publisher', GIT_AUTHOR_EMAIL: 'rescue@localhost.invalid',
      GIT_COMMITTER_NAME: 'Workflow tools Rescue Publisher', GIT_COMMITTER_EMAIL: 'rescue@localhost.invalid' };
    const git = (args, extra = {}) => checked((options.runGit ?? runRescueCommand)(executable.value,
      ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', plan.primaryPath, ...args], { cwd: plan.primaryPath, env, timeout: options.timeout, ...extra }));
    let remote;
    if (options.remotePath !== undefined) {
      if (!isAbsolute(options.remotePath) || !lstatSync(options.remotePath).isDirectory() || lstatSync(options.remotePath).isSymbolicLink()) throw new Error('Local remote must be an absolute bare repository directory');
      remote = resolve(options.remotePath);
      if (git(['-C', remote, 'rev-parse', '--is-bare-repository']).trim() !== 'true') throw new Error('Local remote is not bare');
      // Supplying a local remote must never accidentally invoke real gh.
      if (!options.runGh) throw new Error('Local remote requires an injected gh runner');
    } else {
      remote = `https://github.com/${repository}.git`;
      if (git(['remote', 'get-url', 'origin']).trim().replace(/\.git$/, '') !== remote.replace(/\.git$/, '')) throw new Error('Origin does not match the publication repository');
    }
    const network = ['-c', 'protocol.allow=never', '-c', `protocol.${options.remotePath ? 'file' : 'https'}.allow=always`,
      '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
    const remoteHead = (branch) => {
      const ref = `refs/heads/${branch}`;
      const raw = git([...network, 'ls-remote', '--heads', remote, ref]).trim();
      if (!raw) return null;
      const rows = raw.split('\n');
      if (rows.length !== 1 || rows[0].split('\t')[1] !== ref) throw new Error('Ambiguous remote ref');
      return sha(rows[0].split('\t')[0]);
    };
    const fetchHead = (branch, expected) => {
      const ref = `refs/worktree-cleanup/rescue/${randomUUID()}`;
      try {
        git([...network, 'fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', remote, `refs/heads/${branch}:${ref}`]);
        if (sha(git(['rev-parse', ref])) !== expected) throw new Error('Fetched ref differs from remote observation');
        return parseTree(git(['ls-tree', '-r', '-z', ref]));
      } finally { git(['update-ref', '-d', ref]); }
    };
    let ghExecutable;
    if (!options.runGh) {
      const found = resolveExecutable(options.ghPath ?? 'gh');
      if (found.state !== 'ok') throw new Error('GitHub CLI unavailable');
      ghExecutable = found.value;
    }
    const gh = async (args) => checked(await (options.runGh ? options.runGh(args, { cwd: plan.primaryPath, env, timeout: options.timeout }) :
      runRescueCommand(ghExecutable, args, { cwd: plan.primaryPath, env, timeout: options.timeout })));
    const readPr = async (generation) => {
      const rows = parseJson(await gh(['pr', 'list', '--repo', repository, '--state', 'all', '--limit', '100', '--head', generation,
        '--json', 'number,state,isDraft,headRefName,headRefOid,baseRefName,url,body']));
      if (!Array.isArray(rows) || rows.length > 1) throw new Error('Generation PR identity is ambiguous');
      if (!rows.length) return null;
      const pr = rows[0];
      if (!['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) || !Number.isSafeInteger(pr.number) || pr.number < 1 ||
          pr.headRefName !== generation || pr.baseRefName !== 'main' || !OID.test(pr.headRefOid ?? '') ||
          pr.url !== `https://github.com/${repository}/pull/${pr.number}` || typeof pr.body !== 'string' ||
          (pr.state === 'OPEN' && pr.isDraft !== true)) throw new Error('Invalid generation PR');
      return pr;
    };
    const journalPath = resolve(options.journalPath);
    mkdirSync(dirname(journalPath), { recursive: true });
    release = lockJournal(journalPath);
    const common = resolve(plan.primaryPath, git(['rev-parse', '--git-common-dir']).trim());
    const identity = JSON.stringify([common, remote, repository]);
    record = readJournal(journalPath, identity);
    const save = () => saveJournal(journalPath, record);
    const verify = () => {
      if (remoteHead(record.generation) !== record.commitSha) return false;
      return matchesFiles(fetchHead(record.generation, record.commitSha), record.trees);
    };
    const ensureDraftPr = async () => {
      let pr = await readPr(record.generation);
      const body = manifest(record.trees);
      if (!pr) {
        await gh(['pr', 'create', '--repo', repository, '--draft', '--base', 'main', '--head', record.generation,
          '--title', 'Rescued worktree documents', '--body', body]);
      } else {
        if (pr.state !== 'OPEN' || pr.headRefOid !== record.commitSha) throw new Error('PR changed during publication');
        if (pr.body !== body) await gh(['pr', 'edit', String(pr.number), '--repo', repository, '--body', body]);
      }
      pr = await readPr(record.generation);
      if (!pr || pr.state !== 'OPEN' || pr.headRefOid !== record.commitSha || pr.body !== body || remoteHead(record.generation) !== record.commitSha) throw new Error('Draft PR readback did not match publication');
      record.prConfirmed = true; record.prUrl = pr.url; save();
    };
    const publish = async () => {
      // Recovery must use recorded objects. Never re-read a source path, even if
      // a fresh admission was supplied alongside a missing pending blob.
      for (const tree of record.trees) for (const file of tree.files) {
        if (git(['cat-file', '-t', file.blobSha]).trim() !== 'blob') throw new Error('Recorded rescue blob missing');
      }
      assertCommit(git, record);
      const remoteSha = remoteHead(record.generation);
      if (remoteSha !== record.commitSha) {
        if (record.state !== 'not_pushed' || (remoteSha !== null && remoteSha !== record.baseSha)) throw new Error('Remote generation diverged');
        git([...network, '-c', 'core.hooksPath=NUL', 'push', '--porcelain', remote, `${record.commitSha}:refs/heads/${record.generation}`]);
        record.state = 'pushed_unverified'; record.prConfirmed = false; save();
      }
      if (!verify()) return false;
      record.state = 'published_verified'; record.prConfirmed = false; save();
      await ensureDraftPr();
      return true;
    };

    // Resolve pending publication BEFORE selecting a new generation, including
    // a crash after push that left the durable state at not_pushed.
    let pr = record ? await readPr(record.generation) : null;
    if (record && (!pr || (pr.state === 'OPEN' && (record.state !== 'published_verified' || !record.prConfirmed)))) {
      if (!requested.length) requested = record.trees;
      if (!await publish()) return result(negative());
      pr = await readPr(record.generation);
    }
    if (!requested.length) return result(negative());
    let baseSha, generation, prior = [];
    if (record && pr?.state === 'OPEN') {
      baseSha = remoteHead(record.generation);
      if (baseSha !== pr.headRefOid || !matchesFiles(fetchHead(record.generation, baseSha), record.trees)) throw new Error('Open PR and remote content disagree');
      generation = record.generation; prior = record.trees;
    } else {
      baseSha = remoteHead('main');
      if (!baseSha) throw new Error('Remote main is missing');
      fetchHead('main', baseSha);
      const stem = `chore/rescued-docs-${now.slice(0, 10).replaceAll('-', '')}`;
      for (let suffix = 1; suffix <= 1000; suffix++) {
        const candidate = suffix === 1 ? stem : `${stem}-${suffix}`;
        if (remoteHead(candidate) === null && await readPr(candidate) === null) { generation = candidate; break; }
      }
      if (!generation) throw new Error('No unused rescue generation');
    }
    const trees = prior.map((tree) => ({ ...tree, files: [...tree.files] }));
    const known = new Map(trees.flatMap((tree) => tree.files.map((file) => [file.rescuedPath.toLowerCase(), { tree, file }])));
    const additions = [];
    for (const tree of requested) {
      let target = trees.find((old) => old.path === tree.path && old.head === tree.head);
      if (!target) { target = { ...tree, runDate: now, files: [] }; trees.push(target); }
      for (const file of tree.files) {
        const previous = known.get(file.rescuedPath.toLowerCase());
        if (previous) {
          if (previous.tree.path !== tree.path || previous.tree.head !== tree.head || previous.file.rescuedPath !== file.rescuedPath || previous.file.blobSha !== file.blobSha) throw new Error('Rescue destination collision');
          // A resumed caller may still supply bytes: validate them too.
          if (file.bytes && sha(git(['hash-object', '--stdin'], { input: file.bytes })) !== file.blobSha) throw new Error('Admitted buffer no longer matches blob');
          continue;
        }
        if (!Buffer.isBuffer(file.bytes) || sha(git(['hash-object', '-w', '--stdin'], { input: file.bytes })) !== file.blobSha) throw new Error('Admitted buffer no longer matches blob');
        const { bytes, ...metadata } = file;
        target.files.push(metadata); additions.push(file); known.set(file.rescuedPath.toLowerCase(), { tree: target, file: metadata });
      }
    }
    if (!additions.length) {
      if (!verify()) return result(negative());
      await ensureDraftPr();
      return result(ok({ commitSha: record.commitSha, generation, prUrl: record.prUrl }));
    }
    scratch = mkdtempSync(join(tmpdir(), 'worktree-rescue-index-'));
    const privateEnv = { ...env, GIT_INDEX_FILE: join(scratch, 'index') };
    git(['read-tree', baseSha], { env: privateEnv });
    for (const file of additions) git(['update-index', '--add', '--cacheinfo', '100644', file.blobSha, file.rescuedPath], { env: privateEnv });
    const treeSha = sha(git(['write-tree'], { env: privateEnv }));
    const commitSha = sha(git(['commit-tree', treeSha, '-p', baseSha], { input: `Rescue worktree documents ${now}\n` }));
    record = { schema: SCHEMA, identity, generation, state: 'not_pushed', baseSha, commitSha, treeSha,
      trees, admittedPaths: additions.map((file) => file.rescuedPath), prConfirmed: false, prUrl: null };
    assertCommit(git, record); save();
    if (!await publish()) return result(negative());
    return result(ok({ commitSha, generation, prUrl: record.prUrl }));
  } catch (error) {
    // Never include stderr, buffers or gh response bodies in a cleanup report.
    return result(unknown(error instanceof Error ? error.message : 'Rescue publication failed'));
  } finally {
    // Housekeeping failures must not turn a tri-state API into a thrown error.
    try { if (scratch) rmSync(scratch, { recursive: true, force: true }); } catch { /* Private index may be inspected later. */ }
    try { if (release) release(); } catch { /* A retained lock holds the next call. */ }
  }
}

/** Local-only manual harness. Its private bare object store and simulated PR
 * registry persist beside the journal, so repeated CLI runs exercise recovery.
 * No checkout is staged and no real gh command is ever invoked.
 * @param {{primaryPath: string, worktrees: object[]}} plan
 * @param {{remotePath: string, journalPath?: string, gitPath?: string, timeout?: number}} options
 */
export async function rescueDryRun(plan, options) {
  try {
    if (!options.remotePath || !isAbsolute(options.remotePath)) return unknown('rescue-dry-run requires an absolute --remote-path to a local bare repository');
    const executable = resolveExecutable(options.gitPath ?? 'git');
    if (executable.state !== 'ok') return executable;
    const remotePath = resolve(options.remotePath);
    if (!lstatSync(remotePath).isDirectory() || lstatSync(remotePath).isSymbolicLink()) return unknown('Local remote must be a directory');
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE, GIT_TERMINAL_PROMPT: '0' };
    const git = (cwd, args) => checked(runRescueCommand(executable.value, ['-C', cwd, ...args], { cwd, env, timeout: options.timeout }));
    if (git(remotePath, ['rev-parse', '--is-bare-repository']).trim() !== 'true') return unknown('Local remote is not bare');
    const format = git(remotePath, ['rev-parse', '--show-object-format']).trim();
    if (!['sha1', 'sha256'].includes(format)) return unknown('Unsupported remote object format');
    const journalPath = options.journalPath ? resolve(options.journalPath) : join(mkdtempSync(join(tmpdir(), 'rescue-dry-run-')), 'journal.json');
    const localRepository = `${journalPath}.git`, prPath = `${journalPath}.prs.json`;
    if (!existsSync(localRepository)) {
      mkdirSync(localRepository, { recursive: true });
      git(localRepository, ['init', '--bare', `--object-format=${format}`, '--initial-branch=main']);
    }
    if (git(localRepository, ['rev-parse', '--is-bare-repository']).trim() !== 'true') return unknown('Dry-run object store must be bare');
    const prs = existsSync(prPath) ? JSON.parse(readFileSync(prPath, 'utf8')) : [];
    if (!Array.isArray(prs)) return unknown('Invalid simulated PR registry');
    const repository = 'local/rescue-dry-run';
    const runGh = (args) => {
      const generation = args[args.indexOf('--head') + 1];
      if (args[1] === 'list') {
        return ok(JSON.stringify(prs.filter((pr) => pr.headRefName === generation).map((pr) => ({ ...pr,
          headRefOid: pr.state === 'OPEN' ? sha(git(remotePath, ['rev-parse', `refs/heads/${generation}`])) : pr.headRefOid }))));
      }
      const body = args[args.indexOf('--body') + 1];
      if (args[1] === 'create') {
        const number = prs.length + 1;
        prs.push({ number, state: 'OPEN', isDraft: true, headRefName: generation,
          headRefOid: sha(git(remotePath, ['rev-parse', `refs/heads/${generation}`])), baseRefName: 'main', body,
          url: `https://github.com/${repository}/pull/${number}` });
      } else if (args[1] === 'edit') {
        const pr = prs.find((pr) => pr.number === Number(args[2]));
        if (!pr) return unknown('Simulated PR not found');
        pr.body = body;
      } else return unknown('Unsupported simulated gh command');
      saveJournal(prPath, prs);
      return ok('');
    };
    const publication = await publishRescues({ ...plan, primaryPath: localRepository }, { ...options, remotePath, journalPath, repository, runGh });
    if (publication.state !== 'ok') return publication;
    return ok({ ...publication.value, dryRun: true, journalPath, localRepository, simulatedPrs: prs });
  } catch { return unknown('Local rescue dry run failed'); }
}
