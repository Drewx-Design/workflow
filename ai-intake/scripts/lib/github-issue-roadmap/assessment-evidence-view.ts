import { canonicalJsonSha256 } from "./canonical-json";
import { issueFieldValueIdentity } from "./issue-field-value";
import { markerBlocks, type IntakeIssueSnapshot, type IntakeSnapshotV1 } from "./intake-snapshot";
import type { OutcomeEnvelope } from "./outcome-candidate";
import { effectiveOutcomeCandidates, type DispositionHistory } from "./disposition-selection";

export const ASSESSMENT_EVIDENCE_VIEW_SCHEMA = "github-issue-roadmap-assessment-evidence-view/v1";
export const VIEW_CAP_EXCEEDED_CODE = "view_cap_exceeded" as const;
/**
 * Default hard ceiling on JSON.stringify(view).length. The seat input cap is 1,048,576 and the
 * prompt and the other evidence sections add roughly 60,000, so 900,000 fits with margin.
 */
export const ASSESSMENT_EVIDENCE_VIEW_CHARACTER_CAP = 900_000;
/** Leading and trailing characters an excerpted mandatory body keeps, around its source-marker blocks. */
export const MANDATORY_BODY_EXCERPT_HEAD_CHARACTERS = 6_000;
export const MANDATORY_BODY_EXCERPT_TAIL_CHARACTERS = 2_000;

export class AssessmentEvidenceViewCapError extends Error {
  constructor(size: number, budget: number) {
    super(`${VIEW_CAP_EXCEEDED_CODE}: Assessment evidence view is ${size} characters; the view cap is ${budget} after trimming optional bodies and excerpting long mandatory bodies.`);
    this.name = "AssessmentEvidenceViewCapError";
  }
}

export interface AssessmentEvidenceViewOptions {
  /** Resolved by the caller at its trusted ref; this pure view never reads Git. */
  readonly dispositionHistory: DispositionHistory;
  /** Max issues whose body is included per candidate, before the union. Default 24. */
  readonly neighbourhoodPerCandidate?: number;
  /** Hard ceiling on JSON.stringify(view).length. Default ASSESSMENT_EVIDENCE_VIEW_CHARACTER_CAP. */
  readonly maxViewCharacters?: number;
}

export interface AssessmentEvidenceView extends Omit<IntakeSnapshotV1, "schemaVersion" | "receipts" | "issues" | "markerIndex"> {
  readonly schemaVersion: typeof ASSESSMENT_EVIDENCE_VIEW_SCHEMA;
  readonly receipts: { readonly count: number; readonly sha256: string };
  readonly view: {
    readonly rule: string;
    readonly neighbourhoodIssueNumbers: number[];
    readonly bodiesIncluded: number;
    readonly bodiesOmitted: number;
    readonly truncatedToFit: boolean;
    /** Mandatory issues whose body is shown as an excerpt because the whole bodies did not fit. */
    readonly bodiesExcerpted: number[];
    readonly candidatesWithNoNeighbourhood: string[];
    /**
     * Candidates whose every positive-score lexical pick was trimmed to fit the budget, so the
     * model saw metadata only for them. Recorded, not refused: a refusal here is a silent
     * non-filing with a better label, and the owner ranks that above a repairable duplicate.
     * The sidecar and the filed draft carry this so the omission is visible where it matters.
     */
    readonly trimmedCandidates: string[];
    readonly skipped: readonly { readonly sourceFingerprint: string; readonly stableOutcomeId: string; readonly status: "dispositioned" }[];
  };
  readonly issues: readonly AssessmentEvidenceIssue[];
  readonly markerIndex: Readonly<Record<string, readonly {
    readonly issueNumber: number;
    readonly commentDatabaseId: number | null;
  }[]>>;
}

/**
 * One issue as the model sees it. Fields the model cannot use or cite are dropped: `identity`
 * (the number is the citable id), `bodySha256`, and the comment `nodeId` / `bodySha256` /
 * `updatedAt` -- across 400 issues those id-shaped fields alone cost ~150K characters, which
 * was enough to crowd every optional body out of the budget on the first real run.
 */
