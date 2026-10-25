import { canonicalJson, sha256Bytes } from "./canonical-json";
import { intakeSnapshotCoverageSha256 } from "./intake-assessment";
import {
  incidentSourceFingerprint,
  markerBlocks,
  parseIntakeSnapshotV1,
  sourceMarkersMatchStrictly,
  type IntakeSnapshotV1,
  type MarkerLocation,
} from "./intake-snapshot";
import { parseSourceMarker, type SourceMarkerV1 } from "./source-marker";

export interface CensusBinding {
  readonly artifactPath: string;
  /** The caller binds the artifact bytes; this pure module has no filesystem access. */
  readonly artifactSha256: string;
  readonly contentSha256: string;
  readonly coverageSha256: string;
}

export interface RetainedCreateIdentity {
  readonly issueNumber: number | null;
  readonly issueId: string | number | null;
}

export interface CreateOwnershipInput {
  readonly repository: string;
  readonly sourceFingerprint: string;
  readonly firstAttemptAt: string;
  readonly emissionContentSha256?: string | null;
  readonly retained: RetainedCreateIdentity;
  readonly census: IntakeSnapshotV1;
  readonly censusBinding: CensusBinding;
}

export type OwnershipRefusalReason =
  // History moved under us between reading and proposing: another writer, or an operator edit.
  | "state_drift"
  // Our own proposed event does not resolve to the state it must: an invariant failure in this
  // code, not external drift. It still only refuses this operation — writing nothing is the safe
  // direction, and aborting the run for one operation is the amplification U5.C removed.
  | "reconciled_state_invariant"
  | "repository_mismatch"
  | "coverage_incomplete"
  | "binding_mismatch"
  | "census_predates_attempt"
  | "no_owner"
  | "multiple_owners"
  | "incident_on_owner"
  | "incident_on_fingerprint"
  | "emission_mismatch"
  | "retained_identity_mismatch"
  | "unbound_outcome_identity"
  | "stored_body_disagrees"
  | "comment_only"
  | "retained_issue_missing"
  | "not_an_issue"
  | "live_identity_mismatch"
  | "live_marker_changed";

export interface OwnershipRefusal {
  readonly kind: "refusal";
  readonly reason: OwnershipRefusalReason;
  readonly detail: string;
  readonly candidates?: readonly number[];
}

// Deliberately not exported: an object literal is not an ownership proof.
const ownershipProof: unique symbol = Symbol("create ownership proof");

export interface OwnershipProof {
  readonly [ownershipProof]: true;
  readonly kind: "proof";
  readonly repository: string;
  readonly sourceFingerprint: string;
  readonly issueNumber: number;
  readonly issueId: string | number | null;
  readonly retained: RetainedCreateIdentity;
  readonly censusMarker: SourceMarkerV1;
  readonly markerLocation: MarkerLocation;
  readonly censusBinding: CensusBinding;
  readonly capturedAt: string;
  readonly ownerCount: 1;
  /** All body-marker locations in the census index, including other fingerprints. */
  readonly bodyLocationsInspected: number;
}

export interface OwnershipLiveIssue {
  readonly number: number;
  readonly id: string | number;
  readonly nodeId: string;
  readonly body: string;
  readonly isPullRequest: boolean;
  readonly htmlUrl: string;
  readonly createdAt: string;
  readonly requestId?: string;
  readonly fetchedAt: string;
  /** Carried from the same issue GET for a subsequent read-only classification observation. */
  readonly typeName?: string | null;
}

export interface OwnershipIssueReadPort {
  /** Reject with { status: 404 } for not found. Other read failures propagate without retry. */
  fetchIssue(repository: string, issueNumber: number): Promise<OwnershipLiveIssue>;
}

export interface LiveConfirmation {
  readonly kind: "confirmed";
  readonly proof: OwnershipProof;
  readonly live: {
    readonly issueNumber: number;
    readonly issueId: string | number;
    readonly nodeId: string;
    /** SHA-256 of the UTF-8 body bytes returned by the targeted GET. */
    readonly bodySha256: string;
    readonly liveMarker: SourceMarkerV1;
    readonly createdAt: string;
    readonly fetchedAt: string;
    readonly requestId?: string;
  };
  readonly predatesAttempt?: true;
}

function refusal(reason: OwnershipRefusalReason, detail: string): OwnershipRefusal {
  return { kind: "refusal", reason, detail };
}

export function matchesIssueId(retained: string | number | null, id: string | number, nodeId: string): boolean {
  return retained === null || String(retained) === String(id) || retained === nodeId;
}

function parsedBodyMarkers(body: string): SourceMarkerV1[] {
  return markerBlocks(body).flatMap((block) => {
    if (block.modified) return [];
    try { return [parseSourceMarker(block.raw)]; }
    catch { return []; }
  });
}

