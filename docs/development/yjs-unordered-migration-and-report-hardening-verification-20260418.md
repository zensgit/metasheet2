# Yjs Unordered Migration And Report Hardening Verification

Date: 2026-04-18

## Local Verification

Ran in the clean release worktree:

```bash
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migrations.rollback.test.ts tests/unit/db.test.ts --watch=false
node --test scripts/ops/capture-yjs-rollout-report.test.mjs
```

Results:

- backend build: passed
- `tests/unit/migrations.rollback.test.ts` + `tests/unit/db.test.ts`: `17 passed`
- `scripts/ops/capture-yjs-rollout-report.test.mjs`: `2 passed`

## Remote Rollout Baseline Verification

Target:

- host: `142.171.239.56`
- repo: `~/metasheet2`

### Deployment alignment

Updated remote `.env` to:

```bash
IMAGE_TAG=20260418-yjs-rollout-r2
```

Then ran:

```bash
docker compose -f docker-compose.app.yml pull backend web
docker compose -f docker-compose.app.yml up -d backend web
```

Observed running images:

- `ghcr.io/zensgit/metasheet2-backend:20260418-yjs-rollout-r2`
- `ghcr.io/zensgit/metasheet2-web:20260418-yjs-rollout-r2`

### One-off unordered migration execution

Before the fix, the normal migration entrypoint failed because the database had already recorded:

- `zzzz20260413130000_create_formula_dependencies`

but not:

- `zzzz20260413120000_create_automation_rules`

Using a one-off migrator run with `allowUnorderedMigrations: true`, the remote environment successfully applied:

- `zzzz20260413120000_create_automation_rules`
- `zzzz20260413130000_create_platform_app_instances`
- `zzzz20260414100000_extend_automation_rules`
- `zzzz20260414100001_create_automation_executions_and_dashboard_charts`
- `zzzz20260414100002_create_multitable_api_tokens_and_webhooks`
- `zzzz20260501100000_create_yjs_state_tables`

### Runtime status

Saved local evidence:

- `output/yjs-rollout/remote-yjs-rollout-r2-20260418-115922/status.json`

Result:

```json
{
  "baseUrl": "http://127.0.0.1:8900",
  "metrics": {
    "enabled": true,
    "initialized": true,
    "activeDocCount": 0,
    "pendingWriteCount": 0,
    "flushSuccessCount": 0,
    "flushFailureCount": 0,
    "activeSocketCount": 0,
    "activeRecordCount": 0
  },
  "failures": []
}
```

Direct authenticated curl also returned `200 OK` from `/api/admin/yjs/status`.

### Retention health

Saved local evidence:

- `output/yjs-rollout/remote-yjs-rollout-r2-20260418-115922/retention.json`

Result:

```json
{
  "failures": [],
  "stats": {
    "statesCount": 0,
    "updatesCount": 0,
    "orphanStatesCount": 0,
    "orphanUpdatesCount": 0
  },
  "hottestRecords": []
}
```

### Combined report / gate behavior

Live validation also exposed an evidence-quality issue in the current deployed script path:

- `capture-yjs-rollout-report.mjs` could still serialize a retention payload with `stats: {}`
  as a healthy report when the environment used a temporary `psql` proxy;
- the resulting Markdown showed `states count: undefined`.

That exact runtime observation is why the report hardening change was added in this patch:

- future runs will fail closed instead of generating a misleading healthy report.

Remote raw operator outputs saved locally:

- `output/yjs-rollout/remote-yjs-rollout-r2-20260418-115922/report.stdout.txt`
- `output/yjs-rollout/remote-yjs-rollout-r2-20260418-115922/report.stderr.txt`
- `output/yjs-rollout/remote-yjs-rollout-r2-20260418-115922/gate.stdout.txt`
- `output/yjs-rollout/remote-yjs-rollout-r2-20260418-115922/gate.stderr.txt`

## Conclusion

The rollout environment is now unblocked at the infrastructure layer:

- the backend/web deployment is on the explicit `20260418-yjs-rollout-r2` tag;
- Yjs admin status is enabled and initialized;
- Yjs retention tables exist;
- retention baseline is clean.

The remaining code-side hardening in this patch ensures future rollout reports cannot silently pass with incomplete retention evidence.
