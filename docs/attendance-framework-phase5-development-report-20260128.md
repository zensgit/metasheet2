# Attendance Framework Phase 5 Development Report (2026-01-28)

## Goal
Extend rule-engine behavior to reflect leave/overtime impact on day status and expose additional summary metrics.

## Scope Completed
1. **Daily status adjustment**
   - If approved leave/overtime exists, daily status can be marked `adjusted` even when on-time.
   - If no punches but approved leave exists, day status becomes `adjusted` (instead of `absent`).
2. **Metrics enrichment**
   - Summary now includes total late minutes and total early leave minutes.
3. **OpenAPI + UI**
   - Added summary fields for total late/early minutes.
   - UI displays new totals in summary panel.

## Files Changed
- `plugins/plugin-attendance/index.cjs`
- `apps/web/src/views/AttendanceView.vue`
- `packages/openapi/src/base.yml`

## Notes
- Approved minutes are read from attendance requests (approved only) and used to influence status.
- Work minutes remain punch-based; leave/overtime are tracked separately.

## Next Steps
- Add per-day rollup to show leave/overtime minutes alongside work minutes.
- Add payroll cycle summary UI + export.
