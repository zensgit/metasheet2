# DingTalk Production Rollout Development Log

Date: 2026-04-10

## Summary

Production was moved from the old runtime tag `5e4b8ee487a3bca7e2390f46818f17a79c7d94b8` to the merged DingTalk stack tag `810f6639a`.

Final production state:

- backend image: `ghcr.io/zensgit/metasheet2-backend:810f6639a`
- web image: `ghcr.io/zensgit/metasheet2-web:810f6639a`
- health: `ok`
- DingTalk launch: HTTP `200`
- DingTalk token exchange: `errcode=0`

## Executed Steps

### 1. Backups

- backed up production deploy files:
  - `/home/mainuser/metasheet2/.env.prod-rollout-bak-20260410T065443Z`
  - `/home/mainuser/metasheet2/docker/app.env.prod-rollout-bak-20260410T065443Z`
- created production database dump:
  - `/home/mainuser/metasheet2/artifacts/prod-db-pre-dingtalk-rollout-20260410T070733Z.sql.gz`

### 2. Source sync

- synced merged `main` source from local worktree into `/home/mainuser/metasheet2`
- excluded live env files during rsync
- sync brought in the merged DingTalk files:
  - `apps/web/src/views/RoleDelegationView.vue`
  - `packages/core-backend/src/auth/dingtalk-oauth.ts`
  - `scripts/ops/build-dingtalk-staging-images.sh`
  - `scripts/ops/validate-env-file.sh`
  - `scripts/ops/backfill-dingtalk-corp-identities.sh`

### 3. Production env repair and alignment

- rewrote `docker/app.env` from literal `\n` format to real multiline format
- updated production DingTalk keys and rollout defaults:
  - `DINGTALK_CLIENT_SECRET` -> current live secret
  - `DINGTALK_CORP_ID=dingd1f07b3ff4c8042cbc961a6cb783455b`
  - `DINGTALK_ALLOWED_CORP_IDS=dingd1f07b3ff4c8042cbc961a6cb783455b`
  - `DINGTALK_REDIRECT_URI=http://142.171.239.56:8081/login/dingtalk/callback`
  - `DINGTALK_AUTH_AUTO_LINK_EMAIL=1`
  - `DINGTALK_AUTH_AUTO_PROVISION=0`
  - `DINGTALK_AUTH_REQUIRE_GRANT=1`
- updated `/home/mainuser/metasheet2/.env` to `IMAGE_TAG=810f6639a`

Validation passed:

- `bash scripts/ops/validate-env-file.sh docker/app.env`
- `docker compose --env-file docker/app.env -f docker-compose.app.yml config`
- `bash scripts/ops/attendance-preflight.sh`

### 4. Image build

Built locally on the production host:

- `ghcr.io/zensgit/metasheet2-backend:810f6639a`
- `ghcr.io/zensgit/metasheet2-web:810f6639a`

### 5. DingTalk corpId rollout gate

- equivalent dry-run counts on production:
  - `candidate_rows=0`
  - `missing_open_id_rows=0`
  - `conflict_rows=0`
  - `apply_rows=0`

Result:

- production had no legacy DingTalk identity rows requiring corpId backfill

### 6. Production migration unblock

Production database initially failed the new migrator because of historical gaps in `kysely_migration`.

Observed blockers:

- missing `zzzz20260318123000_formalize_meta_comments`
- missing:
  - `zzzz20260320150000_add_spreadsheet_permissions_and_cell_versions`
  - `zzzz20260320163000_add_comment_permissions`
  - `zzzz20260321124000_add_meta_view_config`

Manual corrective work performed:

- applied the `formalize_meta_comments` SQL directly
- inserted the missing migration record into `kysely_migration`
- applied the three 2026-03-20 / 2026-03-21 schema and RBAC changes directly
- normalized the affected `kysely_migration.timestamp` values so the production executed order matched the current `FileMigrationProvider` order

After that, the new backend image migrator succeeded and executed:

- `zzzz20260404100000_extend_approval_tables_for_bridge`
- `zzzz20260404121000_create_meta_comment_reads`
- `zzzz20260404153000_repair_meta_core_schema`
- `zzzz20260404154500_repair_multitable_attachments_schema`
- `zzzz20260404170000_normalize_attendance_rotation_rule_shift_sequence_ids`
- `zzzz20260405190000_create_spreadsheet_permissions`
- `zzzz20260406030000_add_spreadsheet_permission_subjects`
- `zzzz20260406093000_add_meta_record_created_by`
- `zzzz20260406113000_add_multitable_share_permission`
- `zzzz20260407140000_create_plugin_after_sales_template_installs`
- `zzzz20260408123000_create_plugin_multitable_object_registry`
- `zzzz20260408160000_backfill_after_sales_plugin_multitable_object_registry`
- `zzzz20260409113000_create_delegated_role_admin_scopes`
- `zzzz20260409134000_create_delegated_role_scope_templates`
- `zzzz20260409154000_create_platform_member_groups_and_delegated_group_scopes`

### 7. Service cutover

- switched production backend first:
  - `docker compose ... up -d backend`
- verified:
  - `curl http://127.0.0.1:8900/health`
  - `curl http://127.0.0.1:8900/api/auth/dingtalk/launch`
- switched production web second:
  - `docker compose ... up -d web`

## Final Verification

Verified after cutover:

- `docker ps` shows:
  - `metasheet-backend -> ghcr.io/zensgit/metasheet2-backend:810f6639a`
  - `metasheet-web -> ghcr.io/zensgit/metasheet2-web:810f6639a`
- `curl http://127.0.0.1:8900/health` returned success
- `curl http://127.0.0.1:8081/` returned `200`
- `curl http://127.0.0.1:8900/api/auth/dingtalk/launch` returned `200`
- direct DingTalk token exchange returned:
  - `errcode=0`
  - `errmsg=ok`
  - `has_access_token=true`
- production contains the 2026-04 DingTalk/admin scope migrations

## Residual Follow-up

Next 30-minute production sanity checks should still be done in the browser and business flows:

- real DingTalk扫码登录
- real DingTalk机器人通知
- attendance sync smoke
- delegated admin scope isolation
