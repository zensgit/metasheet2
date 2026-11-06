# Attendance 72h verification — Wave 4 residual

**Mode:** VERIFY + FILE ISSUES only. No product-fix PRs. No merge.  
**Baseline:** `origin/main` `cd42eaf74` (2026-09-21).  
**Do not duplicate:** #5941–#5944, #5961–#5968.

## Relay issue index

| Wave | Issues | Notes |
| --- | --- | --- |
| 1 (overview / reports / hero) | #5941, #5942, #5943, #5944 | #5941/#5942/#5944 closed; #5943 open discussion only |
| 2–3 (admin settings, import/cards/ACL, preview honesty, approvals bridge, anomaly ids) | #5961, #5962, #5963, #5964, #5965, #5966, #5967, #5968 | all open on this tip |
| 4 (this pass) | **#5969** | only new high-signal residual |

## Surface verdicts (Wave 4)

### 1. Annual leave / leave balance days+hours vs submit minutes — **new #5969**

Confirmed on `cd42eaf74`:

- Employee card formats `/me` minutes as days+hours with hardcoded `480` (`attendanceEmployeeWorkspacePresentation.ts` `ATTENDANCE_LEAVE_DAY_MINUTES`; same path for annual and comp_time).
- Dedicated leave card writes snapped wall-clock minutes (default 09:00–18:00 → 540) and shows hours, not standard days.
- Annual standard-day conversion (`computeAnnualLeaveStandardDayMinutes`) runs only on approve: `minutes > defaultMinutesPerDay` → `ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED`; non-divisible → `ANNUAL_LEAVE_DEDUCTION_NOT_WHOLE`.
- Admin L5a still prints raw minutes.

Not a polish issue: default shift + 480-minute leave type can create a pending request that cannot be approved.

### 2. Holiday / calendar policy edges — **no new issue**

Dual `holidayPolicy` / `calendarPolicy` arrays remain intentional (RFC §2.2; `normalizeCalendarPolicyOverrides` comment). Not re-filed.

Checked and left closed:

- Invalid holiday regex: `matchHolidayOverride` catch → no match (fail-closed).
- Incomplete calendar rows: frontend diagnostics + backend silent drop are documented “by design”.
- `from > to` calendar rows: diagnostics warn; persist as dead config; resolver skips inverted spans (`from > to`). Not fail-open payroll.
- First-day holiday hours overwrite is the existing first-day policy, not a leak.

### 3. Decision-trace / result-explain — **no new issue**

`parseAttendanceDecisionTraceQuery` + `buildAttendanceDecisionTraceRequestPath` stay fail-closed (missing category/date/uuid never hits SQL; malformed body not rendered). Self host still rejects `userId`. Calculation-detail remains API-only with no web wiring; that is an unused read surface, not broken validation.

Approve-time annual 422s are covered under #5969 (late validation), not a second trace bug.

### 4. Multi-punch / overnight — **no new issue**

- Opposite-type min-interval bypass and independent `work_minutes` / late / early semantics: already #5941 (closed as owner-decision, not a silent hole).
- Staging PDT split / zero work minutes: already #5558 (open).
- Shift save still rejects `isOvernight=false` when end < start, and the reverse (`resolveShiftTiming`).
- Live punch ambiguous work-date does not steal previous day (`resolvePunchWorkDateByShiftWindow`).

No additional obvious logic hole on this tip.

### 5. Other admin fail-open — **no new issue**

Wave 2–3 already hold the remaining high-signal admin holes: outdoor require-approval without a flow (#5961), geofence silent null (#5965), leave/OT `requiresApproval=false` ignored + multi-flow latest-wins (#5967), O3 preview vs apply honesty (#5968), report-card date residual (#5964). Nothing else in this pass met the “file only if high-signal” bar.

## New issue

- https://github.com/zensgit/metasheet2/issues/5969

## Coverage complete for now

This relay’s filed set is **#5941–#5944, #5961–#5969**. Wave 4 adds one issue. Further residual sweeps should start from that list rather than re-opening holiday dual-entry, decision-trace validation, or overnight contracts already on those tickets.
