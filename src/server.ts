import express, { type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverStacks } from "./discovery.js";
import { VaultClient } from "./vault.js";
import { SkipList } from "./skiplist.js";
import { restartStacks, type LogEvent } from "./restart.js";

const PORT = Number(process.env.PORT ?? 3000);
const VAULT_ADDR = process.env.VAULT_ADDR ?? "http://vault:8200";
const STACKS_DIR = process.env.STACKS_DIR ?? "/stacks";
const DATA_DIR = process.env.DATA_DIR ?? "/data";

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

// SSE: stream a restart run.
app.get("/api/restart", async (req: Request, res: Response) => {
  res.set({
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.flushHeaders();

  const send = (ev: LogEvent) => {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  let closed = false;
  req.on("close", () => { closed = true; });

  try {
    const [stacks, skipped] = await Promise.all([
      discoverStacks(STACKS_DIR),
      skipList.load(),
    ]);
    const targets = stacks.filter((s) => !skipped.has(s.name));
    send({ type: "phase", phase: "stop", message: `Discovered ${stacks.length} stacks, ${targets.length} after skip filter.` });

    await restartStacks(targets, (ev) => {
      if (!closed) send(ev);
    });
  } catch (err) {
    send({ type: "error", message: (err as Error).message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`vaultwake listening on :${PORT} (vault=${VAULT_ADDR}, stacks=${STACKS_DIR}, data=${DATA_DIR})`);
});
