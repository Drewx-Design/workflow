import './worktree-cleanup-test-env';
import { createHash } from "node:crypto";
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { negative, ok, unknown, type ProbeResult } from "../lib/worktree-cleanup/probe.mjs";
import { inventory, parseStatus } from "../lib/worktree-cleanup/inventory.mjs";
import { collectActivity, leases } from "../lib/worktree-cleanup/activity.mjs";
import { main } from "../worktree-cleanup.mjs";
import { admitRescue, classifyScratch, EXAMPLE_URL_HOSTS, scanSecrets, SCRATCH_PATHS, SECRET_NAME_PATTERNS } from "../lib/worktree-cleanup/admission.mjs";
import { ancestry, planWorktrees, readPrSnapshot, refReachability, snapshotFallback } from "../lib/worktree-cleanup/policy.mjs";
import { defaultReportRoot } from '../lib/worktree-cleanup/report.mjs';

const HEAD = "a".repeat(40), OTHER = "b".repeat(40);
const OWNER_NOW = Date.parse('2026-10-05T12:00:00Z');
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
function tree(name = "topic") {
  const path = resolve(tmpdir(), "cleanup-policy", name);
  return {
    path, registration: ok({ path, head: HEAD, branch: "refs/heads/" + name, detached: false, bare: false, locked: null, prunable: null }),
    exemption: negative(), identity: ok({ topLevel: path, commonDirectory: resolve(tmpdir(), "primary/.git") }),
    activity: { live: negative() as ProbeResult<unknown>, head: ok(HEAD) },
    status: ok({ clean: true, entries: parseStatus("") }), ignored: ok({ entries: [] as string[], unexpected: [] as string[] }),
    links: ok({ entries: [], forbidden: [] as string[], nodeModulesTarget: null, nodeModulesTargetEvidence: null }), inboundLinks: negative(),
    containment: ok({ parents: [] as string[], children: [] as string[], unregisteredRepositories: [] as string[] }),
    holdReasons: [] as string[],
  };
}
function detached(t = tree()) {
  if (t.registration.state === "ok") Object.assign(t.registration.value, { branch: null, detached: true });
  return t;
}
function dirty(status = "?? notes.md\0", t = tree()) {
  t.status = ok({ clean: false, entries: parseStatus(status) }); return t;
}
function pr(overrides = {}) {
  return { number: 1, headRefName: "topic", headRefOid: HEAD, state: "MERGED", baseRefName: "main", ...overrides };
}
const defaults = () => ({ prSnapshot: ok([]), ancestorOfMain: vi.fn(() => negative()), readFile: vi.fn(() => Buffer.from("# Notes\n")) });
async function classify(t = tree(), options = {}) {
  const result = await planWorktrees({ primaryPath: resolve(tmpdir(), "primary"), worktrees: [t] }, { ...defaults(), ...options });
  if (result.state !== "ok") throw new Error("Plan unavailable");
  expect(result.value.worktrees).toHaveLength(1);
  expect(result.value.worktrees[0].reasonCode).toEqual(expect.any(String));
  return result.value.worktrees[0];
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cleanup-policy-")); roots.push(root);
  const t = dirty(); t.path = root;
  if (t.registration.state === "ok") t.registration.value.path = root;
  writeFileSync(join(root, "notes.md"), "# Notes\r\n");
  return t;
}

describe('owner release policy', () => {
  function mention(sessionId: string | null = 'owner', hours = 1, kind = 'claude') {
    return { kind, sessionId, filePath: 'fixture.jsonl', latestMentionMs: OWNER_NOW - hours * 3_600_000 };
  }
  function ownerTree(t = tree()) {
    return { ...t, activity: { head: ok(HEAD), lease: negative(), fileActivity: ok(true),
      transcript: { ...ok({ count: 1 }), attributed: { complete: true, mentions: [mention()], doubts: [] } },
      live: ok({ reasons: ['transcript', 'fileActivity'] }), liveReasons: [{ code: 'transcript', state: 'ok' }] } };
  }
  function options(t: { path: string }) {
    const homeDirectory = mkdtempSync(join(tmpdir(), 'owner-policy-')); roots.push(homeDirectory);
    return { ownerRelease: { path: t.path.toUpperCase(), sessionId: 'owner', homeDirectory, now: () => OWNER_NOW } };
  }
  async function admitted(t = ownerTree()) {
    const opts = options(t);
    expect(await classify(t, opts)).toMatchObject({ disposition: 'remove-keep-branch' });
    return { t, opts };
  }
  it('holds transcript evidence without doubts as transcript-unreadable', async () => {
    const t = ownerTree(), opts = options(t);
    Reflect.deleteProperty(t.activity.transcript.attributed, 'doubts');
    Object.assign(t.activity, { live: negative() });
    expect(await classify(t, opts)).toMatchObject({ disposition: 'hold', reasonCode: 'transcript-unreadable' });
  });
  it.each(['ok', 'negative', 'unknown'])('ignores %s file activity only for the owner, and skips merge evidence', async state => {
    const t = ownerTree(), opts = options(t), fetchMain = vi.fn(() => unknown('offline')), ancestorOfMain = vi.fn(() => unknown('unused'));
    Object.assign(t.activity, { fileActivity: { state } });
    expect(await classify(t, { ...opts, fetchMain, ancestorOfMain, prSnapshot: ok([pr()]) })).toMatchObject({ disposition: 'remove-keep-branch' });
    expect(fetchMain).not.toHaveBeenCalled(); expect(ancestorOfMain).not.toHaveBeenCalled();
    expect(await classify(t)).toMatchObject({ disposition: 'hold', reasonCode: 'transcript' });
  });
  it.each(['owner', 'other', undefined])('attributes dispatched rollouts by manifest owner %s, never cwd', async owner_session => {
    const { t, opts } = await admitted();
    t.activity.transcript.attributed.mentions.push(mention('worker', 1, 'codex'));
    const job = join(opts.ownerRelease.homeDirectory, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
    writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'job', cwd: t.path, session_id: 'worker', owner_session }));
    expect(await classify(t, opts)).toMatchObject(owner_session === 'owner'
      ? { disposition: 'remove-keep-branch' } : { disposition: 'hold', reasonCode: 'foreign-session-recent' });
  });
  it.each([2, 6, 7])('uses the six-hour foreign-mention window (%s hours)', async hours => {
    const { t, opts } = await admitted(); t.activity.transcript.attributed.mentions.push(mention('foreign', hours));
    expect(await classify(t, opts)).toMatchObject(hours <= 6 ? { disposition: 'hold', reasonCode: 'foreign-session-recent' } : { disposition: 'remove-keep-branch' });
  });
  it.each(['invalid-json', 'wrong-id', 'linked-job', 'missing-root'])('fails closed for owner-job manifest evidence: %s', async kind => {
    const { t, opts } = await admitted();
    t.activity.transcript.attributed.mentions = [mention('worker', 1, 'codex')];
    const root = join(opts.ownerRelease.homeDirectory, '.claude', 'codex-jobs'), job = join(root, 'job');
    if (kind !== 'missing-root') {
      mkdirSync(root, { recursive: true });
      if (kind === 'linked-job') {
        const target = join(opts.ownerRelease.homeDirectory, 'linked'); mkdirSync(target);
        writeFileSync(join(target, 'manifest.json'), JSON.stringify({ id: 'job', session_id: 'worker', owner_session: 'owner' }));
        symlinkSync(target, job, 'junction');
      } else {
        mkdirSync(job);
        writeFileSync(join(job, 'manifest.json'), kind === 'invalid-json' ? '{' : JSON.stringify({ id: 'other', session_id: 'worker', owner_session: 'owner' }));
      }
    }
    try {
      expect(await classify(t, opts)).toMatchObject({ disposition: 'hold', reasonCode: kind === 'missing-root' ? 'foreign-session-recent' : 'transcript-unreadable' });
    } finally { if (kind === 'linked-job') { if (process.platform === 'win32') rmdirSync(job); else unlinkSync(job); } }
  });
  it.each(['owner', 'other'])('applies dispatcher attribution to unresolved doubt (%s)', async owner_session => {
    const { t, opts } = await admitted();
    Object.assign(t.activity.transcript.attributed, { mentions: [], doubts: [
      { kind: 'codex', sessionId: 'worker', filePath: 'fixture.jsonl', latestRecordMs: OWNER_NOW - 3_600_000 },
    ] });
    const job = join(opts.ownerRelease.homeDirectory, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
    writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'job', session_id: 'worker', owner_session }));
    expect(await classify(t, opts)).toMatchObject(owner_session === 'owner'
      ? { disposition: 'remove-keep-branch' } : { disposition: 'hold', reasonCode: 'foreign-session-recent' });
  });
  it.each(['missing-owner', 'missing-identity', 'invalid-time', 'incomplete', 'absent-attribution'])('fails closed for %s even with a negative rollup', async kind => {
    const { t, opts } = await admitted();
    if (kind === 'missing-owner') Object.assign(opts.ownerRelease, { sessionId: undefined });
    if (kind === 'missing-identity') t.activity.transcript.attributed.mentions = [mention(null)];
    if (kind === 'invalid-time') t.activity.transcript.attributed.mentions[0].latestMentionMs = NaN;
    if (kind === 'incomplete') t.activity.transcript.attributed.complete = false;
    if (kind === 'absent-attribution') Object.assign(t.activity.transcript, { attributed: undefined });
    Object.assign(t.activity, { live: negative() });
    expect(await classify(t, opts)).toMatchObject({ disposition: 'hold', reasonCode: kind.startsWith('missing-') ? 'foreign-session-recent' : 'transcript-unreadable' });
  });
  it.each(['positive', 'unknown'])('requires an explicitly negative lease (%s)', async state => {
    const { t, opts } = await admitted(); Object.assign(t.activity, { lease: state === 'positive' ? ok(true) : unknown('failed'), live: negative() });
    expect(await classify(t, opts)).toMatchObject({ disposition: 'hold', reasonCode: state === 'positive' ? 'lease' : 'lease-unknown' });
  });
  it.each(['untracked', 'modified', 'staged', 'ignored', 'allowed-ignored'])('uses clean-only handling for %s', async kind => {
    const { t, opts } = await admitted(); const readFile = vi.fn(), idleEvidence = vi.fn();
    if (kind === 'ignored') t.ignored = ok({ entries: ['coverage/'], unexpected: ['coverage/'] });
    else if (kind === 'allowed-ignored') t.ignored = ok({ entries: ['node_modules/', '.next/'], unexpected: [] });
    else dirty(kind === 'untracked' ? '?? notes.md\0' : kind === 'modified' ? ' M notes.md\0' : 'M  notes.md\0', t);
    expect(await classify(t, { ...opts, readFile, idleEvidence })).toMatchObject(kind === 'allowed-ignored' ? { disposition: 'remove-keep-branch' } : { disposition: 'hold', reasonCode: 'dirty' });
    expect(readFile).not.toHaveBeenCalled(); expect(idleEvidence).not.toHaveBeenCalled();
  });
  it.each(['open-pr', 'pr-unknown', 'shared', 'child', 'unregistered-child', 'head-changed', 'head-unknown'])('retains the %s gate', async gate => {
    const { t, opts } = await admitted();
    if (gate === 'shared') Object.assign(t, { inboundLinks: ok([{ source: 'other/node_modules' }]) });
    if (gate === 'child' && t.containment.state === 'ok') t.containment.value.children.push(tree('child').path);
    if (gate === 'unregistered-child' && t.containment.state === 'ok') t.containment.value.unregisteredRepositories.push('nested');
    if (gate === 'head-changed') t.activity.head = ok(OTHER);
    if (gate === 'head-unknown') t.activity.head = unknown('failed');
    const prSnapshot = gate === 'open-pr' ? ok([pr({ state: 'OPEN' })]) : gate === 'pr-unknown' ? unknown('offline') : ok([]);
    expect(await classify(t, { ...opts, prSnapshot })).toMatchObject({ disposition: 'hold', reasonCode: gate.includes('child') ? 'nesting' : gate });
  });
  it.each(['reachable', 'unreachable', 'unknown', 'open-pr', 'pr-unknown'])('handles detached owner HEADs with %s evidence', async kind => {
    const { t, opts } = await admitted(); detached(t);
    const reachableFromRef = vi.fn(() => kind === 'unreachable' ? negative() : kind === 'unknown' ? unknown('failed') : ok(true));
    const prSnapshot = kind === 'open-pr' ? ok([pr({ state: 'OPEN', headRefName: 'other' })]) : kind === 'pr-unknown' ? unknown('offline') : ok([]);
    expect(await classify(t, { ...opts, reachableFromRef, prSnapshot })).toMatchObject(kind === 'reachable'
      ? { disposition: 'remove' } : { disposition: 'hold', reasonCode: kind === 'unreachable' ? 'unmerged-detached' : kind });
    if (kind.includes('pr')) expect(reachableFromRef).not.toHaveBeenCalled();
  });
  it('leaves every non-owner decision identical to the nightly plan', async () => {
    const { t, opts } = await admitted();
    const others = [ownerTree(tree('live')), dirty('?? code.ts\0', tree('dirty')), detached(tree('detached')), tree('unknown')];
    others[3].status = unknown('failed');
    const input = { primaryPath: resolve(tmpdir(), 'primary'), worktrees: [t, ...others] };
    const nightly = await planWorktrees(input, defaults()), release = await planWorktrees(input, { ...defaults(), ...opts });
    if (nightly.state !== 'ok' || release.state !== 'ok') throw new Error('Plan failed');
    expect(release.value.worktrees.slice(1)).toEqual(nightly.value.worktrees.slice(1));
  });
  it('does not release a non-owner parent through its newly removable owner child', async () => {
    const parent = tree('parent'), child = ownerTree(tree('parent/child')), opts = options(child);
    if (parent.containment.state === 'ok') parent.containment.value.children.push(child.path);
    const input = { primaryPath: resolve(tmpdir(), 'primary'), worktrees: [child, parent] };
    const nightly = await planWorktrees(input, defaults()), release = await planWorktrees(input, { ...defaults(), ...opts });
    if (nightly.state !== 'ok' || release.state !== 'ok') throw new Error('Plan failed');
    expect(release.value.worktrees[0].disposition).toBe('remove-keep-branch');
    expect(release.value.worktrees[1]).toEqual(nightly.value.worktrees[1]);
  });
  it.each(['live', 'recently-finished', 'absent', 'finished'])('agrees with lease-check grace semantics for %s jobs', async state => {
    const { t, opts } = await admitted();
    if (state !== 'absent') {
      const job = join(opts.ownerRelease.homeDirectory, '.claude', 'codex-jobs', 'job'); mkdirSync(job, { recursive: true });
      writeFileSync(join(job, 'manifest.json'), JSON.stringify({ id: 'job', cwd: t.path, pid: state === 'live' ? 123 : null,
        started_at: new Date(OWNER_NOW - 120_000).toISOString() }));
      if (state === 'recently-finished') {
        const log = join(job, 'stdout.log'); writeFileSync(log, 'done');
        const finished = new Date(OWNER_NOW - 30_000); utimesSync(log, finished, finished);
      }
    }
    const lease = leases(t.path, { ...opts.ownerRelease, pidAlive: () => true });
    expect(lease.state).toBe(['live', 'recently-finished'].includes(state) ? 'ok' : 'negative');
    Object.assign(t.activity, { lease });
    expect(await classify(t, opts)).toMatchObject(lease.state === 'ok' ? { disposition: 'hold', reasonCode: 'lease' } : { disposition: 'remove-keep-branch' });
  });
  it.each(['refs/heads/topic\n', 'refs/remotes/origin/topic\n', 'refs/tags/v1\n', '', 'refs/stash\n', 'garbage'])('validates ref containment output %j', output => {
    const runProbe = vi.fn(() => ok(output));
    expect(refReachability(resolve(tmpdir()), HEAD, { gitPath: process.execPath, runProbe }).state)
      .toBe(output === '' ? 'negative' : /^refs\/(heads|remotes|tags)\//.test(output) ? 'ok' : 'unknown');
    expect(runProbe.mock.calls[0]).toEqual([process.execPath, expect.arrayContaining(['for-each-ref', '--contains=' + HEAD, 'refs/heads/', 'refs/remotes/', 'refs/tags/']), expect.any(Object)]);
  });
});

