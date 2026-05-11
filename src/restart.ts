import { spawn, type ChildProcess } from "node:child_process";
import type { DiscoveredStack } from "./discovery.js";

export type Phase = "stop" | "wait" | "start" | "verify" | "done";
export type PullPolicy = "always" | "missing" | "never";

export type LogEvent =
  | { type: "run-start"; runId: string; options: RestartOptionsView }
  | { type: "log"; stack: string; line: string }
  | { type: "phase"; phase: Phase; message: string }
  | { type: "stack-attempt"; stack: string; phase: "stop" | "start"; attempt: number; maxAttempts: number }
  | { type: "stack-done"; stack: string; phase: "stop" | "start"; ok: boolean; note?: string }
  | { type: "summary"; succeeded: string[]; failed: string[]; retried: string[]; durationMs: number }
  | { type: "error"; message: string };

export type LogSink = (ev: LogEvent) => void;

export interface RestartOptions {
  concurrency: number;
  timeoutMs: number;
  retries: number;
  retryBackoffMs: number;
  waitBetweenMs: number;
  pull: PullPolicy;
  build: boolean;
}

export type RestartOptionsView = Pick<
  RestartOptions,
  "concurrency" | "timeoutMs" | "retries" | "pull" | "build"
>;

export const DEFAULT_OPTIONS: RestartOptions = {
  concurrency: 4,
  timeoutMs: 180_000,
  retries: 1,
  retryBackoffMs: 5_000,
  waitBetweenMs: 3_000,
  pull: "never",
  build: false,
};

interface ComposeResult {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

export async function restartStacks(
  stacks: DiscoveredStack[],
  options: RestartOptions,
  sink: LogSink,
): Promise<{ succeeded: string[]; failed: string[]; retried: string[] }> {
  const succeeded: string[] = [];
  const failed: string[] = [];
  const retried = new Set<string>();

  if (stacks.length === 0) {
    sink({ type: "phase", phase: "done", message: "No stacks to restart." });
    return { succeeded, failed, retried: [] };
  }

  sink({
    type: "phase",
    phase: "stop",
    message: `Stopping ${stacks.length} stacks (concurrency=${options.concurrency})...`,
  });
  const stopResults = await runWithLimit(stacks, options.concurrency, async (s) => {
    const ok = await runWithRetries(s, "stop", options, sink, retried);
    return { stack: s, ok };
  });
  const stopFailed = stopResults.filter((r) => !r.ok).map((r) => r.stack.name);
  if (stopFailed.length > 0) {
    sink({
      type: "log",
      stack: "(vaultwake)",
      line: `WARN: ${stopFailed.length} stack(s) failed to stop cleanly: ${stopFailed.join(", ")}. Proceeding with start phase anyway.`,
    });
  }

  sink({
    type: "phase",
    phase: "wait",
    message: `Waiting ${options.waitBetweenMs / 1000}s before starting...`,
  });
  await sleep(options.waitBetweenMs);

  sink({
    type: "phase",
    phase: "start",
    message: `Starting ${stacks.length} stacks (concurrency=${options.concurrency}, pull=${options.pull}, build=${options.build})...`,
  });
  const startResults = await runWithLimit(stacks, options.concurrency, async (s) => {
    const ok = await runWithRetries(s, "start", options, sink, retried);
    return { stack: s, ok };
  });

  for (const r of startResults) {
    if (r.ok) succeeded.push(r.stack.name);
    else failed.push(r.stack.name);
  }

  return { succeeded, failed, retried: [...retried] };
}

async function runWithRetries(
  stack: DiscoveredStack,
  phase: "stop" | "start",
  options: RestartOptions,
  sink: LogSink,
  retriedSet: Set<string>,
): Promise<boolean> {
  const maxAttempts = options.retries + 1;
  let lastNote: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      retriedSet.add(stack.name);
      sink({ type: "stack-attempt", stack: stack.name, phase, attempt, maxAttempts });
      await sleep(options.retryBackoffMs);
    }

    const result = await runCompose(stack, phase, options, sink);
    if (result.ok && phase === "start") {
      const verify = await verifyStackHealth(stack, sink);
      if (!verify.ok) {
        lastNote = verify.note;
        if (attempt < maxAttempts) continue;
        sink({ type: "stack-done", stack: stack.name, phase, ok: false, note: verify.note });
        return false;
      }
      sink({ type: "stack-done", stack: stack.name, phase, ok: true, note: verify.note });
      return true;
    }

    if (result.ok) {
      sink({ type: "stack-done", stack: stack.name, phase, ok: true });
      return true;
    }

    lastNote = composeFailureNote(result);
    if (attempt < maxAttempts) continue;
    sink({ type: "stack-done", stack: stack.name, phase, ok: false, note: lastNote });
    return false;
  }
  return false;
}

