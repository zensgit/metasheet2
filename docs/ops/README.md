# Ops Notes

## Docker iptables guard
Prevents Docker deploy failures caused by missing `DOCKER` iptables chain.
- Guide: `docs/ops/docker-iptables-guard.md`

## Auto-deploy workflow
The `Build and Push Docker Images` workflow deploys `backend` + `web` after builds.
- Required secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY_B64`
- Optional: `DEPLOY_PATH`, `DEPLOY_COMPOSE_FILE`
