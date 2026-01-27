# Attendance Import Verification Report (2026-01-27)

## Environment
- Web/API: `http://142.171.239.56:8081`
- Org: `default`
- Source tag: `dingtalk_csv_test`

## Verification Steps
1. Enabled bulk import by setting `minPunchIntervalMinutes=0`.
2. Imported核对数据 (6,917 events) in batches.
3. Queried summary and records for 2026-01-20 ~ 2026-01-27.
4. Imported full month data (28,667 events) for 2025-12.
5. Queried summary for 2025-12-01 ~ 2025-12-31.
6. Restored `minPunchIntervalMinutes=1`.

## Results

### A. 核对数据 (2026-01-20 ~ 2026-01-27)
- Import results: 6,917 events, **0 failures**
- Summary API:
  - total_days: 6
  - total_minutes: 3,570
  - normal_days: 1
  - late_days: 5
  - late_early_days: 0
  - partial_days: 0
  - off_days: 2

### B. 全月数据 (2025-12-01 ~ 2025-12-31)
- Import results: 28,667 events, **0 failures**
- Summary API:
  - total_days: 23
  - total_minutes: 12,915
  - normal_days: 3
  - late_days: 20
  - off_days: 8

### C. 随机抽查记录（2025-12）
> 说明：`/api/attendance/records` 默认仅允许查看请求用户的记录，故本次随机抽查针对当前管理员用户进行。

抽样 3 条记录（随机从 2025-12 数据页获取）：
- 2025-12-13：status=off，work_minutes=1230，first_in=2025-12-12T16:48:00Z，last_out=2025-12-13T13:21:00Z
- 2025-12-31：status=late，work_minutes=570，late_minutes=260，first_in=2025-12-31T05:30:00Z，last_out=2025-12-31T15:04:00Z
- 2025-12-16：status=late，work_minutes=560，late_minutes=269，first_in=2025-12-16T05:39:00Z，last_out=2025-12-16T15:02:00Z

## Status
- ✅ Import pipeline works end-to-end (API + aggregation)
- ✅ No failed requests during batch import
- ✅ Settings restored after import

## Follow-ups
- Replace test hashed IDs with DingTalk userId mapping.
- Optional: add import job table usage instead of direct `/attendance/punch` batching.
- Optional: add cleanup endpoint by source tag.
