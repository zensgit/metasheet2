# 考勤 report-records 批量同步 live closeout 验证记录 2026-05-19

## Scope

验证 PR #1648 的 post-merge 状态：

- PR 已合并到 `main`。
- production deploy 已包含 #1648。
- staging live sync 是否具备执行条件。
- TODO 文档是否从旧的 single-user v1 口径更新为 bulk-sync 已完成口径。

## Verification Matrix

| Check | Result |
| --- | --- |
| PR #1648 merge commit | PASS: `2f211d161a301bc632165f9909b604cc05e5559a` |
| `origin/main` contains #1648 | PASS: `2f211d161 feat(attendance): add bulk report-records sync (#1648)` |
| Deploy to Production | PASS: run `26069092327`, conclusion `success`, head SHA `2f211d161a301bc632165f9909b604cc05e5559a` |
| Production backend image | PASS: `ghcr.io/zensgit/metasheet2-backend:2f211d161a301bc632165f9909b604cc05e5559a` |
| Staging tunnel | PASS: local `8082` reached staging `/api/health` |
| Staging backend image | BLOCKED: staging still runs `5ca91630307603eacbbb13ae8209721f1b4d5bf3`, which predates #1648 |
| Staging admin JWT | BLOCKED: local JWT file is expired; `/api/auth/me` returns 401 |
| Staging allUsers/pageSize sync | NOT RUN: blocked by stale staging image and expired JWT |
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

## Future Live Sync Procedure

Once staging is updated to an image containing #1648 and a fresh admin JWT exists:

```bash
API_BASE=http://localhost:8082
AUTH_TOKEN="$(cat /tmp/<staging-admin-jwt-file>.jwt)"

curl -sS -X POST "${API_BASE}/api/attendance/report-records/sync" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{"from":"2026-05-01","to":"2026-05-31","allUsers":true,"page":1,"pageSize":1}'
```

Expected evidence to capture:

- `usersScanned=1`
- `totalUsers >= 1` when staging has active org users
- `multitable.objectId=attendance_report_records`
- `fieldFingerprint` present
- `syncedAt` present
- Matching row in `attendance_report_records` with `field_fingerprint`, `source_fingerprint`, and `synced_at`

## Conclusion

#1648 is merged and deployed to production. The live staging sync remains pending because the staging backend image and JWT are not ready. This is an environment blocker, not a code failure.
