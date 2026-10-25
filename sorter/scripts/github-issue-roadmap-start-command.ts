import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { closingReferenceMatches, linkedPullRequestSources, readQualifiedRelationshipsV2, readRestPagesWithMetadata, readRestResourceWithMetadata, sha256Body } from "./github-issue-roadmap-preflight";
import { canonicalJsonSha256 } from "./lib/github-issue-roadmap/canonical-json";
import { issueFieldValueIdentity } from "./lib/github-issue-roadmap/issue-field-value";
import { assertReadOnlyGhArgs, type GhRunner } from "./lib/github-issue-roadmap/read-only-github-reader";
import { qualifyRepositoryIdentity } from "./lib/github-issue-roadmap/snapshot-v2";
import { AUTHORED_START_COMMANDS } from "./lib/github-issue-roadmap/start-command-values";
import { decideOpenTimeStartCommand, type OpenTimeLiveFacts, type OpenTimeSnapshot, type SnapshotUnavailableReason } from "./lib/github-issue-roadmap/start-command-open-time";
import { stewardshipAssessmentSchema } from "./lib/github-issue-roadmap/stewardship-assessment";
import { compileStewardshipBacklog } from "./lib/github-issue-roadmap/stewardship-backlog";
import type { StewardshipIssueEvidencePacket } from "./lib/github-issue-roadmap/stewardship-evidence";
import { stewardshipLifecycleSchema } from "./lib/github-issue-roadmap/stewardship-policy";
import { stewardshipPaths } from "./lib/github-issue-roadmap/stewardship-state";

const repository = "example-org/example-repo";
const usage = "Usage: npm run roadmap:start-command -- --issue=<positive integer> [--json]";
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const startFactsSchema = z.object({
  lifecycle: stewardshipLifecycleSchema.nullable(),
  pullRequests: z.array(z.object({ state: z.string(), relationship: z.enum(["closing", "linked"]) })),
  type: z.string().nullable(), body: z.string(), hasPlanWithUnits: z.boolean(),
  authoredStartCommand: z.enum(AUTHORED_START_COMMANDS).nullable().optional(),
});
const seatSchema = stewardshipAssessmentSchema.pick({ completion: true, premise: true, unresolvedChoices: true }).strip();
const assessmentSchema = z.object({
  assessments: z.array(z.object({ assessment: seatSchema })),
  ranking: z.object({ effort: z.discriminatedUnion("status", [
    z.object({ status: z.literal("merged"), value: z.enum(["low", "medium", "high"]) }),
    z.object({ status: z.literal("needs_evidence"), cause: z.enum(["abstained", "disagreed"]) }),
  ]) }),
});
const projectionIssueSchema = z.object({
  status: z.enum(["current", "stale", "unassessed", "closed"]),
  startCommandFacts: startFactsSchema, assessment: z.unknown(),
});
const repositoryIdentitySchema = z.object({ organization: z.string().min(1), name: z.string().min(1),
  databaseId: z.number().int().positive(), nodeId: z.string().min(1) });
const issueIdentitySchema = z.object({ repository: repositoryIdentitySchema, number: z.number().int().positive(),
  databaseId: z.number().int().positive(), nodeId: z.string().min(1), state: z.enum(["OPEN", "CLOSED"]).optional() });
const currencyPacketSchema = z.object({
  title: z.string(), body: z.string(), bodySha256: hashSchema, evidencePhase: z.enum(["initial", "expanded"]),
  issue: z.object({ nativeType: z.object({ organization: z.string(), databaseId: z.number().int().positive(),
    nodeId: z.string().nullable(), name: z.string().min(1) }).nullable(),
    v1: z.object({ labels: z.array(z.string()), state: z.enum(["OPEN", "CLOSED"]) }),
    relationships: z.object({ parent: issueIdentitySchema.nullable(), subIssues: z.array(issueIdentitySchema),
      blockedBy: z.array(issueIdentitySchema), blocking: z.array(issueIdentitySchema) }),
  }),
  reopenEvents: z.array(z.object({ id: z.string(), createdAt: z.string(), actorLogin: z.string().nullable() })).optional(),
  sourceExcerpts: z.array(z.object({ path: z.string(), startLine: z.number(), endLine: z.number() })).optional(),
  sources: z.array(z.object({ path: z.string(), snippetSha256: hashSchema,
    excerpt: z.object({ startLine: z.number(), endLine: z.number() }).optional() })),
});
// Validate fields consumed by currency without stripping the archived rubric, excerpts or other packet evidence.
const packetSchema = z.custom<StewardshipIssueEvidencePacket>((value) => currencyPacketSchema.safeParse(value).success);

export interface StartCommandCliDependencies {
  readonly root?: string;
  readonly runGh?: (args: readonly string[], environment: NodeJS.ProcessEnv) => string;
  readonly writeOutput?: (value: string) => void;
  readonly writeError?: (value: string) => void;
}