describe("PR snapshot and ancestry probes", () => {
  it('requests open snapshots explicitly without losing the limit or saturation check', () => {
    const runProbe = vi.fn((_executable: string, _args: string[]) => ok('[]'));
    expect(readPrSnapshot(resolve(tmpdir()), { state: 'open', ghPath: process.execPath, runProbe }).state).toBe('ok');
    expect(runProbe.mock.calls[0][1]).toEqual(expect.arrayContaining(['--state', 'open', '--limit', '10000']));
    runProbe.mockReturnValue(ok(JSON.stringify(Array.from({ length: 10000 }, (_, i) => pr({ number: i + 1, state: 'OPEN' })))));
    expect(readPrSnapshot(resolve(tmpdir()), { state: 'open', ghPath: process.execPath, runProbe }).state).toBe('unknown');
  });
  it("uses an absolute executable and the complete KTD4 argument array once", () => {
    const runProbe = vi.fn((_executable: string, _args: string[], _options?: object) => ok(JSON.stringify([pr()])));
    expect(readPrSnapshot(resolve(tmpdir()), { ghPath: process.execPath, runProbe })).toMatchObject({ state: "ok", value: [pr()] });
    expect(runProbe).toHaveBeenCalledOnce();
    expect(runProbe.mock.calls[0]).toEqual([process.execPath, ["pr", "list", "--state", "all", "--limit", "10000", "--json", "number,headRefName,headRefOid,state,baseRefName"], expect.objectContaining({ cwd: resolve(tmpdir()) })]);
    expect(isAbsolute(runProbe.mock.calls[0][0])).toBe(true);
  });
  it.each(["not json", "{}", "null", '[{"state":"OPEN"}]', JSON.stringify([pr({ state: "bogus" })]), JSON.stringify([pr({ headRefOid: "bad" })])])("rejects malformed PR output %s", (value) => {
    expect(readPrSnapshot(resolve(tmpdir()), { ghPath: process.execPath, runProbe: () => ok(value) }).state).toBe("unknown");
  });
  it("holds on failure, thrown runner, and the 10000-row limit", () => {
    for (const runProbe of [() => ({ ...unknown("failed", "error"), exitCode: 1 }), () => { throw new Error("offline"); }, () => ok(JSON.stringify(Array.from({ length: 10000 }, (_, i) => pr({ number: i + 1 }))))]) {
      expect(readPrSnapshot(resolve(tmpdir()), { ghPath: process.execPath, runProbe }).state).toBe("unknown");
    }
  });
  it("proves ancestry using a successful count, never an exit-code-1 negative", () => {
    for (const [output, state] of [["0\n", "ok"], ["12\n", "negative"], ["", "unknown"], ["-1\n", "unknown"], ["0\nnoise", "unknown"]]) {
      const runProbe = vi.fn((_executable: string, _args: string[]) => ok(output));
      expect(ancestry(resolve(tmpdir()), HEAD, { gitPath: process.execPath, runProbe }).state).toBe(state);
      expect(runProbe.mock.calls[0][1]).toContain("--not");
      expect(runProbe.mock.calls[0][1]).toContain("origin/main");
    }
    expect(ancestry(resolve(tmpdir()), HEAD, { gitPath: process.execPath, runProbe: () => unknown("exit 1") }).state).toBe("unknown");
  });
});