export type AssessmentEvidenceIssue = Omit<IntakeIssueSnapshot,
  "body" | "identity" | "bodySha256" | "comments" | "fieldValues" | "nativeType" | "relationships" | "projectMemberships" | "stateReason"> & {
  readonly body: string | null;
  readonly bodyOmitted?: true;
  readonly bodyExcerpted?: true;
  /** Length of the whole body, present only when the body is excerpted. */
  readonly bodyCharacters?: number;
  readonly fields: readonly { readonly name: string; readonly value: string | number | readonly string[] | null }[];
  readonly nativeType?: IntakeIssueSnapshot["nativeType"];
  readonly relationships?: IntakeIssueSnapshot["relationships"];
  readonly projectMemberships?: IntakeIssueSnapshot["projectMemberships"];
  readonly stateReason?: string;
  readonly comments: readonly {
    readonly databaseId: number;
    readonly author: string | null;
    readonly createdAt: string;
    readonly deleted: boolean;
  }[];
};

const STOP_WORDS = new Set("the and for with that this from into are was were will would should have has had not but all any only when then than its our their".split(" "));
const RULE = "Bodies and per-issue evidence are included for the union of candidate source-marker locations, literal #issue references in candidate titles, completion rules and evidence string fields, and the top lexical matches per candidate (default 24); only positive-overlap issues are eligible. Lexical overlap uses distinct lowercase alphanumeric tokens of at least three characters, excludes a fixed stop-word list, weights each match by 1/log(2 + document frequency), and doubles title matches; ties prefer smaller issue numbers. To fit the character budget, optional lexical matches are removed by lowest maximum score across candidates, with larger issue numbers removed first on ties; marker and referenced bodies are never removed. If they still do not fit, the longest marker and referenced bodies are excerpted, longer first with larger issue numbers first on ties, to their first 6000 and last 2000 characters, a note giving the whole length, and every source-marker block between them; an excerpt that would not shrink the view is skipped, view.bodiesExcerpted lists the excerpted issues, and removed lexical matches are restored, highest score first, while they fit. All issues and their non-default metadata, and all marker locations, remain present. Field values are shown as name/value pairs and marker locations as issue and comment ids. Null state reasons and native types, empty relationships, and empty project memberships are omitted.";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactField(raw: unknown, issueNumber: number): AssessmentEvidenceIssue["fields"][number] {
  const field = isObject(raw) ? raw : {};
  const unsupported = (): never => {
    throw new Error(`view_field_shape_unsupported: issue #${issueNumber}; field keys: ${Object.keys(field).sort().join(", ") || "(none)"}.`);
  };
  const { name } = issueFieldValueIdentity(raw);
  if (name === null) return unsupported();
  switch (field.data_type) {
    case "single_select": {
      const option = field.single_select_option;
      if (option === undefined || option === null) return { name, value: null };
      if (!isObject(option) || typeof option.name !== "string") return unsupported();
      return { name, value: option.name };
    }
    case "multi_select": {
      if (!Array.isArray(field.multi_select_options)) return unsupported();
      const value = field.multi_select_options.map((option: unknown) => {
        if (!isObject(option) || typeof option.name !== "string") return unsupported();
        return option.name;
      });
      return { name, value };
    }
    case "iteration": {
      const iteration = field.iteration;
      if (!isObject(iteration) || typeof iteration.title !== "string") return unsupported();
      return { name, value: iteration.title };
    }
    case "text": case "date":
      if (field.value !== null && typeof field.value !== "string") return unsupported();
      return { name, value: field.value };
    case "number":
      if (field.value !== null && (typeof field.value !== "number" || !Number.isFinite(field.value))) return unsupported();
      return { name, value: field.value };
    default:
      return unsupported();
  }
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOP_WORDS.has(token)));
}

