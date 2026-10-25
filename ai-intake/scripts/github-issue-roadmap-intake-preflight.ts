import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDecisionDirectory } from "./lib/decision-surfacer/journal";
import { acquireExecutionClaim, resolveJournalPath } from "./lib/github-issue-roadmap/intake-execution-journal";
import { readGraphqlWithMetadata } from "./github-issue-roadmap-preflight";
import {
  assertClosingBoardFingerprint, parseBoardFingerprint, readBoardFingerprint, type BoardFingerprint,
} from "./lib/github-issue-roadmap/board-fingerprint";

import {
  assertDistinctRoadmapArtifactPaths,
  assertRoadmapArtifactOutputPath,
  writeRoadmapArtifactAtomically,
} from "./lib/github-issue-roadmap/artifact-io";
import { canonicalJsonSha256, prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import {
  buildIntakeSnapshot,
  intakeSnapshotJson,
  type IntakeCensusPass,
  type IntakeIssueInput,
  type IntakeReadReceipt,
} from "./lib/github-issue-roadmap/intake-snapshot";
import { parseOutcomeEnvelope } from "./lib/github-issue-roadmap/outcome-candidate";
import { dispositionHistory, effectiveOutcomeCandidates } from "./lib/github-issue-roadmap/disposition-history";
import {
  API_VERSION,
  createReadOnlyGhRunner,
  parseIncludedGhResponse,
  readRestResourceWithMetadata,
  readRestPagesWithReceipts,
  type GhRunner,
  type JsonObject,
  type ReadOnlyGithubReceipt,
} from "./lib/github-issue-roadmap/read-only-github-reader";
import { parseCanonicalSnapshotV2, type CanonicalSnapshotV2 } from "./lib/github-issue-roadmap/snapshot-v2";
import {
  createScheduledCaptureSession,
  type ScheduledCaptureOptions,
} from "./lib/github-issue-roadmap/shadow-batch";

type CliArgs = { readonly candidate: string; readonly snapshot: string; readonly out: string; readonly fingerprint?: string; readonly censusPassOut?: string };

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(candidate|snapshot|out|fingerprint|census-pass-out)=(.+)$/.exec(argument);
    if (match === null) throw new Error(`Unsupported argument: ${argument}`);
    if (values.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    values.set(match[1], match[2]);
  }
  for (const name of ["candidate", "snapshot", "out"] as const) {
    if (!values.has(name)) throw new Error(`Missing required --${name}=PATH argument.`);
  }
  return { candidate: values.get("candidate")!, snapshot: values.get("snapshot")!, out: values.get("out")!, fingerprint: values.get("fingerprint"), censusPassOut: values.get("census-pass-out") };
}

function readJson(path: string, context: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${context} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error("GitHub returned an invalid database identity.");
  return value as number;
}

function receipts(input: readonly ReadOnlyGithubReceipt[]): IntakeReadReceipt[] {
  return input.map((entry) => ({ ...entry, domain: entry.domain as IntakeReadReceipt["domain"] }));
}

function emptyRelationships(): IntakeIssueInput["relationships"] {
  return { parent: null, subIssues: [], blockedBy: [], blocking: [] };
}

function relationshipsFromCanonical(
  relationships: CanonicalSnapshotV2["issues"][number]["relationships"],
): IntakeIssueInput["relationships"] {
  const raw = (identity: NonNullable<typeof relationships.parent>) => ({
    number: identity.number,
    databaseId: identity.databaseId,
    nodeId: identity.nodeId,
    repositoryFullName: `${identity.repository.organization}/${identity.repository.name}`,
  });
  return {
    parent: relationships.parent === null ? null : raw(relationships.parent),
    subIssues: relationships.subIssues.map(raw),
    blockedBy: relationships.blockedBy.map(raw),
    blocking: relationships.blocking.map(raw),
  };
}

