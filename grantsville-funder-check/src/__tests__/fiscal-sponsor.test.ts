import { describe, expect, it } from "vitest";
import { buildQualificationVerdict, type QualificationFactView } from "../route-copy";

const sponsorPolicy: QualificationFactView = {
  id: "fiscalSponsorPolicy-id",
  factKey: "lookup.fiscalSponsorPolicy",
  value: "not_allowed",
  quote: "Quoted fiscalSponsorPolicy",
  sourceUrl: "https://example.org/apply",
  sourceReference: null,
  sourceKind: "lookup",
  checkedAt: "2026-09-30T12:00:00.000Z",
  applicantAnswer: "not_sure",
  confirmedValue: null,
};

const route: QualificationFactView = {
  ...sponsorPolicy,
  id: "route-id",
  factKey: "lookup.route",
  value: "direct_application",
  quote: "Quoted route",
};

const verdictFor = (fiscalSponsorship: boolean) =>
  buildQualificationVerdict({
    facts: [route, sponsorPolicy],
    identityStatus: "resolved",
    fiscalSponsorship,
    governmentProgram: false,
  });

describe("fiscal-sponsor exclusion", () => {
  it("recommends skipping a quoted exclusion when the organization uses a fiscal sponsor", () => {
    const verdict = verdictFor(true);
    expect(verdict.recommendSkip).toBe(true);
    expect(verdict.text).toContain("fiscal sponsor");
  });

  it("does not recommend skipping the same exclusion when the organization has no fiscal sponsor", () => {
    expect(verdictFor(false).recommendSkip).toBe(false);
  });
});
