import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { dispositionHistory } from "./lib/github-issue-roadmap/disposition-history";

import {
  authorOperatorAssessmentRequestBundle,
  type AuthoredOperatorAssessmentRequestBundle,
} from "./lib/github-issue-roadmap/operator-assessment-request-bundle";

interface OperatorAssessmentRequestCliDependencies {
  readonly now: () => Date;
  readonly gitHead: (repoRoot: string) => string;
  readonly gitCommonDir: (repoRoot: string) => string;
  readonly author: typeof authorOperatorAssessmentRequestBundle;
}

interface OperatorAssessmentRequestCliInput {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly dependencies?: OperatorAssessmentRequestCliDependencies;
}

function gitValue(repoRoot: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  }).trim();
}

function defaultDependencies(): OperatorAssessmentRequestCliDependencies {
  return {
    now: () => new Date(),
    gitHead: (repoRoot) => gitValue(repoRoot, ["rev-parse", "HEAD"]),
    gitCommonDir: (repoRoot) => gitValue(repoRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    author: authorOperatorAssessmentRequestBundle,
  };
}

function argumentValues(argv: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const supported = new Set([
    "candidate",
    "intake-snapshot",
    "exchange-root",
    "run-discriminator",
    "deadline-minutes",
    "prompt",
    "stack",
    "assessment-schema",
  ]);
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.+)$/.exec(argument);
    if (match === null || !supported.has(match[1]) || values.has(match[1])) {
      throw new Error(`Unsupported or duplicate argument: ${argument}`);
    }
    values.set(match[1], match[2]);
  }
  for (const required of ["candidate", "intake-snapshot", "exchange-root"]) {
    if (!values.has(required)) throw new Error(`Operator assessment request requires --${required}=PATH.`);
  }
  return values;
}

function repoLocator(repoRoot: string, value: string, context: string): string {
  const absolute = resolve(repoRoot, value);
  const fromRoot = relative(repoRoot, absolute);
  if (fromRoot === "" || isAbsolute(fromRoot) || fromRoot === ".." || fromRoot.startsWith(`..\\`) ||
      fromRoot.startsWith("../")) {
    throw new Error(`${context} must resolve to a file inside the repository.`);
  }
  return fromRoot.split("\\").join("/");
}

function deadlineMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("--deadline-minutes must be a positive integer.");
  const milliseconds = Number(value) * 60 * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds > 60 * 60 * 1000) {
    throw new Error("--deadline-minutes must not exceed 60.");
  }
  return milliseconds;
}

function output(result: AuthoredOperatorAssessmentRequestBundle): string {
  const lines = [
    `Operator assessment run: ${result.runId}`,
    `Exchange root: ${result.handoff.exchangeRoot}`,
    `Bundle: ${result.bundlePath}`,
    `Operator handoff: ${result.operatorHandoffPath}`,
    `Assessment target: ${result.handoff.assessmentTarget}`,
  ];
  for (const [role, path] of Object.entries(result.handoff.files)) lines.push(`${role}: ${path}`);
  lines.push(
    `npm run roadmap:shadow-evaluator -- next --exchange-root=${JSON.stringify(result.handoff.exchangeRoot)} --expected-run-id=${result.runId}`,
  );
  return lines.join("\n");
}

export function runOperatorAssessmentRequestCli(input: OperatorAssessmentRequestCliInput): string {
  const values = argumentValues(input.argv);
  const repoRoot = resolve(input.cwd ?? process.cwd());
  const dependencies = input.dependencies ?? defaultDependencies();
  const optionalLocator = (name: "prompt" | "stack" | "assessment-schema", context: string) => {
    const value = values.get(name);
    return value === undefined ? undefined : repoLocator(repoRoot, value, context);
  };
  const result = dependencies.author({
    dispositionHistory,
    repoRoot,
    exchangeRoot: resolve(repoRoot, values.get("exchange-root")!),
    scheduledExchangeRoot: resolve(dirname(dependencies.gitCommonDir(repoRoot)), ".worktrees", ".roadmap-shadow-exchange"),
    candidateLocator: repoLocator(repoRoot, values.get("candidate")!, "Candidate sidecar"),
    intakeSnapshotLocator: repoLocator(repoRoot, values.get("intake-snapshot")!, "Intake snapshot"),
    trustedMainSha: dependencies.gitHead(repoRoot),
    now: dependencies.now(),
    runDiscriminator: values.get("run-discriminator"),
    deadlineMs: deadlineMilliseconds(values.get("deadline-minutes")),
    promptLocator: optionalLocator("prompt", "Assessment prompt"),
    stackLocator: optionalLocator("stack", "Assessment stack"),
    assessmentSchemaLocator: optionalLocator("assessment-schema", "Assessment schema"),
  });
  return output(result);
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(runOperatorAssessmentRequestCli({ argv: process.argv.slice(2) }));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
