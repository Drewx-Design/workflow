import { canonicalJsonSha256, sha256Bytes } from "./canonical-json";
import { issueFieldValueIdentity } from "./issue-field-value";
import type { BoundStewardshipEvidence } from "./stewardship-assessment";
import type { CollectStewardshipEvidenceOptions, StewardshipEvidenceGeneration, StewardshipTargetGeneration, StewardshipTargetResult } from "./stewardship-evidence";
import { CANONICAL_REST_API_VERSION, VERIFICATION_MARKER, type VerificationCommentInput } from "./snapshot-v2";
import { stewardshipOperationField, stewardshipOperationValue, stewardshipOperationSchema, stewardshipSortKeySchema, type StewardshipOperation } from "./stewardship-policy";
import { timeStewardshipAsync, type StewardshipTimingCollector } from "./stewardship-phase-timing";

export function stewardshipSortKeyMatches(actual: unknown, target: unknown, format: "value" | "event" = "value"): boolean {
  if (target === null) return format === "event" ? Array.isArray(actual) && actual.length === 0 : actual === null;
  const parsed = stewardshipSortKeySchema.safeParse(target);
  return parsed.success && (format === "event" ? Array.isArray(actual) && actual.length === 1 && actual[0] === String(parsed.data) : actual === parsed.data);
}

export interface StewardshipObservation {
  readonly evidence: BoundStewardshipEvidence;
  readonly census: { readonly complete: boolean; readonly nowCount: number };
  readonly comments: readonly VerificationCommentInput[];
  readonly commentsComplete: boolean;
}
export interface StewardshipSendReceipt {
  readonly httpStatus: number;
  readonly requestId: string | null;
  /** Null if the body could not be read completely within the existing cap. */
  readonly responseBodyBytes: number | null;
  readonly responseBodySha256: string | null;
  readonly targetFieldValuePresent: boolean | null;
}
export interface StewardshipGitHub {
  observe(issueNumber: number): Promise<StewardshipObservation>;
  /** Optional capability until the executor adopts batch preflight. */
  observeMany?(issueNumbers: readonly number[]): Promise<readonly StewardshipBatchObservation[]>;
  /** Optional until snapshot fence/readback scheduling adopts target completeness. */
  observeTarget?(issueNumber: number, options?: { readonly readback?: boolean }): Promise<StewardshipTargetObservation>;
  send(issueNumber: number, operation: StewardshipOperation, commentBody: string | undefined, beforeSend: () => Promise<void>): Promise<StewardshipSendReceipt | void>;
}
/** A closed read capability; the facade never inherits the transport prototype. */
export interface StewardshipRehearsalTransport {
  observe: StewardshipGitHub["observe"];
  observeMany: NonNullable<StewardshipGitHub["observeMany"]>;
  observeTarget: NonNullable<StewardshipGitHub["observeTarget"]>;
  rateLimits(): ReturnType<StewardshipTimingCollector["snapshot"]>["rateLimits"];
}
export function createStewardshipRehearsalTransport(github: StewardshipGitHub,
  rateLimits: StewardshipRehearsalTransport["rateLimits"]): StewardshipRehearsalTransport {
  if (!github.observeMany || !github.observeTarget) throw new Error("snapshot_observation_capabilities_required");
  const facade = Object.create(null) as StewardshipRehearsalTransport;
  Object.defineProperties(facade, {
    observe: { value: github.observe.bind(github), enumerable: true },
    observeMany: { value: github.observeMany.bind(github), enumerable: true },
    observeTarget: { value: github.observeTarget.bind(github), enumerable: true },
    rateLimits: { value: rateLimits, enumerable: true },
  });
  return Object.freeze(facade);
}
export type StewardshipBatchObservation =
  | ({ readonly issueNumber: number; readonly status: "ok" } & StewardshipObservation)
  | { readonly issueNumber: number; readonly status: "absent" | "unavailable" | "unstable"; readonly nextEligibleAt?: string | null };
export type StewardshipTargetObservation =
  | ({ readonly issueNumber: number; readonly status: "ok"; readonly targetCompleteness: NonNullable<Extract<StewardshipTargetResult, { status: "ok" }>["targetCompleteness"]> }
      & Omit<StewardshipObservation, "census">)
  | Extract<StewardshipTargetResult, { status: "absent" | "unavailable" | "unstable" }>;
