import type { ProcessRoute } from "./types";
import { factName, isDontProceedFact } from "./stop-facts";
export { factName, isDontProceedFact } from "./stop-facts";

export type QualificationFactView = {
  id: string;
  factKey: string;
  value: unknown;
  quote: string | null;
  sourceUrl: string | null;
  sourceReference: string | null;
  sourceKind: "lookup" | "document";
  checkedAt: string;
  applicantAnswer: string;
  confirmedValue: unknown;
};

export type VerdictTone = "go" | "caution" | "stop" | "uncovered";

export type QualificationVerdict = {
  text: string;
  tone: VerdictTone;
  recommendSkip: boolean;
};

const ROUTE_COPY: Record<ProcessRoute | "open_application", string> = {
  direct_application: "You can apply directly with a full application.",
  open_application: "Open application — you can submit a full application directly.",
  loi_first: "They ask for a short letter of inquiry before a full proposal.",
  invitation_only: "They accept an application only after sending you an invitation.",
  eligibility_prescreen:
    "Complete their eligibility quiz or interest form before drafting an application.",
  closed_to_unsolicited:
    "They do not accept uninvited requests; you need an invitation before applying.",
  conversation_first:
    "Contact the program officer before drafting an application.",
  rfp_only:
    "They accept applications only through an active request for proposals.",
  unknown: "Their first application step is not clear yet.",
};

const FORMAT_COPY: Record<string, string> = {
  portal: "an online application portal",
  document: "a document you upload or send",
  email: "an application sent by email",
  unknown: "a submission format that is not clear yet",
};

export function hasQuotedSupport(fact: QualificationFactView | undefined): boolean {
  return Boolean(
    fact &&
      fact.value !== null &&
      fact.value !== undefined &&
      fact.value !== "unknown" &&
      fact.quote?.trim() &&
      fact.sourceUrl?.trim(),
  );
}

export function describeProcessValue(key: string, value: unknown): string {
  if (key === "route") return ROUTE_COPY[String(value) as keyof typeof ROUTE_COPY] ?? ROUTE_COPY.unknown;
  if (key === "fiscalSponsorPolicy") {
    if (value === "allowed") return "They say fiscally sponsored applicants may apply.";
    if (value === "not_allowed") return "They say fiscally sponsored applicants are not eligible.";
    return "Their site doesn't say whether fiscally sponsored applicants may apply.";
  }
  if (value === null || value === undefined || value === "" || value === "unknown") {
    return "Unknown";
  }
  if (key === "submissionFormat") {
    return `The first submission is ${FORMAT_COPY[String(value)] ?? FORMAT_COPY.unknown}.`;
  }
  if (key === "window") {
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      return String(record.label ?? record.status ?? record.deadline ?? "Unknown");
    }
    return String(value);
  }
  if (key === "reopeningDate") return `Reopens ${String(value)}`;
  if (key === "portalSoftware") return `Applications use ${String(value)}.`;
  return String(value);
}

function firstSupported(
  facts: QualificationFactView[],
  key: string,
): QualificationFactView | undefined {
  return facts.find(
    (fact) => factName(fact.factKey) === key && hasQuotedSupport(fact),
  );
}

export function hasActiveRfp(facts: QualificationFactView[]): boolean {
  const window = firstSupported(facts, "window");
  if (!window) return false;
  const text = typeof window.value === "string"
    ? window.value
    : JSON.stringify(window.value);
  return /\b(open|active|accepting)\b/i.test(text);
}

export function buildQualificationVerdict({
  facts,
  identityStatus,
  fiscalSponsorship,
  governmentProgram,
}: {
  facts: QualificationFactView[];
  identityStatus: string;
  fiscalSponsorship: boolean | "unknown";
  governmentProgram: boolean;
}): QualificationVerdict {
  if (governmentProgram) {
    return {
      text: "Not covered yet",
      tone: "uncovered",
      recommendSkip: false,
    };
  }

  const route = firstSupported(facts, "route");
  const rfpWithoutActiveWindow = route?.value === "rfp_only" && !hasActiveRfp(facts);
  const exclusion = facts.find((fact) =>
    isDontProceedFact(fact, fiscalSponsorship),
  );
  if (exclusion || rfpWithoutActiveWindow) {
    const fiscal = exclusion
      ? factName(exclusion.factKey) === "fiscalSponsorPolicy"
      : false;
    return {
      text: rfpWithoutActiveWindow
        ? "This funder accepts applications only through a request for proposals, and we did not find one that is active."
        : fiscal
          ? "This funder says organizations using a fiscal sponsor are not eligible."
          : "This funder says not to apply unless you've been invited.",
      tone: "stop",
      recommendSkip: true,
    };
  }

  if (identityStatus !== "resolved" || !route || route.value === "unknown") {
    return {
      text: "It's unclear how to apply until we confirm the funder and their first application step.",
      tone: "caution",
      recommendSkip: false,
    };
  }

  let text = describeProcessValue("route", route.value);
  if (!firstSupported(facts, "submissionFormat")) {
    text += " We still need to confirm the submission format.";
  }
  if (fiscalSponsorship === true && !firstSupported(facts, "fiscalSponsorPolicy")) {
    text += " Confirm the fiscal-sponsor policy first.";
  }
  return { text, tone: "go", recommendSkip: false };
}
