import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { Node, SyntaxKind, ts } from "ts-morph";

/**
 * Shared AST substrate for the read-only roadmap boundary lints.
 *
 * Both `lint-github-issue-roadmap-shadow-boundary.ts` and
 * `lint-github-issue-roadmap-weekly-boundary.ts` make a claim of the same shape — "starting at this
 * entrypoint, nothing in the transitive runtime closure reaches a credential or a mutation
 * transport". A claim of that shape is only as strong as the walker behind it, so the walker lives
 * here once rather than twice.
 *
 * The weekly lint used to extract imports with a regex over source text. That is the exact technique
 * the shadow lint's seven documented evasions defeated: a block-comment opener spliced across two
 * string literals blanks the real imports between them, and a hand-rolled candidate list picks a
 * different module than the compiler does. Sharing this module is what stops the two lints from
 * making similar-sounding claims of very different strength.
 */

/** Windows and POSIX spellings of the same path compare equal after this. */
export function normalize(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Every module-file extension the TypeScript resolver can land on, including declaration files.
 *
 * Used to reduce a *resolved identity* back to a module name. Classification asks "is this module
 * the host lock", and `host-lock.ts`, `host-lock.js`, `host-lock.d.ts`, `host-lock.mts` and
 * `host-lock/index.ts` are all the same answer.
 */
const MODULE_FILE_EXTENSION = /\.(?:d\.)?[cm]?[tj]sx?$/;

/** True for a resolved path the runtime cannot execute: a declaration file. */
export function isDeclarationFile(path: string): boolean {
  return /\.d\.[cm]?ts$/.test(normalize(path));
}

/**
 * Reduce a resolved identity (or a bare specifier) to the module name a boundary list is written
 * against: no extension, no `/index` tail, no query or fragment suffix.
 */
export function moduleIdentityName(identity: string): string {
  const withoutSuffix = normalize(identity).replace(/[?#].*$/, "");
  const withoutExtension = withoutSuffix.replace(MODULE_FILE_EXTENSION, "");
  return withoutExtension.replace(/\/index$/, "");
}

/**
 * Case-fold a path or module name for comparison.
 *
 * Applied unconditionally rather than conditioned on the host's case sensitivity. This repo's
 * supported platform resolves `./lib/Host-Lock` to `host-lock.ts`, so a case-exact comparison let a
 * forbidden module through on spelling alone, and let a `Node_Modules` segment read as in-tree. The
 * failure direction of folding on a case-sensitive filesystem is a *refusal* of two files whose
 * names differ only in case — fail-closed, and no such pair exists in this repo.
 */
export function caseFold(value: string): string {
  return value.toLowerCase();
}

/** The last path segment of a reduced module identity, case-folded for comparison. */
export function moduleBaseName(identity: string): string {
  const name = moduleIdentityName(identity);
  return caseFold(name.slice(name.lastIndexOf("/") + 1));
}

/**
 * Repo-relative form for reporting. Falls back to the absolute path for anything outside the tree,
 * which is a case the caller should already have refused via `isWithinTree`.
 */
export function toRepoRelative(repoRoot: string, absolutePath: string): string {
  const rel = normalize(relative(repoRoot, absolutePath));
  return rel === "" || rel === ".." || rel.startsWith("../") ? normalize(absolutePath) : rel;
}

/**
 * Containment, computed from absolute paths rather than guessed from a leading separator.
 *
 * The previous test was `resolvedRelative.startsWith("/") || .includes("node_modules/")`. On this
 * repo's platform `path.relative` returns `..\..\..\evil.ts` — backslashes, no leading slash — so a
 * `../` escape tripped neither half and the refusal was dead code. Segment comparison on the
 * normalized relative path holds on both separators, and `isAbsolute` catches a different Windows
 * drive, where `relative` returns an absolute path rather than a `..` chain.
 */
export function isWithinTree(repoRoot: string, absolutePath: string): boolean {
  // Canonicalize BOTH sides before comparing. A lexical comparison accepts a directory symlink
  // inside the repo whose target is outside it: the path reads as in-tree while the file the runtime
  // loads is not, so the audited closure silently extends past the boundary this function defines.
  // Canonicalizing only the target would break the `.worktrees/` layout, where the root itself can
  // sit behind a link — both sides, or neither.
  const root = canonical(repoRoot);
  const target = canonical(absolutePath);
  const rel = relative(root, target);
  if (rel === "" || isAbsolute(rel)) return false;
  const segments = normalize(rel).split("/");
  if (segments[0] === "..") return false;
  return !segments.some((segment) => caseFold(segment) === "node_modules");
}

/**
 * Real path when the entry exists, the resolved lexical path otherwise.
 *
 * The fallback is what lets the in-memory fixture tree work: those paths never touch disk, so
 * `realpathSync` would throw for every one of them. A path that does not exist cannot be a symlink
 * to somewhere else either, so resolving it lexically loses nothing.
 */
function canonical(path: string): string {
  try {
    return normalize(realpathSync.native(path));
  } catch {
    return normalize(path);
  }
}

/**
 * A read-only view of the tree being audited, plus the module-resolution host the compiler uses to
 * walk it. Two implementations: the real filesystem, and an in-memory map for fixtures. Both go
 * through the same `ts.resolveModuleName`, so a fixture exercises the real resolver rather than a
 * hand-rolled candidate list.
 */
export interface TreeView {
  readonly host: ts.ModuleResolutionHost;
  read(absolutePath: string): string | undefined;
}

export function diskView(): TreeView {
  return {
    host: ts.sys,
    read: (absolutePath) => {
      // File-only: `existsSync` is true for a directory, and `readFileSync` on one throws EISDIR.
      const stats = statSync(absolutePath, { throwIfNoEntry: false });
      return stats?.isFile() === true ? readFileSync(absolutePath, "utf8") : undefined;
    },
  };
}

export function memoryView(repoRoot: string, sources: Readonly<Record<string, string>>): TreeView {
  const files = new Map<string, string>();
  for (const [path, source] of Object.entries(sources)) {
    files.set(normalize(resolve(repoRoot, path)), source);
  }
  const directories = new Set<string>();
  for (const path of files.keys()) {
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      directories.add(path.slice(0, slash));
    }
  }
  return {
    host: {
      fileExists: (fileName) => files.has(normalize(fileName)),
      readFile: (fileName) => files.get(normalize(fileName)),
      directoryExists: (directoryName) => directories.has(normalize(directoryName)),
      realpath: (path) => path,
      useCaseSensitiveFileNames: false,
    },
    read: (absolutePath) => files.get(normalize(absolutePath)),
  };
}

export interface ModuleEdge {
  readonly specifier: string;
  /** True only for a statement-level `import type` / `export type`. */
  readonly typeOnly: boolean;
}

/**
 * Collect every module edge in a file as an AST fact.
 *
 * Covers `ImportDeclaration`, `ExportDeclaration` with a module specifier (`export * from`,
 * `export { x } from`), and `ImportEqualsDeclaration` with an external module reference
 * (`import x = require("./y")`). A comment or a string literal produces none of these node kinds,
 * which is why the comment-splice evasion cannot exist against this extractor.
 *
 * Only a **statement-level** `import type` / `export type` counts as type-only. An inline
 * `import { type Foo, bar } from "x"` stays a runtime edge, and so does
 * `import { type Foo } from "x"` — TypeScript may elide the latter, but the failure direction of
 * guessing wrong is an unwalked subgraph, so the gate walks it.
 */
export function moduleEdges(sourceFile: import("ts-morph").SourceFile): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  for (const declaration of sourceFile.getImportDeclarations()) {
    edges.push({
      specifier: declaration.getModuleSpecifierValue(),
      typeOnly: declaration.isTypeOnly(),
    });
  }
  for (const declaration of sourceFile.getExportDeclarations()) {
    const specifier = declaration.getModuleSpecifierValue();
    if (specifier === undefined) continue;
    edges.push({ specifier, typeOnly: declaration.isTypeOnly() });
  }
  for (const declaration of sourceFile.getDescendantsOfKind(SyntaxKind.ImportEqualsDeclaration)) {
    const reference = declaration.getModuleReference();
    if (!Node.isExternalModuleReference(reference)) continue;
    const expression = reference.getExpression();
    if (expression === undefined || !Node.isStringLiteral(expression)) continue;
    edges.push({ specifier: expression.getLiteralValue(), typeOnly: declaration.isTypeOnly() });
  }
  return edges;
}

export function parseDiagnosticsOf(sourceFile: import("ts-morph").SourceFile): readonly ts.Diagnostic[] {
  const compilerNode = sourceFile.compilerNode as unknown as {
    parseDiagnostics?: readonly ts.Diagnostic[];
  };
  return compilerNode.parseDiagnostics ?? [];
}

/**
 * Compiler options used when no tsconfig is available (the in-memory fixture path).
 *
 * Mirrors the repo's own `tsconfig.json` on the settings that change resolution outcomes —
 * `moduleResolution: bundler` (extensionless relative specifiers resolve; `./x.js` maps to `x.ts`)
 * and the `@/*` path alias.
 */
export function fallbackCompilerOptions(repoRoot: string): ts.CompilerOptions {
  return {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2017,
    baseUrl: repoRoot,
    paths: { "@/*": ["./src/*"] },
  };
}

/**
 * Read the repo's own compiler options so a gate resolves module specifiers exactly the way the
 * build and the runtime do — path aliases, `moduleResolution`, and all. Falls back (fail-closed on
 * a malformed config) to the bundler-mode defaults that mirror this repo's tsconfig.
 */
export function repoCompilerOptions(repoRoot: string): ts.CompilerOptions {
  const configPath = resolve(repoRoot, "tsconfig.json");
  if (!existsSync(configPath)) return fallbackCompilerOptions(repoRoot);
  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error !== undefined) return fallbackCompilerOptions(repoRoot);
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, configPath);
  // A repo tsconfig that omits `allowJs` would make a legitimate `./plain.js` edge unresolvable,
  // and an unresolvable in-repo edge is a fail-closed violation. Resolution here is about finding
  // the file the runtime loads, not about what the build emits, so allowJs is forced on.
  return { ...parsed.options, allowJs: true };
}
