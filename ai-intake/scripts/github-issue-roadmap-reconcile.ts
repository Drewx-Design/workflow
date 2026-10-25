import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDistinctRoadmapArtifactPaths,
  assertRoadmapArtifactOutputPath,
  writeRoadmapArtifactAtomically,
} from "./lib/github-issue-roadmap/artifact-io";
import {
  buildIntakeReconciliation,
  intakeReconciliationJson,
  parseWeeklyReconciliationFindings,
  type ProducerArtifactObservation,
} from "./lib/github-issue-roadmap/intake-reconciliation";
import { parseIntakeSnapshotV1 } from "./lib/github-issue-roadmap/intake-snapshot";
import { assertRecommendationArtifact } from "./lib/github-issue-roadmap/recommendation";
import {
  createScheduledReadOnlyGhRunner,
  readRestResourceWithMetadata,
  type GhRunner,
} from "./lib/github-issue-roadmap/read-only-github-reader";
import {
  parseCanonicalSnapshotV2,
  type CanonicalSnapshotV2,
} from "./lib/github-issue-roadmap/snapshot-v2";
import {
  discoverRoadmapProducerArtifacts,
  lintRoadmapOutcomeCandidates,
  parseRoadmapProducerRegistry,
  previousRoadmapArtifactIdentities,
} from "./lint-roadmap-outcome-candidates";

interface ReconciliationCliArgs {
  readonly snapshot: string;
  readonly intakeSnapshot: string;
  readonly findings: string;
  readonly recommendation: string | null;
  readonly out: string;
  readonly legacyStewardIssue: number | null;
}

function parseArgs(argv: readonly string[]): ReconciliationCliArgs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(snapshot|intake-snapshot|findings|recommendation|out|legacy-steward-issue)=(.+)$/.exec(argument);
    if (match === null) throw new Error(`Unsupported argument: ${argument}`);
    if (values.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    values.set(match[1], match[2]);
  }
  for (const name of ["snapshot", "intake-snapshot", "findings", "out"] as const) {
    if (!values.has(name)) throw new Error(`Missing required --${name}=PATH argument.`);
  }
  const legacy = values.get("legacy-steward-issue");
  const legacyStewardIssue = legacy === undefined ? null : (() => {
    const issueNumber = Number(legacy);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("--legacy-steward-issue must be a positive issue number.");
    }
    return issueNumber;
  })();
  return {
    snapshot: values.get("snapshot")!,
    intakeSnapshot: values.get("intake-snapshot")!,
    findings: values.get("findings")!,
    recommendation: values.get("recommendation") ?? null,
    out: values.get("out")!,
    legacyStewardIssue,
  };
}

function readJson(path: string, context: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${context} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCurrentMainReadback(
  snapshot: CanonicalSnapshotV2,
  runGh: GhRunner,
  fetchedAt: string,
): void {
  const fullName = `${snapshot.repository.organization}/${snapshot.repository.name}`;
  const response = readRestResourceWithMetadata(
    runGh,
    `/repos/${fullName}/commits/main`,
    fetchedAt,
  );
  if (response.value.sha !== snapshot.git.originMainSha) {
    throw new Error("Current main drifted after canonical capture; rerun the read-only snapshot before reconciliation.");
  }
}

export function runReconciliationCli(
  argv: readonly string[],
  repoRoot = process.cwd(),
  runGh = createScheduledReadOnlyGhRunner(),
  now: () => Date = () => new Date(),
): string {
  const args = parseArgs(argv);
  const snapshotPath = resolve(repoRoot, args.snapshot);
  const intakeSnapshotPath = resolve(repoRoot, args.intakeSnapshot);
  const findingsPath = resolve(repoRoot, args.findings);
  const recommendationPath = args.recommendation === null
    ? null
    : resolve(repoRoot, args.recommendation);
  const outputPath = assertRoadmapArtifactOutputPath(args.out, repoRoot);
  assertDistinctRoadmapArtifactPaths([
    { label: "--snapshot", path: snapshotPath },
    { label: "--intake-snapshot", path: intakeSnapshotPath },
    { label: "--findings", path: findingsPath },
    ...(recommendationPath === null ? [] : [{ label: "--recommendation", path: recommendationPath }]),
    { label: "--out", path: outputPath },
  ], repoRoot);

  const canonicalSnapshot = parseCanonicalSnapshotV2(readJson(snapshotPath, "Canonical snapshot"));
  const intakeSnapshot = parseIntakeSnapshotV1(readJson(intakeSnapshotPath, "Intake snapshot"));
  const weeklyFindings = parseWeeklyReconciliationFindings(
    readJson(findingsPath, "Weekly reconciliation findings"),
    canonicalSnapshot,
  );
  const recommendation = recommendationPath === null
    ? null
    : assertRecommendationArtifact(readJson(recommendationPath, "Attention recommendation"));
  const generatedAt = now().toISOString();
  assertCurrentMainReadback(canonicalSnapshot, runGh, generatedAt);

  const registry = parseRoadmapProducerRegistry(readJson(
    resolve(repoRoot, "scripts/github-issue-roadmap-producers.json"),
    "Roadmap producer registry",
  ));
  const artifacts = discoverRoadmapProducerArtifacts(repoRoot, registry);
  const lint = lintRoadmapOutcomeCandidates({
    registry,
    artifacts,
    previousArtifactIdentities: previousRoadmapArtifactIdentities(repoRoot, registry),
  });
  const lintByLocator = new Map(lint.artifacts.map((artifact) => [artifact.sourceLocator, artifact]));
  const observations: ProducerArtifactObservation[] = artifacts.map((artifact) => {
    const lintArtifact = lintByLocator.get(artifact.sourceLocator);
    const status = lintArtifact?.status ?? "invalid_sidecar";
    return {
      sourceLocator: artifact.sourceLocator,
      status,
      envelope: lintArtifact?.envelope ?? null,
    };
  });
  const report = buildIntakeReconciliation({
    generatedAt,
    canonicalSnapshot,
    intakeSnapshot,
    producerArtifacts: observations,
    weeklyFindings,
    attentionRecommendation: recommendation,
    legacyStewardV2IssueNumber: args.legacyStewardIssue,
  });
  writeRoadmapArtifactAtomically(outputPath, intakeReconciliationJson(report));
  console.log(`Wrote read-only GitHub roadmap reconciliation to ${relative(repoRoot, outputPath)}.`);
  return outputPath;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    runReconciliationCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