/** Create-only ownership evidence. A refusal never grants permission to create an issue. */
export function proveCreateOwnership(input: CreateOwnershipInput): OwnershipProof | OwnershipRefusal {
  const { census, censusBinding, retained, sourceFingerprint } = input;
  const repository = `${census.repository.organization}/${census.repository.name}`;
  // Same folding as the execution journal, without importing its filesystem operations.
  if (repository.toLowerCase() !== input.repository.toLowerCase()) {
    return refusal("repository_mismatch", `Census repository ${repository} differs from ${input.repository}.`);
  }
  for (const domain of ["issues", "bodies"] as const) {
    if (census.coverage[domain] !== "complete") {
      return refusal("coverage_incomplete", `census.coverage.${domain} must be complete.`);
    }
  }
  if (census.census.issueCount !== census.issues.length ||
      census.census.expectedIssueCount !== census.issues.length ||
      new Set(census.issues.map((issue) => issue.number)).size !== census.issues.length) {
    return refusal("coverage_incomplete", "census.issueCount / census.expectedIssueCount must agree with unique issues rows.");
  }
  // The production collector attests both issue and body coverage with its issues receipts.
  if (!census.receipts.some((receipt) => receipt.domain === "issues")) {
    return refusal("coverage_incomplete", "census.receipts requires the issues domain that attests issues and bodies.");
  }
  try {
    // Recomputes the content digest from the payload, rather than trusting contentSha256.
    parseIntakeSnapshotV1(census);
    if (censusBinding.contentSha256 !== census.contentSha256 ||
        censusBinding.coverageSha256 !== intakeSnapshotCoverageSha256(census) ||
        !/^[0-9a-f]{64}$/.test(censusBinding.artifactSha256) || censusBinding.artifactPath.trim() === "") {
      return refusal("binding_mismatch", "Census artifact metadata or recomputed content/coverage binding disagrees.");
    }
  } catch (error) {
    return refusal("binding_mismatch", `Census integrity check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  // The collector's pass completedAt is its start time. census.bookendCompletedAt
  // comes from buildIntakeSnapshot's bookend.completedAt and ends enumeration.
  const enumerationFinishedAt = census.census.bookendCompletedAt ?? census.census.completedAt;
  const timingField = census.census.bookendCompletedAt == null ? "census.completedAt" : "census.bookendCompletedAt";
  if (!Number.isFinite(Date.parse(input.firstAttemptAt)) || !Number.isFinite(Date.parse(enumerationFinishedAt))) {
    return refusal("binding_mismatch", `First attempt and ${timingField} require valid timestamps.`);
  }
  if (Date.parse(enumerationFinishedAt) < Date.parse(input.firstAttemptAt)) {
    return refusal("census_predates_attempt", `${timingField} precedes the operation's first attempt.`);
  }

  const locations = Object.values(census.markerIndex).flat();
  const bodies = locations.filter((location) => location.source === "body");
  const claims = bodies.filter((location) => location.marker.sourceFingerprint === sourceFingerprint);
  const owners = [...new Set(claims.map((location) => location.issueNumber))].sort((a, b) => a - b);
  if (owners.length === 0) {
    return locations.some((location) => location.source === "comment" && location.marker.sourceFingerprint === sourceFingerprint)
      ? refusal("comment_only", "The fingerprint occurs only in comments; comments cannot establish create ownership.")
      : refusal("no_owner", "No issue body in the census marker index owns this fingerprint.");
  }
  if (owners.length > 1) {
    return { ...refusal("multiple_owners", "Multiple issue bodies own this fingerprint."), candidates: owners };
  }
  const issueNumber = owners[0];
  const incident = census.markerIncidents.find((entry) => entry.issueNumber === issueNumber &&
    entry.source === "body" && (entry.sourceFingerprint === null || entry.sourceFingerprint === sourceFingerprint));
  if (incident !== undefined) {
    return refusal("incident_on_owner", `Issue #${issueNumber} has a ${incident.kind} body-marker incident: ${incident.detail}`);
  }
  const fingerprintIncidents = census.markerIncidents.filter((entry) => entry.sourceFingerprint === sourceFingerprint);
  if (fingerprintIncidents.length > 0) {
    const issues = [...new Set(fingerprintIncidents.map((entry) => entry.issueNumber))].sort((a, b) => a - b);
    return { ...refusal("incident_on_fingerprint", `Fingerprint has marker incidents on issues ${issues.map((number) => `#${number}`).join(", ")}.`),
      candidates: issues };
  }
  const issue = census.issues.find((entry) => entry.number === issueNumber);
  if (retained.issueNumber !== null && retained.issueNumber !== issueNumber) {
    return refusal("retained_identity_mismatch", `Retained issue #${retained.issueNumber} differs from owner #${issueNumber}.`);
  }
  if (issue === undefined) {
    return refusal("stored_body_disagrees", `Indexed owner #${issueNumber} has no stored issue body.`);
  }
  if (!matchesIssueId(retained.issueId, issue.identity.databaseId, issue.identity.nodeId)) {
    return refusal("retained_identity_mismatch", `Retained issue ID differs from census owner #${issueNumber}.`);
  }
  const storedMarkers = parsedBodyMarkers(issue.body);
  if (claims.some((claim) => !storedMarkers.some((marker) => sourceMarkersMatchStrictly(claim.marker, marker)))) {
    return refusal("stored_body_disagrees", `Stored body for #${issueNumber} does not contain every indexed ownership marker.`);
  }
  // Multiple emissions in one issue are still one owner; choose reproducibly regardless of index order.
  const selected = [...claims].sort((a, b) => {
    const left = canonicalJson(a.marker);
    const right = canonicalJson(b.marker);
    return left < right ? -1 : left > right ? 1 : 0;
  })[0];
  if (input.emissionContentSha256 != null && selected.marker.emissionContentSha256 !== input.emissionContentSha256) {
    return refusal("emission_mismatch", `Census marker emission on #${issueNumber} differs from the prior attempt.`);
  }
  const censusMarker = Object.freeze({ ...selected.marker });
  return Object.freeze({
    [ownershipProof]: true as const,
    kind: "proof",
    repository: input.repository,
    sourceFingerprint,
    issueNumber,
    issueId: issue.identity.nodeId ?? issue.identity.databaseId ?? null,
    retained: Object.freeze({ ...retained }),
    censusMarker,
    markerLocation: Object.freeze({ ...selected, marker: censusMarker }),
    censusBinding: Object.freeze({ ...censusBinding }),
    capturedAt: census.census.completedAt,
    ownerCount: 1,
    bodyLocationsInspected: bodies.length,
  });
}

function liveIdentityMatches(proof: OwnershipProof, issue: OwnershipLiveIssue): boolean {
  if (issue.number !== proof.issueNumber) return false;
  try {
    const url = new URL(issue.htmlUrl);
    const path = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
    return url.protocol === "https:" && url.hostname === "github.com" && url.port === "" &&
      url.username === "" && url.password === "" && path !== null &&
      `${path[1]}/${path[2]}`.toLowerCase() === proof.repository.toLowerCase() &&
      Number(path[3]) === proof.issueNumber;
  } catch { return false; }
}

/** One targeted GET; no search, retries, writes, or inference of permission from absence. */
export async function confirmOwnershipLive(
  proof: OwnershipProof,
  port: OwnershipIssueReadPort,
  options: { readonly firstAttemptAt?: string } = {},
): Promise<LiveConfirmation | OwnershipRefusal> {
  let issue: OwnershipLiveIssue;
  try {
    issue = await port.fetchIssue(proof.repository, proof.issueNumber);
  } catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 404) {
      return refusal("retained_issue_missing", `Issue #${proof.issueNumber} was not found by the targeted read.`);
    }
    throw error;
  }
  if (issue.isPullRequest) return refusal("not_an_issue", `#${proof.issueNumber} is a pull request.`);
  if (!liveIdentityMatches(proof, issue)) {
    return refusal("live_identity_mismatch", "Live issue number or repository differs from the ownership proof.");
  }
  if (!matchesIssueId(proof.retained.issueId, issue.id, issue.nodeId)) {
    return refusal("retained_identity_mismatch", "Live issue ID differs from the retained issue ID.");
  }
  if (!matchesIssueId(proof.issueId, issue.id, issue.nodeId)) {
    return refusal("live_identity_mismatch", "Live issue ID differs from the census issue ID.");
  }
  const blocks = markerBlocks(issue.body);
  // A corrupt copy next to an intact marker must not hide a change to the candidate's marker.
  for (const block of blocks) {
    try {
      if (block.modified) throw new Error("Modified marker sentinel.");
      parseSourceMarker(block.raw);
    } catch {
      const fingerprint = incidentSourceFingerprint(block.raw);
      if (fingerprint === null || fingerprint === proof.sourceFingerprint) {
        return refusal("live_marker_changed", "The live body contains a corrupt ownership marker.");
      }
    }
  }
  const liveMarker = parsedBodyMarkers(issue.body).find((marker) =>
    marker.sourceFingerprint === proof.sourceFingerprint && sourceMarkersMatchStrictly(proof.censusMarker, marker));
  if (liveMarker === undefined) {
    return refusal("live_marker_changed", "Live body no longer contains the exact census ownership marker.");
  }
  return {
    kind: "confirmed",
    proof,
    live: {
      issueNumber: issue.number,
      issueId: issue.id,
      nodeId: issue.nodeId,
      bodySha256: sha256Bytes(issue.body),
      liveMarker,
      createdAt: issue.createdAt,
      fetchedAt: issue.fetchedAt,
      ...(issue.requestId === undefined ? {} : { requestId: issue.requestId }),
    },
    ...(options.firstAttemptAt !== undefined && Date.parse(issue.createdAt) < Date.parse(options.firstAttemptAt)
      ? { predatesAttempt: true as const } : {}),
  };
}
