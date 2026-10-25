import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { PRODUCTION_STEWARDSHIP_LIMITS } from "./stewardship-policy";
import { StewardshipAssessmentError, type StewardshipDiagnostic } from "./stewardship-diagnostics";
import type { StewardshipGlmCallReceipt } from "./stewardship-assessment";

/** Quota exhaustion is terminal; a bare 429 is a transient call refusal. */
export function isStewardshipUsageLimit(text: string): boolean {
  return /(?:usage[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|insufficient_quota|insufficient balance or no resource package|\bcode["\s:=]+["\s]*(?:1113|1308|1310)\b|depleted[_ -]+credits|credits[_ -]+(?:depleted|exhausted)|\bHTTP(?:\/[\d.]+)?\s+402\b|\bstatus(?:_code)?["\s:=]+402\b)/i.test(text);
}
export class StewardshipUsageLimitError extends Error {
  constructor() { super("stopped_usage_limit"); }
}

function isRateLimited(text: string): boolean {
  return /(?:rate[_ -]?limit|\bHTTP(?:\/[\d.]+)?\s+429\b|\bstatus(?:_code)?["\s:=]+429\b|\bAPI Error:\s*429\b)/i.test(text);
}
type ProcessReceipt = Omit<StewardshipGlmCallReceipt, "slot">;

export interface StewardshipSeatInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  /** Compact only the CLI's strictly recognized per-token telemetry, never model/tool content. */
  readonly claudeStreamJson?: boolean;
  /** Closed attribution only; called once at transport settlement, never with provider bytes. */
  readonly recordCall?: (receipt: ProcessReceipt) => void;
}

export interface StewardshipSeatProcessResult {
  readonly stdout: string;
  readonly stderr: string;
}

type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessWithoutNullStreams;

export const ASSESSMENT_OUTPUT_BYTES = 256 * 1024;
const TELEMETRY_STREAM_BYTES = 8 * 1024 * 1024;
const TELEMETRY_KEYS = new Set(["type", "subtype", "estimated_tokens", "estimated_tokens_delta", "session_id", "uuid"]);
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function isTokenCount(value: unknown): boolean { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isThinkingTelemetry(line: string): boolean {
  try {
    const event: unknown = JSON.parse(line);
    if (!event || typeof event !== "object" || Array.isArray(event)) return false;
    const value = event as Record<string, unknown>;
    const keys = Object.keys(value);
    return keys.length === TELEMETRY_KEYS.size && keys.every((key) => TELEMETRY_KEYS.has(key))
      && value.type === "system" && value.subtype === "thinking_tokens"
      && isTokenCount(value.estimated_tokens) && isTokenCount(value.estimated_tokens_delta)
      && typeof value.session_id === "string" && UUID.test(value.session_id) && typeof value.uuid === "string" && UUID.test(value.uuid);
  } catch { return false; }
}

/** Bound both wire traffic and retained evidence; telemetry must not crowd out the final answer. */
class SeatOutput {
  private readonly decoder = new StringDecoder("utf8");
  private readonly chunks: string[] = [];
  private pending: string[] = [];
  private pendingBytes = 0;
  private received = 0;
  private retained = 0;
  constructor(private readonly streamJson: boolean) {}
  private retain(text: string): void {
    this.retained += Buffer.byteLength(text);
    if (this.retained > ASSESSMENT_OUTPUT_BYTES) throw new Error("assessment_output_limit");
    this.chunks.push(text);
  }
  private decode(text: string): void {
    if (!this.streamJson) { this.retain(text); return; }
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const fragment = text.slice(start, newline === -1 ? undefined : newline + 1);
      this.pendingBytes += Buffer.byteLength(fragment);
      if (this.pendingBytes > ASSESSMENT_OUTPUT_BYTES) throw new Error("assessment_output_limit");
      this.pending.push(fragment);
      if (newline === -1) break;
      const line = this.pending.join("");
      this.pending = []; this.pendingBytes = 0;
      if (!isThinkingTelemetry(line)) this.retain(line);
      start = newline + 1;
    }
  }
  append(bytes: Buffer): void {
    this.received += bytes.length;
    if (this.received > (this.streamJson ? TELEMETRY_STREAM_BYTES : ASSESSMENT_OUTPUT_BYTES)) throw new Error("assessment_output_limit");
    this.decode(this.decoder.write(bytes));
  }
  finish(): string {
    this.decode(this.decoder.end());
    const remaining = this.pending.join("");
    if (remaining && !isThinkingTelemetry(remaining)) this.retain(remaining);
    return this.chunks.join("");
  }
}

type SeatCommand = Pick<StewardshipSeatInvocation, "command" | "args" | "cwd" | "env">;
interface SeatProcessDependencies {
  readonly spawnProcess?: SpawnProcess;
  readonly killTree?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  /** Session close only: how long to wait for an observed exit after the kill. */
  readonly exitGraceMs?: number;
}

function windowsJobInvocation<T extends SeatCommand>(invocation: T): T {
  const targetEnv = { ...invocation.env };
  if (!Object.keys(targetEnv).some((name) => name.toUpperCase() === "SYSTEMROOT")) {
    targetEnv.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
  }
  const control = Buffer.from(JSON.stringify({
    command: invocation.command,
    args: invocation.args,
    cwd: invocation.cwd,
    environment: Object.entries(targetEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
  }), "utf8").toString("base64");
  const bootstrapEnv = {} as NodeJS.ProcessEnv;
  for (const name of ["SystemRoot", "TEMP", "TMP"] as const) {
    if (process.env[name] !== undefined) bootstrapEnv[name] = process.env[name];
  }
  return {
    ...invocation,
    command: join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "run-stewardship-seat-job.ps1"),
    ],
    env: { ...bootstrapEnv, ROADMAP_STEWARDSHIP_SEAT_LAUNCH: control },
  };
}

function spawnSeatCommand(invocation: SeatCommand, dependencies: SeatProcessDependencies): ChildProcessWithoutNullStreams {
  const launched = process.platform === "win32" && !dependencies.spawnProcess ? windowsJobInvocation(invocation) : invocation;
  return (dependencies.spawnProcess ?? spawn)(launched.command, [...launched.args], {
    cwd: launched.cwd, env: launched.env, shell: false, windowsHide: true, detached: process.platform !== "win32",
  });
}

async function killChildTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (process.platform === "win32" && child.pid) {
    await new Promise<void>((done, reject) => {
      execFile(
        join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
        ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000, maxBuffer: 8192 },
        (error) => {
          child.kill("SIGKILL");
          if (error && child.exitCode === null) {
            reject(new Error("windows_process_tree_cleanup_failed"));
            return;
          }
          done();
        },
      );
    });
  } else if (child.pid) {
    // Children are process-group leaders on POSIX; kill descendants as well as the CLI.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

/** A failed taskkill can race with the child's exit after the fallback SIGKILL. */
function waitForChildExit(child: ChildProcessWithoutNullStreams, graceMs = 1000): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), graceMs);
    child.once("exit", onExit);
  });
}

