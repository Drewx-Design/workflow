import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { prepareIntakeDrain as prepareDrain, type IntakeDrainDependencies } from "../github-issue-roadmap-intake-drain";
import { listIntakeHolds } from "../github-issue-roadmap-intake-holds";
import { canonicalJsonSha256, prettyCanonicalJson } from "../lib/github-issue-roadmap/canonical-json";
import { INTAKE_DRAIN_ADMISSION_SCHEMA, classifyRun, readIntakeRuns } from "../lib/github-issue-roadmap/intake-drain-admission";
import { intakeSnapshotJson } from "../lib/github-issue-roadmap/intake-snapshot";
import { OUTCOME_ENVELOPE_SCHEMA_VERSION_V2, createOutcomeEnvelope, outcomeEnvelopeJson, outcomeSourceContentSha256, parseOutcomeEnvelope } from "../lib/github-issue-roadmap/outcome-candidate";
import { censusPass, stackEnvelope, stackSnapshot } from "./__helpers__/roadmap-intake-stack";
import { admissionGitPreload, cleanAdmissionGit } from "./__helpers__/roadmap-admission-git";

function prepareIntakeDrain(input: Parameters<typeof prepareDrain>[0]) {
  return prepareDrain({ runGit: cleanAdmissionGit, dispositionHistory: () => new Map(), ...input });
}

const repoRoot = process.cwd();
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "drain-admission-"));
  const drainsRoot = join(root, "artifacts/github-issue-roadmap/drains");
  const queue = join(root, "queue");
  mkdirSync(drainsRoot, { recursive: true });
  mkdirSync(queue);
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "docs/plans"), { recursive: true });
  const source = "# source\n";
  writeFileSync(join(root, "scripts/github-issue-roadmap-producers.json"), readFileSync(join(repoRoot, "scripts/github-issue-roadmap-producers.json")));
  writeFileSync(join(root, "stack.json"), "{}\n");
  const base = stackEnvelope(6);
  writeFileSync(join(root, base.artifact.sourceLocator), source);
  const candidates = base.candidates.map(({ sourceFingerprint: _fingerprint, emissionContentSha256: _emission, ...material }) => ({
    ...material,
    evidence: material.evidence.map((evidence) => {
      const path = join(root, evidence.sourceLocator);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, source);
      return { ...evidence, contentSha256: outcomeSourceContentSha256(Buffer.from(source)) };
    }),
  }));
  const sidecars = candidates.map((candidate, index) => {
    const envelope = createOutcomeEnvelope({ ...base, candidates: [candidate] });
    const path = `queue/${index}.json`;
    writeFileSync(join(root, path), outcomeEnvelopeJson(envelope));
    return { path, sha256: hash(readFileSync(join(root, path))) };
  });
  const queueIdentity = canonicalJsonSha256({ queue: sidecars, stack: { path: "stack.json", sha256: hash("{}\n") } });
  const runId = `d-${queueIdentity.slice(0, 12)}`;
  const runRoot = join(drainsRoot, runId);
  const expected = [candidates.slice(0, 5), candidates.slice(5)].map((group) => createOutcomeEnvelope({ ...base, candidates: group }));
  return { root, queue, drainsRoot, runId, runRoot, sidecars, expected, admissionPath: join(runRoot, "admission.json") };
}

function cli(test: ReturnType<typeof fixture>, mode: "interrupt" | "reconstruct" | "unreadable" | "attempts-unreadable" | "artifact-unreadable" | "torn-admission" | "torn-manifest" | "quarantine-crash" | "receipt-committed-crash" | "normal", holds = false) {
  const preload = join(test.root, "fault.cjs");
  writeFileSync(preload, `
${admissionGitPreload}
const historyChild = require('node:child_process');
const admissionGit = historyChild.execFileSync;
historyChild.execFileSync = function(command, args, ...options) {
  if (command === 'git') {
    if (args.includes('--is-shallow-repository')) return 'false';
    const rev = args.indexOf('rev-parse');
    if (rev >= 0 && ["origin/main^{commit}", "a".repeat(40) + "^{commit}"].includes(args[rev + 2])) return "a".repeat(40);
    if (args.includes('log') && args.includes('--raw')) return '';
  }
  return admissionGit.call(this, command, args, ...options);
};
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const write = fs.writeFileSync;
const read = fs.readFileSync;
const list = fs.readdirSync;
const rename = fs.renameSync;
const root = ${JSON.stringify(test.drainsRoot)};
const queue = ${JSON.stringify(test.queue)};
const mode = ${JSON.stringify(mode)};
fs.writeFileSync = function(path, ...args) {
  const name = String(path);
  if ((mode === 'torn-admission' && name.endsWith('admission.json')) || (mode === 'torn-manifest' && name.endsWith('manifest.json'))) {
    write.call(this, path, '{torn');
    throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
  }
  if (mode === 'quarantine-crash' && name.includes('quarantine') && name.endsWith('abandoned.json')) {
    write.call(this, path, '{partial');
    process.exit(87);
  }
  if (mode === 'interrupt' && /envelope-\\d+\\.json$/.test(String(path))) process.exit(86);
  return write.call(this, path, ...args);
};
fs.renameSync = function(from, to) {
  const result = rename.call(this, from, to);
  if (mode === 'receipt-committed-crash' && String(to).endsWith('.abandoned.json')) process.exit(87);
  return result;
};
fs.readdirSync = function(path, ...args) {
  if (mode === 'unreadable' && String(path) === root) throw Object.assign(new Error('denied'), { code: 'EACCES' });
  if (mode === 'reconstruct' && String(path) === queue) throw new Error('QUEUE_SCANNED');
  return list.call(this, path, ...args);
};
fs.readFileSync = function(path, ...args) {
  if (mode === 'attempts-unreadable' && String(path).endsWith('attempts.json')) throw Object.assign(new Error('attempts denied'), { code: 'EACCES' });
  if (mode === 'artifact-unreadable' && /envelope-1\\.json$/.test(String(path))) throw Object.assign(new Error('artifact denied'), { code: 'EACCES' });
  if (mode === 'reconstruct' && String(path).endsWith('github-issue-roadmap-producers.json')) throw new Error('REGISTRY_READ');
  return read.call(this, path, ...args);
};
if (mode === 'reconstruct') process.chdir = () => { throw new Error('TEST_EXTERNAL_SNAPSHOT_BOUNDARY'); };
syncBuiltinESMExports();
`);
  return spawnSync(process.execPath, [
    "--require", preload, "--import", loader,
    join(repoRoot, holds ? "scripts/github-issue-roadmap-intake-holds.ts" : "scripts/github-issue-roadmap-intake-drain.ts"),
    ...(holds ? ["list"] : ["prepare", "--queue=queue", "--stack=stack.json"]),
  ], { cwd: test.root, encoding: "utf8", timeout: 30_000 });
}

