/**
 * KTD1 observation currency, independent of assessment currency.
 *
 * Gap table: inputs outside censusMaterial's per-issue digest.
 * "Via currency" means a changed input can invalidate this member's assessment;
 * its readiness then changes other members' admission/rank at
 * compileStewardshipBacklog. buildStewardshipProjection looks up packets by
 * their own member's number.
 *
 * Input | Cross-member projection/ranking read | Coverage
 * labels | Via currency, stewardshipAssessmentCurrencyKey; candidate | KTD1.2 updatedAt
 * comments | None: raw comments are not packet material, collectGeneration | KTD1.2 updatedAt
 * blockedBy edges/state | blockers; candidate, compileStewardshipBacklog | KTD1.2 updatedAt for edges; KTD1.5 same-repository open-census state (blocker_state_changed); cross-repository links refused
 * parent/subIssues/blocking | Via currency, stewardshipAssessmentCurrencyKey; candidate | KTD1.2 updatedAt for edges; KTD1.6 same-repository open-census state (cross_member_input_changed); cross-repository links refused
 * linked PRs | None: own Start facts only, compileFacts | KTD1.2 updatedAt and KTD1.7 age; no cross-member PR-state input
 * assignees | None: archived by materialPacket, absent from stewardshipAssessmentCurrencyKey, compileFacts, buildStewardshipProjection packet reads | KTD1.2 updatedAt
 * milestone | None: archived by materialPacket, absent from stewardshipAssessmentCurrencyKey, compileFacts, buildStewardshipProjection packet reads | KTD1.2 updatedAt
 * native/v1 type | Native type via currency, stewardshipAssessmentCurrencyKey; candidate; v1 type has no read | KTD1.2 updatedAt
 * persisted verifications | None: archived by materialPacket, absent from stewardshipAssessmentCurrencyKey, compileFacts, buildStewardshipProjection packet reads | KTD1.2 updatedAt and KTD1.7 age
 * project memberships | None: archived by materialPacket, absent from stewardshipAssessmentCurrencyKey, compileFacts, buildStewardshipProjection packet reads | KTD1.2 updatedAt
 * sources (including strategy/spec) | Via currency and localPathCurrency in buildStewardshipProjection; candidate | KTD1.3 exact blobs or producer-identical snippet hash/length for whole sources; excerpt blobs stay exact
 * source discovery/coverage/clauses/facts/scout | None directly: packet construction packetFor; buildStewardshipProjection consumes accepted sources | body digest, KTD1.3 accepted sources, KTD1.7 age
 * rubric identity | Via currency; candidate | KTD1.3 spec blob and KTD1.4 policy
 * phase/excerpts/excerptCapturedAt | buildStewardshipProjection; candidate | KTD1.1 latest capture, KTD1.3 excerpt blobs, KTD1.7 age
 * plan evidence | None: own Start facts only, compileFacts | KTD1.3 plan path/blob
 * repository identity | Qualifies gating edges, blockers; candidate | KTD1.6 same current repository (cross_member_input_changed)
 * freshness/transport metadata | None: buildStewardshipProjection uses journal time/state instead | KTD1.1 recorded capture and KTD1.7 age
 *
 * U3 supplies admission for the EXACT packet selected by journal order, never the
 * assessment's packet or the last entry of state.issues[n].evidencePackets. That
 * index retains the first witness per material hash (reduce).
 * For completed runs, readPriorCensus follows run-finished -> report.censusSha256
 * through archived reports; admittedValues preserves each member's
 * last-admission updatedAtByIssue/digestByIssue for needsDailyRecheck and reuse.
 * Take both strings from those producer-built maps, not a new hash of the packet.
 * For captures kept during this run, use the CAPTURING generation's maps.
 *
 * Missing data: when the capturing run's admission is unrecoverable, U3 passes
 * no admission and reuseStewardshipObservation refuses.
 * Neither an old complete flag nor an old nowCount grants current-run authority.
 * Current open-census presence proves OPEN. Absence proves CLOSED only when
 * the current census is complete; an absent target in an incomplete census is
 * unresolved and refused. Cross-repository target states remain unavailable.
 */
import { canonicalJsonSha256 } from "./canonical-json";
import {
  STEWARDSHIP_OBSERVATION_MAX_AGE_MS,
  stewardshipPacketMaterialSha256,
  type StewardshipEvidenceGeneration,
  type StewardshipIssueEvidencePacket,
} from "./stewardship-evidence";
import type { StewardshipEvent, StewardshipState } from "./stewardship-state";

export type StewardshipObservationReuseRefusal =
  | "not_latest_admission"
  | "changed"
  | "sources_incomplete"
  | "policy_mismatch"
  | "blocker_state_changed"
  | "cross_member_input_changed"
  | "packet_expired"
  | "packet_unreadable";

export interface StewardshipObservationAdmission {
  readonly packetSha256: string;
  readonly updatedAt: string;
  /** The digest emitted by censusMaterial's producer, not a packet hash. */
  readonly digest: string;
}

