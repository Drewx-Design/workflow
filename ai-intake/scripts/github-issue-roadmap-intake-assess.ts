import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evaluateIntakeAssessmentBundle,
  type IntakeAssessmentModelCaller,
} from "./lib/github-issue-roadmap/intake-assessment-evaluator";

interface IntakeAssessCliInput {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly caller?: IntakeAssessmentModelCaller;
}

function handoffArgument(argv: readonly string[]): string {
  if (argv.length !== 1 || !argv[0].startsWith("--handoff=") || argv[0].length === "--handoff=".length) {
    throw new Error("Roadmap intake assessment requires exactly one --handoff=PATH argument.");
  }
  return argv[0].slice("--handoff=".length);
}

export async function runIntakeAssessCli(input: IntakeAssessCliInput): Promise<string> {
  const cwd = resolve(input.cwd ?? process.cwd());
  const result = await evaluateIntakeAssessmentBundle({
    handoffPath: resolve(cwd, handoffArgument(input.argv)),
    caller: input.caller,
  });
  return [
    `Assessment written: ${result.assessmentTarget}`,
    `Provider: ${result.assessment.stack.provider}`,
    `Model: ${result.assessment.stack.model}`,
    `Candidates assessed: ${result.assessment.candidates.length}`,
  ].join("\n");
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  void runIntakeAssessCli({ argv: process.argv.slice(2) })
    .then((message) => console.log(message))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
