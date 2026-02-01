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

4) UI interaction (manual):
   - Open `http://localhost:8899/`
   - Ensure Attendance page loads
   - In Admin > Import:
      - Run **Preview** and **Import** (uses prepare → commit)
      - Confirm **Import Batches** list updates
      - Open a batch and verify **Batch Items**
      - Click **View** to display preview snapshot JSON
      - Trigger **Rollback** and confirm status changes to `rolled_back`
   - Note: MCP automation unavailable (transport closed), so UI clicks are manual.

## Result
- UI changes compile successfully (TypeScript + Vite build).
- UI served in dev mode (HTTP 200).
- Manual UI interaction still required for end-to-end verification.
