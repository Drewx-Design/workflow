import { resolve } from "node:path";

import { canonicalJsonSha256 } from "./canonical-json";
import { runCredentialCleanGit, type GitRunner } from "./credential-clean-git";
import { activeOutcomeCandidates, parseOutcomeEnvelope } from "./outcome-candidate";
import type { CriteriaAuthorship, DispositionHistory, DispositionHistoryEntry, DispositionHistoryOptions, HistoricalSidecar } from "./disposition-selection";

export { effectiveOutcomeCandidates } from "./disposition-selection";
export type { CriteriaAuthorship, CriteriaAuthorshipLookup, DispositionHistory, DispositionHistoryEntry, DispositionHistoryLookup, DispositionHistoryOptions, HistoricalSidecar } from "./disposition-selection";

interface HistoryIndex {
  readonly sidecars: readonly HistoricalSidecar[];
  readonly dispositions: DispositionHistory;
  firstParentSidecars?: readonly HistoricalSidecar[];
}
const cache = new WeakMap<GitRunner, Map<string, HistoryIndex>>();
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Resolve once at admission; apply deliberately calls this again before each write. */
export function dispositionHistoryRef(ref = "origin/main", options: DispositionHistoryOptions = {}): string {
  const runGit = options.runGit ?? runCredentialCleanGit;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  let shallow: string;
  try {
    shallow = runGit(repoRoot, ["rev-parse", "--is-shallow-repository"], { localObjectsOnly: true }).trim();
  } catch (cause) {
    throw new Error(`disposition_history_unavailable: cannot read ${ref}.`, { cause });
  }
  if (shallow !== "false") throw new Error("disposition_history_unavailable: shallow repository; history is incomplete.");
  try {
    const sha = runGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`], { localObjectsOnly: true }).trim();
    if (!OID.test(sha)) throw new Error("Expected a full commit ID.");
    return sha;
  } catch (cause) {
    throw new Error(`disposition_history_unavailable: cannot read ${ref}.`, { cause });
  }
}

/** Walk all parents, including deleted sidecars and dispositions on merged branches.
 * Parse each distinct blob once per pinned SHA. Keep provenance for query/authorship consumers. */
function historyAt(ref: string, options: DispositionHistoryOptions) {
  const runGit = options.runGit ?? runCredentialCleanGit;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const sha = dispositionHistoryRef(ref, { repoRoot, runGit });
  const key = `${repoRoot}\0${sha}`;
  let entries = cache.get(runGit);
  if (entries === undefined) { entries = new Map(); cache.set(runGit, entries); }
  const cached = entries.get(key);
  if (cached !== undefined) return cached;
  try {
    const changes = runGit(repoRoot, ["log", "--full-history", "--reverse", "--topo-order", "--root", "-m",
      "--raw", "--no-abbrev", "--no-renames", "--format=%H", sha, "--",
      ":(glob)artifacts/github-issue-roadmap/**/outcome-candidate--*",
      ":(glob)artifacts/github-issue-roadmap/**/*.roadmap-outcomes.json"], { localObjectsOnly: true });
    const sidecars: HistoricalSidecar[] = [];
    const dispositions = new Map<string, DispositionHistoryEntry[]>();
    const seen = new Set<string>();
    let introducingCommit = "";
    for (const line of changes.split(/\r?\n/)) {
      if (OID.test(line)) { introducingCommit = line; continue; }
      const change = /^:\d{6} (\d{6}) [a-f0-9]+ ([a-f0-9]+) [A-Z]\t(.+)$/.exec(line);
      if (change === null || change[1] === "000000") continue;
      const [, mode, blob, sidecarLocator] = change;
      if (!["100644", "100755"].includes(mode) || !OID.test(introducingCommit)) throw new Error("Invalid historical sidecar.");
      if (seen.has(blob)) continue;
      seen.add(blob);
      const output = runGit(repoRoot, ["cat-file", "blob", blob], { output: "base64", localObjectsOnly: true });
      const bytes = Buffer.from(output, "base64");
      if (bytes.toString("base64") !== output) {
        throw new Error(`disposition_history_unavailable: git_runner_ignored_output_option: ${sidecarLocator} blob ${blob} at ${introducingCommit}.`);
      }
      let envelope: ReturnType<typeof parseOutcomeEnvelope>;
      try {
        envelope = parseOutcomeEnvelope(JSON.parse(bytes.toString("utf8")));
      } catch (cause) {
        throw new Error(`disposition_history_unavailable: cannot parse ${sidecarLocator} blob ${blob} at ${introducingCommit}.`, { cause });
      }
      sidecars.push({ introducingCommit, sidecarLocator, blob, envelope });
      for (const candidate of activeOutcomeCandidates(envelope).dispositioned) {
        const records = dispositions.get(candidate.stableOutcomeId) ?? [];
        records.push({ stableArtifactId: envelope.artifact.stableId, stableOutcomeId: candidate.stableOutcomeId,
          disposition: candidate.disposition!, introducingCommit, sidecarLocator, blob });
        dispositions.set(candidate.stableOutcomeId, records);
      }
    }
    const result: HistoryIndex = { sidecars, dispositions };
    entries.set(key, result);
    return result;
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("disposition_history_unavailable:")) throw cause;
    throw new Error(`disposition_history_unavailable: cannot index ${sha}.`, { cause });
  }
}

export function sidecarHistory(ref: string, options: DispositionHistoryOptions = {}): readonly HistoricalSidecar[] {
  return historyAt(ref, options).sidecars;
}

export function dispositionHistory(ref: string, options: DispositionHistoryOptions = {}): DispositionHistory {
  return historyAt(ref, options).dispositions;
}

/** Locate the filed revision by both marker hashes, then return the first-ever
 * first-parent commit carrying its parser-normalized, authored-order criteria.
 * Reverts do not reset authorship. The closer must require strict ancestry of
 * the satisfying merge commit; this lookup never reads commit dates. */
export function criteriaAuthorship(
  fingerprint: string,
  emissionContentSha256: string,
  ref = "origin/main",
  options: DispositionHistoryOptions = {},
): CriteriaAuthorship {
  const runGit = options.runGit ?? runCredentialCleanGit;
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const sha = dispositionHistoryRef(ref, { repoRoot, runGit });
  const indexed = historyAt(sha, { repoRoot, runGit });
  if (indexed.firstParentSidecars === undefined) {
    try {
      const changes = runGit(repoRoot, ["log", "--full-history", "--first-parent", "--diff-merges=first-parent",
        "--reverse", "--topo-order", "--root", "--raw", "--no-abbrev", "--no-renames", "--format=%H", sha, "--",
        ":(glob)artifacts/github-issue-roadmap/**/outcome-candidate--*",
        ":(glob)artifacts/github-issue-roadmap/**/*.roadmap-outcomes.json"], { localObjectsOnly: true });
      const envelopes = new Map(indexed.sidecars.map(sidecar => [sidecar.blob, sidecar.envelope]));
      const sidecars: HistoricalSidecar[] = [];
      const seen = new Set<string>();
      let introducingCommit = "";
      for (const line of changes.split(/\r?\n/)) {
        if (OID.test(line)) { introducingCommit = line; continue; }
        const change = /^:\d{6} (\d{6}) [a-f0-9]+ ([a-f0-9]+) [A-Z]\t(.+)$/.exec(line);
        if (change === null || change[1] === "000000") continue;
        const [, mode, blob, sidecarLocator] = change;
        const envelope = envelopes.get(blob);
        if (!["100644", "100755"].includes(mode) || !OID.test(introducingCommit) || envelope === undefined) {
          throw new Error("Invalid first-parent sidecar.");
        }
        if (seen.has(blob)) continue;
        seen.add(blob);
        sidecars.push({ introducingCommit, sidecarLocator, blob, envelope });
      }
      indexed.firstParentSidecars = sidecars;
    } catch (cause) {
      throw new Error(`disposition_history_unavailable: cannot read first-parent sidecars at ${sha}.`, { cause });
    }
  }
  const revisions = indexed.firstParentSidecars.flatMap(sidecar => sidecar.envelope.candidates
    .filter(candidate => candidate.sourceFingerprint === fingerprint)
    .map(candidate => ({ candidate, introducingCommit: sidecar.introducingCommit })));
  const filed = revisions.find(revision => revision.candidate.emissionContentSha256 === emissionContentSha256);
  if (filed === undefined || !filed.candidate.acceptanceCriteria?.length) return "unknown";
  const criteriaSha256 = canonicalJsonSha256(filed.candidate.acceptanceCriteria);
  const first = revisions.find(revision => revision.candidate.acceptanceCriteria?.length &&
    canonicalJsonSha256(revision.candidate.acceptanceCriteria) === criteriaSha256)!;
  return { introducingCommit: first.introducingCommit, criteriaSha256 };
}
