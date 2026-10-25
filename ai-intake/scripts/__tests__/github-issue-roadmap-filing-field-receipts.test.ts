import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { prettyCanonicalJson } from "../lib/github-issue-roadmap/canonical-json";
import {
  buildFilingFieldReceipts,
  FILING_FIELD_RECEIPTS_SCHEMA,
  parseFilingFieldReceipts,
} from "../lib/github-issue-roadmap/filing-field-receipts";

const repository = "example-org/example-repo";
const generatedAt = "2026-10-06T12:01:00.000Z";
const receipt = {
  field: "Priority",
  value: "P2",
  eventId: "IFAE_priority",
  eventCreatedAt: "2026-10-06T12:00:01Z",
  writeStartedAt: "2026-10-06T12:00:00.000Z",
  readBackAt: "2026-10-06T12:00:03.000Z",
};

function complete(overrides: Record<string, unknown> = {}) {
  return {
    event: "complete",
    repository,
    issueNumber: 42,
    sourceFingerprint: "source-42",
    decisionContentSha256: "a".repeat(64),
    appliedAt: generatedAt,
    fieldReceipts: [receipt],
    ...overrides,
  };
}

function build(records: readonly unknown[]) {
  return buildFilingFieldReceipts(records, { repository, generatedAt });
}

const tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("filing field receipt export", () => {
  it("maps only matching complete records with receipts and sorts issue, field, then event id", () => {
    const records = [
      complete({ event: "intent" }),
      complete({ fieldReceipts: undefined }),
      complete({ fieldReceipts: [
        { ...receipt, eventId: "IFAE_z" },
        { ...receipt, field: "Effort", value: "Medium", eventId: "IFCE_effort" },
        { ...receipt, eventId: "IFAE_a" },
      ] }),
      complete({ repository: "example-org/example-repo", issueNumber: 7, sourceFingerprint: "source-7",
        fieldReceipts: [{ ...receipt, eventId: "IFAE_7" }] }),
      complete({ repository: "Other/repository" }),
      complete({ event: "legacy_import" }),
      complete({ event: "created" }),
      null,
    ];
    const result = build(records);
    expect(result).toEqual({
      document: {
        schemaVersion: FILING_FIELD_RECEIPTS_SCHEMA,
        repository,
        generatedAt,
        records: [
          { ...receipt, eventId: "IFAE_7", issueNumber: 7, sourceFingerprint: "source-7" },
          { ...receipt, field: "Effort", value: "Medium", eventId: "IFCE_effort", issueNumber: 42,
            sourceFingerprint: "source-42" },
          { ...receipt, eventId: "IFAE_a", issueNumber: 42, sourceFingerprint: "source-42" },
          { ...receipt, eventId: "IFAE_z", issueNumber: 42, sourceFingerprint: "source-42" },
        ],
      },
      skippedMalformed: 0,
      droppedConflicts: 0,
    });
    expect(build([...records].reverse())).toEqual(result);
  });

  it("skips and counts malformed receipts while retaining valid siblings", () => {
    const missingEventId = Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== "eventId"));
    const result = build([complete({ fieldReceipts: [
      missingEventId, { ...receipt, field: "Horizon" }, { ...receipt, value: "" }, receipt,
    ] })]);
    expect(result.skippedMalformed).toBe(3);
    expect(result.droppedConflicts).toBe(0);
    expect(result.document.records).toEqual([{ ...receipt, issueNumber: 42, sourceFingerprint: "source-42" }]);
  });

  it.each([
    null,
    { ...receipt, eventId: " " },
    { ...receipt, value: " " },
    { ...receipt, eventCreatedAt: "invalid" },
    { ...receipt, writeStartedAt: "October 6, 2026" },
    { ...receipt, readBackAt: "2026-10-06" },
    { ...receipt, readBackAt: "2026-99-06T12:00:03Z" },
  ])("rejects malformed receipt %j without throwing", malformed => {
    expect(build([complete({ fieldReceipts: [malformed] })])).toMatchObject({
      document: { records: [] }, skippedMalformed: 1, droppedConflicts: 0,
    });
  });

  it.each([
    { issueNumber: null }, { issueNumber: 0 }, { issueNumber: 1.5 }, { sourceFingerprint: "" },
    { fieldReceipts: {} }, { fieldReceipts: null },
  ])("skips malformed complete record %j", overrides => {
    expect(build([complete(overrides)])).toMatchObject({
      document: { records: [] }, skippedMalformed: 1, droppedConflicts: 0,
    });
  });

  it("deduplicates identical events and deterministically chooses metadata for the same write", () => {
    const records = [complete(), complete(), complete({ sourceFingerprint: "another-source" })];
    const result = build(records);
    expect(result.document.records).toHaveLength(1);
    expect(result).toMatchObject({ skippedMalformed: 0, droppedConflicts: 0 });
    expect(build([...records].reverse())).toEqual(result);
  });

  it.each([
    { issueNumber: 43 },
    { fieldReceipts: [{ ...receipt, field: "Effort" }] },
    { fieldReceipts: [{ ...receipt, value: "P1" }] },
  ])("drops every copy of an event id with conflicting write identity: %j", overrides => {
    const result = build([complete(), complete(overrides), complete(), complete({
      fieldReceipts: [{ ...receipt, eventId: "IFAE_valid" }],
    })]);
    expect(result).toMatchObject({ skippedMalformed: 0, droppedConflicts: 1 });
    expect(result.document.records.map(record => record.eventId)).toEqual(["IFAE_valid"]);
  });

  it("counts distinct conflicting event ids", () => {
    expect(build([
      complete(), complete({ issueNumber: 43 }),
      complete({ fieldReceipts: [{ ...receipt, eventId: "IFAE_other" }] }),
      complete({ fieldReceipts: [{ ...receipt, eventId: "IFAE_other", value: "P1" }] }),
    ])).toMatchObject({ document: { records: [] }, skippedMalformed: 0, droppedConflicts: 2 });
  });

  it("round-trips canonical builder output through the strict consumer parser", () => {
    const { document } = build([complete()]);
    expect(parseFilingFieldReceipts(JSON.parse(prettyCanonicalJson(document)))).toEqual(document);
    expect(parseFilingFieldReceipts(build([]).document)).toEqual(build([]).document);
  });

  it("refuses missing event ids, extra keys, and the wrong schema", () => {
    const { document } = build([complete()]);
    const missingEventId = Object.fromEntries(Object.entries(document.records[0]).filter(([key]) => key !== "eventId"));
    expect(() => parseFilingFieldReceipts({ ...document, records: [missingEventId] })).toThrow();
    expect(() => parseFilingFieldReceipts({ ...document, extra: true })).toThrow();
    expect(() => parseFilingFieldReceipts({ ...document,
      records: [{ ...document.records[0], extra: true }] })).toThrow();
    expect(() => parseFilingFieldReceipts({ ...document, schemaVersion: "wrong/v1" })).toThrow();
  });

  it.each([
    { repository: "invalid" }, { generatedAt: "invalid" }, { records: {} },
    { records: [{ ...receipt, issueNumber: 0, sourceFingerprint: "source-42" }] },
    { records: [{ ...receipt, field: "Horizon", issueNumber: 42, sourceFingerprint: "source-42" }] },
    { records: [{ ...receipt, value: "", issueNumber: 42, sourceFingerprint: "source-42" }] },
    { records: [{ ...receipt, readBackAt: "invalid", issueNumber: 42, sourceFingerprint: "source-42" }] },
  ])("refuses invalid document data %j", overrides => {
    expect(() => parseFilingFieldReceipts({ ...build([]).document, ...overrides })).toThrow();
  });
});