function intakeIssueFromReads(row: JsonObject, comments: readonly JsonObject[], fieldValues: readonly unknown[],
  canonical: CanonicalSnapshotV2["issues"][number] | undefined): IntakeIssueInput {
  const issueNumber = number(row.number);
  return {
    number: issueNumber,
    databaseId: number(row.id),
    nodeId: string(row.node_id),
    repositoryFullName: string(row.repository_url).replace("https://api.github.com/repos/", ""),
    title: string(row.title),
    state: string(row.state).toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN",
    stateReason: row.state_reason === null ? null : string(row.state_reason).toUpperCase(),
    body: typeof row.body === "string" ? row.body : "",
    updatedAt: string(row.updated_at),
    nativeType: row.type ?? null,
    fieldValues,
    relationships: canonical === undefined
      ? emptyRelationships()
      : relationshipsFromCanonical(canonical.relationships),
    projectMemberships: canonical?.projectMemberships ?? [],
    evidence: canonical?.persistedVerifications ?? [],
    comments: comments.map((comment: JsonObject) => ({
      databaseId: number(comment.id),
      nodeId: string(comment.node_id),
      body: typeof comment.body === "string" ? comment.body : "",
      author: typeof (comment.user as JsonObject | undefined)?.login === "string"
        ? (comment.user as JsonObject).login as string
        : null,
      createdAt: string(comment.created_at),
      updatedAt: string(comment.updated_at),
      deleted: false,
    })),
  };
}

export function collectIntakeCensusPass(options: {
  readonly canonicalSnapshot: CanonicalSnapshotV2;
  readonly completedAt: string;
  readonly runGh: GhRunner;
}): IntakeCensusPass {
  const repository = options.canonicalSnapshot.repository;
  const fullName = `${repository.organization}/${repository.name}`;
  const issueEndpoint = `/repos/${fullName}/issues?state=all&per_page=100`;
  const issueResult = readRestPagesWithReceipts(options.runGh, issueEndpoint, options.completedAt, "issues");
  const issueRows = issueResult.value.filter((row) => row.pull_request === undefined);
  const excludedPullRequestCount = issueResult.value.length - issueRows.length;
  const allReceipts: IntakeReadReceipt[] = receipts(issueResult.receipts);
  const issueNumbers = new Set(issueRows.map(row => number(row.number)));
  const pullRequestNumbers = new Set(issueResult.value
    .filter(row => row.pull_request !== undefined).map(row => number(row.number)));
  const commentsResult = readRestPagesWithReceipts(
    options.runGh, `/repos/${fullName}/issues/comments?per_page=100`, options.completedAt, "comments",
  );
  allReceipts.push(...receipts(commentsResult.receipts));
  const commentsByIssue = new Map<number, JsonObject[]>();
  const issueUrlPrefix = `https://api.github.com/repos/${fullName}/issues/`;
  for (const comment of commentsResult.value) {
    const url = string(comment.issue_url);
    const suffix = url.startsWith(issueUrlPrefix) ? url.slice(issueUrlPrefix.length) : "";
    const parent = /^[1-9]\d*$/.test(suffix) ? Number(suffix) : NaN;
    if (issueNumbers.has(parent)) {
      const comments = commentsByIssue.get(parent) ?? [];
      comments.push(comment);
      commentsByIssue.set(parent, comments);
    } else if (!pullRequestNumbers.has(parent)) {
      throw new Error("GitHub issue census changed during collection; comment parent is outside the enumerated issues and pull requests.");
    }
  }
  const canonicalByIssueNumber = new Map(options.canonicalSnapshot.issues.map(issue => [issue.identity.number, issue]));
  const issues: IntakeIssueInput[] = issueRows.map((row) => {
    const issueNumber = number(row.number);
    const fieldsResult = readRestPagesWithReceipts(
      options.runGh, `/repos/${fullName}/issues/${issueNumber}/issue-field-values?per_page=100`,
      options.completedAt, "fields",
    );
    allReceipts.push(...receipts(fieldsResult.receipts));
    return intakeIssueFromReads(row, commentsByIssue.get(issueNumber) ?? [], fieldsResult.value, canonicalByIssueNumber.get(issueNumber));
  });
  return {
    completedAt: options.completedAt,
    repository,
    expectedIssueCount: issues.length,
    excludedPullRequestCount,
    incompleteResults: false,
    coverage: { issues: "complete", bodies: "complete", comments: "complete", fields: "complete", relationships: "incomplete" },
    receipts: allReceipts,
    issues,
  };
}

