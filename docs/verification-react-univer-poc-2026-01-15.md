# React Univer POC Verification (2026-01-15)

## Environment
- Frontend: `apps/web-react` (Vite)
- URL: `http://127.0.0.1:5180/`
- Backend: `http://127.0.0.1:7778`
- Browser: MCP Chrome session

## Services
- Backend health: `GET /health` -> `status: ok`
- Dev token: `GET /api/auth/dev-token` -> token returned
- Views: `GET /api/univer-meta/views?sheetId=univer_demo_meta` -> views list
- Data: `GET /api/univer-meta/view?sheetId=univer_demo_meta` -> data returned

## Verification Steps
1. Open UI and toggle **Backend ON**.
2. Confirm status shows `ready` and view list is populated.
3. Use view type filters (All/Kanban) and observe list updates.
4. Set `Auto Refresh ON`, choose `30s`, reload page and confirm persistence.
5. Force error by setting Sheet to `missing_sheet` and clicking **Apply**.
6. Verify last error details show scope, HTTP code, URL, timestamp.
7. Click **Copy error** and confirm `copied` indicator.
8. Reset Sheet back to default with **Reset**.
9. Test search filter by entering `nope` (list reduces to default entry only).

## Results
- Backend toggle works and data loads without blank canvas.
- View list displays, filter chips update the list (default view option remains as a static entry).
- Auto refresh + interval persist across reload.
- Error details show `data HTTP 404 ... /api/univer-meta/view?sheetId=missing_sheet`.
- Copy error button shows `copied` confirmation.
- Search filter hides non-matching views (default entry remains visible).

## Notes
- `last error` persists after Reset (expected for the current UI design).
- Auto refresh shows `paused` when the tab is hidden; resumes when visible.

---

## 2026-01-15 Update (Backend Persistence + Error Clear)

### Verification
1. Toggle **Backend ON** and reload the page.
2. Confirm the toggle stays ON after reload.
3. Set `sheetId=missing_sheet`, click **Apply**, verify `last error` appears.
4. Click **Reset** and confirm `last error` clears after a successful refresh.

### Result
- Backend ON persists after reload via `localStorage`.
- `last error` clears on successful fetch (scope-specific).

---

## 2026-01-15 Update (View Filters Persistence + Clear State)

### Verification
1. Select **Kanban** filter and set **Search** to `nope`.
2. Reload the page and confirm filter/search persist.
3. Click **Clear State** and confirm:
   - Search input is empty.
   - Active filter resets to **All**.
   - Errors are cleared and view returns to default.

### Result
- Filter and search persist across reload.
- Clear State resets filters/search and clears error UI.