describe("classification and hold order", () => {
  function doubtOnly(t = tree()) {
    return { ...t, activity: { ...t.activity, lease: negative(), fileActivity: negative(),
      transcript: { ...unknown('Recent transcript unavailable: Unresolved relative command path'), literalMatches: 0,
        observed: { ...unknown('Recent transcript unavailable: Unresolved relative command path'), literalMatches: 0 } },
      live: unknown('Activity evidence unknown: transcript'), liveReasons: [{ code: 'unresolved-command', state: 'unknown' }] } };
  }
  it.each([true, false])('releases only named doubt-only trees into their normal disposition (merged=%s)', async merged => {
    const named = doubtOnly(tree('named')), unnamed = doubtOnly(tree('unnamed'));
    const input = { primaryPath: resolve(tmpdir(), 'primary'), worktrees: [named, unnamed] };
    const before = JSON.stringify(input), options = { ...defaults(), ancestorOfMain: () => merged ? ok(true) : negative(), observeLiveness: true };
    const baseline = await planWorktrees(input, options);
    expect(JSON.stringify(await planWorktrees(input, { ...options, operatorRelease: [] }))).toBe(JSON.stringify(baseline));
    const result = await planWorktrees(input, { ...options, operatorRelease: [named.path.toUpperCase()] });
    expect(result).toMatchObject({ state: 'ok', value: { worktrees: [
      { path: named.path, disposition: merged ? 'remove' : 'remove-keep-branch' },
      { path: unnamed.path, disposition: 'hold', reasonCode: 'unresolved-command', wouldBeRemovable: true },
    ] } });
    expect(JSON.stringify(input)).toBe(before);
  });
  it.each(['lease', 'transcript', 'file-activity', 'head-changed', 'transcript-unreadable'])('keeps named trees held by %s, alone or alongside doubt', async code => {
    for (const alongside of [false, true]) {
      const t = doubtOnly();
      const state = code === 'transcript-unreadable' ? 'unknown' : 'ok';
      Object.assign(t.activity, { liveReasons: [...(alongside ? t.activity.liveReasons : []), { code, state }] });
      if (code === 'lease') Object.assign(t.activity, { lease: ok(true) });
      if (code === 'transcript') Object.assign(t.activity, { transcript: ok({ count: 1 }) });
      if (code === 'file-activity') Object.assign(t.activity, { fileActivity: ok({ newestMtimeMs: Date.now() }) });
      if (code === 'head-changed') t.activity.head = ok(OTHER);
      if (code === 'transcript-unreadable') Object.assign(t.activity, { transcript: unknown('Unreadable transcript') });
      expect(await classify(t, { operatorRelease: [t.path] })).toMatchObject({ disposition: 'hold', reason: 'live' });
    }
  });
  it('holds a literal transcript hit masked by the folder-doubt rollup', async () => {
    const t = doubtOnly();
    Object.assign(t.activity.transcript, { observed: ok({ count: 1 }) });
    expect(await classify(t, { operatorRelease: [t.path] })).toMatchObject({ disposition: 'hold', reason: 'live' });
  });
  it.each([undefined, null, '0', NaN, -1, 1])('holds a release without an explicit zero literal count (%s)', async literalMatches => {
    for (const signal of ['deciding', 'observed']) {
      const t = doubtOnly();
      Object.assign(signal === 'deciding' ? t.activity.transcript : t.activity.transcript.observed, { literalMatches });
      expect(await classify(t, { operatorRelease: [t.path] })).toMatchObject({ disposition: 'hold', reason: 'live' });
    }
  });
  it.each(['lease', 'fileActivity', 'head', 'transcript', 'liveReasons'])('holds incomplete or failed %s evidence even with a doubt-only label', async signal => {
    const t = doubtOnly();
    Object.assign(t.activity, { [signal]: signal === 'liveReasons' ? [] : unknown('Evidence provider failed') });
    expect(await classify(t, { operatorRelease: [t.path] })).toMatchObject({ disposition: 'hold', reason: 'live' });
  });
  it.each(['links', 'exemption', 'status'])('retains the %s safety gate on a released tree', async signal => {
    const t = doubtOnly();
    Object.assign(t, { [signal]: unknown('Safety evidence unavailable') });
    const released = await classify(t, { operatorRelease: [t.path] });
    const clear = { ...t, activity: { live: negative(), head: ok(HEAD) } };
    expect(JSON.stringify(released)).toBe(JSON.stringify(await classify(clear)));
    expect(released.disposition).toBe('hold');
  });
  it.each([
    ['lease', 'ok'], ['transcript', 'ok'], ['file-activity', 'ok'],
    ['lease-unknown', 'unknown'], ['transcript-unreadable', 'unknown'], ['unresolved-command', 'unknown'], ['file-activity-unknown', 'unknown'],
  ])('keeps the stable liveness reason %s separate from its display text', async (code, state) => {
    const t = tree();
    Object.assign(t.activity, { live: state === 'ok' ? ok(true) : unknown('Activity evidence unknown'),
      liveReasons: [...(state === 'unknown' ? [{ code: 'lease', state: 'ok' }] : []), { code, state }] });
    expect(await classify(t)).toMatchObject({ disposition: 'hold', reason: 'live', reasonCode: code });
  });
  it('names changed and unknown HEAD evidence separately', async () => {
    const changed = tree(); changed.activity.head = ok(OTHER);
    expect(await classify(changed)).toMatchObject({ reasonCode: 'head-changed' });
    changed.activity.head = unknown('HEAD unavailable');
    expect(await classify(changed)).toMatchObject({ reasonCode: 'head-unknown' });
  });
  it('observes liveness-only removability without changing any deciding disposition or input', async () => {
    const clean = tree('clean'), dirtyTree = dirty('?? notes.md\0', tree('dirty')), linked = tree('linked'),
      unreadable = tree('unreadable'), unresolved = tree('unresolved'), parent = tree('parent'), child = tree('child'), changed = tree('changed');
    for (const t of [clean, dirtyTree, linked, unreadable, unresolved, parent, child, changed]) {
      Object.assign(t.activity, { live: ok({ reasons: ['transcript'] }), liveReasons: [{ code: 'transcript', state: 'ok' }] });
    }
    Object.assign(unreadable.activity, { live: unknown('Unreadable'), liveReasons: [{ code: 'transcript-unreadable', state: 'unknown' }] });
    Object.assign(unresolved.activity, { live: unknown('Unresolved'), liveReasons: [{ code: 'unresolved-command', state: 'unknown' }] });
    if (linked.links.state === 'ok') linked.links.value.forbidden.push('other-link');
    if (parent.containment.state === 'ok') parent.containment.value.children.push(child.path);
    changed.activity.head = ok(OTHER);
    const input = { primaryPath: resolve(tmpdir(), 'primary'), worktrees: [clean, dirtyTree, linked, unreadable, unresolved, parent, child, changed] };
    const before = JSON.stringify(input), options = { ...defaults(), ancestorOfMain: () => ok(true) };
    const deciding = await planWorktrees(input, options);
    const observed = await planWorktrees(input, { ...options, observeLiveness: true });
    expect(JSON.stringify(input)).toBe(before);
    if (deciding.state !== 'ok' || observed.state !== 'ok') throw new Error('Plan unavailable');
    expect(observed.value.worktrees.map(({ wouldBeRemovable: _observation, ...decision }) => decision)).toEqual(deciding.value.worktrees);
    expect(observed.value.worktrees.map(t => t.wouldBeRemovable)).toEqual([true, false, false, true, true, false, true, false]);
    expect(new Set(observed.value.worktrees.map(t => t.path)).size).toBe(input.worktrees.length);
    for (const decision of observed.value.worktrees) expect(decision.reasonCode).toEqual(expect.any(String));
  });
  it("removes an exact merged main PR head without needing ancestry", async () => {
    const ancestorOfMain = vi.fn(() => unknown("unused"));
    expect(await classify(tree(), { prSnapshot: ok([pr()]), ancestorOfMain })).toMatchObject({ disposition: "remove" });
    expect(ancestorOfMain).not.toHaveBeenCalled();
  });
  it("keeps a named branch with later commits or a merge to a feature branch", async () => {
    for (const row of [pr({ headRefOid: OTHER }), pr({ baseRefName: "feature" }), pr({ state: "CLOSED" })]) {
      expect(await classify(tree(), { prSnapshot: ok([row]) })).toMatchObject({ disposition: "remove-keep-branch" });
    }
  });
  it("holds an unmerged detached head, including one with rescuable docs", async () => {
    for (const t of [detached(), detached(dirty())]) expect(await classify(t, { prSnapshot: ok([pr({ headRefOid: OTHER })]) })).toMatchObject({ disposition: "hold", reason: "unmerged-detached" });
  });
  it("requires ancestry for clean detached heads even with an exact merged PR", async () => {
    expect(await classify(detached(), { prSnapshot: ok([pr()]) })).toMatchObject({ disposition: "hold", reason: "unmerged-detached" });
    expect(await classify(detached(), { prSnapshot: unknown("offline"), ancestorOfMain: () => ok(true) })).toMatchObject({ disposition: "remove" });
  });
  it("holds open PRs on any base even with different head OIDs or merge proof", async () => {
    for (const t of [tree(), dirty(), dirty("?? code.ts\0")]) {
      expect(await classify(t, { prSnapshot: ok([pr(), pr({ number: 2, state: "OPEN", headRefOid: OTHER, baseRefName: "feature" })]), idleEvidence: () => ok(true) })).toMatchObject({ disposition: "hold", reason: "open-pr" });
    }
  });
  it("finds an open PR beyond the 30 newest records", async () => {
    const rows = Array.from({ length: 31 }, (_, i) => pr({ number: i + 1, headRefName: "other" }));
    rows.push(pr({ number: 100, state: "OPEN" }));
    expect(await classify(tree(), { prSnapshot: ok(rows) })).toMatchObject({ disposition: "hold", reason: "open-pr" });
  });
  it("holds every PR-dependent verdict when the snapshot is unavailable", async () => {
    for (const t of [tree(), dirty(), dirty("?? code.ts\0")]) expect(await classify(t, { prSnapshot: unknown("offline"), ancestorOfMain: () => ok(true), idleEvidence: () => ok(true) })).toMatchObject({ disposition: "hold", reason: "pr-unknown" });
  });
  it("does not mistake an unknown ancestry for unmerged named work", async () => {
    expect(await classify(tree(), { ancestorOfMain: () => unknown("missing main") })).toMatchObject({ disposition: "hold", reason: "unknown" });
  });
  it("first holds exemption, identity, live, links, nesting, then status", async () => {
    const t = tree(); t.exemption = ok({ reasons: ["runner"] }) as typeof t.exemption;
    t.identity = unknown("missing"); t.activity.live = ok({ reasons: ["transcript"] }) as typeof t.activity.live;
    t.links = unknown("scan failed"); t.status = unknown("status failed");
    expect(await classify(t)).toMatchObject({ reason: "exempt" });
    t.exemption = negative(); expect(await classify(t)).toMatchObject({ reason: "identity" });
    t.identity = tree().identity; expect(await classify(t)).toMatchObject({ reason: "live" });
    t.activity.live = negative(); expect(await classify(t)).toMatchObject({ reason: "links" });
    t.links = tree().links; expect(await classify(t)).toMatchObject({ reason: "unknown" });
  });
  it.each(["live", "head"])("holds unknown activity %s", async (field) => {
    const t = tree(); t.activity[field as "live" | "head"] = unknown("unreadable");
    expect(await classify(t)).toMatchObject({ disposition: "hold", reason: "live" });
  });
  it("holds a changed HEAD, a locked registration and unknown ignored evidence", async () => {
    const changed = tree(); changed.activity.head = ok(OTHER);
    expect(await classify(changed)).toMatchObject({ reason: "live" });
    const locked = tree(); if (locked.registration.state === "ok") Object.assign(locked.registration.value, { locked: "keep" });
    expect(await classify(locked)).toMatchObject({ disposition: "hold" });
    const ignored = tree(); ignored.ignored = unknown("failed");
    expect(await classify(ignored)).toMatchObject({ reason: "unknown" });
  });
  it("holds forbidden links, inbound links and unregistered children", async () => {
    const linked = tree(); linked.links = ok({ entries: [], forbidden: ["packages/x/cache"], nodeModulesTarget: null, nodeModulesTargetEvidence: null });
    expect(await classify(linked, { prSnapshot: ok([pr()]) })).toMatchObject({ reason: "links" });
    const inbound = tree(); inbound.inboundLinks = ok([{}]) as typeof inbound.inboundLinks;
    expect(await classify(inbound)).toMatchObject({ reason: "shared" });
    const nested = tree(); if (nested.containment.state === "ok") nested.containment.value.unregisteredRepositories.push(join(nested.path, "child"));
    expect(await classify(nested)).toMatchObject({ reason: "nesting" });
  });
  it("retains rejected node_modules evidence before an unresolved inbound map", async () => {
    const t = tree(); t.links = ok({ entries: [], forbidden: ["node_modules"], nodeModulesTarget: null, nodeModulesTargetEvidence: null });
    t.inboundLinks = unknown("Link chain cycle");
    expect(await classify(t)).toMatchObject({ disposition: "hold", reason: "links", evidence: t.links });
  });
  it.each([unknown("Full scan unavailable"), negative(), null, undefined])("holds an admissible junction with a non-ok classification snapshot: %s", async targetBaseline => {
    const t = Object.assign(tree(), { targetBaseline });
    if (t.links.state === "ok") Object.assign(t.links.value, {
      nodeModulesTarget: join(tmpdir(), "target"),
      nodeModulesTargetEvidence: ok({ topLevelCount: 2, lockHash: "known" }),
    });
    expect(await classify(t)).toMatchObject({ disposition: "hold", reason: "links", reasonCode: "links", evidence: t.links,
      reasonDetail: targetBaseline?.state === 'unknown' ? 'Full scan unavailable' : 'Junction target snapshot unavailable' });
  });
  it.each([unknown("Lockfile unavailable"), negative(), null, undefined])("holds a candidate junction with non-ok cheap target evidence: %s", async nodeModulesTargetEvidence => {
    const t = tree();
    if (t.links.state === "ok") Object.assign(t.links.value, {
      nodeModulesTarget: join(tmpdir(), "target"), nodeModulesTargetEvidence,
    });
    expect(await classify(t)).toMatchObject({ disposition: "hold", reason: "links", reasonCode: "links", evidence: t.links,
      reasonDetail: nodeModulesTargetEvidence?.state === 'unknown' ? 'Lockfile unavailable' : 'Junction target evidence unavailable' });
  });
  it("does not hold a candidate junction when cheap evidence is ok and the full snapshot is absent", async () => {
    const t = tree();
    if (t.links.state === "ok") Object.assign(t.links.value, {
      nodeModulesTarget: join(tmpdir(), "target"),
      nodeModulesTargetEvidence: ok({ topLevelCount: 2, lockHash: "known" }),
    });
    expect(await classify(t)).toMatchObject({ disposition: "remove-keep-branch" });
  });
  it("resolves child dispositions before parents and preserves inventory output order", async () => {
    const parent = tree(), child = tree("topic/child");
    if (parent.containment.state === "ok") parent.containment.value.children.push(child.path);
    child.activity.live = ok(true) as typeof child.activity.live;
    const input = { primaryPath: resolve(tmpdir()), worktrees: [parent, child] };
    const held = await planWorktrees(input, defaults());
    expect(held).toMatchObject({ state: "ok", value: { worktrees: [{ path: parent.path, disposition: "hold", reason: "nesting" }, { path: child.path, reason: "live" }] } });
    child.activity.live = negative();
    expect(await planWorktrees(input, defaults())).toMatchObject({ state: "ok", value: { worktrees: [{ disposition: "remove-keep-branch" }, { disposition: "remove-keep-branch" }] } });
  });
  it("treats absent child dispositions as unknown nesting", async () => {
    const t = tree(); if (t.containment.state === "ok") t.containment.value.children.push(join(t.path, "missing"));
    expect(await classify(t)).toMatchObject({ reason: "nesting" });
  });
});