const dependencies: IntakeDrainDependencies = {
  captureSnapshots: ({ candidatePath, canonicalPath, intakePath }) => {
    const envelope = parseOutcomeEnvelope(JSON.parse(readFileSync(candidatePath, "utf8")));
    writeFileSync(canonicalPath, "{}\n");
    writeFileSync(intakePath, intakeSnapshotJson(stackSnapshot(envelope, censusPass())));
  },
  authorRequest: ({ exchangeRoot }) => ({ bundlePath: join(exchangeRoot, "bundle"), assessmentTarget: join(exchangeRoot, "assessment.json") }),
  runShadow: () => { throw new Error("No collection in admission tests"); },
};

function attemptMarkers(runRoot: string): string[] {
  return readdirSync(dirname(runRoot)).filter((name) => name.startsWith(`${basename(runRoot)}-`) &&
    /^[a-f0-9-]{36}-attempts\.json$/.test(name.slice(basename(runRoot).length + 1)));
}

function admitted() {
  const test = fixture();
  expect(() => prepareIntakeDrain({
    repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json",
    dependencies: { ...dependencies, captureSnapshots: () => { throw new Error("snapshot interruption"); } },
  })).toThrow("snapshot interruption");
  return test;
}

describe("durable drain admission", () => {
  it("torn legacy attempts do not erase append-only evidence or prevent bounded abandonment", () => {
    const test = admitted();
    const attemptsPath = join(test.runRoot, "attempts.json");
    writeFileSync(attemptsPath, '{"count":');
    const authorRequest = vi.fn(() => { throw new Error("persistent author failure"); });
    const input = { repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json",
      dependencies: { ...dependencies, authorRequest } };
    const firstMarker = attemptMarkers(test.runRoot)[0];
    const firstBytes = readFileSync(join(test.drainsRoot, firstMarker));
    for (let count = 2; count <= 5; count += 1) {
      try { prepareIntakeDrain(input); } catch { /* No fresh candidate remains. */ }
      expect(authorRequest).toHaveBeenCalledTimes(count - 1);
      expect(attemptMarkers(test.runRoot)).toHaveLength(count);
      expect(readFileSync(join(test.drainsRoot, firstMarker))).toEqual(firstBytes);
      expect(classifyRun(test.runRoot).status === "abandoned").toBe(count === 5);
    }
    expect(listIntakeHolds({ repoRoot: test.root })[0].reason).toContain("retry bound reached");
  });

  it.each(['{"count":', "null", "[]", '{"count":-1}', '{"count":1,"abandonmentReason":false}'])(
    "invalid legacy attempts %s do not refuse healthy recovery", (content) => {
      const test = admitted();
      writeFileSync(join(test.runRoot, "attempts.json"), content);
      const manifest = prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
      expect(manifest.runId).toBe(test.runId);
      expect(readFileSync(join(test.runRoot, "attempts.json"), "utf8")).toBe(content);
      expect(attemptMarkers(test.runRoot)).toHaveLength(2);
    },
  );

  it("a persistently failing admission does not block a healthy fresh candidate", () => {
    const test = admitted();
    writeFileSync(join(test.queue, "fresh.json"), readFileSync(join(test.root, test.sidecars[0].path)));
    const captureSnapshots: IntakeDrainDependencies["captureSnapshots"] = (input) => {
      if (input.candidatePath.startsWith(test.runRoot)) throw new Error("persistent snapshot failure");
      dependencies.captureSnapshots(input);
    };
    const manifest = prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json",
      dependencies: { ...dependencies, captureSnapshots } });
    expect(manifest.runId).not.toBe(test.runId);
    expect(manifest.envelopes.flatMap((entry) => entry.queueEntries.map((queue) => queue.path))).toEqual([join(test.queue, "fresh.json")]);
    expect(manifest.quarantinedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ originalPath: test.admissionPath, reason: expect.stringContaining("persistent snapshot failure") }),
    ]));
    expect(classifyRun(test.runRoot).status).toBe("unfinished");
  });

  it("a reached abandonment cap does not block the fresh queue scan", () => {
    const test = admitted();
    const second = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    second.queueEntries.forEach((entry: { path: string }, index: number) => { entry.path = `queue/other-${index}.json`; });
    second.queueIdentity = canonicalJsonSha256({ queue: second.queueEntries.map((entry: { path: string; contentSha256: string }) => ({ path: entry.path, sha256: entry.contentSha256 })), stack: { path: second.stack.path, sha256: second.stack.sha256 } });
    second.runId = `d-${second.queueIdentity.slice(0, 12)}`;
    mkdirSync(join(test.drainsRoot, second.runId));
    writeFileSync(join(test.drainsRoot, second.runId, "admission.json"), prettyCanonicalJson(second));
    for (const id of [test.runId, second.runId]) writeFileSync(join(test.drainsRoot, id, "envelope-1.json"), "conflict");
    writeFileSync(join(test.queue, "fresh.json"), readFileSync(join(test.root, test.sidecars[0].path)));
    const manifest = prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
    expect([test.runId, second.runId]).not.toContain(manifest.runId);
    expect(manifest.envelopes[0].queueEntries[0].path).toBe(join(test.queue, "fresh.json"));
    expect([test.runId, second.runId].filter((id) => classifyRun(join(test.drainsRoot, id)).status === "abandoned")).toHaveLength(1);
    expect(manifest.quarantinedEntries.some((entry) => entry.reason.includes("Abandonment cap reached"))).toBe(true);
  });

  it("an unreadable abandoned sidecar cannot reserve queued paths in a later invocation", () => {
    const test = admitted();
    const sidecarBytes = test.sidecars.map(({ path }) => readFileSync(join(test.root, path)));
    writeFileSync(join(test.runRoot, "envelope-1.json"), "conflict");
    const input = { repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies };
    expect(() => prepareIntakeDrain(input)).toThrow();
    const receipt = JSON.parse(readFileSync(`${classifyRun(test.runRoot).runDir}.abandoned.json`, "utf8"));
    unlinkSync(resolve(test.root, receipt.sidecars[0].quarantinedPath));
    test.sidecars.forEach(({ path }, index) => writeFileSync(join(test.root, path), Buffer.concat([sidecarBytes[index], Buffer.from("\n")])));
    const manifest = prepareIntakeDrain(input);
    expect(manifest.envelopes.flatMap((entry) => entry.queueEntries.map((queue) => queue.path)))
      .toEqual(test.sidecars.map(({ path }) => resolve(test.root, path)));
    expect(manifest.envelopes.map(({ candidatePath }) => JSON.parse(readFileSync(candidatePath, "utf8")))).toEqual(test.expected);
    expect(classifyRun(test.runRoot).status).toBe("abandoned");
  });

  it("unreadable attempt details do not refuse healthy recovery", () => {
    const test = admitted();
    prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
    unlinkSync(join(test.runRoot, "manifest.json"));
    const result = cli(test, "attempts-unreadable");
    expect(result.status, result.stderr).toBe(0);
    expect(attemptMarkers(test.runRoot)).toHaveLength(3);
    expect(result.stderr).toContain("attempts denied");
    expect(existsSync(join(test.runRoot, "attempts.json"))).toBe(false);
    expect(classifyRun(test.runRoot).status).toBe("finished");
  });

  it.each(["ordered", "directory-open-unsupported", "directory-fsync-unsupported", "temp-fsync-failure", "directory-fsync-failure"])(
    "atomic publication fsync ordering and failure handling: %s", (mode) => {
    const test = fixture();
    const preload = join(test.root, "fsync.cjs");
    writeFileSync(preload, `
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
const events = [];
const descriptors = new Map();
const open = fs.openSync;
const rename = fs.renameSync;
fs.openSync = function(path, ...args) {
  if (String(path) === ${JSON.stringify(test.runRoot)}) {
    if (${JSON.stringify(mode)} === 'directory-open-unsupported') throw Object.assign(new Error('directory open unsupported'), { code: 'EISDIR' });
    descriptors.set(987654, 'dir'); return 987654;
  }
  const fd = open.call(this, path, ...args);
  if (String(path).includes('.tmp-') && String(path).endsWith('atomic.json')) descriptors.set(fd, 'temp');
  return fd;
};
const close = fs.closeSync;
fs.closeSync = function(fd) { descriptors.delete(fd); if (fd !== 987654) return close.call(this, fd); };
fs.fsyncSync = function(fd) {
  const kind = descriptors.get(fd);
  events.push(kind);
  if (${JSON.stringify(mode)} === 'directory-fsync-unsupported' && kind === 'dir') throw Object.assign(new Error('directory fsync unsupported'), { code: 'EINVAL' });
  if (${JSON.stringify(mode)} === 'temp-fsync-failure' && kind === 'temp') throw Object.assign(new Error('temp fsync failed'), { code: 'EIO' });
  if (${JSON.stringify(mode)} === 'directory-fsync-failure' && kind === 'dir') throw Object.assign(new Error('directory fsync failed'), { code: 'EIO' });
};
fs.renameSync = function(...args) { events.push('rename'); return rename.apply(this, args); };
syncBuiltinESMExports();
process.on('exit', () => console.log(JSON.stringify(events)));
`);
    const modulePath = join(repoRoot, "scripts/lib/github-issue-roadmap/intake-drain-admission.ts");
    const result = spawnSync(process.execPath, ["--require", preload, "--require", createRequire(import.meta.url).resolve("tsx/cjs"), "-e",
      `const { atomicDrainWrite } = require(${JSON.stringify(modulePath)}); atomicDrainWrite(${JSON.stringify(join(test.runRoot, "atomic.json"))}, '{}');`,
    ], { encoding: "utf8", timeout: 30_000 });
    expect(result.error).toBeUndefined();
    const failed = mode.endsWith("-failure");
    expect(result.status, result.stderr).toBe(failed ? 1 : 0);
    if (failed) expect(result.stderr).toContain(mode === "temp-fsync-failure" ? "temp fsync failed" : "directory fsync failed");
    expect(JSON.parse(result.stdout.trim())).toEqual(mode === "temp-fsync-failure" ? ["temp"]
      : mode === "directory-open-unsupported" ? ["temp", "rename"] : ["temp", "rename", "dir"]);
    expect(existsSync(join(test.runRoot, "atomic.json"))).toBe(mode !== "temp-fsync-failure");
    expect(readdirSync(test.runRoot).some((name) => name.startsWith(".tmp-"))).toBe(false);
  });

  it.each(["admission", "manifest"] as const)("a torn %s write never publishes its final pathname", (kind) => {
    const test = kind === "admission" ? fixture() : admitted();
    if (kind === "manifest") {
      prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
      unlinkSync(join(test.runRoot, "manifest.json"));
    }
    const result = cli(test, kind === "admission" ? "torn-admission" : "torn-manifest");
    expect(result.error).toBeUndefined();
    expect(result.stderr).toContain("simulated ENOSPC");
    expect(existsSync(join(test.runRoot, `${kind}.json`))).toBe(false);
  }, 30_000);

  it("process exits before and after receipt publication preserve the abandonment commit boundary", () => {
    for (const mode of ["quarantine-crash", "receipt-committed-crash"] as const) {
      const test = admitted();
      const bytes = readFileSync(test.admissionPath);
      writeFileSync(join(test.runRoot, "envelope-1.json"), "conflict");
      const first = cli(test, mode);
      expect(first.error).toBeUndefined();
      expect(first.status).toBe(87);
      expect(readFileSync(test.admissionPath)).toEqual(bytes);
      expect(classifyRun(test.runRoot).status).toBe(mode === "quarantine-crash" ? "unfinished" : "abandoned");
      const second = cli(test, "normal");
      expect(second.error).toBeUndefined();
      expect(classifyRun(test.runRoot).status === "abandoned").toBe(true);
      expect(listIntakeHolds({ repoRoot: test.root })[0].reason).toContain("Existing drain artifact differs");
    }
  }, 30_000);

  it("ignores stray root files and inventories a quarantine committed without any receipt", () => {
    const test = admitted();
    const bytes = readFileSync(test.admissionPath);
    const quarantineRoot = `${test.runRoot}.quarantine`;
    renameSync(test.runRoot, quarantineRoot);
    writeFileSync(join(test.drainsRoot, "stray.json"), "{torn non-run");
    writeFileSync(`${quarantineRoot}.abandoned.json`, "{torn receipt");
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({ status: "available", runs: [
      { runId: test.runId, runDir: quarantineRoot, status: "abandoned" },
    ] });
    expect(readFileSync(join(quarantineRoot, "admission.json"))).toEqual(bytes);
    expect(cli(test, "normal", true).status).toBe(0);
  }, 30_000);

  it("a stray non-directory entry does not turn healthy preparation into a corrupt-run exit", () => {
    const test = admitted();
    prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
    unlinkSync(join(test.runRoot, "manifest.json"));
    writeFileSync(join(test.drainsRoot, "stray.json"), "{torn non-run");
    const result = cli(test, "normal");
    expect(result.status, result.stderr).toBe(0);
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({ status: "available", runs: [
      { runId: test.runId, status: "finished" },
    ] });
  }, 30_000);

  it("reads legacy in-quarantine receipts and their sidecar locations", () => {
    const test = admitted();
    const quarantineRoot = `${test.runRoot}.quarantine`;
    renameSync(test.runRoot, quarantineRoot);
    const local = (path: string) => path.slice(test.root.length + 1).replace(/\\/g, "/");
    const reasonPath = join(quarantineRoot, "admission.json.reason.txt");
    writeFileSync(reasonPath, "legacy failure\n");
    const receipt = { runId: test.runId, originalPath: local(test.admissionPath),
      quarantinedPath: local(join(quarantineRoot, "admission.json")), reasonPath: local(reasonPath),
      reason: "legacy failure", sidecars: [{ originalPath: test.sidecars[0].path,
        quarantinedPath: local(join(quarantineRoot, "sidecars/0.json")) }] };
    writeFileSync(join(quarantineRoot, "abandoned.json"), prettyCanonicalJson(receipt));
    expect(classifyRun(test.runRoot)).toMatchObject({ status: "abandoned", receipt, reason: "legacy failure\n" });
  });

  it("preserves an occupied quarantine and commits the current run under a unique suffix", () => {
    const test = admitted();
    const bytes = readFileSync(test.admissionPath);
    const previous = `${test.runRoot}.quarantine`;
    mkdirSync(previous);
    writeFileSync(join(previous, "admission.json"), bytes);
    writeFileSync(join(previous, "preserve.txt"), "previous quarantine");
    writeFileSync(join(test.runRoot, "envelope-1.json"), "conflict");
    expect(() => prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies })).toThrow();
    expect(existsSync(test.runRoot)).toBe(false);
    expect(readFileSync(join(previous, "preserve.txt"), "utf8")).toBe("previous quarantine");
    const inventory = readIntakeRuns(test.drainsRoot);
    expect(inventory).toMatchObject({ status: "available", runs: [
      { runId: test.runId, status: "abandoned" }, { runId: test.runId, status: "abandoned" },
    ] });
    if (inventory.status !== "available") throw new Error("Expected available inventory");
    for (const run of inventory.runs) expect(readFileSync(join(run.runDir, "admission.json"))).toEqual(bytes);
    expect(inventory.runs.some((run) => run.runDir.startsWith(`${previous}-`))).toBe(true);
  });

  it("a corrupt run is isolated while another admitted run finishes and remains listed", () => {
    const test = admitted();
    const bad = join(test.drainsRoot, "bad");
    mkdirSync(bad);
    writeFileSync(join(bad, "admission.json"), "{truncated");
    const manifest = prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
    expect(manifest.runId).toBe(test.runId);
    expect(manifest.quarantinedEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({ originalPath: bad, reason: expect.stringContaining("Corrupt intake run bad") }),
    ]));
    expect(listIntakeHolds({ repoRoot: test.root }).map((hold) => hold.runId)).toContain("bad");
  });

  it.each(["partial copy", "differing reason"])("preserves admitted material despite obsolete quarantine artifacts: %s", (fault) => {
    const test = admitted();
    const admissionBytes = readFileSync(test.admissionPath);
    writeFileSync(join(test.runRoot, "envelope-1.json"), "conflict");
    mkdirSync(join(test.runRoot, "quarantine"));
    writeFileSync(join(test.runRoot, "quarantine/admission.json"), fault === "partial copy" ? "{partial" : admissionBytes);
    if (fault === "differing reason") writeFileSync(join(test.runRoot, "quarantine/admission.json.reason.txt"), "a previous error with unstable text");
    try { prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies }); } catch { /* no fresh work */ }
    expect(classifyRun(test.runRoot).status === "abandoned").toBe(true);
    expect(readFileSync(join(classifyRun(test.runRoot).runDir, "admission.json"))).toEqual(admissionBytes);
    expect(existsSync(test.admissionPath)).toBe(false);
    const holds = listIntakeHolds({ repoRoot: test.root });
    expect(holds).toHaveLength(1);
    expect(holds[0].reason).toContain("Existing drain artifact differs");
    expect(holds[0].quarantinedSidecarPaths).toHaveLength(test.sidecars.length);
  });

  it("spawn ENOENT from authorRequest preserves every unfinished admission", () => {
    const test = admitted();
    const second = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    second.queueEntries.forEach((entry: { path: string }, index: number) => { entry.path = `queue/other-${index}.json`; });
    second.queueIdentity = canonicalJsonSha256({ queue: second.queueEntries.map((entry: { path: string; contentSha256: string }) => ({ path: entry.path, sha256: entry.contentSha256 })), stack: { path: second.stack.path, sha256: second.stack.sha256 } });
    second.runId = `d-${second.queueIdentity.slice(0, 12)}`;
    mkdirSync(join(test.drainsRoot, second.runId));
    writeFileSync(join(test.drainsRoot, second.runId, "admission.json"), prettyCanonicalJson(second));
    const authorRequest = vi.fn(() => { throw Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }); });
    expect(() => prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies: { ...dependencies, authorRequest } })).toThrow("spawn gh ENOENT");
    expect(authorRequest).toHaveBeenCalledTimes(2);
    for (const runId of [test.runId, second.runId]) expect(existsSync(join(test.drainsRoot, runId, "abandoned.json"))).toBe(false);
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({
      status: "available", runs: [{ status: "unfinished" }, { status: "unfinished" }],
    });
  });

  it("deterministic terminal failures abandon at most one admission per invocation", () => {
    const test = admitted();
    const second = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    second.queueEntries.forEach((entry: { path: string }, index: number) => { entry.path = `queue/other-${index}.json`; });
    second.queueIdentity = canonicalJsonSha256({ queue: second.queueEntries.map((entry: { path: string; contentSha256: string }) => ({ path: entry.path, sha256: entry.contentSha256 })), stack: { path: second.stack.path, sha256: second.stack.sha256 } });
    second.runId = `d-${second.queueIdentity.slice(0, 12)}`;
    mkdirSync(join(test.drainsRoot, second.runId));
    writeFileSync(join(test.drainsRoot, second.runId, "admission.json"), prettyCanonicalJson(second));
    for (const runId of [test.runId, second.runId]) writeFileSync(join(test.drainsRoot, runId, "envelope-1.json"), "deterministic conflict");
    const input = { repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies };
    try { prepareIntakeDrain(input); } catch { /* no fresh work */ }
    expect([test.runId, second.runId].filter((id) => classifyRun(join(test.drainsRoot, id)).status === "abandoned")).toHaveLength(1);
    try { prepareIntakeDrain(input); } catch { /* no fresh work */ }
    expect([test.runId, second.runId].filter((id) => classifyRun(join(test.drainsRoot, id)).status === "abandoned")).toHaveLength(2);
  });

  it("persistent EACCES escalates after five attempts with a visible report", () => {
    const test = admitted(); // first attempt already failed at capture
    const input = { repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json",
      dependencies: { ...dependencies, authorRequest: () => { throw Object.assign(new Error("persistent access denied"), { code: "EACCES" }); } } };
    for (let attempt = 2; attempt <= 5; attempt += 1) {
      try { prepareIntakeDrain(input); } catch { /* no fresh work */ }
      expect(classifyRun(test.runRoot).status === "abandoned").toBe(attempt === 5);
    }
    expect(listIntakeHolds({ repoRoot: test.root })[0].reason).toContain("retry bound reached");
  });

  it("refuses a self-consistent admission naming another repository before external work", () => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    raw.repository.organization = "attacker";
    raw.repository.name = "target";
    raw.envelopes.forEach((entry: { envelope: { repository: unknown } }) => { entry.envelope.repository = raw.repository; });
    writeFileSync(test.admissionPath, prettyCanonicalJson(raw));
    test.sidecars.forEach(({ path }) => unlinkSync(join(test.root, path)));
    const captureSnapshots = vi.fn(dependencies.captureSnapshots);
    const authorRequest = vi.fn(dependencies.authorRequest);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies: { ...dependencies, captureSnapshots, authorRequest } })).toThrow();
      expect(captureSnapshots).not.toHaveBeenCalled();
      expect(authorRequest).not.toHaveBeenCalled();
      expect(errors.mock.calls.flat().join("\n")).toContain("configured target");
    } finally { errors.mockRestore(); }
  });

  it("never sweeps a crafted queue path outside the configured queue", () => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    const protectedPath = join(test.root, "tracked.json");
    const bytes = readFileSync(join(test.root, test.sidecars[0].path));
    writeFileSync(protectedPath, bytes);
    raw.queueEntries[0].path = "tracked.json";
    raw.queueIdentity = canonicalJsonSha256({ queue: raw.queueEntries.map((entry: { path: string; contentSha256: string }) => ({ path: entry.path, sha256: entry.contentSha256 })), stack: { path: raw.stack.path, sha256: raw.stack.sha256 } });
    raw.runId = `d-${raw.queueIdentity.slice(0, 12)}`;
    const craftedRoot = join(test.drainsRoot, raw.runId);
    renameSync(test.runRoot, craftedRoot);
    writeFileSync(join(craftedRoot, "admission.json"), prettyCanonicalJson(raw));
    writeFileSync(join(craftedRoot, "envelope-1.json"), "conflict");
    test.sidecars.forEach(({ path }) => unlinkSync(join(test.root, path)));
    try { prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies }); } catch { /* no valid work */ }
    expect(readFileSync(protectedPath)).toEqual(bytes);
    expect(existsSync(join(craftedRoot, "abandoned.json"))).toBe(false);
  });

  it("reports replacement sidecar divergence while resuming the admitted material", () => {
    const test = admitted();
    const path = join(test.root, test.sidecars[0].path);
    writeFileSync(path, "producer replacement");
    const manifest = prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
    expect(manifest.sidecarDivergences).toEqual([{ path, admittedSha256: test.sidecars[0].sha256, currentSha256: hash("producer replacement") }]);
    expect(JSON.parse(readFileSync(manifest.envelopes[0].candidatePath, "utf8"))).toEqual(test.expected[0]);
    expect(readFileSync(path, "utf8")).toBe("producer replacement");
  });

  it.each(["admission.json", "manifest.json"])("classifies pre-existing truncated %s as corrupt", (name) => {
    const test = admitted();
    writeFileSync(join(test.runRoot, name), "{torn");
    expect(classifyRun(test.runRoot)).toMatchObject({ status: "corrupt" });
    expect(listIntakeHolds({ repoRoot: test.root })[0].reason).toContain("corrupt run");
  });

  it.each(["changed", "deleted"])("resumes the admitted bytes when the assessment stack is %s", (change) => {
    const test = admitted();
    if (change === "changed") writeFileSync(join(test.root, "stack.json"), "changed stack\n");
    else unlinkSync(join(test.root, "stack.json"));
    test.sidecars.forEach(({ path }) => unlinkSync(join(test.root, path)));
    const authorRequest = vi.fn((input: Parameters<IntakeDrainDependencies["authorRequest"]>[0]) => {
      expect(readFileSync(input.stackPath, "utf8")).toBe("{}\n");
      return dependencies.authorRequest(input);
    });
    const manifest = prepareIntakeDrain({
      repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json",
      dependencies: { ...dependencies, authorRequest },
    });
    expect(manifest.runId).toBe(test.runId);
    expect(manifest.envelopes.map(({ candidatePath }) => JSON.parse(readFileSync(candidatePath, "utf8")))).toEqual(test.expected);
    expect(authorRequest).toHaveBeenCalledTimes(2);
  });

  it("quarantines an unresumable admission and drains an unrelated candidate in the same configured queue", () => {
    const test = admitted();
    const bytes = readFileSync(test.admissionPath);
    const badPath = join(test.runRoot, "envelope-1.json");
    writeFileSync(badPath, "corrupt retained envelope\n");
    const queue = test.queue;
    writeFileSync(join(queue, "fresh.json"), readFileSync(join(test.root, test.sidecars[0].path)));
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const input = { repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies };
      const manifest = prepareIntakeDrain(input);
      expect(manifest.runId).not.toBe(test.runId);
      const reason = `Existing drain artifact differs: ${badPath}`;
      expect(stderr.mock.calls.flat().join("\n")).toContain(`Abandoned intake admission ${test.runId}: ${reason}`);
      const abandoned = JSON.parse(readFileSync(`${classifyRun(test.runRoot).runDir}.abandoned.json`, "utf8"));
      expect(abandoned).toMatchObject({ runId: test.runId, reason });
      expect(readFileSync(resolve(test.root, abandoned.quarantinedPath))).toEqual(bytes);
      expect(readFileSync(resolve(test.root, abandoned.reasonPath), "utf8")).toContain(reason);
      expect(readFileSync(join(classifyRun(test.runRoot).runDir, "admission.json"))).toEqual(bytes);
      expect(readIntakeRuns(test.drainsRoot)).toMatchObject({
        status: "available", runs: expect.not.arrayContaining([expect.objectContaining({ status: "unfinished" })]),
      });
      expect(prepareIntakeDrain(input)).toEqual(manifest);
      expect(JSON.parse(readFileSync(join(test.drainsRoot, manifest.runId, "manifest.json"), "utf8")).quarantinedEntries).toEqual(manifest.quarantinedEntries);
      expect(listIntakeHolds({ repoRoot: test.root }).find((hold) => hold.runId === test.runId)?.reason).toContain(reason);
    } finally { stderr.mockRestore(); }
  });

  it("keeps a transient unavailable inventory fatal without quarantining admitted work", () => {
    const test = admitted();
    const before = readdirSync(test.runRoot);
    const result = cli(test, "unreadable");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Intake admission inventory unavailable: unreadable");
    expect(readdirSync(test.runRoot)).toEqual(before);
    expect(existsSync(join(test.queue, "quarantine"))).toBe(false);
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({ status: "available", runs: [{ runId: test.runId, status: "unfinished" }] });
  }, 60_000);

  it.each(["snapshot", "authored request", "directory"])("quarantines a permanently invalid downstream %s", (kind) => {
    const test = admitted();
    if (kind === "snapshot") writeFileSync(join(test.runRoot, "intake-snapshot.json"), "{invalid");
    if (kind === "authored request") writeFileSync(join(test.runRoot, "envelope-1-authored-request.json"), "{}");
    if (kind === "directory") {
      unlinkSync(join(test.runRoot, "envelope-1.json"));
      mkdirSync(join(test.runRoot, "envelope-1.json"));
    }
    const queue = test.queue;
    writeFileSync(join(queue, "fresh.json"), readFileSync(join(test.root, test.sidecars[0].path)));
    const manifest = prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies });
    expect(manifest.runId).not.toBe(test.runId);
    const abandoned = JSON.parse(readFileSync(`${classifyRun(test.runRoot).runDir}.abandoned.json`, "utf8"));
    expect(abandoned.reason).toContain(kind === "snapshot" ? "is unparseable" : kind === "authored request" ? "unsupported schema" : "EISDIR");
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({
      status: "available", runs: expect.not.arrayContaining([expect.objectContaining({ status: "unfinished" })]),
    });
  });

  it("keeps local access errors and snapshot capture failures retryable", () => {
    const test = admitted();
    const result = cli(test, "artifact-unreadable");
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("artifact denied");
    expect(classifyRun(test.runRoot).status === "abandoned").toBe(false);
    expect(() => prepareIntakeDrain({
      repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json",
      dependencies: { ...dependencies, captureSnapshots: () => { throw new Error("temporary census failure"); } },
    })).toThrow("temporary census failure");
    expect(classifyRun(test.runRoot).status === "abandoned").toBe(false);
    expect(prepareIntakeDrain({ repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies }).runId).toBe(test.runId);
  }, 60_000);

  it.each(["unchanged", "changed", "deleted"])("handles a legacy v1 admission with a %s stack", (change) => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    raw.schema = "github-issue-roadmap-intake-drain-admission/v1";
    delete raw.stack.contentBase64;
    writeFileSync(test.admissionPath, prettyCanonicalJson(raw));
    const bytes = readFileSync(test.admissionPath);
    const queue = test.queue;
    writeFileSync(join(queue, "fresh.json"), readFileSync(join(test.root, test.sidecars[0].path)));
    if (change === "changed") writeFileSync(join(test.root, "stack.json"), "changed\n");
    if (change === "deleted") unlinkSync(join(test.root, "stack.json"));
    const input = { repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies };
    if (change === "deleted") {
      expect(() => prepareIntakeDrain(input)).toThrow("Assessment stack is missing");
      expect(classifyRun(test.runRoot).status === "abandoned").toBe(true);
      expect(readFileSync(join(classifyRun(test.runRoot).runDir, "admission.json"))).toEqual(bytes);
      return;
    }
    const manifest = prepareIntakeDrain(input);
    if (change === "unchanged") expect(manifest.runId).toBe(test.runId);
    else {
      expect(manifest.runId).not.toBe(test.runId);
      expect(classifyRun(test.runRoot).status === "abandoned").toBe(true);
    }
    expect(readFileSync(join(classifyRun(test.runRoot).runDir, "admission.json"))).toEqual(bytes);
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({
      status: "available", runs: expect.not.arrayContaining([expect.objectContaining({ status: "unfinished" })]),
    });
  });

  it("verifies retained content against its hash before authoring and quarantines tampering", () => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    raw.stack.contentBase64 = Buffer.from("tampered\n").toString("base64");
    writeFileSync(test.admissionPath, prettyCanonicalJson(raw));
    const queue = test.queue;
    writeFileSync(join(queue, "fresh.json"), readFileSync(join(test.root, test.sidecars[0].path)));
    const authorRequest = vi.fn(dependencies.authorRequest);
    const manifest = prepareIntakeDrain({
      repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json",
      dependencies: { ...dependencies, authorRequest },
    });
    expect(manifest.runId).not.toBe(test.runId);
    expect(authorRequest).toHaveBeenCalledTimes(1); // Only the fresh queue's envelope.
    expect(JSON.parse(readFileSync(`${classifyRun(test.runRoot).runDir}.abandoned.json`, "utf8")).reason)
      .toBe("Admitted assessment stack content disagrees with its retained hash.");
  });

  it.each(["first", "last"])("quarantines the sick admission sorted %s and resumes healthy work without scanning the queue", (order) => {
    const test = admitted();
    const second = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    // Aggregate outcomes must include the sick run even when healthy work sorts first.
    for (let index = 0; ; index += 1) {
      second.queueEntries.forEach((entry: { path: string }, queueIndex: number) => { entry.path = `queue/other-${index}-${queueIndex}.json`; });
      second.queueIdentity = canonicalJsonSha256({
        queue: second.queueEntries.map((entry: { path: string; contentSha256: string }) => ({ path: entry.path, sha256: entry.contentSha256 })), stack: { path: second.stack.path, sha256: second.stack.sha256 },
      });
      second.runId = `d-${second.queueIdentity.slice(0, 12)}`;
      if (order === "first" ? second.runId.localeCompare(test.runId) > 0 : second.runId.localeCompare(test.runId) < 0) break;
    }
    const secondRoot = join(test.drainsRoot, second.runId);
    mkdirSync(secondRoot);
    writeFileSync(join(secondRoot, "admission.json"), prettyCanonicalJson(second));
    writeFileSync(join(test.runRoot, "envelope-1.json"), "corrupt\n");
    const manifest = prepareIntakeDrain({
      repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies,
      readQueueFile: () => { throw new Error("QUEUE_READ"); },
    });
    expect(manifest.runId).toBe(second.runId);
    expect(manifest.envelopes.map(({ candidatePath }) => JSON.parse(readFileSync(candidatePath, "utf8")))).toEqual(test.expected);
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({
      status: "available", runs: expect.not.arrayContaining([expect.objectContaining({ status: "unfinished" })]),
    });
  });

  it("actual prepare CLI reconstructs the same ordered envelopes and run identity from admission alone after sidecar deletion", () => {
    const test = fixture();
    const interrupted = cli(test, "interrupt");
    expect(interrupted.error).toBeUndefined();
    expect(interrupted.status, interrupted.stderr).toBe(86);
    expect(existsSync(test.admissionPath)).toBe(true);
    expect(readdirSync(test.runRoot).filter((name) => !attemptMarkers(test.runRoot).includes(name))).toEqual(["admission.json"]);
    expect(attemptMarkers(test.runRoot)).toHaveLength(1);
    const bytes = readFileSync(test.admissionPath);
    const mtime = statSync(test.admissionPath).mtimeMs;
    const record = JSON.parse(bytes.toString());
    expect(record.runId).toBe(test.runId);
    expect(record.schema).toBe(INTAKE_DRAIN_ADMISSION_SCHEMA);
    expect(record.envelopes.map((entry: { envelope: unknown }) => createOutcomeEnvelope(entry.envelope))).toEqual(test.expected);
    expect(record.envelopes[0].envelope.candidates[0]).not.toHaveProperty("sourceFingerprint");
    expect(record.envelopes[0].envelope.candidates[0]).not.toHaveProperty("emissionContentSha256");
    test.sidecars.forEach(({ path }) => unlinkSync(join(test.root, path)));
    expect(readdirSync(test.queue)).toEqual([]);
    expect(readdirSync(join(test.root, "artifacts/github-issue-roadmap"))).toEqual(["drains"]);

    const resumed = cli(test, "reconstruct");
    expect(resumed.error).toBeUndefined();
    expect(resumed.status).toBe(1);
    expect(resumed.stderr).toContain("TEST_EXTERNAL_SNAPSHOT_BOUNDARY");
    // Failed recovery now yields to the fresh queue, after reconstructing retained work.
    expect(resumed.stderr).toContain("QUEUE_SCANNED");
    expect(resumed.stderr.indexOf("QUEUE_SCANNED")).toBeGreaterThan(resumed.stderr.indexOf("TEST_EXTERNAL_SNAPSHOT_BOUNDARY"));
    expect(resumed.stderr).not.toContain("REGISTRY_READ");
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({ status: "available", runs: [{ runId: test.runId }] });
    expect(test.expected.map((_, index) => JSON.parse(readFileSync(join(test.runRoot, `envelope-${index + 1}.json`), "utf8")))).toEqual(test.expected);
    expect(readFileSync(test.admissionPath)).toEqual(bytes);
    expect(statSync(test.admissionPath).mtimeMs).toBe(mtime);

    // Supply only downstream snapshot/authoring responses, after proving reconstruction.
    // These fixtures contain no candidate material and no original queue sidecar.
    writeFileSync(join(test.runRoot, "canonical-snapshot.json"), "{}\n");
    writeFileSync(join(test.runRoot, "intake-snapshot.json"), intakeSnapshotJson(stackSnapshot(test.expected[0], censusPass())));
    test.expected.forEach((_, index) => {
      const exchangeRoot = join(test.runRoot, `exchange-${index + 1}`);
      writeFileSync(join(test.runRoot, `envelope-${index + 1}-authored-request.json`), prettyCanonicalJson({
        schemaVersion: "github-issue-roadmap-intake-drain-authored-request/v1",
        bundlePath: join(exchangeRoot, "bundle"), assessmentTarget: join(exchangeRoot, "assessment.json"),
      }));
    });
    const completed = cli(test, "normal");
    expect(completed.error).toBeUndefined();
    expect(completed.status, completed.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(test.runRoot, "manifest.json"), "utf8"));
    expect(manifest.runId).toBe(test.runId);
    expect(manifest.envelopes.map((entry: { candidatePath: string }) => JSON.parse(readFileSync(entry.candidatePath, "utf8")))).toEqual(test.expected);
    expect(readFileSync(test.admissionPath)).toEqual(bytes);
    expect(statSync(test.admissionPath).mtimeMs).toBe(mtime);
  }, 60_000);

  it("does not attempt to rewrite admission on unfinished or completed retries", () => {
    const test = admitted();
    // An additive field also makes a rewrite through writeImmutableJson fail on content mismatch.
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    raw.futureField = { retained: true };
    writeFileSync(test.admissionPath, JSON.stringify(raw));
    const bytes = readFileSync(test.admissionPath);
    const mtime = statSync(test.admissionPath).mtimeMs;
    const input = { repoRoot: test.root, queueDirectory: "queue", stackPath: "stack.json", dependencies };
    const first = prepareIntakeDrain(input);
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({
      status: "available", runs: expect.not.arrayContaining([expect.objectContaining({ status: "unfinished" })]),
    });
    expect(prepareIntakeDrain(input)).toEqual(first);
    expect(readFileSync(test.admissionPath)).toEqual(bytes);
    expect(statSync(test.admissionPath).mtimeMs).toBe(mtime);
  });

  it("accepts unknown fields at the admission, envelope, and candidate levels", () => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    raw.future = true;
    raw.envelopes[0].envelope.future = true;
    raw.envelopes[0].envelope.candidates[0].outcome.future = true;
    writeFileSync(test.admissionPath, JSON.stringify(raw));
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({ status: "available", runs: [{ runId: test.runId, status: "unfinished" }] });
  });

  it("preserves a v2 Start command and its emission hash when classifying a retained admission", () => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    const material = raw.envelopes[0].envelope;
    const expected = createOutcomeEnvelope({
      ...material,
      schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
      candidates: material.candidates.map((candidate: object, index: number) => ({
        ...candidate, ...(index === 0 ? { startCommand: "ce-debug" } : {}),
      })),
    });
    raw.envelopes[0].envelope = expected;
    writeFileSync(test.admissionPath, JSON.stringify(raw));

    const run = classifyRun(test.runRoot);
    expect(run.status).toBe("unfinished");
    if (run.status !== "unfinished") throw new Error("Expected an unfinished run");
    const restored = createOutcomeEnvelope(run.admission.envelopes[0].envelope);
    expect(restored.candidates[0].startCommand).toBe("ce-debug");
    expect(restored.candidates[0].emissionContentSha256).toBe(expected.candidates[0].emissionContentSha256);
  });

  it("preserves v2 criteria and their emission hash when classifying a retained admission", () => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    const material = raw.envelopes[0].envelope;
    const acceptanceCriteria = ["The drain keeps this criterion"];
    const expected = createOutcomeEnvelope({
      ...material,
      schemaVersion: OUTCOME_ENVELOPE_SCHEMA_VERSION_V2,
      candidates: material.candidates.map((candidate: object, index: number) => ({
        ...candidate, ...(index === 0 ? { acceptanceCriteria } : {}),
      })),
    });
    raw.envelopes[0].envelope = expected;
    writeFileSync(test.admissionPath, JSON.stringify(raw));

    const run = classifyRun(test.runRoot);
    expect(run.status).toBe("unfinished");
    if (run.status !== "unfinished") throw new Error("Expected an unfinished run");
    const restored = createOutcomeEnvelope(run.admission.envelopes[0].envelope);
    expect(restored.candidates[0].acceptanceCriteria).toEqual(acceptanceCriteria);
    expect(restored.candidates[0].emissionContentSha256).toBe(expected.candidates[0].emissionContentSha256);
  });

  it.each([
    ["wrong schema", "unsupported_schema", /"path":\s*\[\s*"schema"\s*\]/],
    ["truncated", "invalid", /JSON/i],
    ["missing material", "invalid", /readiness/],
    ["wrong identity", "invalid", /Admission run identity disagrees/],
  ] as const)("distinguishes %s as %s", (kind, _legacyReason, reasonPattern) => {
    const test = admitted();
    const raw = JSON.parse(readFileSync(test.admissionPath, "utf8"));
    if (kind === "wrong schema") raw.schema = "future/v2";
    if (kind === "missing material") delete raw.envelopes[0].envelope.candidates[0].readiness;
    if (kind === "wrong identity") raw.queueIdentity = "a".repeat(64);
    writeFileSync(test.admissionPath, kind === "truncated" ? "{\"schema\":" : JSON.stringify(raw));
    const run = classifyRun(test.runRoot);
    expect(run).toMatchObject({ status: "corrupt", reason: expect.stringMatching(reasonPattern) });
    if (run.status !== "corrupt") throw new Error("Expected a corrupt run");
    if (kind === "wrong schema") expect(run.reason).not.toMatch(/JSON/i);
    if (kind === "truncated") expect(run.reason).not.toContain('"path"');
    expect(readIntakeRuns(test.drainsRoot)).toEqual({ status: "available", runs: [run] });
    expect(listIntakeHolds({ repoRoot: test.root })[0].reason).toContain("corrupt run");
  });

  it("reports an absent drains root as unavailable/absent and both CLIs exit 1", () => {
    const test = fixture();
    const absent = join(test.root, "absent");
    expect(readIntakeRuns(absent)).toEqual({ status: "unavailable", runs: null, reason: "absent" });
    const cliTest = { ...test, root: mkdtempSync(join(tmpdir(), "drain-absent-")) };
    for (const holds of [false, true]) {
      const result = cli(cliTest, "normal", holds);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unavailable: absent");
    }
  }, 60_000);

  it("reports EACCES on the drains root as unavailable/unreadable and both CLIs exit 1", () => {
    const test = fixture();
    expect(readIntakeRuns(join(test.root, "stack.json"))).toEqual({ status: "unavailable", runs: null, reason: "unreadable" });
    for (const holds of [false, true]) {
      const result = cli(test, "unreadable", holds);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("unavailable: unreadable");
      expect(result.stderr).not.toContain("unavailable: absent");
    }
  }, 60_000);

  it("lists pre-format runs as empty or corrupt, never unfinished, without breaking the inventory", () => {
    const test = fixture();
    mkdirSync(join(test.drainsRoot, "empty"));
    mkdirSync(join(test.drainsRoot, "legacy"));
    writeFileSync(join(test.drainsRoot, "legacy/manifest.json"), "{old or incomplete");
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({
      status: "available", runs: [
        { runId: "empty", status: "empty" },
        { runId: "legacy", status: "corrupt", reason: expect.stringMatching(/JSON/i) },
      ],
    });
  });

  it("holds uses the same inventory and surfaces unfinished preparation", () => {
    const test = admitted();
    expect(readIntakeRuns(test.drainsRoot)).toMatchObject({ status: "available", runs: [{ runId: test.runId, status: "unfinished" }] });
    expect(listIntakeHolds({ repoRoot: test.root })).toMatchObject([{ runId: test.runId, reason: "preparation in progress" }]);
  });
});