function composeFailureNote(r: ComposeResult): string {
  if (r.timedOut) return `timed out (killed with ${r.signal ?? "SIGKILL"})`;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.exitCode}`;
}

function runCompose(
  stack: DiscoveredStack,
  phase: "stop" | "start",
  options: RestartOptions,
  sink: LogSink,
): Promise<ComposeResult> {
  const args = ["compose", "-f", stack.composeFile];
  if (phase === "stop") {
    args.push("down");
  } else {
    args.push("up", "-d", `--pull=${options.pull}`);
    if (!options.build) args.push("--no-build");
  }

  sink({ type: "log", stack: stack.name, line: `$ docker ${args.join(" ")}` });

  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    const result: ComposeResult = { ok: false, exitCode: null, signal: null, timedOut: false };

    const timer = setTimeout(() => {
      result.timedOut = true;
      sink({
        type: "log",
        stack: stack.name,
        line: `WARN: ${phase} exceeded ${options.timeoutMs / 1000}s — sending SIGTERM`,
      });
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!child.killed) {
          sink({ type: "log", stack: stack.name, line: "WARN: still running — sending SIGKILL" });
          child.kill("SIGKILL");
        }
      }, 5_000);
    }, options.timeoutMs);

    streamChildOutput(child, stack.name, sink);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      result.exitCode = code;
      result.signal = signal;
      result.ok = !result.timedOut && code === 0;
      resolve(result);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      sink({ type: "error", message: `${stack.name}: spawn failed: ${err.message}` });
      result.ok = false;
      resolve(result);
    });
  });
}

function streamChildOutput(child: ChildProcess, stack: string, sink: LogSink): void {
  const onData = (buf: Buffer): void => {
    for (const raw of buf.toString("utf8").split("\n")) {
      const line = raw.trimEnd();
      if (!line) continue;
      sink({ type: "log", stack, line });
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
}

interface VerifyResult {
  ok: boolean;
  note: string;
}

// After `compose up -d` exits 0, ask compose which services are actually running.
// `up -d` can return success while individual services exit immediately (bad env,
// vault-rendered secrets missing, image entrypoint failure, etc.).
async function verifyStackHealth(
  stack: DiscoveredStack,
  sink: LogSink,
): Promise<VerifyResult> {
  const out = await captureCommand("docker", [
    "compose",
    "-f",
    stack.composeFile,
    "ps",
    "--format",
    "json",
  ]);
  if (out.exitCode !== 0) {
    sink({
      type: "log",
      stack: stack.name,
      line: `WARN: post-up 'compose ps' exited ${out.exitCode}: ${out.stderr.trim()}`,
    });
    return { ok: false, note: `compose ps exit ${out.exitCode}` };
  }

  const services = parseComposePs(out.stdout);
  if (services.length === 0) {
    return { ok: false, note: "no services reported after up" };
  }

  const bad = services.filter((s) => s.state !== "running");
  for (const svc of services) {
    sink({
      type: "log",
      stack: stack.name,
      line: `  service ${svc.name}: state=${svc.state}${svc.exitCode !== null ? ` exit=${svc.exitCode}` : ""}${svc.health ? ` health=${svc.health}` : ""}`,
    });
  }
  if (bad.length > 0) {
    return {
      ok: false,
      note: `${bad.length}/${services.length} service(s) not running: ${bad.map((s) => `${s.name}=${s.state}`).join(", ")}`,
    };
  }
  return { ok: true, note: `${services.length} service(s) running` };
}

interface ComposeService {
  name: string;
  state: string;
  exitCode: number | null;
  health: string | null;
}

function parseComposePs(stdout: string): ComposeService[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  const services: ComposeService[] = [];

  // Compose v2 emits either a single JSON array, or one JSON object per line
  // depending on minor version. Try array first, fall back to JSONL.
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      for (const obj of parsed) services.push(normaliseService(obj));
      return services;
    }
  } catch {
    /* fall through to JSONL */
  }
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      services.push(normaliseService(JSON.parse(line)));
    } catch {
      /* skip malformed line */
    }
  }
  return services;
}

function normaliseService(obj: unknown): ComposeService {
  const o = obj as Record<string, unknown>;
  const name = String(o["Service"] ?? o["Name"] ?? "?");
  const state = String(o["State"] ?? "unknown").toLowerCase();
  const exitCode = typeof o["ExitCode"] === "number" ? (o["ExitCode"] as number) : null;
  const healthRaw = o["Health"];
  const health = typeof healthRaw === "string" && healthRaw.length > 0 ? healthRaw : null;
  return { name, state, exitCode, health };
}

interface CapturedCommand {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function captureCommand(cmd: string, args: string[]): Promise<CapturedCommand> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    child.on("error", (err) => resolve({ exitCode: null, stdout, stderr: stderr + err.message }));
  });
}

async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return results;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
