# 考勤 report-records 批量同步 live closeout 验证记录 2026-05-19

## Scope

验证 PR #1648 的 post-merge 和 staging live 状态：

- PR 已合并到 `main`。
- production deploy 已包含 #1648。
- staging 是否已更新到包含 #1648 的 runtime 镜像。
- staging live sync 是否可真实执行、读回和幂等。
- TODO 文档是否从旧的 single-user v1 口径更新为 bulk-sync 已完成口径。

## Verification Matrix

| Check | Result |
| --- | --- |
| PR #1648 merge commit | PASS: `2f211d161a301bc632165f9909b604cc05e5559a` |
| `origin/main` contains #1648 | PASS: `2f211d161 feat(attendance): add bulk report-records sync (#1648)` |
| Deploy to Production | PASS: run `26069092327`, conclusion `success`, head SHA `2f211d161a301bc632165f9909b604cc05e5559a` |
| Production backend image | PASS: `ghcr.io/zensgit/metasheet2-backend:2f211d161a301bc632165f9909b604cc05e5559a` |
| Latest `origin/main` image pull | EXPECTED MISS: `55f0c949...` is docs-only; GHCR runtime image was not published for this SHA |
| Staging runtime update | PASS: staging web/backend updated from `5ca91630307603eacbbb13ae8209721f1b4d5bf3` to `01d4134017febcdac5a95f6ce8898e66a81aa9aa` |
| Runtime ancestry | PASS: `01d413401...` contains #1648 (`2f211d161...`) and is the latest available runtime image before docs-only #1650 |
| Staging tunnel | PASS: local `8082` reached staging `/api/health` |
| Staging admin JWT | PASS: `/api/auth/me` returned success with the short-lived file token; token value was not printed |
| Explicit user sync | PASS: 3 rows patched, 0 failed, 0 duplicate row keys |
| Multitable readback | PASS: 3 rows, 3 distinct row keys, fingerprints and `synced_at` present, values matched fixture |
| Idempotent rerun | PASS: 3 rows skipped, 0 created, 0 patched, 0 failed |
| Staging allUsers/pageSize sync | PASS-BY-ENV: endpoint accepted `{allUsers:true,page,pageSize}` and returned an empty page because staging `user_orgs` has 0 active memberships |
| `git diff --check` | PASS |

## Commands

Deployment status:

```bash
gh run list --repo zensgit/metasheet2 --branch main --limit 20 \
  --json databaseId,displayTitle,headSha,status,conclusion,workflowName,createdAt,updatedAt,url
```

Remote container image check:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56 \
  "docker ps --format '{{.Names}} {{.Image}}' | grep -E 'metasheet-(backend|staging-backend)'"
```

Staging health check:

```bash
curl -fsS http://localhost:8082/api/health
```

JWT validity check:

```bash
AUTH_TOKEN="$(cat /tmp/<staging-admin-jwt-file>.jwt)"
curl -sS -H "Authorization: Bearer ${AUTH_TOKEN}" http://localhost:8082/api/auth/me
```

The JWT value was not printed or committed.

Staging runtime update:

```bash
ssh -i ~/.ssh/metasheet2_deploy mainuser@142.171.239.56
cd /home/mainuser/metasheet2-dingtalk-staging

# IMAGE_TAG was updated to the latest available runtime main image:
# 01d4134017febcdac5a95f6ce8898e66a81aa9aa
docker compose -f docker-compose.app.staging.yml pull backend web
docker compose -f docker-compose.app.staging.yml up -d --no-deps backend web
```

`--no-deps` was required because the long-running staging Postgres/Redis containers have historical generated names; backend/web were recreated without touching DB/Redis.

Explicit sync:

```bash
API_BASE=http://localhost:8082
AUTH_TOKEN="$(cat /tmp/<staging-admin-jwt-file>.jwt)"

curl -sS -X POST "${API_BASE}/api/attendance/report-records/sync" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"from":"2026-05-15","to":"2026-05-17","userId":"8b35cbe1-9fd6-4650-9d16-42b2c4d028d1"}'
```

All-users pagination probe:

```bash
curl -sS -X POST "${API_BASE}/api/attendance/report-records/sync?orgId=default" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"from":"2026-05-15","to":"2026-05-17","allUsers":true,"page":1,"pageSize":5}'
```

## Live Evidence

Explicit sync response:

```text
ok=true
synced=3
rowsSynced=3
created=0
patched=3
skipped=0
failed=0
duplicateRowKeys=0
fieldFingerprint=684233f9c36205f9ea59248b29f9d050f88af0cd
syncedAt=2026-05-19T01:18:37.338Z
projectId=default:attendance
objectId=attendance_report_records
sheetId=sheet_90fd4bdebbaabe12b76556bf
viewId=view_f764653146213b44d955d2b1
```

Readback from `attendance_report_records`:

```text
row_count=3
distinct_row_keys=3
rows_with_field_fingerprint=3
rows_with_source_fingerprint=3
rows_with_synced_at=3

2026-05-15 work_minutes=480 late_minutes=12 early_leave_minutes=0 status=late
2026-05-16 work_minutes=450 late_minutes=0 early_leave_minutes=30 status=early_leave
2026-05-17 work_minutes=0 late_minutes=0 early_leave_minutes=0 status=absent
```

Idempotent rerun:

```text
ok=true
synced=3
rowsSynced=3
created=0
patched=0
skipped=3
failed=0
duplicateRowKeys=0
fieldFingerprint=684233f9c36205f9ea59248b29f9d050f88af0cd
```

All-users pagination probe:

```text
ok=true
userSelection=allUsers
totalUsers=0
page=1
pageSize=5
hasNextPage=false
usersScanned=0
synced=0
```

The empty all-users result is an environment fact: staging `user_orgs` currently has 0 rows. It verifies the bulk endpoint path accepts paging parameters, but not an active-membership bulk write. The explicit user sync above verifies the report-records writer against real staging attendance rows.

## Boundaries

- The short-lived JWT was read from a local file and not printed.
- Production was not written by this verification.
- Staging DB/Redis were not recreated during image update.
- The attendance plugin still writes report-records only through the multitable API; the DB readback above was verification-only.

#1648 is merged, deployed to production, and verified on staging after updating staging to the latest available main runtime image. The report-records writer successfully patched real staging rows, readback matched the fixture, and rerun skipped all rows by fingerprint. The only remaining gap is an active-membership `allUsers` bulk-write sample; current staging has no `user_orgs` memberships, so the all-users path returned an honest empty page.
