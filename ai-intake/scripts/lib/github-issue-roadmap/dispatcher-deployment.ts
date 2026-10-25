import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export const DISPATCHER_DEPLOYMENT_SCHEMA = "github-issue-roadmap-dispatcher-deployment/v1" as const;
export interface DispatcherGitEvidence { readonly head: () => string; readonly isClean: () => boolean; readonly isReviewed: (commit: string) => boolean; readonly isMerged: (commit: string) => boolean }
export interface VerifiedDispatcherDeployment { readonly repository: string; readonly commit: string; readonly dispatcherSha256: string; readonly capabilityManifestSha256: string; readonly activatedAt: string }

function fileSha256(path: string): string { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
export { fileSha256 as dispatcherFileSha256 };

function assertExternalPath(workspaceRoot: string, recordPath: string): void {
  const root = realpathSync(resolve(workspaceRoot));
  const resolvedRecord = resolve(recordPath);
  const target = join(realpathSync(dirname(resolvedRecord)), basename(resolvedRecord));
  const fromRoot = relative(root, target);
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) throw new Error("Dispatcher deployment record must be external to the writable workspace.");
}

export function verifyDispatcherDeployment(input: {
  readonly workspaceRoot: string; readonly externalRecordPath: string; readonly repository: string;
  readonly dispatcherPath: string; readonly manifestPath: string; readonly git: DispatcherGitEvidence;
}): VerifiedDispatcherDeployment {
  assertExternalPath(input.workspaceRoot, input.externalRecordPath);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(input.externalRecordPath, "utf8")); } catch { throw new Error("Operator-approved external deployment record is missing or corrupt."); }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("External deployment record is corrupt.");
  const record = raw as Record<string, unknown>;
  const expected = ["schemaVersion", "status", "repository", "commit", "reviewed", "merged", "activatedAt", "revokedAt", "dispatcherSha256", "capabilityManifestSha256"].sort();
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(expected) || record.schemaVersion !== DISPATCHER_DEPLOYMENT_SCHEMA) throw new Error("External deployment record has an invalid closed schema.");
  if (record.status !== "active" || record.revokedAt !== null) throw new Error("External deployment record is missing, inactive, or revoked.");
  if (record.repository !== input.repository) throw new Error("External deployment record belongs to another repository.");
  if (record.reviewed !== true || record.merged !== true || typeof record.commit !== "string" || !/^[0-9a-f]{40,64}$/.test(record.commit)) throw new Error("External deployment record does not identify a reviewed merged commit.");
  if (!input.git.isClean()) throw new Error("Dispatcher credential release requires a clean workspace.");
  const head = input.git.head();
  if (head !== record.commit || !input.git.isReviewed(head) || !input.git.isMerged(head)) throw new Error("Current commit is not the exact reviewed and merged deployment commit.");
  const dispatcherSha256 = fileSha256(input.dispatcherPath);
  const capabilityManifestSha256 = fileSha256(input.manifestPath);
  if (dispatcherSha256 !== record.dispatcherSha256) throw new Error("Dispatcher file hash drifted from the external deployment record.");
  if (capabilityManifestSha256 !== record.capabilityManifestSha256) throw new Error("Capability manifest hash drifted from the external deployment record.");
  if (typeof record.activatedAt !== "string" || !Number.isFinite(Date.parse(record.activatedAt))) throw new Error("External deployment activation time is invalid.");
  return { repository: input.repository, commit: head, dispatcherSha256, capabilityManifestSha256, activatedAt: record.activatedAt };
}

export function releaseDispatcherCredential(input: { readonly deployment: VerifiedDispatcherDeployment; readonly load: () => string | undefined; readonly expectedFingerprint: string }): string {
  const credential = input.load();
  if (!credential) throw new Error("Dispatcher mutation credential is unavailable.");
  const fingerprint = createHash("sha256").update(credential, "utf8").digest("hex");
  if (fingerprint !== input.expectedFingerprint) throw new Error("Dispatcher mutation credential fingerprint is not approved.");
  return credential;
}
