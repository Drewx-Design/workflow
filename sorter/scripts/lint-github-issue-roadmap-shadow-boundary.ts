import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Node, Project, SyntaxKind, VariableDeclarationKind, ts } from "ts-morph";

import {
  diskView,
  fallbackCompilerOptions,
  isDeclarationFile,
  isWithinTree,
  memoryView,
  moduleIdentityName,
  moduleEdges,
  normalize,
  parseDiagnosticsOf,
  repoCompilerOptions,
  toRepoRelative,
} from "./lib/roadmap-boundary-ast";
import {
  isForbiddenModuleIdentity,
  SHADOW_FORBIDDEN_MODULE_NAME_PATTERN,
} from "./lint-github-issue-roadmap-weekly-boundary";

/**
 * R2: shadow mode holds no ambient credential and imports no transport — gated structurally.
 *
 * `scripts/lib/github-issue-roadmap/intake-shadow.ts` compiles the real intake decision and drafts
 * the exact issue routine intake would file. The only thing standing between that decision and a
 * write is the absence of a way to take it, so that absence has to be mechanically gated or it
 * decays on the first convenience import.
 *
 * ## What this gate proves, and what it does not
 *
 * It proves that **no file in an audited closure names a capability root, and no edge leaves that
 * closure except into a short written allowlist**: starting at the shadow entrypoint and following
 * every runtime module edge the TypeScript compiler resolves, nothing references `fetch`,
 * `globalThis`, `process`, `require`, `module`, `eval` or `Function` in value position, and no
 * import reaches a credential, ledger, host-lock, deployment or transport module.
 *
 * ## What it does NOT prove, stated first because four rounds got this wrong
 *
 * **It does not prove transport absence against an author who is trying.** Every allowlisted import
 * is an object, and every object's `.constructor` chain reaches `Function`. A gate that reads
 * syntax cannot close that without evaluating the program. Rounds 3, 4 and 5 each pinned another
 * spelling of `.constructor` — property access, then destructuring, then a `const`-folded key and a
 * Unicode escape — and each round a new spelling appeared, because the property being pinned was
 * *how the name was written*, not what it evaluates to.
 *
 * So `BANNED_CAPABILITY_MEMBERS` and `bannedMemberNames` are **defense in depth and nothing more**.
 * A prototype walk from any allowlisted binding up to `Function`, and any capability laundered
 * through a value the gate cannot fold, are **disclaimed** — not closed. Do not restore a claim to
 * the contrary; the next spelling will defeat it too.
 *
 * **It does not prove credential absence.** `node:fs` is allowlisted because the closure reads its
 * evidence stack and writes its artifact, so a credential living in a *file* stays readable. What
 * holds is narrower: no *ambient* credential surface, because `process` is banned flatly with no
 * carve-out.
 *
 * ## What it is for
 *
 * Drift. The convenience import, the "just this once" ambient read, the refactor that quietly
 * widens the closure. Against that it is strong, and the load-bearing half is the capability-root
 * ban: it tests *value-position references to a binding*, which is a property of the program rather
 * than of its spelling, and it is the half no review round has defeated. Read every claim below in
 * that register.
 *
 * ## Why AST, not regex
 *
 * The previous implementation matched regexes against source text and shipped seven confirmed
 * evasions — a block-comment opener in one string literal and its closer in a later one blanked
 * the real imports between them; `import "./host-lock.js"` slipped past a suffix-matched name that
 * `import "./host-lock"` did not; `const _l = require;` and `const _t = globalThis.fetch;` both
 * evaded checks written against *call* syntax; `const { GH_TOKEN } = process.env;` evaded a check
 * written against `process.env.GH_TOKEN`; a `.js` candidate ordering could pick `worker.js.ts`
 * ahead of the `worker.ts` the runtime actually loads; and `globalThis['fet'+'ch']` produced
 * nothing at all. Every one of those is a *text* fact defeated by a *text* trick. Two rounds of
 * patching added surface without changing the class of the problem.
 *
 * The rewrite changes what is being measured:
 *
 *   - **Module edges are AST nodes**, not line matches. Comments and string literals are not
 *     statements, so nothing inside them can create, erase, or launder an edge (kills A1).
 *   - **Forbidden modules are classified by resolved identity**, not by textual suffix. Every
 *     runtime edge goes through `ts.resolveModuleName` with the repo's own compiler options, so
 *     `./host-lock`, `./host-lock.js`, and a `paths`-aliased spelling all land on the same
 *     absolute file and are classified identically (kills A2 and A6 as a class — the gate inspects
 *     the file the compiler and the runtime agree on, not a candidate list of the gate's own
 *     invention). The identity is then *reduced* — extension and `/index` tail removed — before it
 *     is tested, because `host-lock.ts`, `host-lock.d.ts`, `host-lock.mts` and `host-lock/index.ts`
 *     are one module to the runtime and must be one answer here.
 *   - **Capability roots are banned as value-position references**, not as call patterns. The
 *     question the gate asks is not "does this file *call* fetch" but "does this file *name*
 *     anything from which a transport or a credential could be obtained". An alias is a reference
 *     to the root, so aliasing is caught for free (kills A3, A4). Banning `globalThis` and
 *     `global` outright removes the need to fold `'fet'+'ch'` (kills A7). Banning `process`
 *     removes the need to enumerate credential-shaped property names (kills A5).
 *
 * ## Fail-closed direction
 *
 * This lint is itself a silent-pass mechanism: if it is wrong it exits 0 while the property is
 * false. Every ambiguity is therefore resolved toward *violation*: a file that does not parse, a
 * missing entrypoint, an in-repo edge the compiler cannot resolve, an edge that resolves outside
 * the audited tree, and an external module that is not on the allowlist are all violations rather
 * than skips.
 *
 * The gate walks the shadow module's own transitive import graph — deliberately not the CLI root's.
 * `scripts/github-issue-roadmap-intake.ts` imports the disabled dispatcher, the host lock, and the
 * consumption ledger, and it routes `--shadow` into this module; walking from the root would let
 * the command's transport smuggle itself into the module's claim. Import direction is CLI -> lib
 * only, and `isForbiddenModuleIdentity` catches a lib file reaching back up into the CLI.
 *
 * `isForbiddenModuleIdentity` is imported from the weekly boundary lint rather than restated, so
 * the two read-only claims cannot drift apart about what a transport module is, and both lints walk
 * the same AST substrate (`scripts/lib/roadmap-boundary-ast.ts`) so they cannot drift apart about
 * what "transitive closure" means either. The claims themselves are still deliberately different in
 * strength: weekly reconciliation legitimately holds a *read* token and so has no external
 * allowlist and no capability-root ban. Two checks are stricter here: shadow mode may not reach the
 * read-only GitHub reader at all (R6 — it consumes the preflight snapshot artifact, it does not
 * call GitHub), and it therefore gets no reader exemption.
 */
