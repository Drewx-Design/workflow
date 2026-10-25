import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runShadowPublicationValidatorCli } from "./github-issue-roadmap-shadow-validate";
import { createShadowPrivateDirectoryPolicy } from "./lib/github-issue-roadmap/windows-private-directory-acl";

export {
  createWindowsPrivateDirectoryAclController,
  type WindowsAclCommand,
  type WindowsAclCommandRunner,
} from "./lib/github-issue-roadmap/windows-private-directory-acl";

function runShadowPublicationValidatorCommand(argv: readonly string[]): string {
  return runShadowPublicationValidatorCli(
    argv,
    process.cwd(),
    createShadowPrivateDirectoryPolicy(process.platform),
  );
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === resolve(fileURLToPath(import.meta.url))) {
  try {
    console.log(runShadowPublicationValidatorCommand(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
