import { describe, expect, it } from "vitest";
import { outcomeLineage, sourceLineage } from "../lib/github-issue-roadmap/intake-lineage";
import type { MarkerLocation } from "../lib/github-issue-roadmap/intake-snapshot";
import { sourceFingerprintFor } from "../lib/github-issue-roadmap/outcome-candidate";
import { parseSourceMarker, renderSourceMarker } from "../lib/github-issue-roadmap/source-marker";
import { buildIntakeStack } from "./__helpers__/roadmap-intake-stack";

const stack = buildIntakeStack();
const marker = parseSourceMarker(renderSourceMarker(stack.envelope, stack.envelope.candidates[0]));
const candidate = {
  stableOutcomeId: marker.stableOutcomeId,
  sourceFingerprint: sourceFingerprintFor({ repository: stack.envelope.repository,
    producerKind: "implementation_discovery", stableArtifactId: marker.stableArtifactId,
    stableOutcomeId: marker.stableOutcomeId }),
};
const envelope = { artifact: { stableArtifactId: marker.stableArtifactId, sourceLocator: marker.sourceLocator } };

function location(issueNumber: number, overrides: Partial<MarkerLocation> = {}): MarkerLocation {
  return { issueNumber, source: "body", commentDatabaseId: null, marker, ...overrides };
}

function snapshot(locations: MarkerLocation[]) {
  const markerIndex: Record<string, MarkerLocation[]> = {};
  for (const entry of locations) (markerIndex[entry.marker.sourceFingerprint] ??= []).push(entry);
  return { ...stack.snapshot, markerIndex };
}

describe("deterministic intake lineage", () => {
  it("finds a filed outcome with matching IDs and a different fingerprint", () => {
    expect(marker.producerKind).toBe("plan");
    expect(outcomeLineage(snapshot([location(1697)]), candidate, envelope))
      .toEqual([{ issueNumber: 1697, source: "body", marker }]);
  });

  it("leaves equal fingerprints to the fingerprint index", () => {
    const snap = snapshot([location(1697)]);
    expect(outcomeLineage(snap, marker, envelope)).toEqual([]);
    expect(sourceLineage(snap, envelope, marker)).toEqual([]);
  });

  it("does not match another artifact or outcome", () => {
    const snap = snapshot([location(1697)]);
    expect(outcomeLineage(snap, candidate, { artifact: { stableArtifactId: "other-artifact" } })).toEqual([]);
    expect(outcomeLineage(snap, { ...candidate, stableOutcomeId: "other-outcome" }, envelope)).toEqual([]);
  });

  it("does not claim comment-only evidence was filed", () => {
    const snap = snapshot([location(1697, { source: "comment", commentDatabaseId: 12 })]);
    expect(outcomeLineage(snap, candidate, envelope)).toEqual([]);
    expect(sourceLineage(snap, envelope, candidate)).toEqual([]);
  });

  it("lists distinct body filings from the source and excludes the candidate fingerprint", () => {
    const other = { ...marker, stableOutcomeId: "another-outcome", sourceFingerprint: "b".repeat(64) };
    const snap = snapshot([
      location(1703, { marker: other }), location(1697), location(1697),
      location(1704, { marker: { ...marker, sourceFingerprint: candidate.sourceFingerprint } }),
      location(1705, { marker: { ...marker, sourceLocator: "docs/other.md" } }),
    ]);
    expect(sourceLineage(snap, envelope, candidate)).toEqual([
      { issueNumber: 1697, stableOutcomeId: marker.stableOutcomeId, producerKind: "plan" },
      { issueNumber: 1703, stableOutcomeId: "another-outcome", producerKind: "plan" },
    ]);
  });

  it("sorts and deduplicates deterministically across index and location order", () => {
    const locations = [location(1703), location(1697), location(1697, {
      marker: { ...marker, sourceFingerprint: "0".repeat(64), producerVersion: "v2" },
    }), location(1703, { source: "comment", commentDatabaseId: 1 })];
    const forward = snapshot(locations);
    const reverse = snapshot([...locations].reverse());
    expect(outcomeLineage(forward, candidate, envelope)).toEqual(outcomeLineage(reverse, candidate, envelope));
    expect(outcomeLineage(forward, candidate, envelope).map((hit) => hit.issueNumber)).toEqual([1697, 1703]);
    expect(sourceLineage(forward, envelope, candidate)).toEqual(sourceLineage(reverse, envelope, candidate));
  });
});
