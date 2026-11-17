import { describe, expect, it } from "vitest";
import {
  buildQualificationVerdict,
  describeProcessValue,
  type QualificationFactView,
} from "../route-copy";

const fact = (
  factKey: string,
  value: unknown,
  supported = true,
): QualificationFactView => ({
  id: `${factKey}-id`,
  factKey,
  value,
  quote: supported ? `Quoted ${factKey}` : null,
  sourceUrl: supported ? "https://example.org/apply" : null,
  sourceReference: null,
  sourceKind: "lookup",
  checkedAt: "2026-09-30T12:00:00.000Z",
  applicantAnswer: "not_sure",
  confirmedValue: null,
});

describe("qualification route copy", () => {
  it.each([
    ["direct_application", "full application"],
    ["loi_first", "short letter of inquiry"],
    ["invitation_only", "invitation"],
    ["eligibility_prescreen", "eligibility quiz or interest form"],
    ["closed_to_unsolicited", "invitation"],
    ["conversation_first", "program officer"],
    ["rfp_only", "active request for proposals"],
    ["unknown", "not clear"],
  ])("explains %s without exposing the stored label", (value, phrase) => {
    const copy = describeProcessValue("route", value);
    expect(copy.toLowerCase()).toContain(phrase);
    expect(copy).not.toContain(value);
  });

  it("uses only quoted facts and makes only an unknown route unclear", () => {
    expect(buildQualificationVerdict({
      facts: [fact("lookup.route", "direct_application", false)],
      identityStatus: "resolved",
      fiscalSponsorship: false,
      governmentProgram: false,
    }).text.toLowerCase()).toContain("unclear");

    const verdict = buildQualificationVerdict({
      facts: [
        fact("lookup.route", "direct_application"),
        fact("lookup.submissionFormat", null, false),
      ],
      identityStatus: "resolved",
      fiscalSponsorship: false,
      governmentProgram: false,
    }).text;
    expect(verdict).toContain("full application");
    expect(verdict).toContain("confirm the submission format");
    expect(verdict.toLowerCase()).not.toContain("unclear");
  });

  it("lets a quoted don't-proceed fact outrank missing facts", () => {
    const verdict = buildQualificationVerdict({
      facts: [fact("lookup.route", "invitation_only")],
      identityStatus: "resolved",
      fiscalSponsorship: "unknown",
      governmentProgram: false,
    });
    expect(verdict.recommendSkip).toBe(true);
    expect(verdict.text).toContain("invited");
    expect(verdict.text.toLowerCase()).not.toContain("unclear");
  });

  it("adds a fiscal-policy caveat only for an applicant who needs a sponsor", () => {
    const facts = [fact("lookup.route", "loi_first")];
    expect(buildQualificationVerdict({ facts, identityStatus: "resolved", fiscalSponsorship: true, governmentProgram: false }).text.toLowerCase())
      .toContain("confirm the fiscal-sponsor policy first");
    expect(buildQualificationVerdict({ facts, identityStatus: "resolved", fiscalSponsorship: false, governmentProgram: false }).text)
      .not.toContain("fiscal-sponsor");
  });

  it("treats RFP-only as closed until a quoted active window is found", () => {
    const route = fact("lookup.route", "rfp_only");
    expect(buildQualificationVerdict({ facts: [route], identityStatus: "resolved", fiscalSponsorship: false, governmentProgram: false }).recommendSkip)
      .toBe(true);
    const openWindow = fact("lookup.window", "Open for an active RFP");
    expect(buildQualificationVerdict({ facts: [route, openWindow], identityStatus: "resolved", fiscalSponsorship: false, governmentProgram: false }).recommendSkip)
      .toBe(false);
  });

  it("uses the government hold state instead of a verdict", () => {
    expect(buildQualificationVerdict({
      facts: [fact("lookup.route", "direct_application")],
      identityStatus: "resolved",
      fiscalSponsorship: false,
      governmentProgram: true,
    }).text).toBe("Not covered yet");
  });
});
