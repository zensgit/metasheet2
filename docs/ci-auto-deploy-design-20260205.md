# CI Auto-Deploy Design (2026-02-05)

## Goal
Automate deployment of backend + web containers after the `Build and Push Docker Images` workflow completes on `main`.

## Workflow Change
`/.github/workflows/docker-build.yml` now includes a `deploy` job that runs after `build` and SSHs to the server to pull and recreate the backend and web containers.
The deploy step writes a smoke summary to `GITHUB_STEP_SUMMARY`.

## Deploy Steps (Remote)
1. `docker compose -f <compose-file> pull backend web`
2. `docker compose -f <compose-file> up -d --no-deps --force-recreate backend web`

## Required Secrets
- `DEPLOY_HOST`: SSH host or IP.
- `DEPLOY_USER`: SSH username.
- `DEPLOY_SSH_KEY_B64`: Base64-encoded SSH private key for the deploy user.

## Optional Secrets
- `DEPLOY_PATH`: Working directory on the server. Defaults to `metasheet2` (home-relative).
- `DEPLOY_COMPOSE_FILE`: Compose file path. Defaults to `docker-compose.app.yml`.

## Related Config Templates
`.env.example` and `.env.phase5.template` now include:
- `ATTENDANCE_IMPORT_REQUIRE_TOKEN=0` (set to `1` to enforce commit token usage).

## Safety Notes
- Deploy runs only on `main`.
- Compose commands target only `backend` and `web` services to avoid impacting DB/Redis.
