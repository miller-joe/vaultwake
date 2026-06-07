import { promises as fs, createWriteStream, type WriteStream } from "node:fs";
import path from "node:path";
import type { LogEvent } from "./restart.js";

export interface RunOptionsMeta {
  concurrency: number;
  timeoutMs: number;
  retries: number;
  pull: "always" | "missing" | "never";
  build: boolean;
  strategy: "recreate" | "down-up";
}

export interface RunMeta {
  runId: string;
  startedAt: string;
  endedAt?: string;
  options: RunOptionsMeta;
  stacks: string[];
  result?: RunResult;
}

export interface RunResult {
  succeeded: string[];
  failed: string[];
  retried: string[];
  skipped: number;
  durationMs: number;
}

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export class RunLog {
  private readonly dir: string;
  private readonly streams = new Map<string, WriteStream>();
  private readonly combined: WriteStream;
  private readonly started = Date.now();
  private meta: RunMeta;

  static newRunId(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const rand = Math.random().toString(36).slice(2, 6);
    return `${d}-${t}-${rand}`;
  }

  static async create(
    dataDir: string,
    options: RunOptionsMeta,
    stacks: string[],
  ): Promise<RunLog> {
    const runId = RunLog.newRunId();
    const dir = path.join(dataDir, "logs", runId);
    await fs.mkdir(dir, { recursive: true });
    const meta: RunMeta = {
      runId,
      startedAt: new Date().toISOString(),
      options,
      stacks,
    };
    const rl = new RunLog(dir, meta);
    await rl.persistMeta();
    return rl;
  }

  private constructor(dir: string, meta: RunMeta) {
    this.dir = dir;
    this.meta = meta;
    this.combined = createWriteStream(path.join(dir, "combined.log"), { flags: "a" });
  }

  get runId(): string {
    return this.meta.runId;
  }

  record(ev: LogEvent): void {
    const ts = new Date().toISOString();
    this.combined.write(`${ts} ${JSON.stringify(ev)}\n`);
    if (ev.type === "log") {
      this.stackStream(ev.stack).write(`${ts} ${ev.line}\n`);
    } else if (ev.type === "stack-done") {
      const status = ev.ok ? "OK" : "FAILED";
      const note = ev.note ? ` ${ev.note}` : "";
      this.stackStream(ev.stack).write(`${ts} [${ev.phase} ${status}${note}]\n`);
    } else if (ev.type === "stack-attempt") {
      this.stackStream(ev.stack).write(`${ts} [${ev.phase} attempt ${ev.attempt}/${ev.maxAttempts}]\n`);
    }
  }

  private stackStream(stack: string): WriteStream {
    let s = this.streams.get(stack);
    if (!s) {
      s = createWriteStream(path.join(this.dir, `${safeName(stack)}.log`), { flags: "a" });
      this.streams.set(stack, s);
    }
    return s;
  }

  async finish(result: Omit<RunResult, "durationMs">): Promise<void> {
    this.meta.endedAt = new Date().toISOString();
    this.meta.result = { ...result, durationMs: Date.now() - this.started };
    await this.persistMeta();
    await Promise.all(
      [...this.streams.values(), this.combined].map(
        (s) => new Promise<void>((resolve) => s.end(resolve)),
      ),
    );
  }

  private async persistMeta(): Promise<void> {
    await fs.writeFile(
      path.join(this.dir, "meta.json"),
      JSON.stringify(this.meta, null, 2) + "\n",
      "utf8",
    );
  }

  static async listRuns(dataDir: string, limit = 50): Promise<RunMeta[]> {
    const logsDir = path.join(dataDir, "logs");
    let ids: string[];
    try {
      ids = await fs.readdir(logsDir);
    } catch {
      return [];
    }
    ids.sort().reverse();
    const out: RunMeta[] = [];
    for (const id of ids.slice(0, limit)) {
      const meta = await RunLog.loadMeta(dataDir, id);
      if (meta) out.push(meta);
    }
    return out;
  }

  static async loadMeta(dataDir: string, runId: string): Promise<RunMeta | null> {
    try {
      const text = await fs.readFile(
        path.join(dataDir, "logs", runId, "meta.json"),
        "utf8",
      );
      return JSON.parse(text) as RunMeta;
    } catch {
      return null;
    }
  }

  static async loadStackLog(
    dataDir: string,
    runId: string,
    stack: string,
  ): Promise<string | null> {
    try {
      return await fs.readFile(
        path.join(dataDir, "logs", runId, `${safeName(stack)}.log`),
        "utf8",
      );
    } catch {
      return null;
    }
  }

  static async loadCombined(dataDir: string, runId: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(dataDir, "logs", runId, "combined.log"), "utf8");
    } catch {
      return null;
    }
  }

  // Keep only the newest `keep` runs.
  static async prune(dataDir: string, keep: number): Promise<void> {
    const logsDir = path.join(dataDir, "logs");
    let ids: string[];
    try {
      ids = await fs.readdir(logsDir);
    } catch {
      return;
    }
    ids.sort().reverse();
    for (const id of ids.slice(keep)) {
      await fs.rm(path.join(logsDir, id), { recursive: true, force: true });
    }
  }
}
