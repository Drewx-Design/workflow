import { readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertDistinctRoadmapArtifactPaths,
  assertRoadmapArtifactOutputPath,
  writeRoadmapArtifactAtomically,
} from "./lib/github-issue-roadmap/artifact-io";
import {
  createOutcomeEnvelope,
  outcomeEnvelopeJson,
  type OutcomeEnvelope,
  type ProducerKind,
} from "./lib/github-issue-roadmap/outcome-candidate";
import { dispositionHistory, effectiveOutcomeCandidates } from "./lib/github-issue-roadmap/disposition-history";

const MAX_CANDIDATE_BYTES = 1_048_576;

interface CandidateCliArgs {
  readonly input: string;
  readonly out: string;
}

export interface CandidateCliResult {
  readonly candidateCount: number;
  readonly producerKind: ProducerKind;
  readonly outputPath: string;
  readonly skipped: readonly { readonly sourceFingerprint: string; readonly status: "dispositioned" }[];
}

function parseArgs(argv: readonly string[]): CandidateCliArgs {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--(in|out)=(.+)$/.exec(arg);
    if (match === null) throw new Error(`Unsupported argument: ${arg}`);
    if (values.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    values.set(match[1], match[2]);
  }
  for (const name of ["in", "out"] as const) {
    if (!values.has(name)) throw new Error(`Missing required --${name}=PATH argument.`);
  }
  return { input: values.get("in") as string, out: values.get("out") as string };
}

function assertCandidateInputPath(inputPath: string, repoRoot: string): string {
  const logical = resolve(repoRoot, inputPath);
  let root: string;
  let input: string;
  try {
    root = realpathSync(resolve(repoRoot));
    input = realpathSync(logical);
  } catch {
    throw new Error("The --in path must name an existing JSON file inside the repository.");
  }
  const fromRoot = relative(root, input);
  if (
    fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot) ||
    fromRoot.split(/[\\/]/)[0].toLowerCase() === ".git" || extname(input).toLowerCase() !== ".json"
  ) {
    throw new Error("The --in path must name a JSON file inside the repository and outside .git.");
  }
  const stats = statSync(input);
  if (!stats.isFile()) throw new Error("The --in path must name a JSON file, not a directory.");
  if (stats.size > MAX_CANDIDATE_BYTES) {
    throw new Error(`The --in candidate JSON exceeds the ${MAX_CANDIDATE_BYTES}-byte safety limit.`);
  }
  return input;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Outcome candidate input could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * A producer authors semantic content. The source fingerprint and emission hash are *derived* from
 * that content and must never be authored, so this accepts an envelope with or without them and
 * always derives. When the input already carries them, the derived values are compared against the
 * supplied ones and a mismatch is refused — a producer must not be able to choose its own
 * idempotency key, which is exactly what a hand-written fingerprint would be.
 */
export function deriveOutcomeEnvelope(rawValue: unknown): OutcomeEnvelope {
  if (rawValue === null || typeof rawValue !== "object" || Array.isArray(rawValue)) {
    throw new Error("outcome envelope must be an object.");
  }
  const source = rawValue as Record<string, unknown>;
  if (!Array.isArray(source.candidates)) throw new Error("outcome envelope.candidates must be an array.");

  const supplied: { index: number; sourceFingerprint?: unknown; emissionContentSha256?: unknown }[] = [];
  const material = source.candidates.map((candidate, index) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
    const { sourceFingerprint, emissionContentSha256, ...rest } = candidate as Record<string, unknown>;
    if (sourceFingerprint !== undefined || emissionContentSha256 !== undefined) {
      supplied.push({ index, sourceFingerprint, emissionContentSha256 });
    }
    return rest;
  });

  const envelope = createOutcomeEnvelope({ ...source, candidates: material });
  for (const entry of supplied) {
    const derived = envelope.candidates[entry.index];
    if (entry.sourceFingerprint !== undefined && entry.sourceFingerprint !== derived.sourceFingerprint) {
      throw new Error(`outcome envelope.candidates[${entry.index}].sourceFingerprint does not match the fingerprint derived from this envelope's identity.`);
    }
    if (entry.emissionContentSha256 !== undefined && entry.emissionContentSha256 !== derived.emissionContentSha256) {
      throw new Error(`outcome envelope.candidates[${entry.index}].emissionContentSha256 does not match the hash derived from this candidate's content.`);
    }
  }
  return envelope;
}

export function runCandidateCli(
  argv: readonly string[],
  repoRoot = process.cwd(),
  readHistory = dispositionHistory,
): CandidateCliResult {
  const args = parseArgs(argv);
  const inputPath = assertCandidateInputPath(args.input, repoRoot);
  const outputPath = assertRoadmapArtifactOutputPath(args.out, repoRoot);
  assertDistinctRoadmapArtifactPaths([
    { label: "--in", path: inputPath },
    { label: "--out", path: outputPath },
  ], repoRoot);
  const envelope = deriveOutcomeEnvelope(readJson(inputPath));
  const selection = effectiveOutcomeCandidates(envelope, readHistory("origin/main", { repoRoot }));
  writeRoadmapArtifactAtomically(outputPath, outcomeEnvelopeJson(envelope));
  console.log(
    `Validated ${selection.active.length} active ${envelope.producer.kind} outcome candidate(s), ${selection.dispositioned.length} dispositioned; ` +
    `wrote canonical envelope to ${relative(repoRoot, outputPath)}.`,
  );
  return {
    candidateCount: selection.active.length,
    skipped: selection.dispositioned.map(candidate => ({ sourceFingerprint: candidate.sourceFingerprint, status: "dispositioned" })),
    producerKind: envelope.producer.kind,
    outputPath,
  };
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    runCandidateCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