export const SHADOW_BOUNDARY_ENTRYPOINT = "scripts/lib/github-issue-roadmap/intake-shadow.ts";
export const SHADOW_OPERATOR_REQUEST_BUNDLE_ENTRYPOINT =
  "scripts/lib/github-issue-roadmap/operator-assessment-request-bundle.ts";
export const SHADOW_PUBLICATION_CORE_ENTRYPOINT =
  "scripts/lib/github-issue-roadmap/shadow-publication-core.ts";
export const SHADOW_PUBLICATION_CALLER_ENTRYPOINT =
  "scripts/github-issue-roadmap-shadow-validate.ts";
export const SHADOW_PUBLICATION_SHELL_ENTRYPOINT =
  "scripts/github-issue-roadmap-shadow-validate-cli.ts";
export const SHADOW_WINDOWS_ACL_ADAPTER =
  "scripts/lib/github-issue-roadmap/windows-private-directory-acl.ts";

/**
 * The only external modules a shadow-closure file may import at runtime.
 *
 * Written down rather than pattern-matched: an allowlist you can read in one glance is the point.
 * Today's closure needs exactly these three — `node:crypto` (content hashing in `canonical-json`
 * and `snapshot-v2`, plus `randomUUID` for the atomic-write temp name), `node:fs` (reading the
 * bound evidence stack, writing the artifact), and `node:path`. Every other external specifier —
 * including `node:module`, which is how `createRequire` is obtained — is a violation on sight, so
 * a new dependency has to be argued for here rather than arriving with a refactor.
 */
export const EXTERNAL_RUNTIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "node:crypto",
  "node:fs",
  "node:path",
]);

export const SHADOW_PUBLICATION_CALLER_PROCESS_PROPERTIES: ReadonlySet<string> = new Set([
  "cwd",
  "platform",
]);

const SHADOW_PUBLICATION_SHELL_PROCESS_PROPERTIES: Readonly<Record<string, ReadonlySet<string>>> = {
  [SHADOW_PUBLICATION_SHELL_ENTRYPOINT]: new Set(["argv", "cwd", "exitCode", "platform"]),
  [SHADOW_WINDOWS_ACL_ADAPTER]: new Set(["env"]),
};

