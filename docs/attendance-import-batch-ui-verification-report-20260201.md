# Attendance Import Batch UI Verification (2026-02-01)

## Verification Steps
1) Built web app:
   - `pnpm --filter @metasheet/web build`
   - Result: ✅ success

2) Dev server smoke check:
   - `pnpm --filter @metasheet/web dev`
   - `curl -I http://localhost:8899/` → `200 OK`
   - Result: ✅ UI served

3) Backend API smoke check (to seed batch for UI):
   - `POST /api/attendance/import/prepare` → `commit` → list → items → rollback
   - Result: ✅ batch committed, items=1, rollback=`rolled_back`

4) UI interaction (Playwright):
   - Navigated to `http://localhost:8899/p/plugin-attendance/attendance`
   - Filled import payload, ran **Preview** and **Import**
   - Captured **Import Batches** list
   - Opened **Batch Items** and snapshot viewer
   - Triggered **Rollback** via confirmation dialog
   - Screenshots:
     - `artifacts/attendance-ui-verify/import-batches.png`
     - `artifacts/attendance-ui-verify/import-item-snapshot.png`

## Result
- UI changes compile successfully (TypeScript + Vite build).
- UI served in dev mode (HTTP 200).
- Manual UI interaction still required for end-to-end verification.
