import { canonicalJson, canonicalJsonSha256 } from "./canonical-json";

export const PROPOSAL_V2_SCHEMA = "github-issue-roadmap-proposal/v2" as const;
export type ProposalActorClass = "automatic" | "approval" | "recovery";

export interface ProposalV2Target {
  readonly repository: string;
  readonly issueNumber: number | null;
}

export interface ProposalV2Action {
  readonly actionId: string;
  readonly kind: string;
  readonly capability: string;
  readonly before: unknown;
  readonly after: unknown;
  readonly preservationEffects: readonly string[];
}

export const SENSITIVE_ACTION_KINDS = [
  "append_sensitive_evidence", "set_p0_p1", "set_now_parked", "close_issue",
  "reopen_issue", "retire_duplicate", "retire_superseded", "change_relationship",
  "remove_relationship",
] as const;
export type SensitiveActionKind = typeof SENSITIVE_ACTION_KINDS[number];

export interface ProposalV2 {
  readonly schemaVersion: typeof PROPOSAL_V2_SCHEMA;
  readonly repository: string;
  readonly candidateSha256: string;
  readonly sourceFingerprint: string;
  readonly emissionHash: string;
  readonly snapshotSha256: string;
  readonly assessmentSha256: string;
  readonly decisionSha256: string;
  readonly capabilityManifestSha256: string;
  readonly originMainSha: string;
  readonly actorClass: ProposalActorClass;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly target: ProposalV2Target;
  readonly predictedCanonicalState: unknown;
  readonly actions: readonly ProposalV2Action[];
  readonly proposalSha256: string;
}

export type ProposalV2Input = Omit<ProposalV2, "schemaVersion" | "proposalSha256">;
type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${context} must be an object.`);
  return value as JsonObject;
}

function exact(value: JsonObject, keys: readonly string[], context: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${context} must contain exact keys [${expected.join(", ")}].`);
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${context} must be a non-empty string.`);
  return value;
}

function sha(value: unknown, context: string): string {
  const result = text(value, context);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${context} must be a lowercase SHA-256.`);
  return result;
}

function timestamp(value: unknown, context: string): string {
  const result = text(value, context);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`${context} must be an ISO timestamp.`);
  return result;
}

function repository(value: unknown, context: string): string {
  const result = text(value, context);
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(result)) throw new Error(`${context} must be OWNER/REPO.`);
  return result;
}

function withoutHash(proposal: ProposalV2): Omit<ProposalV2, "proposalSha256"> {
  const { proposalSha256: _proposalSha256, ...content } = proposal;
  void _proposalSha256;
  return content;
}

export function proposalV2Hash(value: ProposalV2 | Omit<ProposalV2, "proposalSha256">): string {
  if ("proposalSha256" in value) return canonicalJsonSha256(withoutHash(value));
  return canonicalJsonSha256(value);
}

export function createProposalV2(input: ProposalV2Input): ProposalV2 {
  const content = { schemaVersion: PROPOSAL_V2_SCHEMA, ...input };
  return validateProposalV2({ ...content, proposalSha256: canonicalJsonSha256(content) });
}

function fieldValue(tuple: unknown, name: "Priority" | "Horizon"): unknown {
  const record = object(tuple, "sensitive action tuple");
  const fields = object(record.fields, "sensitive action tuple.fields");
  return fields[name];
}

function issueState(tuple: unknown): unknown {
  return object(tuple, "sensitive action tuple").state;
}

function assertCompleteSensitiveIssueTuple(value: unknown, issueNumber: number, context: string): void {
  const tuple = object(value, context);
  if (tuple.issueNumber !== issueNumber || !Number.isSafeInteger(tuple.issueNumber)) throw new Error(`${context} must bind the exact target issue number.`);
  if (tuple.state !== "OPEN" && tuple.state !== "CLOSED") throw new Error(`${context}.state must be OPEN or CLOSED.`);
  if (tuple.stateReason !== null && typeof tuple.stateReason !== "string") throw new Error(`${context}.stateReason must be a string or null.`);
  for (const key of ["bodySha256", "markerSha256"] as const) if (typeof tuple[key] !== "string" || !/^[0-9a-f]{64}$/.test(tuple[key] as string)) throw new Error(`${context}.${key} must bind a lowercase SHA-256.`);
  const fields = object(tuple.fields, `${context}.fields`);
  if (!("Priority" in fields) || !("Horizon" in fields)) throw new Error(`${context}.fields must include Priority and Horizon, including explicit nulls.`);
  object(tuple.relationships, `${context}.relationships`);
}

