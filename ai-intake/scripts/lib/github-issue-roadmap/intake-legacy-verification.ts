import type { SourceMarkerV1 } from "./source-marker";

export type ClassificationField = "Type" | "Priority" | "Effort";
export interface RequestedClassification { readonly fieldName: ClassificationField; readonly value: string }
export interface ObservedClassification { readonly fieldName: ClassificationField; readonly value: string | null }
export interface LegacyClassification {
  readonly requested: readonly RequestedClassification[];
  readonly observed: readonly ObservedClassification[];
  readonly matches: boolean;
  readonly drift: readonly { readonly fieldName: ClassificationField; readonly requested: string; readonly observed: string | null }[];
}

export interface LegacyVerification {
  readonly legacyRowDigest: string;
  readonly importedFrom: string;
  readonly priorEventRowNumber: number;
  readonly runId: string;
  readonly census: {
    readonly basename: string;
    readonly artifactSha256: string;
    readonly contentSha256: string;
    readonly coverageSha256: string;
    readonly completedAt: string;
  };
  readonly censusMarker: SourceMarkerV1;
  readonly liveMarker: SourceMarkerV1;
  readonly live: { readonly bodySha256: string; readonly createdAt: string; readonly fetchedAt: string; readonly requestId: string | null };
  readonly classification: LegacyClassification;
  readonly operator: string;
  readonly at: string;
}

/** Validate the raw set before filtering null (explicit skip) values. Never accept a vacuous set. */
export function parseLegacyRequested(value: unknown): readonly RequestedClassification[] | null {
  if (!Array.isArray(value)) return null;
  const names = new Set<string>();
  const requested: RequestedClassification[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const item = raw as Record<string, unknown>;
    if ((item.fieldName !== "Type" && item.fieldName !== "Priority" && item.fieldName !== "Effort")
      || names.has(item.fieldName) || (item.value !== null && (typeof item.value !== "string" || item.value.trim() === ""))) return null;
    names.add(item.fieldName);
    if (item.value !== null) requested.push({ fieldName: item.fieldName, value: item.value as string });
  }
  return requested.length === 0 ? null : requested;
}

/** Observations include all three fields; sparse requests compare only the requested fields. */
export function compareLegacyClassification(
  requested: readonly RequestedClassification[], observed: readonly ObservedClassification[],
): LegacyClassification {
  if (parseLegacyRequested(requested) === null || !Array.isArray(observed) || observed.length !== 3
    || new Set(observed.map((item) => item?.fieldName)).size !== 3
    || observed.some((item) => item === null || !["Type", "Priority", "Effort"].includes(item.fieldName)
      || (item.value !== null && (typeof item.value !== "string" || item.value.trim() === "")))) {
    throw new Error("Invalid legacy classification observation.");
  }
  const drift = requested.flatMap((item) => {
    const value = observed.find((entry) => entry.fieldName === item.fieldName)!.value;
    return value === item.value ? [] : [{ fieldName: item.fieldName, requested: item.value, observed: value }];
  });
  return { requested, observed, matches: drift.length === 0, drift };
}
