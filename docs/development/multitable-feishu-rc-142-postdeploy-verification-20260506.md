# Multitable Feishu RC 142 Postdeploy Verification - 2026-05-06

## Summary

Result: PASS.

The 142 deployment for `main@9464b628479cdff1769c864de05f5ec5b6bf7d94` completed successfully after rerunning a transient GHCR push failure. Postdeploy API probes passed, and the full multitable pilot browser smoke passed with `125/125` checks.

## Deployment Verification

Command:

```bash
gh run view 25435548148 --repo zensgit/metasheet2 \
  --json status,conclusion,headSha,url,createdAt,updatedAt,event,workflowName
```

Observed output:

```json
{
  "conclusion": "success",
  "createdAt": "2026-05-06T12:35:08Z",
  "event": "push",
  "headSha": "9464b628479cdff1769c864de05f5ec5b6bf7d94",
  "status": "completed",
  "updatedAt": "2026-05-06T12:57:10Z",
  "url": "https://github.com/zensgit/metasheet2/actions/runs/25435548148",
  "workflowName": "Build and Push Docker Images"
}
```

The initial workflow attempt failed while pushing GHCR with `unknown blob`. Rerunning failed jobs completed successfully. The final deploy job and K3 WISE postdeploy smoke were green.

## API Probe

Environment:

- `API_BASE=http://142.171.239.56:8081`
- Admin JWT loaded from local token file; token value was not printed.

Observed checks:

| Check | Status |
| --- | --- |
| `/api/health` | 200 |
| `/api/auth/me` | 200 |
| `/api/multitable/bases` | 200 |
| record create | 200 |
| comment create | 201 |
| comment list | 200 |
| comment resolve | 204 |
| record delete | 200 |

This specifically confirms the `#1365` comment scope write fix is deployed: `/api/comments` no longer fails on upgraded DBs with formalized `meta_comments` scope columns.

## Browser Smoke

Command:

```bash
AUTH_TOKEN="$(cat /tmp/metasheet-142-main-admin-72h.jwt)" \
API_BASE="http://142.171.239.56:8081" \
WEB_BASE="http://142.171.239.56:8081" \
OUTPUT_ROOT="output/playwright/multitable-feishu-rc-142-postdeploy-ui-smoke/$(date +%Y%m%d-%H%M%S)" \
HEADLESS=true \
ENSURE_PLAYWRIGHT=false \
TIMEOUT_MS=45000 \
pnpm verify:multitable-pilot:staging
```

Result:

- Overall: PASS
- Total checks: `125`
- Failing checks: none
- Started: `2026-05-06T13:00:15.380Z`
- Finished: `2026-05-06T13:01:41.985Z`
- Local report directory: `/private/tmp/ms2-rc-postdeploy-142-20260506/output/playwright/multitable-feishu-rc-142-postdeploy-ui-smoke/20260506-060014`

Selected passing checks:

- `ui.import.failed-retry`
- `ui.import.mapping-reconcile`
- `ui.import.people-repair-reconcile`
- `ui.import.people-manual-fix`
- `api.import.people-manual-fix-hydration`
- `ui.person.assign`
- `api.person-link-hydration`
- `api.form.attachment-upload`
- `ui.form.upload-comments`
- `api.multitable.attachment-hydration`
- `ui.grid.search-hydration`
- `ui.field-manager.prop-reconcile`
- `ui.field-manager.type-reconcile`
- `ui.view-manager.prop-reconcile`
- `ui.view-manager.field-schema-reconcile`
- `ui.field-manager.target-removal`
- `ui.view-manager.target-removal`
- `ui.gallery.config-replay`
- `ui.calendar.config-replay`
- `ui.timeline.config-replay`
- `ui.kanban.config-replay`
- `ui.kanban.empty-card-fields-replay`
- `ui.kanban.clear-group-replay`
- `ui.embed-host.navigate.blocked`
- `ui.embed-host.navigate.confirmed`
- `ui.embed-host.navigate.replayed`
- `api.form.attachment-delete-clear`
- `ui.conflict.retry`
- `api.multitable.view-submit`
- `smoke.attachment.upload-api`
- `smoke.comment.create`
- `smoke.comment.list`
- `smoke.comment.resolve`

## Docs Verification

Commands:

```bash
git diff --check
rg -n "9464b6284|125/125|unknown blob|postdeploy" \
  docs/development/multitable-feishu-rc-142-postdeploy-*.md \
  docs/development/multitable-feishu-rc-todo-20260430.md
```

Expected:

- `git diff --check` exits 0.
- The grep command finds this postdeploy evidence and TODO linkage.

## Remaining Manual Coverage

This smoke closes the deployment evidence and the known `#1365` blocker path. It does not replace the remaining Phase 1 manual Feishu-parity checks:

- XLSX frontend import/export with a real file.
- Broad field type UI smoke.
- Conditional formatting reload.
- Formula editor.
- Filter builder.
- Gantt and Hierarchy views.
- Public form submit.
- Automation `send_email`.
