import {
  PRODUCER_KINDS,
  type OutcomeCandidate,
  type OutcomeEnvelope,
  type ProducerKind,
  validateSafeSourceLocator,
  validateSha256,
  validateStableIdentifier,
} from "./outcome-candidate";

export const SOURCE_MARKER = "<!-- github-issue-roadmap-source:v1 -->";

const MARKER_KEYS = [
  "source-fingerprint",
  "emission-content-sha256",
  "producer-kind",
  "producer-version",
  "stable-artifact-id",
  "stable-outcome-id",
  "source-locator",
] as const;

export const SOURCE_MARKER_LINE_COUNT = MARKER_KEYS.length + 1;

export interface SourceMarkerV1 {
  readonly sourceFingerprint: string;
  readonly emissionContentSha256: string;
  readonly producerKind: ProducerKind;
  readonly producerVersion: string;
  readonly stableArtifactId: string;
  readonly stableOutcomeId: string;
  readonly sourceLocator: string;
}

function markerValue(value: string, context: string): string {
  if (value.trim() === "" || value !== value.trim() || /[\r\n]/.test(value)) {
    throw new Error(`${context} must be a single non-empty line.`);
  }
  return value;
}

export function renderSourceMarker(
  envelope: OutcomeEnvelope,
  candidate: OutcomeCandidate,
): string {
  const canonical = envelope.candidates.find((entry) =>
    entry.sourceFingerprint === candidate.sourceFingerprint &&
    entry.emissionContentSha256 === candidate.emissionContentSha256);
  if (canonical === undefined) throw new Error("The source marker candidate is not part of this envelope.");
  return [
    SOURCE_MARKER,
    `source-fingerprint: ${markerValue(candidate.sourceFingerprint, "source fingerprint")}`,
    `emission-content-sha256: ${markerValue(candidate.emissionContentSha256, "emission hash")}`,
    `producer-kind: ${envelope.producer.kind}`,
    `producer-version: ${markerValue(envelope.producer.version, "producer version")}`,
    `stable-artifact-id: ${markerValue(envelope.artifact.stableId, "stable artifact ID")}`,
    `stable-outcome-id: ${markerValue(candidate.stableOutcomeId, "stable outcome ID")}`,
    `source-locator: ${validateSafeSourceLocator(envelope.artifact.sourceLocator)}`,
  ].join("\n");
}

export function parseSourceMarker(raw: unknown): SourceMarkerV1 {
  if (typeof raw !== "string") throw new Error("Source marker must be text.");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  if (lines.length !== MARKER_KEYS.length + 1 || lines[0] !== SOURCE_MARKER) {
    throw new Error("Expected one exact github-issue-roadmap source marker v1 block.");
  }
  const values = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(": ");
    if (separator <= 0) throw new Error("Source marker fields must use exact key: value lines.");
    const key = line.slice(0, separator);
    const value = line.slice(separator + 2);
    if (!MARKER_KEYS.includes(key as typeof MARKER_KEYS[number]) || values.has(key)) {
      throw new Error("Source marker must contain exact unique v1 keys.");
    }
    values.set(key, markerValue(value, `Source marker field ${key}`));
  }
  if (MARKER_KEYS.some((key) => !values.has(key))) {
    throw new Error("Source marker must contain exact v1 keys.");
  }
  const producerKind = values.get("producer-kind") as string;
  if (!PRODUCER_KINDS.includes(producerKind as ProducerKind)) {
    throw new Error("Source marker producer kind is unsupported.");
  }
  return {
    sourceFingerprint: validateSha256(values.get("source-fingerprint"), "Source marker source fingerprint"),
    emissionContentSha256: validateSha256(
      values.get("emission-content-sha256"),
      "Source marker emission content SHA-256",
    ),
    producerKind: producerKind as ProducerKind,
    producerVersion: validateStableIdentifier(values.get("producer-version"), "Source marker producer version"),
    stableArtifactId: validateStableIdentifier(values.get("stable-artifact-id"), "Source marker stable artifact ID"),
    stableOutcomeId: validateStableIdentifier(values.get("stable-outcome-id"), "Source marker stable outcome ID"),
    sourceLocator: validateSafeSourceLocator(values.get("source-locator"), "Source marker source locator"),
  };
}