type BatchCollectOptions = Pick<CollectStewardshipEvidenceOptions, "selection" | "targetResults" | "stabilityScope" | "withComments">;
interface GitHubOptions {
  readonly repository: string;
  readonly operator: string;
  readonly getToken: () => string;
  readonly collect: (issueNumber: number) => Promise<Pick<StewardshipObservation, "evidence" | "census">>;
  /** The caller supplies the phase and per-issue layouts, as for single-target collect. */
  readonly collectMany?: (options: BatchCollectOptions) => StewardshipEvidenceGeneration | Promise<StewardshipEvidenceGeneration>;
  readonly collectTarget?: (options: BatchCollectOptions & { readonly targetObservation: true; readonly targetReadback?: boolean }) => StewardshipTargetGeneration | Promise<StewardshipTargetGeneration>;
  readonly now: () => string;
  readonly deadlineAt: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly phaseTiming?: StewardshipTimingCollector;
}
class StewardshipGitHubError extends Error {
  constructor(readonly status: number | null, readonly sent: boolean, readonly nextEligibleAt: string | null = null, readonly definitelyRejected = false) {
    super(status === null ? "Stewardship GitHub request refused or incomplete" : `Stewardship GitHub request failed (${status})`);
  }
}
const API = "https://api.github.com";
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StewardshipGitHubError(null, false);
  return value as Record<string, unknown>;
}
function issueId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new StewardshipGitHubError(null, false);
  return value;
}
function validateComment(issue: number, purpose: "verification" | "decision", body: string | undefined, hash: string): string {
  if (typeof body !== "string" || Buffer.byteLength(body) > 4096 || canonicalJsonSha256(body) !== hash) throw new StewardshipGitHubError(null, false);
  const lines = body.split("\n");
  const valid = purpose === "verification"
    ? lines.length === 4 && lines[0] === VERIFICATION_MARKER && /^origin-main-sha: [a-f0-9]{40}$/.test(lines[1])
      && /^verified-at: /.test(lines[2]) && Number.isFinite(Date.parse(lines[2].slice(13)))
      && new RegExp(`^check: stewardship current-code inspection; issue=${issue}; evidence=[a-f0-9]{64}; assessments=[a-f0-9]{64},[a-f0-9]{64}; clause-proof=[a-f0-9]{64}$`).test(lines[3])
    : lines.length === 7 && lines[0] === "<!-- github-issue-roadmap-stewardship-decision:v1 -->" && lines[1] === `Issue: ${issue}`
      && /^Priority: (?:P[0-3]|unset) -> (?:P[0-3]|unset)$/.test(lines[2])
      && /^Horizon: (?:Now|Next|Later|Parked|Inbox) -> (?:Now|Next|Later|Parked|Inbox)$/.test(lines[3])
      && /^Current main: [a-f0-9]{40}$/.test(lines[4]) && /^Evidence: [a-f0-9]{64}$/.test(lines[5])
      && /^Assessments: [a-f0-9]{64},[a-f0-9]{64}$/.test(lines[6]);
  if (!valid) throw new StewardshipGitHubError(null, false);
  return body;
}

interface PageResponse { readonly value: unknown; readonly link: string | null; readonly sendReceipt?: StewardshipSendReceipt }

/** Shared traversal for synchronous collector reads and asynchronous transport reads. */
function* pageRequests(path: string, container?: string): Generator<string, unknown[], PageResponse> {
  let next = `${path}?per_page=100`; const seen = new Set<string>(); const items: unknown[] = [];
  for (let page = 0; page < 20; page++) {
    if (seen.has(next)) throw new StewardshipGitHubError(null, false);
    seen.add(next);
    const response = yield next;
    const rows = Array.isArray(response.value) ? response.value : container ? object(response.value)[container] : null;
    if (!Array.isArray(rows)) throw new StewardshipGitHubError(null, false);
    items.push(...rows);
    const match = /<([^>]+)>;\s*rel="?next"?(?:\s|,|;|$)/i.exec(response.link ?? "");
    if (!match) {
      if (/\bnext\b/i.test(response.link ?? "")) throw new StewardshipGitHubError(null, false);
      return items;
    }
    let url: URL;
    try { url = new URL(match[1]); } catch { throw new StewardshipGitHubError(null, false); }
    if (url.origin !== API || url.pathname !== path || url.username || url.password || url.hash
      || [...url.searchParams.keys()].some((key) => key !== "page" && key !== "per_page")
      || !/^\d+$/.test(url.searchParams.get("page") ?? "") || url.searchParams.get("per_page") !== "100") throw new StewardshipGitHubError(null, false);
    next = `${url.pathname}${url.search}`;
  }
  throw new StewardshipGitHubError(null, false);
}

