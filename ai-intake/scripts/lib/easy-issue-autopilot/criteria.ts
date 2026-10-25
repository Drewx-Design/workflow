export type CoverageMapping = Readonly<Record<string, readonly string[]>>;

/** Reconciliation's Markdown list, bounded by the next peer/parent heading or a
 * trailing deeper heading unless a pre-bullet heading established grouped criteria.
 * Ignore fenced examples; a missing or empty section is never an empty-set pass.
 */
export function parseCriteria(body: string): string[] {
  const criteria: string[] = [];
  let depth = 0;
  let groupingDepth = 0;
  let fence = "";
  for (const line of body.split(/\r?\n/)) {
    const fenced = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenced) {
      if (!fence) fence = fenced[1][0];
      else if (fenced[1][0] === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const headingDepth = heading[1].length;
      if (depth && headingDepth <= depth) break;
      if (depth && criteria.length > 0 && headingDepth !== groupingDepth) break;
      if (depth && !criteria.length && !groupingDepth) groupingDepth = headingDepth;
      if (!depth && /^Acceptance criteria\s*:?$/i.test(heading[2])) depth = heading[1].length;
      continue;
    }
    if (!depth) continue;
    const bullet = /^\s*[-*+]\s+(?:\[[ xX]\]\s*)?(.+?)\s*$/.exec(line);
    if (bullet) criteria.push(bullet[1]);
    else if (/^\s+\S/.test(line) && criteria.length) criteria[criteria.length - 1] += ` ${line.trim()}`;
  }
  return criteria;
}

/** Names are Vitest fullName values from the supplied file's collected cases.
 * This verifies the operator's declaration, never semantic adequacy.
 */
export function verifyCriteriaCoverage(body: string, mapping: CoverageMapping, testCases: readonly string[]) {
  const criteria = parseCriteria(body);
  const names = new Set(testCases);
  const mapped = (criterion: string) => Object.hasOwn(mapping, criterion) && mapping[criterion].length > 0;
  const uncovered = criteria.filter((criterion) => !mapped(criterion));
  const missing = [...new Set(Object.values(mapping).flat().filter((name) => !names.has(name)))];
  const covered = criteria.filter((criterion) => mapped(criterion) && mapping[criterion].every((name) => names.has(name)));
  const reason = !criteria.length ? "No parseable acceptance criteria."
    : uncovered.length ? `Uncovered criteria: ${uncovered.join("; ")}`
    : missing.length ? `Declared test cases do not exist in the supplied check: ${missing.join("; ")}` : undefined;
  return { status: reason ? "refused" as const : "declared" as const, covered, uncovered,
    adequacy: "not-assessed" as const, ...(reason ? { reason } : {}) };
}
