import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync, writeSync } from "node:fs";
import { homedir, hostname, tmpdir, uptime } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  acquireExecutionClaim, appendJournal, ExecutionClaimRefusedError, ExecutionOwnershipError, importLegacyLedgers, JournalWriteError, readJournal, resolveJournalPath, type LegacyImportCounts,
} from "../lib/github-issue-roadmap/intake-execution-journal";
import { indexHistory, resolveDurableState } from "../github-issue-roadmap-intake-apply";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), writeSync: vi.fn(fs.writeSync), closeSync: vi.fn(fs.closeSync),
    readdirSync: vi.fn(fs.readdirSync), mkdirSync: vi.fn(fs.mkdirSync), rmdirSync: vi.fn(fs.rmdirSync), renameSync: vi.fn(fs.renameSync) };
});
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, uptime: vi.fn(() => 100) };
});

let root: string;
let path: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "roadmap-journal-"));
  vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", root);
  path = resolveJournalPath("example-org/example-repo");
});
afterEach(() => {
  vi.mocked(fsyncSync).mockReset();
  vi.mocked(writeSync).mockReset();
  vi.mocked(closeSync).mockReset();
  vi.mocked(readdirSync).mockReset();
  vi.mocked(mkdirSync).mockReset();
  vi.mocked(rmdirSync).mockReset();
  vi.mocked(renameSync).mockReset();
  vi.mocked(uptime).mockReset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function persist(content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

type RefusedImport = Error & { readonly counts: LegacyImportCounts };

function refusedImport(ledgers: readonly string[]): RefusedImport {
  try { importLegacyLedgers(path, ledgers); }
  catch (error) {
    expect((error as Error).name).toBe("ImportRefusedError");
    return error as RefusedImport;
  }
  throw new Error("Expected legacy ledger import to be refused.");
}

// Shape of the 54 drain rows: 51 executed, one hold, two declined. Repository is
// absent; fingerprints, classifications and effect identity use summary fields.
function legacyRows() {
  const executed = Array.from({ length: 51 }, (_, index) => {
    const fingerprint = index.toString(16).padStart(64, "0");
    return {
      schemaVersion: "github-issue-roadmap-intake-approval-ledger/v1",
      appliedAt: "2026-09-12T18:41:54.404Z", mode: "execute", decisionContentSha256: "d".repeat(64),
      existenceRevalidation: { boundOriginMainSha: "a".repeat(40), trustedOriginMainSha: "b".repeat(40), verdictEqualityVerified: true },
      sourceFingerprint: fingerprint, candidateFingerprint: fingerprint,
      assessorSuggestedClassification: [{ fieldName: "Type", value: "Task", confidence: "high", rationale: "Bounded outcome." }],
      operatorFinalClassification: [{ fieldName: "Type", value: "Task" }],
      approved: true, executed: true, disposition: "executed", hold: null,
      intendedAction: "create_issue", intendedActions: ["create_issue"], actionTaken: "create_issue", actionsTaken: ["create_issue"],
      result: { issueNumber: 1777 + index, issueId: `I_${1777 + index}`, commentId: null },
    };
  });
  return [...executed, ...["hold", "declined", "declined"].map((disposition, index) => ({
    ...executed[0], sourceFingerprint: (51 + index).toString(16).padStart(64, "0"),
    candidateFingerprint: (51 + index).toString(16).padStart(64, "0"),
    approved: false, executed: false, disposition,
    hold: disposition === "hold" ? { reason: "plausible_overlap" } : null,
    intendedAction: disposition === "hold" ? null : "create_issue",
    intendedActions: disposition === "hold" ? [] : ["create_issue"],
    actionTaken: null, actionsTaken: [], result: { issueNumber: null, issueId: null, commentId: null },
  }))];
}

describe("execution claim filesystem store", () => {
  it("exports distinct live-holder and undiagnosable refusal reasons", () => {
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    try {
      expect(() => acquireExecutionClaim(path, { mode: "preflight" })).toThrow(ExecutionClaimRefusedError);
      expect(() => acquireExecutionClaim(path, { mode: "preflight" })).toThrow(expect.objectContaining({ reason: "live_holder" }));
    } finally { claim.release(); }
    const lockPath = join(dirname(path), "execution.lock");
    mkdirSync(lockPath);
    expect(() => acquireExecutionClaim(path, { mode: "execute" })).toThrow(expect.objectContaining({ reason: "undiagnosable", lockPath }));
  });

  it.each(["remote-host", "unreadable-process"])("does not classify %s ownership as a proven live holder", kind => {
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    const ownerPath = join(dirname(path), "execution.lock", "owner.json");
    const before = readFileSync(ownerPath);
    if (kind === "remote-host") writeFileSync(ownerPath, JSON.stringify({ ...JSON.parse(before.toString()), hostname: "another-host" }));
    else vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error("permission denied"), { code: "EPERM" }); });
    try {
      expect(() => acquireExecutionClaim(path, { mode: "preflight" })).toThrow(expect.objectContaining({ reason: "unverifiable_holder" }));
    } finally { claim.release(); }
  });

  it.each((["execute", "import", "resolve", "preflight", "decision-post"] as const).flatMap((holder) =>
    (["execute", "import", "resolve", "preflight", "decision-post"] as const).map((contender) => ({ holder, contender }))))
    ("excludes $contender while $holder owns the repository journal", ({ holder, contender }) => {
      const claim = acquireExecutionClaim(path, { mode: holder });
      const ownerPath = join(dirname(path), "execution.lock", "owner.json");
      const before = readFileSync(ownerPath);
      try {
        expect(() => acquireExecutionClaim(path, { mode: contender })).toThrow(`mode ${holder}`);
        expect(readFileSync(ownerPath)).toEqual(before);
      } finally { claim.release(); }
      const next = acquireExecutionClaim(path, { mode: contender });
      next.release();
    });

  it("creates a non-recursive claim, writes all owner bytes, fsyncs before close, and keeps its token private", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeSync).mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) =>
      fs.writeSync(fd, bytes, offset, Math.min(length, 3))) as typeof writeSync);
    const claim = acquireExecutionClaim(path, { mode: "execute", planPath: "plan.json" });
    const lockPath = join(dirname(path), "execution.lock");
    const owner = JSON.parse(readFileSync(join(lockPath, "owner.json"), "utf8"));
    expect(vi.mocked(mkdirSync).mock.calls).toEqual([[dirname(path), { recursive: true }], [lockPath]]);
    expect(owner).toEqual({ token: expect.stringMatching(/^[0-9a-f]{32}$/), pid: process.pid, hostname: hostname(),
      bootEpochMs: expect.any(Number), holderUptimeS: 100, acquiredAt: claim.ownership.acquiredAt, mode: "execute", planPath: "plan.json" });
    expect(owner.bootEpochMs % 1000).toBe(0);
    expect(Number.isFinite(Date.parse(owner.acquiredAt))).toBe(true);
    expect(writeSync).toHaveBeenCalledTimes(Math.ceil(Buffer.byteLength(JSON.stringify(owner) + "\n") / 3));
    expect(fsyncSync).toHaveBeenCalledOnce();
    expect(vi.mocked(fsyncSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(closeSync).mock.invocationCallOrder[0]);
    expect(JSON.stringify(claim)).not.toContain(owner.token);
    expect(claim.withOwnership(() => "owned")).toBe("owned");
    claim.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it("removes the rebooted holder's directory before creating the replacement", () => {
    const lockPath = join(dirname(path), "execution.lock");
    const original = acquireExecutionClaim(path, { mode: "import" });
    const ownerPath = join(lockPath, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    vi.mocked(uptime).mockReturnValue(1);
    const replacement = acquireExecutionClaim(path, { mode: "execute" });
    expect(rmdirSync).toHaveBeenCalledExactlyOnceWith(lockPath);
    expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toMatchObject({ pid: process.pid, mode: "execute" });
    expect(JSON.parse(readFileSync(ownerPath, "utf8")).token).not.toBe(owner.token);
    expect(() => original.release()).toThrow(ExecutionOwnershipError);
    replacement.release();
  });

  it("retries mkdir only once after clearance and preserves the contender that wins the retry", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const lockPath = join(dirname(path), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    acquireExecutionClaim(path, { mode: "execute" });
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, holderUptimeS: 200 }));
    const successor = { ...owner, token: "c".repeat(32), mode: "import" };
    let attempts = 0;
    vi.mocked(mkdirSync).mockImplementation(((directory: string, options?: never) => {
      if (directory === lockPath && ++attempts === 2) {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(ownerPath, JSON.stringify(successor));
        throw Object.assign(new Error("contender won"), { code: "EEXIST" });
      }
      return fs.mkdirSync(directory, options);
    }) as typeof mkdirSync);
    expect(() => acquireExecutionClaim(path, { mode: "execute" })).toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
    expect(attempts).toBe(2);
    expect(rmdirSync).toHaveBeenCalledExactlyOnceWith(lockPath);
    expect(JSON.parse(readFileSync(ownerPath, "utf8"))).toEqual(successor);
  });

  it.each(["missing", "mismatch"])("refuses protected actions and release with %s owner metadata", (reason) => {
    const lockPath = join(dirname(path), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    if (reason === "missing") rmSync(ownerPath);
    else {
      const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
      writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "d".repeat(32) }));
    }
    const action = vi.fn();
    expect(() => claim.withOwnership(action)).toThrow(ExecutionOwnershipError);
    expect(action).not.toHaveBeenCalled();
    expect(() => claim.release()).toThrow(ExecutionOwnershipError);
    expect(existsSync(lockPath)).toBe(true);
    expect(rmdirSync).not.toHaveBeenCalled();
  });

  it("atomic stale rename preserves B's fresh owner when B wins before A renames: exactly one holder", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const lockPath = join(dirname(path), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    acquireExecutionClaim(path, { mode: "execute" });
    vi.mocked(uptime).mockReturnValue(1);
    let winner!: ReturnType<typeof acquireExecutionClaim>;
    let winnerBytes!: Buffer;
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      // A already diagnosed the old holder. B completes reclamation and fsyncs
      // its new owner before A's atomic operation resumes.
      winner = acquireExecutionClaim(path, { mode: "import" });
      winnerBytes = readFileSync(ownerPath);
      fs.renameSync(from, to);
    });
    expect(() => acquireExecutionClaim(path, { mode: "execute" }))
      .toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
    expect(fsyncSync).toHaveBeenCalledTimes(2); // Original holder and B only.
    expect(readFileSync(ownerPath)).toEqual(winnerBytes);
    expect(readdirSync(lockPath)).toEqual(["owner.json"]);
    expect(winner.withOwnership(() => "one holder")).toBe("one holder");
    winner.release();
  });

  it("keeps B's fence owned while A verifies the live owner it parked", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const lockPath = join(dirname(path), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    acquireExecutionClaim(path, { mode: "execute" });
    vi.mocked(uptime).mockReturnValue(1);
    let winner!: ReturnType<typeof acquireExecutionClaim>;
    let winnerBytes!: Buffer;
    const action = vi.fn(() => appendJournal(path, { event: "created", issueNumber: 101 }));
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      // A diagnosed S, then B reclaimed it. A now parks B's live owner before
      // verifying it; B journals the landed create during that verify window.
      winner = acquireExecutionClaim(path, { mode: "execute" });
      winnerBytes = readFileSync(ownerPath);
      fs.renameSync(from, to);
      expect(existsSync(ownerPath)).toBe(false);
      winner.withOwnership(action);
    });
    expect(() => acquireExecutionClaim(path, { mode: "execute" }))
      .toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
    expect(action).toHaveBeenCalledOnce();
    expect(readJournal(path).records).toEqual([{ event: "created", issueNumber: 101 }]);
    expect(readFileSync(ownerPath)).toEqual(winnerBytes);
    expect(readdirSync(lockPath)).toEqual(["owner.json"]);
    winner.release();
  });

  it.each([
    "different token", "two parked files", "two parked files with one malformed",
    "present different owner", "present invalid owner", "released file", "invalid parked file",
  ])("refuses a parked ownership fallback with %s", (reason) => {
    const lockPath = join(dirname(path), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    const bytes = readFileSync(ownerPath);
    const differentOwner = { ...JSON.parse(bytes.toString("utf8")), token: "d".repeat(32) };
    const parkedPath = join(lockPath, reason === "released file" ? "owner.released.test" : "owner.stale.test");
    renameSync(ownerPath, parkedPath);
    if (reason === "different token") writeFileSync(parkedPath, JSON.stringify(differentOwner));
    if (reason === "two parked files") writeFileSync(join(lockPath, "owner.stale.second"), JSON.stringify(differentOwner));
    if (reason === "two parked files with one malformed") writeFileSync(join(lockPath, "owner.stale.second"), "{broken");
    if (reason === "present different owner") writeFileSync(ownerPath, JSON.stringify(differentOwner));
    if (reason === "present invalid owner") writeFileSync(ownerPath, "{broken");
    if (reason === "invalid parked file") writeFileSync(parkedPath, "{broken");
    const before = readdirSync(lockPath).map((name) => [name, readFileSync(join(lockPath, name))]);
    const action = vi.fn();
    expect(() => claim.withOwnership(action)).toThrow(ExecutionOwnershipError);
    expect(action).not.toHaveBeenCalled();
    expect(readdirSync(lockPath).map((name) => [name, readFileSync(join(lockPath, name))])).toEqual(before);
  });

  it("a reclaimer losing the atomic rename to ENOENT refuses without retrying", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const lockPath = join(dirname(path), "execution.lock");
    const parkedPath = join(lockPath, "owner.stale.other-reclaimer");
    acquireExecutionClaim(path, { mode: "execute" });
    vi.mocked(uptime).mockReturnValue(1);
    const before = readFileSync(join(lockPath, "owner.json"));
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      fs.renameSync(from, parkedPath);
      fs.renameSync(from, to); // The second reclaimer gets ENOENT.
    });
    expect(() => acquireExecutionClaim(path, { mode: "execute" }))
      .toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
    expect(renameSync).toHaveBeenCalledOnce();
    expect(rmdirSync).not.toHaveBeenCalled();
    expect(readFileSync(parkedPath)).toEqual(before);
    expect(fsyncSync).toHaveBeenCalledOnce();
  });

  it("a third process between rmdir and mkdir is the sole winner and both contenders refuse", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const lockPath = join(dirname(path), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    acquireExecutionClaim(path, { mode: "execute" });
    vi.mocked(uptime).mockReturnValue(1);
    let winner!: ReturnType<typeof acquireExecutionClaim>;
    let winnerBytes!: Buffer;
    let attempts = 0;
    vi.mocked(mkdirSync).mockImplementation(((directory: string, options?: never) => {
      if (directory === lockPath && ++attempts === 2) {
        winner = acquireExecutionClaim(path, { mode: "import" });
        winnerBytes = readFileSync(ownerPath);
      }
      return fs.mkdirSync(directory, options);
    }) as typeof mkdirSync);
    for (let contender = 0; contender < 2; contender++) {
      expect(() => acquireExecutionClaim(path, { mode: "execute" }))
        .toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
      expect(readFileSync(ownerPath)).toEqual(winnerBytes);
    }
    expect(attempts).toBe(4); // A's two attempts, third process, second contender.
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    expect(winner.withOwnership(() => true)).toBe(true);
    winner.release();
  });

  it("refuses ENOTEMPTY after stale rename without deleting the unexpected entry or retrying mkdir", () => {
    const lockPath = join(dirname(path), "execution.lock");
    acquireExecutionClaim(path, { mode: "execute" });
    const unexpected = join(lockPath, "unexpected");
    writeFileSync(unexpected, "keep these bytes");
    vi.mocked(uptime).mockReturnValue(1);
    vi.mocked(mkdirSync).mockClear();
    expect(() => acquireExecutionClaim(path, { mode: "execute" }))
      .toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
    expect(vi.mocked(mkdirSync).mock.calls).toEqual([[dirname(path), { recursive: true }], [lockPath]]);
    expect(readFileSync(unexpected, "utf8")).toBe("keep these bytes");
    expect(readdirSync(lockPath)).toEqual(["unexpected"]);
  });

  it("release restores a fresh successor's byte-identical owner after losing the rename race", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const lockPath = join(dirname(path), "execution.lock");
    const ownerPath = join(lockPath, "owner.json");
    const original = acquireExecutionClaim(path, { mode: "execute" });
    vi.mocked(uptime).mockReturnValue(1);
    let successor!: ReturnType<typeof acquireExecutionClaim>;
    let before!: Buffer;
    vi.mocked(renameSync).mockImplementationOnce((from, to) => {
      successor = acquireExecutionClaim(path, { mode: "import" });
      before = readFileSync(ownerPath);
      fs.renameSync(from, to);
    });
    expect(() => original.release()).toThrow(ExecutionOwnershipError);
    expect(readFileSync(ownerPath)).toEqual(before);
    expect(readdirSync(lockPath)).toEqual(["owner.json"]);
    expect(successor.withOwnership(() => true)).toBe(true);
    successor.release();
  });

  it.each([-60000, 60000])("refuses a live holder after a %i ms wall-clock step and delayed sampling", (step) => {
    const claim = acquireExecutionClaim(path, { mode: "execute" });
    const ownerPath = join(dirname(path), "execution.lock", "owner.json");
    const before = readFileSync(ownerPath);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + step);
    vi.mocked(uptime).mockReturnValue(120);
    const probe = vi.spyOn(process, "kill");
    expect(() => acquireExecutionClaim(path, { mode: "import" }))
      .toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, 0);
    expect(readFileSync(ownerPath)).toEqual(before);
    claim.release();
  });

  it.each([
    { currentUptime: 100, alive: true }, { currentUptime: 200, alive: true },
    { currentUptime: 100, alive: false }, { currentUptime: 200, alive: false },
  ])("checks pid at uptime $currentUptime with alive=$alive", ({ currentUptime, alive }) => {
    const original = acquireExecutionClaim(path, { mode: "execute" });
    vi.mocked(uptime).mockReturnValue(currentUptime);
    const probe = vi.spyOn(process, "kill").mockImplementation(() => {
      if (!alive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      return true;
    });
    if (alive) {
      expect(() => acquireExecutionClaim(path, { mode: "import" }))
        .toThrow(expect.objectContaining({ name: "ExecutionClaimRefusedError" }));
      original.release();
    } else {
      const replacement = acquireExecutionClaim(path, { mode: "import" });
      expect(() => original.withOwnership(() => {})).toThrow(ExecutionOwnershipError);
      replacement.release();
    }
    expect(probe).toHaveBeenCalledExactlyOnceWith(process.pid, 0);
  });

  it("releases its claim if owner fsync fails after writing valid metadata", () => {
    const cause = new Error("owner fsync failed");
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw cause; });
    expect(() => acquireExecutionClaim(path, { mode: "execute" })).toThrow(expect.objectContaining({
      message: `Execution claim owner write failed: ${join(dirname(path), "execution.lock")} (owner fsync failed). Claim directory removed.`, cause,
    }));
    expect(existsSync(join(dirname(path), "execution.lock"))).toBe(false);
    expect(existsSync(path)).toBe(false);
    const next = acquireExecutionClaim(path, { mode: "import" });
    next.release();
  });

  it("preserves an undiagnosable claim after a partial owner write", () => {
    vi.mocked(writeSync).mockReturnValueOnce(0);
    const lockPath = join(dirname(path), "execution.lock");
    expect(() => acquireExecutionClaim(path, { mode: "execute" })).toThrow(expect.objectContaining({
      message: `Execution claim owner write failed: ${lockPath} (Journal write made no progress.). Claim directory retained; remove it by hand only after confirming no intake run is live.`,
      cause: expect.objectContaining({ message: "Journal write made no progress." }),
    }));
    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(join(lockPath, "owner.json"), "utf8")).toBe("");
    expect(() => acquireExecutionClaim(path, { mode: "execute" })).toThrow("occupied and undiagnosable");
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it("preserves the owner write cause when best-effort release also fails", () => {
    const cause = new Error("owner fsync failed");
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw cause; });
    vi.mocked(renameSync).mockImplementationOnce(() => { throw new Error("cleanup denied"); });
    expect(() => acquireExecutionClaim(path, { mode: "execute" })).toThrow(expect.objectContaining({
      message: expect.stringContaining("owner fsync failed). Claim directory retained"), cause,
    }));
    expect(existsSync(join(dirname(path), "execution.lock", "owner.json"))).toBe(true);
  });
});