export function buildAssessmentEvidenceView(
  snapshot: IntakeSnapshotV1,
  envelope: OutcomeEnvelope,
  options: AssessmentEvidenceViewOptions,
): AssessmentEvidenceView {
  const limit = options.neighbourhoodPerCandidate ?? 24;
  const budget = options.maxViewCharacters ?? ASSESSMENT_EVIDENCE_VIEW_CHARACTER_CAP;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("neighbourhoodPerCandidate must be a non-negative safe integer.");
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("maxViewCharacters must be a non-negative safe integer.");
  const documents = snapshot.issues.map((issue) => ({
    number: issue.number, title: tokens(issue.title), all: tokens(`${issue.title} ${issue.body}`),
  }));
  const frequencies = new Map<string, number>();
  for (const document of documents) {
    for (const token of document.all) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  const existing = new Set(snapshot.issues.map((issue) => issue.number));
  const mandatory = new Set<number>();
  const selected = new Set<number>();
  const scores = new Map<number, number>();
  const neighbourhoods: { fingerprint: string; mandatory: Set<number>; picks: number[] }[] = [];
  const selection = effectiveOutcomeCandidates(envelope, options.dispositionHistory);
  for (const candidate of selection.active) {
    const candidateMandatory = new Set<number>();
    for (const location of snapshot.markerIndex[candidate.sourceFingerprint] ?? []) {
      if (existing.has(location.issueNumber)) candidateMandatory.add(location.issueNumber);
    }
    const candidateText = `${candidate.outcome.title} ${candidate.outcome.completionRule}`;
    const references = [candidateText, ...candidate.evidence.flatMap((item) => Object.values(item).filter((value) => typeof value === "string"))];
    for (const text of references) {
      for (const match of text.matchAll(/#(\d+)/g)) {
        const number = Number(match[1]);
        if (existing.has(number)) candidateMandatory.add(number);
      }
    }
    const candidateTokens = tokens(candidateText);
    const ranked = documents.map((document) => {
      let score = 0;
      for (const token of candidateTokens) {
        if (document.all.has(token)) score += (document.title.has(token) ? 2 : 1) / Math.log(2 + frequencies.get(token)!);
      }
      scores.set(document.number, Math.max(scores.get(document.number) ?? 0, score));
      return { number: document.number, score };
    }).sort((a, b) => b.score - a.score || a.number - b.number);
    const picks = ranked.filter((issue) => issue.score > 0).slice(0, limit).map((issue) => issue.number);
    for (const number of picks) selected.add(number);
    for (const number of candidateMandatory) mandatory.add(number);
    neighbourhoods.push({ fingerprint: candidate.sourceFingerprint, mandatory: candidateMandatory, picks });
  }
  for (const number of mandatory) selected.add(number);
  const removable = [...selected].filter((number) => !mandatory.has(number))
    .sort((a, b) => scores.get(a)! - scores.get(b)! || b - a);
  const receipts = { count: snapshot.receipts.length, sha256: canonicalJsonSha256(snapshot.receipts) };
  const markerIndex = Object.fromEntries(Object.entries(snapshot.markerIndex).map(([fingerprint, locations]) => [
    fingerprint, locations.map(({ issueNumber, commentDatabaseId }) => ({ issueNumber, commentDatabaseId })),
  ]));
  let truncatedToFit = false;
  const excerpts = new Map<number, string>();
  const materialize = (): AssessmentEvidenceView => ({
    schemaVersion: ASSESSMENT_EVIDENCE_VIEW_SCHEMA,
    candidateSha256: snapshot.candidateSha256,
    contentSha256: snapshot.contentSha256,
    censusContentSha256: snapshot.censusContentSha256,
    canonicalSnapshotV2Sha256: snapshot.canonicalSnapshotV2Sha256,
    generatedAt: snapshot.generatedAt,
    repository: snapshot.repository,
    coverage: snapshot.coverage,
    census: snapshot.census,
    markerIndex,
    markerIncidents: snapshot.markerIncidents,
    projectObservation: snapshot.projectObservation,
    receipts,
    view: {
      rule: RULE, neighbourhoodIssueNumbers: [...selected].sort((a, b) => a - b),
      skipped: selection.dispositioned.map(({ sourceFingerprint, stableOutcomeId }) => ({ sourceFingerprint, stableOutcomeId, status: "dispositioned" as const })),
      bodiesIncluded: selected.size, bodiesOmitted: snapshot.issues.length - selected.size, truncatedToFit,
      bodiesExcerpted: [...excerpts.keys()].sort((a, b) => a - b),
      candidatesWithNoNeighbourhood: neighbourhoods.filter((candidate) => candidate.mandatory.size === 0 && candidate.picks.length === 0)
        .map((candidate) => candidate.fingerprint).sort(),
      trimmedCandidates: neighbourhoods
        .filter((candidate) => candidate.mandatory.size === 0 && candidate.picks.length > 0 && !candidate.picks.some((number) => selected.has(number)))
        .map((candidate) => candidate.fingerprint).sort(),
    },
    issues: snapshot.issues.map((issue) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit them
      const { identity: _identity, bodySha256: _bodySha256, comments, fieldValues, nativeType, relationships, projectMemberships, stateReason, ...rest } = issue;
      const shown = {
        ...rest,
        fields: fieldValues.map((field) => compactField(field, issue.number)),
        ...(nativeType === null ? {} : { nativeType: structuredClone(nativeType) }),
        ...(relationships.parent !== null || relationships.subIssues.length > 0 || relationships.blockedBy.length > 0 || relationships.blocking.length > 0
          ? { relationships: structuredClone(relationships) } : {}),
        ...(projectMemberships.length > 0 ? { projectMemberships: structuredClone(projectMemberships) } : {}),
        ...(stateReason === null ? {} : { stateReason }),
        comments: comments.map(({ databaseId, author, createdAt, deleted }) => ({ databaseId, author, createdAt, deleted })),
      };
      if (!selected.has(issue.number)) return { ...shown, body: null, bodyOmitted: true as const, evidence: [] };
      const excerpt = excerpts.get(issue.number);
      return excerpt === undefined ? shown
        : { ...shown, body: excerpt, bodyExcerpted: true as const, bodyCharacters: issue.body.length };
    }),
  });
  let view = materialize();
  let size = JSON.stringify(view).length;
  for (const number of removable) {
    if (size <= budget) break;
    selected.delete(number);
    truncatedToFit = true;
    view = materialize();
    size = JSON.stringify(view).length;
  }
  // Mandatory bodies stay shown, but a verbose neighbourhood must not refuse a small candidate:
  // excerpt the longest first. The marker index above is untouched, so the deterministic
  // source-marker identity checks still see every location.
  const excerptable = snapshot.issues
    .filter((issue) => mandatory.has(issue.number)
      && issue.body.length > MANDATORY_BODY_EXCERPT_HEAD_CHARACTERS + MANDATORY_BODY_EXCERPT_TAIL_CHARACTERS)
    .sort((a, b) => b.body.length - a.body.length || b.number - a.number);
  for (const issue of excerptable) {
    if (size <= budget) break;
    const head = issue.body.slice(0, MANDATORY_BODY_EXCERPT_HEAD_CHARACTERS);
    const tail = issue.body.slice(-MANDATORY_BODY_EXCERPT_TAIL_CHARACTERS);
    const markers = markerBlocks(issue.body).map((block) => block.raw).filter((raw) => !head.includes(raw) && !tail.includes(raw));
    excerpts.set(issue.number, [
      head,
      `[Excerpt: the first ${MANDATORY_BODY_EXCERPT_HEAD_CHARACTERS} and last ${MANDATORY_BODY_EXCERPT_TAIL_CHARACTERS} of ${issue.body.length} body characters${markers.length > 0 ? ", with the source-marker blocks between them" : ""}.]`,
      ...markers,
      tail,
    ].join("\n\n"));
    const previous: { view: AssessmentEvidenceView; size: number; truncatedToFit: boolean } = { view, size, truncatedToFit };
    truncatedToFit = true;
    view = materialize();
    size = JSON.stringify(view).length;
    // A body made mostly of marker blocks can grow when excerpted; keep it whole and try the next.
    if (size >= previous.size) {
      excerpts.delete(issue.number);
      ({ view, size, truncatedToFit } = previous);
    }
  }
  // Excerpting can free more room than it needed: give back trimmed lexical bodies, best score first.
  if (excerpts.size > 0) {
    for (const number of removable.filter((candidate) => !selected.has(candidate)).reverse()) {
      selected.add(number);
      const candidate = materialize();
      const candidateSize = JSON.stringify(candidate).length;
      if (candidateSize > budget) {
        selected.delete(number);
        continue;
      }
      view = candidate;
      size = candidateSize;
    }
  }
  if (size > budget) throw new AssessmentEvidenceViewCapError(size, budget);
  return view;
}