/**
 * A session closes after a completed turn as well as on failure; under host load the contained
 * launcher can take seconds to exit after a successful taskkill, so its exit gets a longer grace.
 */
export const SESSION_EXIT_GRACE_MS = 10_000;

/** Concrete bounded process transport shared by production seats and process-level tests. */
export function runStewardshipSeatCli(
  invocation: StewardshipSeatInvocation,
  dependencies: SeatProcessDependencies = {},
): Promise<StewardshipSeatProcessResult> {
  return new Promise((accept, reject) => {
    if (
      !Number.isFinite(invocation.timeoutMs) ||
      invocation.timeoutMs <= 0 ||
      invocation.timeoutMs > PRODUCTION_STEWARDSHIP_LIMITS.assessmentTimeoutMs
    ) {
      reject(new Error("assessment_deadline"));
      return;
    }
    const startedAt = new Date().toISOString();
    const started = performance.now();
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnSeatCommand(invocation, dependencies);
    } catch {
      invocation.recordCall?.({ startedAt, wallMs: Math.round(performance.now() - started), outcome: "error", exitCode: null });
      reject(new Error("assessment_spawn_failed"));
      return;
    }
    const stdout = new SeatOutput(invocation.claudeStreamJson === true);
    const stderr: Buffer[] = [];
    let errorBytes = 0;
    let settled = false;
    let providerQuota = false;
    let providerRateLimited = false;
    const recordCall = (outcome: ProcessReceipt["outcome"], exitCode: number | null) => {
      // stderr is transient and bounded above; only booleans leave this transport.
      const errors = Buffer.concat(stderr).toString("utf8");
      invocation.recordCall?.({ startedAt, wallMs: Math.round(performance.now() - started), exitCode,
        outcome: providerQuota || (outcome !== "ok" && isStewardshipUsageLimit(errors)) ? "quota"
          : outcome !== "ok" && (providerRateLimited || isRateLimited(errors)) ? "rate_limited" : outcome });
      stderr.length = 0;
    };
    const fail = (code: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void (dependencies.killTree ?? killChildTree)(child).then(
        async () => {
          // Reaping bounds receipt timing; a successful kill preserves the original failure code.
          if (invocation.recordCall) await waitForChildExit(child);
          recordCall(code === "assessment_timeout" ? "timeout" : "error", null);
          reject(new Error(code));
        },
        async () => {
          const confirmedTimeout = code === "assessment_timeout" && await waitForChildExit(child);
          recordCall(confirmedTimeout ? "timeout" : "error", null);
          reject(new Error(confirmedTimeout ? code : "assessment_cleanup_failed"));
        },
      );
    };
    const timer = setTimeout(() => fail("assessment_timeout"), invocation.timeoutMs);
    child.stdout.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      try { stdout.append(Buffer.from(chunk)); }
      catch { fail("assessment_output_limit"); }
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.from(chunk);
      errorBytes += bytes.length;
      if (errorBytes > 64 * 1024) fail("assessment_output_limit");
      else stderr.push(bytes);
    });
    child.once("error", () => fail("assessment_spawn_failed"));
    child.stdin.once("error", () => fail("assessment_input_failed"));
    child.once("close", (code) => {
      if (settled) return;
      const observeProviderErrors = (output: string) => output.split(/\r?\n/).forEach((line) => {
        try {
          const event = JSON.parse(line);
          // Only provider error frames count; never classify ordinary model answer prose.
          if (event?.type === "error" || event?.type === "turn.failed" || (event?.type === "result" && event?.is_error === true)) {
            providerQuota ||= isStewardshipUsageLimit(line);
            providerRateLimited ||= isRateLimited(line);
          }
        } catch { /* Non-JSON output is classified by the seat's existing runtime guard. */ }
      });
      if (code !== 0) {
        settled = true;
        clearTimeout(timer);
        let limited = isStewardshipUsageLimit(Buffer.concat(stderr).toString("utf8"));
        try {
          observeProviderErrors(stdout.finish());
          limited ||= providerQuota;
        } catch { /* Existing output bounds remain authoritative. */ }
        recordCall("error", code);
        reject(code !== 125 && limited ? new StewardshipUsageLimitError()
          : new Error(code === 125 ? "assessment_cleanup_failed" : "assessment_exit_failed"));
        return;
      }
      try {
        const output = stdout.finish();
        settled = true;
        clearTimeout(timer);
        observeProviderErrors(output);
        const errors = Buffer.concat(stderr).toString("utf8");
        recordCall("ok", code);
        if (providerQuota) { reject(new StewardshipUsageLimitError()); return; }
        accept({ stdout: output, stderr: errors });
      } catch { fail("assessment_output_limit"); }
    });
    child.stdin.end(invocation.input);
  });
}