describe("rescue admission", () => {
  it("admits two markdown files, retaining the scanned buffers and raw Git SHA", async () => {
    const bytes = Buffer.from("# Notes\r\n"), readFile = vi.fn(() => bytes);
    const decision = await classify(dirty("?? one.md\0 M docs/two.md\0"), { readFile });
    expect(decision).toMatchObject({ disposition: "rescue", files: [{ path: "one.md" }, { path: "docs/two.md" }] });
    expect(readFile).toHaveBeenCalledTimes(2);
    for (const file of decision.files!) {
      expect(file.bytes).toBe(bytes);
      expect(file.blobSha).toBe(createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex"));
      expect(file.rescuedPath).toBe(`docs/rescued/topic-${HEAD.slice(0, 7)}/${file.path}`);
    }
  });
  it.each(["MM notes.md\0", "A  new.md\0", "M  notes.md\0", "UU notes.md\0", "D  notes.md\0"])("holds staged state %s", async (status) => {
    expect(await classify(dirty(status))).toMatchObject({ disposition: "hold", reason: "staged" });
  });
  it.each(["?? notes.md\0?? code.ts\0", " D notes.md\0", " R new.md\0old.md\0", " T notes.md\0"])("rejects non-rescuable leftovers %s", async (status) => {
    expect(await classify(dirty(status))).toMatchObject({ disposition: "hold", reason: "leftovers" });
  });
  it("holds non-allowlisted ignored files even with clean status", async () => {
    const t = tree(); t.ignored = ok({ entries: ["private/"], unexpected: ["private/"] });
    expect(await classify(t)).toMatchObject({ disposition: "hold", reason: "leftovers" });
  });
  it("allows inventory-approved ignored build output", async () => {
    const t = tree(); t.ignored = ok({ entries: ["node_modules/", "tsconfig.tsbuildinfo"], unexpected: [] });
    expect(await classify(t)).toMatchObject({ disposition: "remove-keep-branch" });
  });
  it("returns unknown for unreadable bytes, and does not offer archival", async () => {
    const idleEvidence = vi.fn(() => ok(true));
    expect(await classify(dirty(), { readFile: () => { throw new Error("denied"); }, idleEvidence })).toMatchObject({ disposition: "hold", reason: "unknown" });
    expect(idleEvidence).not.toHaveBeenCalled();
  });
  it.each(["-----BEGIN OPENSSH PRIVATE KEY-----", "ghp_abcdef", "gho_abcdef", "github_pat_abcdef", "sk-ant-abcdef", "sk-example", "sk_live_abcdef", "rk_test_abcdef", "pk_live_abcdef", "whsec_abcdef", "npg_abcdef", "AKIA1234567890123456", "xoxb-abcdef", "xoxp-abcdef", "Authorization: Bearer abc.def.ghi", "postgresql://neondb_owner:abc123@host/db", 'api_token="A7z9B2q8W1e6R4t0Y3u5I9o2P8"'])("holds secret shape without echoing it: %s", async (secret) => {
    const decision = await classify(dirty(), { readFile: () => Buffer.from(secret) });
    expect(decision).toMatchObject({ disposition: "hold", reason: "secret-shape" });
    expect(JSON.stringify(decision)).not.toContain(secret);
  });
  it.each(['resend', 'inngest', 'table', 'table-without-edges', 'jwt', 'posthog', 'backticks', 'bold', 'underscores'])('holds Markdown/prose secret shape: %s', async kind => {
    const value = ['A7z9B2q8', 'W1e6R4t0', 'Y3u5I9o2', 'P8x6D4f0'].join('');
    const secret = kind === 'resend' ? 'RESEND_API_KEY=`' + ['re', value.slice(0, 10), value].join('_') + '`' :
      kind === 'inngest' ? '- `INNGEST_SIGNING_KEY`: `' + ['signkey', 'prod', value].join('-') + '`' :
      kind === 'table' ? '| BETTER_AUTH_SECRET | ' + value + ' |' :
      kind === 'table-without-edges' ? 'BETTER_AUTH_SECRET | `' + value + '`' :
      kind === 'jwt' ? 'Saved credential: ' + ['ey' + 'J' + value, 'ey' + 'J' + value, value].join('.') :
      kind === 'posthog' ? 'Saved credential: ' + ['phx', value].join('_') :
      kind === 'bold' ? '- **CUSTOM_KEY**: `' + value + '`' :
      kind === 'underscores' ? '- __CUSTOM_KEY__: __' + value + '__' : '- `CUSTOM_KEY`: `' + value + '`';
    const decision = await classify(dirty(), { readFile: () => Buffer.from(secret) });
    expect(decision).toMatchObject({ disposition: 'hold', reason: 'secret-shape' });
    expect(JSON.stringify(decision)).not.toContain(value);
  });
  it('scans a 1 MB letter-only document in under 1 s and finds a secret on its last line', () => {
    // Bound the reproducer in a child: a synchronous quadratic regex cannot be
    // interrupted by Vitest's own timeout.
    const code = String.raw`import { scanSecrets } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/worktree-cleanup/admission.mjs')).href)};
      const bytes = Buffer.alloc(1024 * 1024, 65), start = performance.now();
      const plain = scanSecrets(bytes);
      const value = ['A7z9B2q8', 'W1e6R4t0', 'Y3u5I9o2', 'P8x6D4f0'].join('');
      const last = scanSecrets(Buffer.concat([bytes, Buffer.from('\nCUSTOM_KEY=' + value)]));
      console.log(JSON.stringify({ plain: plain.state, last: last.state, elapsed: performance.now() - start }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      encoding: 'utf8', windowsHide: true, timeout: 4000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const measured = JSON.parse(result.stdout);
    expect(measured).toMatchObject({ plain: 'negative', last: 'ok' });
    expect(measured.elapsed).toBeLessThan(1000);
  }, 6000);
  it.each(['<value>', '...'])('allows Markdown secret placeholders: %s', async value => {
    const text = ['RESEND_API_KEY=`' + value + '`', '- `INNGEST_SIGNING_KEY`: `' + value + '`', '| BETTER_AUTH_SECRET | ' + value + ' |'].join('\n');
    expect(await classify(dirty(), { readFile: () => Buffer.from(text) })).toMatchObject({ disposition: 'rescue' });
  });
  it.each(["<pw>", "<password>", "...", "%3Cpw%3E"])("allows URL password placeholder %s", async (password) => {
    expect(await classify(dirty(), { readFile: () => Buffer.from(`postgresql://neondb_owner:${password}@host/db`) })).toMatchObject({ disposition: "rescue" });
  });
  it.each(["user", "pass", "password", "username", "secret", "token", "PASS", "Password", "UserName", "SECRET", "Token"])("allows URL placeholder password word %s", (password) => {
    expect(scanSecrets(Buffer.from(`postgres://user:${password}@host/db`)).state).toBe("negative");
  });
  it.each(["Xk7mQ2pL9vR4tW8z", "N3bVc8XzQ1wErT5yU7iO"])("still flags a real-looking URL password %s", (password) => {
    expect(scanSecrets(Buffer.from(`postgres://user:${password}@host/db`))).toMatchObject({ state: "ok", value: { kind: "url-credentials" } });
    expect(scanSecrets(Buffer.from(`postgres://user:pass@host/db\npostgres://user:${password}@host/db`))).toMatchObject({ state: "ok", value: { kind: "url-credentials" } });
  });
  it.each(["passw0rd", "pass123", "tokens", "user1"])("does not widen the placeholder words to near-misses: %s", (password) => {
    expect(scanSecrets(Buffer.from(`postgres://user:${password}@host/db`))).toMatchObject({ state: "ok", value: { kind: "url-credentials" } });
  });
  it.each(["%50ASS", "%74oken"])("matches placeholder words after percent-decoding: %s", (password) => {
    expect(scanSecrets(Buffer.from(`postgres://user:${password}@host/db`)).state).toBe("negative");
  });
  it.each(["pa%zz", "Password%402024"])("flags a malformed or encoded non-word password: %s", (password) => {
    expect(scanSecrets(Buffer.from(`postgres://user:${password}@host/db`))).toMatchObject({ state: "ok", value: { kind: "url-credentials" } });
  });
  // Decision table for the placeholder-word exemption (#2405). It closes the
  // contract: review repros are kept verbatim. A word is excused only when the
  // text after the @ is exactly an example host (optional port) that ends the
  // authority; everything else keeps main's url-credentials veto.
  it.each([
    // Admitted: placeholder word at an example host.
    ["postgres://user:pass@localhost:5432/db", "negative"],
    ["Connect with postgres://user:pass@localhost:5432/db then email ops@example.com", "negative"],
    ["postgres://user:PASSWORD@127.0.0.1/db", "negative"],
    ["postgres://user:secret@[::1]:5432/db", "negative"],
    ["postgres://user:token@hostname", "negative"],
    ["postgres://user:pass@example:5432/db", "negative"],
    ["postgres://user:pass@server/db", "negative"],
    ["postgres://user:pass@db.example/app", "negative"],
    ["postgres://user:pass@db.invalid/app", "negative"],
    ["postgres://user:pass@db.test/app", "negative"],
    ["postgres://user:pass@app.localhost/x", "negative"],
    ["postgres://user:pass@example.com/app", "negative"],
    ["postgres://user:pass@api.example.org/app", "negative"],
    ["`postgres://user:pass@localhost`", "negative"],
    ['{"body":"see postgres://user:pass@localhost:5432/db"}', "negative"],
    // Admitted as on main: angle/ellipsis placeholders are not host-gated.
    ["postgres://app:%3Cpw%3E@host?contact=ops@example.com", "negative"],
    ["postgres://app:...@host#ops@example.com", "negative"],
    [String.raw`https://app:...@host\ops@example.com`, "negative"],
    ['{"url":"postgres://app:%3Cpw%3E@host","email":"ops@example.com"}', "negative"],
    // Vetoed: the password continues past the captured @ (review #1, verbatim repros).
    ["postgres://app:Password@2024@host/db", "url-credentials"],
    ["mysql://root:secret@123@host/db", "url-credentials"],
    ["mysql://root:secret@123@10.0.0.5/db", "url-credentials"],
    ["postgres://admin:secret@Xk7mQ2pL9vR4tW8z@host/app", "url-credentials"],
    // Vetoed: whitespace or an escape after the @ (Astra delta findings 1 and 2).
    ["postgres://app:Password@ 2024@host/db", "url-credentials"],
    ["postgres://app:Password@\t2024@host/db", "url-credentials"],
    ["postgres://app:Password@\n2024@host/db", "url-credentials"],
    [String.raw`{"url":"postgres://app:Password@2024@host/db"}`, "url-credentials"],
    ["postgres://app:pass@host?x@y", "negative"],
    // Vetoed: placeholder word at a real-looking host (GLM; coordinator list).
    ["postgres://deploy:secret@10.0.4.12:5432/app", "url-credentials"],
    ["postgres://user:pass@db.internal/app", "url-credentials"],
    ["redis://default:token@redis-prod.internal:6379", "url-credentials"],
    ["postgres://app:secret@db:5432", "url-credentials"],
    ["redis://default:token@redis", "url-credentials"],
    ["postgres://user:pass@notexample.com/app", "url-credentials"],
    ["postgres://user:pass@evil-example.com/app", "url-credentials"],
    ["postgres://user:pass@localhost.attacker.com/app", "url-credentials"],
    // Vetoed: a parser continues the authority past the host (Sol review, verbatim repros).
    ["https://app:pass@localhost;A7z9B2q8W1e6R4t0@prod.internal/db", "url-credentials"],
    ["https://app:pass@localhost\t.ABC.internal/db", "url-credentials"],
    ["https://app:pass@localhost,x@prod.internal/db", "url-credentials"],
    ["postgres://user:pass@localhost\n.prod.internal/db", "url-credentials"],
    ["postgres://user:pass@localhost then ops@prod.internal", "url-credentials"],
    // Admitted: JSON-escaped line ends and quotes after an example host.
    [String.raw`{"body":"use postgres://user:pass@localhost\nthen run it"}`, "negative"],
    [String.raw`{"body":"\"postgres://user:pass@localhost\" is the default"}`, "negative"],
  ])("url-credentials decision table: %s -> %s", async (text, expected) => {
    const result = scanSecrets(Buffer.from(text));
    if (expected === "negative") expect(result.state).toBe("negative");
    else expect(result).toMatchObject({ state: "ok", value: { kind: expected } });
    expect(await classify(dirty(), { readFile: () => Buffer.from(text) })).toMatchObject(expected === "negative" ? { disposition: "rescue" } : { disposition: "hold", reason: "secret-shape" });
  });
  it("names the example-host list as a closed constant without db", () => {
    expect(Object.isFrozen(EXAMPLE_URL_HOSTS.names)).toBe(true);
    expect(EXAMPLE_URL_HOSTS.names).not.toContain("db");
  });
  it("does not flag ordinary prose or low-entropy assignments", () => {
    expect(scanSecrets(Buffer.from('The key is a useful concept.\npassword = "aaaaaaaaaaaaaaaaaaaaaaaaaaaa"')).state).toBe("negative");
  });
  // #2409: the two entropy rules skip values holding whitespace or a parenthesis
  // (quoted code, Markdown prose cells). Each value below is built at runtime
  // so the source file carries no secret-shaped literal.
  const base64 = (seed: string, length: number) => createHash("sha256").update(seed).digest("base64").slice(0, length);
  const kindOf = (text: string) => { const result = scanSecrets(Buffer.from(text)); return result.state === "ok" ? result.value.kind : result.state; };
  it.each([
    ["const hasTokenInText = text.some((token) => x);"],
    ["const hasTokenInText = issueBodies.some((token) => token.length);"],
    ["const hasTokenInText = text.body.some((token) => token.trim());"],
  ])("does not flag quoted code as a high-entropy assignment: %s", (text) => {
    expect(kindOf(text)).toBe("negative");
  });
  it("does not flag a Markdown table prose cell beside a key-named cell, including JSON-escaped table lines", () => {
    const row = "| token | Rotate the deploy token through the vault before Friday (see the ops runbook) |";
    expect(kindOf(row)).toBe("negative");
    expect(kindOf(JSON.stringify({ body: ["| Field | Meaning |", "| --- | --- |", row, "| signing key | Held by the release owner; never pasted into an issue |"].join("\n") }))).toBe("negative");
  });
  // Segment shapes observed in prose cells of the primary checkout's intake
  // files: camelCase identifiers, kebab-case slugs, paths and URLs.
  it.each([
    ["camelCase", "| secret | the readCommissioningArtifactState helper (see review) |"],
    ["kebab-case", "| secret | the worktree-cleanup-high-entropy-false-positive audit (filed) |"],
    ["path", "| key | see /scripts/lib/worktree-cleanup/2026-10-15-audit2409/ for details |"],
    ["URL", "| key | tracked at https://github.com/example-org/example-repo/issues/2409 today |"],
  ])("does not flag a %s word inside a prose cell", (_name, row) => {
    expect(kindOf(row)).toBe("negative");
  });
  it.each([
    ["API_SECRET", () => "API_SECRET=" + base64("api-secret", 40), "high-entropy-assignment"],
    ["session_key", () => "session_key: " + createHash("sha256").update("session-key").digest("hex"), "high-entropy-assignment"],
    ["client_secret JSON", () => JSON.stringify({ client_secret: base64("client-secret", 32) }), "high-entropy-assignment"],
    ["signing_key table", () => "| signing_key | " + base64("signing-key", 40) + " |", "high-entropy-table"],
  ])("still flags a real-token shape: %s", (_name, text, kind) => {
    expect(kindOf(text())).toBe(kind);
  });
  // Decision table for the #2409 exemption (review round 1: correctness,
  // security, Codex and GLM repros kept verbatim in shape). A value holding
  // whitespace, or starting as a member call (xs.some(...), is judged by its
  // whitespace- and paren-free segments: a segment fires only when it is in the
  // token alphabet and is hex or mixes lower case, upper case and digits.
  // Every other value keeps main's whole-value check, parentheses included.
  const token = base64("decision-table", 40), hex = createHash("sha256").update("decision-table").digest("hex");
  const parenPassword = base64("pw-a", 18) + "(" + base64("pw-b", 12) + ")" + base64("pw-c", 12);
  // Hand-made shapes: base64 letters without a digit, lowercase base36, and
  // generated passwords with symbols.
  const letters = "QxRtYbKmWzPdLsVnHcJgFaEuTiZoXqBwNyMrDkGh", base36 = "k7m3x9q2v8t5w1z4n6b0y3rd";
  const symbolPassword = "Xk7!mV2#pQ7xLz4&wS8ntB3c", atPassword = "Xk7mV2pQ@7xLz4wS8ntB3cRe";
  it.each([
    // Fires: a credential containing or beside a parenthesis, outside a member call.
    ["(API_SECRET=<token>) in prose", "Run it as (API_SECRET=" + token + ") once.", "high-entropy-assignment"],
    ["$(SERVICE_TOKEN=<token>)", "$(SERVICE_TOKEN=" + token + ")", "high-entropy-assignment"],
    ["DB_PASSWORD with parentheses", "DB_PASSWORD=" + parenPassword, "high-entropy-assignment"],
    ["JSON db_password with parentheses", JSON.stringify({ db_password: parenPassword }), "high-entropy-assignment"],
    ["YAML smtp_password with parentheses", "smtp_password: " + parenPassword, "high-entropy-assignment"],
    ["token with an inserted (", "SERVICE_TOKEN=" + token.slice(0, 10) + "(" + token.slice(10), "high-entropy-assignment"],
    ["token argument of a member call", "const api_key = client.connect(" + token + ");", "high-entropy-assignment"],
    // Fires: a credential beside a note in a key-named table cell.
    ["table token (prod)", "| signing_key | " + token + " (prod) |", "high-entropy-table"],
    ["table token - note", "| signing_key | " + token + " - rotated weekly |", "high-entropy-table"],
    ["table backticked token + note", "| API token | `" + token + "` rotated weekly |", "high-entropy-table"],
    ["table prose before token", "| api_key | use " + token + " until Friday |", "high-entropy-table"],
    ["table token ending a sentence", "| api_key | The key is " + token + ". |", "high-entropy-table"],
    ["table hex token + note", "| session_token | " + hex + " (expires Friday) |", "high-entropy-table"],
    ["table token with an inserted space", "| signing_key | " + token.slice(0, 10) + " " + token.slice(10) + " |", "high-entropy-table"],
    ["JSON-escaped table token + note", JSON.stringify({ body: ["| Name | Value |", "| --- | --- |", "| deploy_token | " + token + " (CI only) |"].join("\n") }), "high-entropy-table"],
    // Fires (round 2: Codex Astra delta, GLM): token shapes outside base64 classes beside a note.
    ["table digit-less base64 + note", "| signing_key | " + letters + " (prod) |", "high-entropy-table"],
    ["table base36 + note", "| api_token | " + base36 + " staging |", "high-entropy-table"],
    ["table symbol password + note", "| password | " + symbolPassword + " prod |", "high-entropy-table"],
    ["table @ password + note", "| password | " + atPassword + " prod |", "high-entropy-table"],
    ["table token glued to <prod>", "| key | " + token + "<prod> |", "high-entropy-table"],
    ["table [token] + note", "| key | [" + token + "] old |", "high-entropy-table"],
    // Fires (round 3: Codex Sol delta): word-built passwords with digits, JSON-escaped quotes and newlines.
    ["table camelCase password + digits + note", "| password | CorrectHorseBatteryStaple2024 (prod) |", "high-entropy-table"],
    ["JSON-escaped quoted token + note", JSON.stringify({ body: '| api_key | "' + token + '" (prod) |' }), "high-entropy-table"],
    ["JSON-escaped token between prose lines", JSON.stringify({ body: "| api_key | use\n" + token + "\nthen rotate |" }), "high-entropy-table"],
    // Fires (round 4: Codex Sol final review, GLM): wider punctuation, boundary
    // punctuation kept, and a JSON escape decoded in one left-to-right pass.
    ["table password with an inner colon + note", "| password | Xk7mV2pQ:7xLz4wS8ntB3cR (prod) |", "high-entropy-table"],
    ["table password with an inner ? + note", "| password | Xk7mV2pQ?7xLz4wS8ntB3cR (prod) |", "high-entropy-table"],
    ["table password with inner brackets + note", "| password | Xk7mV2pQ[7xLz4]wS8ntB3cR (prod) |", "high-entropy-table"],
    ["JSON-escaped password with an inner backslash + note", JSON.stringify({ body: "| password | Xk7mV2pQ\\7xLz4wS8ntB3cR (prod) |" }), "high-entropy-table"],
    ["table password wrapped in ! + note", "| password | !" + base64("core18", 18) + "! (prod) |", "high-entropy-table"],
    // Negative: prose punctuation around words.
    ["Windows path", "| key | stored under C:\\Users\\someone\\AppData\\Local\\WorkflowTools for now |", "negative"],
    ["URL with a query", "| key | see https://github.com/example-org/example-repo/issues?q=is:open+label:roadmap2026 today |", "negative"],
    ["array index", "| key | read config.items[index].secretValue from the store |", "negative"],
    ["question-marked identifiers", "| token | WhyDoesTheRotationFail? and isTokenExpired? (both) |", "negative"],
    ["bold Markdown words", "| Secret | **Rotation-schedule** applies (quarterly) |", "negative"],
    ["JSON-escaped newline between words", JSON.stringify({ body: "| key | see roadmap2026\nOverviewDocument today |" }), "negative"],
    ["non-ASCII prose words", "| key | the naïveté-of-the-implementation détail (seriously) |", "negative"],
    ["numbered words joined by !", "| key | tracked as roadmap2409!followupwork today |", "negative"],
    ["low-entropy repeat", "| key | ab12ab12ab12ab12ab12ab12 (example) |", "negative"],
    // Fires: upper-case base32 secrets (TOTP shape) beside a note, including
    // one with a single inner digit run.
    ["table base32 secret + note", "| totp_secret | JBSWY3DPEHPK3PXPJBSWY3DQ (prod) |", "high-entropy-table"],
    ["table base32 secret with one digit run + note", "| totp_secret | QMZRTWKPVNBHGXJDLCFS7YWAEK (prod) |", "high-entropy-table"],
    // Fires (final cross-family review, GLM-5.3 exact repros): a word or number
    // of 20 or more characters is not word-shaped, so single-case random tokens
    // without digits are caught, as are run-together single-case passphrases.
    ["GLM F1: upper-case letters-only token + note", "| signing_key | QXZWVRPLKNMHTDBFAOSCE (prod) |", "high-entropy-table"],
    ["GLM F1: lower-case letters-only token + note", "| api_key | zmqvxpklwnrtdhbfaosce (prod) |", "high-entropy-table"],
    ["run-together single-case words + digits + note", "| password | correcthorsebatterystaple2024 (prod) |", "high-entropy-table"],
    ["webhook URL with an upper-case random tail + note", "| api_key | https://hooks.slack.com/services/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 (prod) |", "high-entropy-table"],
    // Negative (GLM F2 exact repro): the documented placeholder webhook. Its
    // zeros and X runs put the URL segment at 3.40 bits, under the 3.5 floor.
    ["GLM F2: placeholder webhook URL + note", "| api_key | https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX (prod) |", "negative"],
    // Recorded residuals (heuristic limits): word-built passwords without a
    // mixed-case-and-digit part are read as prose when a note sits beside them.
    ["residual: single-case words + digits + note", "| password | correct-horse-battery-staple2024 (prod) |", "negative"],
    ["residual: passphrase without digits + note", "| password | CorrectHorseBatteryStaple (prod) |", "negative"],
    ["residual: symbol-joined passphrase + note", "| password | Correct!Horse#Battery$Staple (prod) |", "negative"],
    // Recorded residual (coordinator probe at 6d48c74cf): a member call with an
    // unquoted word-shaped argument is read as code; main fired on it.
    ["residual: member call with an unquoted passphrase argument", "key=config.get(correct-horse-battery-staple)", "negative"],
    // Hex and UUID values in prose cells are judged alone, so they match
    // plain-cell detection: surrounding prose no longer lifts a value under the
    // 3.5-bit floor (main fired on the 3.47-bit hex 32 below only in prose).
    ["hex 32 in a plain cell", "| signing_key | 4d3be910deaa35d9e4a3cb7ef32fad4e |", "high-entropy-table"],
    ["hex 32 in a prose cell", "| signing_key | rotated 4d3be910deaa35d9e4a3cb7ef32fad4e last week (prod) |", "high-entropy-table"],
    ["UUID in a prose cell", "| signing_key | rotated 3d780c35-3a56-4ffd-a1e7-3b5035d84502 last week (prod) |", "high-entropy-table"],
    ["hex 40 in a prose cell", "| signing_key | rotated efde4107414159b9bff8db8b99b26a2d7fb6da1c last week (prod) |", "high-entropy-table"],
    ["residual: 3.47-bit hex 32 in a plain cell", "| signing_key | 1fec5e691aece97ae240419a2ef39f7f |", "negative"],
    ["residual: 3.47-bit hex 32 in a prose cell", "| signing_key | rotated 1fec5e691aece97ae240419a2ef39f7f last week (prod) |", "negative"],
    // Accepted false positive (fails closed): a two-letter camelCase word
    // without a vowel reads as random, so digit-less random tokens are caught.
    ["identifier with a consonant two-letter word", "| token | the readFsEntryMetadataHelper function (legacy) |", "high-entropy-table"],
    // Negative: a value split into segments shorter than 20 characters.
    ["table token split into short segments", "| signing_key | " + token.slice(0, 15) + " " + token.slice(15, 30) + " " + token.slice(30) + " |", "negative"],
    // Negative: word-shaped segments in prose cells.
    ["camelCase with two-letter words", "| token | userIdToSessionMapping and getXmlHttpRequestFactory here |", "negative"],
    ["PascalCase and acronyms", "| token | ReadCommissioningArtifactState and HTTPServerConfiguration (both) |", "negative"],
    ["snake and SCREAMING_SNAKE", "| key | remove_worktree_after_snapshot_commit and BETTER_AUTH_SECRET_KEY_VALUE |", "negative"],
    ["email", "| key | ask first.lastname@company-domain-name.com about it |", "negative"],
    ["dotted module path", "| key | scripts.lib.worktreeCleanup.admissionScanner.mjs is the file |", "negative"],
  ].map(([name, text, expected]) => ({ name, text, expected })))("#2409 decision table: $name -> $expected", ({ text, expected }) => {
    expect(kindOf(text)).toBe(expected);
  });
  it("scans long capital and punctuation runs in prose cells in linear time", () => {
    // A child bounds the reproducer: a backtracking regex cannot be interrupted
    // by Vitest's own timeout (round 3: 25 capitals > 2 s; round 4: 128,000
    // periods inside a word took 10 s with an anchored regex trim).
    const code = String.raw`import { scanSecrets } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/worktree-cleanup/admission.mjs')).href)};
      const start = performance.now();
      for (const n of [26, 40, 5000]) scanSecrets(Buffer.from('| key | note ' + 'B'.repeat(n) + 'cx7Q tail |'));
      for (const mark of ['.', ',']) scanSecrets(Buffer.from('| key | note a' + mark.repeat(128000) + 'b tail |'));
      console.log(JSON.stringify({ elapsed: performance.now() - start }));`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).elapsed).toBeLessThan(500);
  }, 6000);
  // Seeded sample of random credentials beside a note. Measured miss rates are
  // under 1.1% for these generators (letters-only tokens, a residual, miss
  // more), so a bound of 3% catches a rule that stops seeing a token family.
  const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  it.each([
    ["base64 40", alnum + "+/", 40], ["base64 20", alnum + "+/", 20], ["base64url 32", alnum + "-_", 32],
    ["base36 24", "abcdefghijklmnopqrstuvwxyz0123456789", 24], ["alphanumeric 20", alnum, 20], ["symbol password 24", alnum + "!#$%^&*~@", 24],
    // Single-case letters (final review, GLM F1). At 24 characters about 3.4%
    // miss, every one under the 3.5-bit entropy floor (a residual, like hex 40).
    ["upper-case letters 32", alnum.slice(0, 26), 32], ["lower-case letters 32", alnum.slice(26, 52), 32],
  ] as const)("fires on at least 97 percent of seeded %s tokens beside a note", (name, pool, length) => {
    let missed = 0;
    for (let sample = 0; sample < 500; sample++) {
      const bytes = createHash("sha512").update(`${name}:${sample}`).digest();
      const value = Array.from({ length }, (_unused, index) => pool[bytes[index] % pool.length]).join("");
      if (kindOf("| signing_key | " + value + " (prod) |") === "negative") missed++;
    }
    expect(missed).toBeLessThanOrEqual(15);
  });
  it.each([Buffer.from([0xef, 0xbb, 0xbf, 0x61]), Buffer.from([0xc3, 0x83, 0xc2, 0xa2, 0xc3, 0xa2, 0xe2, 0x82, 0xac])])("holds encoding corruption", async (bytes) => {
    expect(await classify(dirty(), { readFile: () => bytes })).toMatchObject({ disposition: "hold", reason: "encoding" });
  });
  it("rejects the first over-budget full rescued path but admits the last in-budget one", async () => {
    const prefix = `docs/rescued/topic-${HEAD.slice(0, 7)}/`;
    const length = 239 - 38 - 1 - prefix.length;
    expect(await classify(dirty(`?? ${"a".repeat(length - 3)}.md\0`))).toMatchObject({ disposition: "rescue" });
    expect(await classify(dirty(`?? ${"a".repeat(length - 2)}.md\0`))).toMatchObject({ disposition: "hold", reason: "path-budget" });
  });
  it("reads actual files once and preserves CRLF, spaces and non-ASCII names", () => {
    const t = fixture();
    const name = "-notes \u00e9.md";
    writeFileSync(join(t.path, name), Buffer.from("# Caf\u00e9\r\n"));
    t.status = ok({ clean: false, entries: parseStatus(`?? notes.md\0?? ${name}\0`) });
    const result = admitRescue(t);
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(result.value.files.map((file) => file.bytes)).toEqual([readFileSync(join(t.path, "notes.md")), readFileSync(join(t.path, name))]);
  });
  it("fails closed on missing files, directories masquerading as markdown and unsafe paths", () => {
    const t = fixture();
    rmSync(join(t.path, "notes.md")); expect(admitRescue(t).state).toBe("unknown");
    mkdirSync(join(t.path, "notes.md")); expect(admitRescue(t).state).toBe("unknown");
    t.status = ok({ clean: false, entries: [{ index: "?", worktree: "?", path: "../outside.md" }] });
    expect(admitRescue(t).state).toBe("unknown");
  });
  it.each([Buffer.from([0xc3, 0x28]), Buffer.from([0, 65]), Buffer.alloc(5_000_001)])("holds bytes that cannot be fully scanned", async (bytes) => {
    expect(await classify(dirty(), { readFile: () => bytes })).toMatchObject({ disposition: "hold", reason: "unknown" });
  });
  it("does not inherit the linter source allowlist for rescued copies", async () => {
    const status = "?? docs/solutions/workflow-issues/codex-mcp-file-rewrite-encoding-corruption-2026-06-22.md\0";
    expect(await classify(dirty(status), { readFile: () => Buffer.from([0xef, 0xbb, 0xbf]) })).toMatchObject({ disposition: "hold", reason: "encoding" });
  });
  it("never returns partial admission after a later file fails", () => {
    const readFile = vi.fn((_root: string, path: string) => Buffer.from(path === "two.md" ? "ghp_secret" : "safe"));
    const admitted = admitRescue(dirty("?? one.md\0?? two.md\0"), { readFile });
    expect(admitted).toMatchObject({ state: "negative", reason: "secret-shape" });
    expect(admitted).not.toHaveProperty("value.files");
  });
  it("binds publication bytes even when the source later changes", () => {
    const t = fixture(), admitted = admitRescue(t);
    expect(admitted.state).toBe("ok");
    writeFileSync(join(t.path, "notes.md"), "ghp_later_secret");
    if (admitted.state === "ok") expect(admitted.value.files[0].bytes.toString()).toBe("# Notes\r\n");
  });
});

