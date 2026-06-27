# 考勤员工端规则透明度 SR-3 staging smoke runbook

**Date:** 2026-06-26
**Scope:** SR-3 closeout prep only. This runbook does **not** flip the tracker to ✅; the tracker flips only after a real staging PASS stamp.

## What This Proves

The smoke proves the SR-1/SR-2 employee-facing rules surface end to end without granting admin settings access:

- an employee token can call `GET /api/attendance/rules/me`;
- the response is locked to the token subject and token org;
- `userId` / `orgId` / spoof headers are rejected instead of silently ignored;
- the response is an explicit allowlist and does not expose admin-only settings such as geofence, approval-flow internals, or integration config;
- the overview card renders the same rule summary and warnings through the shipped frontend;
- the card clears stale rule data on reload/failure, matching the SR-2 regression contract;
- the smoke is read-only: no attendance records, requests, events, settings, or notification rows are created.

## Prerequisites

1. Staging runs a main build that includes:
   - SR-1 `GET /api/attendance/rules/me`;
   - SR-2 self-service "My attendance rules" card.
2. A disposable or known-safe employee account exists in a real staging org and has `attendance:read`.
3. The employee is an active `user_orgs` member in that org.
4. Optional but recommended: the employee belongs to at least one attendance group and schedule group so the card proves both configured and fallback labels.
5. You have:
   - `BASE_URL`;
   - `EMPLOYEE_TOKEN` for the employee;
   - `DEPLOY_SHA` for the deployed build;
   - a read-only DB connection, if residue counters are checked directly.

Do **not** use an admin token for the main positive path. The point of SR-3 is that employee self-service can read only its own explainable summary without `attendance:admin`.

## API Smoke

```bash
export BASE_URL='https://staging.example.com'
export EMPLOYEE_TOKEN='<employee bearer token>'
export DEPLOY_SHA='<staging-main-sha>'
export STAMP="self-rules-sr3-$(date +%s)"
```

Positive read:

```bash
curl -sS \
  -H "Authorization: Bearer ${EMPLOYEE_TOKEN}" \
  "${BASE_URL}/api/attendance/rules/me" | tee "/tmp/${STAMP}-rules.json"
```

Expected:

```bash
jq -e '
  .ok == true
  and (.data.userId | type == "string")
  and (.data.orgId | type == "string")
  and (.data.runtimeRule | type == "object")
  and (.data.punchPolicy | type == "object")
' "/tmp/${STAMP}-rules.json"
```

Allowlist check:

```bash
! rg -n "geoFence|approvalFlowId|approval-flow|wifiAllowlist|integrationConfig|webhook|smtp|secret|token" "/tmp/${STAMP}-rules.json"
```

Subject/org override rejection:

```bash
curl -sS -o "/tmp/${STAMP}-spoof-user.json" -w "%{http_code}\n" \
  -H "Authorization: Bearer ${EMPLOYEE_TOKEN}" \
  "${BASE_URL}/api/attendance/rules/me?userId=somebody-else"

curl -sS -o "/tmp/${STAMP}-spoof-org.json" -w "%{http_code}\n" \
  -H "Authorization: Bearer ${EMPLOYEE_TOKEN}" \
  "${BASE_URL}/api/attendance/rules/me?orgId=other-org"

curl -sS -o "/tmp/${STAMP}-spoof-header-user.json" -w "%{http_code}\n" \
  -H "Authorization: Bearer ${EMPLOYEE_TOKEN}" \
  -H "x-user-id: somebody-else" \
  "${BASE_URL}/api/attendance/rules/me"

curl -sS -o "/tmp/${STAMP}-spoof-header-org.json" -w "%{http_code}\n" \
  -H "Authorization: Bearer ${EMPLOYEE_TOKEN}" \
  -H "x-org-id: other-org" \
  "${BASE_URL}/api/attendance/rules/me"

curl -sS -o "/tmp/${STAMP}-spoof-header-tenant.json" -w "%{http_code}\n" \
  -H "Authorization: Bearer ${EMPLOYEE_TOKEN}" \
  -H "x-tenant-id: other-org" \
  "${BASE_URL}/api/attendance/rules/me"
```

Expected for each override call:

```bash
jq -e '.error.code | test("ATTENDANCE_RULES_ME_SUBJECT_OVERRIDE")' "/tmp/${STAMP}-spoof-user.json"
jq -e '.error.code | test("ATTENDANCE_RULES_ME_SUBJECT_OVERRIDE")' "/tmp/${STAMP}-spoof-org.json"
jq -e '.error.code | test("ATTENDANCE_RULES_ME_SUBJECT_OVERRIDE")' "/tmp/${STAMP}-spoof-header-user.json"
jq -e '.error.code | test("ATTENDANCE_RULES_ME_SUBJECT_OVERRIDE")' "/tmp/${STAMP}-spoof-header-org.json"
jq -e '.error.code | test("ATTENDANCE_RULES_ME_SUBJECT_OVERRIDE")' "/tmp/${STAMP}-spoof-header-tenant.json"
```

Admin-settings denial with the same employee token:

```bash
curl -sS -o "/tmp/${STAMP}-settings.json" -w "%{http_code}\n" \
  -H "Authorization: Bearer ${EMPLOYEE_TOKEN}" \
  "${BASE_URL}/api/attendance/settings"
```

Expected: `403` (or the staging auth layer's equivalent forbidden response). This proves the card is not using the admin settings endpoint.

## UI Smoke

1. Sign in as the same employee.
2. Open the attendance self-service overview.
3. Confirm the "My attendance rules / 我的考勤规则" card appears after "My status" and before request actions.
4. Confirm the card shows:
   - attendance group or "No attendance group";
   - schedule group or "No schedule group";
   - work window + timezone;
   - working days;
   - late / early grace;
   - severe / absence-late thresholds;
   - punch policy summary;
   - warning chips when the API returns warnings.
5. Trigger refresh while network throttling is enabled or by temporarily forcing the rules endpoint to fail through staging tooling. The card must clear the previous rule summary while loading and must not leave stale group/rule text after a failure.
6. Confirm no admin-only values appear in the UI text: geofence coordinates, approval-flow ids, integration config, tokens, or channel secrets.

## Residue Check

SR-3 is read-only. If DB access is available, record before/after counts for tables that should not change:

```sql
SELECT 'attendance_requests' AS table_name, count(*) FROM attendance_requests
UNION ALL SELECT 'attendance_records', count(*) FROM attendance_records
UNION ALL SELECT 'attendance_events', count(*) FROM attendance_events
UNION ALL SELECT 'attendance_leave_balance_events', count(*) FROM attendance_leave_balance_events
UNION ALL SELECT 'attendance_notification_deliveries', count(*) FROM attendance_notification_deliveries;
```

Expected: counts are unchanged before vs after. If a staging background worker changes unrelated rows during the window, rerun the smoke in a quiet window or use a dedicated disposable employee and filter counts by that employee where possible.

## Expected PASS Stamp

```text
ATTENDANCE_SELF_RULES_SR3_STAGING_SMOKE_PASS deploy=<sha> stamp=<stamp> user=<redacted-user-id> api=pass ui=pass residue=0
```

## On PASS

Backfill the tracker with a dated note like:

> **回填（YYYY-MM-DD 员工端规则透明度 SR-3 staging closeout）**：staging smoke `ATTENDANCE_SELF_RULES_SR3_STAGING_SMOKE_PASS` on deploy `<sha>`（stamp `<stamp>`）：employee token read `/api/attendance/rules/me` successfully; `userId` / `orgId` / spoof headers rejected with subject-override errors; employee token could not read admin settings; response and UI exposed only the allowlisted rule summary and warnings; refresh/failure did not leave stale rule data; read-only residue=0. SR-0 → SR-1 → SR-2 → SR-3 closed ✅.

## On FAIL

- Positive read returns 401/403: verify the employee token and `attendance:read` grant.
- Positive read returns 404: verify active `user_orgs` membership in the token org.
- Override calls return 200: the endpoint may be accepting `getOrgId`/request override input; do not close SR-3.
- Response contains raw settings/secrets: tighten SR-1 response allowlist before staging closeout.
- UI needs admin permission: SR-2 is using the wrong endpoint or an admin-only preload path.
- Stale data remains after refresh/failure: fix the SR-2 loading path before closeout.
- Residue changes: inspect whether a background worker caused unrelated changes; SR itself must not write rows.