export interface IntakeIssueIndex {
  /** Issue number -> `updated_at`, over the same `state=all` census the full pass walks. */
  readonly updatedAt: ReadonlyMap<number, string>;
  readonly excludedPullRequestCount: number;
  readonly completedAt: string;
  readonly receipts: readonly IntakeReadReceipt[];
}

/** Refresh one journal-identified issue without walking the repository census. */
export function collectIntakeIssue(options: {
  readonly canonicalSnapshot: CanonicalSnapshotV2;
  readonly issueNumber: number;
  readonly fetchedAt: string;
  readonly runGh: GhRunner;
}): { readonly issue: IntakeIssueInput; readonly receipts: readonly IntakeReadReceipt[] } {
  const { organization, name } = options.canonicalSnapshot.repository;
  const endpoint = `/repos/${organization}/${name}/issues/${number(options.issueNumber)}`;
  let responseSha256 = "";
  const result = readRestResourceWithMetadata(args => {
    const response = options.runGh(args);
    responseSha256 = createHash("sha256").update(parseIncludedGhResponse(response).body, "utf8").digest("hex");
    return response;
  }, endpoint, options.fetchedAt);
  const row = result.value;
  if (number(row.number) !== options.issueNumber || row.pull_request !== undefined ||
      row.repository_url !== `https://api.github.com/repos/${organization}/${name}`) {
    throw new Error("Targeted intake issue identity differs from the requested issue.");
  }
  const comments = readRestPagesWithReceipts(options.runGh, `${endpoint}/comments?per_page=100`, options.fetchedAt, "comments");
  const fields = readRestPagesWithReceipts(options.runGh, `${endpoint}/issue-field-values?per_page=100`, options.fetchedAt, "fields");
  return {
    issue: intakeIssueFromReads(row, comments.value, fields.value,
      options.canonicalSnapshot.issues.find(issue => issue.identity.number === options.issueNumber)),
    receipts: [{ domain: "issues", endpoint, page: null, responseSha256,
      requestId: result.transport[0].requestId!, fetchedAt: options.fetchedAt, apiVersion: API_VERSION },
      ...receipts(comments.receipts), ...receipts(fields.receipts)],
  };
}

/**
 * Reads only the issue index -- one paginated endpoint, no per-issue fan-out.
 *
 * This is the cheap half of the census. `collectIntakeCensusPass` also reads the repository
 * comment listing and field values per issue, which is what makes a full pass expensive;
 * the index alone is a handful of pages. Re-reading just the index after a full pass detects
 * that the world moved during collection at a small fraction of a second pass's cost.
 */
export function collectIntakeIssueIndex(options: {
  readonly canonicalSnapshot: CanonicalSnapshotV2;
  readonly runGh: GhRunner;
}): IntakeIssueIndex {
  const repository = options.canonicalSnapshot.repository;
  const fullName = `${repository.organization}/${repository.name}`;
  const issueResult = readRestPagesWithReceipts(
    options.runGh,
    `/repos/${fullName}/issues?state=all&per_page=100`,
    new Date().toISOString(),
    "issues",
  );
  const completedAt = new Date().toISOString();
  const issueRows = issueResult.value.filter((row) => row.pull_request === undefined);
  return {
    updatedAt: new Map(issueRows.map((row) => [number(row.number), string(row.updated_at)])),
    excludedPullRequestCount: issueResult.value.length - issueRows.length,
    completedAt,
    receipts: receipts(issueResult.receipts),
  };
}

export interface IntakeCensusDrift {
  readonly appearedIssueNumbers: readonly number[];
  readonly disappearedIssueNumbers: readonly number[];
  readonly movedIssueNumbers: readonly number[];
}

