# React Univer POC Backend Toggle Verification (2026-01-14)

## Environment
- App: `apps/web-react`
- Dev command: `pnpm --filter @metasheet/web-react exec vite -- --host 0.0.0.0 --port 5180`
- URL: `http://10.8.8.140:5180/`

## Config Defaults
- `VITE_META_API_BASE`: `http://127.0.0.1:7778`
- `VITE_META_SHEET_ID`: `univer_demo_meta`
- `VITE_META_VIEW_ID`: (empty)

## Checks Performed
1. Load page with toggle visible in header.
2. Switch toggle to **Backend ON**.
3. Verify error state is surfaced without breaking UI.
4. Confirm grid still renders local data after backend fetch failure.

## Result
- Toggle control renders and switches state.
- Backend fetch failed (expected while backend is unavailable from browser), status shows `error` and message `Failed to fetch`.
- UI remains usable with fallback local workbook data.

## Notes
- To validate live backend data, ensure `http://127.0.0.1:7778` is reachable from the browser and CORS is allowed, or override `VITE_META_API_BASE` to a reachable host.

---

## 2026-01-15 Update

### Fix Applied
- Keep a single `Univer` instance and dispose only workbook units when `workbookData` changes.
- This avoids UI teardown when switching between local data and backend data.
- Add `public/favicon.ico` for the React POC to prevent favicon 404 noise in console logs.

### Verification
1. Load page (Backend OFF shows local demo grid).
2. Toggle Backend ON.
3. Confirm status switches to `ready`.
4. Confirm grid renders backend data (`产品名称/数量/单价/总价/优先级/关联`).

### Result
- Backend toggle works without blank canvas.
- Grid switches from local demo data to backend view data successfully.

---

## 2026-01-15 Update (Views + Refresh)

### Additions
- View list fetch via `/api/univer-meta/views` with a dropdown selector.
- Manual refresh button to re-fetch views + data on demand.
- Auto-refresh toggle with selectable interval (10/30/60s) and pause when the tab is hidden.
- View selection auto-applies and hides the raw `viewId` input when list data is available.
- Dev token is refreshed once on backend enable to avoid initial 401 noise.
- Status now shows last refresh timestamps, error timestamps, and retry buttons for views/data failures.
- View list supports search filtering by name/id and groups by view type.

### Verification
1. Toggle Backend ON.
2. Confirm `views: ready` and dropdown populated.
3. Verify raw `viewId` input is hidden when dropdown is available.
4. Select a different view from the list (viewId updates automatically).
4. Click **Refresh** and verify data reloads without UI flicker.
5. Change interval and enable **Auto Refresh ON**; verify periodic reload keeps status `ready`.
6. Simulate a failure (stop backend) and confirm **Retry views** / **Retry data** appear and recover after backend returns.
7. Type in **Search** and verify the dropdown filters by name/id.
8. Switch tabs and confirm auto-refresh pauses while hidden.

### Result
- View list loads and switching viewId works.
- Manual refresh reloads view data and keeps grid stable.
- Auto refresh runs without breaking the grid.
- No initial 401 noise observed in the console after enabling backend.

---

## 2026-01-16 Update (Error Details + Filters + Persistence)

### Additions
- Status bar now shows the **last failed request** with scope, HTTP status, URL, and timestamp.
- Added **Copy error** button to export the last error payload.
- Auto-refresh state and interval persist via `localStorage`.
- View list supports quick **type filters** (All, Grid, Kanban, Calendar, Gallery, Form, Other).

### Verification
1. Toggle Backend ON and confirm status shows `ready`.
2. Stop backend to force a failure; confirm status bar shows `last error: views/data ...` with URL + HTTP status.
3. Click **Copy error** and confirm clipboard contains JSON with `scope`, `status`, and `url`.
4. Toggle auto refresh and change interval; reload the page and confirm settings persist.
5. Use the type filter chips to narrow the view list, and confirm search still works.

### Result
- Error details are visible and copyable.
- Auto-refresh settings persist after reload.
- View type filters work alongside search and dropdown grouping.
