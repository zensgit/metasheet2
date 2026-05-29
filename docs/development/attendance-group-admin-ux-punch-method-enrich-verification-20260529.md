# Attendance Group Punch-Method Card Enrich (V1-enrich) Verification

Date: 2026-05-29
Branch: `codex/attendance-group-punch-method-enrich-20260529`
Design lock: `docs/development/attendance-group-admin-ux-punch-method-config-design-20260529.md` (#2029)

## Scope

V1-enrich runtime for the design lock: the group-detail **Punch method** summary card now shows the **live workspace-level** punch policy already loaded by `AttendanceView` — IP allowlist, geofence, minimum punch interval — explicitly framed as applying to all attendance groups, with the existing **Open Settings** link as the only edit path.

Frontend + tests only. No backend, route, schema, migration, OpenAPI, permission, or enforcement change. No new fetch. No write. No `attendance_events` / `attendance_records` access. T2 (Wi-Fi/device/photo/face) and T3 (per-group override) remain gated.

## Implementation

- `apps/web/src/views/AttendanceView.vue`:
  - Added `attendanceSettings` ref; `loadSettings()` now retains the **already-fetched** `/api/attendance/settings` response (no new request) alongside the existing `applySettingsToForm` mapping.
  - Added `AttendanceGroupSummaryPolicyLine` type + optional `policyLines` on `AttendanceGroupSummaryCard`.
  - `buildAttendanceGroupPunchPolicyLines()` derives 3 read-only lines from the loaded settings (mirrors the values `enforcePunchConstraints` applies): IP allowlist (empty → "No IP restriction"; non-empty → count only, **no raw ranges**), geofence (null → "No geofence"; else "Geofence enabled" + radius), min interval ("N minute(s)").
  - **Honesty (design §5.1):** when `attendanceSettings` is `null` (not loaded / failed / forbidden) the card shows a single neutral status line ("Loading…" or "Unavailable"), **never** a confident unrestricted policy. Only a successfully-loaded settings object (including an empty `{}` workspace default) renders the value lines.
  - Punch card `value` = "Workspace-level policy · applies to all attendance groups"; `detail` = T2 "not available" copy; `actions` = Open Settings (unchanged).
  - Template renders `policyLines` as a read-only `<ul>` with stable `data-attendance-group-punch-line="ip|geofence|interval"` selectors. No input/select/toggle/save control.

## Verification

```
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-regressions.spec.ts --watch=false   # 36/36 pass
pnpm --filter @metasheet/web exec vitest run tests/attendance-admin-anchor-nav.spec.ts --watch=false     # 30/30 pass (title "Punch method" unchanged)
pnpm --filter @metasheet/web exec vue-tsc --noEmit                                                       # exit 0, no errors
git diff --check                                                                                          # clean
```

Note: a fresh worktree has no `node_modules`; the runs above used the workspace `node_modules` symlinked in, which resolved the `echarts/*` modules that have blocked vue-tsc in borrowed worktrees previously. CI remains the source of truth.

## Test matrix mapping

| ID | Requirement | Coverage |
| --- | --- | --- |
| PM1 | Live settings values render per field. | "surfaces live workspace-level punch policy …": ip=2 ranges, geofence 200 m, interval 5 minutes. |
| PM2 | Copy is workspace-level, not group-specific. | Same test: asserts "applies to all attendance groups"; asserts `not.toContain("this group's punch")`. Plus updated list-detail assertion. |
| PM3 | Defaults: No IP restriction / No geofence / 1 minute. | "renders default punch policy as unrestricted …" (loaded settings = {}). |
| F1 | Unavailable/failed settings show neutral copy, not a confident unrestricted policy. | "shows a neutral punch policy … when workspace settings are unavailable" (settings GET 500 → status line "Unavailable", no "No IP restriction"/"No geofence", ip line absent). |
| PM4 | No input/select/textarea/toggle/save in the card. | "keeps the group punch-method card read-only …": `querySelectorAll('input, select, textarea').length === 0`; single button starts with "Open"; no `type="submit"`. |
| PM5 | Wi-Fi/device/photo/face = not-available text, no controls. | Same test: asserts "not available" + "wi-fi" + "face"; PM4 proves no controls. |
| PM6 | No settings write, no punch-policy POST/PUT. | "does not write punch policy …": clicks Open Settings; asserts zero POST/PUT/PATCH/DELETE to `/api/attendance/settings`. |
| PM7 | No backend/schema/migration/OpenAPI/enforcePunchConstraints diff. | Reviewer diff check — this PR changes only `apps/web/*` + this MD. |
| PM8 | Slice C card copy + test updated same PR. | Card `value`/`detail` updated; the list-detail assertion updated from "Workspace settings only in group settings V1" to "applies to all attendance groups". |
| PM9 | No `attendance_events` / `attendance_records` read or write from the flow. | "does not write punch policy …": asserts no `/api/attendance/punch` call and no write to `/api/attendance/records`. (A baseline GET records overview on admin mount is unrelated to this feature.) |

## Deferred (unchanged, each design-lock-first + separate opt-in)

- T2: Wi-Fi binding, hardware/device, photo, face verification.
- T3: per-group punch override (needs enforcement-path change + migration).
- mobile-client punch capabilities; owner/sub-owner; export/copy; weekly matrix; multi-shift; comprehensive-hours writes.
