# Attendance Import Development Report (2026-01-27)

## Scope
- Implemented a batch import path for attendance punch events via existing `/api/attendance/punch`.
- Prepared test data ingestion for DingTalk CSV exports.
- Added operational script for bulk import with batching, offsets, and concurrency.

## Key Changes
- Added import script: `scripts/attendance/import-punch-events.cjs`
  - Supports `--file`, `--api`, `--token`, `--org`, `--source`, `--offset`, `--limit`, `--concurrency`, `--dry-run`.
  - Normalizes fields: `userId`, `eventType`, `occurredAt`, `timezone`, `meta`.
  - Sends data to `/api/attendance/punch` with `X-User-Id`/`X-Org-Id` headers.

## Test Data Preparation
- Source CSVs:
  - `/Users/huazhou/Downloads/浙江亚光科技股份有限公司_每日汇总（新）_20251201-20251231(2) (1).csv`
  - `/Users/huazhou/Downloads/核对(2).csv`
- Generated JSON event files:
  - `/Users/huazhou/Downloads/dingtalk-csv-entries-20251201-20251231.json`
    - 28,667 events / 360 users / 31 days
  - `/Users/huazhou/Downloads/dingtalk-csv-entries-核对-20260120-20260127.json`
    - 6,917 events / 385 users / 8 days
- Test-only userId mapping (stable hash by `工号` → `钉钉账号` → `姓名`):
  - `/Users/huazhou/Downloads/dingtalk-csv-userid-map-核对.json`

## Operational Configuration (Temporary)
- Attendance settings updated for bulk import:
  - `minPunchIntervalMinutes` set to `0` during import
  - restored to `1` after import completion

## Import Execution Summary
- Source tag used: `dingtalk_csv_test`
- Small batch import (核对数据):
  - 200 + 6,717 = 6,917 events imported
- Full month import (2025-12):
  - 28,667 events imported in 2,000-row batches

## Notes / Caveats
- Test imports used stable hashed IDs instead of real DingTalk userId.
- For production, replace hashed IDs with a proper external-to-internal user mapping.
- Source tag allows future cleanup by `source = dingtalk_csv_test`.
