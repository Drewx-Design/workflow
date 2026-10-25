export const SWEEP_FINAL_STATES = [
  "duplicate",
  "unresolved",
  "held_pair_member",
  "corroborated_novel",
] as const;

export type SweepFinalState = typeof SWEEP_FINAL_STATES[number];
export type EscalationVerdict = "confirmed" | "unresolved" | "disproved";

export interface CensusClaimVerdict {
  readonly issueNumber: number;
  readonly verdict: EscalationVerdict;
}

export interface PairClaimVerdict {
  readonly otherSourceFingerprint: string;
  readonly verdict: EscalationVerdict;
}

export interface CandidateClaimSet {
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
  readonly committedAt: string;
  readonly censusClaims: readonly CensusClaimVerdict[];
  readonly pairClaims: readonly PairClaimVerdict[];
}

export interface CandidateSweepResolution {
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
  readonly finalState: SweepFinalState;
  readonly ladderRule: 1 | 2 | 3 | 4;
  readonly reason: string;
  readonly duplicateIssueNumber: number | null;
  readonly representativeSourceFingerprint: string | null;
}

function hasVerdict(
  claims: readonly { readonly verdict: EscalationVerdict }[],
  verdict: EscalationVerdict,
): boolean {
  return claims.some((claim) => claim.verdict === verdict);
}

/**
 * Returns the one priority-ladder rule which applies. The explicit suppression by
 * earlier rules makes first-match-wins visible and mechanically testable.
 */
export function matchingCandidateResolutionRules(input: {
  readonly censusVerdicts: ReadonlySet<EscalationVerdict>;
  readonly pairVerdicts: ReadonlySet<EscalationVerdict>;
}): readonly (1 | 2 | 3 | 4)[] {
  const censusConfirmed = input.censusVerdicts.has("confirmed");
  const anyUnresolved = input.censusVerdicts.has("unresolved") ||
    input.pairVerdicts.has("unresolved");
  const pairConfirmed = input.pairVerdicts.has("confirmed");
  return [
    ...(censusConfirmed ? [1 as const] : []),
    ...(!censusConfirmed && anyUnresolved ? [2 as const] : []),
    ...(!censusConfirmed && !anyUnresolved && pairConfirmed ? [3 as const] : []),
    ...(!censusConfirmed && !anyUnresolved && !pairConfirmed ? [4 as const] : []),
  ];
}

function ladderRule(candidate: CandidateClaimSet): 1 | 2 | 3 | 4 {
  const matches = matchingCandidateResolutionRules({
    censusVerdicts: new Set(candidate.censusClaims.map((claim) => claim.verdict)),
    pairVerdicts: new Set(candidate.pairClaims.map((claim) => claim.verdict)),
  });
  if (matches.length !== 1) {
    throw new Error(`Candidate ${candidate.sourceFingerprint} did not reach exactly one ladder rule.`);
  }
  return matches[0];
}

function compareCandidateAge(left: CandidateClaimSet, right: CandidateClaimSet): number {
  const dateOrder = Date.parse(left.committedAt) - Date.parse(right.committedAt);
  return dateOrder || left.sourceFingerprint.localeCompare(right.sourceFingerprint);
}

function confirmedPairComponents(candidates: readonly CandidateClaimSet[]): readonly string[][] {
  const known = new Set(candidates.map((candidate) => candidate.sourceFingerprint));
  const neighbours = new Map<string, Set<string>>(
    candidates.map((candidate) => [candidate.sourceFingerprint, new Set<string>()]),
  );
  for (const candidate of candidates) {
    for (const claim of candidate.pairClaims) {
      if (claim.verdict !== "confirmed") continue;
      if (!known.has(claim.otherSourceFingerprint)) {
        throw new Error(`Pair claim names unknown candidate ${claim.otherSourceFingerprint}.`);
      }
      neighbours.get(candidate.sourceFingerprint)!.add(claim.otherSourceFingerprint);
      neighbours.get(claim.otherSourceFingerprint)!.add(candidate.sourceFingerprint);
    }
  }

  const visited = new Set<string>();
  const components: string[][] = [];
  for (const fingerprint of [...known].sort()) {
    if (visited.has(fingerprint) || neighbours.get(fingerprint)!.size === 0) continue;
    const component: string[] = [];
    const pending = [fingerprint];
    visited.add(fingerprint);
    while (pending.length > 0) {
      const current = pending.pop()!;
      component.push(current);
      for (const neighbour of [...neighbours.get(current)!].sort()) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        pending.push(neighbour);
      }
    }
    components.push(component.sort());
  }
  return components;
}

