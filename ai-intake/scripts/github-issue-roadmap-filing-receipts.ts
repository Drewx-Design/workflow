import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertRoadmapArtifactOutputPath, writeRoadmapArtifactAtomically } from "./lib/github-issue-roadmap/artifact-io";
import { prettyCanonicalJson } from "./lib/github-issue-roadmap/canonical-json";
import { buildFilingFieldReceipts, parseFilingFieldReceipts } from "./lib/github-issue-roadmap/filing-field-receipts";
import { readJournal, resolveJournalPath } from "./lib/github-issue-roadmap/intake-execution-journal";

function run(argv: readonly string[]): void {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const match = /^--(repository|out)=(.+)$/.exec(arg);
    if (match === null) throw new Error(`Unsupported argument: ${arg}`);
    if (values.has(match[1])) throw new Error(`Duplicate --${match[1]} argument.`);
    values.set(match[1], match[2]);
  }
  const repository = values.get("repository");
  if (repository === undefined || !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository)) {
    throw new Error("Required --repository=OWNER/REPO must name one non-empty owner/repository pair.");
  }
  const out = values.get("out");
  const outputPath = out === undefined ? undefined : assertRoadmapArtifactOutputPath(out, process.cwd());
  const journal = readJournal(resolveJournalPath(repository));
  const result = buildFilingFieldReceipts(journal.records, { repository, generatedAt: new Date().toISOString() });
  const contents = prettyCanonicalJson(parseFilingFieldReceipts(result.document));
  if (outputPath === undefined) process.stdout.write(contents);
  else writeRoadmapArtifactAtomically(outputPath, contents);
  console.error(`skippedMalformed=${result.skippedMalformed} droppedConflicts=${result.droppedConflicts}`);
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
