import './worktree-cleanup-test-env';
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ok, resolveExecutable, unknown } from "../lib/worktree-cleanup/probe.mjs";
import { publishRescues, rescueDryRun, runRescueCommand } from "../lib/worktree-cleanup/rescue.mjs";
import { admitRescue } from "../lib/worktree-cleanup/admission.mjs";
import { main } from "../worktree-cleanup.mjs";

const roots: string[] = [];
const executable = resolveExecutable("git");
if (executable.state !== "ok") throw new Error("git is required for local fixtures");
const gitPath = executable.value;
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))),
  NODE_ENV: "test" as const,
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: "Rescue test", GIT_AUTHOR_EMAIL: "test@localhost.invalid",
  GIT_COMMITTER_NAME: "Rescue test", GIT_COMMITTER_EMAIL: "test@localhost.invalid" };
function git(cwd: string, args: string[], input?: Buffer | string) {
  return execFileSync(gitPath, ["-c", "core.hooksPath=NUL", "-C", cwd, ...args], { env, input, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
type Pr = { number: number; state: string; isDraft: boolean; headRefName: string; headRefOid: string; baseRefName: string; url: string; body: string };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cleanup-rescue-")); roots.push(root);
  const repo = join(root, "repo"), remote = join(root, "origin.git");
  mkdirSync(repo); mkdirSync(remote);
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  git(repo, ["init", "--initial-branch=main"]);
  writeFileSync(join(repo, "README.md"), "# Main\n");
  git(repo, ["add", "README.md"]); git(repo, ["commit", "-m", "main"]);
  git(repo, ["remote", "add", "origin", remote]); git(repo, ["push", "origin", "main"]);
  const head = git(repo, ["rev-parse", "HEAD"]);
  const prs: Pr[] = [];
  const runGh = vi.fn((args: string[]) => {
    const headName = args[args.indexOf("--head") + 1];
    if (args[1] === "list") {
      return ok(JSON.stringify(prs.filter((pr) => pr.headRefName === headName).map((pr) => ({ ...pr,
        headRefOid: pr.state === "OPEN" ? git(remote, ["rev-parse", `refs/heads/${pr.headRefName}`]) : pr.headRefOid }))));
    }
    if (args[1] === "create") {
      const number = prs.length + 1;
      prs.push({ number, state: "OPEN", isDraft: args.includes("--draft"), headRefName: headName,
        headRefOid: git(remote, ["rev-parse", `refs/heads/${headName}`]), baseRefName: "main",
        url: `https://github.com/example-org/example-repo/pull/${number}`, body: args[args.indexOf("--body") + 1] });
      return ok(prs.at(-1)!.url);
    }
    if (args[1] === "edit") {
      const pr = prs.find((pr) => pr.number === Number(args[2]));
      if (!pr) return unknown("missing PR");
      pr.body = args[args.indexOf("--body") + 1]; return ok("");
    }
    throw new Error(`Unexpected gh command: ${args.join(" ")}`);
  });
  const journalPath = join(root, "journal.json");
  const runGit: typeof runRescueCommand = (executable, args, options) => {
    const result = runRescueCommand(executable, args, options);
    if (result.state !== "ok") throw new Error(`${args.join(" ")}: ${result.stderr}`);
    return result;
  };
  const options = { journalPath, remotePath: remote, gitPath, runGh, runGit, now: "2026-09-26T18:00:00.000Z" };
  function candidate(name = "topic", text = "# Admitted\r\nCafé 日本語\r\n", path = "notes.md") {
    const treePath = join(root, name); mkdirSync(treePath, { recursive: true });
    const bytes = Buffer.from(text), blobSha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    return { path: treePath, head, branch: `refs/heads/${name}`, disposition: "rescue", sourcePr: 42,
      files: [{ path, rescuedPath: `docs/rescued/${name}-${head.slice(0, 7)}/${path.replaceAll("\\", "/")}`, kind: "untracked", bytes, blobSha }] };
  }
  return { root, repo, remote, head, prs, runGh, options, candidate, journal: () => JSON.parse(readFileSync(journalPath, "utf8")) };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe fixture cleanup");
    rmSync(root, { recursive: true, force: true });
  }
});

