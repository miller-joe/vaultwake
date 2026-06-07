import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverStacks } from "./discovery.js";
import { VaultClient } from "./vault.js";
import { SkipList } from "./skiplist.js";
import {
  restartStacks,
  DEFAULT_OPTIONS,
  type LogEvent,
  type LogSink,
  type RestartOptions,
  type PullPolicy,
  type RestartStrategy,
} from "./restart.js";
import { RunLog, type RunOptionsMeta } from "./runLog.js";

const PORT = Number(process.env.PORT ?? 3000);
const VAULT_ADDR = process.env.VAULT_ADDR ?? "http://vault:8200";
const STACKS_DIR = process.env.STACKS_DIR ?? "/stacks";
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const LOG_RETENTION = Number(process.env.LOG_RETENTION ?? 50);

const options: RestartOptions = {
  ...DEFAULT_OPTIONS,
  concurrency: positiveInt(process.env.STACK_CONCURRENCY, DEFAULT_OPTIONS.concurrency),
  timeoutMs: positiveInt(process.env.STACK_TIMEOUT_MS, DEFAULT_OPTIONS.timeoutMs),
  retries: nonNegativeInt(process.env.STACK_RETRIES, DEFAULT_OPTIONS.retries),
  retryBackoffMs: positiveInt(process.env.STACK_RETRY_BACKOFF_MS, DEFAULT_OPTIONS.retryBackoffMs),
  waitBetweenMs: nonNegativeInt(process.env.WAIT_BETWEEN_MS, DEFAULT_OPTIONS.waitBetweenMs),
  pull: parsePull(process.env.COMPOSE_PULL),
  build: parseBool(process.env.COMPOSE_BUILD, DEFAULT_OPTIONS.build),
  strategy: parseStrategy(process.env.RESTART_STRATEGY),
};

