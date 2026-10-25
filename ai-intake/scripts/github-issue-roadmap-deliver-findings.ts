import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runCredentialCleanGit } from "./lib/github-issue-roadmap/credential-clean-git";
import { dispositionHistory, dispositionHistoryRef, effectiveOutcomeCandidates } from "./lib/github-issue-roadmap/disposition-history";
import {
  assertDeliveryInboxOutsideWorktrees, assertDeliverySources, deliveryEnvelope, deliveryEnvelopeHash,
  deliverySidecars, DELIVERY_SCHEMA, localDeliveryGit, readDeliveryBlob, readFindingDelivery, unreadableDeliveryIdentity,
  verifyFindingDelivery, writeFindingDelivery,
  type DeliveryGit, type FindingDelivery,
} from "./lib/github-issue-roadmap/finding-delivery";
import { foldRepository } from "./lib/github-issue-roadmap/intake-execution-journal";

function argumentsMap(argv: readonly string[]) {
  let repository: string | undefined;
  let dryRun = false;
  const refs: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("--repository=") && repository === undefined) repository = arg.slice(13);
    else if (arg.startsWith("--ref=") && arg.length > 6 && !arg.slice(6).startsWith("-")) refs.push(arg.slice(6));
    else if (arg === "--dry-run" && !dryRun) dryRun = true;
    else throw new Error(`Unsupported or duplicate argument: ${arg}`);
  }
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository ?? "")) {
    throw new Error("deliver-findings requires --repository=Owner/repo [--ref=REF ...] [--dry-run].");
  }
  return { repository: foldRepository(repository!), refs: [...new Set(refs)], dryRun };
}

export interface DeliveryScanEntry {
  readonly path: string;
  readonly envelopeSha256: string;
  readonly commit: string;
  readonly action: "delivered" | "would-deliver" | "already-seen" | "on-origin-main" | "reverified" | "dispositioned";
  readonly skippedOutcomeIds?: readonly string[];
  readonly verification?: FindingDelivery["verification"];
}

/** Local branches and tags by default; explicit refs replace that scope. Scan tips
 * first, then every sidecar-changing commit reachable from those tips, including
 * merged history and sidecars subsequently removed. No queue or journal state is
 * consulted. Only verified observations or identical current origin/main envelopes
 * suppress delivery; readable refusals are re-verified without rewriting records. */
