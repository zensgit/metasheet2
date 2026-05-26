# Attendance Admin Smoke Checklist

This runbook covers the post-deploy acceptance check for attendance admin
permissions. It is intentionally narrow: separate employee attendance access
from attendance admin access, and prove the expected boundary with read-only
GET requests.

Related issues: #1846 and #1847.

## Permission boundary

Attendance has two different runtime surfaces:

- Employee/self-service attendance: `/attendance` plus read or write actions
  backed by `features.attendance=true` and normal attendance permissions.
- Attendance admin: settings, rule sets, calendars, payroll configuration,
  scheduling, import history, role templates, user search, and audit logs. This
  requires `features.attendanceAdmin=true` or the explicit `attendance:admin`
  permission.

A global-looking user role is not enough for this checklist. The source of
truth is `/api/auth/me` from the exact JWT used by the smoke run.

## Secret hygiene

Prefer a token file over a literal token in the shell:

```bash
AUTH_TOKEN_FILE="/tmp/$(whoami)-metasheet-attendance-admin.jwt"
chmod 0600 "$AUTH_TOKEN_FILE"
```

The script refuses group or world-readable token files unless
`ALLOW_INSECURE_TOKEN_FILE=1` is explicitly set for a local throwaway test.
Never commit token files or paste JWT values into GitHub issues.

If an operator grants attendance admin permissions after a user has already
logged in, re-login and use a fresh JWT. Older JWTs can still report
`features.attendanceAdmin=false`.

## Employee boundary check

Use this when validating that employee accounts can open attendance without
being treated as admins. Admin-only endpoints should return `403`; the default
attendance rule should still be readable.

```bash
API_BASE="http://<host>:<port>/api" \
AUTH_TOKEN_FILE="/tmp/<employee-jwt>.jwt" \
EXPECTED_ADMIN=false \
node scripts/verify-attendance-admin-smoke.mjs
```

Pass criteria:

- `/api/auth/me` returns 200.
- The report shows `features.attendance=true`.
- The report shows `features.attendanceAdmin=false`.
- `GET /api/attendance/rules/default` returns 2xx.
- Admin endpoints return `403` and are recorded as `forbidden as expected`.

This is the expected outcome for an employee account. It is not a product
defect by itself.

## Admin acceptance check

Use this when validating the attendance admin account after deployment or after
role changes.

```bash
API_BASE="http://<host>:<port>/api" \
AUTH_TOKEN_FILE="/tmp/<attendance-admin-jwt>.jwt" \
REQUIRE_ADMIN=true \
EXPECTED_ADMIN=true \
node scripts/verify-attendance-admin-smoke.mjs
```

Pass criteria:

- `/api/auth/me` returns 200.
- The report shows `features.attendanceAdmin=true` or
  `attendance:admin` in the effective permissions signal.
- Every endpoint in the script returns 2xx.
- The script exits 0 and writes a JSON report under
  `output/attendance-admin-smoke/`.

## Login fallback

Token files are preferred. If a short-lived local session is acceptable, the
script can also log in without printing the password:

```bash
API_BASE="http://<host>:<port>/api" \
LOGIN_EMAIL="<attendance-admin-email>" \
LOGIN_PASSWORD="<attendance-admin-password>" \
REQUIRE_ADMIN=true \
EXPECTED_ADMIN=true \
node scripts/verify-attendance-admin-smoke.mjs
```

Unset those environment variables after the run.

## Endpoint coverage

The script performs GET-only probes for:

- `/api/auth/me`
- `/api/attendance/rules/default`
- `/api/attendance/settings`
- `/api/attendance/rule-sets`
- `/api/attendance/rule-templates`
- `/api/attendance/groups`
- `/api/attendance/import/batches`
- `/api/attendance/report-fields`
- `/api/attendance/payroll-templates`
- `/api/attendance/payroll-cycles`
- `/api/attendance/leave-types`
- `/api/attendance/overtime-rules`
- `/api/attendance/approval-flows`
- `/api/attendance/advanced-scheduling/workbench`
- `/api/attendance/rotation-rules`
- `/api/attendance/rotation-assignments`
- `/api/attendance/shifts`
- `/api/attendance/assignments`
- `/api/attendance-admin/role-templates`
- `/api/attendance-admin/users/search`
- `/api/attendance-admin/audit-logs`

## Troubleshooting

- `AUTH_NOT_ATTENDANCE_ADMIN`: the JWT is valid but does not expose
  attendance admin. Re-login after granting the role, then rerun.
- Employee run fails because admin endpoints return 2xx: the boundary is too
  loose or the wrong token was used.
- Admin run fails with `403`: the account lacks attendance admin or attendance
  import/admin-linked permissions for that route.
- Admin run fails with `503 DB_NOT_READY`: deploy or migration state must be
  checked before treating this as an RBAC failure.
- `AUTH_TOKEN_FILE_INSECURE`: chmod the token file to `0600` or stricter.
