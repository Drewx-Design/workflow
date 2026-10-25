import './worktree-cleanup-test-env';
import { appendFileSync, createReadStream, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, truncateSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activity, collectActivity, fileActivity, leases, transcripts, wouldRelease, DECIDING_TRANSCRIPT_RULE, TRANSCRIPT_BOOKKEEPING_VERSION, TRANSCRIPT_REACH_VERSION } from "../lib/worktree-cleanup/activity.mjs";
import { inventory, normalizePath } from "../lib/worktree-cleanup/inventory.mjs";
import { negative, ok, unknown } from "../lib/worktree-cleanup/probe.mjs";
import { ownerLivenessReason, releasesUnresolvedDoubt } from "../lib/worktree-cleanup/policy.mjs";
import { main } from "../worktree-cleanup.mjs";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createReadStream: vi.fn(fs.createReadStream), fstatSync: vi.fn(fs.fstatSync), openSync: vi.fn(fs.openSync), readdirSync: vi.fn(fs.readdirSync), lstatSync: vi.fn(fs.lstatSync) };
});
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, homedir: vi.fn(() => { throw new Error("Tests must inject homeDirectory"); }) };
});
vi.mock("../lib/worktree-cleanup/inventory.mjs", async (original) => {
  const inventoryModule = await original<typeof import("../lib/worktree-cleanup/inventory.mjs")>();
  return { ...inventoryModule, inventory: vi.fn(inventoryModule.inventory) };
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-09-26T12:00:00Z");
const HEAD = "a".repeat(40);
const timestamp = (ageHours = 1) => new Date(NOW - ageHours * HOUR).toISOString();
const roots: string[] = [], junctions: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.mocked(homedir).mockImplementation(() => { throw new Error("Tests must inject homeDirectory"); });
  // A junction is removed with rmdir on Windows; on Linux the fixture is a
  // directory symlink, which rmdir refuses (ENOTDIR) and unlink removes.
  for (const path of junctions.splice(0)) { if (process.platform === "win32") rmdirSync(path); else unlinkSync(path); }
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cleanup-activity-")); roots.push(root);
  const homeDirectory = join(root, "home"), path = join(root, "bt-x"), codexJobStateDirectory = join(root, "jobs");
  mkdirSync(homeDirectory); mkdirSync(path);
  const options = { homeDirectory, codexJobStateDirectory, now: () => NOW, pidAlive: () => false };
  function file(path: string, text = "fixture", ageHours = 1) {
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text);
    utimesSync(path, new Date(NOW - ageHours * HOUR), new Date(NOW - ageHours * HOUR)); return path;
  }
  function transcript(records: Record<string, unknown>[], source = "claude", ageHours = 1, name = "session.jsonl") {
    return file(join(homeDirectory, source === "claude" ? ".claude/projects/project" : ".codex/sessions/2026/09/26", name), records.map((record) => JSON.stringify({ timestamp: timestamp(ageHours), ...record })).join("\n") + "\n", ageHours);
  }
  function manifest(overrides: Record<string, unknown> = {}, id = "job") {
    return file(join(codexJobStateDirectory, id, "manifest.json"), JSON.stringify({ id, cwd: path, pid: 12345, started_at: new Date(NOW - HOUR).toISOString(), ...overrides }));
  }
  const entry = { path, registration: ok({ head: HEAD }) };
  return { root, path, homeDirectory, codexJobStateDirectory, options, file, transcript, manifest, entry };
}
const edit = (path: string) => ({ timestamp: timestamp(), type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: path } }] } });
const command = (cmd: string) => ({ timestamp: timestamp(), type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd }) } });

describe('attributed transcript mentions', () => {
  it.each([
    { sessionId: 'foreign', hours: 1, tail: false, blocked: true },
    { sessionId: 'foreign', hours: 7, tail: false, blocked: false },
    { sessionId: 'owner', hours: 1, tail: false, blocked: false },
    { sessionId: 'foreign', hours: 7, tail: true, blocked: true },
  ])('attributes target-scoped unresolved doubt: %j', async ({ sessionId, hours, tail, blocked }) => {
    const f = fixture();
    const filePath = f.transcript([
      { type: 'session_meta', timestamp: timestamp(73), payload: { id: sessionId, cwd: f.root } },
      { ...command('cat $FILE'), timestamp: timestamp(hours) },
    ], 'codex');
    if (tail) appendFileSync(filePath, '{"payload":');
    const transcript = await transcripts(f.path, f.options);
    expect(transcript).toMatchObject({ state: 'unknown', literalMatches: 0, attributed: { complete: true,
      mentions: [], doubts: [{ kind: 'codex', sessionId, filePath, latestRecordMs: tail ? NOW : NOW - hours * HOUR }] } });
    expect(ownerLivenessReason({ head: ok(HEAD), lease: negative(), transcript },
      { ...f.options, path: f.path, sessionId: 'owner' }, HEAD)).toBe(blocked ? 'foreign-session-recent' : null);
  });
  it('keeps unknown-time doubt current through cached rechecks and scoped to its cwd', async () => {
    const f = fixture(), other = join(f.root, 'other');
    const filePath = f.transcript([
      { type: 'session_meta', timestamp: timestamp(73), payload: { id: 'foreign', cwd: f.path } },
      { ...command('cat $FILE'), timestamp: undefined },
    ], 'codex');
    const [baseline, unrelated] = await collectActivity([f.entry, { ...f.entry, path: other }], f.options);
    expect(baseline.transcript.attributed).toMatchObject({ doubts: [{ filePath, latestRecordMs: NOW }] });
    expect(unrelated.transcript.attributed).toMatchObject({ doubts: [] });
    vi.mocked(createReadStream).mockClear();
    const cached = await activity({ ...f.entry, activity: baseline }, { ...f.options, now: () => NOW + HOUR });
    expect(cached.transcript.attributed).toMatchObject({ doubts: [{ filePath, latestRecordMs: NOW + HOUR }] });
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('dates doubt by the latest file record even after an older literal match', async () => {
    const f = fixture();
    const filePath = f.transcript([
      { type: 'session_meta', timestamp: timestamp(73), payload: { id: 'foreign', cwd: f.root } },
      { ...edit(f.path), timestamp: timestamp(8) },
      { ...command('cat $FILE'), timestamp: timestamp(7) },
      { type: 'cost-state', timestamp: timestamp(1) },
    ], 'codex');
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.attributed).toMatchObject({ doubts: [{ filePath, latestRecordMs: NOW - HOUR }] });
    expect(ownerLivenessReason({ ...baseline, lease: negative() }, { ...f.options, path: f.path, sessionId: 'owner' }, HEAD)).toBe('foreign-session-recent');
    vi.mocked(createReadStream).mockClear();
    const cached = await activity({ ...f.entry, activity: baseline }, f.options);
    expect(cached.transcript.attributed).toEqual(baseline.transcript.attributed);
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('treats conflicting Codex session_meta ids as unknown and foreign', async () => {
    const f = fixture();
    f.transcript([
      { type: 'session_meta', payload: { id: 'owner', cwd: f.root } },
      { type: 'session_meta', payload: { id: 'other', cwd: f.root } },
      command('cat bt-x/docs/a.md'),
    ], 'codex');
    const transcript = await transcripts(f.path, f.options);
    expect(transcript.attributed.mentions).toEqual([expect.objectContaining({ sessionId: null })]);
    expect(ownerLivenessReason({ head: ok(HEAD), lease: negative(), transcript },
      { ...f.options, path: f.path, sessionId: 'owner' }, HEAD)).toBe('foreign-session-recent');
  });
  it('attributes a recent Claude tool path to the transcript session', async () => {
    const f = fixture(), sessionId = 'owner-session';
    const filePath = f.transcript([{ ...edit(join(f.path, 'docs/a.md')), sessionId, timestamp: timestamp(2) }], 'claude', 1, `${sessionId}.jsonl`);
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId, filePath, latestMentionMs: NOW - 2 * HOUR },
    ] });
  });
  it('attributes a Claude subagent transcript to its parent session', async () => {
    const f = fixture(), sessionId = 'parent-session';
    const filePath = f.transcript([{ ...edit(f.path), sessionId }], 'claude', 1, `${sessionId}/subagents/agent-child.jsonl`);
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId, filePath, latestMentionMs: NOW - HOUR },
    ] });
  });
  it('takes the Codex session identity from old session_meta, rather than the rollout filename', async () => {
    const f = fixture(), sessionId = 'codex-worker';
    const filePath = f.transcript([
      { type: 'session_meta', timestamp: timestamp(73), payload: { id: sessionId, cwd: f.root } },
      command('cat bt-x/docs/a.md'),
    ], 'codex', 1, 'rollout-2026-09-26T11-00-00-filename-id.jsonl');
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'codex', sessionId, filePath, latestMentionMs: NOW - HOUR },
    ] });
  });
  it('keeps one latest mention per file and target, excluding old-only mentions', async () => {
    const f = fixture(), other = join(f.root, 'other');
    const owner = f.transcript([
      { ...edit(f.path), timestamp: timestamp(2) }, edit(other), edit(f.path),
      { ...edit(f.path), timestamp: timestamp(7) }, { ...edit(f.path), timestamp: timestamp(73) },
    ], 'claude', 1, 'owner.jsonl');
    const foreign = f.transcript([{ ...edit(f.path), timestamp: timestamp(72) }], 'claude', 1, 'foreign.jsonl');
    f.transcript([{ ...edit(f.path), timestamp: timestamp(73) }], 'claude', 1, 'old-only.jsonl');
    f.transcript([edit(f.path)], 'claude', 73, 'old-file.jsonl');
    const rows = await collectActivity([f.entry, { ...f.entry, path: other }], f.options);
    expect(rows[0].transcript.attributed).toEqual({ complete: true, doubts: [], mentions: expect.arrayContaining([
      { kind: 'claude', sessionId: 'owner', filePath: owner, latestMentionMs: NOW - HOUR },
      { kind: 'claude', sessionId: 'foreign', filePath: foreign, latestMentionMs: NOW - 72 * HOUR },
    ]) });
    expect(rows[0].transcript.attributed.mentions).toHaveLength(2);
    expect(rows[1].transcript.attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId: 'owner', filePath: owner, latestMentionMs: NOW - HOUR },
    ] });
  });
  it('marks every target incomplete for a malformed complete transcript line', async () => {
    const f = fixture(), other = join(f.root, 'other');
    const filePath = f.transcript([edit(f.path)]);
    f.file(join(f.homeDirectory, '.claude/projects/project/bad.jsonl'), '{bad\n');
    const rows = await collectActivity([f.entry, { ...f.entry, path: other }], f.options);
    expect(rows[0].transcript.attributed).toEqual({ complete: false, doubts: [], mentions: [
      { kind: 'claude', sessionId: 'session', filePath, latestMentionMs: NOW - HOUR },
    ] });
    expect(rows[1].transcript.attributed).toEqual({ complete: false, doubts: [], mentions: [] });
  });
  it('keeps targets complete when an unrelated transcript has a torn tail', async () => {
    const f = fixture(), other = join(f.root, 'other');
    const filePath = f.transcript([edit(f.path)]);
    f.file(join(f.homeDirectory, '.claude/projects/project/unrelated.jsonl'), '{bad');
    const rows = await collectActivity([f.entry, { ...f.entry, path: other }], f.options);
    expect(rows[0].transcript.attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId: 'session', filePath, latestMentionMs: NOW - HOUR },
    ] });
    expect(rows[1].transcript.attributed).toEqual({ complete: true, doubts: [], mentions: [] });
  });
  it.each(['claude', 'codex'])('attributes a torn literal to its %s session with the current run time', async kind => {
    const f = fixture(), sessionId = 'torn-session';
    const records = kind === 'codex' ? [
      { type: 'session_meta', timestamp: timestamp(73), payload: { id: sessionId, cwd: f.root } },
    ] : [];
    const filePath = f.transcript([...records, { ...edit(f.path), timestamp: timestamp(7) }], kind, 1, `${sessionId}.jsonl`);
    appendFileSync(filePath, '{"file_path":' + JSON.stringify(normalizePath(join(f.path, 'docs/a.md'))));
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.attributed).toEqual({ complete: true,
      doubts: kind === 'codex' ? [{ kind, sessionId, filePath, latestRecordMs: NOW }] : [], mentions: [
      { kind, sessionId, filePath, latestMentionMs: NOW },
    ] });
    vi.mocked(createReadStream).mockClear();
    const recheckNow = NOW + 8 * HOUR;
    const cached = await activity({ ...f.entry, activity: baseline }, { ...f.options, now: () => recheckNow });
    expect(cached.transcript.attributed).toEqual({ complete: true,
      doubts: kind === 'codex' ? [{ kind, sessionId, filePath, latestRecordMs: recheckNow }] : [], mentions: [
      { kind, sessionId, filePath, latestMentionMs: recheckNow },
    ] });
    expect(baseline.transcript.attributed.mentions[0].latestMentionMs).toBe(NOW);
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('marks attribution incomplete when a transcript cannot be read', async () => {
    const f = fixture(); f.transcript([edit(f.path)]);
    vi.mocked(createReadStream).mockImplementationOnce(() => { throw new Error('EACCES'); });
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: false, doubts: [], mentions: [] });
  });
  it('replays attributed evidence from the cache and refreshes the latest mention after growth', async () => {
    const f = fixture(), sessionId = 'cached-session';
    const filePath = f.transcript([{ ...edit(f.path), timestamp: timestamp(7) }], 'claude', 1, `${sessionId}.jsonl`);
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId, filePath, latestMentionMs: NOW - 7 * HOUR },
    ] });
    vi.mocked(createReadStream).mockClear();
    const cached = await activity({ ...f.entry, activity: baseline }, f.options);
    expect(cached.transcript.attributed).toEqual(baseline.transcript.attributed);
    expect(createReadStream).not.toHaveBeenCalled();
    appendFileSync(filePath, JSON.stringify(edit(f.path)) + '\n');
    const refreshed = await activity({ ...f.entry, activity: cached }, f.options);
    expect(refreshed.transcript.attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId, filePath, latestMentionMs: NOW - HOUR },
    ] });
    expect(baseline.transcript.attributed.mentions[0].latestMentionMs).toBe(NOW - 7 * HOUR);
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });
  it.each([undefined, 42])('does not invent a Codex identity when session_meta id is %s', async id => {
    const f = fixture();
    const filePath = f.transcript([{ type: 'session_meta', payload: { id } }, edit(f.path)], 'codex');
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'codex', sessionId: null, filePath, latestMentionMs: NOW - HOUR },
    ] });
  });
  it('keeps a Codex mention complete when the rollout has no session_meta record', async () => {
    const f = fixture(), filePath = f.transcript([edit(f.path)], 'codex');
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'codex', sessionId: null, filePath, latestMentionMs: NOW - HOUR },
    ] });
  });
  it.each([undefined, 'not-a-time', timestamp(73).slice(0, -1)])('uses the run clock for an ambiguous mention time (%s)', async value => {
    const f = fixture();
    const filePath = f.transcript([{ ...edit(f.path), timestamp: value }, edit(f.path)]);
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId: 'session', filePath, latestMentionMs: NOW },
    ] });
    vi.mocked(createReadStream).mockClear();
    const recheckNow = NOW + 8 * HOUR;
    const cached = await activity({ ...f.entry, activity: baseline }, { ...f.options, now: () => recheckNow });
    expect(cached.transcript.attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId: 'session', filePath, latestMentionMs: recheckNow },
    ] });
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('keeps a later established mention time alongside an ambiguous timestamp', async () => {
    const f = fixture();
    const filePath = f.transcript([{ ...edit(f.path), timestamp: timestamp(-1) }, { ...edit(f.path), timestamp: undefined }]);
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: true, doubts: [], mentions: [
      { kind: 'claude', sessionId: 'session', filePath, latestMentionMs: NOW + HOUR },
    ] });
  });
  it('uses the existing mention definition, excluding message prose and tool results', async () => {
    const f = fixture();
    f.transcript([
      { type: 'assistant', message: { content: [{ type: 'text', text: f.path }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: f.path }] } },
    ]);
    expect((await transcripts(f.path, f.options)).attributed).toEqual({ complete: true, doubts: [], mentions: [] });
  });
  it.each([false, true])('preserves serialized aggregate and liveness evidence (literal first=%s)', async literalFirst => {
    const f = fixture(), read = edit(f.path), doubt = command('ls $TREE');
    f.transcript([{ cwd: f.root, timestamp: timestamp(73) }, ...(literalFirst ? [read, doubt] : [doubt, read])]);
    const result = await activity(f.entry, f.options);
    const { attributed, ...aggregate } = result.transcript;
    const verdict = literalFirst ? ok({ count: 1 }) : unknown('Recent transcript unavailable: Unresolved relative command path');
    expect(JSON.stringify(aggregate)).toBe(JSON.stringify({ ...verdict, literalMatches: 1,
      bookkeepingVersion: TRANSCRIPT_BOOKKEEPING_VERSION, observed: { ...verdict, literalMatches: 1 },
      residualDoubtCounts: { variable: 1, 'command-substitution': 0, 'chained-cd': 0, 'climb-out': 0,
        'unparsable-exec': 0, 'non-literal-command': 0, other: 0 },
    }));
    expect(JSON.stringify(result.live)).toBe(JSON.stringify(literalFirst ? ok({ reasons: ['transcript'] }) : unknown('Activity evidence unknown: transcript')));
    expect(result.liveReasons).toEqual([{ code: literalFirst ? 'transcript' : 'unresolved-command', state: literalFirst ? 'ok' : 'unknown' }]);
    expect(attributed).toMatchObject({ complete: true, mentions: [{ kind: 'claude', sessionId: 'session' }] });
  });
});

