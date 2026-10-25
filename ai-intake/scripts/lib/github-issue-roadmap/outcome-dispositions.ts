import { resolve } from "node:path";

import { runCredentialCleanGit } from "./credential-clean-git";
import { canonicalJson } from "./canonical-json";
import {
  dispositionHistory,
  dispositionHistoryRef,
  sidecarHistory,
  type DispositionHistoryEntry,
  type DispositionHistoryOptions,
} from "./disposition-history";
import { parseOutcomeEnvelope } from "./outcome-candidate";

export const OUTCOME_DISPOSITIONS_SCHEMA_VERSION = "github-issue-roadmap-outcome-dispositions/v1";

export interface DispositionCommitEvidence {
  readonly sha: string;
  readonly subject: string;
  readonly advisoryPrNumber: number | null;
}

interface DispositionEntryBase {
  readonly stableArtifactId: string;
  readonly artifactSourceLocator: string;
  readonly stableOutcomeId: string;
  readonly title: string;
  readonly note: string;
  readonly sidecarLocator: string;
  readonly sidecarBlob: string;
  readonly introducingCommit: DispositionCommitEvidence;
  readonly candidateResolved: boolean;
  readonly dispositionedAtRef: boolean;
  readonly conflicting: boolean;
}

export type OutcomeDispositionEntry = DispositionEntryBase & (
  | { readonly kind: "achieved"; readonly commits: readonly DispositionCommitEvidence[] }
  | {
    readonly kind: "superseded";
    readonly target: {
      readonly stableArtifactId: string;
      readonly stableOutcomeId: string;
      readonly title: string | null;
    };
    readonly targetResolved: boolean;
  }
);

