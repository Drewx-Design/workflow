import { sha256Body } from "../../github-issue-roadmap-preflight";

import type { StewardshipIssueEvidencePacket } from "./stewardship-evidence";
import { stewardshipAssessmentCurrencyKey } from "./stewardship-projection";
import { deriveStartCommand, type StartCommandDerivation, type StartCommandSeatFacts, type StewardshipStartCommandFacts } from "./stewardship-start-command";

export interface OpenTimeLiveFacts {
  readonly state: "OPEN" | "CLOSED";
  readonly lifecycle: StewardshipStartCommandFacts["lifecycle"];
  readonly pullRequests: StewardshipStartCommandFacts["pullRequests"];
  readonly type: string | null;
  readonly body: string;
  readonly title: string;
  readonly labels: StewardshipIssueEvidencePacket["issue"]["v1"]["labels"];
  readonly nativeType: StewardshipIssueEvidencePacket["issue"]["nativeType"];
  readonly relationships: StewardshipIssueEvidencePacket["issue"]["relationships"];
  readonly reopenEvents: NonNullable<StewardshipIssueEvidencePacket["reopenEvents"]>;
}

/** The selected issue's slice of an archived v2 compile input. */
export interface OpenTimeSnapshot {
  readonly compiledAt: string;
  readonly snapshotSha256: string;
  readonly status: "current" | "stale" | "unassessed" | "closed";
  readonly startCommandFacts: Omit<StewardshipStartCommandFacts, "assessment">;
  readonly assessment: {
    readonly assessments: readonly { readonly assessment: StartCommandSeatFacts }[];
    readonly ranking: { readonly effort: NonNullable<StewardshipStartCommandFacts["assessment"]>["effort"] };
  } | null;
  readonly packet: StewardshipIssueEvidencePacket;
}

export type SnapshotUnavailableReason = "no_journal" | "no_compile" | "journal_unreadable" | "v1_snapshot" | "issue_not_in_snapshot" | "only_refused_compiles";
const snapshotUnavailableMessages: Record<SnapshotUnavailableReason, string> = {
  no_journal: "no journal exists", no_compile: "no backlog compile exists", journal_unreadable: "journal unreadable",
  v1_snapshot: "latest snapshot predates Start command facts", issue_not_in_snapshot: "latest snapshot does not cover this issue",
  only_refused_compiles: "only refused backlog compiles exist",
};
type FactSource = "live" | "snapshot" | "withheld";
export interface OpenTimeStartCommandResult {
  readonly issueNumber: number;
  readonly state: OpenTimeLiveFacts["state"];
  readonly snapshot: Pick<OpenTimeSnapshot, "compiledAt" | "snapshotSha256"> | null;
  readonly snapshotUnavailableReason: SnapshotUnavailableReason | null;
  readonly drift: boolean;
  /** The body is summarized, not repeated: agents already have the issue, and the hash is what drift compares. */
  readonly facts: Omit<StewardshipStartCommandFacts, "body"> & { readonly body: { readonly sha256: string; readonly length: number } };
  readonly sources: { readonly state: "live" } & Readonly<Record<keyof StewardshipStartCommandFacts, FactSource>>;
  readonly derivation: StartCommandDerivation | { readonly kind: "hold"; readonly reason: "issue_closed" };
  readonly derivationSource: FactSource;
  readonly follow: Extract<StartCommandDerivation, { kind: "target" }>["value"] | null;
  readonly reason: string;
  readonly note: string;
}

/** Live issue currency is compared with the archived packet; rubric and excerpts stay archived. */
export function decideOpenTimeStartCommand(input: {
  readonly issueNumber: number;
  readonly live: OpenTimeLiveFacts;
  readonly snapshot: OpenTimeSnapshot | null;
  readonly snapshotUnavailableReason?: SnapshotUnavailableReason;
}): OpenTimeStartCommandResult {
  const { live, snapshot } = input;
  const overlay = snapshot ? { ...snapshot.packet, title: live.title, body: live.body, bodySha256: sha256Body(live.body),
    reopenEvents: live.reopenEvents, issue: { ...snapshot.packet.issue, nativeType: live.nativeType, relationships: live.relationships,
      v1: { ...snapshot.packet.issue.v1, title: live.title, body: live.body, bodySha256: sha256Body(live.body), labels: live.labels,
        type: live.type, state: live.state } } } : null;
  const snapshotKey = snapshot ? stewardshipAssessmentCurrencyKey(snapshot.packet) : null;
  const liveKey = overlay ? stewardshipAssessmentCurrencyKey(overlay) : null;
  const drift = snapshot !== null && (snapshotKey === null || liveKey === null || liveKey !== snapshotKey);
  const assessment = snapshot && !drift && snapshot.status === "current" ? snapshot.assessment : null;
  // Mirror compileStewardshipBacklog's Start command input, including both seat facts and merged Effort.
  const facts: StewardshipStartCommandFacts = {
    ...(snapshot?.startCommandFacts ?? { type: live.type, body: live.body, hasPlanWithUnits: false }),
    authoredStartCommand: snapshot?.startCommandFacts.authoredStartCommand ?? null,
    lifecycle: live.lifecycle,
    pullRequests: live.pullRequests,
    assessment: assessment ? {
      seats: assessment.assessments.map(({ assessment: seat }) => ({ completion: seat.completion, premise: seat.premise, unresolvedChoices: seat.unresolvedChoices })),
      effort: assessment.ranking.effort,
    } : null,
  };
  const derived = deriveStartCommand(facts);
  const derivation = live.state === "CLOSED" ? { kind: "hold", reason: "issue_closed" } as const : derived;
  const derivationSource = derivation.kind === "target" ? derivation.row <= 2 ? "live" : "snapshot" : "withheld";
  let reason: string;
  if (derivation.kind === "target") {
    reason = derivation.value === "none"
      ? `No skill is recommended by row ${derivation.row} using ${derivationSource} facts.`
      : `Start with ${derivation.value} by row ${derivation.row} using ${derivationSource} facts.`;
  } else if (derivation.reason === "issue_closed") reason = "issue is closed; no recommendation";
  else if (drift) reason = "stale since the last sorter run";
  else if (!snapshot) reason = `${input.snapshotUnavailableReason ? snapshotUnavailableMessages[input.snapshotUnavailableReason] : "no snapshot covers this issue"}; only live rows 1-2 are available`;
  else if (derivation.reason === "effort_unmerged") reason = "snapshot Effort needs evidence; no recommendation";
  else reason = "no current two-seat assessment in the snapshot; only live rows 1-2 are available";
  return {
    issueNumber: input.issueNumber, state: live.state,
    snapshot: snapshot ? { compiledAt: snapshot.compiledAt, snapshotSha256: snapshot.snapshotSha256 } : null,
    snapshotUnavailableReason: snapshot ? null : input.snapshotUnavailableReason ?? "issue_not_in_snapshot",
    drift, facts: { ...facts, body: { sha256: sha256Body(facts.body), length: facts.body.length } },
    sources: {
      state: "live", lifecycle: "live", pullRequests: "live", type: snapshot ? "snapshot" : "live", body: snapshot ? "snapshot" : "live",
      hasPlanWithUnits: snapshot ? "snapshot" : "withheld", authoredStartCommand: snapshot ? "snapshot" : "withheld",
      assessment: assessment ? "snapshot" : "withheld",
    },
    derivation, derivationSource, follow: derivation.kind === "target" ? derivation.value : null, reason,
    note: "The Start command field does not exist yet (until U3), so there is no pin. An override made since the last sorter run is not reflected. The rubric and excerpts are as of the snapshot.",
  };
}