/** Fixed-host narrow transport. The final fence runs after preparation and before the only write attempt. */
export function createStewardshipGitHub(options: GitHubOptions): StewardshipGitHub {
  if (!/^[-a-z0-9_.]+\/[-a-z0-9_.]+$/.test(options.repository) || !options.operator || !Number.isFinite(Date.parse(options.deadlineAt))) throw new StewardshipGitHubError(null, false);
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  const remaining = () => {
    const ms = Date.parse(options.deadlineAt) - Date.parse(options.now());
    if (!Number.isFinite(ms) || ms <= 0) throw new StewardshipGitHubError(null, false);
    return ms;
  };
  let token: string | undefined;
  let operatorVerified = false;
  function headers(): Record<string, string> {
    try { token ??= options.getToken().trim(); } catch { throw new StewardshipGitHubError(null, false); }
    if (!token) throw new StewardshipGitHubError(null, false);
    return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": CANONICAL_REST_API_VERSION };
  }
  async function responseBytes(response: Response): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) throw new StewardshipGitHubError(null, false);
    const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 2 * 1024 * 1024) throw new StewardshipGitHubError(null, false);
        chunks.push(value);
      }
      return Buffer.concat(chunks);
    } catch { throw new StewardshipGitHubError(null, false); }
    finally { await reader.cancel().catch(() => {}); }
  }
  async function sendReceipt(response: Response, fieldValue?: { field_id: number; value: string | number }): Promise<StewardshipSendReceipt> {
    const requestId = response.headers.get("x-github-request-id");
    let bytes: Buffer | null = null;
    // Diagnostics must not turn an accepted send into a failure or cause another send.
    try { bytes = response.body === null ? Buffer.alloc(0) : await responseBytes(response); } catch { /* Incomplete body. */ }
    let targetFieldValuePresent: boolean | null = null;
    if (fieldValue && bytes) {
      try {
        const parsed: unknown = JSON.parse(bytes.toString("utf8"));
        const rows = Array.isArray(parsed) ? parsed : object(parsed).issue_field_values;
        if (Array.isArray(rows)) targetFieldValuePresent = rows.some((raw) => {
          if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
          const row = raw as Record<string, unknown>;
          const field = row.issue_field ?? row.field;
          const id = row.field_id ?? (typeof fieldValue.value === "number" ? row.issue_field_id : undefined)
            ?? (field !== null && typeof field === "object" ? (field as Record<string, unknown>).id : undefined);
          return id === fieldValue.field_id && (typeof fieldValue.value === "number"
            ? stewardshipSortKeyMatches(row.value, fieldValue.value) : issueFieldValueIdentity(row).value === fieldValue.value);
        });
      } catch { /* Unparseable bodies contribute no text. */ }
    }
    return { httpStatus: response.status, requestId: requestId !== null && /^[A-Za-z0-9:._-]{1,128}$/.test(requestId)
      && !(token && requestId.includes(token)) ? requestId : null,
      responseBodyBytes: bytes?.byteLength ?? null, responseBodySha256: bytes === null ? null : sha256Bytes(bytes), targetFieldValuePresent };
  }
  function retryTime(response: Response): string | null {
    const current = Date.parse(options.now()); const candidates: number[] = [];
    const reset = response.headers.get("x-ratelimit-reset");
    if (reset !== null && /^\d+$/.test(reset)) candidates.push(Number(reset) * 1000);
    const after = response.headers.get("retry-after");
    if (after !== null) candidates.push(/^\d+(?:\.\d+)?$/.test(after) ? current + Number(after) * 1000 : Date.parse(after));
    const eligible = Math.max(...candidates.filter(Number.isFinite));
    return Number.isFinite(eligible) && eligible > current ? new Date(eligible).toISOString() : null;
  }
  async function request(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, beforeSend?: () => Promise<void>,
    fieldValue?: { field_id: number; value: string | number }): Promise<PageResponse> {
    remaining();
    const requestHeaders = headers(); const attempts = method === "GET" ? 3 : 1;
    if (method !== "GET" && !operatorVerified) {
      const actor = object((await request("GET", "/user")).value);
      if (actor.login !== options.operator) throw new StewardshipGitHubError(null, false);
      operatorVerified = true;
    }
    for (let attempt = 0; attempt < attempts; attempt++) {
      remaining();
      if (method !== "GET") {
        if (!beforeSend) throw new StewardshipGitHubError(null, false);
        await beforeSend();
      }
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(30000, remaining()));
      let response: Response | undefined;
      try {
        response = await fetchImpl(`${API}${path}`, { method, redirect: "error", signal: controller.signal,
          headers: { ...requestHeaders, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        if (!response.ok) throw new StewardshipGitHubError(response.status, method !== "GET", retryTime(response),
          method !== "GET" && [400, 401, 403, 404, 422, 429].includes(response.status));
        const value: unknown = method === "GET" ? JSON.parse((await responseBytes(response)).toString("utf8")) : null;
        const receipt = method === "GET" ? undefined : await sendReceipt(response, fieldValue);
        if (method === "GET") remaining();
        return { value, link: response.headers.get("link"), ...(receipt ? { sendReceipt: receipt } : {}) };
      } catch (error) {
        const failure = error instanceof StewardshipGitHubError ? error : new StewardshipGitHubError(null, method !== "GET");
        if (method !== "GET") throw new StewardshipGitHubError(failure.status, true, failure.nextEligibleAt, failure.definitelyRejected);
        const transient = failure.status === null || failure.status === 408 || failure.status === 429 || failure.status >= 500 || (failure.status === 403 && failure.nextEligibleAt !== null);
        if (!transient || attempt === attempts - 1 || (failure.status === 429 && failure.nextEligibleAt === null)) throw failure;
        const delay = failure.nextEligibleAt === null ? 1000 * (attempt + 1) : Math.max(0, Date.parse(failure.nextEligibleAt) - Date.parse(options.now()));
        if (delay >= remaining()) throw failure;
        try { options.phaseTiming?.retry("transport.retryWait"); } catch { /* Telemetry cannot alter retry behavior. */ }
        await timeStewardshipAsync(options.phaseTiming, "transport.retryWait", () => sleep(delay));
      } finally { clearTimeout(timer); if (response && !response.bodyUsed) await response.body?.cancel().catch(() => {}); }
    }
    throw new StewardshipGitHubError(null, false);
  }
  async function pages(path: string, container?: string): Promise<unknown[]> {
    const pager = pageRequests(path, container);
    let page = pager.next();
    while (!page.done) page = pager.next(await request("GET", page.value));
    return page.value;
  }
  return {
    async observeTarget(number, targetOptions) {
      issueId(number); remaining();
      if (!options.collectTarget) throw new StewardshipGitHubError(null, false);
      return timeStewardshipAsync(options.phaseTiming, "observe.total", async () => {
        const generation = await options.collectTarget!({ selection: { mode: "targeted", issueNumbers: [number] },
          targetObservation: true, ...(targetOptions?.readback ? { targetReadback: true } : {}),
          targetResults: true, withComments: true, stabilityScope: "selected" });
        remaining();
        const matches = generation.targetResults?.filter((entry) => entry.issueNumber === number) ?? [];
        const result = matches.length === 1 ? matches[0] : undefined;
        const unavailable = { issueNumber: number, status: "unavailable" as const, cause: "incomplete_target_observation" };
        if (!result) return unavailable;
        if (result.status !== "ok") return result;
        const complete = result.targetCompleteness;
        if (complete?.complete !== true
          || !result.commentsComplete || !Array.isArray(result.comments) || result.packet.issueNumber !== number
          || result.packet.issue.identity.number !== number || result.packet.issue.v1.state !== "OPEN"
          || result.packet.coverage.omittedPaths.some((path) => path.endsWith(":stale_nomination"))) return unavailable;
        return { issueNumber: number, status: "ok", evidence: { packet: result.packet,
          originMainSha: generation.originMainSha, policySha256: generation.policySha256 },
          comments: result.comments, commentsComplete: true, targetCompleteness: complete };
      });
    },
    async observeMany(numbers) {
      const targets = [...new Set(numbers.map(issueId))];
      if (!targets.length || targets.length > 12 || !options.collectMany) throw new StewardshipGitHubError(null, false);
      let stop: (() => void) | undefined;
      try { stop = options.phaseTiming?.start("observe.total", false); } catch { /* Preserve observation. */ }
      try {
        remaining();
        const generation = await options.collectMany!({ selection: { mode: "targeted", issueNumbers: targets },
          targetResults: true, stabilityScope: "selected", withComments: true });
        remaining();
        return targets.map((issueNumber): StewardshipBatchObservation => {
          const matches = generation.targetResults?.filter((result) => result.issueNumber === issueNumber) ?? [];
          const result = matches.length === 1 ? matches[0] : undefined;
          if (!result) return { issueNumber, status: "unavailable" };
          if (result.status !== "ok") return result;
          if (result.packet.issueNumber !== issueNumber || !result.commentsComplete || !result.comments
            || !generation.census.issueNumbers.includes(issueNumber)
            || !Number.isSafeInteger(generation.census.nowCount) || generation.census.nowCount < 0
            || result.packet.coverage.omittedPaths.some((path) => path.endsWith(":stale_nomination"))) return { issueNumber, status: "unavailable" };
          return { issueNumber, status: "ok", evidence: { packet: result.packet,
            originMainSha: generation.originMainSha, policySha256: generation.policySha256 },
            census: { complete: generation.census.complete, nowCount: generation.census.nowCount },
            comments: result.comments, commentsComplete: true };
        });
      } finally { try { stop?.(); } catch { /* Preserve the observation or error. */ } }
    },
    async observe(number) {
      let stop: (() => void) | undefined;
      try { stop = options.phaseTiming?.start("observe.total", false); } catch { /* Preserve observe behavior. */ }
      try {
        issueId(number); remaining();
        const collected = await options.collect(number);
        if (collected.evidence.packet.issueNumber !== number || !collected.census.complete || !Number.isSafeInteger(collected.census.nowCount) || collected.census.nowCount < 0) throw new StewardshipGitHubError(null, false);
        const comments = (await timeStewardshipAsync(options.phaseTiming, "observe.comments", () =>
          pages(`/repos/${options.repository}/issues/${number}/comments`))).map(object);
        remaining();
        return { ...collected, comments, commentsComplete: true };
      } finally { try { stop?.(); } catch { /* Preserve the original observation or error. */ } }
    },
    async send(number, rawOperation, commentBody, beforeSend) {
      issueId(number); const operation = stewardshipOperationSchema.parse(rawOperation);
      if (typeof beforeSend !== "function") throw new StewardshipGitHubError(null, false);
      const base = `/repos/${options.repository}/issues/${number}`;
      if (operation.kind === "append_comment") {
        const body = validateComment(number, operation.purpose, commentBody, operation.bodySha256);
        return (await request("POST", `${base}/comments`, { body }, beforeSend)).sendReceipt;
      }
      if (commentBody !== undefined) throw new StewardshipGitHubError(null, false);
      const name = stewardshipOperationField(operation)!;
      const value = stewardshipOperationValue(operation);
      const definitions = (await pages(`/orgs/${options.repository.split("/")[0]}/issue-fields`, "issue_fields")).map(object);
      const matching = definitions.filter((entry) => entry.name === name);
      if (matching.length !== 1) throw Object.assign(new Error(`Unresolved field ${name}, option ${value ?? "clear"}`), { sent: false });
      const definition = matching[0]; const fieldId = definition.id;
      if (typeof fieldId !== "number" || !Number.isSafeInteger(fieldId) || fieldId <= 0 || definitions.filter((entry) => entry.id === fieldId).length !== 1
        || definition.data_type !== (name === "Sort key" ? "number" : "single_select")) throw new StewardshipGitHubError(null, false);
      if (value === null) return (await request("DELETE", `${base}/issue-field-values/${fieldId}`, undefined, beforeSend)).sendReceipt;
      if (name !== "Sort key") {
        const values = Array.isArray(definition.options) ? definition.options.map(object).filter((entry) => entry.name === value) : [];
        if (values.length !== 1) throw Object.assign(new Error(`Unresolved field ${name}, option ${value}`), { sent: false });
      }
      const fieldValue = { field_id: fieldId, value };
      return (await request("POST", `${base}/issue-field-values`, { issue_field_values: [fieldValue] }, beforeSend, fieldValue)).sendReceipt;
    },
  };
}

// Expose the same pager on the transport factory for the synchronous evidence collector.
createStewardshipGitHub.pages = pageRequests;
