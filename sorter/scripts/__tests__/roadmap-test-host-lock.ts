import { createServer } from "node:net";
import { acquireHostRepositoryLock, hostRepositoryLockPort } from "../lib/github-issue-roadmap/host-lock";
import { acquireStewardshipStore, readStewardshipLifecycleReceipts } from "../lib/github-issue-roadmap/stewardship-state";
import { runRoadmapSort } from "../github-issue-roadmap-sort";

const productionRepository = "example-org/example-repo";
// Vitest isolates this module per test file. Keep one port per normalized repository
// within that file so successive owners and exclusion tests exercise the same lock.
const ports = new Map<string, Promise<number>>();

export async function allocateTestHostLockPort(repository = productionRepository): Promise<number> {
  const excluded = new Set([hostRepositoryLockPort(repository), hostRepositoryLockPort(productionRepository)]);
  for (;;) {
    const listener = createServer();
    const port = await new Promise<number>((accept, reject) => {
      listener.once("error", reject);
      listener.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
        const address = listener.address();
        if (!address || typeof address === "string") { reject(new Error("Expected a TCP test endpoint")); return; }
        accept(address.port);
      });
    });
    await new Promise<void>((accept, reject) => listener.close((error) => error ? reject(error) : accept()));
    if (!excluded.has(port)) return port;
  }
}

export function testHostLockPort(repository = productionRepository): Promise<number> {
  const identity = repository.toLowerCase();
  if (!ports.has(identity)) ports.set(identity, allocateTestHostLockPort(repository));
  return ports.get(identity)!;
}

export async function acquireTestHostRepositoryLock(input: Parameters<typeof acquireHostRepositoryLock>[0]) {
  return acquireHostRepositoryLock({ ...input, hostLockPort: input.hostLockPort ?? await testHostLockPort(input.repository) });
}

export async function acquireTestStewardshipStore(input: Parameters<typeof acquireStewardshipStore>[0]) {
  return acquireStewardshipStore({ ...input, hostLockPort: input.hostLockPort ?? await testHostLockPort(input.repository) });
}

export async function readTestStewardshipLifecycleReceipts(input: Parameters<typeof readStewardshipLifecycleReceipts>[0]) {
  return readStewardshipLifecycleReceipts({ ...input, hostLockPort: input.hostLockPort ?? await testHostLockPort(input.repository) });
}

export async function runTestRoadmapSort(args: readonly string[], dependencies: NonNullable<Parameters<typeof runRoadmapSort>[1]> = {}) {
  if (dependencies.hostLockPort !== undefined) return runRoadmapSort(args, dependencies);
  // Copy descriptors, not values: a spread would invoke trip-wire getters (e.g. a
  // forbidden `seats` getter) that tests use to prove a command never reads them.
  const routed = Object.create(Object.getPrototypeOf(dependencies), Object.getOwnPropertyDescriptors(dependencies)) as typeof dependencies;
  Object.defineProperty(routed, "hostLockPort", { value: await testHostLockPort(), enumerable: true, configurable: true, writable: true });
  return runRoadmapSort(args, routed);
}
