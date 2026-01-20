# Docker Deployment via GHCR

This guide uses GitHub Actions to build/push Docker images to GHCR, then runs them on your cloud host with Docker Compose.

## 1) Build images on GitHub

1. Push to `main` or trigger `Build and Push Docker Images` manually in Actions.
2. Ensure the workflow has `packages: write` permissions (already set in `.github/workflows/docker-build.yml`).

Images produced:
- `ghcr.io/<owner>/metasheet2-backend:latest`
- `ghcr.io/<owner>/metasheet2-web:latest`

## 2) Prepare the cloud host

Install Docker + Docker Compose plugin:

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-plugin
```

If the GHCR repo is private, login with a PAT that has `read:packages`:

```bash
echo "<GHCR_PAT>" | docker login ghcr.io -u <github-user> --password-stdin
```

## 3) Configure runtime env

Copy the example env file and edit secrets:

```bash
cp docker/app.env.example docker/app.env
```

Update `docker/app.env`:
- `JWT_SECRET` (required)
- `POSTGRES_PASSWORD` (required)
- `DATABASE_URL` (match the Postgres password)
- Optional: `REDIS_PASSWORD` if you secure Redis

If you published images under a different owner, set one-time envs before compose:

```bash
export IMAGE_OWNER=<your-gh-owner>
export IMAGE_TAG=latest
```

## 4) Start services

```bash
docker compose -f docker-compose.app.yml pull
docker compose -f docker-compose.app.yml up -d
```

## 5) Run migrations

```bash
docker compose -f docker-compose.app.yml exec backend node packages/core-backend/dist/db/migrate.js
```

## 6) Access

- Web: `http://<host>:8080`
- API: `http://<host>:8900`

## Notes

- The web container proxies `/api` and `/socket.io` to the backend.
- If you change `POSTGRES_USER`, update the healthcheck user in `docker-compose.app.yml`.