/**
 * Identifiers no file in the audited closure may reference in value position.
 *
 * These are *roots*, not calls. Each one is a place a credential or a transport can be obtained
 * from ambient scope, and each one therefore defeats a check written one level further down:
 *
 *   - `require` / `createRequire` — an escape hatch out of the static import graph this gate
 *     walks. Banning the identifier rather than the call catches `const _l = require;`.
 *   - `fetch` / `WebSocket` / `XMLHttpRequest` — transports that need no import at all, so they
 *     are invisible to the module walk. Shadow mode opens no connection of any kind, so these are
 *     banned outright rather than inspected for a mutating method.
 *   - `globalThis` / `global` — the general-purpose route to every one of the above. Banning the
 *     namespace object means the gate never has to decide what `globalThis['fet'+'ch']` evaluates
 *     to; it refuses the expression before the question arises.
 *   - `process` — the ambient-credential surface. Banning the object rather than enumerating
 *     credential-shaped property names is what makes `const { GH_TOKEN } = process.env;` and every
 *     other destructuring, computed, or aliased spelling fall out as one rule. See
 *     `PROVISIONAL_PROCESS_PROPERTY_ALLOWLIST`, which is empty: the ban is flat and must stay so.
 *   - `module` — the CommonJS ambient. `module.require` is the same function as the banned
 *     `require` identifier reached through a property the identifier ban cannot see, so the
 *     ambient object is banned rather than the one member spelling.
 *   - `eval` / `Function` — arbitrary code from a string, which would make every other claim here
 *     unfalsifiable.
 *
 * Dynamic `import(...)` is banned too, but as a syntax check rather than an identifier: see
 * `scanCapabilityRoots`.
 */
export const BANNED_CAPABILITY_ROOTS: ReadonlySet<string> = new Set([
  "require",
  "createRequire",
  "fetch",
  "WebSocket",
  "XMLHttpRequest",
  "globalThis",
  "global",
  "process",
  "module",
  "eval",
  "Function",
]);

/**
 * Empty, and that is the point: the `process` ban is flat.
 *
 * This set used to hold `cwd`, `platform` and `pid`, because the shipped closure read all three. It
 * was a carve-out on the *shape* — `process` tolerated only as the object of a non-computed property
 * access with an allowlisted name — which held against twenty-plus acquisition spellings that two
 * reviewers probed.
 *
 * It fell to a spelling neither probe covered: `const { constructor: F } = process.cwd;` and
 * `Reflect.get(process.cwd, "constructor")` reach `Function` through an *allowed* read. Widening the
 * member check to cover those two shapes would have been the fourth consecutive round of pinning
 * spellings rather than the property, which is the failure this whole arc documents.
 *
 * So the three reads were removed instead, at the closure boundary the header describes:
 * `runIntakeShadow` now requires `repoRoot` from its caller rather than defaulting to
 * `process.cwd()`, and `artifact-io.ts` derives path case-sensitivity from `path.sep` and drops
 * `process.pid` from its temp-file name (`randomUUID()` already carries the uniqueness).
 *
 * Keep this set empty. Adding a name reopens the acquisition surface for every file in the closure,
 * and the walks above start from exactly such a name.
 */
export const PROVISIONAL_PROCESS_PROPERTY_ALLOWLIST: ReadonlySet<string> = new Set([]);

/**
 * Property names no file in the audited closure may reach through a member access.
 *
 * `BANNED_CAPABILITY_ROOTS` bans *identifiers*, which is the right shape for a root obtained from
 * ambient scope. Two capabilities are reachable without ever naming their identifier, so they are
 * banned by property name instead:
 *
 *   - `require` — `module.require` is the same function as the banned `require` identifier, reached
 *     through a property access the identifier ban does not see.
 *   - `constructor` — the first step of a prototype walk to `Function`. The prototype-walk class is
 *     **disclaimed, not closed** (see the header): every allowlisted import is an object and every
 *     object's constructor chain reaches `Function`, which syntax cannot close without evaluating
 *     the program. This entry is here to make an accidental walk noisy, not to prove one impossible.
 *
 * Member access is covered in its three statically readable spellings — `x.require`,
 * `x["require"]`, `` x[`require`] `` — plus destructuring and a named reflective read. A computed
 * access through a value the gate cannot fold remains disclaimed, not caught.
 *
 * Deliberately narrow. `fetch` is *not* here: `o.fetch` on an ordinary object obtains nothing, and
 * banning the property name would fail on data structures that merely spell it.
 */
export const BANNED_CAPABILITY_MEMBERS: ReadonlySet<string> = new Set([
  "require",
  "constructor",
]);

/**
 * Reflective entry points whose *argument* names a member.
 *
 * Written as a short list rather than "any call handed a banned string". The broad rule refused
 * ordinary data — a lookup table keyed by `"constructor"`, a log line, an assertion — and a gate
 * that fails on ordinary code is how the last carve-out was argued for. Other reflective entry
 * points are disclaimed along with the rest of the prototype-walk class; see the header.
 */
