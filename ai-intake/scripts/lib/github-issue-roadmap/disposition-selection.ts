import { activeOutcomeCandidates, type OutcomeDisposition, type OutcomeEnvelope } from "./outcome-candidate";

export interface DispositionHistoryOptions {
  readonly repoRoot?: string;
  readonly runGit?: (cwd: string, args: readonly string[], options?: {
    readonly output?: "base64";
    readonly localObjectsOnly?: boolean;
  }) => string;
}

export interface HistoricalSidecar {
  readonly introducingCommit: string;
  readonly sidecarLocator: string;
  readonly blob: string;
  readonly envelope: OutcomeEnvelope;
}

export interface DispositionHistoryEntry {
  readonly stableArtifactId: string;
  readonly stableOutcomeId: string;
  readonly disposition: OutcomeDisposition;
  readonly introducingCommit: string;
  readonly sidecarLocator: string;
  readonly blob: string;
}

export type DispositionHistory = ReadonlyMap<string, readonly DispositionHistoryEntry[]>;

export type DispositionHistoryLookup = (ref: string, options: DispositionHistoryOptions) => DispositionHistory;

export type CriteriaAuthorship = "unknown" | {
  readonly introducingCommit: string;
  readonly criteriaSha256: string;
};

export type CriteriaAuthorshipLookup = (fingerprint: string, emissionContentSha256: string,
  ref: string, options: DispositionHistoryOptions) => CriteriaAuthorship;

/** Outcome identity is terminal across artifacts; never mutate or rehash the input. */
export function effectiveOutcomeCandidates(envelope: OutcomeEnvelope, history: DispositionHistory) {
  const own = activeOutcomeCandidates(envelope);
  const skipped = new Set(own.dispositioned.map(candidate => candidate.stableOutcomeId));
  return {
    active: own.active.filter(candidate => !history.has(candidate.stableOutcomeId)),
    dispositioned: envelope.candidates.filter(candidate => skipped.has(candidate.stableOutcomeId) || history.has(candidate.stableOutcomeId)),
  };
}
