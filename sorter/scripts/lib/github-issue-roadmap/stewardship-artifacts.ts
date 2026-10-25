import { resolve } from "node:path";
import { readVerifiedImmutableJson } from "./canonical-json";

// The measured status working set is 377,707,045 UTF-8 bytes (360.2 MiB).
// Allow headroom at 512 MiB; charge serialized bytes, and measure actual RSS separately.
// A 256 MiB trial reread 1,854 artifacts and peaked at 1.70 GiB RSS.
// Three 512 MiB fixture runs peaked at 1.397-1.461 GiB RSS with zero eviction rereads.
export const STEWARDSHIP_ARTIFACT_CACHE_BYTES = 512 * 1024 * 1024;

/** One invocation only. Neither mutable store files nor failed verifications enter this cache. */
export function createStewardshipArtifactCache(options: { maxBytes?: number } = {}) {
  const maxBytes = options.maxBytes ?? STEWARDSHIP_ARTIFACT_CACHE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Invalid artifact cache byte budget");
  const values = new Map<string, { value: unknown; bytes: number }>();
  // Diagnostics only: an eviction never preserves permission to skip disk verification.
  const evicted = new Set<string>();
  let cachedBytes = 0;
  let evictionRereads = 0;
  return {
    // Count attempted disk reads of paths previously evicted by this invocation's LRU.
    get diagnostics() { return { cachedBytes, evictionRereads }; },
    read(artifacts: string, sha256: string): unknown {
      if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid artifact hash");
      const path = resolve(artifacts, `${sha256}.json`);
      const key = path;
      const hit = values.get(key);
      if (hit) {
        values.delete(key); values.set(key, hit);
        return hit.value;
      }
      if (evicted.has(key)) evictionRereads++;
      const { value, bytes } = readVerifiedImmutableJson(path, sha256);
      if (bytes <= maxBytes) {
        while (cachedBytes + bytes > maxBytes) {
          const oldest = values.keys().next().value!;
          cachedBytes -= values.get(oldest)!.bytes; values.delete(oldest); evicted.add(oldest);
        }
        values.set(key, { value, bytes }); cachedBytes += bytes;
      }
      return value;
    },
  };
}

export type StewardshipArtifactCache = ReturnType<typeof createStewardshipArtifactCache>;
