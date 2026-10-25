import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { CANONICAL_REST_API_VERSION, type TransportMetadataV2 } from "./snapshot-v2";

export const API_VERSION = CANONICAL_REST_API_VERSION;
export const ACCEPT_HEADER = "Accept: application/vnd.github+json";
export const GITHUB_HOST = "github.com";
export const AMBIENT_GITHUB_CREDENTIAL_NAMES = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"] as const;

export type JsonObject = Record<string, unknown>;
export type GhRunner = (args: readonly string[]) => string;
export type GhExecutor = (
  file: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string;

export interface GhRunnerOptions {
  readonly execute?: GhExecutor;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  /** Compatibility escape hatch for the frozen Steward preflight only. */
  readonly allowAmbientCredentials?: boolean;
}

export interface ReadOnlyGhCallRecord {
  readonly executable: "gh";
  readonly args: readonly string[];
}

export interface IncludedGhResponse {
  readonly status: number | null;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface MetadataResult<T> {
  readonly value: T;
  readonly transport: readonly TransportMetadataV2[];
}

export interface ReadOnlyGithubReceipt {
  readonly domain: "issues" | "bodies" | "comments" | "fields" | "relationships" | "project" | "resource";
  readonly endpoint: string;
  readonly page: number | null;
  readonly responseSha256: string;
  readonly requestId: string;
  readonly fetchedAt: string;
  readonly apiVersion: typeof API_VERSION;
}

function asObject(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function parseJson<T>(raw: string, context: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`GitHub returned invalid JSON for ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function assertReadOnlyGhArgs(args: readonly string[]): void {
  if (args[0] !== "api") {
    throw new Error("Roadmap GitHub reads permit only read-only gh api commands; subprocess writers are forbidden.");
  }
  const methods = args.flatMap((arg, index) => {
    if (arg === "--method" || arg === "-X") return [args[index + 1] ?? ""];
    if (arg.startsWith("--method=")) return [arg.slice("--method=".length)];
    if (/^-X.+/.test(arg)) return [arg.slice(2)];
    return [];
  });
  if (methods.some((method) => method.toUpperCase() !== "GET")) {
    throw new Error("Roadmap GitHub reader is read-only; mutating REST methods are forbidden.");
  }
  const graphql = args[1] === "graphql";
  const bodyFlag = args.some((arg) =>
    arg === "--input" || arg.startsWith("--input=") ||
    arg === "--raw-field" || arg.startsWith("--raw-field=") ||
    arg === "--field" || arg.startsWith("--field=") ||
    arg === "-f" || /^-f.+/.test(arg) || arg === "-F" || /^-F.+/.test(arg));
  if (!graphql && bodyFlag) {
    throw new Error("Roadmap GitHub reader is read-only; REST request bodies are forbidden.");
  }
  if (graphql) {
    if (args.some((arg) => arg === "--input" || arg.startsWith("--input="))) {
      throw new Error("Roadmap GitHub reader is read-only; GraphQL input files are forbidden.");
    }
    const queries = args
      .filter((arg) => arg.startsWith("query="))
      .map((arg) => arg.slice("query=".length).trim());
    if (queries.length !== 1 || !queries[0] || queries.some((query) => /\bmutation\b/i.test(query))) {
      throw new Error("Roadmap GitHub reader is read-only; GraphQL mutations are forbidden.");
    }
  }
}

function pinGitHubComReadArgs(args: readonly string[]): string[] {
  if (args.some((arg) => arg === "--hostname" || arg.startsWith("--hostname="))) {
    throw new Error("The GitHub issue roadmap reader owns the gh api hostname.");
  }
  return ["api", "--hostname", GITHUB_HOST, ...args.slice(1)];
}

function readOnlyEnvironment(
  input: Readonly<Record<string, string | undefined>>,
  allowAmbientCredentials: boolean,
): NodeJS.ProcessEnv {
  const injectedNodeEnv = input.NODE_ENV;
  const nodeEnv = injectedNodeEnv === "development" || injectedNodeEnv === "production" ||
      injectedNodeEnv === "test"
    ? injectedNodeEnv
    : process.env.NODE_ENV ?? "production";
  const environment: NodeJS.ProcessEnv = {
    ...input,
    NODE_ENV: nodeEnv,
    GH_HOST: GITHUB_HOST,
  };
  const ambient = AMBIENT_GITHUB_CREDENTIAL_NAMES
    .filter((name) => Boolean(environment[name]));
  if (!allowAmbientCredentials && ambient.length > 0) {
    throw new Error(`The read-only GitHub reader rejects ambient mutation-capable credentials: ${ambient.join(", ")}.`);
  }
  if (!allowAmbientCredentials && environment.GH_READ_ONLY_TOKEN) {
    environment.GH_TOKEN = environment.GH_READ_ONLY_TOKEN;
    delete environment.GH_READ_ONLY_TOKEN;
  }
  return environment;
}

export function createReadOnlyGhRunner(options: GhRunnerOptions = {}): GhRunner {
  const execute = options.execute ?? execFileSync;
  const environment = readOnlyEnvironment(
    options.environment ?? process.env,
    options.allowAmbientCredentials === true,
  );
  return (args) => {
    assertReadOnlyGhArgs(args);
    try {
      return execute("gh", pinGitHubComReadArgs(args), {
        encoding: "utf8",
        env: environment,
        maxBuffer: 128 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      });
    } catch (error) {
      const failure = error as Error & { code?: string; signal?: string; stderr?: string | Buffer };
      const details = `${failure.message}\n${String(failure.stderr ?? "")}`;
      if (failure.code === "ETIMEDOUT" || failure.signal === "SIGTERM" || /timed out/i.test(details)) {
        throw new Error(JSON.stringify({
          status: "blocked",
          blocker: { code: "dependency_timeout", dependency: "GitHub API", retryable: true },
        }));
      }
      if (/rate limit|secondary rate|abuse detection|retry-after/i.test(details)) {
        const reset = /x-ratelimit-reset:\s*(\d+)/i.exec(details)?.[1] ?? null;
        throw new Error(JSON.stringify({
          status: "blocked",
          blocker: { code: "rate_limited", dependency: "GitHub API", retryable: true, resetEpoch: reset },
        }));
      }
      throw error;
    }
  };
}

/** Weekly runner that cannot fall back to the workstation's stored `gh` auth. */
export function createScheduledReadOnlyGhRunner(options: Omit<GhRunnerOptions, "allowAmbientCredentials"> = {}): GhRunner {
  const environment = options.environment ?? process.env;
  if (typeof environment.GH_READ_ONLY_TOKEN !== "string" || environment.GH_READ_ONLY_TOKEN.trim() === "") {
    throw new Error("Weekly reconciliation requires an explicit GH_READ_ONLY_TOKEN and never uses stored gh auth.");
  }
  return createReadOnlyGhRunner({
    execute: options.execute,
    environment: {
      ...environment,
      GH_CONFIG_DIR: resolve(tmpdir(), "example-repo-roadmap-read-only-no-stored-auth"),
    },
  });
}

/**
 * Test and canary boundary for weekly consumers. Every attempted egress is
 * validated before it is recorded or delegated, so rejected mutations never
 * reach the supplied transport.
 */
export function createRecordingReadOnlyGhRunner(options: {
  readonly records: ReadOnlyGhCallRecord[];
  readonly respond?: GhRunner;
}): GhRunner {
  return (args) => {
    assertReadOnlyGhArgs(args);
    const pinned = pinGitHubComReadArgs(args);
    options.records.push({ executable: "gh", args: pinned });
    return options.respond?.(args) ?? "";
  };
}

function headerBoundary(raw: string): { readonly index: number; readonly length: number } | null {
  const crlf = raw.indexOf("\r\n\r\n");
  const lf = raw.indexOf("\n\n");
  if (crlf < 0 && lf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

export function parseIncludedGhResponse(raw: string): IncludedGhResponse {
  let remainder = raw;
  let status: number | null = null;
  let headers: Record<string, string> = {};
  while (/^HTTP\//i.test(remainder)) {
    const boundary = headerBoundary(remainder);
    if (!boundary) throw new Error("GitHub included-response headers were incomplete.");
    const headerText = remainder.slice(0, boundary.index);
    const statusMatch = /^HTTP\/\S+\s+(\d{3})/i.exec(headerText);
    status = statusMatch ? Number(statusMatch[1]) : null;
    headers = {};
    for (const line of headerText.split(/\r?\n/).slice(1)) {
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
    }
    remainder = remainder.slice(boundary.index + boundary.length);
  }
  return { status, headers, body: remainder.trim() };
}

export function transportMetadata(
  endpoint: string,
  page: number | null,
  response: IncludedGhResponse,
  fallbackFetchedAt: string,
): TransportMetadataV2 {
  if (!Number.isInteger(response.status) || response.status === null || response.status < 200 || response.status >= 300) {
    throw new Error(`GitHub transport metadata for ${endpoint} requires a complete 2xx HTTP status.`);
  }
  const requestId = response.headers["x-github-request-id"]?.trim() || null;
  if (requestId === null) throw new Error(`GitHub transport metadata for ${endpoint} requires a GitHub request ID.`);
  const lifecycle = (name: "deprecation" | "sunset"): string | null => {
    const raw = response.headers[name];
    if (raw === undefined) return null;
    const parsed = Date.parse(raw);
    if (!Number.isFinite(parsed)) throw new Error(`GitHub ${name} header for ${endpoint} is malformed; disabling capture.`);
    return new Date(parsed).toISOString();
  };
  const deprecationAt = lifecycle("deprecation");
  const sunsetAt = lifecycle("sunset");
  if (deprecationAt !== null || sunsetAt !== null) {
    const signals = [deprecationAt === null ? null : "Deprecation", sunsetAt === null ? null : "Sunset"]
      .filter((signal): signal is string => signal !== null)
      .join(" and ");
    throw new Error(`GitHub returned ${signals} lifecycle metadata for ${endpoint}; disabling capture until the API contract is re-proved.`);
  }
  const graphql = endpoint.startsWith("graphql:");
  const selectedVersion = response.headers["x-github-api-version-selected"]?.trim() || null;
  if (!graphql && selectedVersion !== API_VERSION) {
    throw new Error(`GitHub selected API version ${selectedVersion ?? "missing"} for ${endpoint}; expected ${API_VERSION}.`);
  }
  const serverDate = response.headers.date;
  return {
    endpoint,
    status: response.status,
    requestId,
    fetchedAt: serverDate && Number.isFinite(Date.parse(serverDate))
      ? new Date(serverDate).toISOString()
      : fallbackFetchedAt,
    page,
    apiVersionSelected: graphql ? null : API_VERSION,
    deprecationAt,
    sunsetAt,
  };
}

function hasNextLink(link: string | undefined): boolean {
  return Boolean(link?.split(",").some((entry) => /rel="next"/.test(entry)));
}

function withPage(endpoint: string, page: number): string {
  return `${endpoint}${endpoint.includes("?") ? "&" : "?"}page=${page}`;
}

export function readRestPagesWithMetadata(
  runGh: GhRunner,
  endpoint: string,
  fetchedAt: string,
): MetadataResult<readonly JsonObject[]> {
  const items: JsonObject[] = [];
  const transport: TransportMetadataV2[] = [];
  let page = 1;
  while (true) {
    const response = parseIncludedGhResponse(runGh([
      "api", "--include", "-H", ACCEPT_HEADER,
      "-H", `X-GitHub-Api-Version: ${API_VERSION}`, withPage(endpoint, page),
    ]));
    transport.push(transportMetadata(endpoint, page, response, fetchedAt));
    const value = parseJson<unknown>(response.body, endpoint);
    if (!Array.isArray(value)) throw new Error(`GitHub pagination for ${endpoint} did not return an array.`);
    items.push(...value.map(asObject));
    if (!hasNextLink(response.headers.link)) break;
    page += 1;
  }
  return { value: items, transport };
}

export function readRestPagesWithReceipts(
  runGh: GhRunner,
  endpoint: string,
  fetchedAt: string,
  domain: ReadOnlyGithubReceipt["domain"],
): { readonly value: readonly JsonObject[]; readonly receipts: readonly ReadOnlyGithubReceipt[] } {
  const value: JsonObject[] = [];
  const receipts: ReadOnlyGithubReceipt[] = [];
  let page = 1;
  while (true) {
    const response = parseIncludedGhResponse(runGh([
      "api", "--include", "-H", ACCEPT_HEADER,
      "-H", `X-GitHub-Api-Version: ${API_VERSION}`, withPage(endpoint, page),
    ]));
    const transport = transportMetadata(endpoint, page, response, fetchedAt);
    const parsed = parseJson<unknown>(response.body, endpoint);
    if (!Array.isArray(parsed)) throw new Error(`GitHub pagination for ${endpoint} did not return an array.`);
    value.push(...parsed.map(asObject));
    receipts.push({
      domain, endpoint, page, responseSha256: createHash("sha256").update(response.body, "utf8").digest("hex"),
      requestId: transport.requestId!, fetchedAt: transport.fetchedAt, apiVersion: API_VERSION,
    });
    if (!hasNextLink(response.headers.link)) break;
    page += 1;
  }
  return { value, receipts };
}

export function readRestResourceWithMetadata(
  runGh: GhRunner,
  endpoint: string,
  fetchedAt: string,
): MetadataResult<JsonObject> {
  const response = parseIncludedGhResponse(runGh([
    "api", "--include", "-H", ACCEPT_HEADER,
    "-H", `X-GitHub-Api-Version: ${API_VERSION}`, endpoint,
  ]));
  return {
    value: parseJson<JsonObject>(response.body, endpoint),
    transport: [transportMetadata(endpoint, null, response, fetchedAt)],
  };
}
