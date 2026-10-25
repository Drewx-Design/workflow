import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRoadmapArtifactOutputPath, writeRoadmapArtifactAtomically } from "./lib/github-issue-roadmap/artifact-io";
import { prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import { buildOutcomeDispositions } from "./lib/github-issue-roadmap/outcome-dispositions";

function run(argv: readonly string[]): void {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--(ref|out)=(.+)$/.exec(arg);
    if (match === null) throw new Error(`Unsupported argument: ${arg}`);
    if (values.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    values.set(match[1], match[2]);
  }
  const ref = values.get("ref") ?? "HEAD";
  if (ref.startsWith("-")) throw new Error("The --ref argument must name a git ref, not an option.");
  const out = values.get("out");
  const outputPath = out === undefined ? undefined : assertRoadmapArtifactOutputPath(out, process.cwd());
  if (outputPath !== undefined) {
    const name = basename(outputPath).toLowerCase();
    if (name.endsWith(".roadmap-outcomes.json") || name.startsWith("outcome-candidate--")) {
      throw new Error("The --out path must not use a sidecar filename (*.roadmap-outcomes.json or outcome-candidate--*).");
    }
  }
  const result = buildOutcomeDispositions(ref);
  const contents = prettyCanonicalJson(result);
  if (outputPath === undefined) process.stdout.write(contents);
  else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeRoadmapArtifactAtomically(outputPath, contents);
  }
  console.error(`entries=${result.entries.length} unresolvedCandidates=${result.entries.filter(entry => !entry.candidateResolved).length}`
    + ` unresolvedTargets=${result.entries.filter(entry => entry.kind === "superseded" && !entry.targetResolved).length}`
    + ` conflictingOutcomes=${new Set(result.entries.filter(entry => entry.conflicting)
      .map(entry => `${entry.stableArtifactId}\0${entry.stableOutcomeId}`)).size}`);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    run(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
