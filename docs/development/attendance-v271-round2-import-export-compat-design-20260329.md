# Attendance v2.7.1 Round 2 Import/Export Compatibility Design

Date: 2026-03-29

## Context

Second-round `v2.7.1` feedback narrowed the remaining runtime gaps to:

1. CSV upload -> prepare -> commit could still end with `No rows to import` even when the file looked structurally valid.
2. `/api/attendance/payroll-cycles/:id/export` returned `404` while `/api/attendance/payroll-cycles/:id/summary/export` worked.

The reported CSV example used API-style column names such as `workDate` and `1_on_duty_user_check_time`, plus slash dates like `2026/3/26`.

## Goals

- Make the upload channel use the same notion of “valid data row” as preview/commit.
- Accept common CSV date variants such as `YYYY/M/D`.
- Keep CSV imports compatible when callers use API-style required columns under the default admin flow.
- Add a narrow compatibility alias for payroll-cycle CSV export without changing existing canonical routes.

## Non-Goals

- No new punch-event detail API in this slice.
- No further admin UI work in this slice.
- No change to the canonical payroll summary/export contract; the alias only reduces client breakage.

## Design

### 1. Upload validation uses parsed non-empty rows

`/api/attendance/import/upload` previously derived `rowCount` from physical line count. That could diverge from preview/commit, which parse CSV rows and ignore blank data rows.

The upload route now calls the same CSV row iterator used by import processing and:

- validates the header as before
- counts parsed non-empty data rows
- rejects files that only contain a header row plus empty lines
- stores the parsed `rowCount` in upload metadata and response

This closes the “upload says 1 row, commit says no rows” class of drift for header-only or visually empty CSV files.

### 2. CSV workDate normalization accepts non-zero-padded slash dates

`normalizeCsvWorkDate()` now accepts `YYYY/M/D` and normalizes it to `YYYY-MM-DD`.

Examples:

- `2026/3/26` -> `2026-03-26`
- `2026/03/26` -> `2026-03-26`

### 3. Required-field lookup accepts canonical aliases

`resolveRequiredFieldValue()` now checks a small alias table so the default daily-summary admin path also recognizes API-style equivalents for required punch/date fields.

Examples:

- `日期` can be satisfied by `workDate`
- `上班1打卡时间` can be satisfied by `1_on_duty_user_check_time`
- `下班1打卡时间` can be satisfied by `1_off_duty_user_check_time`

This keeps the current default import profile usable for API-column CSV uploads without forcing callers to know an extra profile flag.

### 4. Payroll-cycle export compatibility alias

Runtime now exposes:

- canonical: `/api/attendance/payroll-cycles/:id/summary/export`
- compatibility alias: `/api/attendance/payroll-cycles/:id/export`

Both routes share the same handler and produce identical CSV output.

## Minimal Working CSV Example

This API-style CSV is now accepted by the default upload -> preview -> commit flow:

```csv
workDate,userId,1_on_duty_user_check_time,1_off_duty_user_check_time,attend_result
2026/3/26,user-001,2026-03-26T09:00:00+08:00,2026-03-26T18:00:00+08:00,Normal
```

The canonical template endpoints remain:

- `GET /api/attendance/import/template`
- `GET /api/attendance/import/template.csv`
- `GET /api/attendance/import/template.csv?profileId=dingtalk_api_columns`

