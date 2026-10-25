import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { renderJudgementMaterial } from "./lib/github-issue-roadmap/judgement-material";

const ARGUMENT = /^--observation-id=(.+)$/;

function parseObservationId(argv: readonly string[]): string {
  if (argv.length !== 1) {
    throw new Error("Exactly one --observation-id=<sha256> argument is required.");
  }
  const match = ARGUMENT.exec(argv[0]);
  if (match === null) throw new Error(`Unsupported argument: ${argv[0]}`);
  return match[1];
}

export function runJudgeMaterialCli(input: {
  readonly argv: readonly string[];
  readonly cwd: string;
}): string {
  return renderJudgementMaterial({
    repoRoot: resolve(input.cwd),
    observationId: parseObservationId(input.argv),
  });
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    process.stdout.write(runJudgeMaterialCli({ argv: process.argv.slice(2), cwd: process.cwd() }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