export function runDeliverFindingsCli(input: {
  readonly argv: readonly string[];
  readonly repoRoot?: string;
  readonly runGit?: DeliveryGit;
  readonly log?: (line: string) => void;
}) {
  const started = Date.now();
  const args = argumentsMap(input.argv);
  const root = resolve(input.repoRoot ?? process.cwd());
  const log = input.log ?? console.log;
  let gitCommands = 0;
  const git: DeliveryGit = localDeliveryGit((cwd, command, options) => {
    gitCommands += 1;
    return (input.runGit ?? runCredentialCleanGit)(cwd, command, options);
  });
  const originMain = dispositionHistoryRef("origin/main", { repoRoot: root, runGit: git });
  const history = dispositionHistory(originMain, { repoRoot: root, runGit: git });
  const inbox = assertDeliveryInboxOutsideWorktrees(root, args.repository, git);
  const diagnostics: string[] = [];
  const names = args.refs.length > 0 ? args.refs : git(root, ["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/tags/"]).split(/\r?\n/).filter(Boolean);
  const refs: { ref: string; tip: string }[] = [];
  for (const name of [...new Set(names)].sort()) {
    try {
      const ref = git(root, ["rev-parse", "--symbolic-full-name", "--verify", "--end-of-options", name]);
      if (!/^refs\/(heads|tags|remotes)\/.+/.test(ref)) throw new Error("Must name a retained ref.");
      const tip = git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
      if (!refs.some((entry) => entry.ref === ref)) refs.push({ ref, tip });
    } catch (error) {
      const diagnostic = `delivery_ref_invalid: ${name}: ${error instanceof Error ? error.message : String(error)}`;
      if (args.refs.length > 0) throw new Error(diagnostic, { cause: error });
      diagnostics.push(diagnostic);
    }
  }
  const commits = new Map<string, typeof refs[number]>();
  for (const ref of refs) commits.set(ref.tip, ref);
  const refsByTip = new Map(refs.map((ref) => [ref.tip, ref]));
  if (refs.length > 0) {
    // One shared history walk, not one walk per branch. %S identifies the pinned
    // input tip through which Git reached each historical commit.
    for (const line of git(root, ["log", "--source", "--full-history", "--topo-order", "--format=%H%x09%S", ...refsByTip.keys(), "--",
      ":(glob)artifacts/github-issue-roadmap/**/outcome-candidate--*",
      ":(glob)artifacts/github-issue-roadmap/**/*.roadmap-outcomes.json",
    ]).split(/\r?\n/).filter(Boolean)) {
      const [commit, tip] = line.split("\t");
      const ref = refsByTip.get(tip);
      if (ref === undefined) throw new Error(`delivery_history_source_unknown: ${line}`);
      if (!commits.has(commit)) commits.set(commit, ref);
    }
  }
  const bytesByBlob = new Map<string, Buffer>();
  const read = (oid: string) => {
    let bytes = bytesByBlob.get(oid);
    if (bytes === undefined) { bytes = readDeliveryBlob(root, oid, git); bytesByBlob.set(oid, bytes); }
    return bytes;
  };
  const onMain = new Set<string>();
  {
    for (const sidecar of deliverySidecars(root, originMain, git)) {
      try {
        const bytes = read(sidecar.oid);
        deliveryEnvelope(bytes, sidecar.locator, args.repository);
        if (["100644", "100755"].includes(sidecar.mode)) onMain.add(deliveryEnvelopeHash(bytes));
      } catch (error) {
        // An invalid main sidecar is never evidence that a finding was seen.
        diagnostics.push(`origin_main_sidecar_invalid: ${sidecar.locator}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const seen = new Set<string>();
  const entries: DeliveryScanEntry[] = [];
  for (const [commit, discoveredFrom] of commits) {
    for (const sidecar of deliverySidecars(root, commit, git)) {
      let bytes: Buffer = Buffer.alloc(0);
      let envelopeSha256: string;
      let unreadableReason: string | undefined;
      try {
        // Preserve available blob bytes even for a refused symlink; this reads
        // the Git object itself and never follows its target in the filesystem.
        if (["100644", "100755", "120000"].includes(sidecar.mode)) bytes = read(sidecar.oid);
        if (!["100644", "100755"].includes(sidecar.mode)) throw new Error(`delivery_sidecar_not_regular: mode ${sidecar.mode}.`);
        envelopeSha256 = deliveryEnvelopeHash(bytes);
      }
      catch (error) {
        unreadableReason = `delivery_envelope_unreadable: ${commit}:${sidecar.locator}: ${error instanceof Error ? error.message : String(error)}`;
        diagnostics.push(unreadableReason);
        envelopeSha256 = unreadableDeliveryIdentity(commit, sidecar);
      }
      if (seen.has(envelopeSha256)) continue;
      seen.add(envelopeSha256);
      const path = join(inbox, `${envelopeSha256}.json`);
      let effective: ReturnType<typeof effectiveOutcomeCandidates> | undefined;
      if (unreadableReason === undefined) {
        try { effective = effectiveOutcomeCandidates(deliveryEnvelope(bytes, sidecar.locator, args.repository), history); }
        catch { /* Preserve invalid envelopes as ordinary refused delivery observations below. */ }
      }
      const base = { path, envelopeSha256, commit,
        ...(effective?.dispositioned.length ? { skippedOutcomeIds: effective.dispositioned.map(candidate => candidate.stableOutcomeId) } : {}) };
      if (effective !== undefined && effective.active.length === 0 && effective.dispositioned.length > 0) {
        entries.push({ ...base, action: "dispositioned" });
        continue;
      }
      if (existsSync(path)) {
        const prior = readFindingDelivery(path, args.repository);
        if (prior.verification.deliverable || unreadableReason !== undefined) {
          entries.push({ ...base, commit: prior.commit, action: "already-seen", verification: prior.verification });
          continue;
        }
        let verification: FindingDelivery["verification"];
        try { verifyFindingDelivery(root, prior, git, history); verification = { deliverable: true }; }
        catch (error) { verification = { deliverable: false, reason: error instanceof Error ? error.message : String(error) }; }
        diagnostics.push(`delivery_reverified: ${path}: current deliverable=${verification.deliverable}; immutable prior refusal retained.`);
        entries.push({ ...base, commit: prior.commit, action: "reverified", verification });
        continue;
      }
      if (onMain.has(envelopeSha256)) { entries.push({ ...base, action: "on-origin-main" }); continue; }
      let verification: FindingDelivery["verification"];
      try {
        if (unreadableReason !== undefined) throw new Error(unreadableReason);
        const envelope = deliveryEnvelope(bytes, sidecar.locator, args.repository);
        assertDeliverySources(root, { ...envelope, candidates: effectiveOutcomeCandidates(envelope, history).active }, commit, git);
        verification = { deliverable: true };
      } catch (error) {
        verification = { deliverable: false, reason: error instanceof Error ? error.message : String(error) };
      }
      const record: FindingDelivery = {
        schemaVersion: DELIVERY_SCHEMA, repository: args.repository, envelopeSha256,
        envelopeBase64: bytes.toString("base64"), commit, sidecarLocator: sidecar.locator,
        sidecarBlob: sidecar.oid, sidecarMode: sidecar.mode, discoveredFrom, verification,
      };
      const created = args.dryRun ? false : writeFindingDelivery(record).created;
      const observed = args.dryRun || created ? record : readFindingDelivery(path, args.repository);
      entries.push({ ...base, commit: observed.commit,
        action: args.dryRun ? "would-deliver" : created ? "delivered" : "already-seen", verification: observed.verification });
    }
  }
  for (const entry of entries) log(JSON.stringify(entry));
  for (const diagnostic of diagnostics) log(diagnostic);
  const stats = { refs: refs.length, commits: commits.size, blobs: bytesByBlob.size, gitCommands, elapsedMs: Date.now() - started };
  log(JSON.stringify({ inbox, originMain, ...stats }));
  return { inbox, originMain, entries, diagnostics, stats };
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runDeliverFindingsCli({ argv: process.argv.slice(2) });
    if (result.diagnostics.length > 0 || result.entries.some((entry) => entry.verification?.deliverable === false)) process.exitCode = 1;
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
