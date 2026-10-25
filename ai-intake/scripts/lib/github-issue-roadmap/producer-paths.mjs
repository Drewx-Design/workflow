/** Dependency-free naming and matching shared by CI classification and conformance. */
export const ROADMAP_SIDECAR_ROOT = "artifacts/github-issue-roadmap";
const PREFIX = "outcome-candidate--";
const SUFFIX = ".roadmap-outcomes.json";

/** @param {string} locator */
export function isCanonicalSourceLocator(locator) {
  return typeof locator === "string" && locator.length > 0 && locator.length <= 512 &&
    /^[A-Za-z0-9._@+/-]+$/.test(locator) &&
    !locator.split("/").some((part) => part === "" || part === "." || part === "..") &&
    locator.split("/")[0].toLowerCase() !== ".git";
}

/** @param {string} glob */
function globRegex(glob) {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        index += 1;
        if (glob[index + 1] === "/") {
          index += 1;
          pattern += "(?:.*/)?";
        } else {
          pattern += ".*";
        }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "{") {
      const close = glob.indexOf("}", index);
      if (close === -1) throw new Error(`Invalid producer glob ${glob}.`);
      const options = glob.slice(index + 1, close).split(",")
        .map((entry) => entry.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      pattern += `(?:${options.join("|")})`;
      index = close;
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`, "s");
}

/**
 * @template {{active: boolean, artifactGlobs: readonly string[]}} T
 * @param {string} sourceLocator
 * @param {readonly T[]} producers
 * @returns {T | null}
 */
export function producerFor(sourceLocator, producers) {
  if (!isCanonicalSourceLocator(sourceLocator)) return null;
  return producerForPath(sourceLocator, producers);
}

/** Match registration before identity validation, so noncanonical producer paths
 * cannot fall through to an ordinary-docs exemption.
 * @template {{active: boolean, artifactGlobs: readonly string[]}} T
 * @param {string} sourceLocator
 * @param {readonly T[]} producers
 * @returns {T | null}
 */
export function producerForPath(sourceLocator, producers) {
  const matches = producers.filter((producer) => producer.active &&
    producer.artifactGlobs.some((glob) => globRegex(glob).test(sourceLocator)));
  if (matches.length > 1) throw new Error(`${sourceLocator} matches multiple active producer kinds.`);
  return matches[0] ?? null;
}

/**
 * @param {{sidecar: {storageRoot: string, prefix: string, suffix: string}}} producer
 * @param {string} sourceLocator
 */
export function roadmapSidecarLocator(producer, sourceLocator) {
  if (!isCanonicalSourceLocator(sourceLocator)) throw new Error(`Unsafe source locator: ${sourceLocator}.`);
  return `${producer.sidecar.storageRoot}/${producer.sidecar.prefix}${encodeURIComponent(sourceLocator)}${producer.sidecar.suffix}`;
}

/** Recognizes malformed candidate names too, so they cannot escape validation.
 * @param {string} path
 */
export function isRoadmapSidecarNamespace(path) {
  return path.startsWith(`${ROADMAP_SIDECAR_ROOT}/`) &&
    (path.slice(ROADMAP_SIDECAR_ROOT.length + 1).startsWith(PREFIX) || path.endsWith(SUFFIX));
}

/** Decode only the exact canonical mirror name; registration is a separate check.
 * @param {string} path
 * @returns {string | null}
 */
export function roadmapSourceLocator(path) {
  const prefix = `${ROADMAP_SIDECAR_ROOT}/${PREFIX}`;
  if (!path.startsWith(prefix) || !path.endsWith(SUFFIX)) return null;
  const encoded = path.slice(prefix.length, -SUFFIX.length);
  try {
    const source = decodeURIComponent(encoded);
    return isCanonicalSourceLocator(source) && encodeURIComponent(source) === encoded ? source : null;
  } catch { return null; }
}
