import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeRoadmapArtifactAtomically } from "./lib/github-issue-roadmap/artifact-io";
import { runCredentialCleanGit, type GitRunner } from "./lib/github-issue-roadmap/credential-clean-git";
import { dispositionHistory, effectiveOutcomeCandidates } from "./lib/github-issue-roadmap/disposition-history";
import {
  createExistenceRecord,
  existenceCitationContentSha256,
  existenceRecordJson,
  type ExistenceCodeCitation,
  type ExistenceEntryInput,
  type ExistenceRecordV1,
} from "./lib/github-issue-roadmap/existence-record";
import {
  parseOutcomeEnvelope,
  type OutcomeCandidate,
  type OutcomeEnvelope,
  type OutcomeRepositoryIdentity,
} from "./lib/github-issue-roadmap/outcome-candidate";

type CliArgs = {
  readonly candidate: string;
  readonly out: string;
  readonly budget: number;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const EXPORT_PATH = "(?:(?:[A-Za-z0-9_.@+-]+/)+[A-Za-z0-9_.@+-]*[A-Za-z0-9_@+-]|[A-Za-z0-9_.@+-]+\\.[A-Za-z0-9_@+-]+)";
const EXPORT_TAIL = "(?<tail>\\s+(?:from|in)\\s+(?<path>`" + EXPORT_PATH + "`|" + EXPORT_PATH + "))?";

function exportAssertionPattern(identifier: string, passive = false): RegExp {
  const head = passive
    ? "^`" + identifier + "`\\s+(?:is|must be)\\s+exported"
    : "^(?<predicate>(?:and\\s+)?(?:(?:the\\s+)?repository\\s+)?(?:must\\s+)?exports?\\s+)`" + identifier + "`";
  return new RegExp(head + EXPORT_TAIL + "[.!?]?\\s*$", "i");
}

export function decomposeCompletionRule(completionRule: string): string[] {
  // Common abbreviations do not end a sentence, even before a capitalized example.
  return completionRule
    .split(/(?:\r?\n|;|(?<!\b(?:[Ee]\.[Gg]|[Ii]\.[Ee]|[Vv][Ss]|[Ee][Tt][Cc]|[Nn][Oo])\.)(?<=[.!?])\s+(?=[A-Z]))+/)
    // Preserve quoted enumerated cases, but do not turn dependent article phrases into requirements.
    .flatMap((clause) => {
      const fragments = clause.split(/,\s+(?:and\s+)?(?=['"`])/i);
      const head = fragments[0].trim();
      const identifier = quotedIdentifiers(head)[0];
      const match = identifier === undefined || !assertsExport(head, identifier)
        ? null : exportAssertionPattern(identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).exec(head);
      const predicate = match?.groups?.predicate;
      if (predicate === undefined) return fragments;
      const bareIdentifier = /^[`'"][^`'"]+[`'"](?:\s+(?:from|in)\s+\S+)?[.!?]?\s*$/i;
      const sharedTail = fragments.slice(1).every((fragment) => bareIdentifier.test(fragment))
        ? new RegExp(EXPORT_TAIL + "[.!?]?\\s*$", "i").exec(fragments[fragments.length - 1])?.groups?.tail
        : undefined;
      // A fragment that names its own from/in path keeps it; the shared tail binds only the bare ones.
      const ownTail = new RegExp("\\s+(?:from|in)\\s+\\S+[.!?]?\\s*$", "i");
      let carry = true;
      return fragments.map((fragment, index) => {
        if (index > 0 && !bareIdentifier.test(fragment)) carry = false;
        const carried = index > 0 && carry ? predicate + fragment : fragment;
        return sharedTail !== undefined && index < fragments.length - 1 && !ownTail.test(fragment)
          ? carried.replace(/[.!?]?\s*$/, "") + sharedTail : carried;
      });
    })
    // A coordinated article phrase is independent only with an explicit predicate before the next boundary.
    .flatMap((clause) => clause.split(
      /,\s+and\s+(?=(?:the|a|an|neither|no)\s+[^,;.!?]+?\b(?:is|are|must|shall|requires?|advances?|reports?|reconciles?)\b)/i,
    ))
    .flatMap((clause) => clause.split(
      /\s+(?:and|plus)\s+(?=(?:the\s+)?(?:repository\s+)?(?:exports?|provides?|implements?|creates?|adds?|supports?|contains?)\b)/i,
    ))
    .map((clause) => clause.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function quotedIdentifiers(clause: string): string[] {
  return [...clause.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((value) => IDENTIFIER.test(value));
}

function namedPaths(clause: string): string[] {
  return [...clause.matchAll(/(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+/g)]
    .map((match) => match[0]);
}

/** Diagnostic only: absence of an anchor is not evidence of a missing implementation. */
export function clauseMatchability(clause: string): "anchored" | "structurally_unmatchable" {
  return namedPaths(clause).length > 0 || quotedIdentifiers(clause).length > 0
    ? "anchored" : "structurally_unmatchable";
}

function assertsExport(clause: string, identifier: string): boolean {
  // Negated, removed, and referential exports cannot witness a positive requirement.
  if (/\b(?:not|never|no longer|without|remove[sd]?|deletes?|documented|mentions?|refers?)\b/i.test(clause)) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Only a direct export assertion is witnessed by an export declaration; behavior needs stronger evidence.
  return exportAssertionPattern(escaped).test(clause) || exportAssertionPattern(escaped, true).test(clause);
}

function exportLine(contents: string, identifier: string): number | null {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(
    `\\bexport\\s+(?:default\\s+)?(?:declare\\s+)?(?:async\\s+)?` +
    `(?:(?:const|let|var|function|class|type|interface|enum)\\s+)?${escaped}\\b`,
  );
  const exportList = new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
  const lines = contents.split(/\r?\n/);
  const index = lines.findIndex((line) => declaration.test(line) || exportList.test(line));
  return index === -1 ? null : index + 1;
}

function citation(locator: string, contents: string, line: number): ExistenceCodeCitation {
  const bytes = Buffer.from(contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
  return {
    sourceLocator: locator,
    contentSha256: existenceCitationContentSha256(bytes),
    startLine: line,
    endLine: line,
  };
}

function isGitGrepNoMatch(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "status" in error
    && error.status === 1;
}

function findClauseCitation(
  clause: string,
  files: readonly string[],
  readFile: (locator: string) => string,
  findIdentifierLocators: (identifier: string) => readonly string[],
): ExistenceCodeCitation | null {
  // A path is a search constraint, never a line-1 witness of the described behavior.
  const exportPath = new RegExp(EXPORT_TAIL + "[.!?]?\\s*$", "i").exec(clause)?.groups?.path;
  const paths = exportPath === undefined ? namedPaths(clause) : [exportPath.replace(/^`|`$/g, "")];
  const identifiers = quotedIdentifiers(clause);
  for (const identifier of identifiers) {
    if (!assertsExport(clause, identifier)) continue;
    for (const locator of findIdentifierLocators(identifier)) {
      if (!files.includes(locator) || (paths.length > 0 && !paths.includes(locator))) continue;
      const contents = readFile(locator);
      const line = exportLine(contents, identifier);
      if (line !== null) return citation(locator, contents, line);
    }
  }
  return null;
}

function evaluateCandidate(options: {
  readonly candidate: OutcomeCandidate;
  readonly repository: OutcomeRepositoryIdentity;
  readonly originMainSha: string;
  readonly clauses: readonly string[];
  readonly files: readonly string[];
  readonly repoRoot: string;
  readonly runGit: GitRunner;
}): ExistenceEntryInput {
  const cache = new Map<string, string>();
  const identifierLocatorCache = new Map<string, readonly string[]>();
  let repositorySearches = 0;
  const readFile = (locator: string) => {
    const cached = cache.get(locator);
    if (cached !== undefined) return cached;
    const contents = options.runGit(options.repoRoot, ["show", `${options.originMainSha}:${locator}`]);
    cache.set(locator, contents);
    return contents;
  };
  const findIdentifierLocators = (identifier: string): readonly string[] => {
    const cached = identifierLocatorCache.get(identifier);
    if (cached !== undefined) return cached;
    repositorySearches += 1;
    let output = "";
    try {
      output = options.runGit(options.repoRoot, [
        "grep", "-n", "--fixed-strings", identifier, options.originMainSha, "--",
      ]);
    } catch (error) {
      if (isGitGrepNoMatch(error)) {
        identifierLocatorCache.set(identifier, []);
        return [];
      }
      throw error;
    }
    const locators = [...new Set(output.split(/\r?\n/).flatMap((line) => {
      const match = /^(.*?):\d+:/.exec(line.slice(`${options.originMainSha}:`.length));
      if (!line.startsWith(`${options.originMainSha}:`)) return [];
      if (match === null || !options.files.includes(match[1])) return [];
      return [match[1]];
    }))];
    identifierLocatorCache.set(identifier, locators);
    return locators;
  };
  const clauses = options.clauses.map((clause) => {
    const found = findClauseCitation(
      clause,
      options.files,
      readFile,
      findIdentifierLocators,
    );
    return found === null
      ? { clause, satisfied: false as const }
      : { clause, satisfied: true as const, citation: found };
  });
  const satisfiedClauses = clauses.filter((clause) => clause.satisfied);
  if (satisfiedClauses.length === 0) {
    return {
      sourceFingerprint: options.candidate.sourceFingerprint,
      emissionContentSha256: options.candidate.emissionContentSha256,
      evidence: {
        clauses,
        searchAttestation: {
          scope: ["origin/main:**/*", "producer-independent:path-and-export-inventory"],
          budgetConsumed: cache.size + repositorySearches + 1,
          clausesEvaluated: clauses.length,
          clausesTotal: clauses.length,
        },
      },
    };
  }
  if (satisfiedClauses.length !== clauses.length) {
    return {
      sourceFingerprint: options.candidate.sourceFingerprint,
      emissionContentSha256: options.candidate.emissionContentSha256,
      evidence: { clauses },
    };
  }
  const citedPaths = [...new Set(satisfiedClauses.map((clause) => clause.citation.sourceLocator))];
  const mergeCommitSha = options.runGit(options.repoRoot, [
    "log", "-1", "--format=%H", options.originMainSha, "--", ...citedPaths,
  ]);
  return {
    sourceFingerprint: options.candidate.sourceFingerprint,
    emissionContentSha256: options.candidate.emissionContentSha256,
    evidence: {
      mergedCommitReceipt: {
        mergeCommitSha,
        url: `https://github.com/${options.repository.organization}/${options.repository.name}/commit/${mergeCommitSha}`,
      },
      satisfiedClauses,
    },
  };
}

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  for (const argument of argv) {
    const match = /^--(candidate|out|budget|origin-main-sha|sha)=(.+)$/.exec(argument);
    if (match === null) throw new Error(`Unsupported argument: ${argument}`);
    if (match[1] === "origin-main-sha" || match[1] === "sha") continue;
    if (values.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    values.set(match[1], match[2]);
  }
  for (const name of ["candidate", "out"] as const) {
    if (!values.has(name)) throw new Error(`Missing required --${name}=PATH argument.`);
  }
  const budgetText = values.get("budget");
  const budget = budgetText === undefined ? Number.MAX_SAFE_INTEGER : Number(budgetText);
  if (!Number.isSafeInteger(budget) || budget < 0) {
    throw new Error("--budget must be a non-negative integer.");
  }
  return { candidate: values.get("candidate")!, out: values.get("out")!, budget };
}

export function runExistenceProbeCli(
  argv: readonly string[],
  repoRoot = process.cwd(),
  runGit: GitRunner = runCredentialCleanGit,
  options: { readonly dispositionHistory?: typeof dispositionHistory } = {},
): ExistenceRecordV1 {
  const args = parseArgs(argv);
  const envelope = parseOutcomeEnvelope(JSON.parse(readFileSync(resolve(repoRoot, args.candidate), "utf8")));
  const originMainSha = runGit(repoRoot, ["rev-parse", "--verify", "origin/main^{commit}"]).trim();
  const record = probeExistence({ envelope, originMainSha, repoRoot, runGit, budget: args.budget, ...options }, () => new Date().toISOString());
  writeRoadmapArtifactAtomically(resolve(repoRoot, args.out), existenceRecordJson(record));
  return record;
}

/** Probe an immutable, caller-trusted commit without writing artifacts. */
export function probeExistenceAtSha(input: {
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly envelope: OutcomeEnvelope;
  readonly originMainSha: string;
  readonly repoRoot: string;
  readonly runGit: GitRunner;
  readonly budget: number;
  readonly generatedAt: string;
}): ExistenceRecordV1 {
  return probeExistence(input, () => input.generatedAt);
}

function probeExistence(input: {
  readonly dispositionHistory?: typeof dispositionHistory;
  readonly envelope: OutcomeEnvelope;
  readonly originMainSha: string;
  readonly repoRoot: string;
  readonly runGit: GitRunner;
  readonly budget: number;
}, generatedAt: () => string): ExistenceRecordV1 {
  const { envelope, originMainSha, repoRoot, runGit, budget } = input;
  const history = (input.dispositionHistory ?? dispositionHistory)(originMainSha, { repoRoot, runGit });
  const selection = effectiveOutcomeCandidates(envelope, history);
  for (const skipped of selection.dispositioned) console.log(`dispositioned: ${skipped.sourceFingerprint} (${skipped.stableOutcomeId}); skipped existence probe.`);
  let files: string[] | null = null;
  try {
    files = runGit(repoRoot, ["ls-tree", "-r", "--name-only", originMainSha])
      .split(/\r?\n/)
      .filter(Boolean)
      .map((locator) => locator.replaceAll("\\", "/"));
  } catch {
    // The SHA was established above; subsequent repository reads are advisory outcomes.
  }
  return createExistenceRecord({
    repository: envelope.repository,
    originMainSha,
    generatedAt: generatedAt(),
    entries: selection.active.map((candidate): ExistenceEntryInput => {
      const identity = {
        sourceFingerprint: candidate.sourceFingerprint,
        emissionContentSha256: candidate.emissionContentSha256,
      };
      if (files === null) return { ...identity, runOutcome: { kind: "read_failure" } };
      try {
        const clauses = decomposeCompletionRule(candidate.outcome.completionRule);
        const clausesToEvaluate = clauses.slice(0, budget);
        if (clausesToEvaluate.length === 0 && clauses.length > 0) {
          return {
            ...identity,
            runOutcome: { kind: "budget_exhausted", clausesEvaluated: 0, clausesTotal: clauses.length },
          };
        }
        const evaluated = evaluateCandidate({
          candidate,
          repository: envelope.repository,
          originMainSha,
          clauses: clausesToEvaluate,
          files,
          repoRoot,
          runGit,
        });
        if (clausesToEvaluate.length < clauses.length) {
          return {
            ...identity,
            runOutcome: {
              kind: "budget_exhausted",
              clausesEvaluated: clausesToEvaluate.length,
              clausesTotal: clauses.length,
            },
          };
        }
        return evaluated;
      } catch {
        return { ...identity, runOutcome: { kind: "read_failure" } };
      }
    }),
  });
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    runExistenceProbeCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
