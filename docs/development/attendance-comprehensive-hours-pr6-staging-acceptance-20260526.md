# Comprehensive-Hours Reporting V1 — Staging Acceptance Evidence — 2026-05-26

Real-stack acceptance of the comprehensive-hours reporting V1 (value-plumbing, #1833) against
**staging** `http://23.254.236.11:8082`. This is the evidence the producer-level mock tests in
#1833 could not provide (the unit harness does not wire multitable). With this, the reporting
V1 capability moves from *code + closeout* to **staging-verified closeout**.

**Disposition:** PASS. All four `comprehensive_hours_*` columns are written to the real
`attendance_report_period_summaries` multitable snapshot; idempotent skip and cap-change
re-sync both behave correctly. Original staging settings were restored.

## Scope / safety

- Staging only — production untouched. No code change. No migration.
- Admin token read from a local 0600 file, never printed; deleted after the run. (Token had
  been pasted into the operator chat, so it was rotated/invalidated afterward.)
- The only writes were: a reversible `attendance.settings` cap change (restored at the end)
  and period-summary snapshot rows (the rebuildable report layer — designed behavior).

## Preflight gates (all green before any write)

| Gate | Result |
| --- | --- |
| 1 — staging admin JWT valid | exp `2026-06-02T02:19:08Z`, roles `[admin]`, perms `[*:*]` |
| 2 — `GET /api/auth/me` | HTTP 200, `role=admin`, `email=staging-admin-admin@example.com`, `attendanceAdmin=true`, 16 perms |
| 3 — #1829+ deployed | `GET /api/attendance/settings` → 200 carrying `comprehensiveHours.capDefaults` (absent on the pre-deploy build; its presence proved the staging backend was redeployed to current `main`, which includes #1833 / `6a70eb670` lineage) |

(An earlier preflight on the same day **correctly blocked**: the staging backend predated
#1829 — `GET settings` lacked `comprehensiveHours` — and the staging JWT was expired. The
acceptance only proceeded after a staging redeploy + fresh JWT.)

## Acceptance steps + results

| # | Action | Result |
| --- | --- | --- |
| 1 | Save original `attendance.settings` | `comprehensiveHours.capDefaults = {month:null, quarter:null, year:null}` |
| 2 | `PUT /api/attendance/settings` partial `{comprehensiveHours:{capDefaults:{month:600}}}` | 200; saved `{month:600, quarter:null, year:null}` — partial **deep-merge** preserved quarter/year |
| 3 | `GET` confirm | `capDefaults.month == 600` |
| 4 | `POST /api/attendance/report-period-summaries/sync` `{userId:<staging admin>, from:2026-04-01, to:2026-04-30}` (natural month) | `created=1`, **non-degraded**, `periodType=date_range`, sheet `sheet_f88393b5901293621cab1262` |
| 5 | Read the snapshot row (`GET /api/multitable/records` + `/fields` to map field ids) | All 4 columns present (below) |
| 6a | Re-sync, cap unchanged | `skipped=1` (idempotent — `source_fingerprint` match) |
| 6b | `PUT` cap `600→900`, re-sync | `patched=1`; row now `上限=900`, **new** `上限版本` — proves the cap value is in `source_fingerprint` (the #1833 plumbing; pre-#1833 code would not re-sync on a cap-only change) |
| 7 | Restore original settings | capDefaults back to all-null; `GET` confirms `RESTORED: true` |

### Snapshot columns observed (step 5, cap=600)

| Multitable field name | Logical code | Value |
| --- | --- | --- |
| 综合工时超额（分钟） | `comprehensive_hours_excess_minutes` | `0` |
| 综合工时上限（分钟） | `comprehensive_hours_cap_minutes` | `600` |
| 综合工时上限来源 | `comprehensive_hours_cap_source` | `org_default_by_cycle_type` |
| 综合工时上限版本 | `comprehensive_hours_cap_effective_key` | `cfg:7a6c2f2969e9` → `cfg:af909d8402f9` after cap→900 |

`excess_minutes = 0` because the staging admin user has no April attendance (actual 0 < cap),
so `max(0, 0 − 600) = 0`. The non-null cap companion fields prove the column write, and the
cap-change patch (6b) proves the fingerprint plumbing; a data-bearing user would additionally
show `excess > 0` but is not required to verify the mechanism.

## What this confirms

- #1833 value-plumbing is **live and correct on a real stack**: the resolver → period-type
  bridge → period sync → multitable snapshot path emits the metric + cap companion fields.
- The settings save-path (zod schema + deep-merge, fixed during #1829 review) round-trips the
  cap on the real wire.
- Idempotency and cap-edit-driven passive re-sync work end-to-end.
- The fail-closed `date_range` whitelist holds (the synced period was `date_range`; the cap
  resolved because the window aligned to a natural month).

## Known limits (unchanged from closeout)

Global (not per-org) settings; `month`/`quarter`/`year` only via aligned `date_range`;
`payroll_cycle`/`custom_range` → null; one metric (`excess_minutes`); no effective-dating;
no UI. See the closeout for the full list and the future opt-ins.

## Cross-references

- `docs/development/attendance-comprehensive-hours-reporting-closeout-20260525.md` — the capability closeout (now staging-verified by this run).
- `docs/development/attendance-comprehensive-hours-pr6-value-plumbing-verification-20260525.md` — #1833 design + (mock-level) verification.
- `[[staging-8082-jwt-and-deploy-lane]]` — staging preflight discipline (distinct JWT_SECRET; deploy lane does not auto-mirror main — confirmed again here).
- `[[attendance-multitable-report-boundary]]`, `[[skip-when-unreachable-blind-spot]]`.
