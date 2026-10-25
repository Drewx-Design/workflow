import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Node, Project, SyntaxKind, ts } from "ts-morph";

import {
  diskView,
  fallbackCompilerOptions,
  isWithinTree,
  memoryView,
  moduleBaseName,
  moduleEdges,
  normalize,
  parseDiagnosticsOf,
  repoCompilerOptions,
  toRepoRelative,
  type TreeView,
} from "./lib/roadmap-boundary-ast";

export interface WeeklyBoundaryViolation {
  readonly code:
    | "forbidden_import"
    | "dynamic_import"
    | "ambient_mutation_auth"
    | "subprocess_github_write"
    | "mutating_rest"
    | "graphql_mutation"
    | "parse_error";
  readonly file: string;
  readonly detail: string;
}

export interface WeeklyBoundaryInspection {
  readonly entrypoint: string;
  readonly visitedFiles: readonly string[];
  readonly violations: readonly WeeklyBoundaryViolation[];
}

/**
 * The shared forbidden-module list for every read-only roadmap boundary lint.
 *
 * Exported so `scripts/lint-github-issue-roadmap-shadow-boundary.ts` can enforce the same list
 * rather than forking it: two copies drift, and the weekly and shadow claims must stay in
 * agreement about what a credential, deployment, ledger, host-lock, or mutation-transport module
 * is.
 *
 * A **set of names**, not a regex over paths. The regex this replaced carried an optional `.ts`
 * tail, which meant it classified `host-lock.ts` as forbidden and `host-lock.js`, `host-lock.d.ts`,
 * `host-lock.tsx`, `host-lock.mts` and `host-lock/index.ts` as ordinary modules — every one of
 * which is the same module to the runtime. Classification now runs on the *reduced identity*
 * (`moduleBaseName`), so the spelling of the file the compiler landed on cannot change the answer.
 */
export const FORBIDDEN_MODULE_NAMES: ReadonlySet<string> = new Set([
  "dispatcher-runtime",
  "dispatcher-deployment",
  "host-lock",
  "consumption-safety-ledger",
  "approval-receipt",
  "sensitive-issue-adapters",
  "relationship-adapter",
  "github-issue-roadmap-intake",
  "github-issue-roadmap-steward",
  "run-github-issue-roadmap-steward",
  "github-issue-roadmap-sort",
  "run-github-issue-roadmap-sort",
  "run-stewardship-seat-job",
  "stewardship-executor",
  "stewardship-github",
  "stewardship-seat-process",
  "stewardship-seats",
  "stewardship-state",
  // Reserved before the deferred adjudication path exists, so introducing one of its modules
  // cannot quietly make it reachable from a read-only closure.
  "adjudication-receipt",
  "ledger-comment-reader",
  "github-issue-roadmap-adjudicate",
  "adjudicated-case-loader",
  "github-issue-roadmap-accrual",
  // Operator-only publication composition. Scheduled collection must terminate before this graph.
  "shadow-publisher",
  "github-issue-roadmap-shadow-publish",
  "github-issue-roadmap-shadow-refresh-publish-manifest",
  "github-issue-roadmap-shadow-reconcile-published-state",
  "github-issue-roadmap-shadow-cohort",
]);

/**
 * The legacy shadow closure walker's case-insensitive substring name class.
 *
 * The weekly closure legitimately reaches its read-only GitHub reader and `node:child_process`, so
 * this broader class is applied by the shadow gate only. It lives beside the shared exact-name set
 * so the surviving gate can port the still-live walker's whole class without forking its tokens.
 */
export const SHADOW_FORBIDDEN_MODULE_NAME_PATTERN = /credential|secret|deployment|ledger|host-lock|transport|github-reader|octokit|child_process|node:http|node:https|node:net|node:dns|node:tls|github-issue-roadmap-intake\b/i;

/**
 * Classify a resolved identity — or, for an external specifier the resolver has no file for, the
 * specifier text — against `FORBIDDEN_MODULE_NAMES`.
 */
export function isForbiddenModuleIdentity(identity: string): boolean {
  return FORBIDDEN_MODULE_NAMES.has(moduleBaseName(identity));
}

