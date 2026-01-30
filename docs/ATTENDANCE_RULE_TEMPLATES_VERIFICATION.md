# Attendance Rule Templates Verification

Date: 2026-01-30

## Automated Checks
- `node --check plugins/plugin-attendance/index.cjs` ✅

## Manual Verification Steps
1. Open Attendance → Admin → Rule Sets.
2. Click **Load template** and confirm system templates include:
   - 标准上下班提醒
   - 缺卡补卡核对
   - 休息日加班
3. Select a system template, adjust parameters, and click **Create custom template**.
   - Optionally click **Export params** and verify JSON appears.
   - Paste the JSON into **Params JSON** and click **Import params**.
   - Click **Export file** and then **Import file** to validate file flow.
4. Verify the custom template appears under Custom templates and rules are populated.
5. Save the rule set and run **Rule Preview** to confirm engine warnings/reasons appear.
6. Open **Import Reconcile**:
   - Paste an `entries` payload and a corresponding `rows` payload.
   - Click **Reconcile** and verify summary counts + diff list.
   - Click **Export JSON** and **Export CSV** (CSV should include a summary section).

## Notes
- Reconcile output depends on `/api/attendance/import/preview` and respects the selected rule set and timezone.
- If no rule set is selected, default rule/engine applies.
