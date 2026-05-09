# Multitable Feishu RC 142 Postdeploy Design - 2026-05-06

## Scope

This is a postdeploy evidence slice for the merged `#1365` fix:

- Commit deployed: `9464b628479cdff1769c864de05f5ec5b6bf7d94`
- Target: 142 staging / `http://142.171.239.56:8081`
- Goal: prove the RC browser smoke path is no longer blocked by the issues fixed in `#1365`.

This slice does not add product code. It records the deployment and verification path so the RC TODO can distinguish:

- Deployed and verified browser smoke coverage.
- Remaining manual Feishu-parity checks that still need explicit tester coverage.

## Deployment Path

The repository deployment path is `.github/workflows/docker-build.yml`.

On a push to `main`, the workflow builds backend/frontend Docker images, pushes GHCR tags, then deploys to 142 with `IMAGE_TAG=${{ github.sha }}`.

Observed run:

- Workflow: `Build and Push Docker Images`
- Run ID: `25435548148`
- URL: `https://github.com/zensgit/metasheet2/actions/runs/25435548148`
- Event: `push`
- Head SHA: `9464b628479cdff1769c864de05f5ec5b6bf7d94`
- Final status: `completed`
- Final conclusion: `success`

The first attempt failed while pushing GHCR with a transient `unknown blob` error. The failed jobs were rerun, and the rerun completed successfully, including deploy and postdeploy smoke.

## Verification Design

The postdeploy check used two layers.

1. API readiness probe against the live 142 service.
2. Full browser smoke through `pnpm verify:multitable-pilot:staging`.

The API probe intentionally used the local 72h admin JWT file and did not print or commit the token. It validated:

- `/api/health`
- `/api/auth/me`
- `/api/multitable/bases`
- record create/delete
- comment create/list/resolve

The browser smoke validated the paths that had blocked the previous 142 run:

- Failed import retry.
- Import mapping reconciliation.
- People repair and manual-fix reconciliation.
- Exact form attachment upload/comment selector flow.
- Scoped comment create/list/resolve.
- Field/view manager reconciliation and removal.
- Gallery/calendar/timeline/kanban config replay.
- Embed-host navigation, blocked navigation, discard, deferred replay, and busy save.
- Conflict retry.
- Attachment upload/delete cleanup.

## Non-Goals

This slice does not claim completion for the full Phase 1 manual smoke list.

The following remain explicit manual/browser coverage items:

- XLSX frontend import/export with a real file.
- Broad UI validation of field types: currency, percent, rating, url, email, phone, longText, multiSelect.
- Conditional formatting persistence and reload.
- Formula editor token insertion, function insertion, and diagnostics.
- Filter builder typed controls and saved view behavior.
- Gantt view rendering.
- Hierarchy view rendering and child creation.
- Public form submit path.
- Automation `send_email` save/execute path.

## Artifact Policy

The Playwright run produced screenshots and JSON/Markdown reports under `output/playwright/...` in the temporary worktree. Those raw artifacts are local evidence and are intentionally not committed.

Only this design record, the verification summary, and the RC TODO update are committed.
