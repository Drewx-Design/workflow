import type { QualificationFact } from "./types";

type StopFact = Pick<QualificationFact, "factKey" | "quote" | "sourceUrl"> & { value: unknown };
type AnsweredFact = StopFact & Pick<QualificationFact, "applicantAnswer" | "confirmedValue">;
export type FiscalSponsorship = boolean | "unknown";

export function factName(factKey: string): string {
  return factKey.slice(factKey.lastIndexOf(".") + 1);
}

/** Only quoted invitation restrictions and matching sponsor exclusions stop an applicant. */
export function classifyStopFact(fact: StopFact, fiscalSponsorship: FiscalSponsorship): "invitation" | "sponsor_policy" | null {
  if (!fact.quote?.trim() || !fact.sourceUrl?.trim()) return null;
  const key = factName(fact.factKey);
  if (key === "route" && (fact.value === "invitation_only" || fact.value === "closed_to_unsolicited")) return "invitation";
  if (key === "fiscalSponsorPolicy" && fact.value === "not_allowed" && fiscalSponsorship === true) return "sponsor_policy";
  return null;
}

export function isDontProceedFact(fact: StopFact, fiscalSponsorship: FiscalSponsorship): boolean {
  return classifyStopFact(fact, fiscalSponsorship) !== null;
}

const NON_OVERRIDE_ANSWERS = new Set(["no", "not_sure", "skip", "portal_questions", "uses_sponsor", "does_not_use_sponsor"]);

/** Classify by effect: status answers never confirm a published exclusion. */
export function answerRequiresOverride(fact: StopFact, answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  if (!normalized || NON_OVERRIDE_ANSWERS.has(normalized)) return false;
  // Classify the policy's potential effect independently of current org data,
  // so a policy override always passes through the human confirmation route.
  const kind = classifyStopFact(fact, true);
  if (kind === "invitation") return true;
  if (kind === "sponsor_policy") return ["eligible_despite_policy", "continue_anyway", "confirmed_eligible"].includes(normalized);
  // An RFP-only route is a closed-window confirmation, not a don't-proceed stop.
  return Boolean(fact.quote?.trim() && fact.sourceUrl?.trim()) &&
    factName(fact.factKey) === "route" && fact.value === "rfp_only" &&
    (normalized === "active_rfp" || normalized === "continue_anyway");
}

export function isStopFactSatisfied(fact: AnsweredFact): boolean {
  // Every override-class published value is a string; strict equality binds
  // the saved answer to that exact value without a client-side Node dependency.
  return fact.confirmedValue === fact.value && answerRequiresOverride(fact, fact.applicantAnswer);
}

export function resolveFiscalSponsorship(
  vaultStatus: FiscalSponsorship,
  facts: readonly Pick<QualificationFact, "factKey" | "applicantAnswer">[],
): FiscalSponsorship {
  if (vaultStatus !== "unknown") return vaultStatus;
  const answers = facts.filter(fact => factName(fact.factKey) === "fiscalSponsorPolicy").map(fact => fact.applicantAnswer);
  // An affirmative saved status applies across both document and lookup facts.
  if (answers.includes("uses_sponsor")) return true;
  if (answers.includes("does_not_use_sponsor")) return false;
  return "unknown";
}