export interface StewardshipSeatSession {
  write(message: unknown): Promise<void>;
  /** FIFO parsed messages; one pending next() at a time, with a timeout for that read. */
  next(timeoutMs: number): Promise<unknown>;
  /** Remove all already-parsed queued messages in FIFO order without waiting. */
  drain(): unknown[];
  /** True while bytes of an incomplete line are buffered, so a message is still arriving. */
  pending(): boolean;
  /** Idempotent tree cleanup; false means process-tree cleanup could not be confirmed. */
  close(): Promise<boolean>;
}

/** Bidirectional JSON lines over the same contained launcher as one-shot seats. */
export function openStewardshipSeatSession(
  invocation: SeatCommand,
  dependencies: SeatProcessDependencies = {},
): StewardshipSeatSession {
  const error = (code: StewardshipDiagnostic["code"], stage: StewardshipDiagnostic["stage"] = "transport") =>
    new StewardshipAssessmentError({ stage, code, field: "$" });
  let child: ChildProcessWithoutNullStreams;
  try { child = spawnSeatCommand(invocation, dependencies); }
  catch { throw error("assessment_spawn_failed"); }
  let open = true;
  let exited = child.exitCode !== null || child.signalCode !== null;
  let exitCode = child.exitCode;
  let failure: StewardshipAssessmentError | undefined;
  let cleanup: Promise<boolean> | undefined;
  let fragments: Buffer[] = [];
  let lineBytes = 0;
  let outputBytes = 0;
  let stderrBytes = 0;
  const messages: unknown[] = [];
  let messageIndex = 0;
  let waiting: { accept: (message: unknown) => void; reject: (error: StewardshipAssessmentError) => void; timer: ReturnType<typeof setTimeout> } | undefined;
  const writes = new Set<(error: StewardshipAssessmentError) => void>();
  const close = (): Promise<boolean> => {
    if (cleanup) return cleanup;
    open = false;
    messages.length = 0; messageIndex = 0; fragments = []; lineBytes = 0;
    if (waiting) clearTimeout(waiting.timer);
    // The launcher's kill-on-close Job Object ends the tree when the launcher exits, so an observed
    // exit confirms cleanup even when taskkill failed (for example, the process was already gone);
    // code 125 is the launcher's reserved cleanup failure either way.
    cleanup = (async () => {
      try { await (dependencies.killTree ?? killChildTree)(child); }
      catch { /* Still observe any exit during the bounded cleanup grace. */ }
      const observedExit = exited || await waitForChildExit(child, dependencies.exitGraceMs ?? SESSION_EXIT_GRACE_MS);
      const confirmed = observedExit && exitCode !== 125 && child.exitCode !== 125;
      if (!confirmed) failure = error("assessment_cleanup_failed");
      const stopped = failure ?? error("assessment_exit_failed");
      if (waiting) { waiting.reject(stopped); waiting = undefined; }
      for (const reject of writes) reject(stopped);
      writes.clear();
      return confirmed && failure?.detail.code !== "assessment_cleanup_failed";
    })();
    return cleanup;
  };
  const fail = (code: StewardshipDiagnostic["code"], stage?: StewardshipDiagnostic["stage"]) => {
    if (!open) return;
    failure = error(code, stage);
    void close();
  };
  const readFailure = async (): Promise<never> => {
    await close();
    throw failure ?? error("assessment_exit_failed");
  };
  child.stdout.on("data", (chunk: Buffer | string) => {
    if (!open) return;
    const bytes = Buffer.from(chunk);
    outputBytes += bytes.length;
    if (outputBytes > 8 * 1024 * 1024) { fail("assessment_output_limit"); return; }
    let start = 0;
    while (start < bytes.length && open) {
      const newline = bytes.indexOf(10, start);
      const fragment = bytes.subarray(start, newline === -1 ? undefined : newline);
      lineBytes += fragment.length;
      if (lineBytes > 1024 * 1024) { fail("assessment_output_limit"); return; }
      fragments.push(fragment);
      if (newline === -1) break;
      let message: unknown;
      try { message = JSON.parse(Buffer.concat(fragments, lineBytes).toString("utf8")); }
      catch { fail("invalid_json", "runtime"); return; }
      fragments = []; lineBytes = 0;
      if (waiting) {
        const receiver = waiting; waiting = undefined;
        clearTimeout(receiver.timer); receiver.accept(message);
      } else messages.push(message);
      start = newline + 1;
    }
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    if (!open) return;
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > 64 * 1024) fail("assessment_output_limit");
  });
  child.once("error", () => fail("assessment_spawn_failed"));
  child.stdin.on("error", () => fail("assessment_input_failed"));
  const onExit = (code: number | null) => {
    exited = true;
    exitCode = code;
    if (code === 125) failure = error("assessment_cleanup_failed");
    fail(code === 125 ? "assessment_cleanup_failed" : "assessment_exit_failed");
  };
  child.once("exit", onExit);
  child.once("close", onExit);
  return {
    write(message) {
      if (!open) return readFailure();
      let line: string;
      try {
        const json = JSON.stringify(message);
        if (json === undefined) throw error("invalid_json", "runtime");
        line = `${json}\n`;
      } catch { fail("invalid_json", "runtime"); return readFailure(); }
      return new Promise<void>((accept, reject) => {
        writes.add(reject);
        const written = (writeError?: Error | null) => {
          if (writeError) { fail("assessment_input_failed"); return; }
          if (!open) return;
          writes.delete(reject); accept();
        };
        try { child.stdin.write(line, "utf8", written); }
        catch { fail("assessment_input_failed"); }
      });
    },
    next(timeoutMs) {
      if (!open) return readFailure();
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > PRODUCTION_STEWARDSHIP_LIMITS.assessmentTimeoutMs) {
        fail("assessment_deadline"); return readFailure();
      }
      if (waiting) return Promise.reject(error("refused"));
      if (messageIndex < messages.length) {
        const message = messages[messageIndex++];
        if (messageIndex === messages.length) { messages.length = 0; messageIndex = 0; }
        return Promise.resolve(message);
      }
      return new Promise((accept, reject) => {
        waiting = { accept, reject, timer: setTimeout(() => fail("assessment_timeout"), timeoutMs) };
      });
    },
    drain() {
      if (!open) throw failure ?? error("assessment_exit_failed");
      const queued = messages.slice(messageIndex);
      messages.length = 0; messageIndex = 0;
      return queued;
    },
    pending() {
      return open && lineBytes > 0;
    },
    close,
  };
}