describe("per-record transcript time", () => {
  const worktreeState = (f: ReturnType<typeof fixture>, worktreePath: unknown = f.path) => ({
    type: 'worktree-state', timestamp: undefined,
    worktreeSession: {
      originalCwd: f.root, preEnterOriginalCwd: f.root, worktreePath,
      worktreeName: 'bt-x', worktreeBranch: 'feat/test', sessionId: '0ef40000-0000-4000-8000-000000000000', enteredExisting: true,
    },
    sessionId: '0ef40000-0000-4000-8000-000000000000',
  });
  it.each(['claude', 'codex'])('counts a two-hour-old record in a recently modified %s transcript', async source => {
    const f = fixture();
    f.transcript([{ ...edit(f.path), timestamp: timestamp(2) }], source);
    expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'ok', value: { count: 1 }, bookkeepingVersion: 1 });
  });
  it.each(['claude', 'codex'])('ignores old activity revived by bookkeeping appends in %s', async source => {
    const f = fixture();
    f.transcript([
      { ...edit(f.path), timestamp: timestamp(73) },
      { type: 'cost-state', timestamp: undefined },
      { type: 'last-prompt', timestamp: undefined },
    ], source);
    expect((await transcripts(f.path, f.options)).state).toBe('negative');
  });
  it.each([71, 72, 73])('uses the inclusive record-time cutoff (%i hours) despite recent file mtime', async age => {
    const f = fixture();
    f.transcript([{ ...edit(f.path), timestamp: timestamp(age) }]);
    expect((await transcripts(f.path, f.options)).state).toBe(age <= 72 ? 'ok' : 'negative');
  });
  it.each(['2026-09-23T08:00:00-04:00', '2026-09-23T14:00:00+0200'])('uses the instant of a zoned record timestamp: %s', async value => {
    const f = fixture();
    f.transcript([{ ...edit(f.path), timestamp: value }]);
    expect((await transcripts(f.path, f.options)).state).toBe('ok');
  });
  it.each<[string, unknown, number?]>([
    ['missing', undefined], ['future', timestamp(-1)], ['without zone', timestamp(73).slice(0, -1)],
    ['unparsable', 'not-a-time'], ['empty', ''], ['null', null], ['non-string', NOW - 73 * HOUR],
    ['non-ISO trailing year', '09-30-2026', Date.parse('2026-10-03T01:00:00-04:00')],
    ['RFC-2822 zoned', 'Wed, 23 Sep 2026 08:00:00 -0400', Date.parse('2026-10-03T01:00:00-04:00')],
  ])('holds for a record with a %s timestamp', async (_label, value, recordNow = NOW) => {
    const f = fixture();
    const path = f.transcript([{ ...edit(f.path), timestamp: value }]);
    utimesSync(path, new Date(recordNow - HOUR), new Date(recordNow - HOUR));
    expect((await transcripts(f.path, { ...f.options, now: () => recordNow })).state).toBe('ok');
  });
  it.each([
    'cost-state', 'last-prompt', 'ai-title', 'custom-title', 'mode', 'permission-mode',
    'bridge-session', 'atis-latch', 'history-suppression', 'artifact-autoreact-ledger', 'artifact-comment-monitor',
  ])('ignores only pathless bookkeeping records of type %s', async type => {
    const f = fixture();
    f.transcript([{ cwd: f.root, timestamp: timestamp(73) }, { type, timestamp: undefined }]);
    expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'negative', bookkeepingVersion: TRANSCRIPT_BOOKKEEPING_VERSION });
  });
  it.each(['cwd', 'payload.cwd', 'claude-tool', 'codex-function', 'codex-custom'])('counts a bookkeeping record carrying %s', async field => {
    const f = fixture();
    const input = field === 'cwd' ? { cwd: f.path } : field === 'payload.cwd' ? { payload: { cwd: f.path } }
      : field === 'claude-tool' ? edit(f.path) : field === 'codex-function' ? command(`cat "${f.path}/a.md"`)
        : { payload: { type: 'custom_tool_call', name: 'apply_patch', input: `*** Update File: ${f.path}/a.md` } };
    f.transcript([{ ...input, type: 'cost-state', timestamp: undefined }]);
    expect((await transcripts(f.path, f.options)).state).toBe('ok');
  });
  it('holds for an ambiguous bookkeeping working folder', async () => {
    const f = fixture();
    f.transcript([{ type: 'cost-state', payload: { cwd: 'relative' }, timestamp: undefined }]);
    expect((await transcripts(f.path, f.options)).state).toBe('unknown');
  });
  it.each(['unknown-new-type', 'worktree-state', 'file-history-snapshot'])('counts an unlisted %s record without a timestamp', async type => {
    const f = fixture();
    f.transcript([type === 'worktree-state' ? worktreeState(f) : { type, cwd: f.path, timestamp: undefined }]);
    expect((await transcripts(f.path, f.options)).state).toBe('ok');
  });
  it('counts a timestamp-free worktree-state path after old session metadata elsewhere', async () => {
    const f = fixture();
    f.transcript([
      { type: 'session_meta', timestamp: timestamp(73), payload: { cwd: f.root } },
      worktreeState(f),
      { type: 'cost-state', timestamp: undefined },
    ]);
    expect((await transcripts(f.path, f.options)).state).toBe('ok');
  });
  it('holds as unknown for a non-string worktree-state path', async () => {
    const f = fixture();
    f.transcript([worktreeState(f, 123)]);
    expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Invalid transcript worktree path') });
  });
  it.each(['cwd', 'session_meta', 'turn_context', 'cost-state'])('carries an old %s folder into a recent relative-path record', async type => {
    const f = fixture();
    const old = { timestamp: timestamp(73), ...(type === 'cwd' ? { cwd: f.path } : { type, payload: { cwd: f.path } }) };
    f.transcript([old]);
    expect((await transcripts(f.path, f.options)).state).toBe('negative');
    f.transcript([old, command('cat docs/a.md')]);
    expect((await transcripts(f.path, f.options)).state).toBe('ok');
  });
  it('emits neither paths nor doubt from old tool-input records', async () => {
    const f = fixture();
    f.transcript([
      { cwd: f.root, timestamp: timestamp(73) },
      { ...command('ls $TREE'), timestamp: timestamp(73) },
      { type: 'response_item', timestamp: timestamp(73), payload: { type: 'function_call', arguments: '{bad' } },
    ]);
    expect((await transcripts(f.path, f.options)).state).toBe('negative');
  });
  it('retains the file-mtime pre-filter even for a future record', async () => {
    const f = fixture();
    f.transcript([{ ...edit(f.path), timestamp: timestamp(-1) }], 'claude', 73);
    expect((await transcripts(f.path, f.options)).state).toBe('negative');
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it.each(['ruleVersion', 'cutoff'])('rereads an unchanged transcript with a stale cache %s', async field => {
    const f = fixture(), path = f.transcript([edit(f.path)]);
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.state).toBe('ok');
    vi.mocked(createReadStream).mockClear();
    const original = Map.prototype.get;
    // Model verified file metadata with a prior rule/cutoff and stale negative evidence.
    const stale = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      const value = original.call(this, key);
      return key === path && value?.results instanceof Map ? { ...value, [field]: -1,
        results: new Map([[normalizePath(f.path), { matched: false, uncertain: false }]]) } : value;
    });
    try {
      expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.state).toBe('ok');
      expect(vi.mocked(createReadStream).mock.calls.map(args => args[0])).toEqual([path]);
    } finally { stale.mockRestore(); }
  });
});

