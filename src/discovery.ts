import { promises as fs } from "node:fs";
import path from "node:path";
import YAML from "yaml";

export interface DiscoveredStack {
  name: string;
  composeFile: string;
}

const ALWAYS_EXCLUDE = new Set(["vault", "vaultwake"]);

export async function discoverStacks(stacksDir: string): Promise<DiscoveredStack[]> {
  const entries = await fs.readdir(stacksDir, { withFileTypes: true });
  const results: DiscoveredStack[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ALWAYS_EXCLUDE.has(entry.name)) continue;

    const composeFile = await findComposeFile(path.join(stacksDir, entry.name));
    if (!composeFile) continue;

    if (await hasVaultAgent(composeFile)) {
      results.push({ name: entry.name, composeFile });
    }
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

async function findComposeFile(dir: string): Promise<string | null> {
  for (const candidate of ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]) {
    const full = path.join(dir, candidate);
    try {
      await fs.access(full);
      return full;
    } catch {
      // try next
    }
  }
  return null;
}

async function hasVaultAgent(composeFile: string): Promise<boolean> {
  try {
    const text = await fs.readFile(composeFile, "utf8");
    const doc = YAML.parse(text);
    const services = doc?.services;
    if (!services || typeof services !== "object") return false;
    return Object.prototype.hasOwnProperty.call(services, "vault-agent");
  } catch {
    return false;
  }
}
