import './worktree-cleanup-test-env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { acquireRunLock, admitRunLock, coordinationDirectory, processIdentity } from '../lib/worktree-cleanup/report.mjs';
import { negative, ok, unknown } from '../lib/worktree-cleanup/probe.mjs';
import { runRelease } from '../lib/worktree-cleanup/release.mjs';

const roots: string[] = [], held: (() => Promise<unknown>)[] = [];
const identityProbe = () => ok('born');
function fixture() {
  const repository = mkdtempSync(join(tmpdir(), 'wt-admission-')); roots.push(repository);
  const directory = coordinationDirectory(repository); mkdirSync(directory, { recursive: true });
  const root = join(repository, 'reports');
  let clock = 100_000;
  const now = () => clock;
  const advance = (ms: number) => { clock += ms; };
  const options = { now, identityProbe };
  const tickets = () => readdirSync(directory).filter(name => name.endsWith('.ticket.json'));
  const lock = async (kind = 'owner-release') => {
    const unlock = await acquireRunLock(repository, root, kind, options); held.push(unlock); return unlock;
  };
  const admit = async (kind = 'owner-release', extra = {}) => {
    const unlock = await admitRunLock(repository, root, kind, { ...options, ...extra }); held.push(unlock); return unlock;
  };
  function ticket(name: string, extra = {}) {
    const path = join(directory, name + '.ticket.json'), temporary = path + '.tmp';
    writeFileSync(temporary, JSON.stringify({ ticketId: name, pid: 123, creationTime: 'born', enqueuedAtMs: clock - 1,
      tieBreaker: 1, kind: 'owner-release', target: repository, ...extra }));
    renameSync(temporary, path); return path;
  }
  return { repository, root, directory, now, advance, options, tickets, lock, admit, ticket };
}
function gate() {
  let resume!: () => void, arrived!: () => void;
  const waiting = new Promise<void>(accept => { arrived = accept; });
  const resumed = new Promise<void>(accept => { resume = accept; });
  return { waiting, resume, wait: vi.fn(async () => { arrived(); await resumed; }) };
}
afterEach(async () => {
  for (const unlock of held.splice(0)) await unlock().catch(() => {});
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('shared ordered admission', () => {
  it.each(['{torn', 'null', '{}', '{"enqueuedAtMs":1,"ticketId":"bad","pid":0}',
    '{"enqueuedAtMs":1,"ticketId":"bad","pid":123,"kind":"invalid"}'])('quarantines invalid published ticket %s and continues', async contents => {
    const f = fixture(), path = join(f.directory, 'invalid.ticket.json');
    writeFileSync(path, contents);
    await f.admit('owner-release', { wait: async () => f.advance(600_000) });
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(path + '.invalid', 'utf8')).toBe(contents);
    expect(f.tickets()).toEqual([]);
  });
  it.each([['owner-release', 20], ['nightly', 30]] as const)('expires a live %s ticket only past its %s minute cap', async (kind, minutes) => {
    const f = fixture(), old = f.ticket('suspended', { pid: process.pid, kind, enqueuedAtMs: f.now() - minutes * 60_000 });
    const wait = vi.fn(async () => { if (wait.mock.calls.length > 1) throw new Error('Expired ticket still blocks'); expect(existsSync(old)).toBe(true); f.advance(1); });
    await f.admit('owner-release', { wait });
    expect(wait).toHaveBeenCalledOnce(); expect(existsSync(old)).toBe(false);
  });
  it('a suspended waiter loses its expired slot and never republishes when resumed', async () => {
    const f = fixture(), holder = await f.lock(), waiting = gate();
    const victim = f.admit('owner-release', { wait: waiting.wait }).then(() => 'unexpected admission', error => error);
    await waiting.waiting; const path = join(f.directory, f.tickets()[0]);
    f.advance(20 * 60_000 + 1); await holder();
    try {
      await f.admit('owner-release', { wait: async () => { throw new Error('Expired slot still blocks'); } });
      expect(existsSync(path)).toBe(false);
    } finally { waiting.resume(); }
    expect(await victim).toMatchObject({ code: 'RUN_LOCK_OCCUPIED' }); expect(f.tickets()).toEqual([]);
  });
  it('memoizes creation-time probes across polls while checking liveness cheaply', async () => {
    const f = fixture(), old = f.ticket('first'), identities = vi.fn(identityProbe);
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid === 123 ? true : realKill(pid, signal));
    const wait = vi.fn(async () => { f.advance(1000); if (wait.mock.calls.length === 2) rmSync(old); });
    try {
      await f.admit('owner-release', { identityProbe: identities, wait });
      expect(wait).toHaveBeenCalledTimes(2);
      expect(identities).toHaveBeenCalledTimes(2); // One own identity and one queued process.
      expect(kill).toHaveBeenCalledWith(123, 0);
    } finally { kill.mockRestore(); }
  });
  it('retries a failed identity probe so a live waiter is not aged out', async () => {
    const f = fixture(), old = f.ticket('first', { enqueuedAtMs: f.now() - 16 * 60_000 + 1 });
    let queuedProbes = 0;
    const identities = vi.fn((pid: number) => pid === 123 && queuedProbes++ === 0 ? unknown('transient failure') : ok('born'));
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => pid === 123 ? true : realKill(pid, signal));
    const wait = vi.fn(async () => {
      expect(existsSync(old)).toBe(true);
      f.advance(2);
      if (wait.mock.calls.length === 2) rmSync(old);
    });
    try {
      await f.admit('owner-release', { identityProbe: identities, wait });
      expect(wait).toHaveBeenCalledTimes(2);
      expect(queuedProbes).toBe(2);
      expect(identities).toHaveBeenCalledTimes(3); // One own identity and two queued-process probes.
    } finally { kill.mockRestore(); }
  });
  it('probes again when a ticket records another creation time for the same pid', async () => {
    const f = fixture(), old = f.ticket('first', { pid: process.pid });
    const identities = vi.fn(identityProbe);
    const wait = vi.fn(async () => {
      writeFileSync(old, JSON.stringify({ ...JSON.parse(readFileSync(old, 'utf8')), creationTime: 'another-birth' }));
      f.advance(1000);
    });
    await f.admit('owner-release', { identityProbe: identities, wait });
    expect(wait).toHaveBeenCalledOnce(); expect(identities).toHaveBeenCalledTimes(2);
    expect(existsSync(old)).toBe(false);
  });
  it('drops a previously verified ticket when its cheap liveness check proves death', async () => {
    const f = fixture(), old = f.ticket('first'), identities = vi.fn(identityProbe);
    const realKill = process.kill.bind(process);
    const check = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 123) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
      return realKill(pid, signal);
    });
    const wait = vi.fn(async () => f.advance(1000));
    try {
      await f.admit('owner-release', { identityProbe: identities, wait });
      expect(wait).toHaveBeenCalledOnce(); expect(existsSync(old)).toBe(false);
      expect(identities.mock.calls).toHaveLength(2);
      expect(check).toHaveBeenCalledWith(123, 0);
    } finally { check.mockRestore(); }
  });
  it.each(['missing', 'malformed', 'invalid', 'stale'])('reports lock-held-unknown after bounded waiting with %s holder metadata', async kind => {
    const f = fixture(); await f.lock('nightly');
    const path = join(f.directory, 'owner.json');
    if (kind === 'missing') rmSync(path);
    else writeFileSync(path, kind === 'malformed' ? '{torn' : JSON.stringify(kind === 'invalid'
      ? { kind: 'nightly' } : { kind: 'nightly', pid: process.pid, creationTime: 'old' }));
    const wait = vi.fn(async () => f.advance(600_000)), scan = vi.fn();
    const result = await runRelease({ repositoryPath: f.repository, reportRoot: f.root, targetPath: join(f.repository, 'target'),
      ownerSession: 'owner', now: f.now }, { identityProbe, waitForLock: wait, inventory: scan });
    expect(result).toMatchObject({ exitCode: 3, reasonCode: 'lock-held-unknown' });
    expect(wait).toHaveBeenCalledOnce(); expect(scan).not.toHaveBeenCalled(); expect(f.tickets()).toEqual([]);
  });
  it('U4-T1 waits for the release holder and admits its successor', async () => {
    const f = fixture(), first = await f.lock(), waiting = gate();
    const second = f.admit('owner-release', { wait: waiting.wait });
    await waiting.waiting; expect(f.tickets()).toHaveLength(1);
    await first(); waiting.resume(); await second;
    expect(f.tickets()).toEqual([]);
  });
  it('U4-T2 admits B before A2 and A3, even when A polls first', async () => {
    const f = fixture(), a1 = await f.lock(), bGate = gate(), aGate = gate(), attempts: string[] = [];
    const b = f.admit('owner-release', { wait: bGate.wait, target: 'B' });
    await bGate.waiting; f.advance(1); await a1();
    const a2 = f.admit('owner-release', { wait: aGate.wait, target: 'A2',
      takeLock: async (...args: Parameters<typeof acquireRunLock>) => { attempts.push('A2'); return acquireRunLock(...args); } });
    await aGate.waiting;
    expect(attempts).toEqual([]); // A2 must not even compete for B's free port.
    bGate.resume(); const unlockB = await b; await unlockB(); aGate.resume();
    const unlockA2 = await a2; await unlockA2(); await f.admit('owner-release', { target: 'A3' });
    expect(attempts).toEqual(['A2']); expect(f.tickets()).toEqual([]);
  });
  it('U4-T3 expires and removes its own ticket', async () => {
    const f = fixture(); await f.lock();
    await expect(f.admit('owner-release', { wait: async () => f.advance(600_000) }))
      .rejects.toMatchObject({ code: 'RUN_LOCK_OCCUPIED', holderKind: 'owner-release' });
    expect(f.tickets()).toEqual([]);
  });
  it.each(['dead', 'reused'])('U4-T4/U4-T5 removes a %s process ticket', async kind => {
    const f = fixture(), stale = f.ticket('old');
    await f.admit('owner-release', { identityProbe: (pid: number) => pid === 123 ? kind === 'dead' ? negative() : ok('new-birth') : ok('born') });
    expect(existsSync(stale)).toBe(false); expect(f.tickets()).toEqual([]);
  });
  it('U4-T6 retains unknown identity through expiry and ages it out only after sixteen minutes', async () => {
    const f = fixture(), old = f.ticket('unknown');
    const identities = (pid: number) => pid === 123 ? unknown('query failed') : ok('born');
    await expect(f.admit('owner-release', { identityProbe: identities, wait: async () => f.advance(600_000) })).rejects.toMatchObject({ code: 'RUN_LOCK_OCCUPIED' });
    expect(existsSync(old)).toBe(true); f.advance(360_001);
    await f.admit('owner-release', { identityProbe: identities }); expect(existsSync(old)).toBe(false);
  });
  it('U4-T7 ignores unpublished partial temp files', async () => {
    const f = fixture(), path = join(f.directory, 'older.ticket.json.tmp'); writeFileSync(path, '{partial');
    await f.admit(); expect(readFileSync(path, 'utf8')).toBe('{partial');
  });
  it('U4-T8 admits exactly one same-tick waiter while the other retains its ticket', async () => {
    const f = fixture(), waiting = gate();
    const first = f.admit(), second = f.admit('owner-release', { wait: waiting.wait });
    const unlock = await first; await waiting.waiting;
    expect(f.tickets()).toHaveLength(1); await unlock(); waiting.resume(); await second;
    expect(f.tickets()).toEqual([]);
  });
  it('U4-T9 drops a bound port when an older ticket publishes after the first scan', async () => {
    const f = fixture(); let older = '', binds = 0;
    const wait = vi.fn(async () => {
      // Real bind proves the provisional holder released the port.
      const unlock = await f.lock(); await unlock(); rmSync(older);
    });
    await f.admit('owner-release', { wait,
      takeLock: async (...args: Parameters<typeof acquireRunLock>) => {
        if (++binds === 1) older = f.ticket('late-publisher');
        const unlock = await acquireRunLock(...args);
        if (binds === 1) expect(existsSync(join(f.directory, 'owner.json'))).toBe(false);
        return unlock;
      } });
    expect(wait).toHaveBeenCalledOnce(); expect(binds).toBe(2); expect(f.tickets()).toEqual([]);
  });
  it('U4-T10 admits a waiting nightly before a later release', async () => {
    const f = fixture(), a = await f.lock(), nightGate = gate(), releaseGate = gate();
    const night = f.admit('nightly', { wait: nightGate.wait }); await nightGate.waiting;
    f.advance(1);
    const release = f.admit('owner-release', { wait: releaseGate.wait }); await releaseGate.waiting;
    await a(); nightGate.resume(); const unlockNight = await night;
    expect(JSON.parse(readFileSync(join(f.directory, 'owner.json'), 'utf8')).kind).toBe('nightly');
    expect(f.tickets()).toHaveLength(1); await unlockNight(); releaseGate.resume(); await release;
  });
  it('U4-T11 refuses a release immediately for a nightly holder', async () => {
    const f = fixture(); await f.lock('nightly'); const wait = vi.fn();
    await expect(f.admit('owner-release', { wait })).rejects.toMatchObject({ holderKind: 'nightly' });
    expect(wait).not.toHaveBeenCalled(); expect(f.tickets()).toEqual([]);
  });
  it('U4-T12 shares coordination and holder metadata across report roots', async () => {
    const f = fixture(), first = await f.lock(), waiting = gate();
    const otherRoot = join(f.repository, 'other-reports');
    const other = admitRunLock(f.repository, otherRoot, 'nightly', { ...f.options, wait: waiting.wait });
    await waiting.waiting; expect(f.tickets()).toHaveLength(1);
    expect(existsSync(join(f.root, 'locks'))).toBe(false); expect(existsSync(otherRoot)).toBe(false);
    await first(); waiting.resume(); held.push(await other);
    expect(JSON.parse(readFileSync(join(f.directory, 'owner.json'), 'utf8')).kind).toBe('nightly');
  });
  it('orders ticket contents instead of filenames', async () => {
    const f = fixture(), path = f.ticket('zzzz', { ticketId: 'older', enqueuedAtMs: 0 });
    const wait = vi.fn(async () => { rmSync(path); });
    await f.admit('owner-release', { wait }); expect(wait).toHaveBeenCalledOnce();
  });
  it('ignores stale holder identity after a failed bind', async () => {
    const f = fixture(), holder = await f.lock('nightly'), path = join(f.directory, 'owner.json');
    writeFileSync(path, JSON.stringify({ kind: 'nightly', pid: 123, creationTime: 'old' }));
    const wait = vi.fn(async () => { await holder(); });
    await f.admit('owner-release', { wait }); expect(wait).toHaveBeenCalledOnce();
  });
  it('fails closed with a named reason when coordination cannot be written', async () => {
    const f = fixture(); rmSync(f.directory, { recursive: true }); writeFileSync(f.directory, 'blocked');
    const takeLock = vi.fn(acquireRunLock);
    await expect(f.admit('owner-release', { takeLock })).rejects.toMatchObject({ reasonCode: 'coordination-unavailable' });
    expect(takeLock).not.toHaveBeenCalled();
  });
  it('keeps a proven live ticket beyond the unknown-identity age cap', async () => {
    const f = fixture(), old = f.ticket('suspended', { enqueuedAtMs: f.now() - 17 * 60_000 });
    await expect(f.admit('owner-release', { wait: async () => f.advance(600_000) })).rejects.toMatchObject({ code: 'RUN_LOCK_OCCUPIED' });
    expect(existsSync(old)).toBe(true);
  });
  it('removes its ticket if waiting throws and bounds every identity query', async () => {
    const f = fixture(); f.ticket('first');
    const identities = vi.fn((pid: number, options: { softDeadline: number; deadlineNow: () => number; timeout: number }) => {
      expect(options.softDeadline).toBe(700_000); expect(options.deadlineNow()).toBe(f.now());
      expect(options.timeout).toBeLessThanOrEqual(options.softDeadline - f.now()); return ok('born');
    });
    await expect(f.admit('owner-release', { identityProbe: identities, wait: async () => { throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(f.tickets()).toEqual(['first.ticket.json']); expect(identities).toHaveBeenCalled();
  });
  it.each(['owner-release', 'nightly'])('admits %s when the self-identity probe needs 1.5 seconds', async kind => {
    const f = fixture();
    const identities = vi.fn((_pid: number, options: { timeout: number }) => {
      f.advance(Math.min(1500, options.timeout));
      return options.timeout < 1500 ? unknown(`probe timed out after ${options.timeout} ms`) : ok('born');
    });
    await f.admit(kind, { identityProbe: identities });
    expect(identities).toHaveBeenCalledOnce();
    expect(identities.mock.calls[0][1].timeout).toBe(10_000);
    expect(f.tickets()).toEqual([]);
  });
  it('caps self, queued-ticket and holder probes at the remaining admission deadline', async () => {
    const f = fixture(), holder = await f.lock(); f.ticket('first');
    const identities = vi.fn((pid: number, options: { softDeadline: number; timeout: number }) => {
      expect(options.timeout).toBe(Math.min(10_000, options.softDeadline - f.now()));
      if (identities.mock.calls.length === 1) f.advance(1500);
      return pid === 123 ? negative() : ok('born');
    });
    const takeLock = vi.fn((repositoryPath: string, root: string, kind: string, options: { timeout?: number }) =>
      acquireRunLock(repositoryPath, root, kind, options));
    await f.admit('owner-release', { waitBudgetMs: 3000, identityProbe: identities, takeLock, wait: holder });
    expect(identities.mock.calls.map(([, options]) => options.timeout)).toEqual([3000, 1500, 1500]);
    expect(takeLock.mock.calls.every(([, , , options]) => options.timeout === 1000)).toBe(true);
    expect(f.tickets()).toEqual([]);
  });
  it.each(['owner-release', 'nightly'])('preserves the self-probe timeout reason when %s admission fails closed', async kind => {
    const f = fixture(), takeLock = vi.fn(acquireRunLock);
    await expect(f.admit(kind, { takeLock,
      identityProbe: () => unknown('probe timed out after 10000 ms', 'stderr must not be included') }))
      .rejects.toMatchObject({ reasonCode: 'coordination-unavailable',
        message: 'coordination-unavailable: Process creation time unavailable: probe timed out after 10000 ms' });
    expect(takeLock).not.toHaveBeenCalled();
    expect(f.tickets()).toEqual([]);
  });
  it('bounds direct acquisition and preserves its self-probe timeout reason without a creationTime option', async () => {
    const f = fixture();
    const identities = vi.fn((_pid: number, options: { timeout: number }) => {
      expect(options.timeout).toBe(10_000);
      return unknown('probe timed out after 10000 ms', 'stderr must not be included');
    });
    await expect(acquireRunLock(f.repository, f.root, 'owner-release', { ...f.options, identityProbe: identities, timeout: 1000 }))
      .rejects.toMatchObject({ reasonCode: 'coordination-unavailable',
        message: 'coordination-unavailable: Process creation time unavailable: probe timed out after 10000 ms' });
    expect(identities).toHaveBeenCalledOnce();
    expect(existsSync(join(f.directory, 'owner.json'))).toBe(false);
    await f.lock(); // A failed identity probe must release the port.
  });
  it('reads the current OS process creation time and distinguishes a proven dead pid', () => {
    const result = processIdentity(process.pid, { timeout: 5000 });
    expect(result.state).toBe('ok'); expect(processIdentity(process.pid)).toMatchObject({ state: result.state, value: result.state === 'ok' ? result.value : null });
    expect(processIdentity(2_147_483_647).state).toBe('negative');
  });
});