describe("transcript activity", () => {
  describe('owner-release commands', () => {
    const shapes = ['Bash', 'PowerShell', 'exec_command', 'shell_command', 'shell-argv'] as const;
    type Shape = typeof shapes[number] | 'argv';
    const zeroCounts = { variable: 0, 'command-substitution': 0, 'chained-cd': 0, 'climb-out': 0,
      'unparsable-exec': 0, 'non-literal-command': 0, other: 0 };
    function record(shape: Shape, text: string, cwd: string, argv?: string[]) {
      if (shape === 'Bash' || shape === 'PowerShell') return {
        type: 'assistant', message: { content: [{ type: 'tool_use', name: shape, input: { command: text } }] },
      };
      if (shape === 'exec_command' || shape === 'shell_command') return {
        type: 'response_item', payload: { type: 'function_call', name: shape,
          arguments: JSON.stringify({ [shape === 'exec_command' ? 'cmd' : 'command']: text, workdir: cwd }) },
      };
      return { type: 'event_msg', payload: { type: 'item_completed', item: {
        type: 'CommandExecution', cwd: pathToFileURL(cwd).href,
        command: shape === 'argv' ? argv : ['powershell', '-Command', text],
      } } };
    }
    function write(f: ReturnType<typeof fixture>, shape: Shape, text: string, cwd: string, argv?: string[]) {
      f.transcript([{ cwd, timestamp: timestamp(73) }, record(shape, text, cwd, argv)],
        shape === 'Bash' || shape === 'PowerShell' ? 'claude' : 'codex');
    }
    const releases = [
      'release-worktree.ps1 -Path <tree>',
      'release-worktree.ps1 <tree>',
      '& "$env:LOCALAPPDATA\\WorkflowTools\\worktree-cleanup\\release-worktree.ps1" -Path <tree>',
      '"<primary>/release-worktree.ps1" -OwnerSession owner -Path "<tree>" -NodePath "<primary>/node.exe"',
      "'<primary>/release-worktree.ps1' '<tree>' -owner-session owner",
      'release-worktree.ps1 --owner-session owner <tree>',
      'PoWeRsHeLl.ExE -NoProfile -NonInteractive -ExecutionPolicy Bypass -File release-worktree.ps1 -pAtH <tree>',
      'pwsh -File "<primary>/release-worktree.ps1" <tree>',
      'PWSH.EXE -NonInteractive -NoProfile -File release-worktree.ps1 -Path <tree>',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary>',
      'NODE.EXE "<primary>/worktree-cleanup.mjs" release "<tree>" --repo <primary> --owner-session owner --runner <primary>/run.ps1 --git git --gh gh --report-root <primary>/reports --timeout-ms 1 --walk-timeout-ms 2 --soft-timeout-ms 3',
      // The program options qualify by final path segment, case-insensitively.
      'release-worktree.ps1 -Path <tree> -NodePath <primary>/NODE.EXE',
      'release-worktree.ps1 -Path <tree> -NodePath <primary>/node',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --git <primary>/git.exe --gh <primary>/gh',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --git <primary>/GIT --gh <primary>/Gh.Exe',
    ];
    it.each(shapes.flatMap(shape => releases.map(text => ({ shape, text }))))
      ('drops only the release target in $shape: $text', async ({ shape, text }) => {
        const f = fixture(), primary = join(f.root, 'primary');
        const cmd = text.replaceAll('<tree>', normalizePath(f.path)).replaceAll('<primary>', normalizePath(primary));
        write(f, shape, cmd, primary);
        const row = await transcripts(f.path, f.options);
        expect(row).toMatchObject({ state: 'negative', literalMatches: 0,
          observed: { state: 'negative', literalMatches: 0 }, attributed: { complete: true, mentions: [], doubts: [] } });
        expect(row.residualDoubtCounts).toEqual({ ...zeroCounts, variable: text.includes('$env:') ? 1 : 0 });
      });
    it.each(shapes.flatMap(shape => ['forward', 'backslash', 'quoted space', 'Git Bash', 'POSIX'].map(form => ({ shape, form }))))
      ('accepts a literal absolute target in $shape ($form)', async ({ shape, form }) => {
        const f = fixture(), primary = join(f.root, 'primary');
        const tree = form === 'POSIX' ? '/fixture/tree' : form === 'quoted space' ? join(f.root, 'tree with spaces') : f.path;
        let target = normalizePath(tree).toUpperCase();
        if (form === 'backslash') target = target.replaceAll('/', '\\');
        if (form === 'Git Bash') target = target.replace(/^([A-Z]):/, '/$1');
        write(f, shape, `release-worktree.ps1 -Path "${target}"`, primary);
        expect(await transcripts(tree, f.options)).toMatchObject({ state: 'negative', literalMatches: 0,
          observed: { state: 'negative', literalMatches: 0 }, attributed: { mentions: [] } });
      });
    const retained = [
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --report-root <tree>/reports',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --runner <tree>/run.ps1',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <tree>/primary',
      '<tree>/release-worktree.ps1 -Path <tree>',
      'release-worktree.ps1 -Path <tree> -NodePath <tree>/node.exe',
    ];
    it.each(shapes.flatMap(shape => retained.map(text => ({ shape, text }))))
      ('retains other release paths in $shape: $text', async ({ shape, text }) => {
        const f = fixture(), primary = join(f.root, 'primary');
        write(f, shape, text.replaceAll('<tree>', normalizePath(f.path)).replaceAll('<primary>', normalizePath(primary)), primary);
        const row = await transcripts(f.path, f.options);
        expect(row).toMatchObject({ state: shape === 'shell-argv' ? 'negative' : 'ok',
          literalMatches: shape === 'shell-argv' ? 0 : 1, observed: { state: 'ok', literalMatches: 1 } });
        expect(row.attributed.mentions).toHaveLength(shape === 'shell-argv' ? 0 : 1);
      });
    const rejected = [
      'release-worktree.ps1 -Path <tree>; ls <tree>',
      'release-worktree.ps1 -Path <tree> && ls <tree>',
      'release-worktree.ps1 -Path <tree> || ls <tree>',
      'release-worktree.ps1 -Path <tree> | cat <tree>/file',
      'cd <tree>; release-worktree.ps1 -Path <tree>',
      'set-location <tree>; release-worktree.ps1 -Path <tree>',
      'pushd <tree>; release-worktree.ps1 -Path <tree>',
      'release-worktree.ps1 -Path <tree> > output',
      'release-worktree.ps1 -Path <tree> < input',
      '(release-worktree.ps1 -Path <tree>)',
      '{ release-worktree.ps1 -Path <tree> }',
      'release-worktree.ps1 -Path <tree> &',
      '& & release-worktree.ps1 -Path <tree>',
      'release-worktree.ps1 `\n-Path <tree>',
      'release-worktree.ps1 -Path <tree>\r\n',
      'release-worktree.ps1 -Path <tree> -Unknown value',
      'release-worktree.ps1 -Path <tree> -Path <tree>',
      'release-worktree.ps1 -Path <tree> <tree>',
      'release-worktree.ps1 -Path <tree> -OwnerSession a --owner-session b',
      'release-worktree.ps1 -Path <tree> -NodePath node -NodePath node',
      'release-worktree.ps1 -Path <tree> -OwnerSession',
      'release-worktree.ps1 -Path $t',
      'release-worktree.ps1 -Path <tree>/../bt-x',
      ...['~', '%TREE%', '*', '?', '[x]', '{x}', ',', '$t', '`x`', '!', '@', ':', "'"].map(suffix =>
        `release-worktree.ps1 -Path "<tree>/${suffix}"`),
      'release-worktree.ps1 -Path relative/bt-x',
      'powershell -NoProfile -NoProfile -File release-worktree.ps1 -Path <tree>',
      'pwsh -ExecutionPolicy RemoteSigned -File release-worktree.ps1 -Path <tree>',
      'powershell -Unknown -File release-worktree.ps1 -Path <tree>',
      'powershell -Command release-worktree.ps1 -Path <tree>',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --unknown value',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --repo <primary>',
      'node scripts/worktree-cleanup.mjs release <tree> --repo',
      'node scripts/worktree-cleanup.mjs release <tree> --repo --runner path',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> second',
      'node scripts/worktree-cleanup.mjs release <tree>/../bt-x --repo <primary>',
      // A shell escape, comment, Node option, or option-name case the CLI rejects never qualifies.
      'release-worktree.ps1 -Path <tree>\\ -OwnerSession owner',
      'release-worktree.ps1 -Path "<tree>\\" -OwnerSession owner',
      'release-worktree.ps1 -Path <tree>\\',
      'release-worktree.ps1 -OwnerSession # -Path <tree>',
      'release-worktree.ps1 -Path <tree> # note',
      'node --import=./scripts/worktree-cleanup.mjs release <tree> --repo <primary>',
      'node "--import=scripts/worktree-cleanup.mjs" release <tree> --repo <primary>',
      'node scripts/worktree-cleanup.mjs release <tree> --REPO <primary>',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --Runner <primary>/run.ps1',
      'node scripts/worktree-cleanup.mjs release <tree>',
      'node scripts/worktree-cleanup.mjs release <tree> --owner-session owner',
      // A POSIX shell strips these backslashes, turning the script word into a Node option.
      'node \\--import=./scripts/worktree-cleanup.mjs release <tree> --repo <primary>',
      'node \\-r./scripts/worktree-cleanup.mjs release <tree> --repo <primary>',
      'node scripts\\worktree-cleanup.mjs release <tree> --repo <primary>',
      'node "scripts/worktree-cleanup.mjs" release <tree> --repo "<primary>\\$x"',
      'C:\\tools\\release-worktree.ps1 -Path <tree>',
      // An expansion, a non-ASCII separator, or a value the CLI rejects never qualifies.
      'node "$x/worktree-cleanup.mjs" release <tree> --repo <primary>',
      'node "%X%/worktree-cleanup.mjs" release <tree> --repo <primary>',
      '"$x/release-worktree.ps1" -Path <tree>',
      'release-worktree.ps1 -Path <tree> -NodePath $node',
      'node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --owner-session $s',
      'node\u00a0scripts/worktree-cleanup.mjs release <tree> --repo <primary>',
      'node\vscripts/worktree-cleanup.mjs release <tree> --repo <primary>',
      'node\tscripts/worktree-cleanup.mjs release <tree> --repo <primary>',
      // Splatting, an assignment word, and a single-quoted (unexpanded) $env: are not literal releases.
      'node scripts/worktree-cleanup.mjs release <tree> --repo @repo',
      'x=<primary>/release-worktree.ps1 -Path <tree>',
      "& '$env:LOCALAPPDATA/WorkflowTools/worktree-cleanup/release-worktree.ps1' -Path <tree>",
      ...['0', '01', '-1', 'a=b', '9007199254740993', '1.5'].map(value =>
        `node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --timeout-ms ${value}`),
      // A program option that names anything but its own program runs that program against the target.
      ...['C:/tools/other.exe', 'C:/tools/git.exe', 'C:/tools/gh', 'C:/tools/nodejs.exe', 'C:/tools/xnode', 'C:/tools/node.exe.bak',
        'C:/tools/node.cmd', 'C:/tools/node.com', 'C:/tools/node.exe/other.exe', 'other'].map(value => `release-worktree.ps1 -Path <tree> -NodePath ${value}`),
      ...['C:/tools/other.exe', 'C:/tools/gh.exe', 'C:/tools/node', 'C:/tools/xgit.exe', 'C:/tools/git.exe.bak', 'C:/tools/git.com', 'git.com', 'C:/tools/git.exe/other.exe']
        .map(value => `node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --git ${value}`),
      ...['C:/tools/other.exe', 'C:/tools/git', 'C:/tools/node.exe', 'C:/tools/xgh', 'C:/tools/gh.exe.bak', 'C:/tools/gh.com', 'gh.com', 'C:/tools/gh.exe/other.exe']
        .map(value => `node scripts/worktree-cleanup.mjs release <tree> --repo <primary> --gh ${value}`),
    ];
    it.each(shapes.flatMap(shape => rejected.map(text => ({ shape, text }))))
      ('keeps existing evidence for an unrecognized $shape release: $text', async ({ shape, text }) => {
        const f = fixture();
        const cmd = text.replaceAll('<tree>', normalizePath(f.path)).replaceAll('<primary>', normalizePath(join(f.root, 'primary')));
        write(f, shape, cmd, f.root);
        const row = await transcripts(f.path, f.options);
        write(f, shape, cmd.replaceAll('release-worktree.ps1', 'other-release.ps1').replaceAll('worktree-cleanup.mjs', 'other-cleanup.mjs'), f.root);
        expect(row).toEqual(await transcripts(f.path, f.options));
        if (cmd.includes(normalizePath(f.path))) {
          expect(row.observed.literalMatches).toBe(1);
          expect(row.literalMatches).toBe(shape === 'shell-argv' ? 0 : 1);
        }
      });
    it.each(shapes.flatMap(shape => ['git -C <tree> status', 'ls <tree>'].map(text => ({ shape, text }))))
      ('retains ordinary commands in $shape: $text', async ({ shape, text }) => {
        const f = fixture(); write(f, shape, text.replaceAll('<tree>', normalizePath(f.path)), f.root);
        expect(await transcripts(f.path, f.options)).toMatchObject({ state: shape === 'shell-argv' ? 'negative' : 'ok',
          observed: { state: 'ok', literalMatches: 1 }, literalMatches: shape === 'shell-argv' ? 0 : 1 });
      });
    it('retains Read file_path evidence', async () => {
      const f = fixture();
      f.transcript([{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: f.path } }] } }]);
      const row = await transcripts(f.path, f.options);
      expect(row).toMatchObject({ state: 'ok', literalMatches: 1, observed: { state: 'ok', literalMatches: 1 } });
      expect(row.attributed.mentions).toHaveLength(1);
    });
    it.each(['plain', 'space', 'report', 'duplicate', 'unknown', 'variable', 'parent', 'chained'])
      ('applies the same recognizer to non-shell argv (%s)', async form => {
        const f = fixture(), primary = join(f.root, 'primary');
        const tree = form === 'space' ? join(f.root, 'tree with spaces') : f.path;
        const argv = ['node', 'scripts/worktree-cleanup.mjs', 'release',
          form === 'variable' ? '$t' : form === 'parent' ? tree + '/..' : tree, '--repo', primary];
        if (form === 'report') argv.push('--report-root', join(f.path, 'reports'));
        if (form === 'duplicate') argv.push('--repo', primary);
        if (form === 'unknown') argv.push('--unknown', 'value');
        if (form === 'chained') argv.push(';', 'ls', f.path);
        write(f, 'argv', argv.join(' '), f.root, argv);
        const row = await transcripts(tree, f.options);
        expect(row).toMatchObject({ state: 'negative', literalMatches: 0,
          observed: { state: form === 'plain' || form === 'space' ? 'negative' : form === 'variable' ? 'unknown' : 'ok',
            literalMatches: form === 'plain' || form === 'space' || form === 'variable' ? 0 : 1 }, attributed: { mentions: [], doubts: [] } });
        if (form !== 'plain' && form !== 'space' && form !== 'report') {
          const baseline = argv.map(token => token === 'scripts/worktree-cleanup.mjs' ? 'scripts/other-cleanup.mjs' : token);
          write(f, 'argv', baseline.join(' '), f.root, baseline);
          expect(row).toEqual(await transcripts(tree, f.options));
        }
      });
    it.each([
      ['--import', ['node', '--import=./scripts/worktree-cleanup.mjs', 'release', '<tree>', '--repo', '<primary>']],
      ['option case', ['node', 'scripts/worktree-cleanup.mjs', 'release', '<tree>', '--REPO', '<primary>']],
      ['missing --repo', ['node', 'scripts/worktree-cleanup.mjs', 'release', '<tree>']],
      ['literal quoted subcommand', ['node', 'scripts/worktree-cleanup.mjs', '"release"', '<tree>', '--repo', '<primary>']],
      ['literal quoted option', ['node', 'scripts/worktree-cleanup.mjs', 'release', '<tree>', '"--repo"', '<primary>']],
      ['literal quoted target', ['node', 'scripts/worktree-cleanup.mjs', 'release', '"<tree>"', '--repo', '<primary>']],
      ['ampersand program name', ['&', '<primary>/release-worktree.ps1', '-Path', '<tree>']],
      ['other --git program', ['node', 'scripts/worktree-cleanup.mjs', 'release', '<tree>', '--repo', '<primary>', '--git', 'C:/tools/other.exe']],
      ['other -NodePath program', ['<primary>/release-worktree.ps1', '-Path', '<tree>', '-NodePath', 'C:/tools/other.exe']],
      ['other --gh program', ['node', 'scripts/worktree-cleanup.mjs', 'release', '<tree>', '--repo', '<primary>', '--gh', 'C:/tools/other.exe']],
    ])('keeps non-shell argv evidence for a form the CLI would not run as a release (%s)', async (_, template) => {
      const f = fixture(), primary = join(f.root, 'primary');
      const argv = template.map(token => token.replace('<tree>', f.path).replace('<primary>', primary));
      write(f, 'argv', argv.join(' '), f.root, argv);
      const row = await transcripts(f.path, f.options);
      expect(row.observed).toMatchObject({ state: 'ok', literalMatches: 1 });
      const baseline = argv.map(token => token.replace('worktree-cleanup.mjs', 'other-cleanup.mjs').replace('release-worktree.ps1', 'other-release.ps1'));
      write(f, 'argv', baseline.join(' '), f.root, baseline);
      expect(row).toEqual(await transcripts(f.path, f.options));
    });
    it('preserves variable doubt in the release script path', async () => {
      const f = fixture();
      write(f, 'PowerShell', `& "$env:LOCALAPPDATA\\WorkflowTools\\worktree-cleanup\\release-worktree.ps1" -Path ${normalizePath(f.path)}`, f.root);
      const row = await transcripts(f.path, f.options);
      expect(row).toMatchObject({ state: 'unknown', literalMatches: 0,
        observed: { state: 'unknown', literalMatches: 0 }, attributed: { mentions: [] } });
      expect(row.residualDoubtCounts).toEqual({ ...zeroCounts, variable: 1 });
      expect(row.attributed.doubts).toHaveLength(1);
    });
    it('keeps evidence and doubt for a non-literal option value', async () => {
      const f = fixture(), primary = normalizePath(join(f.root, 'primary'));
      write(f, 'PowerShell', `release-worktree.ps1 -Path ${normalizePath(f.path)} -OwnerSession "owner's"`, primary);
      const row = await transcripts(f.path, f.options);
      expect(row).toMatchObject({ state: 'ok', literalMatches: 1, observed: { state: 'ok', literalMatches: 1 } });
      expect(row.residualDoubtCounts).toEqual({ ...zeroCounts, other: 1 });
      write(f, 'PowerShell', `other-release.ps1 -Path ${normalizePath(f.path)} -OwnerSession "owner's"`, primary);
      expect(row).toEqual(await transcripts(f.path, f.options));
    });
    // PowerShell binds -Param:value exactly like -Param value (#2419).
    const colonCommands = ['Get-ChildItem -Path:<tree>', 'Set-Location -Path:<tree>', 'Set-Content -Path:<tree>/x -Value 1'];
    it.each(['PowerShell', 'exec_command', 'shell_command', 'shell-argv'].flatMap(shape => colonCommands.flatMap(text =>
      ['forward', 'backslash'].map(form => ({ shape: shape as Shape, text, form })))))
      ('counts a colon parameter path in $shape ($form): $text', async ({ shape, text, form }) => {
        const f = fixture(), primary = join(f.root, 'primary');
        const tree = form === 'forward' ? normalizePath(f.path) : f.path.replaceAll('/', '\\');
        write(f, shape, text.replaceAll('<tree>', tree), primary);
        const row = await transcripts(f.path, f.options);
        expect(row).toMatchObject({ ...folderRule(shape), observed: { state: 'ok', literalMatches: 1 } });
        write(f, shape, text.replaceAll('-Path:', '-Path ').replaceAll('<tree>', tree), primary);
        const control = await transcripts(f.path, f.options);
        expect([row.state, row.literalMatches]).toEqual([control.state, control.literalMatches]);
      });
    // The folder rule never reads CommandExecution records, so shell-argv
    // evidence reaches only the observed rule, as it does for `ls <tree>`.
    const folderRule = (shape: Shape) => shape === 'shell-argv'
      ? { state: 'negative', literalMatches: 0 } : { state: 'ok', literalMatches: 1 };
    // Decision: the owner-release exemption recognizes only `-Path <tree>`; the
    // colon form fails closed and counts as activity on its target.
    it.each(shapes)('counts release-worktree.ps1 -Path:<tree> as activity in %s', async shape => {
      const f = fixture(), primary = join(f.root, 'primary');
      write(f, shape, `release-worktree.ps1 -Path:${normalizePath(f.path)}`, primary);
      expect(await transcripts(f.path, f.options)).toMatchObject({ ...folderRule(shape),
        observed: { state: 'ok', literalMatches: 1 } });
    });
    it.each(shapes.flatMap(shape => ['Invoke-WebRequest -Uri:https://example.com<posix>', 'Get-ChildItem -Path:<tree>-other',
      'Write-Output a:b:c'].map(text => ({ shape, text }))))
      ('keeps colon text that names no indexed tree negative in $shape: $text', async ({ shape, text }) => {
        const f = fixture(), primary = join(f.root, 'primary');
        const tree = normalizePath(f.path);
        write(f, shape, text.replaceAll('<tree>', tree).replaceAll('<posix>', tree.replace(/^([a-z]):/i, '')), primary);
        expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'negative', literalMatches: 0 });
      });
    it.each([false, true])('keeps the folder rule raw for an exec wrapper (unparsable=%s)', async unparsable => {
      const f = fixture(), cmd = `release-worktree.ps1 -Path ${normalizePath(f.path)}`;
      const input = `tools.exec_command(${JSON.stringify({ cmd })})${unparsable ? '; extra()' : ''}`;
      f.transcript([{ cwd: join(f.root, 'primary'), timestamp: timestamp(73) },
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } }], 'codex');
      const row = await transcripts(f.path, f.options);
      expect(row).toMatchObject({ state: 'ok', literalMatches: 1,
        observed: { state: unparsable ? 'ok' : 'negative', literalMatches: unparsable ? 1 : 0 } });
      expect(row.attributed.mentions).toHaveLength(1);
      expect(row.residualDoubtCounts).toEqual({ ...zeroCounts, 'unparsable-exec': unparsable ? 1 : 0 });
    });
    it('pins residual doubt counts for mixed non-release commands', async () => {
      const f = fixture();
      f.transcript([{ cwd: f.root, timestamp: timestamp(73) },
        record('Bash', 'ls $TREE', f.root), record('PowerShell', 'echo $(pwd)', f.root),
        record('exec_command', 'cd somewhere; ls ../* ~', f.root), record('shell_command', 'ls @files', f.root),
        record('shell-argv', 'Get-Content "unfinished', f.root),
        ...['broken', 'tools.exec_command({cmd:command})'].map(input => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } })),
        edit(f.path)], 'codex');
      const row = await transcripts(f.path, f.options);
      expect(row).toMatchObject({ state: 'unknown', literalMatches: 1, observed: { state: 'unknown', literalMatches: 1 } });
      expect(row.residualDoubtCounts).toEqual({ variable: 1, 'command-substitution': 1, 'chained-cd': 1,
        'climb-out': 1, 'unparsable-exec': 1, 'non-literal-command': 1, other: 3 });
      expect(row.attributed.mentions).toHaveLength(1);
      expect(row.attributed.doubts).toHaveLength(1);
    });
  });
  it.each([false, true])('retains literal Read evidence alongside doubt and in the cache (literal first=%s)', async literalFirst => {
    const f = fixture();
    const read = { ...edit(join(f.path, 'file')), message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: join(f.path, 'file') } }] } };
    const doubt = command('cat $TREE/file');
    f.transcript([{ cwd: f.root }, ...(literalFirst ? [read, doubt] : [doubt, read])]);
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript).toMatchObject({ state: literalFirst ? 'ok' : 'unknown', literalMatches: 1,
      observed: { state: literalFirst ? 'ok' : 'unknown', literalMatches: 1 } });
    expect(releasesUnresolvedDoubt(f.path, baseline, [f.path])).toBe(false);
    vi.mocked(createReadStream).mockClear();
    const recheck = await activity({ ...f.entry, activity: baseline }, f.options);
    expect(recheck.transcript).toEqual(baseline.transcript);
    expect(releasesUnresolvedDoubt(f.path, recheck, [f.path])).toBe(false);
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it.each([false, true])('holds a quiescent torn tail literal with scoped doubt (session known=%s)', async sessionKnown => {
    const f = fixture(), scoped = join(f.root, 'scoped'), child = join(scoped, 'child'), outside = join(f.root, 'outside');
    const path = f.transcript(sessionKnown ? [{ cwd: scoped, timestamp: timestamp(73) }] : []);
    appendFileSync(path, '{"file_path":' + JSON.stringify(normalizePath(join(f.path, 'file'))));
    const entries = [f.path, child, outside].map(path => ({ ...f.entry, path }));
    const rows = await collectActivity(entries, f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(['ok', sessionKnown ? 'unknown' : 'negative', 'negative']);
    expect(rows[0].transcript).toMatchObject({ literalMatches: 1, observed: { state: 'ok', literalMatches: 1 } });
    expect(rows[1].transcript.observed.state).toBe(sessionKnown ? 'unknown' : 'negative');
    vi.mocked(createReadStream).mockClear();
    for (const [index, entry] of entries.entries()) {
      const recheck = await activity({ ...entry, activity: rows[index] }, f.options);
      expect(recheck.transcript).toEqual(rows[index].transcript);
    }
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('scopes a relative torn tail to the carried session folder and reads its completion after growth', async () => {
    const f = fixture(), child = join(f.path, 'child'), outside = join(f.root, 'outside');
    const path = f.transcript([{ cwd: f.path, timestamp: timestamp(73) }]);
    const line = JSON.stringify(edit('child/file'));
    const cut = line.indexOf('child/file') + 'child/file'.length;
    appendFileSync(path, line.slice(0, cut));
    const entries = [f.path, child, outside].map(path => ({ ...f.entry, path }));
    const rows = await collectActivity(entries, f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(['unknown', 'unknown', 'negative']);
    expect(rows.map(row => row.transcript.observed.state)).toEqual(['unknown', 'unknown', 'negative']);
    expect(rows[0].transcript).toMatchObject({ literalMatches: 0, observed: { literalMatches: 0 } });
    vi.mocked(createReadStream).mockClear();
    expect((await activity({ ...entries[1], activity: rows[1] }, f.options)).transcript).toEqual(rows[1].transcript);
    expect(createReadStream).not.toHaveBeenCalled();
    appendFileSync(path, line.slice(cut) + '\n');
    expect((await activity({ ...entries[1], activity: rows[1] }, f.options)).transcript)
      .toMatchObject({ state: 'ok', literalMatches: 1, observed: { state: 'ok', literalMatches: 1 } });
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });
  it('retains matched and uncertain evidence when a cached transcript ages out mid-run', async () => {
    const f = fixture(), cwd = join(f.root, 'scoped'), uncertain = join(cwd, 'uncertain'), idle = join(f.root, 'idle');
    f.transcript([{ ...edit(f.path), timestamp: timestamp(72) }, { cwd }, { ...command('ls $TREE'), timestamp: timestamp(72) }], 'claude', 72);
    const entries = [f.path, uncertain, idle].map(path => ({ ...f.entry, path }));
    const baseline = await collectActivity(entries, f.options);
    expect(baseline.map(row => row.transcript.state)).toEqual(['ok', 'unknown', 'negative']);
    vi.mocked(createReadStream).mockClear();
    const rows = await Promise.all(entries.map((entry, index) => activity({ ...entry, activity: baseline[index] }, {
      ...f.options, now: () => NOW + 35 * 60_000,
    })));
    expect(rows.map(row => row.transcript.state)).toEqual(['ok', 'unknown', 'negative']);
    expect(rows[1].transcript).toMatchObject({ reason: expect.stringContaining('Unresolved relative command path') });
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('fails closed when a cached transcript is genuinely deleted', async () => {
    const f = fixture(), path = f.transcript([edit(f.path)], 'claude', 72);
    const [baseline] = await collectActivity([f.entry], f.options);
    unlinkSync(path);
    expect((await activity({ ...f.entry, activity: baseline }, { ...f.options, now: () => NOW + 1 })).transcript)
      .toMatchObject({ state: 'unknown', reason: expect.stringContaining('Previously scanned transcript disappeared') });
  });
  it('keeps B unknown after A evicts a malformed transcript and the transcript disappears', async () => {
    const f = fixture(), path = f.transcript([{ type: 'event_msg' }]), second = join(f.root, 'bt-b');
    mkdirSync(second);
    const entries = [f.entry, { ...f.entry, path: second }];
    const baseline = await collectActivity(entries, f.options);
    expect(baseline.map(row => row.live.state)).toEqual(['negative', 'negative']);
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(edit(second)) + '\n{\n');
    expect((await activity({ ...entries[0], activity: baseline[0] }, f.options)).transcript.state).toBe('unknown');
    unlinkSync(path);
    const result = await activity({ ...entries[1], activity: baseline[1] }, f.options);
    expect(result.transcript.state).toBe('unknown');
    expect(result.live.state).toBe('unknown');
  });
  it.each(['missing', 'unreadable'])('keeps a previously observed %s transcript failure for the rest of the session', async failure => {
    const f = fixture(), clean = JSON.stringify({ timestamp: timestamp(), type: 'event_msg' }) + '\n', path = f.transcript([{ type: 'event_msg' }]);
    const [baseline] = await collectActivity([f.entry], f.options);
    if (failure === 'missing') unlinkSync(path);
    else vi.mocked(openSync).mockImplementationOnce(() => { throw new Error('Unreadable transcript fixture'); });
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.state).toBe('unknown');
    writeFileSync(path, clean);
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.state).toBe('unknown');
    // A new run can establish fresh evidence after the failed run ends.
    expect((await activity(f.entry, f.options)).transcript.state).toBe('negative');
  });
  it.each(['before', 'during'])('bounds an append %s the transcript read and caches only the opened prefix', async timing => {
    const f = fixture(), path = f.transcript([{ type: 'event_msg' }]);
    const [baseline] = await collectActivity([f.entry], f.options);
    // Force a read on recheck, then inject another append at the race boundary.
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify({ timestamp: timestamp() }) + '\n');
    const append = () => writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(edit(f.path)) + '\n');
    if (timing === 'before') {
      const real = vi.mocked(openSync).getMockImplementation()!;
      vi.mocked(openSync).mockImplementationOnce((...args) => { append(); return real(...args); });
    } else {
      const real = vi.mocked(createReadStream).getMockImplementation()!;
      vi.mocked(createReadStream).mockImplementationOnce((...args) => { append(); return real(...args); });
    }
    const result = await activity({ ...f.entry, activity: baseline }, f.options);
    expect(result.transcript.state).toBe(timing === 'before' ? 'ok' : 'negative');
    vi.mocked(createReadStream).mockClear();
    const recheck = await activity({ ...f.entry, activity: result }, f.options);
    expect(recheck.transcript).toMatchObject({ state: 'ok', value: { count: 1 } });
    expect(createReadStream).toHaveBeenCalledTimes(timing === 'before' ? 0 : 1);
    vi.mocked(createReadStream).mockClear();
    expect((await activity({ ...f.entry, activity: recheck }, f.options)).transcript.state).toBe('ok');
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('leaves an unscoped torn final line clear and sees its completion on the next recheck', async () => {
    const f = fixture(), line = JSON.stringify(edit(f.path));
    const path = f.transcript([{ type: 'event_msg' }]);
    const torn = readFileSync(path, 'utf8') + line.slice(0, 10);
    writeFileSync(path, torn);
    const real = vi.mocked(createReadStream).getMockImplementation()!;
    // Read only the torn bytes, then let the writer finish the line.
    vi.mocked(createReadStream).mockImplementationOnce((file, options) => {
      const stream = real(file, { ...(options as object), end: Buffer.byteLength(torn) - 1 });
      writeFileSync(path, torn + line.slice(10) + '\n');
      return stream;
    });
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.state).toBe('negative');
    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript)
      .toMatchObject({ state: 'ok', value: { count: 1 } });
    expect(createReadStream).toHaveBeenCalledTimes(2);
  });
  it('preserves an earlier literal hit with an unscoped torn final line whose file does not change', async () => {
    const f = fixture(), path = f.transcript([edit(f.path)]);
    writeFileSync(path, readFileSync(path, 'utf8') + JSON.stringify(edit(f.path)).slice(0, 10));
    expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'ok', value: { count: 1 } });
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });
  it('uses only the opened prefix even when a writer appends on every read', async () => {
    const f = fixture(), other = join(f.root, 'bt-other'); mkdirSync(other);
    const path = f.transcript([edit(f.path)]), size = lstatSync(path).size;
    const real = vi.mocked(createReadStream).getMockImplementation()!;
    vi.mocked(createReadStream).mockImplementation((...args) => {
      appendFileSync(path, JSON.stringify(edit(other)) + '\n');
      return real(...args);
    });
    const entries = [f.entry, { ...f.entry, path: other }];
    const baseline = await collectActivity(entries, f.options);
    expect(baseline.map(row => row.transcript.state)).toEqual(['ok', 'negative']);
    expect(baseline.map(row => row.transcript.observed.state)).toEqual(['ok', 'negative']);
    expect(baseline.every(row => !row.liveReasons.some(reason => reason.code === 'transcript-unreadable'))).toBe(true);
    expect(createReadStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createReadStream).mock.calls[0][1]).toMatchObject({ start: 0, end: size - 1 });
    const recheck = await activity({ ...entries[1], activity: baseline[1] }, f.options);
    expect(recheck.transcript).toMatchObject({ state: 'ok', value: { count: 1 } });
    expect(createReadStream).toHaveBeenCalledTimes(2);
  });
  it.each(['truncated', 'replaced', 'rewritten'])('fails closed after both reads are %s', async change => {
    const f = fixture(), path = f.transcript([edit(f.path)]);
    const real = vi.mocked(createReadStream).getMockImplementation()!;
    let attempts = 0;
    vi.mocked(createReadStream).mockImplementation((...args) => {
      const stream = real(...args);
      stream.once('end', () => {
        attempts++;
        if (change === 'truncated') truncateSync(path, lstatSync(path).size - 1);
        else if (change === 'replaced') {
          const text = readFileSync(path, 'utf8');
          renameSync(path, path + '.previous-' + attempts);
          f.file(path, text);
        } else {
          writeFileSync(path, readFileSync(path));
          utimesSync(path, new Date(NOW), new Date(NOW + attempts * 1000));
        }
      });
      return stream;
    });
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Transcript changed during read') });
    expect(baseline.liveReasons).toContainEqual({ code: 'transcript-unreadable', state: 'unknown' });
    expect(createReadStream).toHaveBeenCalledTimes(2);
    vi.mocked(createReadStream).mockImplementation(real);
    f.transcript([edit(f.path)]);
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.state).toBe('unknown');
  });
  it('counts a valid unterminated final record', async () => {
    const f = fixture(), path = f.transcript([{ type: 'event_msg' }]);
    appendFileSync(path, JSON.stringify(edit(f.path)));
    expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'ok', value: { count: 1 } });
  });
  it('retains literals in a prefix ending inside a UTF-8 character and reads its completion next time', async () => {
    const f = fixture(), path = f.transcript([]);
    const line = Buffer.from(JSON.stringify({ ...edit(f.path), text: '\u{1f680}' }));
    const cut = line.indexOf(Buffer.from('\u{1f680}')) + 2;
    appendFileSync(path, line.subarray(0, cut));
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.state).toBe('ok');
    appendFileSync(path, Buffer.concat([line.subarray(cut), Buffer.from('\n')]));
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.state).toBe('ok');
    expect(createReadStream).toHaveBeenCalledTimes(2);
  });
  it.each(['{}\n{bad\n', '{bad\n{}', '{bad\n'])('fails closed for malformed terminated lines: %s', async text => {
    const f = fixture(), path = f.transcript([edit(f.path)]);
    appendFileSync(path, text);
    expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Malformed transcript JSONL') });
  });
  it('validates a parsed unterminated record and its tool inputs', async () => {
    const f = fixture(), path = f.transcript([]);
    for (const record of [null, [], { cwd: 42 }, { type: 'response_item', payload: { type: 'function_call', arguments: '{bad' } }]) {
      writeFileSync(path, JSON.stringify(record));
      expect((await transcripts(f.path, f.options)).state).toBe('unknown');
    }
  });
  it('handles an empty prefix and rereads it after growth', async () => {
    const f = fixture(), path = f.transcript([]);
    writeFileSync(path, '');
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.state).toBe('negative');
    expect(createReadStream).not.toHaveBeenCalled();
    appendFileSync(path, JSON.stringify(edit(f.path)) + '\n');
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.state).toBe('ok');
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });
  it('does not reuse a cached prefix for a replacement with the same size and mtime', async () => {
    const f = fixture(), other = f.path.slice(0, -1) + 'y';
    const path = f.transcript([edit(other)]);
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.state).toBe('negative');
    const before = lstatSync(path);
    renameSync(path, path + '.previous');
    f.transcript([edit(f.path)]);
    const after = lstatSync(path);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).not.toBe(before.ino);
    vi.mocked(createReadStream).mockClear();
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.state).toBe('ok');
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });
  it('rereads a same-inode, same-size rewrite with preserved mtime and changed ctime', async () => {
    const f = fixture(), path = f.transcript([edit(f.path.slice(0, -1) + 'y')]);
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.state).toBe('negative');
    const before = lstatSync(path);
    await new Promise(resolve => setTimeout(resolve, 20));
    f.transcript([edit(f.path)]);
    const after = lstatSync(path);
    expect([after.dev, after.ino, after.size, after.mtimeMs]).toEqual([before.dev, before.ino, before.size, before.mtimeMs]);
    expect(after.ctimeMs).not.toBe(before.ctimeMs);
    vi.mocked(createReadStream).mockClear();
    expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript)
      .toMatchObject({ state: 'ok', literalMatches: 1 });
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });
  it('rejects an unchanged-size prefix when only ctime changes during the read', async () => {
    const f = fixture(); f.transcript([edit(f.path)]);
    const realStat = vi.mocked(fstatSync).getMockImplementation()!;
    const realStream = vi.mocked(createReadStream).getMockImplementation()!;
    let reads = 0;
    vi.mocked(createReadStream).mockImplementation((...args) => { reads++; return realStream(...args); });
    vi.mocked(fstatSync).mockImplementation((...args) => {
      const stat = realStat(...args);
      // The opened identity, size and mtime stay constant, but each read changes ctime.
      return Object.assign(stat, { ctimeMs: Number(stat.ctimeMs) + reads * 1000 });
    });
    expect(await transcripts(f.path, f.options)).toMatchObject({ state: 'unknown', reason: expect.stringContaining('Transcript changed during read') });
    expect(createReadStream).toHaveBeenCalledTimes(2);
  });
  it('bounded transcript recheck reads appended evidence but never rereads unchanged files', async () => {
    const f = fixture();
    const changed = f.transcript([{ type: 'session_meta', payload: { cwd: f.root } }]);
    const unchanged = f.transcript([{ type: 'event_msg', payload: {} }], 'codex');
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(baseline.transcript.state).toBe('negative');
    vi.mocked(createReadStream).mockClear();
    const idle = await activity({ ...f.entry, activity: baseline }, f.options);
    expect(idle.transcript.state).toBe('negative');
    expect(createReadStream).not.toHaveBeenCalled();
    writeFileSync(changed, readFileSync(changed, 'utf8') + JSON.stringify(edit(f.path)) + '\n');
    const live = await activity({ ...f.entry, activity: baseline }, f.options);
    expect(live.transcript.state).toBe('ok');
    expect(vi.mocked(createReadStream).mock.calls.map(args => args[0])).toEqual([changed]);
    expect(vi.mocked(createReadStream).mock.calls.map(args => args[0])).not.toContain(unchanged);
  });
  it.each(['ls $RUN_DIR/x', 'cd ${X}', 'cd %X%', 'cd $(pwd)', 'ls .worktrees/*', 'Get-Content "unfinished',
    'ls -la $TREE', 'ls -la ${TREE}', 'ls -la %TREE%', 'echo $(pwd)', 'echo `pwd`', 'Write-Output $status', 'ls -la *', 'ls -la [ab]'])
    ("scopes unresolved command paths to the cwd subtree: %s", async cmd => {
      const f = fixture(), cwd = join(f.root, "primary");
      const candidate = join(cwd, ".worktrees", "old"), other = join(f.root, "bt-other");
      f.transcript([{ cwd, ...command(cmd) }]);
      const rows = await collectActivity([candidate, other].map(path => ({ ...f.entry, path })), f.options);
      expect(rows.map(row => row.transcript.state)).toEqual(["unknown", "negative"]);
      expect(rows[0].liveReasons).toContainEqual({ code: 'unresolved-command', state: 'unknown' });
    });
  it("keeps resolved relative command paths scoped to their target", async () => {
    const f = fixture(), cwd = join(f.root, "primary");
    const candidate = join(cwd, ".worktrees", "old"), other = join(f.root, "bt-other");
    f.transcript([{ cwd, ...command("git -C .worktrees/old status") }]);
    const rows = await collectActivity([candidate, other].map(path => ({ ...f.entry, path })), f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(["ok", "negative"]);
  });
  it("ignores an unresolved command path without a cwd", async () => {
    const f = fixture(); f.transcript([command("cd $X")]);
    const rows = await collectActivity([f.entry, { ...f.entry, path: join(f.root, "bt-other") }], f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(["negative", "negative"]);
  });
  it("keeps matching outside targets and later records after scoped uncertainty", async () => {
    const f = fixture(), cwd = join(f.root, "primary");
    const nested = join(cwd, ".worktrees", "old"), other = join(f.root, "bt-other");
    f.transcript([{ cwd, ...command("ls $RUN_DIR/x ../bt-other/a.md") }, edit(join(f.path, "a.md"))]);
    const rows = await collectActivity([nested, other, f.path].map(path => ({ ...f.entry, path })), f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(["unknown", "ok", "ok"]);
  });
  it.each([
    ["Bash", "git -C .worktrees/old status"],
    ["PowerShell", "Get-Content .worktrees\\old\\a.md"],
    ["Bash", "cd .worktrees/old"],
    ["Bash", "ls '.worktrees/old/a.md'"],
    ["Bash", "cat .worktrees/old/a.md"],
  ])("resolves %s relative command inputs: %s", async (name, cmd) => {
    const f = fixture(), candidate = join(f.root, ".worktrees", "old");
    f.transcript([{ cwd: f.root, type: "assistant", message: { content: [{ type: "tool_use", name, input: { command: cmd } }] } }]);
    expect((await transcripts(candidate, f.options)).state).toBe("ok");
  });
  it("does not hold an unrelated candidate for resolved relative command inputs", async () => {
    const f = fixture(); f.transcript([{ cwd: f.root }, command("git -C .worktrees/other status")]);
    expect((await transcripts(join(f.root, ".worktrees", "old"), f.options)).state).toBe("negative");
  });
  it.each(['const result = { ok: true };'])('does not mistake pathless command syntax for uncertain paths: %s', async cmd => {
    const f = fixture(); f.transcript([{ cwd: f.root }, command(cmd)]);
    expect((await transcripts(join(f.root, '.worktrees', 'old'), f.options)).state).toBe('negative');
  });
  it.each(['workdir', 'cwd', 'working_directory'])('resolves relative commands against tool %s without changing record cwd', async field => {
    const f = fixture(), cwd = join(f.root, 'primary'), workdir = join(cwd, '.worktrees');
    const candidate = join(workdir, 'old'), outside = join(cwd, 'old');
    f.transcript([{ cwd, type: 'response_item', payload: { type: 'function_call', name: 'exec_command',
      arguments: JSON.stringify({ cmd: 'git -C old status', [field]: workdir }) } }, command('cat later/a.md')]);
    const rows = await collectActivity([candidate, outside, join(cwd, 'later'), join(workdir, 'later')].map(path => ({ ...f.entry, path })), f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(['ok', 'negative', 'ok', 'negative']);
  });
  it('scopes variable uncertainty to the tool working directory and the session cwd', async () => {
    const f = fixture(), cwd = join(f.root, 'primary'), workdir = join(cwd, '.worktrees');
    f.transcript([{ cwd, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash',
      input: { command: 'ls -la $TREE', workdir } }] } }]);
    const rows = await collectActivity([join(workdir, 'old'), join(cwd, 'inside'), join(f.root, 'elsewhere')].map(path => ({ ...f.entry, path })), f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(['unknown', 'unknown', 'negative']);
  });
  it('keeps session-cwd doubt when a variable command runs from an unrelated tool workdir', async () => {
    const f = fixture(), cwd = join(f.root, 'primary'), workdir = join(f.root, 'temp');
    f.transcript([{ cwd, type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash',
      input: { command: 'git -C $WT pull', workdir } }] } }]);
    const rows = await collectActivity([join(cwd, '.worktrees', 'target'), join(f.root, 'elsewhere')].map(path => ({ ...f.entry, path })), f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(['unknown', 'negative']);
  });
  it('holds an unresolved variable used as a path operand', async () => {
    const f = fixture(); f.transcript([{ cwd: f.root }, command('git -C $TREE status')]);
    expect((await transcripts(join(f.root, '.worktrees', 'old'), f.options)).state).toBe('unknown');
  });
  it.each(['git -C "$TREE/old" status', "ls .worktrees/*/a.md", 'Get-Content ".worktrees/old/a.md'])
    ("holds an uncertain relative command as unknown: %s", async cmd => {
      const f = fixture(); f.transcript([{ cwd: f.root }, command(cmd)]);
      expect((await transcripts(join(f.root, ".worktrees", "old"), f.options)).state).toBe("unknown");
    });
  it.skipIf(process.platform !== "win32")("matches Git Bash drive paths with component boundaries", async () => {
    const f = fixture(), bashPath = normalizePath(f.path).replace(/^([a-z]):/, "/$1");
    const file = f.transcript([command(`git -C '${bashPath}' status`)]);
    expect((await transcripts(f.path, f.options)).state).toBe("ok");
    f.file(file, JSON.stringify(command(`git -C '${bashPath}2' status`)));
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
  });
  it.each(["forward", "backslash", "json-escaped"])("matches case-insensitive %s Edit paths", async (form) => {
    const f = fixture();
    let path = (normalizePath(f.path) + "/docs/a.md").toUpperCase();
    if (form !== "forward") path = path.replaceAll("/", form === "backslash" ? "\\" : "\\\\");
    f.transcript([edit(path)]);
    expect((await transcripts(f.path, f.options)).state).toBe("ok");
  });
  it("matches a record cwd and Codex session metadata below the tree", async () => {
    const f = fixture(); f.transcript([{ cwd: join(f.path, "src") }]);
    expect((await transcripts(f.path, f.options)).state).toBe("ok");
    const g = fixture(); g.transcript([{ type: "session_meta", payload: { cwd: join(g.path, "src") } }], "codex");
    expect((await transcripts(g.path, g.options)).state).toBe("ok");
  });
  it("finds nested subagent transcripts and nested Codex sessions", async () => {
    const f = fixture(); f.transcript([edit(join(f.path, "a.md"))], "claude", 1, "session/subagents/agent.jsonl");
    expect((await transcripts(f.path, f.options)).state).toBe("ok");
    const g = fixture(); g.transcript([command(`git -C "${g.path}" status`)], "codex");
    expect((await transcripts(g.path, g.options)).state).toBe("ok");
  });
  it("ignores tool results, message text, and edit replacement text", async () => {
    const f = fixture();
    f.transcript([
      { type: "user", message: { content: [{ type: "tool_result", content: `git worktree list: ${f.path}` }] } },
      { type: "assistant", message: { content: [{ type: "text", text: f.path }] } },
      { type: "response_item", payload: { type: "function_call_output", output: f.path } },
      { type: "response_item", payload: { type: "message", content: [{ type: "input_text", text: f.path }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: join(f.root, "elsewhere.txt"), new_string: f.path } }] } },
    ]);
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
  });
  it.each(["2", "-old", ".backup"])("does not match sibling suffix %s in paths or commands", async (suffix) => {
    const f = fixture(); f.transcript([edit(f.path + suffix + "/a.md"), command(`git -C "${f.path + suffix}" status`)]);
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
  });
  it("does not match a path embedded inside another path", async () => {
    const f = fixture(); f.transcript([command(`echo prefix${normalizePath(f.path)}/file`)]);
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
  });
  it.skipIf(process.platform !== "win32")("preserves UNC roots while normalizing backslash paths and commands", async () => {
    const f = fixture(); f.transcript([edit("\\\\server\\share\\bt-x\\docs\\a.md")]);
    expect((await transcripts("//server/share/bt-x", f.options)).state).toBe("ok");
    const g = fixture(); g.transcript([command('git -C "\\\\server\\share\\bt-x" status')]);
    expect((await transcripts("//server/share/bt-x", g.options)).state).toBe("ok");
  });
  it.each([71, 72, 73])("uses the inclusive 72-hour transcript window (%i hours)", async (age) => {
    const f = fixture(); f.transcript([{ ...edit(f.path), timestamp: timestamp(age) }], "claude", age);
    expect((await transcripts(f.path, f.options)).state).toBe(age <= 72 ? "ok" : "negative");
  });
  it("treats missing transcript directories as negative", async () => {
    const f = fixture(); expect((await transcripts(f.path, f.options)).state).toBe("negative");
  });
  it("fails closed for a recent unreadable transcript even after a matching record", async () => {
    const f = fixture(); f.transcript([edit(f.path)]);
    vi.mocked(createReadStream).mockImplementationOnce(() => { throw new Error("EACCES"); });
    const result = await activity(f.entry, f.options);
    expect(result.transcript.state).toBe("unknown");
    expect(result.liveReasons).toContainEqual({ code: 'transcript-unreadable', state: 'unknown' });
  });
  it("fails closed for unreadable directories and malformed recent JSONL", async () => {
    const f = fixture(); f.transcript([edit(f.path)]);
    vi.mocked(readdirSync).mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect((await transcripts(f.path, f.options)).state).toBe("unknown");
    f.file(join(f.homeDirectory, ".claude/projects/project/bad.jsonl"), "{bad\n");
    expect((await transcripts(f.path, f.options)).state).toBe("unknown");
  });
  it("ignores malformed old transcripts but rejects malformed tool arguments", async () => {
    const f = fixture(); f.file(join(f.homeDirectory, ".codex/sessions/old.jsonl"), "{bad", 73);
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
    f.transcript([{ type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{bad" } }]);
    expect((await transcripts(f.path, f.options)).state).toBe("unknown");
  });
  it("streams many records and finds the final tool call without reading whole transcripts", async () => {
    const f = fixture(); f.transcript([...Array.from({ length: 20000 }, () => ({ type: "user", message: { content: "fixture" } })), edit(f.path)]);
    expect((await transcripts(f.path, f.options)).state).toBe("ok");
    expect(createReadStream).toHaveBeenCalled();
  });
  it("scans 20,000 tool calls against 90 candidates well within the activity deadline", async () => {
    const f = fixture();
    const entries = Array.from({ length: 90 }, (_, index) => {
      const path = join(f.root, `tree-${index}`); mkdirSync(path);
      return { ...f.entry, path };
    });
    // Keep candidates unmatched until the end so a per-candidate parser cannot
    // escape the workload by remembering an early hit. Include sizable ignored
    // fields, as real tool calls often carry replacement text or descriptions.
    const cmd = "cat " + Array.from({ length: 24 }, (_, index) => `../elsewhere/file-${index}.md`).join(" ");
    const records = Array.from({ length: 20000 }, (_, index) => ({
      type: "response_item", payload: { type: "function_call", name: "exec_command",
        arguments: JSON.stringify({ cmd, description: `record ${index}: ${"ignored ".repeat(64)}` }) },
    }));
    f.transcript([{ cwd: join(f.root, "primary") }, ...records, edit(join(entries[89].path, "last.md"))], "codex");
    const started = performance.now();
    const rows = await collectActivity(entries, { ...f.options, walkTimeout: 10_000 });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(rows.map(row => row.transcript.state)).toEqual([...Array(89).fill("negative"), "ok"]);
  }, 20_000);
  it("matches unsorted nested candidates and every literal absolute mention without a cwd", async () => {
    const f = fixture(), parent = join(f.root, "tree with spaces 🚀"), child = join(parent, "child"), sibling = parent + "2";
    f.transcript([command(`cat '${child}/../a.md' '${f.path}/b.md'`)]);
    const paths = [child, sibling, f.path, parent, parent.toUpperCase()];
    const rows = await collectActivity(paths.map(path => ({ ...f.entry, path })), f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(["ok", "negative", "ok", "ok", "ok"]);
  });
  it("preserves uncertainty ordering within inputs and across records", async () => {
    const f = fixture(), first = join(f.root, "first"), second = join(f.root, "second"), third = join(f.root, "third");
    f.transcript([
      { cwd: f.root }, edit(first),
      command("ls $TREE/file ./second/a.md"),
      edit(third),
    ]);
    const rows = await collectActivity([third, first, second].map(path => ({ ...f.entry, path })), f.options);
    expect(rows.map(row => row.transcript.state)).toEqual(["unknown", "ok", "ok"]);
    f.transcript([{ cwd: f.root, ...command("ls $TREE/file") }, edit(second)], "codex");
    expect((await transcripts(second, f.options)).state).toBe("unknown");
  });
  it("validates ignored records even after all candidates match", async () => {
    const f = fixture();
    const path = f.transcript([edit(f.path)]);
    f.file(path, readFileSync(path, "utf8") + '{"type":"user","message":{"content":"ignored"}\n');
    expect((await transcripts(f.path, f.options)).state).toBe("unknown");
  });
  it("reads custom apply_patch headers but ignores patch body mentions", async () => {
    const f = fixture();
    const patch = (input: string) => ({ timestamp: timestamp(), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", input } });
    const path = f.transcript([patch(`*** Begin Patch\n*** Update File: ${f.root}/elsewhere\n+${f.path}\n*** End Patch`)], "codex");
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
    f.file(path, JSON.stringify(patch(`*** Begin Patch\n*** Add File: ${f.path}/a.md\n+fixture\n*** End Patch`)));
    expect((await transcripts(f.path, f.options)).state).toBe("ok");
  });
  it("does not treat arbitrary freeform tool prose as command input", async () => {
    const f = fixture();
    f.transcript([{ type: "response_item", payload: { type: "custom_tool_call", name: "write_message", input: `Report on ${f.path}` } }], "codex");
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
  });
  it("resolves relative file inputs against the recorded cwd", async () => {
    const f = fixture(); f.transcript([{ cwd: f.root }, edit("bt-x/docs/a.md")]);
    expect((await transcripts(f.path, f.options)).state).toBe("ok");
  });
  it("holds on stream errors after open", async () => {
    const f = fixture(); f.transcript([edit(f.path)]);
    const real = vi.mocked(createReadStream).getMockImplementation()!;
    vi.mocked(createReadStream).mockImplementationOnce((...args) => {
      const stream = real(...args);
      queueMicrotask(() => stream.destroy(new Error("EIO")));
      return stream;
    });
    expect((await transcripts(f.path, f.options)).state).toBe("unknown");
  });
  it("does not traverse a linked transcript directory", async () => {
    const f = fixture(); const target = join(f.root, "sessions"); f.file(join(target, "session.jsonl"), JSON.stringify(edit(f.path)));
    const link = join(f.homeDirectory, ".claude/projects"); mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, "junction"); junctions.push(link); vi.mocked(readdirSync).mockClear();
    expect((await transcripts(f.path, f.options)).state).toBe("unknown");
    expect(vi.mocked(readdirSync).mock.calls.some(([path]) => normalizePath(String(path)).startsWith(normalizePath(link)))).toBe(false);
  });
  it("accepts valid replacement characters in ignored text but rejects invalid UTF-8 bytes", async () => {
    const f = fixture(); const path = f.transcript([{ type: "user", message: { content: "fixture \uFFFD" } }]);
    expect((await transcripts(f.path, f.options)).state).toBe("negative");
    writeFileSync(path, Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d, 0x0a]));
    expect((await transcripts(f.path, f.options)).state).toBe("unknown");
  });
});

describe('observed transcript reach', () => {
  const exec = (input: unknown) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input } });
  const execution = (cwd: unknown, cmd: unknown = 'cat docs/a.md') => ({
    type: 'event_msg', payload: { type: 'item_completed', item: {
      type: 'CommandExecution', cwd, command: ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-Command', cmd],
      parsed_cmd: [{ type: 'unknown', cmd }], status: 'completed',
    } },
  });
  const context = (cwd: string) => ({ type: 'session_meta', timestamp: timestamp(73), payload: { cwd } });
  const zeroCounts = { variable: 0, 'command-substitution': 0, 'chained-cd': 0, 'climb-out': 0,
    'unparsable-exec': 0, 'non-literal-command': 0, other: 0 };
  async function scan(f: ReturnType<typeof fixture>, paths: string[]) {
    return (await collectActivity(paths.map(path => ({ ...f.entry, path })), f.options)).map(row => row.transcript);
  }
  const scope = { sessionCwd: '<primary>', trees: ['<primary>/.worktrees/x', '<primary>/.worktrees/bt-live',
    '<primary>/.worktrees/old', '<primary>/unrelated', '<outside>'] };
  it.each([
    { ...scope, name: 'glob inside tree', shape: 'claude', text: 'ls .worktrees/x/*', tree: 0, state: 'unknown' },
    { ...scope, name: 'glob inside source directory', shape: 'claude', text: 'cat .worktrees/x/src/*.ts', tree: 0, state: 'unknown' },
    { ...scope, name: 'glob subtree siblings', shape: 'claude', text: 'ls .worktrees/*', tree: 1, state: 'unknown', counts: zeroCounts },
    { ...scope, name: 'glob excludes outside tree', shape: 'claude', text: 'ls .worktrees/*', tree: 4, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'glob excludes unrelated subtree', shape: 'claude', text: 'ls .worktrees/*', tree: 3, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'literal git target', shape: 'claude', text: 'git -C .worktrees/old status', tree: 2, state: 'ok', counts: zeroCounts },
    { ...scope, name: 'literal git excludes sibling', shape: 'claude', text: 'git -C .worktrees/old status', tree: 1, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'literal backslash path', shape: 'claude', text: 'cat ".WORKTREES\\OLD\\a.md"', tree: 2, state: 'ok', counts: zeroCounts },
    { ...scope, name: 'literal-only miss', shape: 'claude', text: 'cat docs/a.md', tree: 1, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'space flag value', shape: 'claude', text: 'Get-ChildItem -Path .worktrees/bt-*', tree: 1, state: 'unknown', counts: zeroCounts },
    { ...scope, name: 'colon flag value', shape: 'claude', text: 'Get-ChildItem -Path:.worktrees/bt-*', tree: 1, state: 'unknown', counts: { ...zeroCounts, other: 1 } },
    ...['cd', 'chdir', 'SL', 'set-location', 'pushd', 'push-location', 'popd', 'pop-location'].map(alias => ({
      ...scope, name: `directory alias ${alias}`, shape: 'claude', text: `${alias} .worktrees; Get-ChildItem bt-*`,
      tree: 1, state: 'unknown', counts: { ...zeroCounts, 'chained-cd': 1 },
    })),
    ...['$TREE', '${TREE}', '%VAR%', '$env:TREE'].map(token => ({
      ...scope, name: `variable ${token}`, shape: 'claude', text: `ls ${token}`, tree: 1, state: 'unknown', counts: { ...zeroCounts, variable: 1 },
    })),
    ...['$(pwd)', '`pwd`'].map(token => ({
      ...scope, name: `substitution ${token}`, shape: 'claude', text: `ls ${token}`, tree: 1, state: 'unknown', counts: { ...zeroCounts, 'command-substitution': 1 },
    })),
    ...['~', 'thing:else', 'c:relative', '@paths', 'foo!', '--path=.worktrees/bt-*', '-I.worktrees/bt-*', 'out=docs/a.md', 'docs/a.md > @target'].map(token => ({
      ...scope, name: `unrecognized ${token}`, shape: 'claude', text: `cat ${token}`, tree: 1, state: 'unknown', counts: { ...zeroCounts, other: 1 },
    })),
    { ...scope, name: 'climb out', shape: 'claude', text: 'ls ../*', tree: 1, state: 'unknown', counts: { ...zeroCounts, 'climb-out': 1 } },
    { ...scope, name: 'literal climb retains outside hit', trees: ['<primary>/../sibling'], shape: 'claude', text: 'cat ../sibling/a.md', tree: 0, state: 'ok', counts: { ...zeroCounts, 'climb-out': 1 } },
    { ...scope, name: 'redirection with literal target', shape: 'claude', text: 'cat .worktrees/old/a.md 2>&1', tree: 2, state: 'ok', counts: zeroCounts },
    { ...scope, name: 'redirection does not cast doubt', shape: 'claude', text: 'cat .worktrees/old/a.md 2>&1', tree: 1, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'shell operators are skipped', shape: 'claude', text: '(cat docs/a.md) > output.txt; cat < input.txt | cat &', tree: 1, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'parentheses are operators', shape: 'claude', text: 'ls (odd)', tree: 1, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'literal exec glob', shape: 'exec', text: 'tools.exec_command({cmd:"ls .worktrees/x/*"})', tree: 0, state: 'unknown', counts: zeroCounts },
    { ...scope, name: 'two-call exec outside workdir', shape: 'exec',
      text: 'text(await tools.exec_command({cmd:"ls"})); text(await tools.exec_command({cmd:"ls",workdir:"<outside>"}));', tree: 4, state: 'ok', counts: { ...zeroCounts, 'unparsable-exec': 1 } },
    { ...scope, name: 'two-call exec session doubt', shape: 'exec',
      text: 'text(await tools.exec_command({cmd:"ls"})); text(await tools.exec_command({cmd:"ls",workdir:"<outside>"}));', tree: 1, state: 'unknown', counts: { ...zeroCounts, 'unparsable-exec': 1 } },
    { ...scope, name: 'nonliteral exec retains absolute reference', shape: 'exec',
      text: 'tools.exec_command({cmd:buildCommand(),workdir:"<outside>"})', tree: 4, state: 'ok', counts: { ...zeroCounts, 'non-literal-command': 1 } },
    { ...scope, name: 'non-shell argv retains every argument', shape: 'execution', text: ['git', '-C', '<outside>', 'status'], tree: 4, state: 'ok', counts: zeroCounts },
    { ...scope, name: 'non-shell argv excludes other trees', shape: 'execution', text: ['git', '-C', '<outside>', 'status'], tree: 1, state: 'negative', counts: zeroCounts },
    { ...scope, name: 'shell wrapper', shape: 'execution', text: ['pwsh', '-Command', 'ls .worktrees/x/*'], tree: 0, state: 'unknown', counts: zeroCounts },
    { ...scope, name: 'unrecognized wrapper', shape: 'execution', text: ['pwsh', '-File', 'script.ps1'], tree: 1, state: 'unknown', counts: { ...zeroCounts, 'non-literal-command': 1 } },
  ])('refuses ambiguous reach by default: $name', async row => {
    const f = fixture(), primary = normalizePath(join(f.root, 'primary'));
    const outside = process.platform === 'win32' ? 'C:/tmp/bt-live' : '/tmp/bt-live';
    const expand = (text: string) => text.replaceAll('<primary>', primary).replaceAll('<outside>', outside);
    const cwd = expand(row.sessionCwd), paths = row.trees.map(expand);
    const text = typeof row.text === 'string' ? expand(row.text) : row.text.map(expand);
    const record = row.shape === 'exec' ? exec(text) : row.shape === 'execution'
      ? { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', cwd: pathToFileURL(cwd).href, command: text } } }
      : { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: text } }] } };
    f.transcript([context(cwd), record], row.shape === 'claude' ? 'claude' : 'codex');
    const observed = (await scan(f, paths))[row.tree];
    expect(observed.observed.state).toBe(row.state);
    expect(wouldRelease(observed)).toBe(row.state === 'negative' && observed.state === 'unknown' &&
      observed.reason === 'Recent transcript unavailable: Unresolved relative command path');
    if ('counts' in row) expect(observed.residualDoubtCounts).toEqual(row.counts);
  });
  it.each(['.worktrees/*', '.worktrees/bt-*', '.worktrees/bt-?', '.worktrees/[ab]*', '.worktrees/{bt,old}*'])
    ('bounds static glob reach by its full or partial prefix: %s', async glob => {
      const f = fixture(), primary = join(f.root, 'primary');
      const paths = [primary, join(primary, '.worktrees/bt-live'), join(primary, '.worktrees/old'), join(primary, 'unrelated'), f.path];
      f.transcript([context(primary), command(`ls ${glob}`)]);
      const rows = await scan(f, paths);
      expect(rows.map(row => row.state)).toEqual(['ok', 'unknown', 'unknown', 'unknown', 'negative']);
      expect(rows.map(row => row.observed.state)).toEqual(['ok', 'unknown', glob.includes('bt-') ? 'negative' : 'unknown', 'negative', 'negative']);
      expect(rows[0].residualDoubtCounts).toEqual(zeroCounts);
      expect(wouldRelease(rows[1])).toBe(false); // The control is reached only by the recent glob.
      expect(rows.map(wouldRelease)).toEqual([false, false, glob.includes('bt-'), true, false]);
    });
  it.each(['forward', 'backslash', 'case', 'quoted'])('recognizes absolute static prefixes in %s form', async form => {
    const f = fixture(), primary = join(f.root, 'primary');
    let glob = normalizePath(join(primary, '.worktrees/bt-')) + '*';
    if (form === 'backslash') glob = glob.replaceAll('/', '\\');
    if (form === 'case') glob = glob.toUpperCase();
    if (form === 'quoted') glob = `"${glob}"`;
    f.transcript([context(primary), command(`ls ${glob}`)]);
    expect((await scan(f, [join(primary, '.worktrees/bt-live'), join(primary, '.worktrees/other'), f.path]))
      .map(row => row.observed.state)).toEqual(['unknown', 'negative', 'negative']);
  });
  it.each(['git -C .worktrees/old status', 'cat ".WORKTREES/OLD/a.md"', "cat '.worktrees\\old\\a.md'"])
    ('preserves literal matching: %s', async cmd => {
      const f = fixture(); f.transcript([context(f.root), command(cmd)]);
      const rows = await scan(f, [join(f.root, '.worktrees/old'), join(f.root, '.worktrees/other')]);
      expect(rows.map(row => [row.state, row.observed.state])).toEqual([['ok', 'ok'], ['negative', 'negative']]);
      expect(rows[0].residualDoubtCounts).toEqual(zeroCounts);
    });
  it.each([
    ['ls $TREE', 'variable'], ['ls ${TREE}', 'variable'], ['ls %VAR%', 'variable'], ['ls $env:TREE', 'variable'],
    ['ls $(pwd)', 'command-substitution'], ['ls `pwd`', 'command-substitution'],
    ['cd .worktrees/x && ls ../*', 'chained-cd'], ['set-location x; ls *', 'chained-cd'], ['pushd x; ls *', 'chained-cd'],
    ['ls ../*', 'climb-out'], ['cat ../file', 'climb-out'], ['ls x/../../*', 'climb-out'], ['ls x/*/../../*', 'climb-out'],
    ['ls x/{..,other}/*', 'climb-out'],
    ['ls ~', 'other'], ['ls c:foo', 'other'], ['ls c:', 'other'], ['Get-Content "unfinished', 'other'],
  ])('retains subtree doubt for %s (%s)', async (cmd, doubt) => {
    const f = fixture(), primary = join(f.root, 'primary');
    f.transcript([context(primary), command(cmd)]);
    const rows = await scan(f, [join(primary, '.worktrees/tree'), join(primary, 'other'), f.path]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'unknown', 'negative']);
    expect(rows[0].residualDoubtCounts[doubt]).toBe(1);
    if (doubt === 'command-substitution') expect(rows[0].residualDoubtCounts).toEqual({ ...zeroCounts, 'command-substitution': 1 });
    if (doubt === 'variable' || doubt === 'chained-cd') expect(rows.map(row => row.state)).toEqual(['unknown', 'unknown', 'negative']);
  });
  it('resolves non-escaping parent segments before a glob', async () => {
    const f = fixture(); f.transcript([context(f.root), command('ls folder/../bt-*')]);
    const rows = await scan(f, [f.path, join(f.root, 'other')]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'negative']);
    expect(rows[0].residualDoubtCounts).toEqual(zeroCounts);
  });
  it('resolves absolute globs without session cwd and preserves partial dot prefixes', async () => {
    const f = fixture(), hidden = join(f.root, '.hidden'), visible = join(f.root, 'visible');
    f.transcript([command(`ls "${normalizePath(f.root)}/.*"`)]);
    const rows = await scan(f, [hidden, visible]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'negative']);
    expect(rows[0].residualDoubtCounts).toEqual(zeroCounts);
  });
  it.each(['function', 'exec', 'execution'])('keeps session and tool folder doubt for %s variables', async shape => {
    const f = fixture(), session = join(f.root, 'primary'), workdir = join(f.root, 'elsewhere');
    const cmd = 'git -C $WT pull';
    const record = shape === 'exec' ? exec(`text(await tools.exec_command(${JSON.stringify({ cmd, workdir })}));`)
      : shape === 'execution' ? execution(pathToFileURL(workdir).href, cmd)
        : { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, workdir }) } };
    f.transcript([context(session), record], 'codex');
    const rows = await scan(f, [join(session, '.worktrees/tree'), join(workdir, 'tree'), f.path]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'unknown', 'negative']);
    expect(rows[0].residualDoubtCounts).toEqual({ ...zeroCounts, variable: 1 });
    if (shape === 'function') expect(rows.map(row => row.state)).toEqual(['unknown', 'unknown', 'negative']);
  });
  it.each(['function', 'exec', 'execution'])('uses the %s tool folder for literal relative paths without changing session cwd', async shape => {
    const f = fixture(), workdir = join(f.root, 'tool');
    const cmd = 'cat target/a.md';
    const record = shape === 'exec' ? exec(`text(await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:${JSON.stringify(workdir)},max_output_tokens:1000}));`)
      : shape === 'execution' ? execution(pathToFileURL(workdir).href, cmd)
        : { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cmd, workdir }) } };
    f.transcript([context(f.root), record, command('cat later/a.md')], 'codex');
    const rows = await scan(f, [join(workdir, 'target'), join(f.root, 'target'), join(f.root, 'later'), join(workdir, 'later')]);
    expect(rows.map(row => row.observed.state)).toEqual(['ok', 'negative', 'ok', 'negative']);
  });
  it('decodes percent-encoded CommandExecution cwd and holds the tool tree', async () => {
    const f = fixture(), workdir = join(f.root, 'tree with space #percent%');
    const url = pathToFileURL(workdir).href;
    expect(url).toContain('%20'); expect(url).toContain('%23'); expect(url).toContain('%25');
    f.transcript([context(f.root), execution(url)], 'codex');
    const rows = await scan(f, [workdir, f.path]);
    expect(rows.map(row => row.state)).toEqual(['negative', 'negative']);
    expect(rows.map(row => row.observed.state)).toEqual(['ok', 'negative']);
  });
  it('casts session doubt for a non-literal CommandExecution command', async () => {
    const f = fixture(); f.transcript([context(f.root), execution(pathToFileURL(f.path).href, null)], 'codex');
    const rows = await scan(f, [f.path, join(f.root, '../unrelated')]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'negative']);
    expect(rows[0].residualDoubtCounts).toEqual({ ...zeroCounts, 'non-literal-command': 1 });
  });
  it.each(['relative/path', 'file:relative', 'file:///bad%ZZ', 'https://example.test/a', null])
    ('holds locally for malformed CommandExecution cwd %s without failing the pass', async cwd => {
      const f = fixture(); f.transcript([context(f.root), execution(cwd), edit(join(f.root, 'outside/late'))], 'codex');
      const rows = await scan(f, [f.path, join(f.root, 'outside/late'), join(f.root, '../unrelated')]);
      expect(rows.map(row => row.state)).toEqual(['negative', 'ok', 'negative']);
      expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'unknown', 'negative']);
      expect(rows[0].observed.reason).toContain('Unresolved relative command path');
      expect(rows[0].residualDoubtCounts).toEqual({ ...zeroCounts, other: 1 });
    });
  it('extracts bare and quoted exec keys with JSON escapes, including no workdir', async () => {
    const f = fixture();
    f.transcript([context(f.root), exec('text(await tools.exec_command({cmd:"Get-Location; rg --files -g AGENTS.md -g \'*uptake-report*\'", "max_output_tokens":6000}));'),
      exec(`text(await tools.exec_command({"cmd":"cat bt-x/a.md","workdir":${JSON.stringify(f.root)},max_output_tokens:1000}));`)], 'codex');
    const rows = await scan(f, [f.path, join(f.root, 'other')]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'unknown']); // Bare * still reaches both.
    expect(rows[0].residualDoubtCounts).toEqual({ ...zeroCounts, other: 1 });
    f.transcript([context(f.root), exec('text(await tools.exec_command({cmd:"cat bt-x/a.md","max_output_tokens":6000}));')], 'codex');
    expect((await scan(f, [f.path, join(f.root, 'other')])).map(row => row.observed.state)).toEqual(['ok', 'negative']);
  });
  it('narrows a literal exec glob against its explicit workdir', async () => {
    const f = fixture(), primary = join(f.root, 'primary');
    f.transcript([context(f.root), exec(`text(await tools.exec_command({cmd:"ls .worktrees/*",workdir:${JSON.stringify(primary)}}));`)], 'codex');
    const rows = await scan(f, [join(primary, '.worktrees/live'), join(primary, 'other'), f.path]);
    expect(rows.map(row => row.state)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'negative', 'negative']);
    expect(rows.map(wouldRelease)).toEqual([false, true, true]);
  });
  it.each([
    ['not javascript', 'unparsable-exec'], ['text(await tools.exec_command({cmd:"ls"})); text(await tools.exec_command({cmd:"ls"}));', 'unparsable-exec'],
    ['text(await tools.exec_command({cmd:buildCommand()}));', 'non-literal-command'], ['text(await tools.exec_command({cmd:42}));', 'non-literal-command'],
    ["text(await tools.exec_command({cmd:'ls'}));", 'non-literal-command'], ['text(await tools.exec_command({cmd:"ls",workdir:getDirectory()}));', 'unparsable-exec'],
    ['text(await tools.exec_command({cmd:"ls",cmd:"cat"}));', 'unparsable-exec'], ['text(await tools.exec_command({cmd:"bad\\xescape"}));', 'unparsable-exec'],
  ])('falls back for exec input %s', async (input, doubt) => {
    const f = fixture(); f.transcript([context(f.root), exec(input)], 'codex');
    const rows = await scan(f, [f.path, join(f.root, '../unrelated')]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'negative']);
    expect(rows[0].residualDoubtCounts[doubt]).toBe(1);
  });
  it('counts each residual class once per recent record across files and cached rechecks', async () => {
    const f = fixture();
    f.transcript([context(f.root), command('ls $A $B; echo $(pwd) `pwd`; cd x; ls ../* ~'),
      { ...command('ls $OLD'), timestamp: timestamp(73) }]);
    f.transcript([context(f.root), exec('broken'), exec('tools.exec_command({cmd:command})')], 'codex');
    const [baseline] = await collectActivity([f.entry], f.options);
    const expected = Object.fromEntries(Object.keys(zeroCounts).map(name => [name, 1]));
    expect(baseline.transcript.residualDoubtCounts).toEqual(expected);
    vi.mocked(createReadStream).mockClear();
    const recheck = await activity({ ...f.entry, activity: baseline }, f.options);
    expect(recheck.transcript).toEqual(baseline.transcript);
    expect(createReadStream).not.toHaveBeenCalled();
  });
  it('replays new observed evidence and preserves the classification candidate set on a single-tree recheck', async () => {
    const f = fixture(), other = join(f.root, 'other');
    const file = f.transcript([context(f.root), exec('tools.exec_command({cmd:"ls bt-*"})')], 'codex');
    const entries = [f.entry, { ...f.entry, path: other }];
    const baseline = await collectActivity(entries, f.options);
    expect(baseline.map(row => row.transcript.observed.state)).toEqual(['unknown', 'negative']);
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({ timestamp: timestamp(), ...execution(pathToFileURL(other).href) }) + '\n');
    const recheck = await activity({ ...entries[1], activity: baseline[1] }, f.options);
    expect(recheck.transcript.observed.state).toBe('ok');
    expect(recheck.transcript.state).toBe('unknown');
  });
  it('invalidates cached observed results when the reach version changes', async () => {
    const f = fixture(), file = f.transcript([context(f.root), command('ls bt-*')]);
    const [baseline] = await collectActivity([f.entry], f.options);
    expect(TRANSCRIPT_REACH_VERSION).toBe(2);
    vi.mocked(createReadStream).mockClear();
    const original = Map.prototype.get;
    const stale = vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key: unknown) {
      const value = original.call(this, key);
      return key === file && value?.results instanceof Map ? { ...value, reachVersion: -1 } : value;
    });
    try {
      expect((await activity({ ...f.entry, activity: baseline }, f.options)).transcript.observed.state).toBe('unknown');
      expect(createReadStream).toHaveBeenCalledTimes(1);
    } finally { stale.mockRestore(); }
  });
  it('applies the same time rule to observed-only records and carries old context', async () => {
    const f = fixture();
    f.transcript([context(f.root), { ...execution(pathToFileURL(f.path).href), timestamp: timestamp(73) },
      { ...exec('broken'), timestamp: timestamp(73) }, exec('tools.exec_command({cmd:"ls bt-*"})')], 'codex');
    const rows = await scan(f, [f.path, join(f.root, 'other')]);
    expect(rows.map(row => row.observed.state)).toEqual(['unknown', 'negative']);
    expect(rows[0].residualDoubtCounts).toEqual(zeroCounts);
  });
  it('shares transcript failures and never calls a read failure a release', async () => {
    const f = fixture(), file = f.transcript([context(f.root), command('ls bt-*')]);
    const [baseline] = await collectActivity([f.entry], f.options);
    unlinkSync(file);
    const row = (await activity({ ...f.entry, activity: baseline }, f.options)).transcript;
    expect(row.observed).toMatchObject({ state: row.state, reason: row.reason });
    expect(wouldRelease(row)).toBe(false);
    f.file(file, '{bad\n');
    const malformed = await transcripts(f.path, f.options);
    expect(malformed.observed).toMatchObject({ state: 'unknown', reason: malformed.reason });
  });
  it('wouldRelease requires unresolved deciding doubt and a negative observation exactly', () => {
    const reason = 'Recent transcript unavailable: Unresolved relative command path';
    for (const state of ['ok', 'negative', 'unknown']) for (const observed of ['ok', 'negative', 'unknown']) {
      expect(wouldRelease({ state, reason, observed: { state: observed } })).toBe(state === 'unknown' && observed === 'negative');
    }
    expect(wouldRelease({ state: 'unknown', reason: 'Unreadable', observed: { state: 'negative' } })).toBe(false);
    expect(wouldRelease(undefined)).toBe(false);
  });
  it('keeps deciding verdicts identical with observation stubbed out; the rule switch alone selects reach', async () => {
    const f = fixture(), primary = join(f.root, 'primary'), variableRoot = join(f.root, 'variables');
    const paths = [join(primary, '.worktrees/bt-live'), join(primary, 'idle'), join(variableRoot, 'tree'), f.path];
    f.transcript([context(primary), command('ls .worktrees/bt-*'), edit(f.path),
      exec(`text(await tools.exec_command({cmd:"cat notes/a.md",workdir:${JSON.stringify(primary)}}));`),
      execution(pathToFileURL(f.path).href), { cwd: variableRoot, ...command('ls $TREE') }], 'codex');
    const rows = await scan(f, paths);
    expect(DECIDING_TRANSCRIPT_RULE).toBe('folder');
    // Stub only the observer invocation in memory in an isolated native module.
    // No production off switch, rewritten repository file, or second transcript format.
    const script = `
      import { readFileSync } from 'node:fs';
      import { pathToFileURL } from 'node:url';
      const [file, config] = process.argv.slice(1), settings = JSON.parse(config);
      const base = pathToFileURL(file);
      const source = readFileSync(file, 'utf8').replace(/from '(\\.\\/[^']+)'/g, (_, path) => 'from ' + JSON.stringify(new URL(path, base).href));
      const invocation = 'observeRecord(record, inputs, cwd, candidates, observation);';
      if (!source.includes(invocation)) throw new Error('Observer stub did not apply');
      const outputs = [];
      for (const code of [source, source.replace(invocation, ''), source.replace("DECIDING_TRANSCRIPT_RULE = 'folder'", "DECIDING_TRANSCRIPT_RULE = 'reach'")]) {
        const module = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
        const rows = await module.collectActivity(settings.paths.map(path => ({path, registration: {state:'ok', value:{head: settings.head}}})), {...settings.options, now: () => settings.now});
        outputs.push(rows.map(({transcript: {state, value, reason}}) => ({state, value, reason})));
      }
      console.log(JSON.stringify(outputs));
    `;
    const outputs = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script,
      resolve('scripts/lib/worktree-cleanup/activity.mjs'), JSON.stringify({ paths, head: HEAD, now: NOW, options: f.options })],
    { encoding: 'utf8', windowsHide: true, timeout: 30_000 }));
    const verdict = ({ state, value, reason }: { state: string; value?: unknown; reason?: string }) => JSON.parse(JSON.stringify({ state, value, reason }));
    expect(outputs[0]).toEqual(rows.map(verdict));
    expect(outputs[1]).toEqual(outputs[0]);
    expect(outputs[2]).toEqual(rows.map(row => verdict(row.observed)));
  }, 45_000);
});

