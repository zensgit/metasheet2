# Attendance Import CSV Upload Channel (2026-02-12)

This document records the **CSV upload channel** for Attendance imports. It is intended for **extreme-scale payloads** (roughly `200k-500k+` rows) where embedding `csvText` inside a JSON request becomes fragile due to reverse-proxy/body-size limits and JSON parse overhead.

For the overall extreme-scale plan and baselines, see:

- `docs/attendance-production-import-extreme-scale-plan-20260212.md`

## API Contract

### `POST /api/attendance/import/upload`

Uploads a CSV file as a **raw request body** (not multipart) and returns a `csvFileId` that can be used in the existing import payload.

Auth:

- Requires `attendance:admin`
- Still subject to Attendance production security middleware (IP allowlist, etc.)

Request:

- Header: `Content-Type: text/csv` (recommended)
- Query:
  - `orgId` (optional; defaults to `default`)
  - `filename` (optional; metadata only)
- Body: raw CSV text/binary (use `--data-binary @file.csv` with curl)

Response:

- `201`:
  - `{ ok: true, data: { fileId, rowCount, bytes, createdAt, expiresAt, maxBytes } }`

Errors (examples):

- `400 VALIDATION_ERROR`: multipart uploads, missing data rows
- `401 UNAUTHORIZED`: user identity missing
- `403 IP_RESTRICTED`: allowlist configured and client IP not permitted
- `413 PAYLOAD_TOO_LARGE`: exceeds `ATTENDANCE_IMPORT_UPLOAD_MAX_BYTES`
- `410 EXPIRED`: the uploaded file expired before use (applies to later preview/commit that references the file)

## Import Payload Change

The existing import payload now supports:

- `csvFileId?: string` (UUID)

Behavior:

- If `csvFileId` is present, the server reads the CSV from disk and proceeds exactly like a `csvText` import:
  - respects `csvOptions`
  - enforces the server-side CSV row cap (`ATTENDANCE_IMPORT_CSV_MAX_ROWS`)
  - supports both sync and async commit paths
- If `csvFileId` is absent, the legacy `csvText`/`rows[]`/`entries[]` behaviors remain unchanged.

## Storage, Cleanup, and TTL

Uploads are stored on the backend host filesystem under:

- `ATTENDANCE_IMPORT_UPLOAD_DIR/<orgId>/<fileId>.csv`
- `ATTENDANCE_IMPORT_UPLOAD_DIR/<orgId>/<fileId>.json` (metadata)

Cleanup behavior:

- Best-effort deletion after successful commit (sync/async) and rollback.
- Best-effort periodic janitor deletes expired uploads.
- TTL is enforced at read time (preview/commit using `csvFileId`).

Ops note:

- If the backend container can restart independently, mount `ATTENDANCE_IMPORT_UPLOAD_DIR` to a persistent volume. Otherwise a restart can remove uploads before commit.

## Env Vars

Upload channel knobs (all optional; safe defaults):

- `ATTENDANCE_IMPORT_UPLOAD_DIR`
  - default: `<backend cwd>/uploads/attendance-import`
- `ATTENDANCE_IMPORT_UPLOAD_MAX_BYTES`
  - default: `120MB`
- `ATTENDANCE_IMPORT_UPLOAD_TTL_MS`
  - default: `24h`
- `ATTENDANCE_IMPORT_UPLOAD_CLEANUP`
  - default: enabled (`true`); set to `false` to disable the janitor
- `ATTENDANCE_IMPORT_UPLOAD_CLEANUP_INTERVAL_MS`
  - default: `30m`

## Web UI Behavior

In the Attendance Admin import UI:

- When selecting a CSV file:
  - If file size is `< 5MB`, the UI embeds CSV as `csvText` (legacy behavior).
  - If file size is `>= 5MB`, the UI uploads via `POST /api/attendance/import/upload` and switches the payload to `csvFileId`.
- The upload call is bound to the selected `orgId` at upload time to avoid later mismatch.

Implementation:

- `apps/web/src/views/AttendanceView.vue`

## Verification (Remote, GA Evidence)

### 1) Strict Gates (Post-Deploy)

- Run: [Attendance Strict Gates (Prod) #21949081591](https://github.com/zensgit/metasheet2/actions/runs/21949081591) (`SUCCESS`)
- Evidence (downloaded):
  - `output/playwright/ga/21949081591/20260212-134540-1/`
  - `output/playwright/ga/21949081591/20260212-134540-2/`

Previous strict-gate re-validation (post upload channel deploy):

- Run: [Attendance Strict Gates (Prod) #21948274924](https://github.com/zensgit/metasheet2/actions/runs/21948274924) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21948274924/attendance-strict-gates-prod-21948274924-1/20260212-132140-1/`
  - `output/playwright/ga/21948274924/attendance-strict-gates-prod-21948274924-1/20260212-132140-2/`

### 2) Perf Baseline (500k, async+export+rollback, upload_csv=true)

- Run: [Attendance Import Perf Baseline #21948416024](https://github.com/zensgit/metasheet2/actions/runs/21948416024) (`SUCCESS`)
- Evidence (downloaded):
  - `output/playwright/ga/21948416024/attendance-perf-mljhqv6r-wx77vt/perf-summary.json`
- previewMs: `16290`
- commitMs: `463804`
- exportMs: `14491`
- rollbackMs: `6566`

Comparison baseline (500k, async+export+rollback, inline `csvText`):

- Run: [Attendance Import Perf Baseline #21946763144](https://github.com/zensgit/metasheet2/actions/runs/21946763144) (`SUCCESS`)
- Evidence:
  - `output/playwright/ga/21946763144/attendance-perf-mljfw881-6fyhbk/perf-summary.json`
- previewMs: `22687`
- commitMs: `627089`
- exportMs: `16627`
- rollbackMs: `6877`

## Manual Smoke (Token Placeholder Only)

Do not paste real tokens into docs.

```bash
API_BASE="http://142.171.239.56:8081/api"
AUTH_TOKEN="<ADMIN_JWT>"

# Upload
curl -sS -X POST "${API_BASE}/attendance/import/upload?orgId=default&filename=demo.csv" \
  -H "Authorization: Bearer ${AUTH_TOKEN}" \
  -H "Content-Type: text/csv" \
  --data-binary "@./demo.csv"
```

Then place the returned `fileId` into the JSON payload as `csvFileId` and run the existing preview/commit flow.
