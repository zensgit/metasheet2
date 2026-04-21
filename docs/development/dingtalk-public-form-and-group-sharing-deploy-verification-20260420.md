# DingTalk Public Form And Group Sharing Deploy Verification - 2026-04-20

## Mainline Verification

Confirmed merged PRs:

- `#935` -> merge commit `97995e6af8f48d79c086f7584748bfd38843aada`
- `#936` -> merge commit `88a45881821f0792e4a54c1161588f603a59e34b`

Confirmed latest main:

```bash
git rev-parse origin/main
```

Result:

- `88a45881821f0792e4a54c1161588f603a59e34b`

## Workflow Verification

Observed GitHub Actions results:

- `Build and Push Docker Images` run `24659314048`: `success`
- `Deploy to Production` run `24659314034`: `success`

`Build and Push Docker Images` included:

- `build`: success
- `deploy`: success

## Production Runtime Verification

Remote repo head:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 \
  'cd ~/metasheet2 && git rev-parse HEAD'
```

Result:

- `88a45881821f0792e4a54c1161588f603a59e34b`

Running containers:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 \
  'cd ~/metasheet2 && docker compose -f docker-compose.app.yml ps'
```

Relevant result:

- backend image: `ghcr.io/zensgit/metasheet2-backend:88a45881821f0792e4a54c1161588f603a59e34b`
- web image: `ghcr.io/zensgit/metasheet2-web:88a45881821f0792e4a54c1161588f603a59e34b`

Additional `docker ps` confirmation:

- `metasheet-backend` -> `88a45881821f0792e4a54c1161588f603a59e34b`
- `metasheet-web` -> `88a45881821f0792e4a54c1161588f603a59e34b`

Host `.env` check:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 \
  'cd ~/metasheet2 && grep -E "^IMAGE_TAG=" .env'
```

Result:

- `IMAGE_TAG=71e29327d052f4976dff549e46d34aa96f398667`

Conclusion:

- live containers are correct
- host config file is stale

## Production Health Verification

Validated over SSH because the public hostname did not resolve from the current shell environment:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 \
  'curl -fsS http://127.0.0.1:8900/health'
```

Result:

```json
{"status":"ok","ok":true,"success":true,"timestamp":"2026-04-20T09:40:32.729Z","plugins":12,"pluginsSummary":{"total":12,"active":12,"failed":0},"dbPool":{"total":1,"idle":1,"waiting":0}}
```

## Production Schema Verification

Executed via the running backend container using `DATABASE_URL` from runtime env.

Verified columns:

```sql
select table_name, column_name, is_nullable
from information_schema.columns
where
  (table_name = 'users' and column_name in ('email', 'username'))
  or
  (table_name = 'dingtalk_group_destinations' and column_name = 'sheet_id')
order by table_name, column_name;
```

Result:

- `dingtalk_group_destinations.sheet_id` -> nullable `YES`
- `users.email` -> nullable `YES`
- `users.username` -> nullable `YES`

Verified Kysely migration ledger entries:

```sql
select name
from kysely_migration
where
  name like '%allow_no_email_users%'
  or
  name like '%sheet_scope_to_dingtalk_group_destinations%'
order by name;
```

Result:

- `zzzz20260418170000_allow_no_email_users_and_add_username`
- `zzzz20260420164500_add_sheet_scope_to_dingtalk_group_destinations`

## Deploy Content

- Remote deploy performed: `yes`
- Runtime updated to merged main head: `yes`
- Required schema present: `yes`
- Health check passed: `yes`
- Remaining ops gap: `host .env IMAGE_TAG drift`
