import { canonicalJsonSha256 } from "./canonical-json";

export const DISPATCHER_CAPABILITY_MANIFEST_SCHEMA = "github-issue-roadmap-dispatcher-capabilities/v1" as const;
export const AUTOMATIC_INTAKE_LIMITS = Object.freeze({
  maxEnvelopeCandidates: 5,
  maxEnvelopeBytes: 64 * 1024,
  maxCandidateBytes: 16 * 1024,
  maxCreatesPerRun: 2,
  maxCommentsPerRun: 5,
  maxCreatesPer24Hours: 5,
  maxCommentsPer24Hours: 20,
});
export type CapabilityEntrypoint = "automatic" | "approval";
export interface DispatcherCapabilityEntry {
  readonly capability: string;
  readonly entrypoint: CapabilityEntrypoint;
  readonly actionKinds: readonly string[];
  readonly enabled: boolean;
  readonly qualification: "unqualified" | "disposable_canary" | "production";
  readonly method: "POST" | "PATCH" | "DELETE";
  readonly endpointPattern: string;
  readonly maxActions: number;
  readonly credentialClass: string;
  readonly proofSha256: string | null;
}
export interface DispatcherCapabilityManifest {
  readonly schemaVersion: typeof DISPATCHER_CAPABILITY_MANIFEST_SCHEMA;
  readonly repository: string;
  readonly capabilities: readonly DispatcherCapabilityEntry[];
}

const AUTOMATIC_CAPABILITY_SHAPES: Readonly<Record<string, { readonly method: DispatcherCapabilityEntry["method"]; readonly endpointSuffix: string }>> = {
  create_issue: { method: "POST", endpointSuffix: "/issues" },
  append_evidence: { method: "POST", endpointSuffix: "/issues/{issue_number}/comments" },
  append_evidence_overlap: { method: "POST", endpointSuffix: "/issues/{issue_number}/comments" },
  close_issue_existence: { method: "PATCH", endpointSuffix: "/issues/{issue_number}" },
  set_type: { method: "PATCH", endpointSuffix: "/issues/{issue_number}" },
  set_priority: { method: "POST", endpointSuffix: "/issues/{issue_number}/issue-field-values" },
  set_effort: { method: "POST", endpointSuffix: "/issues/{issue_number}/issue-field-values" },
};

export function parseDispatcherCapabilityManifest(value: unknown): DispatcherCapabilityManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Capability manifest must be an object.");
  const raw = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(raw).sort()) !== JSON.stringify(["capabilities", "repository", "schemaVersion"].sort()) || raw.schemaVersion !== DISPATCHER_CAPABILITY_MANIFEST_SCHEMA || typeof raw.repository !== "string" || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(raw.repository) || !Array.isArray(raw.capabilities)) throw new Error("Capability manifest has an invalid closed schema.");
  const capabilities = raw.capabilities.map((value, index) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`Capability ${index} must be an object.`);
    const entry = value as unknown as DispatcherCapabilityEntry;
    const expected = ["capability", "entrypoint", "actionKinds", "enabled", "qualification", "method", "endpointPattern", "maxActions", "credentialClass", "proofSha256"].sort();
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expected) || typeof entry.capability !== "string" || !["automatic", "approval"].includes(entry.entrypoint) || !Array.isArray(entry.actionKinds) || entry.actionKinds.length === 0 || entry.actionKinds.some((kind) => typeof kind !== "string") || new Set(entry.actionKinds).size !== entry.actionKinds.length || typeof entry.enabled !== "boolean" || !["unqualified", "disposable_canary", "production"].includes(entry.qualification) || !["POST", "PATCH", "DELETE"].includes(entry.method) || typeof entry.endpointPattern !== "string" || !Number.isSafeInteger(entry.maxActions) || entry.maxActions < 1 || entry.maxActions > 25 || typeof entry.credentialClass !== "string" || (entry.proofSha256 !== null && !/^[0-9a-f]{64}$/.test(entry.proofSha256))) throw new Error(`Capability ${index} is invalid.`);
    if (entry.enabled && entry.qualification !== "production") throw new Error(`Capability ${entry.capability} cannot be enabled before production qualification.`);
    const automaticShape = entry.entrypoint === "automatic" ? AUTOMATIC_CAPABILITY_SHAPES[entry.capability] : undefined;
    if (automaticShape !== undefined) {
      const expectedEndpoint = `/repos/${raw.repository}${automaticShape.endpointSuffix}`;
      if (entry.method !== automaticShape.method || entry.endpointPattern !== expectedEndpoint) throw new Error(`Automatic capability ${entry.capability} method or endpoint is outside its fixed allowlist.`);
    }
    if (entry.entrypoint === "automatic" && entry.capability === "create_issue" && entry.maxActions > AUTOMATIC_INTAKE_LIMITS.maxCreatesPerRun) throw new Error("Automatic create capability exceeds the approved per-run limit.");
    if (entry.entrypoint === "automatic" && ["append_evidence", "append_evidence_overlap"].includes(entry.capability) && entry.maxActions > AUTOMATIC_INTAKE_LIMITS.maxCommentsPerRun) throw new Error("Automatic comment capability exceeds the approved per-run limit.");
    return entry;
  });
  if (new Set(capabilities.map((entry) => entry.capability)).size !== capabilities.length) throw new Error("Capability manifest contains duplicate capability identities.");
  const actionOwners = new Map<string, string>();
  for (const entry of capabilities) for (const kind of entry.actionKinds) {
    const owner = actionOwners.get(kind); if (owner !== undefined) throw new Error(`Action ${kind} is multiply classified by ${owner} and ${entry.capability}.`);
    actionOwners.set(kind, entry.capability);
  }
  return raw as unknown as DispatcherCapabilityManifest;
}

export function dispatcherCapabilityManifestHash(manifest: DispatcherCapabilityManifest): string { return canonicalJsonSha256(parseDispatcherCapabilityManifest(manifest)); }

export function resolveCapabilityForAction(manifest: DispatcherCapabilityManifest, actionKind: string, entrypoint: CapabilityEntrypoint): DispatcherCapabilityEntry {
  const parsed = parseDispatcherCapabilityManifest(manifest);
  const matches = parsed.capabilities.filter((entry) => entry.actionKinds.includes(actionKind));
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `Unknown action ${actionKind}; capability manifest denies it.` : `Action ${actionKind} is multiply classified.`);
  if (matches[0].entrypoint !== entrypoint) throw new Error(`Action ${actionKind} is not permitted through the ${entrypoint} entrypoint.`);
  return matches[0];
}

export function assertCapabilityExecutable(manifest: DispatcherCapabilityManifest, actionKind: string, entrypoint: CapabilityEntrypoint, runtimeEnabled: boolean): DispatcherCapabilityEntry {
  const entry = resolveCapabilityForAction(manifest, actionKind, entrypoint);
  if (!runtimeEnabled || !entry.enabled || entry.qualification !== "production") throw new Error(`Capability ${entry.capability} is disabled or unqualified.`);
  return entry;
}
