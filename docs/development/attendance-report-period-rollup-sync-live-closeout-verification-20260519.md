# 考勤 Period Rollup live closeout 验证记录

Date: 2026-05-19

## Verification Matrix

| Check | Result |
| --- | --- |
| PR #1662 merge commit | PASS: `dc31d86688956bd474a3e3d65ca343c1672cbb16` |
| `origin/main` contains #1662 | PASS: `dc31d8668 feat(attendance): add period rollup sync UI (#1662)` |
| Production deploy | PASS: Deploy to Production run `26078413056`, conclusion `success`, head SHA `dc31d86688956bd474a3e3d65ca343c1672cbb16` |
| Staging tunnel | PASS: local `8082` reached staging `/api/health` |
| Staging runtime before update | `01d4134017febcdac5a95f6ce8898e66a81aa9aa` |
| Staging runtime after update | PASS: backend / web image `dc31d86688956bd474a3e3d65ca343c1672cbb16` |
| Staging DB / Redis | PASS: not recreated; backend / web updated with `--no-deps` |
| Staging admin JWT | PASS: regenerated short-lived file token, mode `0600`, `/api/auth/me` returned admin user; token value not printed |
| Date range sync | PASS: `created=1`, `failed=0`, `duplicateRowKeys=0` |
| Date range idempotent rerun | PASS: `skipped=1`, `created=0`, `patched=0`, `failed=0` |
| Payroll cycle sync | PASS: `periodType=payroll_cycle`, `created=1`, `failed=0` |
| Payroll cycle idempotent rerun | PASS: `skipped=1`, `created=0`, `patched=0`, `failed=0` |
| allUsers pagination initial state | PASS: staging `user_orgs` initially scanned 0 users |
| allUsers active membership probe | PASS: temporary membership scanned 1 user, `skipped=1`, `failed=0` |
| Fixture cleanup | PASS: temporary `user_orgs` membership deleted; staging returned to 0 memberships |
| Multitable readback | PASS: 2 rows, 2 distinct row keys, fingerprints and `synced_at` present on all rows |
| `git diff --check` | PASS |

## Commands

Health:

```bash
curl -fsS http://localhost:8082/api/health
```

Auth:

```bash
AUTH_TOKEN="$(cat /tmp/<staging-admin-jwt-file>.jwt)"
curl -sS -H "Authorization: Bearer ${AUTH_TOKEN}" http://localhost:8082/api/auth/me
```

The JWT value was not printed or committed.

Staging update:

```bash
cd /home/mainuser/metasheet2-dingtalk-staging
docker compose -f docker-compose.app.staging.yml pull backend web
docker compose -f docker-compose.app.staging.yml up -d --no-deps backend web
```

Date range sync:

```bash
curl -sS -X POST "${API_BASE}/api/attendance/report-period-summaries/sync?orgId=default" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"from":"2026-05-15","to":"2026-05-17","userId":"8b35cbe1-9fd6-4650-9d16-42b2c4d028d1"}'
```

Payroll cycle sync:

```bash
curl -sS -X POST "${API_BASE}/api/attendance/report-period-summaries/sync?orgId=default" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"cycleId":"4a3173ab-4065-42f3-bbeb-cb02b4807db2","userId":"8b35cbe1-9fd6-4650-9d16-42b2c4d028d1"}'
```

allUsers pagination probe:

```bash
curl -sS -X POST "${API_BASE}/api/attendance/report-period-summaries/sync?orgId=default" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"from":"2026-05-15","to":"2026-05-17","allUsers":true,"page":1,"pageSize":5}'
```

## Live Evidence

Date range first sync:

```text
ok=true
periodType=date_range
periodKey=range:2026-05-15:2026-05-17
from=2026-05-15
to=2026-05-17
synced=1
rowsSynced=1
created=1
patched=0
skipped=0
failed=0
duplicateRowKeys=0
fieldFingerprint=ecefbf5d6311372c780830b1504b471afba022ec
syncedAt=2026-05-19T05:46:28.971Z
projectId=default:attendance
objectId=attendance_report_period_summaries
sheetId=sheet_f88393b5901293621cab1262
viewId=view_56cb1aa1126315cc5a35d19a
```

Date range rerun:

```text
ok=true
synced=1
rowsSynced=1
created=0
patched=0
skipped=1
failed=0
duplicateRowKeys=0
fieldFingerprint=ecefbf5d6311372c780830b1504b471afba022ec
```

Payroll cycle first sync:

```text
ok=true
periodType=payroll_cycle
periodKey=cycle:4a3173ab-4065-42f3-bbeb-cb02b4807db2
cycleId=4a3173ab-4065-42f3-bbeb-cb02b4807db2
from=2099-05-09
to=2099-05-09
synced=1
created=1
patched=0
skipped=0
failed=0
duplicateRowKeys=0
fieldFingerprint=ecefbf5d6311372c780830b1504b471afba022ec
```

Payroll cycle rerun:

```text
ok=true
periodType=payroll_cycle
synced=1
created=0
patched=0
skipped=1
failed=0
duplicateRowKeys=0
fieldFingerprint=ecefbf5d6311372c780830b1504b471afba022ec
```

allUsers initial state:

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

allUsers with temporary active membership:

```text
temporary membership inserted:
user_orgs_count=1

sync response:
ok=true
userSelection=allUsers
totalUsers=1
page=1
pageSize=5
hasNextPage=false
usersScanned=1
usersSynced=1
usersFailed=0
synced=1
rowsSynced=1
created=0
patched=0
skipped=1
failed=0
duplicateRowKeys=0
fieldFingerprint=ecefbf5d6311372c780830b1504b471afba022ec

cleanup:
deleted_memberships=1
user_orgs_count=0
```

Readback from `attendance_report_period_summaries`:

```text
row_count=2
distinct_row_keys=2
rows_with_field_fingerprint=2
rows_with_source_fingerprint=2
rows_with_synced_at=2

payroll_cycle cycle:4a3173ab-4065-42f3-bbeb-cb02b4807db2
total_work_minutes=0 total_late_minutes=0 total_early_leave_minutes=0
field_fp=ecefbf5d6311372c780830b1504b471afba022ec
source_fp=3addd9b9b0d1fe9cc1bbe35b120f918deeb68650

date_range range:2026-05-15:2026-05-17
total_work_minutes=930 total_late_minutes=12 total_early_leave_minutes=30
field_fp=ecefbf5d6311372c780830b1504b471afba022ec
source_fp=bb1f53e6a8e814b0e1c4ef151a5d89738fb3b146
```

The date range totals match the staging fixture:

```text
2026-05-15 work_minutes=480 late_minutes=12 early_leave_minutes=0
2026-05-16 work_minutes=450 late_minutes=0 early_leave_minutes=30
2026-05-17 work_minutes=0 late_minutes=0 early_leave_minutes=0
```

## Boundaries

- No production write was performed.
- Staging DB / Redis were not recreated.
- Temporary `user_orgs` fixture was removed.
- Token / JWT secret values were not printed or committed.
- Readback SQL touched `meta_*` only as verification; product code still writes through the attendance plugin API.

Period Rollup PR1 / PR2 / PR3 is now merged, deployed, and live-verified on staging.
