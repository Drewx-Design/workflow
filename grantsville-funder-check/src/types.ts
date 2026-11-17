// Written for this excerpt. In the private codebase these types come from the
// database schema and the funder-lookup module; this file declares only the
// fields the two excerpted modules read.

/** How a funder accepts a first application. */
export type ProcessRoute =
  | "direct_application" | "loi_first" | "invitation_only"
  | "eligibility_prescreen" | "closed_to_unsolicited" | "conversation_first"
  | "rfp_only" | "unknown";

/** One stored qualification fact, as the stop rules read it. */
export type QualificationFact = {
  factKey: string;
  quote: string | null;
  sourceUrl: string | null;
  applicantAnswer: string;
  confirmedValue: unknown;
};
