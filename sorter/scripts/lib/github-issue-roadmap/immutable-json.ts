import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { canonicalJson, prettyCanonicalJson } from "./canonical-json";

const CLAIM_RETRY_DELAYS_MS = [10, 20, 40, 80] as const;

function waitForClaimRetry(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Claim-and-write for one immutable JSON file.
 *
 * This deliberately does NOT reuse `writeImmutable` in `intake-observation.ts`: that helper throws
 * on any existing destination and never compares content, so a content-equal replay is an error
 * there. Here a replay of identical canonical content succeeds and reports `created: false`; only a
 * genuine content mismatch throws.
 */
export class ImmutableJsonMismatch extends Error {
  constructor(readonly path: string) {
    super(`Immutable JSON mismatch: ${path} already holds different content.`);
    this.name = "ImmutableJsonMismatch";
  }
}

export interface ImmutableJsonWriteResult {
  readonly path: string;
  /** False when the destination already held byte-identical canonical content. */
  readonly created: boolean;
}

function readCanonical(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`Immutable JSON destination ${path} is not readable: ${String(error)}`);
  }
  try {
    return canonicalJson(JSON.parse(raw));
  } catch {
    throw new Error(`Immutable JSON destination ${path} is not readable as JSON.`);
  }
}

export function readImmutableJson(path: string): unknown {
  return JSON.parse(readFileSync(resolve(path), "utf8"));
}

export function writeImmutableJson(path: string, value: unknown): ImmutableJsonWriteResult {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  const claimPath = `${target}.claim`;
  const temporaryPath = `${target}.${randomUUID()}.tmp`;
  const canonicalValue = canonicalJson(value);
  let claim: number | null = null;
  let ownsClaim = false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        claim = openSync(claimPath, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

        // The claim gates progress only when this call would create the destination. Once the
        // destination exists and canonicalizes equal, the answer is already settled and no writer
        // — this one or the claim's owner — can change it, so answer now. Returning here instead
        // of waiting out the retries and then removing a claim this call never acquired is what
        // keeps the helper from ever deleting a live writer's claim.
        if (existsSync(target)) {
          if (readCanonical(target) !== canonicalValue) throw new ImmutableJsonMismatch(target);
          return { path: target, created: false };
        }

        // Destination absent: the claim genuinely blocks this write, so wait for its owner.
        // `>=`, not `===`: past the end of the table `Atomics.wait` would read an `undefined`
        // timeout as Infinity and hang forever rather than throw.
        if (attempt >= CLAIM_RETRY_DELAYS_MS.length) {
          throw new Error(
            `Could not acquire write claim for ${target}: ${claimPath} still exists and the destination is absent after ${attempt + 1} attempts; another writer may still be active.`,
          );
        }

        waitForClaimRetry(CLAIM_RETRY_DELAYS_MS[attempt]);
      }
    }
    ownsClaim = true;
    closeSync(claim);
    claim = null;
    if (existsSync(target)) {
      if (readCanonical(target) !== canonicalValue) throw new ImmutableJsonMismatch(target);
      return { path: target, created: false };
    }
    writeFileSync(temporaryPath, prettyCanonicalJson(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
    // A hard-link commit is atomic and never replaces an existing pathname on POSIX or Windows,
    // matching `writeRoadmapArtifactImmutably` in artifact-io.ts. `renameSync` would silently
    // overwrite a file another writer created between the existence check above and this commit —
    // the one outcome an immutable store must not produce.
    linkSync(temporaryPath, target);
    unlinkSync(temporaryPath);
    return { path: target, created: true };
  } catch (error) {
    if (claim !== null) closeSync(claim);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      /* best effort */
    }
    throw error;
  } finally {
    try {
      if (ownsClaim && existsSync(claimPath)) unlinkSync(claimPath);
    } catch {
      /* best effort */
    }
  }
}