function parseArgs(argv: readonly string[]) {
  let issueNumber: number | null = null;
  let json = false;
  for (const arg of argv) {
    if (/^--issue=[1-9]\d*$/.test(arg) && issueNumber === null) issueNumber = Number(arg.slice("--issue=".length));
    else if (arg === "--json" && !json) json = true;
    else throw new Error(usage);
  }
  if (issueNumber === null || !Number.isSafeInteger(issueNumber)) throw new Error(usage);
  return { issueNumber, json };
}

function readSnapshot(issueNumber: number, root?: string): { snapshot: OpenTimeSnapshot | null; snapshotUnavailableReason?: SnapshotUnavailableReason } {
  const paths = stewardshipPaths({ repository, root });
  let journal: string;
  try { journal = readFileSync(paths.journal, "utf8"); }
  catch (error) {
    return { snapshot: null, snapshotUnavailableReason: (error as NodeJS.ErrnoException).code === "ENOENT"
      ? "no_journal" : "journal_unreadable" };
  }
  try {
    const compiles: { at: string; event: { snapshotSha256: string; compileInputsSha256: string } }[] = [];
    const lines = journal.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let raw: unknown;
      try { raw = JSON.parse(line); }
      catch (error) {
        if (index === lines.length - 1 && !journal.endsWith("\n")) continue;
        throw error;
      }
      const entry = z.object({ event: z.object({ type: z.string() }).passthrough(), at: z.string() }).parse(raw);
      if (entry.event.type !== "backlog-compiled") continue;
      const compiled = z.object({
        at: z.string().datetime({ offset: true }), event: z.object({ snapshotSha256: hashSchema, compileInputsSha256: hashSchema }),
      }).parse(entry);
      compiles.push(compiled);
    }
    let latest: { at: string; snapshotSha256: string; input: Parameters<typeof compileStewardshipBacklog>[0] } | null = null;
    for (let index = compiles.length - 1; index >= 0; index--) {
      const compiled = compiles[index];
      const input: unknown = JSON.parse(readFileSync(join(paths.artifacts, `${compiled.event.compileInputsSha256}.json`), "utf8"));
      if (canonicalJsonSha256(input) !== compiled.event.compileInputsSha256) throw new Error("Compile input hash mismatch");
      const compileInput = input as Parameters<typeof compileStewardshipBacklog>[0];
      const snapshot = compileStewardshipBacklog(compileInput);
      if (snapshot.status === "refused") continue;
      if (snapshot.snapshotSha256 !== compiled.event.snapshotSha256) throw new Error("Snapshot hash mismatch");
      latest = { at: compiled.at, snapshotSha256: compiled.event.snapshotSha256, input: compileInput };
      break;
    }
    if (!latest) return { snapshot: null, snapshotUnavailableReason: compiles.length ? "only_refused_compiles" : "no_compile" };
    const compile = z.object({ projection: z.object({ compileFormat: z.string().optional(), issues: z.record(z.string(), z.unknown()) }),
      observations: z.record(z.string(), z.unknown()).optional() }).parse(latest.input);
    if (compile.projection.compileFormat !== "github-issue-roadmap-backlog-compile/v2") {
      return { snapshot: null, snapshotUnavailableReason: "v1_snapshot" };
    }
    const rawIssue = compile.projection.issues[issueNumber];
    if (!rawIssue) return { snapshot: null, snapshotUnavailableReason: "issue_not_in_snapshot" };
    const issue = projectionIssueSchema.parse(rawIssue);
    const observation = compile.observations?.[issueNumber];
    if (observation === undefined) return { snapshot: null, snapshotUnavailableReason: "issue_not_in_snapshot" };
    const packet = z.object({ evidence: z.object({ packet: packetSchema }) }).parse(observation).evidence.packet;
    const nativeTypeName = packet.issue.nativeType?.name ?? null;
    if (sha256Body(packet.body) !== packet.bodySha256 || sha256Body(issue.startCommandFacts.body) !== packet.bodySha256
      || issue.startCommandFacts.type !== nativeTypeName) {
      throw new Error("Snapshot facts do not match its packet");
    }
    return { snapshot: {
      compiledAt: latest.at, snapshotSha256: latest.snapshotSha256,
      status: issue.status, startCommandFacts: issue.startCommandFacts,
      assessment: issue.status === "current" && issue.assessment != null ? assessmentSchema.parse(issue.assessment) : null,
      packet,
    } };
  } catch {
    return { snapshot: null, snapshotUnavailableReason: "journal_unreadable" };
  }
}

export function sessionGhRunner(runGh: StartCommandCliDependencies["runGh"]): GhRunner {
  const environment: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env)
    .filter((name) => !["ROADMAP_SORT_GITHUB_TOKEN"].includes(name.toUpperCase()))
    .map((name) => [name, process.env[name]])) as NodeJS.ProcessEnv;
  return (args) => {
    assertReadOnlyGhArgs(args);
    // REST reads are forced to GET. GraphQL must POST; assertReadOnlyGhArgs admits only a single
    // non-mutation query there, with no input files.
    const getArgs = args[1] === "graphql" ? [...args, "--hostname", "github.com"] : [...args, "--method", "GET", "--hostname", "github.com"];
    assertReadOnlyGhArgs(getArgs);
    return runGh ? runGh(getArgs, environment) : execFileSync("gh", getArgs, {
      encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 128 * 1024 * 1024, timeout: 60_000,
    });
  };
}