export interface StewardshipObservationReuseInput {
  issueNumber: number;
  generation: Pick<StewardshipEvidenceGeneration, "repository" | "census" | "generatedAt" | "policySha256">;
  journal: readonly { readonly at: string; readonly event: StewardshipEvent }[];
  state: StewardshipState;
  readArtifact: (hash: string) => unknown;
  admission?: StewardshipObservationAdmission;
  blobsAtMain: ReadonlyMap<string, string>;
  snippetAtMain?: (path: string) => { sha256: string; byteLength: number } | null;
}

export type StewardshipObservationReuseResult =
  | { reusable: true; evidence: { packet: StewardshipIssueEvidencePacket; originMainSha: string; policySha256: string } }
  | { reusable: false; reason: StewardshipObservationReuseRefusal };

export function latestEvidenceRecorded(journal: StewardshipObservationReuseInput["journal"], issueNumber: number) {
  return journal.findLast(({ event }) => event.type === "evidence-recorded" && event.issueNumber === issueNumber);
}

/** Pure except for the supplied read-only artifact and snippet readers. */
export function reuseStewardshipObservation(input: StewardshipObservationReuseInput): StewardshipObservationReuseResult {
  try {
    const latest = latestEvidenceRecorded(input.journal, input.issueNumber);
    if (!latest || latest.event.type !== "evidence-recorded") return { reusable: false, reason: "not_latest_admission" };
    const event = latest.event;
    const admission = input.admission;
    const recorded = input.state.issues[input.issueNumber]?.evidencePackets?.[event.materialEvidenceSha256];
    if (!admission || admission.packetSha256 !== event.packetSha256 || !admission.updatedAt || !admission.digest || !recorded) {
      return { reusable: false, reason: "not_latest_admission" };
    }
    const packet = input.readArtifact(event.packetSha256) as StewardshipIssueEvidencePacket;
    const policySha256 = event.policySha256 ?? recorded.policySha256;
    if (canonicalJsonSha256(packet) !== event.packetSha256 || packet.issueNumber !== input.issueNumber
      || packet.materialEvidenceSha256 !== event.materialEvidenceSha256
      || recorded.originMainSha !== event.originMainSha || recorded.policySha256 !== policySha256
      || stewardshipPacketMaterialSha256(packet, event.originMainSha, policySha256) !== event.materialEvidenceSha256) {
      return { reusable: false, reason: "packet_unreadable" };
    }
    const census = input.generation.census;
    if (census.updatedAtByIssue?.[input.issueNumber] !== admission.updatedAt
      || census.digestByIssue?.[input.issueNumber] !== admission.digest) return { reusable: false, reason: "changed" };
    if (policySha256 !== input.generation.policySha256) return { reusable: false, reason: "policy_mismatch" };
    const blobMatches = ({ path, blobOid }: { path: string; blobOid?: string }) => Boolean(blobOid) && input.blobsAtMain.get(path) === blobOid;
    const sourcesMatch = packet.sources.every((source) => {
      if (blobMatches(source)) return true;
      if (!source.blobOid || source.excerpt || !input.snippetAtMain) return false;
      try {
        const snippet = input.snippetAtMain(source.path);
        return snippet !== null && snippet.sha256 === source.snippetSha256 && snippet.byteLength === source.byteLength;
      } catch { return false; }
    });
    if (!sourcesMatch || ![...(packet.sourceExcerpts ?? []), ...(packet.planEvidence ?? [])].every(blobMatches)) {
      return { reusable: false, reason: "sources_incomplete" };
    }
    const repositorySha256 = canonicalJsonSha256(input.generation.repository);
    const sameRepository = (repo: typeof input.generation.repository) => canonicalJsonSha256(repo) === repositorySha256;
    if (!sameRepository(packet.issue.identity.repository)) {
      return { reusable: false, reason: "cross_member_input_changed" };
    }
    const relationships = packet.issue.relationships;
    const stateMatches = (link: (typeof relationships.blockedBy)[number]) => {
      // A same-number member of a different repository is not this target.
      if (!sameRepository(link.repository)) return false;
      const open = census.issueNumbers.includes(link.number)
        || census.members?.some((member) => member.issueNumber === link.number && member.state === "OPEN");
      const currentState = open ? "OPEN" : census.complete === true ? "CLOSED" : undefined;
      return (link.state === "OPEN" || link.state === "CLOSED") && currentState === link.state;
    };
    if (!relationships.blockedBy.every(stateMatches)) return { reusable: false, reason: "blocker_state_changed" };
    const currencyLinks = [...(relationships.parent ? [relationships.parent] : []), ...relationships.subIssues, ...relationships.blocking];
    if (!currencyLinks.every(stateMatches)) return { reusable: false, reason: "cross_member_input_changed" };
    const age = Date.parse(input.generation.generatedAt) - Date.parse(latest.at);
    if (!Number.isFinite(age) || age < 0 || age >= STEWARDSHIP_OBSERVATION_MAX_AGE_MS) return { reusable: false, reason: "packet_expired" };
    return { reusable: true, evidence: { packet, originMainSha: event.originMainSha, policySha256 } };
  } catch {
    return { reusable: false, reason: "packet_unreadable" };
  }
}