function assertOnlyTupleChanges(action: ProposalV2Action, allowed: readonly string[]): void {
  const before = object(action.before, `${action.kind}.before`); const after = object(action.after, `${action.kind}.after`);
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  for (const key of keys) {
    if (!allowed.includes(key) && canonicalJsonSha256(before[key]) !== canonicalJsonSha256(after[key])) throw new Error(`${action.kind} cannot change unrelated tuple member ${key}.`);
  }
}

function assertSensitiveActionSequence(proposal: ProposalV2): void {
  if (proposal.actorClass !== "approval" && proposal.actorClass !== "recovery") throw new Error("Sensitive proposals require the approval or recovery entrypoint.");
  if (proposal.target.issueNumber === null) throw new Error("Sensitive proposals require an existing target issue.");
  const [evidence, ...meaningActions] = proposal.actions;
  if (evidence?.kind !== "append_sensitive_evidence" || evidence.capability !== "sensitive_evidence" || meaningActions.length === 0) {
    throw new Error("Sensitive proposals require one ordered evidence action before all meaning changes.");
  }
  const evidenceBody = object(evidence.after, "sensitive evidence after").body;
  if (typeof evidenceBody !== "string" || evidenceBody.trim() === "") throw new Error("Sensitive evidence must bind the exact non-empty comment body.");
  for (const action of meaningActions) {
    if (!SENSITIVE_ACTION_KINDS.includes(action.kind as SensitiveActionKind) || action.kind === "append_sensitive_evidence") throw new Error(`Unsupported sensitive action ${action.kind}.`);
    if (action.kind !== "change_relationship" && action.kind !== "remove_relationship") {
      assertCompleteSensitiveIssueTuple(action.before, proposal.target.issueNumber, `${action.kind}.before`);
      assertCompleteSensitiveIssueTuple(action.after, proposal.target.issueNumber, `${action.kind}.after`);
    }
  }
  if (canonicalJsonSha256(evidence.before) !== canonicalJsonSha256(meaningActions[0].before)) throw new Error("Sensitive evidence and the first meaning action must bind the same canonical before tuple.");
  for (let index = 1; index < meaningActions.length; index += 1) {
    if (canonicalJsonSha256(meaningActions[index - 1].after) !== canonicalJsonSha256(meaningActions[index].before)) throw new Error("Sensitive actions must form one exact ordered before/after transition.");
  }
  for (const action of meaningActions) {
    if (action.kind === "set_p0_p1") {
      const beforeFields = object(object(action.before, "set_p0_p1.before").fields, "set_p0_p1.before.fields");
      const afterFields = object(object(action.after, "set_p0_p1.after").fields, "set_p0_p1.after.fields");
      if (!["P0", "P1"].includes(String(afterFields.Priority)) || beforeFields.Priority === afterFields.Priority) throw new Error("set_p0_p1 must make an actual transition to P0 or P1.");
      assertOnlyTupleChanges(action, ["fields"]);
      if (canonicalJsonSha256({ ...beforeFields, Priority: afterFields.Priority }) !== canonicalJsonSha256(afterFields)) throw new Error("set_p0_p1 cannot smuggle another field change.");
    }
    if (action.kind === "set_now_parked") {
      const beforeFields = object(object(action.before, "set_now_parked.before").fields, "set_now_parked.before.fields");
      const afterFields = object(object(action.after, "set_now_parked.after").fields, "set_now_parked.after.fields");
      const from = beforeFields.Horizon; const to = afterFields.Horizon;
      if (from === to || ![from, to].some((value) => value === "Now" || value === "Parked")) throw new Error("set_now_parked must make an actual transition involving Now or Parked.");
      assertOnlyTupleChanges(action, ["fields"]);
      if (canonicalJsonSha256({ ...beforeFields, Horizon: to }) !== canonicalJsonSha256(afterFields)) throw new Error("set_now_parked cannot smuggle another field change.");
    }
    if (["close_issue", "retire_duplicate", "retire_superseded"].includes(action.kind)) {
      const before = object(action.before, `${action.kind}.before`); const after = object(action.after, `${action.kind}.after`);
      if (before.state !== "OPEN" || issueState(action.after) !== "CLOSED") throw new Error(`${action.kind} must transition open to closed.`);
      const expectedDisposition = action.kind === "retire_duplicate" ? "duplicate" : action.kind === "retire_superseded" ? "superseded" : after.closureDisposition;
      if (action.kind === "close_issue" && !["completed", "not_planned"].includes(String(after.closureDisposition))) throw new Error("close_issue requires the completed or not_planned reason branch.");
      if (after.closureDisposition !== expectedDisposition || after.stateReason !== (after.closureDisposition === "completed" ? "COMPLETED" : "NOT_PLANNED")) throw new Error(`${action.kind} closure reason tuple is inconsistent.`);
      if ((action.kind === "retire_duplicate" || action.kind === "retire_superseded") && (!Number.isSafeInteger(after.retirementTargetIssueNumber) || (after.retirementTargetIssueNumber as number) <= 0)) throw new Error(`${action.kind} requires an exact retirement target.`);
      if (action.kind === "close_issue" && after.retirementTargetIssueNumber !== null && after.retirementTargetIssueNumber !== undefined) throw new Error("close_issue cannot carry a duplicate/superseded retirement target.");
      assertOnlyTupleChanges(action, ["state", "stateReason", "closureDisposition", "retirementTargetIssueNumber"]);
    }
    if (action.kind === "reopen_issue") {
      const before = object(action.before, "reopen_issue.before"); const after = object(action.after, "reopen_issue.after");
      if (before.state !== "CLOSED" || issueState(action.after) !== "OPEN" || after.stateReason !== null || (after.closureDisposition !== null && after.closureDisposition !== undefined) || (after.retirementTargetIssueNumber !== null && after.retirementTargetIssueNumber !== undefined)) throw new Error("reopen_issue must clear the closure tuple and end open.");
      assertOnlyTupleChanges(action, ["state", "stateReason", "closureDisposition", "retirementTargetIssueNumber"]);
    }
  }
  const reopenIndex = meaningActions.findIndex((action) => action.kind === "reopen_issue");
  if (reopenIndex >= 0) {
    const reopen = meaningActions[reopenIndex];
    const originalHorizon = fieldValue(meaningActions[0].before, "Horizon");
    if ((originalHorizon === "Now" || originalHorizon === "Parked") &&
      (reopenIndex === 0 || meaningActions[reopenIndex - 1].kind !== "set_now_parked" || fieldValue(reopen.before, "Horizon") !== null)) {
      throw new Error("Reopen from Now/Parked requires one ordered proposal that clears Horizon before reopening.");
    }
  }
}

