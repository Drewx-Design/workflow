// These filesystem fixtures are not Git repositories. Model a committed, clean
// admission input set; individual tree-contract tests override the Git responses.
export function cleanAdmissionGit(_cwd: string, args: readonly string[]): string {
  if (args.includes("rev-parse") && args.includes("HEAD^{commit}")) return "a".repeat(40);
  if (args.includes("status") || args.includes("ls-files")) return "";
  throw new Error(`Unexpected admission Git command: ${args.join(" ")}`);
}

// The fault suites also invoke the real CLI in a child; keep its Git fixture at
// the subprocess boundary without changing any filesystem fault or assertion.
export const admissionGitPreload = `
const admissionChildProcess = require('node:child_process');
const admissionExecFileSync = admissionChildProcess.execFileSync;
admissionChildProcess.execFileSync = function(command, args, ...rest) {
  if (command === 'git') {
    if (args.includes('rev-parse') && args.includes('HEAD^{commit}')) return 'a'.repeat(40);
    if (args.includes('status') || args.includes('ls-files')) return '';
  }
  return admissionExecFileSync.call(this, command, args, ...rest);
};
`;