function sorterCredentialPresent(): boolean {
  return Object.keys(process.env).some((name) => name.toUpperCase() === "ROADMAP_SORT_GITHUB_TOKEN");
}

function readLiveIssue(issueNumber: number, runGh: GhRunner): OpenTimeLiveFacts {
  const endpoint = `/repos/${repository}/issues/${issueNumber}`;
  const fetchedAt = new Date().toISOString();
  const repositoryRow = readRestResourceWithMetadata(runGh, `/repos/${repository}`, fetchedAt).value;
  if (z.string().parse(repositoryRow.full_name).toLowerCase() !== repository.toLowerCase()) throw new Error("Live repository mismatch");
  const [organization, name] = repository.split("/");
  const repositoryIdentity = qualifyRepositoryIdentity({ organization, name,
    databaseId: repositoryRow.id, nodeId: repositoryRow.node_id });
  const issue = readRestResourceWithMetadata(runGh, endpoint, fetchedAt).value;
  if (issue.pull_request !== undefined) throw new Error("Requested number is a pull request, not an issue");
  if (issue.number !== issueNumber) throw new Error("Live issue number mismatch");
  const state = z.enum(["open", "closed"]).parse(issue.state);
  const body = z.string().nullable().parse(issue.body) ?? "";
  const typeValue = z.object({ id: z.number().int().positive(), node_id: z.string().nullish(), name: z.string().min(1) }).nullish().parse(issue.type);
  const type = typeValue?.name ?? null;
  const nativeType = typeValue ? { organization: "example-org", databaseId: typeValue.id, nodeId: typeValue.node_id ?? null,
    name: typeValue.name } as NonNullable<OpenTimeLiveFacts["nativeType"]> : null;
  const title = z.string().parse(issue.title);
  const labels = z.array(z.union([z.string(), z.object({ name: z.string() })])).parse(issue.labels)
    .map((label) => typeof label === "string" ? label : label.name);
  const fieldValues = readRestPagesWithMetadata(runGh, `${endpoint}/issue-field-values?per_page=100`, fetchedAt).value;
  const lifecycleValues = fieldValues.flatMap((field) => {
    const identity = issueFieldValueIdentity(field);
    const name = identity.name ?? (typeof field.name === "string" ? field.name : null);
    return name === "Lifecycle" ? [stewardshipLifecycleSchema.nullable().parse(identity.value)] : [];
  });
  if (lifecycleValues.length > 1) throw new Error("Live Lifecycle is ambiguous");
  const timeline = readRestPagesWithMetadata(runGh, `${endpoint}/timeline?per_page=100`, fetchedAt).value;
  const reopenEvents = timeline.filter((event) => event.event === "reopened").map((event) => {
    const row = z.object({ node_id: z.string().min(1), created_at: z.string().datetime({ offset: true }),
      actor: z.object({ login: z.string() }).nullable() }).parse(event);
    return { id: row.node_id, createdAt: row.created_at, actorLogin: row.actor?.login ?? null };
  });
  const relationships = readQualifiedRelationshipsV2(repositoryIdentity, issueNumber, runGh, fetchedAt).value;
  const pullRequests = linkedPullRequestSources(timeline).map((source) => {
    const pull = readRestResourceWithMetadata(runGh, `/repos/${source.repositoryFullName}/pulls/${source.number}`, fetchedAt).value;
    const state = z.enum(["open", "closed"]).parse(pull.state);
    const body = z.string().nullable().parse(pull.body);
    const closing = closingReferenceMatches(body, repositoryIdentity, issueNumber);
    return { state: state.toUpperCase(), relationship: closing ? "closing" as const : "linked" as const };
  });
  return { state: state === "open" ? "OPEN" : "CLOSED", lifecycle: lifecycleValues[0] ?? null, pullRequests, type, body,
    title, labels, nativeType, relationships, reopenEvents };
}

/** Returns an exit code; failed live reads never reach the output sink. */
export function runStartCommandCli(argv: readonly string[], dependencies: StartCommandCliDependencies = {}): number {
  const writeOutput = dependencies.writeOutput ?? ((value: string) => process.stdout.write(`${value}\n`));
  const writeError = dependencies.writeError ?? ((value: string) => process.stderr.write(`${value}\n`));
  let args: ReturnType<typeof parseArgs>;
  try { args = parseArgs(argv); }
  catch { writeError(usage); return 1; }
  if (sorterCredentialPresent()) {
    writeError("refusing to run: the sorter's credential is present in this environment");
    return 1;
  }
  const archived = readSnapshot(args.issueNumber, dependencies.root);
  let live: OpenTimeLiveFacts;
  try { live = readLiveIssue(args.issueNumber, sessionGhRunner(dependencies.runGh)); }
  catch { writeError("Live read failed; no recommendation. Check the session's gh login and issue access."); return 1; }
  const result = decideOpenTimeStartCommand({ issueNumber: args.issueNumber, live, ...archived });
  writeOutput(args.json ? JSON.stringify(result, null, 2)
    : Object.entries(result).map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join("\n"));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = runStartCommandCli(process.argv.slice(2));
}
