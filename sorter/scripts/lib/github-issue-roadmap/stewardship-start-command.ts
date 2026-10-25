import type { z } from "zod";

import type { StewardshipAssessment, StewardshipMergedRanking } from "./stewardship-assessment";
import type { stewardshipLifecycleSchema } from "./stewardship-policy";
import type { AuthoredStartCommand, StartCommandFieldValue } from "./start-command-values";

export interface StartCommandSeatFacts {
  readonly completion: StewardshipAssessment["completion"];
  readonly premise: StewardshipAssessment["premise"];
  readonly unresolvedChoices: readonly string[];
}
export interface StewardshipStartCommandFacts {
  readonly lifecycle: z.infer<typeof stewardshipLifecycleSchema> | null;
  readonly pullRequests: readonly { readonly state: string; readonly relationship: "closing" | "linked" }[];
  readonly type: string | null;
  readonly body: string;
  readonly hasPlanWithUnits: boolean;
  readonly authoredStartCommand?: AuthoredStartCommand | null;
  /** Only a current assessment belongs here; callers omit stale assessments. */
  readonly assessment?: {
    readonly seats: readonly StartCommandSeatFacts[];
    readonly effort: Readonly<StewardshipMergedRanking["effort"]>;
  } | null;
}
interface StartCommandTableRow {
  readonly row: number;
  readonly predicate: (facts: StewardshipStartCommandFacts) => boolean;
  readonly target: StartCommandFieldValue | ((facts: StewardshipStartCommandFacts) => StartCommandFieldValue);
}

/** Only the heading itself counts; an Outcome heading, prose mentioning acceptance criteria, or a
 * heading inside a fenced code block does not. An unclosed fence hides everything after it. */
function hasAcceptanceCriteriaHeading(body: string): boolean {
  // CommonMark fences: at most three spaces of indent; a backtick opener's info string has no backtick;
  // a closing fence uses the same character, is at least as long as the opener, and has only whitespace after it.
  let fence: { readonly char: string; readonly length: number } | null = null;
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && /^\s*$/.test(marker[2])) fence = null;
      continue;
    }
    if (marker && !(marker[1][0] === "`" && marker[2].includes("`"))) {
      fence = { char: marker[1][0], length: marker[1].length };
      continue;
    }
    if (/^#{2,3} Acceptance criteria[^\S\r\n]*\r?$/i.test(line)) return true;
  }
  return false;
}

function mergedEffort(facts: StewardshipStartCommandFacts): "low" | "medium" | "high" | undefined {
  const effort = facts.assessment?.effort;
  return effort?.status === "merged" ? effort.value : undefined;
}

/** First match wins, after the assessment and Effort pre-checks in deriveStartCommand. */
export const START_COMMAND_TABLE = [
  { row: 1, predicate: (facts) => facts.lifecycle === "Done candidate" || facts.lifecycle === "Stale candidate", target: "none" },
  { row: 2, predicate: (facts) => facts.pullRequests.some((pr) => pr.state.toLowerCase() === "open" && pr.relationship === "closing"), target: "ce-resolve-pr-feedback" },
  { row: 3, predicate: (facts) => facts.assessment?.seats.some((seat) => seat.completion === "complete" || seat.premise === "disproved") === true, target: "none" },
  { row: 4, predicate: (facts) => facts.assessment?.seats.some((seat) => seat.unresolvedChoices.length > 0) === true, target: "ce-brainstorm" },
  { row: 5, predicate: (facts) => facts.authoredStartCommand != null, target: (facts) => facts.authoredStartCommand! },
  { row: 6, predicate: (facts) => facts.type === "Bug", target: "ce-debug" },
  { row: 7, predicate: (facts) => facts.type === "Feature" && facts.hasPlanWithUnits, target: "ce-work" },
  { row: 8, predicate: (facts) => facts.type === "Feature" || (facts.type === "Task" && mergedEffort(facts) === "high"), target: "ce-plan" },
  { row: 9, predicate: (facts) => facts.type === "Task" && hasAcceptanceCriteriaHeading(facts.body)
    && (mergedEffort(facts) === "low" || mergedEffort(facts) === "medium"), target: "ce-work" },
  { row: 10, predicate: () => true, target: "none" },
] as const satisfies readonly StartCommandTableRow[];

export type StartCommandRowNumber = typeof START_COMMAND_TABLE[number]["row"];
export type StartCommandDerivation =
  | { readonly kind: "target"; readonly value: StartCommandFieldValue; readonly row: StartCommandRowNumber }
  | { readonly kind: "hold"; readonly reason: "no_current_assessment" | "effort_unmerged" };

/** Rows from this one on read the assessment, so an assessment without exactly two seats holds here;
 * a stale or duplicate extra seat must not decide row 3 or row 4. */
const ASSESSMENT_REQUIRED_FROM_ROW = 3;
/** The Effort rows start here; an unmerged Effort on a Task holds before them. */
const EFFORT_HOLD_BEFORE_ROW = 8;
const ASSESSMENT_SEAT_COUNT = 2;

export function deriveStartCommand(facts: StewardshipStartCommandFacts): StartCommandDerivation {
  for (const row of START_COMMAND_TABLE) {
    if (row.row === ASSESSMENT_REQUIRED_FROM_ROW && (!facts.assessment || facts.assessment.seats.length !== ASSESSMENT_SEAT_COUNT)) {
      return { kind: "hold", reason: "no_current_assessment" };
    }
    if (row.row === EFFORT_HOLD_BEFORE_ROW && facts.type === "Task" && facts.assessment?.effort.status === "needs_evidence") {
      return { kind: "hold", reason: "effort_unmerged" };
    }
    if (row.predicate(facts)) {
      return { kind: "target", value: typeof row.target === "function" ? row.target(facts) : row.target, row: row.row };
    }
  }
  throw new Error("Start command table must end with an unconditional row");
}
