import type { OperatorIntakeApprovalTransport } from "../../github-issue-roadmap-intake-apply";
import type { OwnershipIssueReadPort, OwnershipLiveIssue } from "./intake-create-reconciliation";
import type { ObservedClassification } from "./intake-legacy-verification";

import { CANONICAL_REST_API_VERSION } from "./snapshot-v2";

const GITHUB_API_ROOT = "https://api.github.com";

const FIELD_WRITE_TIMELINE_QUERY = `query IntakeFieldWriteReceipt($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      timelineItems(last: 100, itemTypes: [ISSUE_FIELD_ADDED_EVENT, ISSUE_FIELD_CHANGED_EVENT, ISSUE_FIELD_REMOVED_EVENT]) {
        nodes {
          ... on IssueFieldAddedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } } options { name } value }
          ... on IssueFieldChangedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } } newOptions { name } previousOptions { name } newValue previousValue }
          ... on IssueFieldRemovedEvent { __typename id actor { login } createdAt issueField { ... on IssueFieldSingleSelect { id fullDatabaseId name } } options { name } }
        }
      }
    }
  }
}`;

interface GitHubIntakeApprovalTransportInput {
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
}

type JsonObject = Record<string, unknown>;

class GitHubIntakeRequestError extends Error {
  constructor(message: string, readonly status: number | null, options?: ErrorOptions) {
    super(message, options);
  }
}

export function hasGitHubRequestStatus(error: unknown): error is { readonly status: number | null } {
  return error !== null && typeof error === "object" && "status" in error
    && (error.status === null || typeof error.status === "number");
}

// Optional dispatch fences leave the fake/operator transport contract unchanged.
export type FencedIntakeApprovalTransport = {
  [Method in keyof OperatorIntakeApprovalTransport]: Method extends
    "createIssue" | "appendEvidenceComment" | "closeIssue" | "applyClassification"
    ? (...args: [...Parameters<OperatorIntakeApprovalTransport[Method]>, fence?: () => void]) =>
      ReturnType<OperatorIntakeApprovalTransport[Method]>
    : OperatorIntakeApprovalTransport[Method];
};

interface IssueFieldDefinition {
  readonly id: number;
  readonly nodeId?: string;
  readonly name: "Priority" | "Effort";
  readonly options: readonly { readonly id: string | number; readonly name: string }[];
}

interface ClassificationPreflightEntry {
  readonly sourceFingerprint: string;
  readonly repository: string;
  readonly classifications: readonly {
    readonly fieldName: "Type" | "Priority" | "Effort";
    readonly value: string;
  }[];
}

export interface ClassificationReadPort {
  /** Reuses Type from the targeted issue GET; reads all current field-value pages. No writes. */
  readClassifications(repository: string, issueNumber: number, issue: OwnershipLiveIssue): Promise<readonly ObservedClassification[]>;
}

export interface FieldWriteReceipt {
  readonly eventId: string;
  readonly eventCreatedAt: string;
  readonly readBackAt: string;
  readonly writeStartedAt: string;
}

export interface FieldEventSnapshot {
  readonly eventIds: Set<string>;
  readonly currentValue: string | null;
}

export interface FieldWriteReadPort {
  /** A complete pre-write event set; unavailable or truncated evidence returns null. */
  snapshotFieldEvents(repository: string, issueNumber: number, fieldName: "Priority" | "Effort"): Promise<FieldEventSnapshot | null>;
  /** Best-effort provenance only: unavailable or ambiguous evidence returns null. */
  readBackFieldWrite(repository: string, issueNumber: number, write: {
    readonly fieldName: "Priority" | "Effort";
    readonly value: string;
    readonly writeStartedAt: string;
    readonly snapshot: FieldEventSnapshot | null;
  }): Promise<FieldWriteReceipt | null>;
}