/** Resolve the fixed cohort in two phases: the ladder, then confirmed-pair components. */
export function resolveCandidateClaims(
  candidates: readonly CandidateClaimSet[],
): readonly CandidateSweepResolution[] {
  const fingerprints = candidates.map((candidate) => candidate.sourceFingerprint);
  if (new Set(fingerprints).size !== fingerprints.length) {
    throw new Error("Sweep cohort contains duplicate source fingerprints.");
  }
  for (const candidate of candidates) {
    if (!Number.isFinite(Date.parse(candidate.committedAt))) {
      throw new Error(`Candidate ${candidate.sourceFingerprint} has an invalid git commit date.`);
    }
  }

  const byFingerprint = new Map(candidates.map((candidate) => [candidate.sourceFingerprint, candidate]));
  const resolutions = new Map<string, CandidateSweepResolution>();
  for (const candidate of candidates) {
    const rule = ladderRule(candidate);
    const duplicateIssueNumber = rule === 1
      ? [...candidate.censusClaims]
        .filter((claim) => claim.verdict === "confirmed")
        .sort((left, right) => left.issueNumber - right.issueNumber)[0]!.issueNumber
      : null;
    const finalState: SweepFinalState = rule === 1
      ? "duplicate"
      : rule === 2
        ? "unresolved"
        : rule === 4
          ? "corroborated_novel"
          : "held_pair_member";
    resolutions.set(candidate.sourceFingerprint, {
      sourceFingerprint: candidate.sourceFingerprint,
      emissionContentSha256: candidate.emissionContentSha256,
      finalState,
      ladderRule: rule,
      reason: rule === 1
        ? `Escalation confirmed duplicate of issue #${duplicateIssueNumber}.`
        : rule === 2
          ? "At least one collected claim remained unresolved after the bounded escalation pass."
          : rule === 3
            ? "Confirmed within-queue pair awaits connected-component disposition."
            : "Every collected claim was disproved, or no claims were made.",
      duplicateIssueNumber,
      representativeSourceFingerprint: null,
    });
  }

  for (const component of confirmedPairComponents(candidates)) {
    const eligible = component
      .map((fingerprint) => byFingerprint.get(fingerprint)!)
      .filter((candidate) => {
        const resolution = resolutions.get(candidate.sourceFingerprint)!;
        return resolution.ladderRule === 3 &&
          !hasVerdict(candidate.censusClaims, "confirmed") &&
          !hasVerdict(candidate.censusClaims, "unresolved") &&
          !hasVerdict(candidate.pairClaims, "unresolved");
      })
      .sort(compareCandidateAge);
    if (eligible.length === 0) continue;
    const representative = eligible[0].sourceFingerprint;
    for (const candidate of eligible) {
      const isRepresentative = candidate.sourceFingerprint === representative;
      resolutions.set(candidate.sourceFingerprint, {
        ...resolutions.get(candidate.sourceFingerprint)!,
        finalState: isRepresentative ? "corroborated_novel" : "held_pair_member",
        reason: isRepresentative
          ? "Oldest eligible member represents the confirmed within-queue component."
          : `Held as a confirmed within-queue duplicate of representative ${representative}.`,
        representativeSourceFingerprint: representative,
      });
    }
  }

  return [...resolutions.values()].sort((left, right) =>
    left.sourceFingerprint.localeCompare(right.sourceFingerprint));
}
