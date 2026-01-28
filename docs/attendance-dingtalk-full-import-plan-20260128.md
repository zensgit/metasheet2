# DingTalk Full Import Plan (2026-01-28)

## Goal
Turn DingTalk attendance export data into MetaSheet attendance imports reliably, with a repeatable preview/import flow and UI verification.

## Inputs
1) DingTalk column metadata (field id → name/alias)
2) DingTalk per-user column values (date → value) for the target range
3) Optional: column-id overrides (manual mapping fixes)

## Output
- Import payload JSON for `/api/attendance/import/preview` and `/api/attendance/import`
- UI verification using Playwright script

## Step 1: Collect Column Metadata
- Use DingTalk columns API export or your existing field mapping JSON.
- Save as JSON with `result.columns` or top-level `columns`.

Example file (shape):
```json
{
  "result": {
    "columns": [
      { "id": 14888299, "name": "上班1打卡时间", "alias": "1_on_duty_user_check_time" }
    ]
  }
}
```

## Step 2: Export Column Values (per user)
- Export data for a user and date range (DingTalk JSON with `result.column_vals`).
- Keep raw JSON per user; do not pre-aggregate.

## Step 3: Convert to Import Payload
Use the helper script to convert DingTalk JSON to MetaSheet import payload.

```bash
node scripts/attendance/dingtalk-json-to-import.mjs \
  --input /path/to/dingtalk-user.json \
  --columns /path/to/dingtalk-columns.json \
  --user-id 09141829115765 \
  --from 2025-12-01 \
  --to 2025-12-05 \
  --mapping docs/attendance-import-preview-payload.json \
  --out artifacts/attendance/import-09141829115765.json
```

Optional overrides for column id → field keys:
```bash
node scripts/attendance/dingtalk-json-to-import.mjs \
  --input /path/to/dingtalk-user.json \
  --columns /path/to/dingtalk-columns.json \
  --override /path/to/column-overrides.json \
  --user-id 09141829115765 \
  --out artifacts/attendance/import-09141829115765.json
```

## Step 4: Preview & Import
Preview:
```bash
curl -sS -X POST "$API_URL/api/attendance/import/preview" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d @artifacts/attendance/import-09141829115765.json
```

Import:
```bash
curl -sS -X POST "$API_URL/api/attendance/import" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d @artifacts/attendance/import-09141829115765.json
```

## Step 5: UI Verification (Playwright)
Use the Playwright script for a quick UI check:
```bash
WEB_URL=http://142.171.239.56:8081/attendance \
AUTH_TOKEN=... \
FROM_DATE=2025-12-01 \
TO_DATE=2025-12-05 \
USER_IDS=09141829115765,0613271732687725 \
node scripts/verify-attendance-import-ui.mjs
```

## Notes
- `attendance_group` is a field that can come from CSV/JSON; it is mapped via `attendanceGroup` in the import mapping.
- `security/driver userId` and `attendance_group` are optional; keep them in payload fields for later use.
- If a user has no punch data for the date range, the import should still create `Absent` status rows when policy rules apply.
