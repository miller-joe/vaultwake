import { spawn } from "node:child_process";
import type { DiscoveredStack } from "./discovery.js";

export type LogEvent = { type: "log"; stack: string; line: string }
  | { type: "phase"; phase: "stop" | "wait" | "start" | "done"; message: string }
  | { type: "stack-done"; stack: string; phase: "stop" | "start"; ok: boolean }
  | { type: "error"; message: string };

export type LogSink = (ev: LogEvent) => void;

const WAIT_BETWEEN_MS = 3000;

export async function restartStacks(stacks: DiscoveredStack[], sink: LogSink): Promise<void> {
  if (stacks.length === 0) {
    sink({ type: "phase", phase: "done", message: "No stacks to restart." });
    return;
  }

  sink({ type: "phase", phase: "stop", message: `Stopping ${stacks.length} stacks (parallel)...` });
  await Promise.all(stacks.map((s) => runCompose(s, "down", sink)));

  sink({ type: "phase", phase: "wait", message: `Waiting ${WAIT_BETWEEN_MS / 1000}s before starting...` });
  await sleep(WAIT_BETWEEN_MS);

  sink({ type: "phase", phase: "start", message: `Starting ${stacks.length} stacks (parallel)...` });
  await Promise.all(stacks.map((s) => runCompose(s, "up", sink)));

  sink({ type: "phase", phase: "done", message: "All done." });
}

function runCompose(stack: DiscoveredStack, op: "down" | "up", sink: LogSink): Promise<void> {
  const args = op === "down"
    ? ["compose", "-f", stack.composeFile, "down"]
    : ["compose", "-f", stack.composeFile, "up", "-d"];

  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });

    const onData = (buf: Buffer) => {
      for (const raw of buf.toString("utf8").split("\n")) {
        const line = raw.trimEnd();
        if (!line) continue;
        if (line.includes("level=warning")) continue;
        sink({ type: "log", stack: stack.name, line });
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => {
      const ok = code === 0;
      sink({ type: "stack-done", stack: stack.name, phase: op === "down" ? "stop" : "start", ok });
      if (!ok) sink({ type: "log", stack: stack.name, line: `(exit ${code})` });
      resolve();
    });
    child.on("error", (err) => {
      sink({ type: "error", message: `${stack.name}: ${err.message}` });
      resolve();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
