import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  isAbsolute,
  relative,
  resolve,
} from "node:path";

import { canonicalJsonSha256 } from "./canonical-json";
import {
  INTAKE_OBSERVATION_DIRECTORY,
  INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1,
  INTAKE_OBSERVATION_SCHEMA_V2,
  readIntakeJournalRecord,
  type IntakeObservationRecordV2,
} from "./intake-observation";
import {
  parseIntakeSnapshotV1,
  type IntakeSnapshotV1,
} from "./intake-snapshot";
import {
  outcomeSourceContentMatchesSha256,
  outcomeSourceContentSha256,
  parseOutcomeEnvelope,
  type OutcomeCandidate,
  type OutcomeEnvelope,
} from "./outcome-candidate";

const OBSERVATION_ID = /^[a-f0-9]{64}$/;

/** Bump whenever the rendered judgement material's output bytes can change. */
export const JUDGEMENT_MATERIAL_RENDERER_VERSION = "github-issue-roadmap-judgement-material/v1" as const;

export interface RenderJudgementMaterialInput {
  readonly repoRoot: string;
  readonly observationId: string;
}

export interface EvidenceContentVerification {
  readonly evidenceId: string;
  readonly sourceLocator: string;
  readonly recordedContentSha256: string;
  readonly currentContentSha256: string;
  readonly verified: boolean;
}

export interface RenderedJudgementMaterial {
  readonly text: string;
  readonly evidenceVerification: readonly EvidenceContentVerification[];
  readonly evidenceVerified: boolean;
}

function isInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (!fromParent.startsWith("..") && !isAbsolute(fromParent));
}

function resolveFile(
  repoRoot: string,
  locator: string,
  description: string,
): string {
  const path = resolve(repoRoot, locator);
  if (!isInside(repoRoot, path)) {
    throw new Error(`${description} must resolve inside the repository: ${locator}.`);
  }
  if (!existsSync(path)) throw new Error(`${description} is missing: ${locator}.`);
  const canonicalPath = realpathSync(path);
  if (!isInside(repoRoot, canonicalPath) || !statSync(canonicalPath).isFile()) {
    throw new Error(`${description} must resolve to a file inside the repository: ${locator}.`);
  }
  return canonicalPath;
}

function readJson(path: string, locator: string, description: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${description} is not valid JSON: ${locator}: ${detail}`);
  }
}

function readObservation(input: RenderJudgementMaterialInput, repoRoot: string): IntakeObservationRecordV2 {
  if (!OBSERVATION_ID.test(input.observationId)) {
    throw new Error("Observation id must be a lowercase SHA-256.");
  }
  const locator = `${INTAKE_OBSERVATION_DIRECTORY}/${input.observationId}.json`;
  const path = resolveFile(repoRoot, locator, "Intake observation");
  let record: ReturnType<typeof readIntakeJournalRecord>;
  try {
    record = readIntakeJournalRecord(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Intake observation is invalid: ${locator}: ${detail}`);
  }
  if (record.schemaVersion !== INTAKE_OBSERVATION_SCHEMA_V2) {
    throw new Error(`Intake observation does not carry action operands: ${locator}.`);
  }
  if (record.observationId !== input.observationId) {
    throw new Error(`Intake observation filename does not match its identity: ${locator}.`);
  }
  return record;
}

function readCandidate(
  repoRoot: string,
  observation: IntakeObservationRecordV2,
): OutcomeEnvelope {
  const locator = observation.candidate.locator;
  const path = resolveFile(repoRoot, locator, "Pinned candidate artifact");
  const raw = readJson(path, locator, "Pinned candidate artifact");
  const actualHash = canonicalJsonSha256(raw);
  if (actualHash !== observation.candidate.contentSha256) {
    throw new Error(
      `Pinned candidate artifact canonical hash mismatch for ${locator}: ` +
      `expected ${observation.candidate.contentSha256}, received ${actualHash}.`,
    );
  }
  try {
    return parseOutcomeEnvelope(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Pinned candidate artifact is invalid: ${locator}: ${detail}`);
  }
}

function readSnapshot(
  repoRoot: string,
  observation: IntakeObservationRecordV2,
): IntakeSnapshotV1 {
  const locator = observation.snapshot.locator;
  const path = resolveFile(repoRoot, locator, "Pinned snapshot artifact");
  const raw = readJson(path, locator, "Pinned snapshot artifact");
  let snapshot: IntakeSnapshotV1;
  try {
    // The parser verifies the producer's defined-core canonical hash. Hashing the raw file bytes
    // here would reject semantically identical, re-indented snapshots.
    snapshot = parseIntakeSnapshotV1(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Pinned snapshot artifact is invalid: ${locator}: ${detail}`);
  }
  if (snapshot.contentSha256 !== observation.snapshot.contentSha256) {
    throw new Error(
      `Pinned snapshot artifact canonical hash mismatch for ${locator}: ` +
      `expected ${observation.snapshot.contentSha256}, received ${snapshot.contentSha256}.`,
    );
  }
  return snapshot;
}

