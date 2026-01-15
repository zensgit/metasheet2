# React Univer POC Backend Proxy Verification (2026-01-14)

## Changes
- Added Vite proxy for `/api` → `http://127.0.0.1:7778`.
- Default meta API base now empty string, so fetch goes through proxy.
- Backend toggle now treats non-2xx response as an error and surfaces HTTP status.
- Added in-app inputs for sheetId/viewId with Apply button (no restart needed).
- Added localStorage persistence for sheetId/viewId plus Reset button.
- Added basic field styling for select (background) and link (blue text) cells.
- Added numeric right alignment and formula monospace/gray style.

## Status
- Backend running on `127.0.0.1:7778` (health OK).
- Toggle to **Backend ON** reaches `ready` state and renders meta data via proxy.
- Sheet/View inputs render and Apply is enabled only when values change.

## How to validate live backend
1. Start core backend on `127.0.0.1:7778`.
2. Reload `http://localhost:5180/`.
3. Click **Backend ON**.
4. Status should move to `ready` and grid should render backend data.
