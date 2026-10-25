import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

export type GitRunner = typeof runCredentialCleanGit;

/** Base64 output preserves exact blob bytes, including binary content and trailing
 * whitespace. The default text mode keeps the existing trimmed-output contract. */
export function runCredentialCleanGit(cwd: string, args: readonly string[], options?: {
  readonly output?: "base64";
  readonly localObjectsOnly?: boolean;
}): string {
  const output = execFileSync("git", [
    "-c", "credential.helper=",
    "-c", `safe.directory=${resolve(cwd)}`,
    ...args,
  ], {
    cwd,
    encoding: options?.output === "base64" ? "buffer" : "utf8",
    ...(options?.localObjectsOnly ? { maxBuffer: 64 * 1024 * 1024 } : {}),
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      NODE_ENV: "production",
      PATH: process.env.PATH,
      PATHEXT: process.env.PATHEXT,
      SYSTEMROOT: process.env.SYSTEMROOT,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...(options?.localObjectsOnly ? { GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" } : {}),
    },
  });
  return Buffer.isBuffer(output) ? output.toString("base64") : output.trim();
}