describe("filing receipt CLI", () => {
  const script = resolve("scripts/github-issue-roadmap-filing-receipts.ts");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

  function fixture(records: readonly unknown[] = []) {
    const root = mkdtempSync(join(tmpdir(), "filing-receipts-"));
    tempDirs.push(root);
    const journalRoot = join(root, "journal");
    const journalDirectory = join(journalRoot, "example-org--example-repo");
    mkdirSync(journalDirectory, { recursive: true });
    mkdirSync(join(root, "artifacts/github-issue-roadmap"), { recursive: true });
    const journalPath = join(journalDirectory, "execution.journal.jsonl");
    const bytes = Buffer.from(records.map(record => `${JSON.stringify(record)}\n`).join(""));
    writeFileSync(journalPath, bytes);
    const run = (...args: string[]) => spawnSync(process.execPath, ["--import", loader, script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ROADMAP_INTAKE_JOURNAL_ROOT: journalRoot, GH_TOKEN: "", GITHUB_TOKEN: "" },
      timeout: 20_000,
    });
    return { root, journalPath, journalDirectory, bytes, run };
  }

  it("writes an artifact with diagnostics and leaves the journal bytes and directory unchanged", () => {
    const { root, journalPath, journalDirectory, bytes, run } = fixture([
      complete(), complete({ fieldReceipts: [{ ...receipt, eventId: undefined }] }),
      complete({ fieldReceipts: [{ ...receipt, eventId: "IFAE_conflict" }] }),
      complete({ issueNumber: 43, fieldReceipts: [{ ...receipt, eventId: "IFAE_conflict" }] }),
    ]);
    const output = "artifacts/github-issue-roadmap/filing-receipts.json";
    const result = run(`--repository=${repository}`, `--out=${output}`);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("skippedMalformed=1");
    expect(result.stderr).toContain("droppedConflicts=1");
    const raw = readFileSync(join(root, output), "utf8");
    const document = parseFilingFieldReceipts(JSON.parse(raw));
    expect(document.records).toEqual(build([complete()]).document.records);
    expect(raw).toBe(prettyCanonicalJson(document));
    expect(readFileSync(journalPath)).toEqual(bytes);
    expect(readdirSync(journalDirectory)).toEqual(["execution.journal.jsonl"]);
    expect(readdirSync(join(root, "artifacts/github-issue-roadmap"))).toEqual(["filing-receipts.json"]);
  });

  it("prints a zero-receipt document to stdout and exits successfully", () => {
    const { journalPath, bytes, run } = fixture();
    const result = run(`--repository=${repository}`);
    expect(result.status, result.stderr).toBe(0);
    expect(parseFilingFieldReceipts(JSON.parse(result.stdout))).toMatchObject({ repository, records: [] });
    expect(result.stderr).toContain("skippedMalformed=0");
    expect(result.stderr).toContain("droppedConflicts=0");
    expect(readFileSync(journalPath)).toEqual(bytes);
  });

  it("does not provision a missing journal", () => {
    const { run, root } = fixture();
    const result = run("--repository=Other/repository");
    expect(result.status, result.stderr).toBe(0);
    expect(parseFilingFieldReceipts(JSON.parse(result.stdout))).toMatchObject({
      repository: "Other/repository", records: [],
    });
    expect(readdirSync(join(root, "journal"))).toEqual(["example-org--example-repo"]);
  });

  it.each([
    { args: [] }, { args: ["--repository=invalid"] }, { args: ["--repository=Owner/repo/extra"] },
    { args: [`--repository=${repository}`, "--out=outside.json"] },
    { args: [`--repository=${repository}`, "--out=artifacts/github-issue-roadmap/../../outside.json"] },
    { args: [`--repository=${repository}`, `--repository=${repository}`] },
    { args: [`--repository=${repository}`, "--unknown=true"] },
  ])("refuses invalid CLI arguments $args without changing the journal", ({ args }) => {
    const { journalPath, bytes, run } = fixture([complete()]);
    const result = run(...args);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
    expect(readFileSync(journalPath)).toEqual(bytes);
  });
});
