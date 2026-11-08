# Run Open Accountant on a home server (Docker)

This puts the Open Accountant dashboard on a machine that is always on, such as a NAS, a mini PC, or a Linux box, so you can open it from any computer or phone on your home network. Your financial data stays on that machine, in one Docker volume.

You need Docker with Compose v2 (the `docker compose` command). Unraid, Synology (Container Manager), Proxmox, and any Linux machine all have it.

## Quick start

On the server:

```bash
mkdir wilson && cd wilson
curl -fsSLO https://raw.githubusercontent.com/openaccountant/wilson/main/docker-compose.yml
```

Create a file named `.env` in the same folder. It holds the names you type in your browser to reach the server:

```bash
WILSON_LAN_HOSTS=nas.local,192.168.1.20
```

Use your server's real hostname and IP address here.

Start it:

```bash
docker compose up -d
docker compose logs wilson
```

On first start, the log prints a box with the admin **username and password**:

```
================================================================
 Dashboard admin account created (dashboard login is now ON).
   username: admin
   password: 3vQ...
```

Open `http://nas.local:3141` (use your own name or IP), then sign in. If the log has scrolled away, the password is also saved inside the volume. To read it, then delete it:

```bash
docker compose exec wilson cat /data/.openaccountant/profiles/default/initial-admin-password
docker compose exec wilson rm /data/.openaccountant/profiles/default/initial-admin-password
```

To choose the password yourself, put `WILSON_ADMIN_PASSWORD=...` (8 or more characters) in `.env` **before the first start**. Once any dashboard user exists, these settings are ignored. They never reset a password.

### Why there is a login

Anyone on your network could otherwise read your books. When the dashboard listens on the network, it refuses to start unless dashboard login is on and an admin account exists. The container sets this up for you on first start. You can add more people (admins or read-only viewers) under Settings in the dashboard.

## Add a local AI model (optional)

The chat can run on a model on your own server, so nothing leaves your network:

```bash
docker compose --profile local-ai up -d
```

This also starts Ollama and downloads `granite4.1:3b`, about 2 GB, so the first start takes a few minutes. Open Open Accountant once the download has finished:

```bash
docker compose --profile local-ai logs -f ollama-pull
```

To use a different model, set `OLLAMA_MODEL=gemma3:4b` in `.env`. Small models (3 to 4B) run on CPU. For an NVIDIA GPU, uncomment the `deploy:` block under `ollama` in `docker-compose.yml`.

Already running Ollama somewhere else? Skip the profile and put its address in `.env`: `WILSON_OLLAMA_URL=http://192.168.1.30:11434`.

To use a cloud model instead, put its API key in `.env` (for example `ANTHROPIC_API_KEY=...`), then pick the model under Settings → Models. The model chosen in Settings always wins over the defaults above.

## Settings (`.env`)

| Setting | What it does | Default |
|---|---|---|
| `WILSON_LAN_HOSTS` | Names/IPs you type in the browser, comma-separated. Any other name is refused. | (only `localhost`) |
| `WILSON_HOST_PORT` | Port on the server. | `3141` |
| `WILSON_ADMIN_USERNAME` / `WILSON_ADMIN_PASSWORD` | First-start admin account. | `admin` / random |
| `OLLAMA_MODEL` | Model the local-ai profile downloads and uses. | `granite4.1:3b` |
| `WILSON_OLLAMA_URL` | Ollama to talk to. | `http://ollama:11434` |
| `WILSON_IMAGE` | Image tag, to stay on a specific version. | `ghcr.io/openaccountant/wilson:latest` |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, ... | Cloud model keys (see `env.example`). | none |

**Changing the port:** if you set `WILSON_HOST_PORT=8080`, open the dashboard by a name listed in `WILSON_LAN_HOSTS` (`http://nas.local:8080`). `http://localhost:8080` will not work.

**Behind a reverse proxy with HTTPS** (Caddy, Traefik, Nginx Proxy Manager, Synology's reverse proxy): add the public name to `WILSON_LAN_HOSTS`, and the full origin to `.env`:

```bash
WILSON_LAN_HOSTS=wilson.example.com
WILSON_DASHBOARD_ALLOWED_ORIGINS=https://wilson.example.com
```

The proxy must pass the original `Host` header through, which is the default for all four.

Do not expose the dashboard directly to the internet. Use a VPN (Tailscale, WireGuard) or a proxy with its own login in front of it.

## Backups

Everything (database, settings, logs, downloaded models) is in the `wilson-data` volume. **Back up the volume and you have backed up Open Accountant.**

```bash
docker compose stop wilson
docker run --rm -v wilson_wilson-data:/data -v "$PWD":/backup debian:bookworm-slim \
  tar czf /backup/wilson-backup-$(date +%F).tgz -C /data .
docker compose start wilson
```

To restore, stop the container, unpack the archive into an empty `wilson_wilson-data` volume the same way (`tar xzf`), then start it again. Stopping first keeps the database consistent.

The volume name is `<folder>_wilson-data`. If your folder is not called `wilson`, run `docker volume ls` to see the real name.

## Updating

```bash
docker compose pull
docker compose up -d
```

Your data volume is kept. To stay on one version, set `WILSON_IMAGE=ghcr.io/openaccountant/wilson:0.10.1` (or another tag).

## Platform notes

**Unraid.** Install the *Docker Compose Manager* plugin, add a new stack, paste `docker-compose.yml`, and put the settings in the stack's env file. To keep data on the array instead of in a Docker volume, replace `wilson-data:/data` with `/mnt/user/appdata/wilson:/data`. That folder must be writable by UID 1000: `chown -R 1000:1000 /mnt/user/appdata/wilson`.

**Synology (DSM 7.2+).** Open *Container Manager*, then *Project*, then *Create*. Point it at a folder such as `/volume1/docker/wilson`, upload `docker-compose.yml`, and add a `.env` file there. For a shared-folder path instead of a volume, use `/volume1/docker/wilson/data:/data` and give UID 1000 write access. Use the NAS's IP or `<name>.local` in `WILSON_LAN_HOSTS`.

**Proxmox.** Run it in a small Debian or Ubuntu VM, or in an LXC container with nesting enabled (*Options*, then *Features*, then `nesting=1`), with Docker installed. Then follow the quick start. 2 GB of RAM is enough for the dashboard. Give it 6 GB or more with the local-ai profile.

**Plain Linux.** Install Docker Engine and the compose plugin from your distribution or docs.docker.com, then follow the quick start. The container restarts on its own after a reboot (`restart: unless-stopped`).

Images are published for `linux/amd64` and `linux/arm64`, so a Raspberry Pi 4/5 with a 64-bit OS works too.

## Troubleshooting

- **Blank page or "421" in the browser**: the name in your address bar is not in `WILSON_LAN_HOSTS`. Add it, then run `docker compose up -d`.
- **"Refusing to bind the dashboard"** in the log: no active admin account is left (for example, the last admin was deactivated). The container switches login back on by itself when an admin exists. Without one, restore the volume from a backup.
- **Chat says the model is not available**: with local-ai, wait for `ollama-pull` to finish. Without it, pick a model under Settings → Models or add an API key.
- **Health**: `docker compose ps` shows `healthy` once the dashboard answers.
