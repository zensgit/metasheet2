# Ops Notes

## Docker iptables guard
Prevents Docker deploy failures caused by missing `DOCKER` iptables chain.
- Guide: `docs/ops/docker-iptables-guard.md`

## Multitable AI (「AI 自动填写」) enable runbook
Env names, the availability rule and how to verify; enabling it for a customer is an owner decision.
- Guide: `docs/ops/multitable-ai-enable-runbook.md`

## Auto-deploy workflow
The `Build and Push Docker Images` workflow deploys `backend` + `web` after builds.
- Required secrets: `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY_B64`
- Optional: `DEPLOY_PATH`, `DEPLOY_COMPOSE_FILE`