export interface OutcomeDispositions {
  readonly schemaVersion: typeof OUTCOME_DISPOSITIONS_SCHEMA_VERSION;
  readonly ref: string;
  readonly refSha: string;
  readonly entries: readonly OutcomeDispositionEntry[];
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The history lookup owns the entry set; the pinned tree only resolves current identities. */
export function buildOutcomeDispositions(ref = "HEAD", options: DispositionHistoryOptions = {}): OutcomeDispositions {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runGit = options.runGit ?? runCredentialCleanGit;
  const gitOptions = { localObjectsOnly: true } as const;
  const historyOptions = { repoRoot, runGit };
  const refSha = dispositionHistoryRef(ref, historyOptions);
  const history = dispositionHistory(refSha, historyOptions);
  if (history.size === 0) return { schemaVersion: OUTCOME_DISPOSITIONS_SCHEMA_VERSION, ref, refSha, entries: [] };
  const sidecars = sidecarHistory(refSha, historyOptions);
  const historicalEnvelopes = new Map(sidecars.map(sidecar => [sidecar.blob, sidecar.envelope]));
  const targetTitles = new Map<string, string[]>();
  const currentDispositions = new Map<string, Set<string>>();

  const tree = runGit(repoRoot, ["ls-tree", "--full-tree", "-r", "-z", refSha, "--", "artifacts/github-issue-roadmap"], gitOptions);
  const currentPaths = new Set(tree.split("\0").flatMap(line => {
    const match = /^100(?:644|755) blob [a-f0-9]+\t(.+)$/.exec(line);
    if (match === null) return [];
    const locator = match[1];
    return locator.endsWith(".roadmap-outcomes.json") || /\/outcome-candidate--[^/]+$/.test(locator) ? [locator] : [];
  }));
  // Read committed blobs, never working-tree files. Missing paths are expected after paired deletion.
  for (const locator of [...currentPaths].sort(compareStrings)) {
    const contents = runGit(repoRoot, ["cat-file", "blob", `${refSha}:${locator}`], { ...gitOptions, output: "base64" });
    const envelope = parseOutcomeEnvelope(JSON.parse(Buffer.from(contents, "base64").toString("utf8")));
    for (const candidate of envelope.candidates) {
      const key = `${envelope.artifact.stableId}\0${candidate.stableOutcomeId}`;
      const titles = targetTitles.get(key) ?? [];
      titles.push(candidate.outcome.title);
      targetTitles.set(key, titles);
      if (candidate.disposition !== undefined) {
        const dispositions = currentDispositions.get(key) ?? new Set<string>();
        dispositions.add(canonicalJson(candidate.disposition));
        currentDispositions.set(key, dispositions);
      }
    }
  }

  const commitEvidence = new Map<string, DispositionCommitEvidence>();
  function readCommit(sha: string): DispositionCommitEvidence {
    const cached = commitEvidence.get(sha);
    if (cached !== undefined) return cached;
    const subject = runGit(repoRoot, ["show", "--no-patch", "--no-show-signature", "--format=%s", sha, "--"], gitOptions);
    const suffix = /\(#([1-9][0-9]*)\)$/.exec(subject);
    const number = suffix === null ? null : Number(suffix[1]);
    const evidence = { sha, subject, advisoryPrNumber: number !== null && Number.isSafeInteger(number) ? number : null };
    commitEvidence.set(sha, evidence);
    return evidence;
  }

  const commitOrder = new Map(runGit(repoRoot, ["rev-list", "--topo-order", "--reverse", refSha], gitOptions)
    .split(/\r?\n/).map((sha, index) => [sha, index] as const));
  const records = [...history.values()].flat().sort((left, right) => {
    const leftOrder = commitOrder.get(left.introducingCommit);
    const rightOrder = commitOrder.get(right.introducingCommit);
    if (leftOrder === undefined || rightOrder === undefined) throw new Error("Disposition history commit is outside the ref's ancestry.");
    return leftOrder - rightOrder || compareStrings(
      [left.sidecarLocator, left.blob].join("\0"), [right.sidecarLocator, right.blob].join("\0"),
    );
  });
  const uniqueRecords = new Map<string, DispositionHistoryEntry>();
  const dispositionsByOutcome = new Map<string, Set<string>>();
  for (const record of records) {
    const identity = `${record.stableArtifactId}\0${record.stableOutcomeId}`;
    const disposition = canonicalJson(record.disposition);
    const key = `${identity}\0${disposition}`;
    if (!uniqueRecords.has(key)) uniqueRecords.set(key, record);
    const dispositions = dispositionsByOutcome.get(identity) ?? new Set<string>();
    dispositions.add(disposition);
    dispositionsByOutcome.set(identity, dispositions);
  }
  const sortedRecords = [...uniqueRecords].sort(([left], [right]) => compareStrings(left, right));
  const entries = sortedRecords.map(([, record]): OutcomeDispositionEntry => {
    const envelope = historicalEnvelopes.get(record.blob);
    const candidate = envelope?.candidates.find(candidate => candidate.stableOutcomeId === record.stableOutcomeId);
    if (envelope === undefined || candidate === undefined) throw new Error("Disposition history is missing its candidate envelope.");
    const identity = `${record.stableArtifactId}\0${record.stableOutcomeId}`;
    const base: DispositionEntryBase = {
      stableArtifactId: record.stableArtifactId,
      artifactSourceLocator: envelope.artifact.sourceLocator,
      stableOutcomeId: record.stableOutcomeId,
      title: candidate.outcome.title,
      note: record.disposition.note,
      sidecarLocator: record.sidecarLocator,
      sidecarBlob: record.blob,
      introducingCommit: readCommit(record.introducingCommit),
      candidateResolved: targetTitles.has(identity),
      dispositionedAtRef: currentDispositions.get(identity)?.has(canonicalJson(record.disposition)) ?? false,
      conflicting: (dispositionsByOutcome.get(identity)?.size ?? 0) > 1,
    };
    if (record.disposition.kind === "achieved") {
      return { ...base, kind: "achieved", commits: [...record.disposition.commits]
        .sort((left, right) => compareStrings(left.sha, right.sha)).map(commit => readCommit(commit.sha)) };
    }
    const target = record.disposition.target;
    const titles = targetTitles.get(`${target.stableArtifactId}\0${target.stableOutcomeId}`) ?? [];
    const targetResolved = titles.length === 1;
    return { ...base, kind: "superseded", target: { ...target, title: targetResolved ? titles[0] : null }, targetResolved };
  });
  return { schemaVersion: OUTCOME_DISPOSITIONS_SCHEMA_VERSION, ref, refSha, entries };
}