describe("rescue publisher with a local bare origin and stubbed gh", { timeout: 30_000 }, () => {
  it("publishes admitted bytes from main, verifies blobs, and creates one draft with its manifest", async () => {
    const f = fixture(), tree = f.candidate();
    const beforeIndex = readFileSync(join(f.repo, ".git/index"));
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options);
    expect(result, JSON.stringify(result)).toMatchObject({ state: "ok", value: { worktrees: [{ path: tree.path, verified: { state: "ok" } }] } });
    const journal = f.journal();
    expect(journal).toMatchObject({ state: "published_verified", generation: "chore/rescued-docs-20260926", prConfirmed: true });
    expect(git(f.remote, ["rev-parse", `${journal.commitSha}^`])).toBe(f.head);
    const bytes = execFileSync(gitPath, ["-C", f.remote, "show", `${journal.commitSha}:${tree.files[0].rescuedPath}`], { env });
    expect(bytes).toEqual(tree.files[0].bytes);
    expect(f.prs).toHaveLength(1);
    expect(f.prs[0]).toMatchObject({ isDraft: true, baseRefName: "main" });
    for (const text of [tree.path, tree.branch, "42", "notes.md", "2026-09-26"]) expect(f.prs[0].body).toContain(text);
    expect(readFileSync(join(f.repo, ".git/index"))).toEqual(beforeIndex);
    expect(git(f.repo, ["status", "--porcelain"])).toBe("");
    expect(git(f.repo, ["rev-parse", "HEAD"])).toBe(f.head);
  });

  it("appends to the open generation, keeps a cumulative body, and retries without another commit", async () => {
    const f = fixture(), first = f.candidate(), second = f.candidate("another");
    await publishRescues({ primaryPath: f.repo, worktrees: [first] }, f.options);
    const previous = f.journal().commitSha;
    const next = await publishRescues({ primaryPath: f.repo, worktrees: [second] }, f.options);
    expect(next, JSON.stringify(next)).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    const current = f.journal().commitSha;
    expect(current).not.toBe(previous);
    expect(git(f.remote, ["rev-parse", `${current}^`])).toBe(previous);
    expect(f.prs).toHaveLength(1);
    expect(f.prs[0].body).toContain(first.files[0].rescuedPath);
    expect(f.prs[0].body).toContain(second.files[0].rescuedPath);
    const retry = await publishRescues({ primaryPath: f.repo, worktrees: [second] }, f.options);
    expect(retry).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(f.journal().commitSha).toBe(current);
    expect(f.runGh.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(1);
  });

  it.each(["MERGED", "CLOSED"])("starts from fresh remote main after %s and never alters the old branch", async (state) => {
    const f = fixture();
    await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, f.options);
    const previous = f.journal(); f.prs[0].state = state;
    writeFileSync(join(f.repo, "README.md"), "# New main\n");
    git(f.repo, ["add", "README.md"]); git(f.repo, ["commit", "-m", "advance main"]); git(f.repo, ["push", "origin", "main"]);
    const main = git(f.remote, ["rev-parse", "main"]);
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate("next")] }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(f.journal().generation).toBe("chore/rescued-docs-20260926-2");
    expect(git(f.remote, ["rev-parse", `${f.journal().commitSha}^`])).toBe(main);
    expect(git(f.remote, ["rev-parse", previous.generation])).toBe(previous.commitSha);
    expect(f.prs.filter((pr) => pr.state === "OPEN")).toHaveLength(1);
    expect(f.prs).toHaveLength(2);
  });

  it("skips occupied suffixes and a finished PR whose branch was deleted", async () => {
    const f = fixture();
    await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, f.options);
    f.prs[0].state = "MERGED";
    git(f.remote, ["update-ref", "-d", `refs/heads/${f.prs[0].headRefName}`]);
    git(f.remote, ["update-ref", "refs/heads/chore/rescued-docs-20260926-2", f.head]);
    await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate("next")] }, f.options);
    expect(f.journal().generation).toBe("chore/rescued-docs-20260926-3");
  });

  it("treats a definitively closed pending PR as a finished generation", async () => {
    const f = fixture();
    const runGh = (args: string[]) => {
      const result = f.runGh(args);
      return args[1] === "create" ? unknown("lost create response") : result;
    };
    await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, { ...f.options, runGh });
    expect(f.journal().prConfirmed).toBe(false); f.prs[0].state = "CLOSED";
    const previous = f.journal();
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate("next")] }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(f.journal().generation).toBe("chore/rescued-docs-20260926-2");
    expect(git(f.remote, ["rev-parse", previous.generation])).toBe(previous.commitSha);
  });

  it("holds every candidate on a real non-fast-forward rejection", async () => {
    const f = fixture(), trees = [f.candidate(), f.candidate("second")];
    const runGit: typeof runRescueCommand = (executable, args, options) => {
      if (args.includes("push")) {
        const branch = args.at(-1)!.split(":refs/heads/")[1];
        const treeSha = git(f.remote, ["rev-parse", "main^{tree}"]);
        const competing = git(f.remote, ["commit-tree", treeSha, "-p", f.head], "competing publisher\n");
        git(f.remote, ["update-ref", `refs/heads/${branch}`, competing]);
      }
      return runRescueCommand(executable, args, options);
    };
    const result = await publishRescues({ primaryPath: f.repo, worktrees: trees }, { ...f.options, runGit });
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }, { verified: { state: "unknown" } }] } });
    expect(f.prs).toHaveLength(0); expect(f.journal().state).toBe("not_pushed");
  });

  it("holds after a successful push exit with no matching remote SHA", async () => {
    const f = fixture();
    const runGit: typeof runRescueCommand = (executable, args, options) => args.includes("push") ? ok("") : runRescueCommand(executable, args, options);
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, { ...f.options, runGit });
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "negative" } }] } });
    expect(f.journal().state).toBe("pushed_unverified"); expect(f.prs).toHaveLength(0);
  });

  it("holds the whole tree if one remote readback blob differs", async () => {
    const f = fixture(), tree = f.candidate();
    tree.files.push(f.candidate("topic", "# Second\n", "second.md").files[0]);
    let pushed = false;
    const runGit: typeof runRescueCommand = (executable, args, options) => {
      const result = runRescueCommand(executable, args, options);
      if (args.includes("push")) pushed = true;
      if (pushed && args.includes("ls-tree") && args.at(-1)!.startsWith("refs/worktree-cleanup/") && result.state === "ok") {
        return ok(result.value.replace(tree.files[1].blobSha, "b".repeat(40)));
      }
      return result;
    };
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, { ...f.options, runGit });
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "negative" } }] } });
    expect(f.prs).toHaveLength(0);
  });

  it.each(["not_pushed", "pushed_unverified"])("recovers a crash recorded as %s without another push, commit or PR", async (state) => {
    const f = fixture(), tree = f.candidate();
    let pushed = false;
    const commands: string[][] = [];
    const runGit: typeof runRescueCommand = (executable, args, options) => {
      commands.push(args);
      if (pushed && args.includes("ls-remote")) throw new Error("simulated crash");
      const result = runRescueCommand(executable, args, options);
      if (args.includes("push")) { pushed = true; if (state === "not_pushed") throw new Error("simulated crash after push"); }
      return result;
    };
    await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, { ...f.options, runGit });
    const before = f.journal(); expect(before.state).toBe(state); expect(f.prs).toHaveLength(0);
    commands.length = 0;
    const resumeGit: typeof runRescueCommand = (executable, args, options) => { commands.push(args); return runRescueCommand(executable, args, options); };
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [] }, { ...f.options, runGit: resumeGit });
    expect(result, JSON.stringify(result)).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(f.journal().commitSha).toBe(before.commitSha); expect(f.prs).toHaveLength(1);
    expect(commands.some((args) => args.includes("push") || args.includes("commit-tree") || args.includes("hash-object"))).toBe(false);
  });

  it.each([false, true])("recovers failed PR creation (server created it: %s) before adding a new tree", async (created) => {
    const f = fixture(), first = f.candidate(), second = f.candidate("second");
    const runGh = (args: string[]) => {
      if (args[1] === "create") { if (created) f.runGh(args); return unknown("gh failed"); }
      return f.runGh(args);
    };
    const failed = await publishRescues({ primaryPath: f.repo, worktrees: [first] }, { ...f.options, runGh });
    expect(failed).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    const previous = f.journal(); expect(previous.state).toBe("published_verified"); expect(previous.prConfirmed).toBe(false);
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [second] }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(git(f.remote, ["rev-parse", `${f.journal().commitSha}^`])).toBe(previous.commitSha);
    expect(f.prs).toHaveLength(1); expect(f.prs[0].body).toContain(first.files[0].rescuedPath);
    expect(f.runGh.mock.calls.filter(([args]) => args[1] === "create")).toHaveLength(1);
  });

  it("publishes admitted buffers after source replacement; current disk bytes fail U5's comparison", async () => {
    const f = fixture(), tree = f.candidate();
    writeFileSync(join(tree.path, "notes.md"), ("ghp_" + "A".repeat(36) + "\n"));
    await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options);
    const pushed = git(f.remote, ["show", `${f.journal().commitSha}:${tree.files[0].rescuedPath}`]);
    expect(pushed).toBe(tree.files[0].bytes.toString("utf8").trim()); expect(pushed).not.toContain("ghp_");
    const current = git(f.repo, ["hash-object", "--stdin"], readFileSync(join(tree.path, "notes.md")));
    expect(current).not.toBe(tree.files[0].blobSha);
  });

  it("holds a resume with a missing recorded blob instead of publishing a fresh source read", async () => {
    const f = fixture(), tree = f.candidate();
    const runGh = (args: string[]) => args[1] === "create" ? unknown("offline") : f.runGh(args);
    await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, { ...f.options, runGh });
    const blob = tree.files[0].blobSha;
    const objectPath = resolve(f.repo, ".git/objects", blob.slice(0, 2), blob.slice(2));
    expect(objectPath.startsWith(resolve(f.repo) + sep)).toBe(true); unlinkSync(objectPath);
    writeFileSync(join(tree.path, "notes.md"), ("ghp_" + "A".repeat(36) + "\n"));
    const runGit = vi.fn(runRescueCommand);
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, { ...f.options, runGit });
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    expect(runGit.mock.calls.some(([, args]) => args.includes("push") || args.includes("hash-object"))).toBe(false);
    expect(f.prs).toHaveLength(0);
  });

  it("refuses an actual plumbing commit with a path outside the admitted diff", async () => {
    const f = fixture(), tree = f.candidate(); let pushed = false;
    const runGit: typeof runRescueCommand = (executable, args, options) => {
      if (args.includes("write-tree")) {
        const injected = runRescueCommand(executable, ["-C", f.repo, "update-index", "--add", "--cacheinfo", "100644", tree.files[0].blobSha, "src/unadmitted.md"], options);
        expect(injected.state).toBe("ok");
      }
      if (args.includes("push")) pushed = true;
      return runRescueCommand(executable, args, options);
    };
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, { ...f.options, runGit });
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown", reason: "Commit diff escapes admitted rescue paths" } }] } });
    expect(pushed).toBe(false); expect(f.prs).toHaveLength(0); expect(existsSync(f.options.journalPath)).toBe(false);
  });

  it("rejects a buffer changed after admission and conflicting rescue destinations", async () => {
    const f = fixture(), tree = f.candidate(); tree.files[0].bytes = Buffer.from("replacement");
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    expect(f.prs).toHaveLength(0);
    await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, f.options);
    const before = f.journal().commitSha;
    const collision = await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate("topic", "changed")] }, f.options);
    expect(collision).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown", reason: "Rescue destination collision" } }] } });
    expect(f.journal().commitSha).toBe(before);
  });

  it("normalizes Windows file separators and ignores non-rescue dispositions", async () => {
    const f = fixture(), tree = f.candidate("topic", "# Nested\n", "docs\\日本語.md");
    tree.files[0].rescuedPath = tree.files[0].rescuedPath.replaceAll("/", "\\");
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [{ disposition: "hold" }, tree] }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(f.journal().trees[0].files[0].rescuedPath).toMatch(/docs\/日本語.md$/);
  });

  it("uses a private index despite inherited Git variables and skips hooks only on the non-force push", async () => {
    const f = fixture(), tree = f.candidate();
    writeFileSync(join(f.repo, "staged.txt"), "keep staged\n"); git(f.repo, ["add", "staged.txt"]);
    const index = readFileSync(join(f.repo, ".git/index"));
    const poisonIndex = join(f.root, "poison-index"); writeFileSync(poisonIndex, "not an index");
    vi.stubEnv("GIT_INDEX_FILE", poisonIndex); vi.stubEnv("GIT_DIR", join(f.root, "missing"));
    const runGit = vi.fn(runRescueCommand);
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, { ...f.options, runGit });
    vi.unstubAllEnvs();
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    const calls = runGit.mock.calls, push = calls.filter(([, args]) => args.includes("push"));
    expect(push).toHaveLength(1); expect(push[0][1]).toContain("core.hooksPath=NUL");
    expect(push[0][1]).toContain("credential.helper=!gh auth git-credential");
    expect(calls.filter(([, args]) => args.includes("core.hooksPath=NUL"))).toHaveLength(1);
    expect(push[0][1].some((arg) => arg.includes("force") || arg.startsWith("+"))).toBe(false);
    expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index);
    expect(readFileSync(poisonIndex, "utf8")).toBe("not an index");
    expect(git(f.repo, ["status", "--porcelain"])).toBe("A  staged.txt");
    expect(git(f.repo, ["for-each-ref", "--format=%(refname)", "refs/worktree-cleanup/"])).toBe("");
  });

  it.each(["unknown", "malformed", "duplicate", "ready", "head-mismatch"])("holds on %s PR evidence", async (failure) => {
    const f = fixture();
    await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, f.options);
    const before = f.journal().commitSha;
    const runGh = (args: string[]) => {
      if (args[1] !== "list") return f.runGh(args);
      if (failure === "unknown") return unknown("network failure");
      if (failure === "malformed") return ok("not json");
      const pr = { ...f.prs[0], ...(failure === "ready" ? { isDraft: false } : {}), ...(failure === "head-mismatch" ? { headRefOid: "b".repeat(40) } : {}) };
      return ok(JSON.stringify(failure === "duplicate" ? [pr, { ...pr, number: 2 }] : [pr]));
    };
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate("second")] }, { ...f.options, runGh });
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    expect(f.journal().commitSha).toBe(before);
  });

  it("does no publication with empty input, and refuses a corrupt or foreign journal", async () => {
    const f = fixture();
    const empty = await publishRescues({ primaryPath: f.repo, worktrees: [] }, f.options);
    expect(empty).toMatchObject({ state: "ok", value: { worktrees: [] } }); expect(f.runGh).not.toHaveBeenCalled();
    writeFileSync(f.options.journalPath, "broken");
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    expect(f.prs).toHaveLength(0);
  });

  it("consumes real U3 admission for multiple trees in one commit", async () => {
    const f = fixture();
    const trees = [f.candidate(), f.candidate("second")].map((candidate) => {
      writeFileSync(join(candidate.path, "notes.md"), candidate.files[0].bytes);
      const admitted = admitRescue({ path: candidate.path, registration: ok({ head: candidate.head }),
        status: ok({ entries: [{ index: "?", worktree: "?", path: "notes.md" }] }), ignored: ok({ unexpected: [] }) });
      if (admitted.state !== "ok") throw new Error("Admission failed");
      return { ...candidate, files: admitted.value.files };
    });
    const result = await publishRescues({ primaryPath: f.repo, worktrees: trees }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }, { verified: { state: "ok" } }] } });
    expect(git(f.remote, ["rev-list", "--count", `${f.head}..${f.journal().commitSha}`])).toBe("1");
    expect(f.journal().trees).toHaveLength(2);
  });

  it("recovers not_pushed after an offline push and refuses a foreign journal identity", async () => {
    const f = fixture(), tree = f.candidate();
    const runGit: typeof runRescueCommand = (executable, args, options) => args.includes("push") ? unknown("offline") : runRescueCommand(executable, args, options);
    await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, { ...f.options, runGit });
    const before = f.journal(); expect(before.state).toBe("not_pushed");
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options);
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(f.journal().commitSha).toBe(before.commitSha);
    writeFileSync(f.options.journalPath, JSON.stringify({ ...f.journal(), identity: "foreign" }));
    const foreign = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options);
    expect(foreign).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
  });

  it("holds while a journal owner is alive and recovers a dead owner's lock", async () => {
    const f = fixture(), tree = f.candidate(), lock = `${f.options.journalPath}.lock`;
    writeFileSync(lock, String(process.pid));
    expect(await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options)).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
    writeFileSync(lock, "2147483647");
    expect(await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options)).toMatchObject({ value: { worktrees: [{ verified: { state: "ok" } }] } });
    expect(existsSync(lock)).toBe(false);
  });

  it.each(["fetch-failure", "fetch-race", "malformed-ref", "body-readback"])("holds on %s after a push", async (failure) => {
    const f = fixture(); let pushed = false;
    const runGit: typeof runRescueCommand = (executable, args, options) => {
      if (pushed && args.includes("fetch")) {
        if (failure === "fetch-failure") return unknown("fetch failed");
        if (failure === "fetch-race") git(f.remote, ["update-ref", "refs/heads/chore/rescued-docs-20260926", f.head]);
      }
      if (pushed && args.includes("ls-remote") && failure === "malformed-ref") return ok(`${f.head}\twrong-ref\n`);
      const result = runRescueCommand(executable, args, options);
      if (args.includes("push")) pushed = true;
      return result;
    };
    const runGh = (args: string[]) => {
      const result = f.runGh(args);
      if (failure === "body-readback" && args[1] === "create") f.prs[0].body = "wrong manifest";
      return result;
    };
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [f.candidate()] }, { ...f.options, runGit, runGh });
    expect(result).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    expect(f.journal().prConfirmed).toBe(false);
  });

  it("requires a stubbed gh for local publishing and rejects non-bare/URL dry-run remotes", async () => {
    const f = fixture(), tree = f.candidate();
    const { runGh: _unused, ...options } = f.options;
    expect(await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, options)).toMatchObject({ value: { worktrees: [{ verified: { state: "unknown" } }] } });
    for (const remotePath of [f.repo, "https://github.com/example-org/example-repo.git", "git@github.com:example-org/example-repo.git"]) {
      expect((await rescueDryRun({ primaryPath: f.repo, worktrees: [tree] }, { remotePath })).state).toBe("unknown");
    }
    expect(f.prs).toHaveLength(0);
  });

  it.each(["../escape.md", "/root.md", ".git/config.md", "notes.txt"])("refuses unsafe input %s without Git publication", async (path) => {
    const f = fixture(), tree = f.candidate(); tree.files[0].path = path;
    const result = await publishRescues({ primaryPath: f.repo, worktrees: [tree] }, f.options);
    expect(result.state === "unknown" || (result.state === "ok" && result.value.worktrees.every((tree) => tree.verified.state !== "ok"))).toBe(true);
    expect(f.prs).toHaveLength(0); expect(existsSync(f.options.journalPath)).toBe(false);
  });

  it("returns unknown for incomplete dispositions instead of throwing or authorizing an empty success", async () => {
    const f = fixture();
    for (const bad of [{ disposition: "rescue", path: f.root, files: null }, { ...f.candidate(), files: [null] }]) {
      const result = await publishRescues({ primaryPath: f.repo, worktrees: [bad] }, f.options);
      expect(result.state).toBe("unknown");
    }
  });

  it("runs the local-only CLI harness, persists a simulated manifest, and leaves the source checkout untouched", async () => {
    const f = fixture(), tree = f.candidate(), plan = { primaryPath: f.repo, worktrees: [tree], freshness: ok({ source: "fixture" }), prSnapshot: ok([]) };
    const journalPath = join(f.root, "manual", "journal.json");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dependencies = {
      inventory: vi.fn(() => ok({ primaryPath: f.repo, runnerPath: f.repo, commonDirectory: ok(join(f.repo, ".git")), worktrees: [], incompleteScans: [], registrationKeys: [], knownStaleRegistrations: [] })), collectActivity: vi.fn(async () => []),
      planWorktrees: vi.fn(async () => ok(plan)), runProbe: vi.fn(() => unknown("must not call real gh or fetch")),
    };
    const args = ["rescue-dry-run", "--repo", f.repo, "--remote-path", f.remote, "--journal-path", journalPath];
    const status = git(f.repo, ["status", "--porcelain"]), index = readFileSync(join(f.repo, ".git/index"));
    expect(await main(args, dependencies)).toBe(0);
    const result = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(result).toMatchObject({ state: "ok", value: { dryRun: true, journalPath, simulatedPrs: [{ isDraft: true }], worktrees: [{ verified: { state: "ok" } }] } });
    expect(result.value.simulatedPrs[0].body).toContain(tree.files[0].rescuedPath);
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(await main(args, dependencies)).toBe(0);
    expect(JSON.parse(readFileSync(journalPath, "utf8")).commitSha).toBe(journal.commitSha);
    expect(dependencies.planWorktrees.mock.calls[0]).toEqual([expect.anything(), expect.objectContaining({ prSnapshot: ok([]) })]);
    expect(dependencies.runProbe).not.toHaveBeenCalled(); expect(f.runGh).not.toHaveBeenCalled();
    expect(readFileSync(join(f.repo, ".git/index"))).toEqual(index); expect(git(f.repo, ["status", "--porcelain"])).toBe(status);
    expect(() => git(f.repo, ["cat-file", "-e", journal.commitSha])).toThrow();
  });

  it("requires --remote-path before inventory, and keeps run unwired", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["rescue-dry-run"])).toBe(1);
    expect(String(log.mock.calls[0][0])).toContain("--remote-path");
    expect(await main(["run"])).toBe(1);
  });
});