describe('scratch snapshot decision table', () => {
  const draft = 'artifacts/github-issue-roadmap/_drafts/finding.json';
  type Row = { name: string; status?: string; ignored?: string[]; mergedHead?: string; mergedBase?: string; ancestor?: boolean; ancestorUnknown?: boolean;
    idle?: boolean; open?: boolean; disposition: string; reasonCode: string; veto?: string; nameHits?: string[] };
  const rows: Row[] = [
    { name: 'exact merged-main HEAD', status: `?? ${draft}\0`, mergedHead: HEAD, disposition: 'snapshot', reasonCode: 'snapshot' },
    { name: 'different merged PR HEAD without idle evidence', status: `?? ${draft}\0`, mergedHead: OTHER, disposition: 'hold', reasonCode: 'leftovers', veto: 'snapshot-unmerged' },
    { name: 'different merged PR HEAD with idle evidence', status: `?? ${draft}\0`, mergedHead: OTHER, idle: true, disposition: 'archive', reasonCode: 'leftovers', veto: 'snapshot-unmerged' },
    { name: 'main ancestry without a merged PR', status: `?? ${draft}\0`, ancestor: true, disposition: 'snapshot', reasonCode: 'snapshot' },
    { name: 'merged PR into another base is not proof', status: `?? ${draft}\0`, mergedHead: HEAD, mergedBase: 'release', disposition: 'hold', reasonCode: 'leftovers', veto: 'snapshot-unmerged' },
    { name: 'unavailable ancestry uses the leftovers fallback', status: `?? ${draft}\0`, ancestorUnknown: true, idle: true, disposition: 'archive', reasonCode: 'leftovers', veto: 'snapshot-unmerged' },
    { name: 'scratch mixed with source dirt', status: `?? ${draft}\0?? src/x.ts\0`, mergedHead: HEAD, disposition: 'hold', reasonCode: 'leftovers' },
    { name: 'staged scratch file', status: `A  ${draft}\0`, mergedHead: HEAD, disposition: 'hold', reasonCode: 'staged' },
    { name: 'deleted tracked scratch file', status: ` D ${draft}\0`, mergedHead: HEAD, disposition: 'hold', reasonCode: 'leftovers' },
    { name: 'renamed scratch file', status: `R  ${draft}\0.tmp-intake/old.json\0`, mergedHead: HEAD, disposition: 'hold', reasonCode: 'staged' },
    { name: 'unmerged scratch file', status: `UU ${draft}\0`, mergedHead: HEAD, disposition: 'hold', reasonCode: 'staged' },
    { name: 'scratch markdown precedes rescue', status: '?? .tmp-intake/notes.md\0', mergedHead: HEAD, disposition: 'snapshot', reasonCode: 'snapshot' },
    { name: 'unstaged modified tracked scratch file', status: ` M ${draft}\0`, mergedHead: HEAD, disposition: 'snapshot', reasonCode: 'snapshot' },
    { name: 'open PR still holds scratch', status: `?? ${draft}\0`, open: true, disposition: 'hold', reasonCode: 'open-pr' },
    { name: 'ignored scratch directory and disposable node_modules', ignored: ['.reproduce-out/', 'node_modules/'], mergedHead: HEAD, disposition: 'snapshot', reasonCode: 'snapshot' },
    { name: 'nested look-alike path', status: '?? docs/artifacts/github-issue-roadmap/x.json\0', mergedHead: HEAD, disposition: 'hold', reasonCode: 'leftovers' },
    { name: 'prefix look-alike path', status: '?? .reproduce-out-old/x\0', mergedHead: HEAD, disposition: 'hold', reasonCode: 'leftovers' },
    { name: 'case variant', status: '?? Artifacts/GitHub-Issue-Roadmap/X.json\0', mergedHead: HEAD, disposition: 'snapshot', reasonCode: 'snapshot' },
    { name: 'root env is ordinary leftovers', status: '?? .env.local\0', mergedHead: HEAD, disposition: 'hold', reasonCode: 'leftovers' },
    { name: 'untracked scratch env', status: '?? .tmp-intake/.env.local\0', mergedHead: HEAD, disposition: 'hold', reasonCode: 'leftovers', veto: 'secret_material', nameHits: ['.tmp-intake/.env.local'] },
    { name: 'ignored scratch env backup', ignored: ['.reproduce-out/.env.local.op-template.backup'], mergedHead: HEAD, idle: true, disposition: 'archive', reasonCode: 'leftovers', veto: 'secret_material', nameHits: ['.reproduce-out/.env.local.op-template.backup'] },
    { name: 'untracked scratch pem', status: '?? artifacts/github-issue-roadmap/deploy.pem\0', mergedHead: HEAD, disposition: 'hold', reasonCode: 'leftovers', veto: 'secret_material', nameHits: ['artifacts/github-issue-roadmap/deploy.pem'] },
    { name: 'modified tracked env skips name gate', status: ' M .tmp-intake/.env.local.example\0', mergedHead: HEAD, disposition: 'snapshot', reasonCode: 'snapshot' },
  ];
  it.each(rows)('$name', async row => {
    const t = row.status ? dirty(row.status) : tree();
    if (row.ignored) t.ignored = ok({ entries: row.ignored, unexpected: row.ignored.filter(path => path !== 'node_modules/') });
    const options = { prSnapshot: ok(row.open ? [pr({ state: 'OPEN' })] : row.mergedHead ? [pr({ headRefOid: row.mergedHead, baseRefName: row.mergedBase ?? 'main' })] : []),
      ancestorOfMain: vi.fn(() => row.ancestorUnknown ? unknown('ancestry unavailable') : row.ancestor ? ok(true) : negative()),
      idleEvidence: vi.fn(() => row.idle ? ok(true) : unknown('missing days')), readFile: vi.fn(() => Buffer.from('# Notes\n')) };
    const decision = await classify(t, options);
    expect(decision).toMatchObject({ disposition: row.disposition, reasonCode: row.reasonCode });
    if (row.veto) expect(decision).toMatchObject({ snapshotVeto: row.veto });
    else expect(decision).not.toHaveProperty('snapshotVeto');
    if (row.nameHits) expect(decision.nameHits).toEqual(row.nameHits);
    if (row.disposition === 'snapshot') expect(options.idleEvidence).not.toHaveBeenCalled();
    expect(options.readFile).not.toHaveBeenCalled();
  });
  it('pins the closed scratch list and exported secret patterns', () => {
    expect(SCRATCH_PATHS).toEqual(['artifacts/github-issue-roadmap/', '.reproduce-out/', '.tmp-intake/']);
    expect(SECRET_NAME_PATTERNS.length).toBeGreaterThan(0);
  });
  it.each([
    { path: '.tmp-intake\\notes.json', state: 'unknown', disposition: 'hold' },
    { path: 'ARTIFACTS\\GITHUB-ISSUE-ROADMAP\\_drafts\\x.json', state: 'unknown', disposition: 'hold' },
    { path: 'ARTIFACTS/GITHUB-ISSUE-ROADMAP/_drafts/x.json', state: 'ok', disposition: 'snapshot' },
  ])('rejects backslashes and preserves case variants: $path', async ({ path, state, disposition }) => {
    const t = tree(); t.status = ok({ clean: false, entries: [{ index: '?', worktree: '?', path }] });
    expect(classifyScratch(t)).toMatchObject(state === 'ok' ? { state, value: { scratch: true, nameHits: [] } } : { state });
    expect(await classify(t, { prSnapshot: ok([pr()]) })).toMatchObject({ disposition, reasonCode: state === 'unknown' ? 'unknown' : 'snapshot' });
  });
  it.each(['.env', '.env.local', 'deploy.pem', 'deploy.key', 'deploy.p12', 'deploy.pfx', 'id_rsa', 'id_rsa.pub', 'id_ed25519', 'id_ed25519.pub'])('checks the secret basename %s and backup suffixes', name => {
    for (const suffix of ['', '.backup', '.bak', '.orig']) {
      const path = `.tmp-intake/${name}${suffix}`;
      expect(classifyScratch(dirty(`?? ${path}\0`))).toMatchObject({ state: 'ok', value: { scratch: true, nameHits: [path] } });
    }
  });
  it.each(['deployment.pem.txt', 'my.env', 'assert-signing-secret.ts', 'credential-clean-git.ts'])('keeps the name gate narrow: %s', name => {
    expect(classifyScratch(dirty(`?? .tmp-intake/${name}\0`))).toMatchObject({ state: 'ok', value: { scratch: true, nameHits: [] } });
  });
  it('excludes tracked unmodified templates and secret-named source helpers', async () => {
    // These tracked unmodified files are absent from status: .env.local.example,
    // src/lib/agent/chip-dispatch/assert-signing-secret.ts,
    // scripts/lib/github-issue-roadmap/credential-clean-git.ts.
    const t = tree();
    expect(classifyScratch(t)).toMatchObject({ state: 'ok', value: { scratch: false, nameHits: [] } });
    expect(await classify(t, { prSnapshot: ok([pr()]) })).toMatchObject({ disposition: 'remove' });
  });
  it('holds unknown status evidence without a snapshot', async () => {
    const t = dirty(`?? ${draft}\0`); Object.assign(t, { status: unknown('probe failed') });
    expect(classifyScratch(t)).toMatchObject({ state: 'unknown' });
    expect(await classify(t, { prSnapshot: ok([pr()]) })).toMatchObject({ disposition: 'hold', reasonCode: 'unknown' });
  });
  it.each(['../.tmp-intake/x', '.tmp-intake/../x', '/.tmp-intake/x', 'C:\\tmp-intake\\x'])('holds unsafe scratch paths: %s', async path => {
    const t = tree(); t.status = ok({ clean: false, entries: [{ index: '?', worktree: '?', path }] });
    expect(classifyScratch(t)).toMatchObject({ state: 'unknown' });
    expect(await classify(t, { prSnapshot: ok([pr()]) })).toMatchObject({ disposition: 'hold', reasonCode: 'unknown' });
  });
  it.each(['leftovers', 'staged', 'secret-shape'])('characterizes snapshotFallback for %s and idle evidence', async reason => {
    const t = dirty('?? code.ts\0'), admitted = { ...negative(), reason };
    for (const idle of [ok(true), negative(), unknown('missing days')]) {
      const idleEvidence = vi.fn(() => idle);
      expect(await snapshotFallback(t, admitted, { idleEvidence })).toEqual({ path: t.path, head: HEAD, branch: 'refs/heads/topic',
        disposition: idle.state === 'ok' ? 'archive' : 'hold', reason, reasonCode: reason, idleEvidence: idle });
      expect(idleEvidence).toHaveBeenCalledWith(t.path);
    }
  });
  it.each(['selfLink', 'danglingJunction'])('preserves snapshotFallback link holds for %s', async flag => {
    const t = dirty('?? code.ts\0');
    if (t.links.state !== 'ok') throw new Error('Links unavailable');
    Object.assign(t.links.value, { entries: [{ [flag]: true }] });
    expect(await snapshotFallback(t, { ...negative(), reason: 'leftovers' }, { idleEvidence: () => ok(true) }))
      .toEqual({ path: t.path, head: HEAD, branch: 'refs/heads/topic', disposition: 'hold', reason: 'links', reasonCode: 'links', evidence: t.links });
  });
});