const REFLECTIVE_MEMBER_READERS: ReadonlySet<string> = new Set([
  "get",
  "has",
  "getOwnPropertyDescriptor",
  "getOwnPropertyDescriptors",
  "defineProperty",
]);

const READER_MODULE = /(?:^|\/)read-only-github-reader\.tsx?$/;
const SUBPROCESS_MODULE = /^(?:node:)?child_process$/;
const NETWORK_MODULE = /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns)$|^(?:undici|node-fetch|axios|got|@octokit\/)/;

/** Exact shared identities plus the still-live regex walker's broader substring name class. */
function isForbiddenShadowModuleIdentity(identity: string): boolean {
  return isForbiddenModuleIdentity(identity) ||
    SHADOW_FORBIDDEN_MODULE_NAME_PATTERN.test(moduleIdentityName(identity));
}

export type ShadowBoundaryViolationCode =
  | "forbidden_import"
  | "readonly_reader_import"
  | "subprocess_module_import"
  | "network_module_import"
  | "external_module_not_allowlisted"
  | "capability_root"
  | "dynamic_import"
  | "unresolved_import"
  | "declaration_only_resolution"
  | "missing_entrypoint"
  | "parse_error"
  | "subprocess_github_write"
  | "mutating_rest"
  | "graphql_mutation";

export interface ShadowBoundaryViolation {
  readonly code: ShadowBoundaryViolationCode;
  readonly file: string;
  readonly detail: string;
}

export interface ShadowBoundaryInspection {
  readonly entrypoint: string;
  readonly visitedFiles: readonly string[];
  readonly violations: readonly ShadowBoundaryViolation[];
}

/**
 * True when this identifier is a *reference to a binding* rather than a name that merely happens
 * to spell one.
 *
 * Excluded: the property half of `obj.fetch` and `Namespace.Function`, declaration and member
 * names (`{ process: 1 }`, `interface X { fetch: () => void }`), and anything inside a type
 * position — `Function` and `global` in particular appear in perfectly ordinary type text, and a
 * type is erased before the module runs, so it cannot obtain anything.
 *
 * Everything else counts, deliberately including an import binding and a local declaration named
 * after a root: shadowing a capability root inside the audited closure is confusing enough that
 * failing on it is the right direction, and no file in the closure does it.
 */
function isValuePositionReference(node: import("ts-morph").Identifier): boolean {
  const parent = node.getParent();
  if (parent === undefined) return false;
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return false;
  if (Node.isQualifiedName(parent) && parent.getRight() === node) return false;
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === node) return false;
  if (Node.isPropertySignature(parent) && parent.getNameNode() === node) return false;
  if (Node.isPropertyDeclaration(parent) && parent.getNameNode() === node) return false;
  if (Node.isMethodSignature(parent) && parent.getNameNode() === node) return false;
  if (Node.isMethodDeclaration(parent) && parent.getNameNode() === node) return false;
  if (Node.isEnumMember(parent) && parent.getNameNode() === node) return false;
  // A binding element's *property* name (`const { process: p } = x`) reads a property; the local
  // name (`p`) is the binding. Neither spelling reaches ambient `process`.
  if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === node) return false;
  if (isErasedTypePosition(node)) return false;
  return true;
}

/**
 * True when this node sits in a position the compiler *erases* before the module runs.
 *
 * Not the same question as "is there a TypeNode ancestor", which is what this used to ask. A class
 * heritage clause is the counterexample that mattered: ts-morph models `class C extends Function {}`
 * as an `ExpressionWithTypeArguments`, which **is** a TypeNode — but an `extends` expression is
 * evaluated at runtime, so the blanket ancestor test exempted a genuine value-position reference to
 * a capability root. `class Ctor extends Function {}` followed by
 * `new Ctor("return globalThis.fetch")()` returned the real transport with the gate reporting zero
 * violations.
 *
 * So the walk stops at an `extends` heritage clause on a class and reports "not erased". An
 * `implements` clause, and `interface A extends B`, stay erased — neither is evaluated.
 */
function isErasedTypePosition(node: import("ts-morph").Node): boolean {
  for (let current = node.getParent(); current !== undefined; current = current.getParent()) {
    if (Node.isHeritageClause(current)) {
      const isClassExtends = current.getToken() === SyntaxKind.ExtendsKeyword &&
        (Node.isClassDeclaration(current.getParent()) || Node.isClassExpression(current.getParent()));
      // A class `extends` expression runs. Anything else in a heritage clause is erased.
      return !isClassExtends;
    }
    if (Node.isTypeNode(current)) continue;
  }
  return node.getFirstAncestor((ancestor) => Node.isTypeNode(ancestor)) !== undefined;
}

