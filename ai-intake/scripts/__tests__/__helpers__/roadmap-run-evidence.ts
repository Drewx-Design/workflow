import { canonicalJsonSha256 } from "../../lib/github-issue-roadmap/canonical-json";
import { intakeSnapshotCoverageSha256, parseIntakeAssessment } from "../../lib/github-issue-roadmap/intake-assessment";
import type { IntakeSnapshotV1 } from "../../lib/github-issue-roadmap/intake-snapshot";
import type { OutcomeEnvelope } from "../../lib/github-issue-roadmap/outcome-candidate";
import { ASSESSMENT_STACK } from "./roadmap-intake-stack";

export function reboundSnapshot(census: IntakeSnapshotV1, envelope: OutcomeEnvelope): IntakeSnapshotV1 {
  const snapshot = { ...census, candidateSha256: canonicalJsonSha256(envelope) };
  snapshot.contentSha256 = canonicalJsonSha256({
    candidateSha256: snapshot.candidateSha256, canonicalSnapshotV2Sha256: snapshot.canonicalSnapshotV2Sha256,
    repository: snapshot.repository, censusContentSha256: snapshot.censusContentSha256, issues: snapshot.issues,
    markerIndex: snapshot.markerIndex, markerIncidents: snapshot.markerIncidents,
    projectObservation: snapshot.projectObservation, receipts: snapshot.receipts,
  });
  return snapshot;
}

export function evidenceAssessment(envelope: OutcomeEnvelope, snapshot: IntakeSnapshotV1) {
  const assessed = (value: string | null, evidenceId: string) => ({
    value, confidence: "high", evidenceIds: [evidenceId], rationale: "Fixture assessment evidence.",
  });
  return parseIntakeAssessment({
    schemaVersion: "github-issue-roadmap-intake-assessment/v1", candidateSha256: canonicalJsonSha256(envelope),
    snapshotContentSha256: snapshot.contentSha256, snapshotCoverageSha256: intakeSnapshotCoverageSha256(snapshot),
    generatedAt: snapshot.generatedAt, stack: ASSESSMENT_STACK,
    candidates: envelope.candidates.map((candidate) => {
      const id = candidate.evidence[0].id;
      return {
        sourceFingerprint: candidate.sourceFingerprint, emissionContentSha256: candidate.emissionContentSha256,
        match: { result: "clearly_novel", confidence: "high", canonicalIssueNumber: null, competingIssueNumbers: [],
          evidenceIds: [id], rationale: "Fixture assessment evidence." },
        classification: { type: assessed("Task", id), priority: assessed("P2", id), effort: assessed("Medium", id), horizon: assessed(null, id) },
        relationships: [], completionContradicted: false,
      };
    }),
    attention: { issueNumber: null, evidenceRefresh: "Refresh evidence.", decision: null, tradeoff: null,
      evidenceIds: [envelope.candidates[0].evidence[0].id], rationale: "Fixture attention." },
  }, envelope, snapshot, undefined, new Map());
}
