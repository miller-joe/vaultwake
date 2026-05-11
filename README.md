# vaultwake

One-click [HashiCorp Vault](https://www.vaultproject.io/) unseal + auto-restart of dependent Docker stacks. Built for self-hosted homelabs where Vault gates secrets that other services need at boot.

## What it does

After a server restart, Vault comes up sealed. Anything that depends on a vault-agent sidecar can't fetch its secrets and either crashes or stalls. **vaultwake** is a single-page web app that:

1. Shows Vault's seal status.
2. Takes your unseal key in a single field.
3. Calls Vault's API to unseal.
4. Discovers every Docker Compose stack that has a `vault-agent` service — automatically, no list to maintain.
5. Restarts those stacks (parallel `down` → wait → parallel `up -d`), streaming live logs to the browser.
6. Lets you opt specific stacks out via a checklist that persists to disk.

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
| `DATA_DIR` | `/data` | Where the skip-list JSON lives |

## Security notes

- vaultwake mounts `/var/run/docker.sock` (root-equivalent on the host). Treat it the way you'd treat dozzle or portainer.
- The unseal page has no built-in auth. Front it with a reverse proxy that does basic auth (Nginx Proxy Manager Access Lists work well) and keep it off the public internet.
- The unseal key is only sent over the network between your browser and vaultwake, and from vaultwake to Vault. Use TLS for both hops.

## Development

```bash
npm install
npm run dev
```

Set `VAULT_ADDR`, `STACKS_DIR`, `DATA_DIR` to point at a real or mock environment.

## License

MIT — see [LICENSE](./LICENSE).