/**
 * The one shape in which `process` is tolerated. See
 * `PROVISIONAL_PROCESS_PROPERTY_ALLOWLIST` — the carve-out is on the *shape*, so `process.env`
 * and every computed, aliased, or destructured acquisition stays a violation.
 */
function isAllowedProcessRead(
  node: import("ts-morph").Identifier,
  allowlist: ReadonlySet<string>,
): boolean {
  const parent = node.getParent();
  if (parent === undefined) return false;
  if (!Node.isPropertyAccessExpression(parent)) return false;
  if (parent.getExpression() !== node) return false;
  return allowlist.has(parent.getName());
}

/**
 * Read a property-name node as a *value*, never as source text.
 *
 * `getText()` returns what was typed. `getLiteralValue()` returns what it means, so
 * `"constructor"` and `` `constructor` `` both reduce to `constructor`. Round 5 found the text
 * form: a Unicode-escaped binding key walked straight past a comparison done on raw text.
 */
function literalName(node: import("ts-morph").Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  if (Node.isIdentifier(node)) return node.getText();
  if (Node.isComputedPropertyName(node)) return literalName(node.getExpression());
  return undefined;
}

/**
 * One level of constant folding for a member key held in a local `const`.
 *
 * `const K = "constructor"; Reflect.get(x, K)` was a live bypass: the argument is an identifier, so
 * no literal rule saw it. Folding a single-level `const … = "<literal>"` in the same file closes it
 * without building an evaluator. Deeper folding is deliberately not attempted — see the header's
 * disclaimer about values the gate cannot fold.
 */
function foldedName(node: import("ts-morph").Node | undefined): string | undefined {
  const direct = literalName(node);
  if (node === undefined) return undefined;
  if (!Node.isIdentifier(node)) return direct;
  for (const declaration of node.getSymbol()?.getDeclarations() ?? []) {
    if (!Node.isVariableDeclaration(declaration)) continue;
    // `const` only. A `let` or `var` can be reassigned between declaration and use, so folding one
    // would refuse code that assigns a safe value before reading it — a false refusal, which is the
    // pressure that produces carve-outs.
    if (declaration.getVariableStatement()?.getDeclarationKind() !== VariableDeclarationKind.Const) continue;
    const initializer = declaration.getInitializer();
    if (initializer === undefined || Node.isIdentifier(initializer)) continue;
    const value = literalName(initializer);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * True when this property sits on the left-hand side of a destructuring assignment.
 *
 * Walks only the literal spine — object/array literals, property and spread assignments, and
 * parentheses — and then requires that spine's top to be the `left` operand of an `=`. Anything
 * else on the way up means this is ordinary data, not a destructuring target.
 */
function isDestructuringAssignmentTarget(node: import("ts-morph").Node): boolean {
  let current: import("ts-morph").Node = node;
  for (let parent = current.getParent(); parent !== undefined; parent = current.getParent()) {
    if (Node.isBinaryExpression(parent)) {
      return parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken && parent.getLeft() === current;
    }
    const onSpine = Node.isObjectLiteralExpression(parent) || Node.isArrayLiteralExpression(parent) ||
      Node.isPropertyAssignment(parent) || Node.isShorthandPropertyAssignment(parent) ||
      Node.isSpreadAssignment(parent) || Node.isSpreadElement(parent) ||
      Node.isParenthesizedExpression(parent);
    if (!onSpine) return false;
    current = parent;
  }
  return false;
}

/**
 * Every statically readable way to *name* a banned member.
 *
 * Four shapes, because each reaches a member without a plain member-access node:
 *
 *   - member access — `x.constructor`, `x["constructor"]`, `` x[`constructor`] ``
 *   - binding destructuring — `const { constructor: F } = y;`, including a computed or escaped key
 *   - assignment destructuring — `({ constructor: F } = y);`, which is an ObjectLiteralExpression
 *     on the left of an `=`, not a binding pattern, and so was missed entirely
 *   - reflective read — `Reflect.get(y, "constructor")`, a descriptor lookup, or any call handed a
 *     banned member name, including one held in a local `const`
 *
 * **This is defense in depth, not the proof.** Four review rounds each closed some spellings here
 * and left others; the header says plainly why that is expected and what actually carries the
 * claim. Read this function as raising the cost of an accident, not as closing a class.
 */
function bannedMemberNames(node: import("ts-morph").Node): string[] {
  const banned = (name: string | undefined): string[] =>
    name !== undefined && BANNED_CAPABILITY_MEMBERS.has(name) ? [name] : [];

  if (Node.isPropertyAccessExpression(node)) return banned(node.getName());
  if (Node.isElementAccessExpression(node)) return banned(foldedName(node.getArgumentExpression()));
  if (Node.isBindingElement(node)) {
    return banned(literalName(node.getPropertyNameNode()) ?? node.getName());
  }
  // Assignment destructuring: `({ constructor: F } = y)`. The left side is an object *literal*, so
  // none of the binding-pattern rules above apply. The walk is bounded to the literal spine and
  // requires the top of it to be the LEFT operand of the `=`. An unbounded ancestor search for any
  // `=` refused ordinary data — `config = { require: true }` — wherever it appeared under an
  // assignment, which is a false refusal rather than a caught capability.
  if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) {
    if (isDestructuringAssignmentTarget(node)) return banned(literalName(node.getNameNode()));
    return [];
  }
  if (Node.isCallExpression(node)) {
    // Only a named reflective reader, not every call. See REFLECTIVE_MEMBER_READERS.
    const callee = node.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || !REFLECTIVE_MEMBER_READERS.has(callee.getName())) return [];
    return node.getArguments().flatMap((argument) => banned(foldedName(argument)));
  }
  return [];
}