describe("read-only Codex leases", () => {
  it("returns negative for a missing or empty state directory", () => {
    const f = fixture(); expect(leases(f.path, f.options).state).toBe("negative");
    mkdirSync(f.codexJobStateDirectory); expect(leases(f.path, f.options).state).toBe("negative");
  });
  it("holds child trees covered by a parent PID lease, and a tree containing the job cwd", () => {
    const f = fixture(); f.manifest({ cwd: f.root });
    expect(leases(f.path, { ...f.options, pidAlive: () => true }).state).toBe("ok");
    f.manifest({ cwd: join(f.path, "src") });
    expect(leases(f.path, { ...f.options, pidAlive: () => true }).state).toBe("ok");
  });
  it("respects case, separators, and lease path boundaries", () => {
    const f = fixture(); f.manifest({ cwd: f.path.toUpperCase().replaceAll("\\", "/") });
    expect(leases(f.path, { ...f.options, pidAlive: () => true }).state).toBe("ok");
    f.manifest({ cwd: f.path + "2" });
    expect(leases(f.path, { ...f.options, pidAlive: () => true }).state).toBe("negative");
  });
  it.each(["stdout.log", "stderr.log"])("holds a reaped PID with fresh %s", (log) => {
    const f = fixture(); f.manifest(); f.file(join(f.codexJobStateDirectory, "job", log), "fixture", 30 / 3600);
    expect(leases(f.path, f.options).state).toBe("ok");
  });
  it("uses a one-minute inclusive grace and startup fallback", () => {
    const f = fixture(); f.manifest({ pid: null, started_at: new Date(NOW - 60000).toISOString() });
    expect(leases(f.path, f.options).state).toBe("ok");
    f.manifest({ started_at: new Date(NOW - 60001).toISOString() });
    expect(leases(f.path, f.options).state).toBe("negative");
  });
  it("releases dead, stale jobs but keeps a live PID despite old logs", () => {
    const f = fixture(); const manifest = f.manifest(); const before = readFileSync(manifest, "utf8");
    f.file(join(f.codexJobStateDirectory, "job/stdout.log"), "fixture", 2);
    expect(leases(f.path, f.options).state).toBe("negative");
    expect(leases(f.path, { ...f.options, pidAlive: () => true }).state).toBe("ok");
    expect(readFileSync(manifest, "utf8")).toBe(before);
    expect(readdirSync(join(f.codexJobStateDirectory, "job")).sort()).toEqual(["manifest.json", "stdout.log"]);
  });
  it.each(["{bad", "{}", JSON.stringify({ id: "job", cwd: "relative", pid: 12, started_at: "bad" })])("holds every tree for malformed manifests (%s)", (text) => {
    const f = fixture(); f.file(join(f.codexJobStateDirectory, "job/manifest.json"), text);
    expect(leases(f.path, f.options).state).toBe("unknown");
    expect(leases(join(f.root, "unrelated"), f.options).state).toBe("unknown");
  });
  it("holds on missing or unreadable manifests, log metadata failures, and PID probe failures", () => {
    const f = fixture(); mkdirSync(join(f.codexJobStateDirectory, "job"), { recursive: true });
    expect(leases(f.path, f.options).state).toBe("unknown");
    f.manifest();
    expect(leases(f.path, { ...f.options, pidAlive: () => { throw new Error("unavailable"); } }).state).toBe("unknown");
    vi.mocked(lstatSync).mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect(leases(f.path, f.options).state).toBe("unknown");
  });
  it("treats denied manifest reads and log metadata errors as unknown", () => {
    const f = fixture(); f.manifest();
    vi.mocked(openSync).mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect(leases(f.path, f.options).state).toBe("unknown");
    const real = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation((...args) => {
      if (String(args[0]).endsWith("stdout.log")) throw new Error("EACCES");
      return real(...args);
    });
    expect(leases(f.path, f.options).state).toBe("unknown");
  });
  it("uses the actual PID probe without running codex-job", () => {
    const f = fixture(); f.manifest({ pid: process.pid });
    expect(leases(f.path, { ...f.options, pidAlive: undefined }).state).toBe("ok");
  });
});

