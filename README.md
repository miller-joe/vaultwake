<img src="assets/logo.svg" width="80" height="80" alt="vaultwake">

# vaultwake

One-click [HashiCorp Vault](https://www.vaultproject.io/) unseal + auto-restart of dependent Docker stacks. Built for self-hosted homelabs where Vault gates secrets that other services need at boot.

## What it does

After a server restart, Vault comes up sealed. Anything that depends on a vault-agent sidecar can't fetch its secrets and either crashes or stalls. **vaultwake** is a single-page web app that:

1. Shows Vault's seal status.
2. Takes your unseal key in a single field.
3. Calls Vault's API to unseal.
4. Discovers every Docker Compose stack that has a `vault-agent` service — automatically, no list to maintain.
5. Restarts those stacks with a bounded-concurrency `down` → wait → `up -d`, retries failures, verifies each stack is actually running afterwards, and streams live logs to the browser.
6. Persists every run to `$DATA_DIR/logs/<run-id>/` so you can read what happened the next day. Past runs are browsable in the UI and via `/api/runs`.
7. Lets you opt specific stacks out via a checklist that persists to disk.

By default vaultwake passes `--pull never --no-build` so it never re-downloads or rebuilds images — image management is left to your update pipeline (e.g. bumpsight). Set `COMPOSE_PULL=missing` / `COMPOSE_BUILD=true` if you want different behavior.

## Why not a hardcoded list

Most homelab "restart everything that needs Vault" scripts (mine included) are a hardcoded array of service names. They drift the moment you add a new vault-using stack. vaultwake walks `compose.yaml` files at request time and picks up anything with a `vault-agent:` service. Add a stack — it appears. Remove one — it disappears.

## Run it

```yaml
# compose.yaml
services:
  vaultwake:
    image: ghcr.io/miller-joe/vaultwake:latest
    container_name: vaultwake
    restart: unless-stopped
    ports:
      - "8210:3000"
    environment:
      VAULT_ADDR: http://vault:8200       # how vaultwake reaches Vault
      STACKS_DIR: /stacks                  # where compose files live (mounted)
      DATA_DIR: /data                      # persistent skip-list
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /path/to/your/compose/stacks:/stacks:ro
      - /path/to/persist/vaultwake:/data
    networks:
      - vault_default                       # join Vault's docker network
networks:
  vault_default:
    external: true
```

Then `docker compose up -d` and visit `http://<host>:8210`.

## Config

| Env var | Default | What |
| --- | --- | --- |
| `PORT` | `3000` | Listen port inside the container |
| `VAULT_ADDR` | `http://vault:8200` | Base URL of the Vault API |
| `STACKS_DIR` | `/stacks` | Where to scan for `*/compose.yaml` |
| `DATA_DIR` | `/data` | Where the skip-list and run logs live |
| `STACK_CONCURRENCY` | `4` | How many stacks to `down`/`up` in parallel. Set lower if dockerd is saturating. |
| `STACK_TIMEOUT_MS` | `180000` | Per-stack subprocess timeout. SIGTERM at the limit, SIGKILL 5s later. |
| `STACK_RETRIES` | `1` | Retries per stack on failure (not counting the first attempt). |
| `STACK_RETRY_BACKOFF_MS` | `5000` | Sleep between retry attempts. |
| `WAIT_BETWEEN_MS` | `3000` | Pause after the stop phase before starting. |
| `COMPOSE_PULL` | `never` | `--pull` flag for `compose up`: `never` / `missing` / `always`. |
| `COMPOSE_BUILD` | `false` | If true, allow `compose up` to auto-build. Default passes `--no-build`. |
| `LOG_RETENTION` | `50` | How many past runs to keep on disk (older runs are pruned after each run). |

## Run logs

Every restart writes a directory under `$DATA_DIR/logs/<run-id>/`:

```
20260511-094523-x1y2/
├── meta.json          # options, started/ended, per-stack succeeded/failed/retried
├── combined.log       # every SSE event in chronological order (JSONL)
├── gitea.log          # raw docker-compose output for this stack
├── seafile.log
└── ...
```

You can read them from the "Past runs" panel in the UI, or via the API:

| Endpoint | What |
| --- | --- |
| `GET /api/runs?limit=20` | List recent runs with their `meta.json` (newest first). |
| `GET /api/runs/:id` | One run's `meta.json`. |
| `GET /api/runs/:id/log` | Combined JSONL stream for the run. |
| `GET /api/runs/:id/log/:stack` | Per-stack plain-text log. |

## How stack health is verified

After `compose up -d` exits 0, vaultwake runs `compose ps --format json` for that stack and only marks it OK if every service is in state `running`. This catches the common failure mode where `up -d` returns success but a service exits immediately (e.g. a `vault-agent`-rendered env var didn't make it into the entrypoint). Stacks that fail the post-up check are retried per `STACK_RETRIES` and reported with their failing service in the run summary.

---

## Setting up vault-protected stacks (recommended pattern)

vaultwake is only useful if your stacks actually use Vault for their secrets. Here's the canonical sidecar pattern that vaultwake auto-discovers — it's how every stack in the author's homelab works, and we recommend it for new self-hosters.

### One-time Vault setup

Assuming you have Vault already running with a KV v2 mount at `secrets/`:

```bash
# 1. Enable AppRole auth (one time, server-wide)
vault auth enable approle

# 2. Per-stack: write a policy granting read on this stack's secret path
vault policy write ghost - <<EOF
path "secrets/data/ghost/*" {
  capabilities = ["read"]
}
EOF

# 3. Per-stack: create an AppRole bound to that policy
vault write auth/approle/role/ghost \
  token_policies="ghost" \
  token_ttl=1h \
  token_max_ttl=24h \
  secret_id_ttl=0      # never expires; rotate manually if you prefer

# 4. Pull the role-id and a fresh secret-id (these go on the host disk)
vault read -field=role_id auth/approle/role/ghost/role-id      > role-id
vault write -f -field=secret_id auth/approle/role/ghost/secret-id > secret-id
chmod 0600 role-id secret-id
```

Move `role-id` and `secret-id` into `/your/stacks/<name>/vault/config/`.

### Stack file layout

```
/your/stacks/ghost/
├── compose.yaml
└── vault/
    ├── config/
    │   ├── agent.hcl       # vault-agent config
    │   ├── role-id         # 0600
    │   └── secret-id       # 0600
    └── templates/
        └── ghost.env.tmpl  # what gets rendered into a secrets file
```

### `vault/config/agent.hcl`

```hcl
vault {
  address = "https://vault.example.com"   # or http://vault:8200 over a docker network
}

auto_auth {
  method {
    type = "approle"
    config = {
      role_id_file_path   = "/vault/config/role-id"
      secret_id_file_path = "/vault/config/secret-id"
    }
  }
  sink {
    type = "file"
    config = { path = "/vault/token" }
  }
}

# Render to tmpfs first (avoids permission/atomicity issues on bind mounts),
# then publish to the shared volume the app reads from.
template {
  source      = "/vault/templates/ghost.env.tmpl"
  destination = "/tmp/ghost.env"
  perms       = "0640"
  command     = "install -m 0640 /tmp/ghost.env /vault/secrets/ghost.env"
}
```

### `vault/templates/ghost.env.tmpl`

> ⚠️ **Always use `export KEY=value`, never bare `KEY=value`.** The app's entrypoint will source this file and then `exec` its real binary as a child process; non-exported variables won't propagate. This is the single most common cause of "vault is unsealed but my app still crashes." Put `export` on **every** line.

```hcl
{{- with secret "secrets/data/ghost/database" }}
export MYSQL_ROOT_PASSWORD='{{ .Data.data.MYSQL_ROOT_PASSWORD }}'
export MYSQL_PASSWORD='{{ .Data.data.MYSQL_PASSWORD }}'
{{- end }}
{{- with secret "secrets/data/ghost/smtp" }}
export MAIL_USER='{{ .Data.data.USERNAME }}'
export MAIL_PASS='{{ .Data.data.PASSWORD }}'
{{- end }}
```

### `compose.yaml` for the stack

The vault-agent sidecar must be a **top-level service named exactly `vault-agent`** — that's what vaultwake greps for during discovery.

```yaml
services:
  vault-agent:
    image: hashicorp/vault:1.18
    restart: unless-stopped
    user: "0:0"
    entrypoint: ["/bin/vault"]
    command: ["agent", "-config=/vault/config/agent.hcl"]
    volumes:
      - ./vault/config:/vault/config:ro
      - ./vault/templates:/vault/templates:ro
      - vault-secrets:/vault/secrets

  ghost:
    image: ghost:6-alpine
    restart: unless-stopped
    depends_on:
      vault-agent:
        condition: service_started
    ports:
      - "2368:2368"
    volumes:
      - vault-secrets:/vault/secrets:ro
      - /your/data/ghost:/var/lib/ghost/content
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        set -eu
        # Wait for vault-agent to render the secrets file
        while [ ! -s /vault/secrets/ghost.env ]; do sleep 0.5; done
        . /vault/secrets/ghost.env
        # Re-export anything the app expects in env (some apps only read fresh-init)
        export NODE_ENV=production
        export url=https://ghost.example.com
        # Hand off to the image's real entrypoint
        exec docker-entrypoint.sh node current/index.js

volumes:
  vault-secrets:
```

### Common gotchas

- **`env_file:` doesn't work with these templates.** It parses bare `KEY=value` only and ignores `export`. Always source via `. /vault/secrets/...` inside an inline shell entrypoint.
- **Postgres-style fresh-init traps.** Postgres reads `POSTGRES_PASSWORD` *only on first init*. If your template ever renders the password without `export`, the bug stays latent until the next fresh init (could be years). Some compose entrypoints belt-and-suspender this with an explicit re-export before `exec docker-entrypoint.sh`.
- **The `vault-agent` service name is load-bearing.** vaultwake's discovery looks for that exact key. If you call it `vault_agent`, `vault-sidecar`, or `agent`, vaultwake won't see your stack. (You can opt-in via the skip list in reverse if needed, but renaming is simpler.)
- **Per-stack AppRole, not one shared role.** Sharing one AppRole across stacks means a single compromised app token can read every other app's secrets. The cost of one role per stack is ~30 seconds of `vault write`.

### Adopting the pattern incrementally

You don't need to migrate everything at once. Convert one stack, verify it boots clean after `docker compose down/up -d`, then add the next. vaultwake will pick up new stacks the moment they have a `vault-agent` service in their compose.

---

## Security model

Honest assessment of what this design protects against and what it doesn't.

### What you get

- **Stolen-disk threat**: Vault's file backend is encrypted with the master key, which is never written to disk. Without an unseal key, an attacker with your drives sees ciphertext for every secret.
- **Per-app blast radius**: each stack's AppRole can only read its own KV path. A compromised app container yields one set of secrets, not all of them.
- **Auditable secret access**: turn on Vault's audit log (`vault audit enable file file_path=/vault/logs/audit.log`) and you get a record of every read/write/unseal attempt. vaultwake's unseal calls land here too.
- **No drift**: dynamic discovery means a stack you forget about won't silently miss a restart and run with stale secrets.
- **Reverse-proxy auth**: front vaultwake with NPM Access Lists / Authelia / similar so the unseal field isn't on the open LAN.

### What you don't get (and what to do about it)

- **`docker.sock` mount = root on host.** Necessary for `docker compose down/up -d` to work. Same risk profile as portainer/dozzle. Mitigate by treating vaultwake as privileged and keeping it off the public internet.
- **Browser-typed unseal key.** The key spends a moment in browser memory and travels: browser → reverse proxy → vaultwake → Vault. Use TLS on every hop you can. **Never type your unseal key on a device you don't control.** Store it in a password manager, hardware token, or paper safe — not in shell history, not in a sticky note, not in the same Vault you're trying to unseal.
- **Secret-id files on disk.** `<stack>/vault/config/secret-id` is plaintext on the host filesystem. Anyone with read access to that file can become that AppRole. Keep them `0600` and consider periodic rotation (`vault write -f auth/approle/role/<name>/secret-id`).
- **Single-key Shamir is convenient, not strong.** A 1-of-1 unseal means one key holder can unseal alone. Higher-assurance setups use 3-of-5 or 5-of-9 thresholds so no single person can solo-unseal. vaultwake supports the multi-submit flow if you change Vault's threshold — submit each key in turn, Vault tracks progress.
- **No anomaly detection.** vaultwake doesn't rate-limit unseal attempts itself. Vault does (`max_request_duration`), and the audit log lets you spot brute-force attempts after the fact, but if your reverse-proxy auth is weak, the only thing between an attacker and an unseal attempt is the unseal key itself.

### Is "manual unseal on every restart" a best practice?

It depends on your threat model — there isn't one universally-correct answer.

**HashiCorp's enterprise guidance** leans toward **auto-unseal** via cloud KMS (AWS KMS, GCP KMS, Azure Key Vault) or Vault's own transit secret engine. Auto-unseal means zero downtime on restart, no human in the loop, and HA failover that doesn't require paging someone. The trade-off: your master key now lives wherever the KMS does, and you trust the KMS provider not to read it.

**Manual unseal** (what vaultwake helps with) trades availability for security. The master key never touches the box and never touches a third party. The cost is operational toil — every reboot needs a human, and during the unseal window your secret-consuming services are down.

For a homelab, manual unseal is the right call when:
- you don't want to depend on a cloud KMS for an on-prem service
- restarts are infrequent enough that the toil is acceptable
- you actually care about the stolen-disk threat (otherwise why use Vault at all?)

For production, you should think harder. If downtime is unacceptable, auto-unseal with a hardened KMS is probably correct. If your security model genuinely requires a human-in-the-loop, manual unseal — but then plan for HA, on-call rotation, and the operational cost honestly.

vaultwake exists to make the manual path as painless as possible without removing the human. It does not aim to be the answer for every Vault deployment — it aims to be the right answer for the homelab/single-host pattern where you've decided the trade is worth it.

---

## Development

```bash
npm install
npm run dev
```

Set `VAULT_ADDR`, `STACKS_DIR`, `DATA_DIR` to point at a real or mock environment.

## License

MIT — see [LICENSE](./LICENSE).
