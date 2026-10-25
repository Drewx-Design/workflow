import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import registry from "../../github-issue-roadmap-producers.json";
import { resolveRoadmapArtifactRealPath } from "./artifact-io";
import { canonicalJsonSha256, prettyCanonicalJson } from "./canonical-json";
import { runCredentialCleanGit } from "./credential-clean-git";
import { dispositionHistory, effectiveOutcomeCandidates, type DispositionHistory } from "./disposition-history";
import { foldRepository, resolveJournalPath } from "./intake-execution-journal";
import { assertAutomaticIntakeEnvelopeBudgets, outcomeSourceContentMatchesSha256, parseOutcomeEnvelope, validateSafeSourceLocator, type OutcomeEnvelope } from "./outcome-candidate";
import { isRoadmapSidecarNamespace, producerFor, roadmapSidecarLocator } from "./producer-paths.mjs";

export type DeliveryGit = typeof runCredentialCleanGit;
export const DELIVERY_SCHEMA = "github-issue-roadmap-finding-delivery/v1";
const OID = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

/** Delivery cannot lazy-fetch from a partial clone or substitute replacement
 * objects. Scope those restrictions to delivery; legacy HEAD callers keep their
 * existing Git behavior. This delegates every operation to the sole Git runner. */
export function localDeliveryGit(git: DeliveryGit): DeliveryGit {
  return (cwd, args, options) => git(cwd, args, { ...options, localObjectsOnly: true });
}

/** An immutable observation, never a filing ledger. No disposition, retry or
 * ownership fields belong here. A commit ID is stable but does NOT retain objects. */
export interface FindingDelivery {
  readonly schemaVersion: typeof DELIVERY_SCHEMA;
  readonly repository: string;
  readonly envelopeSha256: string;
  readonly envelopeBase64: string;
  readonly commit: string;
  readonly sidecarLocator: string;
  readonly sidecarBlob: string;
  readonly sidecarMode?: string;
  readonly discoveredFrom: { readonly ref: string; readonly tip: string };
  readonly verification: { readonly deliverable: true } | { readonly deliverable: false; readonly reason: string };
}

/** Internal: the module's own callers resolve the inbox; production reaches it
 * through assertDeliveryInboxOutsideWorktrees. */
function deliveryInboxPath(repository: string): string {
  return join(dirname(resolveJournalPath(repository)), "finding-inbox");
}

/** Resolve the configured root, but never resolve away aliases in the repository
 * segment or inbox itself: those names bind the inbox to this repository. */
function canonicalDeliveryInbox(repository: string): string {
  const logical = resolve(deliveryInboxPath(repository));
  const expected = join(resolveRoadmapArtifactRealPath(dirname(dirname(logical))), basename(dirname(logical)), "finding-inbox");
  if (relative(expected, resolveRoadmapArtifactRealPath(logical)) !== "") {
    throw new Error("delivery_inbox_alias: inbox must live in this repository's journal directory.");
  }
  return expected;
}

/** Also rejects an override (or symlinked override) inside another linked worktree. */
export function assertDeliveryInboxOutsideWorktrees(repoRoot: string, repository: string, git: DeliveryGit): string {
  const inbox = canonicalDeliveryInbox(repository);
  // An absolute override could also point into an unrelated repository, which
  // would not appear in this repository's linked-worktree inventory.
  let existing = inbox;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  let insideWorktree = false;
  for (;;) {
    try { insideWorktree = git(existing, ["rev-parse", "--is-inside-work-tree"]) === "true"; break; }
    catch (error) {
      // An ordinary .git text file is not a repository; ask Git about its parent
      // as well so that file cannot hide an enclosing worktree.
      const stderr = String((error as { stderr?: unknown }).stderr);
      if (/invalid gitfile format:/i.test(stderr) && dirname(existing) !== existing) {
        existing = dirname(existing);
        continue;
      }
      if (!/not a git repository/i.test(stderr)) throw error;
      break;
    }
  }
  if (insideWorktree) {
    throw new Error("delivery_inbox_inside_worktree: choose an external ROADMAP_INTAKE_JOURNAL_ROOT.");
  }
  const output = git(repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  for (const field of output.split("\0")) {
    if (!field.startsWith("worktree ")) continue;
    const root = resolveRoadmapArtifactRealPath(resolve(field.slice(9)));
    const path = relative(root, inbox);
    if (path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))) {
      throw new Error("delivery_inbox_inside_worktree: choose an external ROADMAP_INTAKE_JOURNAL_ROOT.");
    }
  }
  return inbox;
}

