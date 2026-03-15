# Attendance Run11 Test Brief

## Status

- Date: `2026-03-15`
- Main commit: `c2f48a8e22f2d64c692afc672ace59e1a28121ac`
- Scope: `run11` attendance release candidate

## Release Signal

- `Attendance Strict Gates (Prod)` passed on `main` after the import retry-status fix:
  - Run: `23107792219`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/23107792219>
- `Attendance Post-Merge Verify (Nightly)` still failed, but only for the known high-scale perf gate:
  - Run: `23107785329`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/23107785329>

## What Testers Should Focus On

### Login / Entry

- Opening `/login` should no longer hammer `/api/auth/me` when there is no token.
- Opening `/login` with a stale token should stop after a single failed `/api/auth/me` probe.

### Attendance Overview

- Punching in/out should show current-day status feedback instead of only returning a raw event payload.
- Dates in records and requests should display in localized user-facing format, not raw ISO timestamps.
- Punch-related error messages should be localized instead of exposing backend English text directly.

### Admin Console

- Holiday-related sections are grouped together in this order:
  - `节假日策略 -> 节假日同步 -> 节假日`
- `节假日覆盖规则` is now collapsed by default and expands on click.
- Clicking `新增覆盖` should reveal an editable row, and `节假日名称` should fill the available column width.
- Holiday settings should save and still be visible after reload.
- `holidaySync.lastRun: null` is now accepted on settings save; the previous GET/PUT mismatch should be gone.

### Import / Provisioning

- Invalid JSON in the admin import payload should show both:
  - the error message
  - the retry action (`Retry preview` / `重试预览` or `Retry import` / `重试导入`)
- The desktop admin import flow that previously timed out in strict gates should now complete.
- Numeric placeholder group names such as `"1"` should no longer auto-create attendance groups during CSV import.

### Leave / Rules

- Leave types should clearly preserve and display `paid/unpaid`.

## Known Non-Blocking Issue

- High-scale import perf still fails:
  - Run: `23107883313`
  - URL: <https://github.com/zensgit/metasheet2/actions/runs/23107883313>
  - Current error: `CSV exceeds max rows (20000)`
  - Tracking issue: [#447](https://github.com/zensgit/metasheet2/issues/447)
- This is being treated as a separate perf track, not as a `run11` functional release blocker.

## Recommended Test Pass

1. Login page idle behavior
2. Attendance overview punch flow
3. Attendance request submission / approval
4. Admin holiday policy + holiday data save/reload
5. Admin import invalid JSON retry behavior
6. Admin import preview/commit happy path
7. Leave type `paid/unpaid` visibility

## Reference Runs

- Strict gates pass: <https://github.com/zensgit/metasheet2/actions/runs/23107792219>
- Post-merge verify summary: <https://github.com/zensgit/metasheet2/actions/runs/23107785329>
- Locale zh smoke pass: <https://github.com/zensgit/metasheet2/actions/runs/23107855881>
- Perf baseline pass: <https://github.com/zensgit/metasheet2/actions/runs/23107872594>
- Daily dashboard pass: <https://github.com/zensgit/metasheet2/actions/runs/23107890684>
- Perf high-scale fail: <https://github.com/zensgit/metasheet2/actions/runs/23107883313>