/** Compares a completed census pass against a bookend index read taken after it. */
export function detectIntakeCensusDrift(
  pass: { readonly issues: readonly { readonly number: number; readonly updatedAt: string }[] },
  bookend: IntakeIssueIndex,
): IntakeCensusDrift {
  const observed = new Map(pass.issues.map((issue) => [issue.number, issue.updatedAt]));
  const appearedIssueNumbers: number[] = [];
  const movedIssueNumbers: number[] = [];
  for (const [issueNumber, updatedAt] of bookend.updatedAt) {
    const before = observed.get(issueNumber);
    if (before === undefined) appearedIssueNumbers.push(issueNumber);
    // Compare instants: a normalized snapshot writes .000Z where REST writes Z.
    // An unparseable stamp yields NaN, which never compares equal, so it counts as moved.
    else if (Date.parse(before) !== Date.parse(updatedAt)) movedIssueNumbers.push(issueNumber);
  }
  const disappearedIssueNumbers = [...observed.keys()]
    .filter((issueNumber) => !bookend.updatedAt.has(issueNumber));
  const ascending = (left: number, right: number) => left - right;
  return {
    appearedIssueNumbers: appearedIssueNumbers.sort(ascending),
    disappearedIssueNumbers: disappearedIssueNumbers.sort(ascending),
    movedIssueNumbers: movedIssueNumbers.sort(ascending),
  };
}

