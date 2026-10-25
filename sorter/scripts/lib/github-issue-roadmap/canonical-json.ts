import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;
// Intrinsic value hashes only: this weak memo never authorizes a file read.
const immutableHashes = new WeakMap<object, string>();

function memoizeImmutableJsonHash(value: unknown, sha256: string): void {
  if (value === null || typeof value !== "object") return;
  const seen = new WeakSet<object>();
  const freeze = (node: object): void => {
    if (seen.has(node)) return;
    seen.add(node);
    for (const child of Object.values(node)) if (child !== null && typeof child === "object") freeze(child);
    Object.freeze(node);
  };
  freeze(value);
  immutableHashes.set(value, sha256);
}

/** A memoized hash can only originate from a successful verification of these disk bytes. */
export function readVerifiedImmutableJson(path: string, sha256: string): { value: unknown; bytes: number } {
  const text = readFileSync(path, "utf8");
  const value: unknown = JSON.parse(text);
  if (canonicalJsonSha256(value) !== sha256) throw new Error("Immutable artifact hash mismatch / corruption");
  memoizeImmutableJsonHash(value, sha256);
  return { value, bytes: Buffer.byteLength(text, "utf8") };
}

export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as JsonObject)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, canonicalizeJson(child)]));
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function prettyCanonicalJson(value: unknown): string {
  return `${JSON.stringify(canonicalizeJson(value), null, 2)}\n`;
}

export function sha256Bytes(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJsonSha256(value: unknown): string {
  const known = value !== null && typeof value === "object" ? immutableHashes.get(value) : undefined;
  if (known !== undefined) return known;
  return sha256Bytes(canonicalJson(value));
}
