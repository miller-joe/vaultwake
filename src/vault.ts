export interface SealStatus {
  sealed: boolean;
  threshold: number;
  progress: number;
  version: string;
  initialized: boolean;
}

export class VaultClient {
  constructor(private addr: string) {}

  async sealStatus(): Promise<SealStatus> {
    const res = await fetch(`${this.addr}/v1/sys/seal-status`);
    if (!res.ok) throw new Error(`vault seal-status: HTTP ${res.status}`);
    const body = (await res.json()) as SealStatus;
    return body;
  }

  async unseal(key: string): Promise<SealStatus> {
    const res = await fetch(`${this.addr}/v1/sys/unseal`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`vault unseal: HTTP ${res.status}: ${text}`);
    }
    return (await res.json()) as SealStatus;
  }
}