describe("execution journal filesystem store", () => {
  it("resolves one machine-wide repository path with no checkout, plan or cwd input", () => {
    expect(path).toBe(join(root, "example-org--example-repo", "execution.journal.jsonl"));
    expect(resolveJournalPath("example-org/example-repo")).toBe(path);
    vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", undefined);
    expect(resolveJournalPath("example-org/example-repo"))
      .toBe(join(homedir(), ".example-repo", "roadmap-intake", "example-org--example-repo", "execution.journal.jsonl"));
    vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", "relative-root");
    expect(() => resolveJournalPath("example-org/example-repo")).toThrow("ROADMAP_INTAKE_JOURNAL_ROOT must be an absolute path.");
  });

  it.each(["C:\\journal", "C:/journal", "\\\\server\\share\\journal", "//server/share/journal"])("accepts a drive-qualified or UNC Windows root: %s", (root) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", root);
      vi.mocked(readdirSync).mockReturnValueOnce([]);
      expect(() => resolveJournalPath("example-org/example-repo")).not.toThrow();
    } finally { vi.unstubAllGlobals(); }
  });

  it("refuses a drive-relative Windows root: C:journal", () => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", "C:journal");
      expect(() => resolveJournalPath("example-org/example-repo"))
        .toThrow("ROADMAP_INTAKE_JOURNAL_ROOT must be an absolute path.");
    } finally { vi.unstubAllGlobals(); }
  });

  it("refuses a differently-cased sibling directory before resolving a folded journal path", () => {
    const existingDirectory = join(root, "Example-Org--example-repo");
    mkdirSync(existingDirectory);
    const expectedMessage = `Execution journal directory casing conflict: expected "${dirname(path)}", but differently-cased directory "${existingDirectory}" exists.`;
    try { resolveJournalPath("example-org/example-repo"); throw new Error("expected refusal"); } catch (error) { expect((error as Error).name).toBe("JournalDirectoryCaseConflictError"); }
    expect(() => resolveJournalPath("example-org/example-repo")).toThrow(expectedMessage);
    expect(readdirSync(root)).toEqual(["Example-Org--example-repo"]);
    expect(existsSync(path)).toBe(false);
    expect(writeSync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it("accepts an exactly-cased directory and ignores a differently-cased sibling file", () => {
    mkdirSync(dirname(path));
    expect(resolveJournalPath("example-org/example-repo")).toBe(path);
    const fileRoot = join(root, "files");
    mkdirSync(fileRoot);
    writeFileSync(join(fileRoot, "Example-Org--example-repo"), "", "utf8");
    vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", fileRoot);
    expect(resolveJournalPath("example-org/example-repo")).toBe(join(fileRoot, "example-org--example-repo", "execution.journal.jsonl"));
  });

  it.each(["\\journal", "/journal"])("refuses a drive-less Windows root: %s", (root) => {
    vi.stubGlobal("process", { ...process, platform: "win32" });
    try {
      vi.stubEnv("ROADMAP_INTAKE_JOURNAL_ROOT", root);
      expect(() => resolveJournalPath("example-org/example-repo"))
        .toThrow(new Error("ROADMAP_INTAKE_JOURNAL_ROOT must be a drive-qualified absolute path or UNC path on Windows."));
    } finally { vi.unstubAllGlobals(); }
  });

  it("reads a missing journal as unprovisioned without creating it", () => {
    expect(readJournal(path)).toEqual({ records: [], tail: null, provisioned: false });
    expect(existsSync(dirname(path))).toBe(false);
  });

  it.each(['{"event":"complete"}', '{"event":', 'é{"sourceFingerprint":"unfinished'])
    ("keeps an unterminated segment out of records: %s", (tail) => {
      const content = `{"prior":true}\n${tail}`;
      persist(content);
      expect(readJournal(path)).toEqual({ records: [{ prior: true }], tail: { bytes: Buffer.from(tail), malformed: true }, provisioned: true });
      expect(readFileSync(path, "utf8")).toBe(content);
    });

  it("treats valid JSON without any trailing newline as a malformed tail", () => {
    persist('{"event":"complete"}');
    expect(readJournal(path)).toEqual({ records: [], tail: { bytes: Buffer.from('{"event":"complete"}'), malformed: true }, provisioned: true });
  });

  it("parses terminated lines independently and retains concatenated objects as malformed", () => {
    persist(' \r\n{"first":1}\r\n{"a":1}{"b":2}\nnull\n');
    expect(readJournal(path)).toEqual({ records: [{ first: 1 }, { malformedJson: '{"a":1}{"b":2}' }, null], tail: null, provisioned: true });
  });

  it("appends exact UTF-8 lines and fsyncs each before close", () => {
    appendJournal(path, { title: "Grants — café" });
    appendJournal(path, { second: true });
    expect(readFileSync(path)).toEqual(Buffer.from('{"title":"Grants — café"}\n{"second":true}\n'));
    expect(fsyncSync).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fsyncSync).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(closeSync).mock.invocationCallOrder[0]);
  });

  it("loops on short writes until the whole line is durable", async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    vi.mocked(writeSync).mockImplementation(((fd: number, bytes: Buffer, offset: number, length: number) =>
      fs.writeSync(fd, bytes, offset, Math.min(length, 3))) as typeof writeSync);
    appendJournal(path, { title: "café" });
    expect(readFileSync(path, "utf8")).toBe('{"title":"café"}\n');
    expect(vi.mocked(writeSync).mock.calls.length).toBeGreaterThan(1);
    expect(fsyncSync).toHaveBeenCalledOnce();
  });

  it("throws JournalWriteError on fsync failure before advancing caller state", () => {
    const records: unknown[] = [];
    const record = { event: "intent" };
    vi.mocked(fsyncSync).mockImplementationOnce(() => { throw new Error("fsync unavailable"); });
    expect(() => { appendJournal(path, record); records.push(record); }).toThrow(JournalWriteError);
    expect(records).toEqual([]);
    expect(closeSync).toHaveBeenCalledOnce();
    // Bytes can exist even when durability was not confirmed; never erase them.
    expect(readFileSync(path, "utf8")).toBe('{"event":"intent"}\n');
  });

  it("wraps write failures and refuses a zero-progress write", () => {
    vi.mocked(writeSync).mockReturnValueOnce(0);
    expect(() => appendJournal(path, { event: "intent" })).toThrow(JournalWriteError);
    expect(fsyncSync).not.toHaveBeenCalled();
    expect(closeSync).toHaveBeenCalledOnce();
  });

  it("refuses append over an unterminated tail without repairing bytes", () => {
    persist('{"event":');
    expect(() => appendJournal(path, { event: "intent" })).toThrow(JournalWriteError);
    expect(readFileSync(path, "utf8")).toBe('{"event":');
    expect(writeSync).not.toHaveBeenCalled();
  });

  it("imports 54 legacy-shaped rows (51 executed, one hold, two declined) once with provenance and leaves sources untouched", () => {
    const rows = legacyRows();
    const ledgers = [join(root, "pilot.jsonl"), join(root, "batch.jsonl")];
    const contents = [rows.slice(0, 5), rows.slice(5)].map((part) => part.map((row) => JSON.stringify(row)).join("\n") + "\n");
    ledgers.forEach((ledger, index) => writeFileSync(ledger, contents[index], "utf8"));
    expect(importLegacyLedgers(path, ledgers)).toEqual({ imported: 54, skipped: 0, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    const events = readJournal(path).records as { kind: string; importedFrom: string; importedAt: string; row: unknown }[];
    expect(events.map((event) => event.row)).toEqual(rows);
    expect(events.every((event) => event.kind === "legacy_import" && !Number.isNaN(Date.parse(event.importedAt)))).toBe(true);
    expect(events.map((event) => event.importedFrom)).toEqual([...Array(5).fill(ledgers[0]), ...Array(49).fill(ledgers[1])]);
    expect(rows.filter((row) => row.executed)).toHaveLength(51);
    expect(rows.filter((row) => row.disposition === "hold")).toHaveLength(1);
    expect(rows.filter((row) => row.disposition === "declined")).toHaveLength(2);
    const before = readFileSync(path);
    expect(importLegacyLedgers(path, ledgers)).toEqual({ imported: 0, skipped: 54, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    expect(readFileSync(path)).toEqual(before);
    ledgers.forEach((ledger, index) => expect(readFileSync(ledger, "utf8")).toBe(contents[index]));
  });

  it("deduplicates by canonical row hash and absolute source path", () => {
    const ledger = join(root, "legacy.jsonl");
    const row = legacyRows()[0];
    const reordered = Object.fromEntries(Object.entries(row).reverse());
    writeFileSync(ledger, JSON.stringify(row) + "\n", "utf8");
    expect(importLegacyLedgers(path, [ledger]).imported).toBe(1);
    writeFileSync(ledger, JSON.stringify(reordered) + "\n", "utf8");
    expect(importLegacyLedgers(path, [join(root, ".", "legacy.jsonl")])).toEqual({ imported: 0, skipped: 1, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    const another = join(root, "another.jsonl");
    writeFileSync(another, JSON.stringify(reordered) + "\n", "utf8");
    expect(importLegacyLedgers(path, [another]).imported).toBe(1);
  });

  it("imports five null/optional-field legacy variants and skips all five on re-import", () => {
    const ledger = join(root, "optional-legacy.jsonl");
    const row = legacyRows()[0];
    const rows = [
      { ...row, repository: null },
      { ...row, result: { issueNumber: null, issueId: null, commentId: null } },
      { ...row, result: {} },
      { candidateFingerprint: "c".repeat(64), executed: true, result: { issueNumber: 202 } },
      { sourceFingerprint: "d".repeat(64), executed: true, result: { issueNumber: 203, issueId: 204, commentId: 205 } },
    ];
    writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
    expect(importLegacyLedgers(path, [ledger])).toEqual({ imported: 5, skipped: 0, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    expect(readJournal(path).records).toEqual(rows.map((row) => expect.objectContaining({ row })));
    const before = readFileSync(path);
    expect(importLegacyLedgers(path, [ledger])).toEqual({ imported: 0, skipped: 5, rejected: 0, malformed: 0, rejectedLines: [], malformedLines: [] });
    expect(readFileSync(path)).toEqual(before);
  });

  it.each([false, true])("refuses a torn executed line across the whole input set (journal exists=%s)", (provisioned) => {
    const validLedger = join(root, "valid.jsonl");
    const ledger = join(root, "legacy.jsonl");
    const row = legacyRows()[0];
    if (provisioned) persist(JSON.stringify({ kind: "legacy_import", importedFrom: validLedger, row }) + "\n");
    const before = provisioned ? readFileSync(path) : null;
    writeFileSync(validLedger, legacyRows().slice(0, 2).map((row) => JSON.stringify(row)).join("\n"), "utf8");
    const torn = `{"sourceFingerprint":"${"a".repeat(64)}","executed":true,"result":{"issueNumber":4`;
    writeFileSync(ledger, `\n${JSON.stringify(row)}\n\n${torn}`, "utf8");
    const error = refusedImport([validLedger, ledger]);
    expect(error.name).toBe("ImportRefusedError");
    expect(error.message).toContain(`${ledger}:4: malformed: Invalid JSON.`);
    expect(error.counts).toEqual({ imported: 0, skipped: provisioned ? 1 : 0, rejected: 0, malformed: 1,
      rejectedLines: [], malformedLines: [{ path: ledger, lineNumber: 4, reason: "Invalid JSON." }] });
    if (before !== null) expect(readFileSync(path)).toEqual(before);
    else expect(existsSync(dirname(path))).toBe(false);
    expect(writeSync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
  });

  it("rejects a copied journal without double-wrapping or hiding the original imported identities", () => {
    const ledger = join(root, "legacy.jsonl");
    const rows = legacyRows().slice(0, 2);
    writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    expect(importLegacyLedgers(path, [ledger]).imported).toBe(2);
    const before = readFileSync(path);
    const copy = join(root, "copied-journal.jsonl");
    writeFileSync(copy, before);
    const error = refusedImport([copy]);
    expect(error.counts).toEqual({ imported: 0, skipped: 0, rejected: 2, malformed: 0,
      rejectedLines: [1, 2].map((lineNumber) => ({ path: copy, lineNumber,
        reason: "Journal envelopes and staged events cannot be imported as legacy ledger rows." })), malformedLines: [] });
    for (const lineNumber of [1, 2]) expect(error.message).toContain(`${copy}:${lineNumber}: rejected:`);
    expect(readFileSync(path)).toEqual(before);
    const history = indexHistory(readJournal(path).records);
    for (const row of rows) {
      const state = resolveDurableState(history, { repository: "example-org/example-repo", sourceFingerprint: row.sourceFingerprint, action: "create_issue" });
      expect(state).toMatchObject({ kind: "legacy_unverified", operation: { result: row.result } });
    }
  });

  it("requires attributable legacy shape while retaining either fingerprint and optional metadata", () => {
    const ledger = join(root, "minimal-legacy.jsonl");
    const rows = [
      { candidateFingerprint: "c".repeat(64), executed: true, result: { issueNumber: 202 } },
      { sourceFingerprint: "d".repeat(64), mode: "dry-run" },
      { sourceFingerprint: "e".repeat(64), mode: "execute", executed: false },
    ];
    writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    expect(importLegacyLedgers(path, [ledger])).toEqual({ imported: 3, skipped: 0, rejected: 0, malformed: 0,
      rejectedLines: [], malformedLines: [] });
    const history = indexHistory(readJournal(path).records);
    expect(resolveDurableState(history, { repository: "example-org/example-repo", sourceFingerprint: "c".repeat(64), action: "create_issue" }))
      .toMatchObject({ kind: "legacy_unverified", operation: { result: { issueNumber: 202 } } });
    expect(history.malformed).toEqual([]);
  });

  it("refuses every unattributable legacy shape before appending valid rows", () => {
    const ledger = join(root, "invalid-legacy.jsonl");
    const rows = [legacyRows()[0],
      { executed: true, result: { issueNumber: 202 } },
      { sourceFingerprint: "", candidateFingerprint: 42, executed: true, result: {} },
      { sourceFingerprint: "f".repeat(64), executed: true },
    ];
    writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n"), "utf8");
    const error = refusedImport([ledger]);
    expect(error.counts).toEqual({ imported: 0, skipped: 0, rejected: 0, malformed: 3,
      rejectedLines: [], malformedLines: [2, 3, 4].map((lineNumber) => ({ path: ledger, lineNumber, reason: "Invalid legacy ledger row shape." })) });
    expect(existsSync(dirname(path))).toBe(false);
  });

  it("counts shapeless and prose lines as malformed without changing the journal bytes", () => {
    persist(JSON.stringify({ kind: "legacy_import", row: legacyRows()[0] }) + "\n");
    const before = readFileSync(path);
    const ledger = join(root, "shapeless.jsonl");
    writeFileSync(ledger, '{}\n\nprose\n"prose JSON"\n{"notes":"prose object"}\nnull\n{"kind":{"toString":null}}\n', "utf8");
    const error = refusedImport([ledger]);
    expect(error.counts).toEqual({ imported: 0, skipped: 0, rejected: 0, malformed: 6,
      rejectedLines: [], malformedLines: [1, 3, 4, 5, 6, 7].map((lineNumber) => ({ path: ledger, lineNumber, reason: expect.any(String) })) });
    for (const lineNumber of [1, 3, 4, 5, 6, 7]) expect(error.message).toContain(`${ledger}:${lineNumber}: malformed:`);
    expect(readFileSync(path)).toEqual(before);
  });

  it("rejects staged journal kinds and event rows without provisioning a journal", () => {
    const ledger = join(root, "events.jsonl");
    const rows = ["intent", "created", "complete", "classification_failed", "create_unresolved"]
      .flatMap((event) => [{ ...legacyRows()[0], kind: event }, { ...legacyRows()[0], event }]);
    writeFileSync(ledger, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
    expect(refusedImport([ledger]).counts).toEqual({ imported: 0, skipped: 0, rejected: 10, malformed: 0,
      rejectedLines: rows.map((_, index) => ({ path: ledger, lineNumber: index + 1,
        reason: "Journal envelopes and staged events cannot be imported as legacy ledger rows." })), malformedLines: [] });
    expect(existsSync(path)).toBe(false);
  });

  it("reports rejected and malformed lines in every supplied file without appending any valid row", () => {
    const ledgers = [join(root, "wrapped.jsonl"), join(root, "broken.jsonl")];
    writeFileSync(ledgers[0], `${JSON.stringify(legacyRows()[0])}\n${JSON.stringify({ kind: "legacy_import", row: legacyRows()[1] })}\n`, "utf8");
    writeFileSync(ledgers[1], `\n{broken\n${JSON.stringify(legacyRows()[2])}\n`, "utf8");
    const error = refusedImport(ledgers);
    expect(error.counts).toMatchObject({ imported: 0, skipped: 0, rejected: 1, malformed: 1 });
    expect(error.message).toContain("rejected=1, malformed=1");
    expect(error.message).toContain(`${ledgers[0]}:2: rejected: Journal envelopes`);
    expect(error.message).toContain(`${ledgers[1]}:2: malformed: Invalid JSON.`);
    expect(existsSync(dirname(path))).toBe(false);
    expect(writeSync).not.toHaveBeenCalled();
    expect(fsyncSync).not.toHaveBeenCalled();
  });
});
