import type { ProposalActorClass, ProposalV2 } from "./proposal-v2";

export const STEWARD_AUDIT_V2_SCHEMA = "github-issue-roadmap-steward-audit/v2" as const;
export const V2_TERMINAL_OUTCOMES = ["verified_applied", "conflict_no_write", "partial_safe", "created_partial", "unknown_remote_outcome", "unknown_recovery_required", "skipped", "recovered_adopted", "recovered_no_mutation"] as const;
export type V2TerminalOutcome = typeof V2_TERMINAL_OUTCOMES[number];
export interface StewardAuditV2Action { readonly actionId: string; outcome: V2TerminalOutcome | "pending"; before: unknown; after: unknown; requestId?: string; error?: string }
export interface StewardAuditV2 {
  readonly schemaVersion: typeof STEWARD_AUDIT_V2_SCHEMA; readonly proposalSha256: string; readonly repository: string;
  readonly actorClass: ProposalActorClass; readonly startedAt: string; completedAt: string | null;
  status: "running" | "success" | "conflict" | "partial_safe" | "recovery_required" | "recovered";
  actions: StewardAuditV2Action[]; error?: string;
}
export type StewardAuditV2Writer = (audit: StewardAuditV2) => void;

export function createInitialStewardAuditV2(proposal: ProposalV2, startedAt: string): StewardAuditV2 {
  return { schemaVersion: STEWARD_AUDIT_V2_SCHEMA, proposalSha256: proposal.proposalSha256, repository: proposal.repository, actorClass: proposal.actorClass,
    startedAt, completedAt: null, status: "running", actions: proposal.actions.map((action) => ({ actionId: action.actionId, outcome: "pending", before: action.before, after: null })) };
}
export function checkpointStewardAuditV2(writer: StewardAuditV2Writer, audit: StewardAuditV2): void { writer(structuredClone(audit)); }
export function terminalAuditStatus(outcomes: readonly V2TerminalOutcome[]): StewardAuditV2["status"] {
  if (outcomes.some((value) => value === "unknown_remote_outcome" || value === "unknown_recovery_required" || value === "created_partial")) return "recovery_required";
  if (outcomes.some((value) => value === "partial_safe")) return "partial_safe";
  if (outcomes.every((value) => value === "conflict_no_write" || value === "skipped")) return "conflict";
  if (outcomes.some((value) => value.startsWith("recovered_"))) return "recovered";
  return "success";
}