describe("archive seam and run evidence", () => {
  it("never archives without the U7 journal, regardless of file age", async () => {
    expect(await classify(dirty("?? code.ts\0"))).toMatchObject({ disposition: "hold", reason: "leftovers", idleEvidence: { state: "unknown" } });
  });
  it("archives definite leftover rejections only with affirmative 14-day idle evidence", async () => {
    const idleEvidence = vi.fn(() => ok(true));
    expect(await classify(dirty("MM notes.md\0"), { idleEvidence })).toMatchObject({ disposition: "archive", reason: "staged" });
    expect(idleEvidence).toHaveBeenCalledWith(tree().path);
    for (const evidence of [negative(), unknown("missing days")]) expect(await classify(dirty(), { readFile: () => Buffer.from("ghp_secret"), idleEvidence: () => evidence })).toMatchObject({ disposition: "hold", reason: "secret-shape" });
  });
  it.each(["selfLink", "danglingJunction"] as const)("holds an otherwise archivable dirty idle tree with an admitted %s", async flag => {
    const t = dirty("MM notes.md\0"), options = { idleEvidence: () => ok(true) };
    expect(await classify(t, options)).toMatchObject({ disposition: "archive" });
    if (t.links.state !== "ok") throw new Error("Links unavailable");
    Object.assign(t.links.value, { entries: [{ relativePath: flag === "selfLink" ? ".next/node_modules/pkg-hash" : "node_modules", [flag]: true }] });
    expect(t.links.value.forbidden).toEqual([]);
    expect(await classify(t, options)).toMatchObject({ disposition: "hold", reasonCode: "links", evidence: t.links });
  });
  it("does not turn earlier safety holds into archive", async () => {
    const t = dirty("?? code.ts\0"); t.identity = unknown("missing");
    const idleEvidence = vi.fn(() => ok(true));
    expect(await classify(t, { idleEvidence })).toMatchObject({ reason: "identity" });
    expect(idleEvidence).not.toHaveBeenCalled();
  });
  it("takes one snapshot for a run and calls a supplied fetch before PR/ancestry evidence", async () => {
    const order: string[] = [];
    const runGh = vi.fn(() => { order.push("snapshot"); return ok("[]"); });
    const fetchMain = vi.fn(() => { order.push("fetch"); return ok(null); });
    const result = await planWorktrees({ primaryPath: resolve(tmpdir()), worktrees: [tree(), tree("other")] }, {
      ghPath: process.execPath, runGh, fetchMain, ancestorOfMain: () => { order.push("ancestry"); return ok(true); },
    });
    expect(result).toMatchObject({ state: "ok", value: { worktrees: [{ disposition: "remove" }, { disposition: "remove" }] } });
    expect(runGh).toHaveBeenCalledOnce(); expect(fetchMain).toHaveBeenCalledOnce();
    expect(order).toEqual(["fetch", "snapshot", "ancestry", "ancestry"]);
  });
  it("holds after a failed requested fetch, while preserving earlier exemption holds", async () => {
    const t = tree(); t.exemption = ok({ reasons: ["primary"] }) as typeof t.exemption;
    expect(await classify(tree(), { fetchMain: () => unknown("offline") })).toMatchObject({ reason: "unknown" });
    expect(await classify(t, { fetchMain: () => unknown("offline") })).toMatchObject({ reason: "exempt" });
  });
});