function scanCapabilityRoots(
  sourceFile: import("ts-morph").SourceFile,
  add: (code: ShadowBoundaryViolationCode, detail: string) => void,
  processPropertyAllowlist: ReadonlySet<string>,
): void {
  sourceFile.forEachDescendant((node) => {
    if (Node.isCallExpression(node) && node.getExpression().getKind() === SyntaxKind.ImportKeyword) {
      add("dynamic_import", "Dynamic import() is forbidden: it hides the closure this gate walks.");
      return;
    }
    for (const member of bannedMemberNames(node)) {
      add(
        "capability_root",
        `line ${node.getStartLineNumber()}: \`${member}\` names a capability root; the shadow closure may not reach it through a member access, a destructuring, or a reflective read.`,
      );
      return;
    }
    if (!Node.isIdentifier(node)) return;
    const name = node.getText();
    if (!BANNED_CAPABILITY_ROOTS.has(name)) return;
    if (!isValuePositionReference(node)) return;
    if (name === "process" && isAllowedProcessRead(node, processPropertyAllowlist)) return;
    add(
      "capability_root",
      `line ${node.getStartLineNumber()}: \`${name}\` is a capability root; the shadow closure may not reference it in value position.`,
    );
  });
}

/**
 * Secondary diagnostics only.
 *
 * These are the surviving request-text checks from the regex era. They are kept because a
 * half-written mutating request is a useful thing to name in a review, and because deleting them
 * would look like a narrowing of the claim. They are NOT what carries the guarantee: text matching
 * is exactly the technique the seven documented evasions defeated. The guarantee comes from the
 * capability closure above — no transport root and no credential root is reachable, so there is
 * nothing for a well-formed mutating request string to be handed to.
 */