describe("Codex lease process identity (U1)", () => {
  const PID = 5856;
  const born = NOW - 2 * HOUR + 760;
  const runningAt = born + 4500;
  const running = (job = "job") => ({ ts: new Date(runningAt).toISOString(), job, state: "running", pid: PID });
  const terminal = (job = "job") => ({ ts: new Date(runningAt + 1000).toISOString(), job, state: "completed", reason: "terminal event in stream" });
  function setup(overrides: Record<string, unknown> = {}) {
    const f = fixture();
    f.manifest({ pid: PID, pid_created_at: new Date(born).toISOString(), ...overrides });
    f.file(join(f.codexJobStateDirectory, "job/stdout.log"), "", 1);
    const ledger = join(f.codexJobStateDirectory, "ledger.jsonl");
    const writeLedger = (entries: Record<string, unknown>[]) => f.file(ledger, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    writeLedger([running(), terminal()]);
    const leaseProcessSnapshot = vi.fn(() => ok(new Map([[PID, born + HOUR]])));
    const leaseMemo = new Set<string>();
    const options = { ...f.options, pidAlive: vi.fn(() => true), leaseProcessSnapshot, leaseMemo };
    return { ...f, ledger, writeLedger, options, leaseProcessSnapshot, leaseMemo };
  }

  it("U1-T1: compares ISO and CIM milliseconds with the inclusive rounding margin", async () => {
    const { creationMs, processSnapshot } = await import("../lib/worktree-cleanup/process-snapshot.mjs");
    const f = setup();
    const runner = vi.fn(() => ok(JSON.stringify([{ ProcessId: PID, CreationDate: `/Date(${Math.floor(born / 1000) * 1000})/` }])));
    expect(creationMs(new Date(born).toISOString())).toBe(born);
    expect(creationMs("2026-09-26T06:00:00.760-04:00")).toBe(born);
    expect(creationMs("2026-09-26T10:00:00.760")).toBe(Date.parse("2026-09-26T10:00:00.760"));
    expect(creationMs(`/Date(${born})/`)).toBe(born);
    expect(creationMs("unknown")).toBeNull();
    expect(creationMs(null)).toBeNull();
    const snapshot = processSnapshot({ runner });
    expect(snapshot).toEqual(ok(new Map([[PID, Math.floor(born / 1000) * 1000]])));
    expect(runner).toHaveBeenCalledWith(expect.stringMatching(/WindowsPowerShell.*powershell\.exe$/i),
      ["-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("Get-CimInstance Win32_Process")], { timeout: 10_000 });
    f.leaseProcessSnapshot.mockReturnValue(snapshot);
    expect(leases(f.path, f.options).state).toBe("ok");
    f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, born + 60_000]])));
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(f.leaseProcessSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each([-60_001, 60_001])("U1-T2: releases a completed modern job with a creation delta of %i ms", (delta) => {
    const f = setup(); f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, born + delta]])));
    expect(leases(f.path, f.options).state).toBe("negative");
  });

  it.each(["failure", "missing", "throws"])("U1-T3: snapshot %s holds only the job's covered trees", async (kind) => {
    const f = setup({ cwd: join(fixture().root, "unrelated-job") });
    const manifestPath = join(f.codexJobStateDirectory, "job/manifest.json");
    const cwd = JSON.parse(readFileSync(manifestPath, "utf8")).cwd;
    const leaseProcessSnapshot = vi.fn(() => {
      if (kind === "throws") throw new Error("snapshot unavailable");
      return kind === "failure" ? unknown("snapshot timed out") : ok(new Map<number, number>());
    });
    const rows = await collectActivity([{ path: cwd, registration: ok({ head: HEAD }) }, f.entry], { ...f.options, leaseProcessSnapshot });
    expect(rows.map(row => row.lease.state)).toEqual(["ok", "negative"]);
    expect(rows[0].liveReasons).toContainEqual({ code: "lease", state: "ok" });
    expect(leaseProcessSnapshot).toHaveBeenCalledTimes(1);
  });

  it("U1-T3: snapshot runner failures and malformed CIM output are unknown", async () => {
    const { processSnapshot } = await import("../lib/worktree-cleanup/process-snapshot.mjs");
    for (const runner of [() => unknown("timeout"), () => { throw new Error("denied"); }, () => ok("{bad"), () => ok('{"ProcessId":"5856","CreationDate":null}')]) {
      expect(processSnapshot({ runner }).state).toBe("unknown");
    }
    expect(processSnapshot({ runner: () => ok(JSON.stringify([
      { ProcessId: 0, CreationDate: null }, { ProcessId: PID, CreationDate: `/Date(${born})/` },
    ])) })).toEqual(ok(new Map([[PID, born]])));
    if (process.platform !== "win32") expect(processSnapshot().state).toBe("unknown");
  });

  it.each([undefined, null, "unknown"])("U1-T4: releases legacy pid_created_at=%s using one matching running entry", (stamp) => {
    const f = setup({ pid_created_at: stamp });
    f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, runningAt + 60_001]])));
    expect(leases(f.path, f.options).state).toBe("negative");
  });

  it.each([-HOUR, 0, 60_000])("U1-T5: holds legacy creation %i ms from running, without memoizing doubt", (delta) => {
    const f = setup({ pid_created_at: undefined });
    f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, runningAt + delta]])));
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(f.leaseMemo.size).toBe(0);
    f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, runningAt + 60_001]])));
    expect(leases(f.path, f.options).state).toBe("negative");
  });

  it.each([
    "inferred failure", "partial stream failure", "unverified cancellation", "cancellation survivors", "cancelling", "cancellation-failed",
    "early terminal", "same-time terminal", "no terminal", "no running", "duplicate running", "wrong PID", "invalid timestamp", "unreadable", "malformed",
    "non-stream failure", "cancellation without verification", "invalid queued timestamp",
  ])("U1-T6: %s is per-job doubt and a corrected ledger is re-read", async (kind) => {
    const f = setup();
    let entries: Record<string, unknown>[] = [running(), terminal()];
    if (kind === "inferred failure") entries[1] = { ...terminal(), state: "failed", reason: "process gone and log stale", partial: true };
    if (kind === "partial stream failure") entries[1] = { ...terminal(), state: "failed", partial: true };
    if (kind === "unverified cancellation") entries[1] = { ...terminal(), state: "cancelled" };
    if (kind === "cancellation survivors") entries[1] = { ...terminal(), state: "cancelled", termination_verified: true, survivors: 1 };
    if (["cancelling", "cancellation-failed"].includes(kind)) entries.push({ ...terminal(), state: kind });
    if (kind === "early terminal") entries[1] = { ...terminal(), ts: new Date(runningAt - 1).toISOString() };
    if (kind === "same-time terminal") entries[1] = { ...terminal(), ts: running().ts };
    if (kind === "no terminal") entries = [running()];
    if (kind === "no running") entries = [terminal()];
    if (kind === "duplicate running") entries.push(running());
    if (kind === "wrong PID") entries[0] = { ...running(), pid: PID + 1 };
    if (kind === "invalid timestamp") entries[1] = { ...terminal(), ts: "invalid" };
    if (kind === "non-stream failure") entries[1] = { ...terminal(), state: "failed", reason: "process exited without a terminal event" };
    if (kind === "cancellation without verification") entries[1] = { ...terminal(), state: "cancelled", survivors: 0 };
    if (kind === "invalid queued timestamp") entries.unshift({ ...running(), state: "queued", ts: "invalid" });
    f.writeLedger(entries);
    if (kind === "unreadable") unlinkSync(f.ledger);
    if (kind === "malformed") f.file(f.ledger, "{bad\n");
    const rows = await collectActivity([f.entry, { ...f.entry, path: join(f.root, "other") }], f.options);
    expect(rows.map(row => row.lease.state)).toEqual(["ok", "negative"]);
    expect(f.leaseProcessSnapshot).not.toHaveBeenCalled();
    expect(f.leaseMemo.size).toBe(0);
    f.writeLedger([running(), { ...terminal(), state: "failed" }]);
    expect(leases(f.path, f.options).state).toBe("negative");
  });

  it("U1-T7: fresh logs override even a memoized identity release, with the PID probe first", () => {
    const f = setup();
    f.file(join(f.codexJobStateDirectory, "job/stdout.log"), "fresh", 30 / 3600);
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(f.options.pidAlive).toHaveBeenCalledTimes(1);
    expect(f.leaseProcessSnapshot).not.toHaveBeenCalled();
    f.file(join(f.codexJobStateDirectory, "job/stdout.log"), "stale", 1);
    expect(leases(f.path, f.options).state).toBe("negative");
    f.file(join(f.codexJobStateDirectory, "job/stderr.log"), "fresh", 0);
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(f.options.pidAlive).toHaveBeenCalledTimes(3);
    expect(f.leaseProcessSnapshot).toHaveBeenCalledTimes(1);
  });

  it("U1-T8: shares one lazy snapshot and memoizes only full-manifest identity releases within a run", () => {
    const f = setup();
    f.manifest({ pid: PID + 1, pid_created_at: new Date(born).toISOString() }, "job-two");
    f.writeLedger([running(), terminal(), { ...running("job-two"), pid: PID + 1 }, terminal("job-two")]);
    f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, born + HOUR], [PID + 1, born + HOUR]])));
    expect(leases(f.path, f.options).state).toBe("negative");
    expect(f.leaseProcessSnapshot).toHaveBeenCalledTimes(1);
    expect(f.leaseMemo.size).toBe(2);
    f.leaseProcessSnapshot.mockClear();
    expect(leases(f.path, f.options).state).toBe("negative");
    expect(f.leaseProcessSnapshot).not.toHaveBeenCalled();
    expect(f.options.pidAlive).toHaveBeenCalledTimes(4);
    // A change outside the identity fields must also invalidate the memo key.
    f.manifest({ pid: PID, pid_created_at: new Date(born).toISOString(), prompt_file: "changed" });
    f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, born]])));
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(f.leaseProcessSnapshot).toHaveBeenCalledTimes(1);
    f.leaseProcessSnapshot.mockClear();
    expect(leases(f.path, { ...f.options, pidAlive: () => false }).state).toBe("negative");
    expect(f.leaseProcessSnapshot).not.toHaveBeenCalled();
    // Default memo storage is scoped to the options object (one run), not global.
    const options = { ...f.options, leaseMemo: undefined };
    f.leaseProcessSnapshot.mockReturnValue(ok(new Map([[PID, born + HOUR], [PID + 1, born + HOUR]])));
    expect(leases(f.path, options).state).toBe("negative");
    expect(leases(f.path, options).state).toBe("negative");
    expect(f.leaseProcessSnapshot).toHaveBeenCalledTimes(1);
    expect(leases(f.path, { ...options }).state).toBe("negative");
    expect(f.leaseProcessSnapshot).toHaveBeenCalledTimes(2);
  });

  it.each(["UNKNOWN", "", "not-a-date", "12", 123, false, {}])("U1-T9: malformed pid_created_at=%j never uses the legacy anchor", (stamp) => {
    const f = setup({ pid_created_at: stamp });
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(f.leaseMemo.size).toBe(0);
    f.manifest({ pid: PID, pid_created_at: "unknown" });
    expect(leases(f.path, f.options).state).toBe("negative");
  });

  it("U1-T10: a PID probe error is whole-read unknown even with fresh logs", async () => {
    const f = setup();
    f.file(join(f.codexJobStateDirectory, "job/stdout.log"), "fresh", 0);
    const rows = await collectActivity([f.entry, { ...f.entry, path: join(f.root, "other") }], {
      ...f.options, pidAlive: () => { throw new Error("probe denied"); },
    });
    expect(rows.map(row => row.lease.state)).toEqual(["unknown", "unknown"]);
    expect(f.leaseProcessSnapshot).not.toHaveBeenCalled();
  });

  it("U1-T11: reused modern root with failed cancellation stays un-memoized until verified cancellation", () => {
    const f = setup();
    const failed = { ...terminal(), state: "cancellation-failed", termination_verified: false, survivors: 1 };
    f.writeLedger([running(), terminal(), failed]);
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(leases(f.path, f.options).state).toBe("ok");
    expect(f.leaseMemo.size).toBe(0);
    expect(f.leaseProcessSnapshot).not.toHaveBeenCalled();
    appendFileSync(f.ledger, JSON.stringify({ ...terminal(), state: "cancelled", termination_verified: true, survivors: 0 }) + "\n");
    expect(leases(f.path, f.options).state).toBe("negative");
    expect(f.leaseMemo.size).toBe(1);
  });
});