function observedCandidate(
  envelope: OutcomeEnvelope,
  observation: IntakeObservationRecordV2,
): OutcomeCandidate {
  const matches = envelope.candidates.filter(
    ({ sourceFingerprint }) => sourceFingerprint === observation.candidate.sourceFingerprint,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Pinned candidate artifact must contain exactly one candidate with source fingerprint ` +
      `${observation.candidate.sourceFingerprint}; found ${matches.length}.`,
    );
  }
  return matches[0];
}

function indented(contents: string): string {
  if (contents === "") return "    (empty file)";
  return contents.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function evidenceMaterial(repoRoot: string, candidate: OutcomeCandidate): {
  readonly lines: string[];
  readonly verification: EvidenceContentVerification[];
} {
  const lines = ["## Evidence contents", ""];
  const verification: EvidenceContentVerification[] = [];
  if (candidate.evidence.length === 0) {
    lines.push("The candidate contains zero evidence entries.", "");
    return { lines, verification };
  }
  for (const evidence of candidate.evidence) {
    const path = resolveFile(repoRoot, evidence.sourceLocator, `Evidence ${evidence.id}`);
    const bytes = readFileSync(path);
    const contents = bytes.toString("utf8");
    const currentContentSha256 = outcomeSourceContentSha256(bytes);
    const verified = outcomeSourceContentMatchesSha256(bytes, evidence.contentSha256);
    verification.push({
      evidenceId: evidence.id,
      sourceLocator: evidence.sourceLocator,
      recordedContentSha256: evidence.contentSha256,
      currentContentSha256,
      verified,
    });
    lines.push(
      `### ${evidence.id}`,
      "",
      `- kind: ${evidence.kind}`,
      `- sourceLocator: ${evidence.sourceLocator}`,
      `- recordedContentSha256: ${evidence.contentSha256}`,
      `- currentContentSha256: ${currentContentSha256}`,
      "",
      verified
        ? "> **EVIDENCE CONTENT VERIFIED AGAINST RECORDED SHA-256**"
        : "> **!!! EVIDENCE CONTENT DRIFT: CURRENT CONTENT IS NOT THE PINNED VERSION !!!**",
      "",
      "Contents:",
      "",
      indented(contents),
      "",
    );
  }
  return { lines, verification };
}

function comparableIssueMaterial(snapshot: IntakeSnapshotV1): string[] {
  const lines = [
    "## Comparable issues",
    "",
    "Comparable issue bodies are unavailable as prose; issue bodies are available only as digests in the pinned snapshot.",
    "",
  ];
  if (snapshot.issues.length === 0) {
    lines.push("The snapshot contains zero comparable issues.", "");
    return lines;
  }
  for (const issue of snapshot.issues) {
    lines.push(
      `- #${issue.number}: ${issue.title}`,
      `  bodySha256: ${issue.bodySha256}`,
    );
  }
  lines.push("");
  return lines;
}

/** Render the exact, deterministic text and evidence verification an operator judges. */
export function renderJudgementMaterialWithVerification(
  input: RenderJudgementMaterialInput,
): RenderedJudgementMaterial {
  const repoRoot = realpathSync(resolve(input.repoRoot));
  const observation = readObservation(input, repoRoot);
  const envelope = readCandidate(repoRoot, observation);
  const snapshot = readSnapshot(repoRoot, observation);
  if (snapshot.candidateSha256 !== observation.candidate.contentSha256) {
    throw new Error(
      `Pinned snapshot artifact ${observation.snapshot.locator} is bound to candidate ` +
      `${snapshot.candidateSha256}, not ${observation.candidate.contentSha256}.`,
    );
  }
  const candidate = observedCandidate(envelope, observation);
  const evidence = evidenceMaterial(repoRoot, candidate);
  const lines = [
    "# Roadmap judgement material",
    "",
    `Observation id: ${observation.observationId}`,
    "",
    "This material is not blinded: the operand vocabulary encodes the classifier's own call. " +
      "It is loop-validation material, not an independent measurement of classifier accuracy.",
    "",
    "## Candidate identity",
    "",
    `- title: ${candidate.outcome.title}`,
    `- stableOutcomeId: ${candidate.stableOutcomeId}`,
    `- sourceFingerprint: ${candidate.sourceFingerprint}`,
    `- producerKind: ${envelope.producer.kind}`,
    `- stableArtifactId: ${envelope.artifact.stableId}`,
    "",
    "## Completion rule",
    "",
    candidate.outcome.completionRule,
    "",
    ...evidence.lines,
    ...comparableIssueMaterial(snapshot),
    "## Action operands",
    "",
  ];
  for (const [index, operand] of observation.actionOperands.entries()) {
    lines.push(
      `### ${index + 1}. ${operand.action}`,
      "",
      `- observedDisposition: ${operand.observedDisposition}`,
      `- hypotheticalFullyQualifiedDisposition: ${operand.hypotheticalFullyQualifiedDisposition}`,
      `- proposedValue: ${operand.proposedValue ?? "null"}`,
      "",
    );
    if (observation.operandDerivationVersion === INTAKE_OBSERVATION_OPERAND_DERIVATION_VERSION_V1) {
      lines.push("This observation predates the competing-issue field; competitors were never recorded.", "");
    } else if (operand.competingIssueNumbers !== null) {
      lines.push("Competing issues:", "");
      for (const issueNumber of operand.competingIssueNumbers) {
        const issue = snapshot.issues.find(({ number }) => number === issueNumber);
        lines.push(issue === undefined
          ? `- #${issueNumber}: not found in the pinned intake snapshot`
          : `- #${issueNumber}: ${issue.title}`);
      }
      if (operand.competingIssueNumbers.length === 0) lines.push("- (recorded empty)");
      lines.push("");
    }
  }
  lines.push(
    "## Operator counterfactuals",
    "",
    "would the observed proposal have executed a sensitive action automatically under a qualified capability manifest?",
    "",
    "given the issue context another agent already wrote, is this outcome simple enough " +
      "for an implementation agent to complete on its own?",
    "",
  );
  return {
    text: `${lines.join("\n")}\n`,
    evidenceVerification: evidence.verification,
    evidenceVerified: evidence.verification.every(({ verified }) => verified),
  };
}

/** Render only the operator-facing text. */
export function renderJudgementMaterial(input: RenderJudgementMaterialInput): string {
  return renderJudgementMaterialWithVerification(input).text;
}