function assertNoUnresolvedDecisionDispatch(repository: string): void {
  const path = join(resolveDecisionDirectory(repository), "unresolved-dispatch");
  try { lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Decision post reconciliation required before intake census: ${path}. Run decision-surfacer post to reconcile unresolved dispatches. If readback remains absent, verify the request cannot still land and use post --confirm-absent <operationId> to resolve it.`);
}

export function collectClaimedIntakeCensus(options: {
  readonly heldClaim?: ReturnType<typeof acquireExecutionClaim>;
  readonly canonicalSnapshot: CanonicalSnapshotV2;
  readonly runGh: GhRunner;
  readonly fingerprint?: BoardFingerprint;
}): { pass: IntakeCensusPass; bookend: IntakeIssueIndex } {
  const { organization, name } = options.canonicalSnapshot.repository;
  const repository = `${organization}/${name}`;
  assertNoUnresolvedDecisionDispatch(repository);
  const claim = options.heldClaim ?? acquireExecutionClaim(resolveJournalPath(repository), { mode: "preflight" });
  try {
    return claim.withOwnership(() => {
      // A post can die between the first check and our acquisition/reclamation.
      assertNoUnresolvedDecisionDispatch(repository);
      const pass = collectIntakeCensusPass({ ...options, completedAt: new Date().toISOString() });
      const bookend = collectIntakeIssueIndex(options);
      const drift = detectIntakeCensusDrift(pass, bookend);
      if (drift.appearedIssueNumbers.length > 0 || drift.disappearedIssueNumbers.length > 0 || drift.movedIssueNumbers.length > 0) {
        throw new Error("GitHub issue census changed during collection; refusing mixed-version intake evidence. " +
          `Moved: [${drift.movedIssueNumbers.join(", ")}]. ` +
          `Appeared: [${drift.appearedIssueNumbers.join(", ")}]. ` +
          `Disappeared: [${drift.disappearedIssueNumbers.join(", ")}].`);
      }
      if (options.fingerprint !== undefined) {
        const closing = readBoardFingerprint({ repo: { owner: organization, name, fullName: repository },
          runGh: options.runGh, fetchedAt: new Date().toISOString(), readGraphql: readGraphqlWithMetadata });
        assertClosingBoardFingerprint(options.fingerprint, closing.fingerprint, pass.issues);
      }
      return claim.withOwnership(() => ({ pass, bookend }));
    });
  } finally { if (options.heldClaim === undefined) claim.release(); }
}

export function runIntakePreflightCli(
  argv: readonly string[],
  repoRoot = process.cwd(),
  runGh = createReadOnlyGhRunner(),
  heldClaim?: ReturnType<typeof acquireExecutionClaim>,
  options: { readonly dispositionHistory?: typeof dispositionHistory } = {},
): string {
  const args = parseArgs(argv);
  const candidatePath = assertRoadmapArtifactOutputPath(args.candidate, repoRoot);
  const snapshotPath = assertRoadmapArtifactOutputPath(args.snapshot, repoRoot);
  const outputPath = assertRoadmapArtifactOutputPath(args.out, repoRoot);
  const fingerprintPath = args.fingerprint === undefined ? undefined : assertRoadmapArtifactOutputPath(args.fingerprint, repoRoot);
  const censusPassPath = args.censusPassOut === undefined ? undefined : assertRoadmapArtifactOutputPath(args.censusPassOut, repoRoot);
  assertDistinctRoadmapArtifactPaths([
    { label: "--candidate", path: candidatePath },
    { label: "--snapshot", path: snapshotPath },
    { label: "--out", path: outputPath },
    ...(fingerprintPath === undefined ? [] : [{ label: "--fingerprint", path: fingerprintPath }]),
    ...(censusPassPath === undefined ? [] : [{ label: "--census-pass-out", path: censusPassPath }]),
  ], repoRoot);
  const candidate = parseOutcomeEnvelope(readJson(candidatePath, "Outcome candidate"));
  const canonicalSnapshot = parseCanonicalSnapshotV2(readJson(snapshotPath, "Canonical snapshot v2"));
  const fingerprint = fingerprintPath === undefined ? undefined : parseBoardFingerprint(readJson(fingerprintPath, "Board fingerprint"));
  const history = (options.dispositionHistory ?? dispositionHistory)(canonicalSnapshot.git.originMainSha, { repoRoot });
  const selection = effectiveOutcomeCandidates(candidate, history);
  for (const skipped of selection.dispositioned) console.log(`dispositioned: ${skipped.sourceFingerprint} (${skipped.stableOutcomeId}); skipped preflight candidate work.`);
  if (candidate.repository.databaseId !== canonicalSnapshot.repository.databaseId ||
      candidate.repository.nodeId !== canonicalSnapshot.repository.nodeId) {
    throw new Error("Outcome candidate and canonical snapshot repository identities disagree.");
  }
  // One full census, then a cheap bookend index read to detect drift during collection.
  //
  // This previously ran the whole census twice and required the two to be byte-identical.
  // A pass used to cost two requests per issue on top of the index, so the second pass doubled the
  // collection window -- which doubled the exposure during which genuine drift could occur
  // and force a refusal. The mitigation amplified the risk it guarded against, and yielded
  // no artifact at all when it fired.
  //
  // The bookend detects the same condition (the census moved while we were walking it) by
  // re-reading only the index. Known residual gap: it keys on issue-level `updated_at`, so a
  // mutation that does not bump it -- comment deletion is the suspected case -- is not seen.
  // That is proportionate for backlog sorting; it must be verified before this evidence
  // feeds unsupervised issue selection.
  const { pass, bookend } = collectClaimedIntakeCensus({ canonicalSnapshot, runGh, heldClaim, fingerprint });
  const generatedAt = new Date().toISOString();
  const artifact = buildIntakeSnapshot({
    candidateSha256: canonicalJsonSha256(candidate),
    canonicalSnapshotV2Sha256: canonicalJsonSha256(canonicalSnapshot),
    generatedAt,
    pass,
    bookend,
    projectObservation: {
      status: "unavailable",
      memberships: canonicalSnapshot.issues.flatMap((issue) => issue.projectMemberships),
      evidence: "Project observation is optional; canonical snapshot memberships are retained as prior evidence.",
    },
  });
  writeRoadmapArtifactAtomically(outputPath, intakeSnapshotJson(artifact));
  if (censusPassPath !== undefined) writeRoadmapArtifactAtomically(censusPassPath,
    prettyCanonicalJson({ pass, bookend: { ...bookend, updatedAt: Object.fromEntries(bookend.updatedAt) } }));
  console.log(`Wrote read-only GitHub roadmap intake snapshot to ${relative(repoRoot, outputPath)}.`);
  return outputPath;
}

export function runScheduledIntakePreflightCli(
  argv: readonly string[],
  repoRoot = process.cwd(),
  captureOptions: ScheduledCaptureOptions = {},
): string {
  const session = createScheduledCaptureSession(captureOptions);
  try {
    return runIntakePreflightCli(argv, repoRoot, session.runGh);
  } finally {
    session.dispose();
  }
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    runIntakePreflightCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