export function createSensitiveProposalV2(input: ProposalV2Input): ProposalV2 {
  const proposal = createProposalV2(input);
  assertSensitiveActionSequence(proposal);
  return proposal;
}

export function validateSensitiveProposalV2(value: unknown): ProposalV2 {
  const proposal = validateProposalV2(value);
  assertSensitiveActionSequence(proposal);
  return proposal;
}

/** Canonical action bytes reused verbatim by preview, approval payload, and executors. */
export function renderProposalActionData(proposal: ProposalV2): string {
  return canonicalJson(validateProposalV2(proposal).actions);
}

export function validateProposalV2(value: unknown): ProposalV2 {
  const raw = object(value, "proposal v2");
  exact(raw, ["schemaVersion", "repository", "candidateSha256", "sourceFingerprint", "emissionHash", "snapshotSha256", "assessmentSha256", "decisionSha256", "capabilityManifestSha256", "originMainSha", "actorClass", "createdAt", "expiresAt", "target", "predictedCanonicalState", "actions", "proposalSha256"], "proposal v2");
  if (raw.schemaVersion !== PROPOSAL_V2_SCHEMA) throw new Error(`proposal v2.schemaVersion must be ${PROPOSAL_V2_SCHEMA}.`);
  const repo = repository(raw.repository, "proposal v2.repository");
  for (const key of ["candidateSha256", "sourceFingerprint", "emissionHash", "snapshotSha256", "assessmentSha256", "decisionSha256", "capabilityManifestSha256", "proposalSha256"] as const) sha(raw[key], `proposal v2.${key}`);
  if (typeof raw.originMainSha !== "string" || !/^[0-9a-f]{40,64}$/.test(raw.originMainSha)) throw new Error("proposal v2.originMainSha must be a Git commit SHA.");
  if (!(["automatic", "approval", "recovery"] as const).includes(raw.actorClass as ProposalActorClass)) throw new Error("proposal v2.actorClass is unsupported.");
  const createdAt = timestamp(raw.createdAt, "proposal v2.createdAt");
  const expiresAt = timestamp(raw.expiresAt, "proposal v2.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error("proposal v2 must expire after it is created.");
  const target = object(raw.target, "proposal v2.target");
  exact(target, ["repository", "issueNumber"], "proposal v2.target");
  if (repository(target.repository, "proposal v2.target.repository").toLowerCase() !== repo.toLowerCase()) throw new Error("proposal v2 target belongs to another repository.");
  if (target.issueNumber !== null && (!Number.isSafeInteger(target.issueNumber) || (target.issueNumber as number) <= 0)) throw new Error("proposal v2.target.issueNumber must be positive or null.");
  if (!Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > 25) throw new Error("proposal v2.actions must contain 1 to 25 actions.");
  const ids = new Set<string>();
  raw.actions.forEach((entry, index) => {
    const action = object(entry, `proposal v2.actions[${index}]`);
    exact(action, ["actionId", "kind", "capability", "before", "after", "preservationEffects"], `proposal v2.actions[${index}]`);
    const id = text(action.actionId, `proposal v2.actions[${index}].actionId`);
    if (ids.has(id)) throw new Error(`proposal v2 has duplicate actionId ${id}.`);
    ids.add(id); text(action.kind, `proposal v2.actions[${index}].kind`); text(action.capability, `proposal v2.actions[${index}].capability`);
    if (!Array.isArray(action.preservationEffects)) throw new Error(`proposal v2.actions[${index}].preservationEffects must be an array.`);
    action.preservationEffects.forEach((effect, effectIndex) => text(effect, `proposal v2.actions[${index}].preservationEffects[${effectIndex}]`));
  });
  const proposal = raw as unknown as ProposalV2;
  if (proposalV2Hash(proposal) !== proposal.proposalSha256) throw new Error("proposal v2 content hash mismatch; the preview or proposal was edited.");
  return proposal;
}

export function assertProposalExecutionBindings(proposal: ProposalV2, current: {
  readonly repository: string; readonly snapshotSha256: string; readonly originMainSha: string;
  readonly actorClass: ProposalActorClass; readonly canonicalBefore: readonly unknown[]; readonly now: string;
}): void {
  validateProposalV2(proposal);
  if (proposal.repository.toLowerCase() !== current.repository.toLowerCase()) throw new Error("Proposal repository drifted.");
  if (proposal.snapshotSha256 !== current.snapshotSha256) throw new Error("Proposal snapshot advanced.");
  if (proposal.originMainSha !== current.originMainSha) throw new Error("Proposal origin/main advanced.");
  if (proposal.actorClass !== current.actorClass) throw new Error("Proposal actor class does not match this entrypoint.");
  if (Date.parse(current.now) > Date.parse(proposal.expiresAt)) throw new Error("Proposal expired.");
  if (canonicalJsonSha256(proposal.actions.map((action) => action.before)) !== canonicalJsonSha256(current.canonicalBefore)) throw new Error("Canonical state drifted from the proposal before tuples.");
}
