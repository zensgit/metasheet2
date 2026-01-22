# GHCR Deployment Scripts

This repo includes two helper scripts for deploying the Docker images from GHCR.

## Scripts

- `scripts/deploy-ghcr.sh`: Uses a GitHub username + PAT (`read:packages`) to log in.
- `scripts/deploy-ghcr-gh.sh`: Uses `gh` CLI auth to log in and fetch the GHCR token.

## Prerequisites

- Ubuntu host with `sudo` access
- Ports open: `WEB_PORT` (default 8080), `8900` bound to localhost
- Access to GHCR images for `zensgit/metasheet2`

## Usage

```sh
bash scripts/deploy-ghcr.sh
```

Or with GitHub CLI:

```sh
bash scripts/deploy-ghcr-gh.sh
```

## What the scripts do

- Install Docker, Compose, Git, Curl, OpenSSL (and `gh` for the CLI version)
- Clone or update `https://github.com/zensgit/metasheet2.git` into `$HOME/metasheet2`
- Create `docker/app.env` if missing (credentials are generated and stored locally)
- Create `docker-compose.override.yml` to map ports
- Pull and run `docker-compose.app.yml`
- Run migrations with `packages/core-backend/dist/db/migrate.js`

## Notes

- `docker/app.env` and `docker-compose.override.yml` are gitignored.
- To change the web port or image tag, edit `WEB_PORT` or `IMAGE_TAG` near the top of the script.
- If you want to avoid `sudo`, re-login after running `usermod -aG docker $USER`.

## Troubleshooting

- Check status: `sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml ps`
- Logs: `sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml logs`
- Stop: `sudo docker compose -f docker-compose.app.yml -f docker-compose.override.yml down`