const READER = "scripts/lib/github-issue-roadmap/read-only-github-reader.ts";
const WEEKLY_BOUNDARY_ENTRYPOINT = "scripts/github-issue-roadmap-reconcile.ts";

/**
 * Text diagnostics over the weekly graph.
 *
 * These are read-position checks, not the guarantee: the weekly claim is carried by the module
 * closure walked with the compiler's own resolver. They are kept because a half-written mutating
 * request or an ambient credential read is worth naming in a review, and the reader exemption is
 * real — weekly reconciliation legitimately holds a *read* token, which is the one credential this
 * boundary tolerates and shadow mode does not.
 */
function scanTextDiagnostics(
  file: string,
  source: string,
  add: (code: WeeklyBoundaryViolation["code"], detail: string) => void,
): void {
  if (file !== READER && /process\.env(?:\.|\[)[^\n]*(?:GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|ROADMAP_[A-Z_]*(?:TOKEN|CREDENTIAL))/i.test(source)) {
    add("ambient_mutation_auth", "Weekly modules cannot read ambient mutation credentials.");
  }
  if (file !== READER && /(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*["']gh["'][\s\S]{0,300}?(?:issue\s*["'],\s*["'](?:create|close|reopen|edit)|api[\s\S]{0,120}?(?:POST|PATCH|PUT|DELETE))/i.test(source)) {
    add("subprocess_github_write", "A weekly module attempts a GitHub write subprocess.");
  }
  if (file !== READER && /["'](?:--method|-X)["']\s*,\s*["'](?:POST|PATCH|PUT|DELETE)["']/i.test(source)) {
    add("mutating_rest", "A weekly module constructs a mutating REST request.");
  }
  if (file !== READER && /query\s*=\s*mutation\b/i.test(source)) {
    add("graphql_mutation", "A weekly module constructs a GraphQL mutation.");
  }
}

export interface WeeklyBoundaryInput {
  readonly entrypoint: string;
  /** In-memory tree, keyed by repo-relative path. Omit to audit `repoRoot` on disk. */
  readonly sources?: Readonly<Record<string, string>>;
  readonly repoRoot?: string;
  readonly compilerOptions?: ts.CompilerOptions;
}

/**
 * Walk the weekly composition graph as an AST, classifying every runtime edge by the identity the
 * compiler resolves it to.
 *
 * Deliberately *not* identical in strength to the shadow gate. The weekly boundary has no external
 * allowlist and no capability-root ban: weekly reconciliation legitimately reads GitHub with a read
 * token, so it imports the reader, `node:child_process` and a network client by design.
 *
 * What this gate proves, stated no wider than it holds: **every module edge the compiler resolves
 * from the weekly entrypoint is classified against the forbidden list, and no edge is created or
 * erased by text the compiler would not read as a statement** — the comment-splice and
 * string-literal evasions are dead here because edges are AST nodes.
 *
 * What it does NOT yet prove, tracked rather than implied:
 *
 *   - **Closure completeness.** An edge that does not resolve, resolves outside the tree, or
 *     resolves to a declaration file is skipped silently rather than raised. The shadow gate fails
 *     closed on all three; this one does not yet.
 *   - **CommonJS reach.** `moduleEdges` collects import/export/import-equals nodes only, so a
 *     literal `require("...")` in a `.js`/`.cjs` file is neither walked nor classified. The shadow
 *     closure is covered anyway because it bans the `require` identifier as a capability root; this
 *     gate has no such ban. The weekly closure contains no `.js` file today, so this is latent.
 *   - **Entrypoint liveness.** A missing entrypoint yields no violation here, where the shadow gate
 *     raises `missing_entrypoint`.
 *
 * Those three are review findings deferred out of the shadow-mode branch on purpose: they concern
 * this already-shipped read-only path rather than the shadow claim, and deferring leaves the weekly
 * gate no weaker than it was. They are not licence to read the guarantee above as wider than it is.
 */
export function inspectWeeklyBoundary(input: WeeklyBoundaryInput): WeeklyBoundaryInspection {
  const repoRoot = normalize(resolve(input.repoRoot ?? (input.sources === undefined ? process.cwd() : "/repo")));
  const view: TreeView = input.sources === undefined ? diskView() : memoryView(repoRoot, input.sources);
  const compilerOptions = input.compilerOptions ?? fallbackCompilerOptions(repoRoot);
  const entrypoint = normalize(input.entrypoint);
  const entrypointAbsolute = normalize(resolve(repoRoot, entrypoint));

  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { ...compilerOptions, noLib: true, noResolve: true },
  });

  const violations: WeeklyBoundaryViolation[] = [];
  const visited = new Set<string>();
  const pending = [entrypointAbsolute];
  const resolutionCache = ts.createModuleResolutionCache(repoRoot, (name) => name.toLowerCase(), compilerOptions);

  while (pending.length > 0) {
    const absolutePath = pending.pop()!;
    if (visited.has(absolutePath)) continue;
    visited.add(absolutePath);
    const file = toRepoRelative(repoRoot, absolutePath);
    const add = (code: WeeklyBoundaryViolation["code"], detail: string) => {
      violations.push({ code, file, detail });
    };

    const source = view.read(absolutePath);
    if (source === undefined) continue;

    let sourceFile: import("ts-morph").SourceFile;
    try {
      sourceFile = project.createSourceFile(absolutePath, source, { overwrite: true });
    } catch (error) {
      add("parse_error", `The gate could not parse this file: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parseErrors = parseDiagnosticsOf(sourceFile);
    if (parseErrors.length > 0) {
      const first = ts.flattenDiagnosticMessageText(parseErrors[0].messageText, " ");
      add("parse_error", `${parseErrors.length} syntax error(s); the gate cannot audit what it cannot parse. First: ${first}`);
      continue;
    }

    scanTextDiagnostics(file, source, add);
    sourceFile.forEachDescendant((node) => {
      if (!Node.isCallExpression(node)) return;
      if (node.getExpression().getKind() !== SyntaxKind.ImportKeyword) return;
      add("dynamic_import", "Dynamic imports are forbidden in the weekly composition graph.");
    });

    for (const { specifier, typeOnly } of moduleEdges(sourceFile)) {
      const resolved = ts.resolveModuleName(
        specifier,
        absolutePath,
        compilerOptions,
        view.host,
        resolutionCache,
      ).resolvedModule?.resolvedFileName;
      const resolvedPath = resolved === undefined ? undefined : normalize(resolved);
      const identity = resolvedPath === undefined ? specifier : toRepoRelative(repoRoot, resolvedPath);
      if (isForbiddenModuleIdentity(identity)) {
        add("forbidden_import", `Weekly modules cannot import ${specifier} (resolves to ${identity}).`);
      }
      if (typeOnly) continue;
      // Walk in-repo edges only, matching the shadow gate's rule. An external specifier is still
      // classified above; it is not walked, because the weekly claim is about this repo's own
      // composition graph rather than about its dependencies.
      const inRepoSpecifier = specifier.startsWith(".") || specifier.startsWith("@/");
      if (!inRepoSpecifier) continue;
      if (resolvedPath === undefined || !isWithinTree(repoRoot, resolvedPath)) continue;
      pending.push(resolvedPath);
    }
  }

  return {
    entrypoint,
    visitedFiles: [...visited].map((absolutePath) => toRepoRelative(repoRoot, absolutePath)).sort(),
    violations: violations.sort((left, right) =>
      left.file.localeCompare(right.file) || left.code.localeCompare(right.code)),
  };
}

export function runWeeklyBoundaryLint(repoRoot = process.cwd()): WeeklyBoundaryInspection {
  const result = inspectWeeklyBoundary({
    entrypoint: WEEKLY_BOUNDARY_ENTRYPOINT,
    repoRoot,
    compilerOptions: repoCompilerOptions(repoRoot),
  });
  for (const violation of result.violations) {
    console.error(`${violation.code}: ${violation.file}: ${violation.detail}`);
  }
  return result;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runWeeklyBoundaryLint();
    if (result.violations.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