describe("file mtime activity", () => {
  it.each([71, 72, 73])("uses an inclusive 72-hour floor (%i hours)", (age) => {
    const f = fixture(); f.file(join(f.path, "docs/a.md"), "fixture", age);
    expect(fileActivity(f.path, f.options).state).toBe(age <= 72 ? "ok" : "negative");
  });
  it("reports the newest regular-file mtime across the whole tree", () => {
    const f = fixture();
    f.file(join(f.path, "a-old.md"), "fixture", 73);
    f.file(join(f.path, "b-recent.md"), "fixture", 71);
    f.file(join(f.path, "nested/newest.md"), "fixture", 1);
    expect(fileActivity(f.path, f.options)).toMatchObject({ state: "ok", value: { newestMtimeMs: NOW - HOUR } });
  });
  it("holds on a later metadata error even after finding a recent file", () => {
    const f = fixture(); f.file(join(f.path, "a-recent.md"));
    const denied = f.file(join(f.path, "z-denied.md"));
    const real = vi.mocked(lstatSync).getMockImplementation()!;
    vi.mocked(lstatSync).mockImplementation((...args) => {
      if (String(args[0]) === denied) throw new Error("EACCES");
      return real(...args);
    });
    expect(fileActivity(f.path, f.options).state).toBe("unknown");
  });
  it("ignores .git, node_modules and .next at every depth and directory mtimes", () => {
    const f = fixture();
    for (const prefix of ["", "nested/"]) for (const name of [".git", "node_modules", ".next"]) f.file(join(f.path, prefix + name, "recent"));
    f.file(join(f.path, "old.txt"), "fixture", 73);
    expect(fileActivity(f.path, f.options).state).toBe("negative");
  });
  it("does not follow junctions or a linked root or ancestor", () => {
    const f = fixture(); const target = join(f.root, "target"); f.file(join(target, "recent.txt"));
    const link = join(f.path, "junction"); symlinkSync(target, link, "junction"); junctions.push(link);
    vi.mocked(readdirSync).mockClear();
    expect(fileActivity(f.path, f.options).state).toBe("unknown");
    expect(fileActivity(link, f.options).state).toBe("unknown");
    expect(fileActivity(join(link, "child"), f.options).state).toBe("unknown");
    expect(vi.mocked(readdirSync).mock.calls.some(([path]) => normalizePath(String(path)).startsWith(normalizePath(link)))).toBe(false);
  });
  it("excludes a node_modules junction without reading its target", () => {
    const f = fixture(); const target = join(f.root, "packages"); f.file(join(target, "recent"));
    const link = join(f.path, "node_modules"); symlinkSync(target, link, "junction"); junctions.push(link);
    vi.mocked(readdirSync).mockClear();
    expect(fileActivity(f.path, f.options).state).toBe("negative");
    expect(vi.mocked(readdirSync).mock.calls.some(([path]) => normalizePath(String(path)).startsWith(normalizePath(link)))).toBe(false);
  });
  it("holds on missing trees, denied reads, and timeouts", () => {
    const f = fixture(); expect(fileActivity(join(f.root, "missing"), f.options).state).toBe("unknown");
    vi.mocked(readdirSync).mockImplementationOnce(() => { throw new Error("EACCES"); });
    expect(fileActivity(f.path, f.options).state).toBe("unknown");
    expect(fileActivity(f.path, { ...f.options, walkTimeout: 0 }).state).toBe("unknown");
  });
});