describe("plan CLI integration without real GitHub or fetch", () => {
  it('keeps default reports under OS temp and disables real notifications', () => {
    expect(resolve(defaultReportRoot()).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(process.env.WORKTREE_CLEANUP_NO_TOAST).toBe('1');
  });
  function dependencies(t = tree()) {
    const primaryPath = resolve(tmpdir(), "primary");
    const inventoryStub = vi.fn<typeof inventory>(() => ok({ primaryPath, runnerPath: primaryPath, commonDirectory: ok(join(primaryPath, ".git")), worktrees: [t], incompleteScans: [], registrationKeys: [], knownStaleRegistrations: [] }));
    const activityStub = vi.fn<typeof collectActivity>(async () => [{ lease: negative(), transcript: negative(), fileActivity: negative(), head: ok(HEAD), live: negative(), liveReasons: [] }]);
    const planStub = vi.fn<typeof planWorktrees>((input, options) => planWorktrees(input, { ...options, ...defaults() }));
    const runProbe = vi.fn((_executable: string, _args: string[], _options?: object) => unknown("stubbed fetch failure"));
    return { inventory: inventoryStub, collectActivity: activityStub, planWorktrees: planStub, runProbe };
  }
  it("prints one disposition per tree and counts, defaults to no fetch, and leaves input args intact", async () => {
    const deps = dependencies(), output = vi.spyOn(console, "log").mockImplementation(() => {});
    const args = ["plan", "--repo", resolve(tmpdir(), "primary")];
    expect(await main(args, deps)).toBe(0);
    expect(args[0]).toBe("plan");
    expect(deps.runProbe).not.toHaveBeenCalled();
    expect(deps.planWorktrees.mock.calls[0][1]?.fetchMain).toBeUndefined();
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report.value).toMatchObject({ counts: { "remove-keep-branch": 1 }, holdReasons: {}, worktrees: [{ path: tree().path, disposition: "remove-keep-branch" }] });
    expect(deps.inventory.mock.calls[0][0]?.runnerPath).toBe(resolve(tmpdir(), "primary"));
  });
  it("uses only a supplied fetch stub, in the primary repo, when --fetch is present", async () => {
    const deps = dependencies(); vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["plan", "--repo", tree().path, "--git", process.execPath, "--fetch"], deps)).toBe(0);
    expect(deps.runProbe).toHaveBeenCalledOnce();
    expect(deps.runProbe.mock.calls[0]).toEqual([process.execPath, ["-C", resolve(tmpdir(), "primary"), "fetch", "origin", "main"], expect.any(Object)]);
  });
  it("prints rescued paths and hashes without serializing captured contents", async () => {
    const deps = dependencies(dirty()), output = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["plan"], deps)).toBe(0);
    const report = JSON.parse(output.mock.calls[0][0]);
    expect(report.value.worktrees[0].files[0]).toMatchObject({ path: "notes.md", byteLength: 8 });
    expect(report.value.worktrees[0].files[0]).not.toHaveProperty("bytes");
    expect(output.mock.calls[0][0]).not.toContain("# Notes");
  });
  it("leaves inventory mode available and rejects unknown or incomplete options", async () => {
    const deps = dependencies(); vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["inventory"], deps)).toBe(0);
    expect(deps.planWorktrees).not.toHaveBeenCalled();
    for (const args of [["run"], ["plan", "--repo"], ["plan", "--timeout-ms", "0"], ["plan", "--fetch", "--fetch"], ["inventory", "--fetch"]]) expect(await main(args, deps)).toBe(1);
    expect(deps.runProbe).not.toHaveBeenCalled();
  });
});
