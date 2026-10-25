import './worktree-cleanup-test-env';
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspect } from "../lint-encoding-corruption";
import { inspectEncoding } from "../lib/worktree-cleanup/admission.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});
describe("encoding detector parity with inspect()", () => {
  it.each([
    ["BOM", Buffer.from([0xef, 0xbb, 0xbf, 0x61])],
    ["double-encoded em dash", Buffer.from([0xc3, 0x83, 0xc2, 0xa2, 0xc3, 0xa2, 0xe2, 0x82, 0xac, 0xe2, 0x80, 0x9d])],
    ["clean UTF-8", Buffer.from("# Caf\u00e9 \u2014 notes\n")],
    ["CRLF", Buffer.from("# Notes\r\nsecond line\r\n")],
    ["second-line corruption", Buffer.from([10, 0xc3, 0xa2, 0xe2, 0x82, 0xac])],
    ["NUL binary", Buffer.from([0xef, 0xbb, 0xbf, 0])],
    ["large file", Buffer.alloc(5_000_001, 65)],
  ] as const)("matches verdict and finding kinds/lines: %s", (_name, bytes) => {
    const root = mkdtempSync(join(tmpdir(), "cleanup-encoding-")); roots.push(root);
    const file = join(root, "fixture.md"); writeFileSync(file, bytes);
    const expected = inspect(file).map(({ kind, line }) => ({ kind, line }));
    const result = inspectEncoding(file, bytes);
    expect(result.state).toBe(expected.length ? "ok" : "negative");
    if (result.state === "ok") expect(result.value.map(({ kind, line }) => ({ kind, line }))).toEqual(expected);
  });
  it("matches allowlisted paths and binary extensions", () => {
    for (const file of ["scripts/lint-encoding-corruption.ts", "docs/solutions/workflow-issues/codex-mcp-file-rewrite-encoding-corruption-2026-06-22.md", "image.png"]) {
      expect(inspectEncoding(file, Buffer.from([0xef, 0xbb, 0xbf])).state).toBe("negative");
    }
  });
});