export function deliveryEnvelope(bytes: Buffer, locator: string, repository: string): OutcomeEnvelope {
  const raw: unknown = JSON.parse(bytes.toString("utf8"));
  assertAutomaticIntakeEnvelopeBudgets(raw);
  let envelope: OutcomeEnvelope;
  try { envelope = parseOutcomeEnvelope(raw); }
  catch (error) {
    throw new Error(`delivery_envelope_invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (foldRepository(`${envelope.repository.organization}/${envelope.repository.name}`) !== foldRepository(repository)) {
    throw new Error("delivery_repository_mismatch: envelope belongs to another repository.");
  }
  const producer = producerFor(envelope.artifact.sourceLocator, registry.producers);
  if (producer === null || producer.kind !== envelope.producer.kind || roadmapSidecarLocator(producer, envelope.artifact.sourceLocator) !== locator) {
    throw new Error("delivery_unregistered_sidecar: source and sidecar must match the active producer registry.");
  }
  return envelope;
}

export function deliveryEnvelopeHash(bytes: Buffer): string {
  return canonicalJsonSha256(JSON.parse(bytes.toString("utf8")));
}

export interface DeliveryTreeBlob { readonly mode: string; readonly oid: string; readonly locator: string }

/** A disjoint namespace from canonical envelope hashes, stable even without bytes. */
export function unreadableDeliveryIdentity(commit: string, entry: DeliveryTreeBlob): string {
  return `unreadable-${canonicalJsonSha256({ commit, locator: entry.locator, oid: entry.oid, mode: entry.mode })}`;
}

export function deliverySidecars(repoRoot: string, commit: string, git: DeliveryGit): DeliveryTreeBlob[] {
  return git(repoRoot, ["ls-tree", "-r", "-t", "-z", "--full-tree", commit, "--", "artifacts/github-issue-roadmap"])
    .split("\0").filter(Boolean).flatMap((line) => {
      const match = /^(\d+) \S+ ([a-f0-9]+)\t([\s\S]*)$/.exec(line);
      return match !== null && isRoadmapSidecarNamespace(match[3])
        ? [{ mode: match[1], oid: match[2], locator: match[3] }] : [];
    });
}

export function readDeliveryBlob(repoRoot: string, oid: string, git: DeliveryGit): Buffer {
  if (!OID.test(oid)) throw new Error("delivery_object_invalid: expected a full object ID.");
  return Buffer.from(git(repoRoot, ["cat-file", "blob", oid], { output: "base64", localObjectsOnly: true }), "base64");
}

/** Git object reads only: never resolve a citation in the current filesystem,
 * follow a symlink, run a clean filter, or fall back to HEAD. */
export function assertDeliverySources(repoRoot: string, envelope: OutcomeEnvelope, commit: string, git: DeliveryGit): string {
  if (!OID.test(commit)) throw new Error("delivery_commit_invalid: expected a full commit ID.");
  try {
    if (git(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`]) !== commit) throw new Error("Not the named commit.");
  } catch (error) {
    throw new Error(`delivery_commit_unavailable: ${commit}; retain the source ref or restore its objects.`, { cause: error });
  }
  const citations = envelope.candidates.flatMap((candidate) => [...candidate.evidence, ...candidate.provenance]);
  const locators = new Set([envelope.artifact.sourceLocator, ...citations.map((citation) => citation.sourceLocator)]);
  for (const locator of locators) {
    try { validateSafeSourceLocator(locator); }
    catch (error) { throw new Error(`delivery_source_locator_unsafe: ${locator}`, { cause: error }); }
    let oid: string;
    try {
      const entry = git(repoRoot, ["ls-tree", "-z", commit, "--", locator]);
      const match = /^(100644|100755) blob ([a-f0-9]+)\t([^\0]+)\0$/.exec(entry);
      if (match === null || match[3] !== locator) throw new Error("Not a regular committed blob.");
      oid = match[2];
    } catch (error) {
      throw new Error(`delivery_source_missing: ${locator} is not a regular blob at ${commit}.`, { cause: error });
    }
    let bytes: Buffer;
    try { bytes = readDeliveryBlob(repoRoot, oid, git); }
    catch (error) { throw new Error(`delivery_source_missing: ${locator} at ${commit}.`, { cause: error }); }
    if (citations.some((citation) => citation.sourceLocator === locator && !outcomeSourceContentMatchesSha256(bytes, citation.contentSha256))) {
      throw new Error(`delivery_source_hash_mismatch: ${locator} at ${commit}.`);
    }
  }
  return commit;
}

