import type { IntakeSnapshotV1, MarkerLocation } from "./intake-snapshot";
import type { SourceMarkerV1 } from "./source-marker";

export interface OutcomeLineageHit {
  readonly issueNumber: number;
  readonly source: "body" | "comment";
  readonly marker: SourceMarkerV1;
}

export interface SourceLineageHit {
  readonly issueNumber: number;
  readonly stableOutcomeId: string;
  readonly producerKind: string;
}

/** What a create action records about a candidate's filed lineage. Derived from marker data only. */
export interface IntakeLineage {
  readonly stableArtifactId: string;
  readonly stableOutcomeId: string;
  readonly producerKind: string;
  readonly sourceLocator: string;
  /** Issues carrying this outcome's identity under a different fingerprint, with the producer kind their marker recorded. */
  readonly outcome: readonly { readonly issueNumber: number; readonly producerKind: string }[];
  /** Issues already filed from the same source document. Attention, not identity. */
  readonly source: readonly number[];
}

/** The lines the draft renders. Built from the structured record so no free text can pose as lineage. */
export function lineageLines(lineage: IntakeLineage): string[] {
  return [
    ...lineage.outcome.map((hit) =>
      `outcome "${lineage.stableOutcomeId}" of artifact "${lineage.stableArtifactId}" was already filed as #${hit.issueNumber} ` +
      `(marker fingerprint differs: producer kind ${hit.producerKind} -> ${lineage.producerKind}); the deterministic guard could not match it.`),
    ...(lineage.source.length > 0
      ? [`Source lineage: ${lineage.sourceLocator} already produced ${lineage.source.map((number) => `#${number}`).join(", ")}.`]
      : []),
  ];
}

function filedMarkers(snapshot: IntakeSnapshotV1, matches: (marker: SourceMarkerV1) => boolean): MarkerLocation[] {
  // Choose a stable representative even when one issue carries several matching body markers.
  const locations = Object.values(snapshot.markerIndex).flat()
    .filter((location) => location.source === "body" && matches(location.marker))
    .sort((left, right) => {
      const issueOrder = left.issueNumber - right.issueNumber;
      if (issueOrder !== 0) return issueOrder;
      const key = (marker: SourceMarkerV1) => JSON.stringify([
        marker.sourceFingerprint, marker.stableArtifactId, marker.stableOutcomeId,
        marker.producerKind, marker.producerVersion, marker.sourceLocator, marker.emissionContentSha256,
      ]);
      const a = key(left.marker);
      const b = key(right.marker);
      return a < b ? -1 : a > b ? 1 : 0;
    });
  return locations.filter((location, index) => index === 0 || locations[index - 1].issueNumber !== location.issueNumber);
}

/** Body filings with the same artifact/outcome identity but a different fingerprint. */
export function outcomeLineage(
  snapshot: IntakeSnapshotV1,
  candidate: { sourceFingerprint: string; stableOutcomeId: string },
  envelope: { artifact: { stableArtifactId: string } },
): OutcomeLineageHit[] {
  return filedMarkers(snapshot, (marker) => marker.sourceFingerprint !== candidate.sourceFingerprint &&
    marker.stableArtifactId === envelope.artifact.stableArtifactId &&
    marker.stableOutcomeId === candidate.stableOutcomeId)
    .map(({ issueNumber, source, marker }) => ({ issueNumber, source, marker }));
}

/** Source attention only: distinct outcomes from one document remain distinct filings. */
export function sourceLineage(
  snapshot: IntakeSnapshotV1,
  envelope: { artifact: { sourceLocator: string } },
  candidate: { sourceFingerprint: string },
): SourceLineageHit[] {
  return filedMarkers(snapshot, (marker) => marker.sourceFingerprint !== candidate.sourceFingerprint &&
    marker.sourceLocator === envelope.artifact.sourceLocator)
    .map(({ issueNumber, marker }) => ({ issueNumber, stableOutcomeId: marker.stableOutcomeId, producerKind: marker.producerKind }));
}
