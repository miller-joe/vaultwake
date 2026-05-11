import { promises as fs } from "node:fs";
import path from "node:path";

export class SkipList {
  private file: string;
  private cache: Set<string> | null = null;

  constructor(dataDir: string) {
    this.file = path.join(dataDir, "skip.json");
  }

  async load(): Promise<Set<string>> {
    if (this.cache) return this.cache;
    try {
      const text = await fs.readFile(this.file, "utf8");
      const arr = JSON.parse(text);
      this.cache = new Set(Array.isArray(arr) ? arr : []);
    } catch {
      this.cache = new Set();
    }
    return this.cache;
  }

  async save(skipped: string[]): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true });
    const sorted = [...new Set(skipped)].sort();
    await fs.writeFile(this.file, JSON.stringify(sorted, null, 2) + "\n", "utf8");
    this.cache = new Set(sorted);
  }
}