/** Read by identity from the shared inbox, not an arbitrary candidate file. */
export function readFindingDelivery(path: string, repository: string): FindingDelivery {
  const inbox = canonicalDeliveryInbox(repository);
  const actualPath = resolveRoadmapArtifactRealPath(resolve(path));
  const record = JSON.parse(readFileSync(actualPath, "utf8")) as FindingDelivery;
  if (record?.schemaVersion !== DELIVERY_SCHEMA || record.repository !== foldRepository(repository) ||
      !/^(?:unreadable-)?[a-f0-9]{64}$/.test(record.envelopeSha256) || !OID.test(record.commit) || !OID.test(record.sidecarBlob) ||
      typeof record.sidecarLocator !== "string" || typeof record.envelopeBase64 !== "string" ||
      typeof record.verification?.deliverable !== "boolean" ||
      (!record.verification.deliverable && typeof record.verification.reason !== "string") ||
      relative(join(inbox, `${record.envelopeSha256}.json`), actualPath) !== "") {
    throw new Error("delivery_record_invalid: expected a record in this repository's inbox.");
  }
  const bytes = Buffer.from(record.envelopeBase64, "base64");
  const unreadable = record.envelopeSha256.startsWith("unreadable-");
  if (bytes.toString("base64") !== record.envelopeBase64 || (unreadable
    ? record.verification.deliverable || typeof record.sidecarMode !== "string" ||
      unreadableDeliveryIdentity(record.commit, { locator: record.sidecarLocator, oid: record.sidecarBlob, mode: record.sidecarMode }) !== record.envelopeSha256
    : deliveryEnvelopeHash(bytes) !== record.envelopeSha256)) {
    throw new Error("delivery_record_invalid: envelope identity does not match its bytes.");
  }
  return record;
}

export function verifyFindingDelivery(repoRoot: string, record: FindingDelivery, git: DeliveryGit,
  history: DispositionHistory = dispositionHistory("origin/main", { repoRoot, runGit: git })): OutcomeEnvelope {
  if (record.envelopeSha256.startsWith("unreadable-")) {
    throw new Error(`delivery_undeliverable: ${record.verification.deliverable ? "delivery_record_invalid" : record.verification.reason}`);
  }
  // A readable refusal is an immutable observation, not permanent suppression.
  // Both a rescan and the filer check the pinned evidence again, without rewriting it.
  try { return verifyReadableFindingDelivery(repoRoot, record, git, history); }
  catch (error) {
    if (record.verification.deliverable) throw error;
    throw new Error(`delivery_undeliverable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function verifyReadableFindingDelivery(repoRoot: string, record: FindingDelivery, git: DeliveryGit, history: DispositionHistory): OutcomeEnvelope {
  const bytes = Buffer.from(record.envelopeBase64, "base64");
  const envelope = deliveryEnvelope(bytes, record.sidecarLocator, record.repository);
  const { active } = effectiveOutcomeCandidates(envelope, history);
  if (active.length > 0) assertDeliverySources(repoRoot, { ...envelope, candidates: active }, record.commit, git);
  const sidecar = deliverySidecars(repoRoot, record.commit, git).find((entry) => entry.locator === record.sidecarLocator);
  if (sidecar === undefined || !["100644", "100755"].includes(sidecar.mode) || sidecar.oid !== record.sidecarBlob ||
      !readDeliveryBlob(repoRoot, sidecar.oid, git).equals(bytes)) {
    throw new Error("delivery_sidecar_mismatch: inbox bytes must match the sidecar at the delivery commit.");
  }
  return envelope;
}

/** fsync the complete record before atomic, no-replace publication. A losing
 * concurrent delivery leaves the first immutable observation intact. */
export function writeFindingDelivery(record: FindingDelivery): { path: string; created: boolean } {
  const inbox = canonicalDeliveryInbox(record.repository);
  const path = join(inbox, `${record.envelopeSha256}.json`);
  if (existsSync(path)) { readFindingDelivery(path, record.repository); return { path, created: false }; }
  mkdirSync(inbox, { recursive: true });
  const temporary = join(inbox, `.${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, prettyCanonicalJson(record));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    linkSync(temporary, path);
    return { path, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    readFindingDelivery(path, record.repository);
    return { path, created: false };
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