function repositoryPath(repository: string): string {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part === "" || part.trim() !== part)) {
    throw new Error("GitHub repository must be exactly one non-empty owner/name pair.");
  }
  return `${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

function asObject(value: unknown, context: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`GitHub returned an invalid ${context} response.`);
  }
  return value as JsonObject;
}

function positiveInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`GitHub returned an invalid ${context}.`);
  }
  return value;
}

function nonEmptyString(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`GitHub returned an invalid ${context}.`);
  }
  return value;
}

function identifier(value: unknown, context: string): string | number {
  if (typeof value === "string" && value.trim() !== "") return value;
  return positiveInteger(value, context);
}

function fieldEventValues(options: unknown, value: unknown): readonly string[] {
  if (options !== null && !Array.isArray(options)) throw new Error("Invalid issue-field event options.");
  if (value !== null && typeof value !== "string") throw new Error("Invalid issue-field event value.");
  const names = (options ?? []).map((option: unknown) =>
    nonEmptyString(asObject(option, "event option").name, "event option name"));
  return [...new Set([...names, ...(value === null || value === "" ? [] : [value])])];
}

export function createGitHubIntakeApprovalTransport(
  input: GitHubIntakeApprovalTransportInput,
): FencedIntakeApprovalTransport & OwnershipIssueReadPort & ClassificationReadPort & FieldWriteReadPort {
  const token = input.token.trim();
  if (token === "") {
    throw new Error("GitHub intake approval transport requires a non-empty token.");
  }
  const redact = (message: string): string => message.replaceAll(token, "[redacted]");
  const responseDiagnostic = (body: string): string => redact(body).slice(0, 512);
  const fetchImpl = input.fetchImpl ?? fetch;
  const fieldDefinitionsByOwner = new Map<string, Promise<ReadonlyMap<string, IssueFieldDefinition>>>();
  const issueTypesByOwner = new Map<string, Promise<readonly string[]>>();
  let viewerLogin: Promise<string | null> | undefined;

  const fetchResponse = async (url: string, init: RequestInit): Promise<Response> => {
    try {
      return await fetchImpl(url, init);
    } catch (error) {
      throw new GitHubIntakeRequestError(redact(error instanceof Error ? error.message : String(error)), null, { cause: error });
    }
  };
  const responseText = async (response: Response): Promise<string> => {
    try { return await response.text(); }
    catch (error) {
      throw new GitHubIntakeRequestError(redact(error instanceof Error ? error.message : String(error)), null, { cause: error });
    }
  };

  const request = async (method: "GET" | "PATCH" | "POST", path: string, body?: JsonObject, fence: () => void = () => {}, receipt?: (response: Response) => void): Promise<unknown> => {
    const url = `${GITHUB_API_ROOT}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": CANONICAL_REST_API_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    if (method !== "GET") fence();
    const response = await fetchResponse(url, init);
    const responseBody = await responseText(response);
    if (!response.ok) {
      throw new GitHubIntakeRequestError(`${redact(`GitHub request failed with status ${response.status}: `)}${responseDiagnostic(responseBody)}`, response.status);
    }
    receipt?.(response);
    try {
      return JSON.parse(responseBody) as unknown;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(`${redact("GitHub returned invalid JSON: ")}${responseDiagnostic(error.message)}`);
      }
      throw error;
    }
  };

  const write = async (method: "PATCH" | "POST", path: string, body: JsonObject, fence?: () => void): Promise<JsonObject> =>
    asObject(await request(method, path, body, fence), "JSON");

  const graphql = async (query: string, variables?: JsonObject, received?: () => void): Promise<JsonObject> => {
    const result = asObject(await request("POST", "/graphql", {
      query, ...(variables === undefined ? {} : { variables }),
    }, undefined, received), "GraphQL");
    if (result.errors !== undefined && (!Array.isArray(result.errors) || result.errors.length > 0)) {
      throw new Error("GitHub returned GraphQL errors.");
    }
    return asObject(result.data, "GraphQL data");
  };

  const filingLogin = (): Promise<string | null> => {
    viewerLogin ??= (async () => {
      try {
        const data = await graphql("query IntakeFilingViewer { viewer { login } }");
        return nonEmptyString(asObject(data.viewer, "viewer").login, "viewer login");
      } catch { return null; }
    })();
    return viewerLogin;
  };

  const writeClassification = async (method: "PATCH" | "POST", path: string, body: JsonObject, fence: () => void = () => {}): Promise<void> => {
    const url = `${GITHUB_API_ROOT}${path}`;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": CANONICAL_REST_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    };
    fence();
    const response = await fetchResponse(url, init);
    if (!response.ok) {
      throw new GitHubIntakeRequestError(`${redact(`GitHub request failed with status ${response.status}: `)}${responseDiagnostic(await responseText(response))}`, response.status);
    }
  };

  const fieldDefinitions = (owner: string): Promise<ReadonlyMap<string, IssueFieldDefinition>> => {
    let pending = fieldDefinitionsByOwner.get(owner);
    if (pending !== undefined) return pending;
    pending = (async () => {
      const raw = await request("GET", `/orgs/${encodeURIComponent(owner)}/issue-fields?per_page=100`);
      const container = Array.isArray(raw) ? raw : asObject(raw, "issue fields").issue_fields;
      if (!Array.isArray(container)) throw new Error("GitHub returned an invalid issue fields response.");
      const definitions = new Map<string, IssueFieldDefinition>();
      for (const [index, rawField] of container.entries()) {
        const field = asObject(rawField, `issue field[${index}]`);
        if (field.name !== "Priority" && field.name !== "Effort") continue;
        const options = Array.isArray(field.options)
          ? field.options.map((rawOption, optionIndex) => {
            const option = asObject(rawOption, `${field.name} option[${optionIndex}]`);
            const name = nonEmptyString(option.name, `${field.name} option[${optionIndex}] name`);
            return {
              id: option.id === undefined ? name : identifier(option.id, `${field.name} option[${optionIndex}] id`),
              name,
            };
          })
          : [];
        definitions.set(field.name, {
          id: positiveInteger(field.id, `${field.name} field id`),
          ...(typeof field.node_id === "string" && field.node_id !== "" ? { nodeId: field.node_id } : {}),
          name: field.name,
          options,
        });
      }
      return definitions;
    })();
    pending.catch(() => {
      if (fieldDefinitionsByOwner.get(owner) === pending) fieldDefinitionsByOwner.delete(owner);
    });
    fieldDefinitionsByOwner.set(owner, pending);
    return pending;
  };

  const issueTypes = (owner: string): Promise<readonly string[]> => {
    let pending = issueTypesByOwner.get(owner);
    if (pending !== undefined) return pending;
    pending = (async () => {
      const raw = await request("GET", `/orgs/${encodeURIComponent(owner)}/issue-types?per_page=100`);
      const container = Array.isArray(raw) ? raw : asObject(raw, "issue types").issue_types;
      if (!Array.isArray(container)) throw new Error("GitHub returned an invalid issue types response.");
      return container.map((rawType, index) =>
        nonEmptyString(asObject(rawType, `issue type[${index}]`).name, `issue type[${index}] name`));
    })();
    pending.catch(() => {
      if (issueTypesByOwner.get(owner) === pending) issueTypesByOwner.delete(owner);
    });
    issueTypesByOwner.set(owner, pending);
    return pending;
  };

  const preflightClassifications = async (entries: readonly ClassificationPreflightEntry[]): Promise<void> => {
    const failures: string[] = [];
    const checks = entries.flatMap((entry) => entry.classifications.map((classification) => ({
      entry,
      classification,
      owner: entry.repository.split("/")[0]!,
    })));
    const ownersNeedingFields = [...new Set(checks.filter(({ classification }) =>
      classification.fieldName !== "Type").map(({ owner }) => owner))];
    const ownersNeedingTypes = [...new Set(checks.filter(({ classification }) =>
      classification.fieldName === "Type").map(({ owner }) => owner))];
    const fields = new Map<string, ReadonlyMap<string, IssueFieldDefinition>>();
    const fieldErrors = new Map<string, unknown>();
    const types = new Map<string, readonly string[]>();
    const typeErrors = new Map<string, unknown>();

    await Promise.all(ownersNeedingFields.map(async (owner) => {
      try { fields.set(owner, await fieldDefinitions(owner)); }
      catch (error) { fieldErrors.set(owner, error); }
    }));
    await Promise.all(ownersNeedingTypes.map(async (owner) => {
      try { types.set(owner, await issueTypes(owner)); }
      catch (error) { typeErrors.set(owner, error); }
    }));

    for (const { entry, classification, owner } of checks) {
      const prefix = `${entry.sourceFingerprint}: ${classification.fieldName}=${classification.value}`;
      if (classification.fieldName === "Type") {
        const error = typeErrors.get(owner);
        if (error !== undefined) {
          failures.push(`${prefix} could not be validated: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
        const liveTypes = types.get(owner) ?? [];
        if (!liveTypes.includes(classification.value)) {
          failures.push(`${prefix} is not a live issue type. Live types: ${liveTypes.join(", ") || "none"}.`);
        }
        continue;
      }
      const error = fieldErrors.get(owner);
      if (error !== undefined) {
        failures.push(`${prefix} could not be validated: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const definition = fields.get(owner)?.get(classification.fieldName);
      if (definition === undefined) {
        failures.push(`${prefix} cannot be applied because the organization issue field was not found.`);
      } else if (!definition.options.some((option) => option.name === classification.value)) {
        failures.push(
          `${prefix} is not a live option. Live options: ${definition.options.map((option) => option.name).join(", ") || "none"}.`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(redact(`Classification preflight refused:\n${failures.map((failure) => `- ${failure}`).join("\n")}`));
    }
  };

  const readFieldEvents = async (repository: string, issueNumber: number, fieldName: "Priority" | "Effort") => {
    repositoryPath(repository);
    positiveInteger(issueNumber, "issue number");
    const [owner, repo] = repository.split("/");
    const definition = (await fieldDefinitions(owner)).get(fieldName);
    if (definition === undefined) return null;
    let readBackAt = "";
    const data = await graphql(FIELD_WRITE_TIMELINE_QUERY, { owner, repo, number: issueNumber },
      () => { readBackAt = new Date().toISOString(); });
    const issue = asObject(asObject(data.repository, "repository").issue, "issue");
    const nodes = asObject(issue.timelineItems, "timeline").nodes;
    // A full page cannot prove the complete event set, even if just one node matches.
    if (!Array.isArray(nodes) || nodes.length >= 100) return null;
    const events: { eventId: string; eventCreatedAt: string; actor: string | null; values: readonly string[] }[] = [];
    for (const raw of nodes) {
      const event = asObject(raw, "field event");
      if (event.__typename !== "IssueFieldAddedEvent" && event.__typename !== "IssueFieldChangedEvent"
        && event.__typename !== "IssueFieldRemovedEvent") return null;
      const eventId = nonEmptyString(event.id, "field event id");
      const eventCreatedAt = nonEmptyString(event.createdAt, "field event createdAt");
      if (!Number.isFinite(Date.parse(eventCreatedAt))) return null;
      const actor = event.actor === null ? null : nonEmptyString(asObject(event.actor, "actor").login, "actor login");
      const field = asObject(event.issueField, "event field");
      const name = nonEmptyString(field.name, "event field name");
      // fullDatabaseId is the REST field id; GraphQL id is an opaque node id.
      const databaseId = field.fullDatabaseId == null ? null : identifier(field.fullDatabaseId, "event field database id");
      const nodeId = field.id == null ? null : nonEmptyString(field.id, "event field node id");
      // Removed options describe the previous value, never a current value or receipt.
      const values = event.__typename === "IssueFieldRemovedEvent" ? [] : event.__typename === "IssueFieldAddedEvent"
        ? fieldEventValues(event.options, event.value) : fieldEventValues(event.newOptions, event.newValue);
      if (name !== fieldName) continue;
      // Identity needs a positive id match. A same-named field with a definitely different id is
      // another field; anything else (no comparable id, or ids that disagree) is inconclusive,
      // because silently skipping a real event of this field could hide a human change.
      const idMatches = (databaseId !== null && String(databaseId) === String(definition.id))
        || (nodeId !== null && definition.nodeId !== undefined && nodeId === definition.nodeId);
      const idConflicts = (databaseId !== null && String(databaseId) !== String(definition.id))
        || (nodeId !== null && definition.nodeId !== undefined && nodeId !== definition.nodeId);
      if (idConflicts && !idMatches) continue;
      if (!idMatches || idConflicts) return null;
      events.push({ eventId, eventCreatedAt, actor, values });
    }
    return { events, readBackAt };
  };

  return {
    supportsCloseIssue: true,
    preflightClassifications,
    snapshotFieldEvents: async (repository, issueNumber, fieldName) => {
      try {
        const page = await readFieldEvents(repository, issueNumber, fieldName);
        if (page === null) return null;
        // Timeline connection order supplies the latest value without comparing clocks.
        const values = page.events.at(-1)?.values ?? [];
        if (values.length > 1) return null;
        return { eventIds: new Set(page.events.map(event => event.eventId)), currentValue: values[0] ?? null };
      } catch { return null; }
    },
    readBackFieldWrite: async (repository, issueNumber, write) => {
      try {
        const snapshot = write.snapshot;
        if (snapshot == null || snapshot.currentValue === write.value) return null;
        const login = await filingLogin();
        if (login === null) return null;
        const page = await readFieldEvents(repository, issueNumber, write.fieldName);
        if (page === null) return null;
        // Count every new event for this field before checking value or actor.
        const added = page.events.filter(event => !snapshot.eventIds.has(event.eventId));
        if (added.length !== 1) return null;
        const event = added[0];
        if (event.values.length !== 1 || event.values[0] !== write.value || event.actor !== login) return null;
        // Accepted residual (coordinator decision 2026-10-06). A human can still be certified if
        // they (1) act as the filing account itself, (2) set exactly the written value, and (3) do
        // it in the window between this snapshot's response and filing's POST reaching GitHub
        // (about 0.2-1 s). Filing's POST is then a no-op and the one new event is theirs. It cannot
        // be closed client-side: the field-values POST returns no event and takes no idempotency
        // key, so a same-value write is indistinguishable from a no-op. It is tolerable because
        // every sorter Priority clear appears in a snapshot the operator approves before execution, and the
        // first approved cycle is report-only, so it cannot produce a silent write. The closing
        // path is a dedicated filing account: actor equality then becomes real provenance.
        // Local timestamps are audit metadata only, never provenance matching inputs.
        return { eventId: event.eventId, eventCreatedAt: event.eventCreatedAt,
          readBackAt: page.readBackAt, writeStartedAt: write.writeStartedAt };
      } catch { return null; }
    },
    fetchIssue: async (repository, issueNumber) => {
      let requestId: string | undefined;
      const result = asObject(await request("GET",
        `/repos/${repositoryPath(repository)}/issues/${positiveInteger(issueNumber, "issue number")}`,
        undefined, undefined, (response) => { requestId = response.headers.get("x-github-request-id") ?? undefined; }), "issue");
      if (result.body !== null && typeof result.body !== "string") throw new Error("GitHub returned an invalid issue body.");
      const createdAt = nonEmptyString(result.created_at, "issue created_at");
      if (!Number.isFinite(Date.parse(createdAt))) throw new Error("GitHub returned an invalid issue created_at.");
      return {
        number: positiveInteger(result.number, "issue number"), id: identifier(result.id, "issue id"),
        nodeId: nonEmptyString(result.node_id, "issue node_id"), body: result.body ?? "",
        isPullRequest: "pull_request" in result, htmlUrl: nonEmptyString(result.html_url, "issue html_url"),
        createdAt, fetchedAt: new Date().toISOString(), ...(requestId === undefined ? {} : { requestId }),
        typeName: result.type == null ? null : nonEmptyString(asObject(result.type, "issue type").name, "issue type name"),
      };
    },
    readClassifications: async (repository, issueNumber, issue) => {
      if (issue.number !== issueNumber || issue.typeName === undefined) throw new Error("Classification observation requires the targeted issue read.");
      const definitions = await fieldDefinitions(repository.split("/")[0]!);
      const endpoint = `/repos/${repositoryPath(repository)}/issues/${issueNumber}/issue-field-values?per_page=100`;
      const values: JsonObject[] = [];
      let page = 1;
      while (true) {
        let hasNext = false;
        const raw = await request("GET", page === 1 ? endpoint : `${endpoint}&page=${page}`, undefined, undefined,
          (response) => { hasNext = Boolean(response.headers.get("link")?.split(",").some((entry) => /rel="next"/.test(entry))); });
        if (!Array.isArray(raw)) throw new Error("GitHub returned an invalid issue field values response.");
        values.push(...raw.map((value, index) => asObject(value, `issue field value[${index}]`)));
        if (!hasNext) break;
        page += 1;
      }
      const observed: ObservedClassification[] = [{ fieldName: "Type", value: issue.typeName }];
      for (const fieldName of ["Priority", "Effort"] as const) {
        const definition = definitions.get(fieldName);
        const selected = definition === undefined ? [] : values.filter((value) => value.issue_field_id === definition.id);
        if (selected.length > 1) throw new Error(`GitHub returned duplicate ${fieldName} values.`);
        const option = selected[0]?.single_select_option;
        if (option == null) { observed.push({ fieldName, value: null }); continue; }
        const item = asObject(option, `${fieldName} selected option`);
        const value = item.name ?? definition?.options.find((candidate) => candidate.id === item.id)?.name;
        observed.push({ fieldName, value: nonEmptyString(value, `${fieldName} selected option name`) });
      }
      return observed;
    },
    createIssue: async (repository, payload, fence) => {
      const result = await write("POST", `/repos/${repositoryPath(repository)}/issues`, {
        title: payload.title,
        body: payload.body,
      }, fence);
      return {
        issueNumber: positiveInteger(result.number, "issue number"),
        issueId: nonEmptyString(result.node_id, "issue node_id"),
      };
    },
    appendEvidenceComment: async (repository, issueNumber, body, fence) => {
      const result = await write("POST",
        `/repos/${repositoryPath(repository)}/issues/${issueNumber}/comments`,
        { body },
        fence,
      );
      return { commentId: positiveInteger(result.id, "comment id") };
    },
    closeIssue: async (repository, issueNumber, fence) => {
      const result = await write("PATCH",
        `/repos/${repositoryPath(repository)}/issues/${positiveInteger(issueNumber, "issue number")}`,
        { state: "closed", state_reason: "completed" }, fence);
      if (result.number !== issueNumber || result.state !== "closed") {
        throw new Error("GitHub did not confirm the requested issue was closed.");
      }
    },
    applyClassification: async (repository, issueNumber, classification, fence) => {
      if ((classification.fieldName as string) === "Horizon") {
        throw new Error("Routine intake structurally forbids writing a Horizon classification.");
      }
      const path = repositoryPath(repository);
      if (classification.fieldName === "Type") {
        await writeClassification("PATCH", `/repos/${path}/issues/${issueNumber}`, {
          type: classification.value,
        }, fence);
        return {};
      }
      const owner = repository.split("/")[0]!;
      const definition = (await fieldDefinitions(owner)).get(classification.fieldName);
      if (definition === undefined) {
        throw new Error(redact(`Organization issue field ${classification.fieldName} was not found.`));
      }
      if (!definition.options.some((option) => option.name === classification.value)) {
        throw new Error(redact(
          `${classification.value} is not a live option for ${classification.fieldName}. ` +
          `Live options: ${definition.options.map((option) => option.name).join(", ") || "none"}.`,
        ));
      }
      await writeClassification("POST", `/repos/${path}/issues/${issueNumber}/issue-field-values`, {
        issue_field_values: [{ field_id: definition.id, value: classification.value }],
      }, fence);
      return {};
    },
    verifyClassifications: async (repository, issueNumber, classifications) => {
      if (classifications.length === 0) return true;
      const path = repositoryPath(repository);
      const issue = asObject(await request("GET", `/repos/${path}/issues/${issueNumber}`), "issue");
      const type = issue.type === null || issue.type === undefined ? null : asObject(issue.type, "issue type").name;
      const owner = repository.split("/")[0]!;
      const definitions = await fieldDefinitions(owner);
      const rawValues = await request("GET", `/repos/${path}/issues/${issueNumber}/issue-field-values?per_page=100`);
      const values = Array.isArray(rawValues)
        ? rawValues.map((value, index) => asObject(value, `issue field value[${index}]`))
        : [];
      return classifications.every((classification) => {
        if (classification.fieldName === "Type") return type === classification.value;
        const definition = definitions.get(classification.fieldName);
        const option = definition?.options.find((candidate) => candidate.name === classification.value);
        return definition !== undefined && option !== undefined && values.some((value) =>
          value.issue_field_id === definition.id
          && asObject(value.single_select_option, `${classification.fieldName} selected option`).id === option.id);
      });
    },
  };
}
