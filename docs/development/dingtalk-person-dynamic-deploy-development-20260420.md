# DingTalk Person Dynamic Recipients Deploy Development

- Date: 2026-04-20
- Scope: production rollout verification for `#952 feat(dingtalk): package dynamic person recipient automation`
- Base commit on `main`: `67d23da123b92d9d8fb96940c718f716a9d0c023`

## Goal

Confirm that the packaged DingTalk personal dynamic-recipient automation feature was not only merged to `main`, but also built, deployed, and smoke-checked by the production workflow.

## What Was Done

1. Confirmed `#952` merged into `main` at `67d23da123b92d9d8fb96940c718f716a9d0c023`.
2. Checked GitHub Actions runs triggered by that merge.
3. Verified the real production path came from `Build and Push Docker Images` run `24670485107`.
4. Downloaded the deploy artifact `deploy-logs-24670485107-1` and inspected:
   - deployed image tag
   - `.env` tag persistence
   - deploy / migrate / smoke markers
5. Recorded the rollout evidence into repository docs.

## Deployment Evidence Used

- Workflow run:
  - `Build and Push Docker Images`
  - run id `24670485107`
- Deploy job:
  - job id `72140017011`
- Artifact:
  - `deploy-logs-24670485107-1`
- Local evidence path:
  - `output/playwright/ga/24670485107/deploy.log`
  - `output/playwright/ga/24670485107/step-summary.md`

## Notes

- A direct SSH verification from the local terminal was not available in this run because non-interactive auth to `142.171.239.56` was rejected.
- Production verification therefore used the signed GitHub deploy job output plus the uploaded deploy artifact, which includes the remote deploy, migrate, and smoke logs.