function scanRequestTextDiagnostics(
  source: string,
  add: (code: ShadowBoundaryViolationCode, detail: string) => void,
): void {
  if (/(?:execFileSync|execFile|spawnSync|spawn)\s*\(\s*["']gh["'][\s\S]{0,300}?(?:issue\s*["'],\s*["'](?:create|close|reopen|edit)|api[\s\S]{0,120}?(?:POST|PATCH|PUT|DELETE))/i.test(source)) {
    add("subprocess_github_write", "A shadow module attempts a GitHub write subprocess.");
  }
  if (/["'](?:--method|-X)["']\s*,\s*["'](?:POST|PATCH|PUT|DELETE)["']/i.test(source)) {
    add("mutating_rest", "A shadow module constructs a mutating REST request.");
  }
  if (/query\s*=\s*mutation\b/i.test(source)) {
    add("graphql_mutation", "A shadow module constructs a GraphQL mutation.");
  }
}

export interface ShadowBoundaryInput {
  readonly entrypoint: string;
  /**
   * In-memory tree, keyed by repo-relative path. Omit to audit `repoRoot` on disk.
   */
  readonly sources?: Readonly<Record<string, string>>;
  readonly repoRoot?: string;
  readonly compilerOptions?: ts.CompilerOptions;
  readonly externalRuntimeAllowlist?: ReadonlySet<string>;
  readonly processPropertyAllowlist?: ReadonlySet<string>;
  readonly processPropertyAllowlistForFile?: (file: string) => ReadonlySet<string>;
  readonly subprocessModuleAllowedFiles?: ReadonlySet<string>;
}

export function inspectShadowBoundary(input: ShadowBoundaryInput): ShadowBoundaryInspection {
  const repoRoot = normalize(resolve(input.repoRoot ?? (input.sources === undefined ? process.cwd() : "/repo")));
  const view = input.sources === undefined ? diskView() : memoryView(repoRoot, input.sources);
  const compilerOptions = input.compilerOptions ?? fallbackCompilerOptions(repoRoot);
  const externalRuntimeAllowlist = input.externalRuntimeAllowlist ?? EXTERNAL_RUNTIME_ALLOWLIST;
  const processPropertyAllowlist = input.processPropertyAllowlist ?? PROVISIONAL_PROCESS_PROPERTY_ALLOWLIST;
  const entrypoint = normalize(input.entrypoint);
  const entrypointAbsolute = normalize(resolve(repoRoot, entrypoint));

  // Parsing plus binder-level symbol lookup — `foldedName` calls `getSymbol()` for the single-level
  // const fold. That works under `noResolve`/`noLib` only because the fold is same-file; do not
  // narrow these options without re-running the const-fold cases, and do not widen the fold to
  // cross-file without revisiting them. Module resolution still goes through `ts.resolveModuleName`
  // against `view.host`, not through the program.
  const project = new Project({
    useInMemoryFileSystem: false,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { ...compilerOptions, noLib: true, noResolve: true },
  });

  const violations: ShadowBoundaryViolation[] = [];
  const visited = new Set<string>();
  const inspected = new Set<string>();
  const pending = [entrypointAbsolute];
  const resolutionCache = ts.createModuleResolutionCache(repoRoot, (name) => name.toLowerCase(), compilerOptions);

  const relativeTo = (absolutePath: string): string => toRepoRelative(repoRoot, absolutePath);

  while (pending.length > 0) {
    const absolutePath = pending.pop()!;
    if (visited.has(absolutePath)) continue;
    visited.add(absolutePath);
    const file = relativeTo(absolutePath);
    const add = (code: ShadowBoundaryViolationCode, detail: string) => {
      violations.push({ code, file, detail });
    };

    const source = view.read(absolutePath);
    if (source === undefined) continue;
    inspected.add(absolutePath);

    let sourceFile: import("ts-morph").SourceFile;
    try {
      sourceFile = project.createSourceFile(absolutePath, source, { overwrite: true });
    } catch (error) {
      add("parse_error", `The gate could not parse this file: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const parseErrors = parseDiagnosticsOf(sourceFile);
    if (parseErrors.length > 0) {
      // Fail closed: a file the parser could not make sense of has an unknown import graph and an
      // unknown set of identifier references. Reporting zero violations for it would be a lie.
      const first = ts.flattenDiagnosticMessageText(parseErrors[0].messageText, " ");
      add("parse_error", `${parseErrors.length} syntax error(s); the gate cannot audit what it cannot parse. First: ${first}`);
      continue;
    }

    scanCapabilityRoots(
      sourceFile,
      add,
      input.processPropertyAllowlistForFile?.(file) ?? processPropertyAllowlist,
    );
    scanRequestTextDiagnostics(source, add);

    for (const { specifier, typeOnly } of moduleEdges(sourceFile)) {
      const resolved = ts.resolveModuleName(
        specifier,
        absolutePath,
        compilerOptions,
        view.host,
        resolutionCache,
      ).resolvedModule?.resolvedFileName;
      const resolvedPath = resolved === undefined ? undefined : normalize(resolved);
      const resolvedRelative = resolvedPath === undefined ? undefined : relativeTo(resolvedPath);

      // Classify by resolved identity wherever the compiler could produce one, and fall back to
      // the specifier text only for externals the resolver has no files for (node builtins).
      const identity = resolvedRelative ?? specifier;
      const allowedSubprocessImport = SUBPROCESS_MODULE.test(specifier) &&
        input.subprocessModuleAllowedFiles?.has(file) === true;
      if (isForbiddenShadowModuleIdentity(identity) && !allowedSubprocessImport) {
        add("forbidden_import", `Shadow modules cannot import ${specifier} (resolves to ${identity}).`);
      }

      // Type-only statements are erased before the module runs, so they are not edges in the
      // runtime closure this gate is about. They are still classified as forbidden modules above,
      // and they are not walked or fail-closed on.
      if (typeOnly) continue;

      const inRepoSpecifier = specifier.startsWith(".") || specifier.startsWith("@/");
      if (inRepoSpecifier) {
        if (resolvedPath === undefined) {
          // Fail closed: an edge the compiler cannot resolve is an unwalked subgraph, not an
          // absent one.
          add(
            "unresolved_import",
            `${specifier} does not resolve; the gate cannot walk what the compiler cannot find.`,
          );
          continue;
        }
        if (!isWithinTree(repoRoot, resolvedPath) || resolvedRelative === undefined) {
          add(
            "external_module_not_allowlisted",
            `${specifier} resolves to ${resolvedPath}, which is outside the audited tree.`,
          );
          continue;
        }
        if (isDeclarationFile(resolvedPath)) {
          // A declaration file is not what the runtime loads. Walking it would audit a file that
          // never executes while its sibling implementation — a `.js` the compiler declined to
          // resolve to — runs unread, which silently shrinks the closure this gate reports on.
          add(
            "declaration_only_resolution",
            `${specifier} resolves to the declaration file ${resolvedRelative}; the runtime loads a sibling the gate cannot audit.`,
          );
          continue;
        }
        if (READER_MODULE.test(resolvedRelative)) {
          add(
            "readonly_reader_import",
            `Shadow mode consumes the preflight snapshot artifact and never calls GitHub; ${resolvedRelative} is out of bounds.`,
          );
        }
        pending.push(resolvedPath);
        continue;
      }

      // External runtime edge. Named codes first, for a legible failure; then the allowlist, which
      // is what actually bounds the closure.
      if (SUBPROCESS_MODULE.test(specifier) && !allowedSubprocessImport) {
        add("subprocess_module_import", `Shadow modules spawn no subprocess; ${specifier} is out of bounds.`);
      }
      if (NETWORK_MODULE.test(specifier)) {
        add("network_module_import", `Shadow modules open no socket; ${specifier} is out of bounds.`);
      }
      if (!externalRuntimeAllowlist.has(specifier)) {
        add(
          "external_module_not_allowlisted",
          `${specifier} is not on the shadow closure's external allowlist (${[...externalRuntimeAllowlist].join(", ")}).`,
        );
      }
    }
  }

  // Fail closed on a stale entrypoint constant: an empty or unreachable tree would otherwise
  // inspect nothing, find nothing, and exit 0 while proving nothing.
  if (!inspected.has(entrypointAbsolute)) {
    violations.push({
      code: "missing_entrypoint",
      file: entrypoint,
      detail: "The shadow entrypoint was not found, so nothing was proved.",
    });
  }

  return {
    entrypoint,
    visitedFiles: [...visited].map(relativeTo).sort(),
    violations: violations.sort((left, right) =>
      left.file.localeCompare(right.file) || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail)),
  };
}

export function runShadowBoundaryLint(
  repoRoot = process.cwd(),
  // `includePublicationEntrypoints: false` also skips the operator request-bundle
  // entrypoint, which is not a publication surface. Only fixture-root tests pass it —
  // production callers take the default and audit every entrypoint. If a production
  // caller ever needs it, split the flag rather than widening this exemption.
  options: { readonly includePublicationEntrypoints?: boolean } = {},
): ShadowBoundaryInspection {
  const compilerOptions = repoCompilerOptions(repoRoot);
  const inspections = [inspectShadowBoundary({
    entrypoint: SHADOW_BOUNDARY_ENTRYPOINT,
    repoRoot,
    compilerOptions,
  }), ...(options.includePublicationEntrypoints === false ? [] : [inspectShadowBoundary({
    entrypoint: SHADOW_OPERATOR_REQUEST_BUNDLE_ENTRYPOINT,
    repoRoot,
    compilerOptions,
  }), inspectShadowBoundary({
    entrypoint: SHADOW_PUBLICATION_CORE_ENTRYPOINT,
    repoRoot,
    compilerOptions,
  }), inspectShadowBoundary({
    entrypoint: SHADOW_PUBLICATION_CALLER_ENTRYPOINT,
    repoRoot,
    compilerOptions,
    externalRuntimeAllowlist: EXTERNAL_RUNTIME_ALLOWLIST,
    processPropertyAllowlist: SHADOW_PUBLICATION_CALLER_PROCESS_PROPERTIES,
  }), inspectShadowBoundary({
    entrypoint: SHADOW_PUBLICATION_SHELL_ENTRYPOINT,
    repoRoot,
    compilerOptions,
    externalRuntimeAllowlist: new Set([...EXTERNAL_RUNTIME_ALLOWLIST, "node:child_process", "node:url"]),
    processPropertyAllowlistForFile: (file) =>
      SHADOW_PUBLICATION_SHELL_PROCESS_PROPERTIES[file] ?? SHADOW_PUBLICATION_CALLER_PROCESS_PROPERTIES,
    subprocessModuleAllowedFiles: new Set([SHADOW_WINDOWS_ACL_ADAPTER]),
  })])];
  const result: ShadowBoundaryInspection = {
    entrypoint: SHADOW_BOUNDARY_ENTRYPOINT,
    visitedFiles: [...new Set(inspections.flatMap(({ visitedFiles }) => visitedFiles))].sort(),
    violations: inspections.flatMap(({ violations }) => violations).sort((left, right) =>
      left.file.localeCompare(right.file) || left.code.localeCompare(right.code) || left.detail.localeCompare(right.detail)),
  };
  for (const violation of result.violations) {
    console.error(`${violation.code}: ${violation.file}: ${violation.detail}`);
  }
  return result;
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runShadowBoundaryLint();
    if (result.violations.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
