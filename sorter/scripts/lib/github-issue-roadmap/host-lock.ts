import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HostRepositoryLock {
  readonly path: string;
  readonly port: number;
  readonly release: () => void;
  readonly retain: () => void;
}

function repositoryIdentity(repository: string): string {
  if (!/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(repository)) throw new Error("Repository must be OWNER/REPO.");
  return repository.toLowerCase();
}

export function defaultHostRoadmapControlRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return process.platform === "win32"
    ? join(environment.LOCALAPPDATA ?? homedir(), "WorkflowTools", "github-issue-roadmap")
    : join(environment.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "example-repo", "github-issue-roadmap");
}

export function hostRepositoryLockPath(root: string | undefined, repository: string): string {
  const digest = createHash("sha256").update(repositoryIdentity(repository), "utf8").digest("hex");
  return join(resolve(root ?? defaultHostRoadmapControlRoot()), "locks", `${digest}.lock`);
}

/** Fixed protocol mapping: collisions deny admission; never probe or choose another port. */
export function hostRepositoryLockPort(repository: string): number {
  const digest = createHash("sha256").update(repositoryIdentity(repository), "utf8").digest();
  return 49152 + digest.readUInt32BE(0) % 16384;
}

export async function acquireHostRepositoryLock(input: {
  readonly root?: string; readonly repository: string; readonly owner: string; readonly now?: string;
  /** In-process test seam only; production callers omit this fixed-port override. */
  readonly hostLockPort?: number;
}): Promise<HostRepositoryLock> {
  const root = input.root ?? defaultHostRoadmapControlRoot();
  const path = hostRepositoryLockPath(root, input.repository);
  mkdirSync(join(resolve(root), "locks"), { recursive: true });
  const port = input.hostLockPort ?? hostRepositoryLockPort(input.repository);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Host lock port must be an integer between 1 and 65535.");
  // No response protocol exists: peers (including unrelated clients) cannot
  // authorize acquisition. Only the OS's successful exclusive listen can.
  const listener = createServer((socket) => socket.destroy());
  await new Promise<void>((accept, reject) => {
    listener.once("error", reject);
    listener.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      listener.removeListener("error", reject);
      accept();
    });
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      throw new Error(`Repository ${repositoryIdentity(input.repository)} is already locked or its endpoint 127.0.0.1:${port} is occupied by an unrelated listener; refusing admission without port fallback.`, { cause: error });
    }
    throw error;
  });
  try {
    // Permanent, atomically created barrier. Old wx clients cannot acquire it.
    // An empty directory is valid after a crash before the diagnostic record write.
    // A legacy file (even empty) might have a live owner: never migrate it online.
    try { mkdirSync(path, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!lstatSync(path).isDirectory()) throw new Error(`Legacy host lock requires offline migration with all old-style dispatchers stopped (${path}).`);
    }
    const record = { schemaVersion: "github-issue-roadmap-host-lock/v2", repository: repositoryIdentity(input.repository), owner: input.owner, acquiredAt: input.now ?? new Date().toISOString(), nonce: randomUUID(), port };
    writeFileSync(join(path, "owner.json"), `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    listener.close();
    throw error;
  }
  let closed = false;
  // Both methods are terminal: callers must have finished all dispatch-capable
  // execution. Retained outcome evidence belongs to the ledger, not the listener.
  // Never unlink or edit shared paths on release, even after another acquisition.
  const close = () => { if (!closed) { closed = true; listener.close(); } };
  return {
    path,
    port,
    release: close,
    retain: close,
  };
}
