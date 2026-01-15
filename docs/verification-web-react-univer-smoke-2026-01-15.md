# Web React Univer UI Smoke (Playwright) - 2026-01-15

## Environment
- Script: `scripts/verify-web-react-univer-smoke.mjs`
- API base: `http://127.0.0.1:7778`
- Web base: `http://127.0.0.1:5180`
- Headless: `true`
- Report JSON: `artifacts/univer-poc/verify-web-react-univer-smoke.json`

## Checks
- Preflight API/Web reachable
- Backend ON toggle
- Auto Refresh ON + interval `30s`
- View type filter (Kanban)
- Search filter persistence
- Backend/Auto Refresh/Interval persistence after reload
- Error flow (missing sheet) + Copy error
- Error cleared after Reset
- Clear State resets filters/search
- Console error gating (filters expected 404s)

## Result
- ✅ All checks passed (`ok: true`).
- Copy error in headless mode reported `copy failed` (expected when clipboard is restricted in headless browser).
- Two console 404s occurred during the forced error flow and were filtered as expected.

## Headed Run (Clipboard)
- Ran with `HEADLESS=false`, `copyStatus: copied` confirmed.

## Run Command
```
NODE_PATH="$(pwd)/apps/web-react/node_modules" node scripts/verify-web-react-univer-smoke.mjs
```

## Package Script
```
pnpm verify:web-react-univer
```

## Notes
- If you want `copyStatus: copied`, run with `HEADLESS=false` so the clipboard API is available.
