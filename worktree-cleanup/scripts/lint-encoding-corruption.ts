/**
 * Reject UTF-8 encoding corruption before it enters history.
 *
 * Why this exists: an agent rewriting a whole file can BOM-prefix it and
 * double-encode every multibyte character (`—` becomes `â€"`), and `tsc`,
 * `vitest`, and `eslint --max-warnings 0` all pass green on the result. The
 * agent then self-reports success. Nothing in the existing gate stack looks at
 * bytes, so the corruption only surfaces when a human reads the diff — or when a
 * user sees mojibake in the UI.
 *
 * See docs/solutions/workflow-issues/codex-mcp-file-rewrite-encoding-corruption-2026-06-22.md
 *
 * Default scope is the staged set, so the repo's pre-existing corruption does not
 * block unrelated commits. `--all` scans every tracked file for cleanup work.
 *
 *   npx tsx scripts/lint-encoding-corruption.ts            # staged (pre-commit)
 *   npx tsx scripts/lint-encoding-corruption.ts --all      # whole repo
 *   npx tsx scripts/lint-encoding-corruption.ts --all --fix # repair in place
 *
 * The repair is targeted, never a whole-file re-decode. It rewrites only the
 * byte runs that round-trip cleanly and leaves every other byte untouched,
 * because rewritten files come back MIXED -- new hunks clean, rewritten lines
 * corrupt -- so re-decoding the whole file destroys the parts that were fine.
 *
 * The source encoding is WINDOWS-1252, not latin-1. CP1252 maps 0x80-0x9F to
 * printable punctuation (0x80 -> U+20AC, 0x99 -> U+2122, 0x93/0x94 -> curly
 * quotes); latin-1 maps them to C1 controls. Encoding back with latin-1 would
 * truncate U+20AC to 0xAC and manufacture fresh garbage.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Byte signatures of UTF-8 read as latin1 and re-encoded. These are the
 * high-confidence markers: `Ã¢â‚¬` is the mojibake of the U+2018-U+201D
 * punctuation block (curly quotes, em/en dashes, ellipsis), which is what
 * whole-file rewrites mangle in practice. Matching on bytes rather than decoded
 * text avoids depending on how the reader decodes the file.
 */
const SIGNATURES: ReadonlyArray<{ bytes: Buffer; label: string }> = [
  { bytes: Buffer.from([0xc3, 0xa2, 0xe2, 0x82, 0xac]), label: "â€ (mangled curly quote / dash / ellipsis)" },
  { bytes: Buffer.from([0xc3, 0x83, 0xc2]), label: "Ãƒâ€š (double-encoded latin-1 supplement)" },
];

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Files that legitimately contain a corruption signature: the learning doc that
 * documents this exact failure quotes the mojibake as evidence, and this linter
 * carries the signatures in its own source.
 */
const ALLOWLIST = new Set([
  "docs/solutions/workflow-issues/codex-mcp-file-rewrite-encoding-corruption-2026-06-22.md",
  "scripts/lint-encoding-corruption.ts",
]);

/** Skip anything that is legitimately binary — signatures there are meaningless. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|avif|ico|pdf|zip|gz|tgz|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|jsonl|lockb)$/i;

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function targets(all: boolean): string[] {
  const out = all
    ? git(["ls-files"])
    : git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  return out.split("\n").filter(Boolean);
}

type Finding = { file: string; kind: "bom" | "mojibake"; detail: string; line?: number };

export function inspect(file: string): Finding[] {
  if (ALLOWLIST.has(file) || BINARY_EXT.test(file)) return [];

  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return []; // deleted or unreadable in the work tree; nothing to audit
  }
  if (buf.length > 5_000_000) return [];
  if (buf.includes(0)) return []; // NUL byte -> binary

  const findings: Finding[] = [];

  if (buf.subarray(0, 3).equals(BOM)) {
    findings.push({ file, kind: "bom", detail: "file starts with a UTF-8 BOM (EF BB BF)" });
  }

  for (const sig of SIGNATURES) {
    const at = buf.indexOf(sig.bytes);
    if (at === -1) continue;
    // Report a line number so the author can go straight to it.
    const line = buf.subarray(0, at).toString("utf8").split("\n").length;
    findings.push({ file, kind: "mojibake", detail: sig.label, line });
  }

  return findings;
}

/** CP1252 high range: code point -> byte. Everything else below 0x100 is identity. */
const CP1252: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x0192, 0x83], [0x201e, 0x84], [0x2026, 0x85],
  [0x2020, 0x86], [0x2021, 0x87], [0x02c6, 0x88], [0x2030, 0x89], [0x0160, 0x8a],
  [0x2039, 0x8b], [0x0152, 0x8c], [0x017d, 0x8e], [0x2018, 0x91], [0x2019, 0x92],
  [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97],
  [0x02dc, 0x98], [0x2122, 0x99], [0x0161, 0x9a], [0x203a, 0x9b], [0x0153, 0x9c],
  [0x017e, 0x9e], [0x0178, 0x9f],
]);