describe("activity aggregation and CLI integration", () => {
  it("returns negative only after every signal is negative and preserves the HEAD snapshot", async () => {
    const f = fixture(); f.file(join(f.path, "old"), "fixture", 73);
    const result = await activity(f.entry, f.options);
    expect(result.live.state).toBe("negative"); expect(result.head).toMatchObject({ state: "ok", value: HEAD });
    expect(result.liveReasons).toEqual([]);
  });
  it("keeps separate signal evidence and holds unknowns even with a positive signal", async () => {
    const f = fixture(); f.file(join(f.path, "recent")); f.file(join(f.codexJobStateDirectory, "bad/manifest.json"), "{bad");
    const result = await activity(f.entry, f.options);
    expect(result.lease.state).toBe("unknown"); expect(result.fileActivity.state).toBe("ok"); expect(result.live.state).toBe("unknown");
    expect(result.liveReasons).toEqual([{ code: 'lease-unknown', state: 'unknown' }, { code: 'file-activity', state: 'ok' }]);
  });
  it("holds when HEAD cannot be recorded", async () => {
    const f = fixture(); expect((await activity({ ...f.entry, registration: ok({ head: null }) }, f.options)).live.state).toBe("unknown");
  });
  it("fails closed for an invalid injected clock", async () => {
    const f = fixture(); const result = await activity(f.entry, { ...f.options, now: () => NaN });
    expect(result.lease.state).toBe("unknown"); expect(result.transcript.state).toBe("unknown"); expect(result.fileActivity.state).toBe("unknown");
  });
  it("scans shared transcript inputs once for multiple worktrees", async () => {
    const f = fixture(); const other = join(f.root, "bt-x2"); mkdirSync(other);
    f.transcript([edit(f.path)]); vi.mocked(createReadStream).mockClear();
    const rows = await collectActivity([f.entry, { ...f.entry, path: other }], f.options);
    expect(rows[0].live.state).toBe("ok"); expect(rows[1].live.state).toBe("negative");
    expect(rows[0].liveReasons).toEqual([{ code: 'transcript', state: 'ok' }]);
    expect(createReadStream).toHaveBeenCalledTimes(1);
  });
  it("adds activity to CLI inventory JSON without changing U1 evidence", async () => {
    const f = fixture(); f.transcript([{ ...edit(f.path), timestamp: new Date().toISOString() }]); vi.mocked(homedir).mockReturnValue(f.homeDirectory);
    // CLI uses the real clock; keep its transcript recent without exposing real session roots.
    const path = join(f.homeDirectory, ".claude/projects/project/session.jsonl"); utimesSync(path, new Date(), new Date());
    const original = { state: "ok", value: { worktrees: [f.entry] } };
    vi.mocked(inventory).mockReturnValueOnce(original as ReturnType<typeof inventory>);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["inventory", "--repo", f.path])).toBe(0);
    const result = JSON.parse(String(output.mock.calls[0][0]));
    expect(result.value.worktrees[0]).toMatchObject({ path: f.path, registration: f.entry.registration, activity: { transcript: { state: "ok", bookkeepingVersion: TRANSCRIPT_BOOKKEEPING_VERSION }, live: { state: "ok" } } });
  });
});