function positiveInt(s: string | undefined, fallback: number): number {
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function nonNegativeInt(s: string | undefined, fallback: number): number {
  const n = s ? Number(s) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function parsePull(s: string | undefined): PullPolicy {
  if (s === "always" || s === "missing" || s === "never") return s;
  return DEFAULT_OPTIONS.pull;
}
function parseStrategy(s: string | undefined): RestartStrategy {
  if (s === "recreate" || s === "down-up") return s;
  return DEFAULT_OPTIONS.strategy;
}
function parseBool(s: string | undefined, fallback: boolean): boolean {
  if (s === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(s);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");

const vault = new VaultClient(VAULT_ADDR);
const skipList = new SkipList(DATA_DIR);

const app = express();
app.use(express.json({ limit: "16kb" }));
app.use(express.static(PUBLIC_DIR));

app.get("/api/status", async (_req, res) => {
  try {
    const [seal, stacks, skipped] = await Promise.all([
      vault.sealStatus().catch((e: Error) => ({ error: e.message })),
      discoverStacks(STACKS_DIR),
      skipList.load(),
    ]);
    res.json({
      vaultAddr: VAULT_ADDR,
      seal,
      stacks: stacks.map((s) => ({ name: s.name, skipped: skipped.has(s.name) })),
      options: optionsView(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/skip", async (req: Request, res: Response) => {
  const skipped = req.body?.skipped;
  if (!Array.isArray(skipped) || !skipped.every((x: unknown) => typeof x === "string")) {
    return res.status(400).json({ error: "skipped must be string[]" });
  }
  await skipList.save(skipped);
  res.json({ ok: true, skipped });
});

app.post("/api/unseal", async (req: Request, res: Response) => {
  const key = req.body?.key;
  if (typeof key !== "string" || key.length === 0) {
    return res.status(400).json({ error: "key required" });
  }
  try {
    const status = await vault.unseal(key.trim());
    res.json({ ok: true, seal: status });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

app.get("/api/restart", async (req: Request, res: Response) => {
  res.set({
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  const send = (ev: LogEvent): void => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  let closed = false;
  req.on("close", () => { closed = true; });

  const [stacks, skipped] = await Promise.all([
    discoverStacks(STACKS_DIR),
    skipList.load(),
  ]);
  const targets = stacks.filter((s) => !skipped.has(s.name));

  const optsMeta: RunOptionsMeta = optionsView();
  const runLog = await RunLog.create(DATA_DIR, optsMeta, targets.map((s) => s.name));
  console.log(`[run ${runLog.runId}] starting, ${targets.length} stacks, ${skipped.size} skipped`);

  const sink: LogSink = (ev) => {
    runLog.record(ev);
    if (!closed) send(ev);
  };

  sink({ type: "run-start", runId: runLog.runId, options: optsMeta });
  sink({
    type: "phase",
    phase: "stop",
    message: `Discovered ${stacks.length} stacks, ${targets.length} after skip filter. Run ID: ${runLog.runId}`,
  });

  const startedAt = Date.now();
  let result: { succeeded: string[]; failed: string[]; retried: string[] } = {
    succeeded: [],
    failed: [],
    retried: [],
  };
  try {
    result = await restartStacks(targets, options, sink);
  } catch (err) {
    sink({ type: "error", message: (err as Error).message });
  }

  const summary: LogEvent = {
    type: "summary",
    succeeded: result.succeeded,
    failed: result.failed,
    retried: result.retried,
    durationMs: Date.now() - startedAt,
  };
  sink(summary);
  sink({
    type: "phase",
    phase: "done",
    message: `Done in ${(summary.durationMs / 1000).toFixed(1)}s — ${result.succeeded.length} ok, ${result.failed.length} failed${result.retried.length > 0 ? `, ${result.retried.length} retried` : ""}.`,
  });

  await runLog.finish({
    succeeded: result.succeeded,
    failed: result.failed,
    retried: result.retried,
    skipped: skipped.size,
  });
  console.log(`[run ${runLog.runId}] finished: ${result.succeeded.length} ok, ${result.failed.length} failed`);

  RunLog.prune(DATA_DIR, LOG_RETENTION).catch((e: Error) => {
    console.error(`[run ${runLog.runId}] prune error: ${e.message}`);
  });

  res.end();
});

app.get("/api/runs", async (_req, res) => {
  const limit = Math.max(1, Math.min(200, Number(_req.query.limit) || 50));
  const runs = await RunLog.listRuns(DATA_DIR, limit);
  res.json({ runs });
});

app.get("/api/runs/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!isSafeId(id)) return res.status(400).json({ error: "bad run id" });
  const meta = await RunLog.loadMeta(DATA_DIR, id);
  if (!meta) return res.status(404).json({ error: "not found" });
  res.json(meta);
});

app.get("/api/runs/:id/log", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  if (!isSafeId(id)) return res.status(400).send("bad run id");
  const text = await RunLog.loadCombined(DATA_DIR, id);
  if (text === null) return res.status(404).send("not found");
  res.set("content-type", "text/plain; charset=utf-8");
  res.send(text);
});

app.get("/api/runs/:id/log/:stack", async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const stack = String(req.params.stack);
  if (!isSafeId(id) || !isSafeStack(stack)) return res.status(400).send("bad id");
  const text = await RunLog.loadStackLog(DATA_DIR, id, stack);
  if (text === null) return res.status(404).send("not found");
  res.set("content-type", "text/plain; charset=utf-8");
  res.send(text);
});

function optionsView(): RunOptionsMeta {
  return {
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    pull: options.pull,
    build: options.build,
    strategy: options.strategy,
  };
}

function isSafeId(id: string): boolean {
  return /^[0-9]{8}-[0-9]{6}-[a-z0-9]{1,8}$/.test(id);
}
function isSafeStack(s: string): boolean {
  return /^[a-zA-Z0-9_.-]{1,80}$/.test(s);
}

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `vaultwake listening on :${PORT} (vault=${VAULT_ADDR}, stacks=${STACKS_DIR}, data=${DATA_DIR}, ` +
      `strategy=${options.strategy}, concurrency=${options.concurrency}, pull=${options.pull}, build=${options.build}, ` +
      `retries=${options.retries}, timeout=${options.timeoutMs}ms)`,
  );
});