const LEADS = new Set(["Â", "Ã", "â"]);

function toCp1252(str: string): Buffer | null {
  const out = Buffer.alloc(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.codePointAt(i)!;
    const mapped = CP1252.get(c);
    if (mapped !== undefined) out[i] = mapped;
    else if (c <= 0xff) out[i] = c;
    else return null;
  }
  return out;
}

/**
 * Shortest run at `i` that round-trips to valid, shorter text. Shortest (not
 * longest) keeps the rewrite minimal — it replaces the corrupted characters and
 * nothing else.
 */
function repairRunAt(s: string, i: number): { len: number; fixed: string } | null {
  for (let len = 2; len <= 6 && i + len <= s.length; len++) {
    const bytes = toCp1252(s.slice(i, i + len));
    if (!bytes) return null;
    const fixed = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    if (fixed.includes("�")) continue;
    if (fixed.length < len) return { len, fixed };
  }
  return null;
}

function repair(file: string): { replacements: number; bomRemoved: boolean } | null {
  const raw = fs.readFileSync(file);
  const hadBom = raw.subarray(0, 3).equals(BOM);
  const s = (hadBom ? raw.subarray(3) : raw).toString("utf8");

  let out = "";
  let replacements = 0;
  for (let i = 0; i < s.length; ) {
    if (LEADS.has(s[i])) {
      const r = repairRunAt(s, i);
      if (r) {
        out += r.fixed;
        i += r.len;
        replacements++;
        continue;
      }
    }
    out += s[i];
    i++;
  }

  if (replacements === 0 && !hadBom) return null;
  fs.writeFileSync(file, Buffer.from(out, "utf8"));
  return { replacements, bomRemoved: hadBom };
}

function main(): void {
  const all = process.argv.includes("--all");
  const fix = process.argv.includes("--fix");
  const files = targets(all);
  if (files.length === 0) {
    process.exit(0);
  }

  if (fix) {
    let touched = 0;
    for (const f of files) {
      if (ALLOWLIST.has(f) || BINARY_EXT.test(f)) continue;
      if (inspect(f).length === 0) continue;
      const r = repair(f);
      if (!r) continue;
      touched++;
      const bits = [
        r.replacements ? `${r.replacements} sequence${r.replacements === 1 ? "" : "s"}` : null,
        r.bomRemoved ? "BOM removed" : null,
      ].filter(Boolean);
      console.log(`  repaired ${f} — ${bits.join(", ")}`);
    }
    console.log(touched ? `\n${touched} file(s) repaired. Review the diff before committing.` : "Nothing to repair.");
    process.exit(0);
  }

  const findings = files.flatMap(inspect);
  if (findings.length === 0) {
    if (all) console.log(`encoding audit: ${files.length} tracked files clean.`);
    process.exit(0);
  }

  const scope = all ? "tracked files" : "staged changes";
  console.error(`\nEncoding corruption detected in ${scope}:\n`);
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    console.error(`  ${where}\n    ${f.detail}`);
  }
  console.error(
    `\nThis is UTF-8 read as latin-1 and re-encoded. Type checks, tests, and lint all\n` +
      `pass on it, so nothing else will catch it before a user sees mojibake.\n` +
      `\nRepair with targeted replacement of the affected characters, NOT a blanket\n` +
      `latin1->utf8 round-trip: rewritten files come back mixed, so a whole-file\n` +
      `re-decode corrupts the hunks that are still correct.\n` +
      `\nRun \`npm run lint:encoding -- --all\` to see every affected file.\n` +
      `Deliberate bypass: git commit --no-verify\n`,
  );
  process.exit(1);
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("lint-encoding-corruption.ts") || entry.endsWith("lint-encoding-corruption.js")) main();
