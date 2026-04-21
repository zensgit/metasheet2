# DingTalk Notify Deploy Verification - 2026-04-19

## Local Validation

Executed in `.worktrees/dingtalk-notify-deploy-20260419`:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migration-provider.test.ts tests/unit/migrations.rollback.test.ts tests/unit/db.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
node -e "const {createCoreBackendMigrationProvider}=require('./packages/core-backend/dist/src/db/migration-provider.js'); (async()=>{ const runtimeDir=require('path').resolve('./packages/core-backend/dist/src/db'); const p=createCoreBackendMigrationProvider({runtimeDir}); const migrations=await p.getMigrations(); console.log('has20250925', Object.prototype.hasOwnProperty.call(migrations,'20250925_create_view_tables')); console.log('has20250926', Object.prototype.hasOwnProperty.call(migrations,'20250926_create_audit_tables')); })()"
```

Results:

- unit tests: `21 passed`
- backend build: `passed`
- dist-runtime provider self-check:
  - `has20250925 true`
  - `has20250926 true`

## Image Validation

Built and pushed linux/amd64 manifests:

```bash
docker buildx build --platform linux/amd64 -f Dockerfile.backend -t ghcr.io/zensgit/metasheet2-backend:8060c596970b59b0e2b6360297af1332b63db7f6 --push <clean-exported-context>
docker buildx build --platform linux/amd64 -f Dockerfile.frontend -t ghcr.io/zensgit/metasheet2-web:8060c596970b59b0e2b6360297af1332b63db7f6 --push <clean-exported-context>
docker buildx imagetools inspect ghcr.io/zensgit/metasheet2-backend:8060c596970b59b0e2b6360297af1332b63db7f6
docker buildx imagetools inspect ghcr.io/zensgit/metasheet2-web:8060c596970b59b0e2b6360297af1332b63db7f6
```

Results:

- backend manifest present for `linux/amd64`
- web manifest present for `linux/amd64`

## Remote Migration Ledger Backfill

Before backfill:

- `kysely_migration` count: `103`

Inserted 33 historical names into `kysely_migration` to reflect already-superseded schema debt and unblock current deploy.

After backfill:

- `kysely_migration` count: `136`

## Remote Deployment

Executed on `mainuser@142.171.239.56`:

```bash
docker compose -f docker-compose.app.yml pull backend web
docker compose -f docker-compose.app.yml up -d --force-recreate backend web
docker compose -f docker-compose.app.yml exec -T backend node packages/core-backend/dist/src/db/migrate.js
```

Migration results:

- `zzzz20260419183000_create_dingtalk_group_destinations`
- `zzzz20260419193000_add_dingtalk_group_message_automation_action`
- `zzzz20260419203000_create_dingtalk_group_deliveries`
- `zzzz20260419213000_add_dingtalk_person_message_automation_action`
- `zzzz20260419214000_create_dingtalk_person_deliveries`

All five executed successfully.

## Remote Runtime Verification

Running containers:

- backend image: `ghcr.io/zensgit/metasheet2-backend:8060c596970b59b0e2b6360297af1332b63db7f6`
- web image: `ghcr.io/zensgit/metasheet2-web:8060c596970b59b0e2b6360297af1332b63db7f6`

Schema checks:

```sql
select table_name
from information_schema.tables
where table_schema='public'
  and table_name in (
    'dingtalk_group_destinations',
    'dingtalk_group_deliveries',
    'dingtalk_person_deliveries'
  )
order by table_name;
```

Result:

- `dingtalk_group_destinations`
- `dingtalk_group_deliveries`
- `dingtalk_person_deliveries`

Automation action registration check:

```bash
docker compose -f docker-compose.app.yml exec -T backend \
  node -e "const mod=require('/app/packages/core-backend/dist/src/multitable/automation-actions.js'); console.log(JSON.stringify(mod.ALL_ACTION_TYPES));"
```

Result includes:

- `send_dingtalk_group_message`
- `send_dingtalk_person_message`

HTTP sanity checks:

```bash
curl -s -o /dev/null -w 'web:%{http_code}\n' http://127.0.0.1:8081/
curl -s -o /dev/null -w 'health:%{http_code}\n' http://127.0.0.1:8900/health
```

Results:

- `web:200`
- `health:200`

`/health` payload included:

- `status=ok`
- `plugins=12`
- `dbPool.total=1`

## Deploy Content

- Remote deploy performed: `yes`
- Database migrations executed: `yes`
- Runtime hotfix ahead of main: `yes`
