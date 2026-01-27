# PLM UI Screenshot Regression Design (2026-01-27)

## Goal
Capture UI evidence for Where-Used, BOM Compare, and Substitutes panels with real Yuantus data.

## Tooling
- Playwright (Chromium) headless screenshots
- Targets the Vite dev server (`/plm`) and uses core-backend dev token

## Flow
1. Start core-backend with Yuantus federation env and `RBAC_TOKEN_TRUST=true` (dev-only).
2. Start web dev server (Vite).
3. Fetch dev token: `GET /api/auth/dev-token?userId=dev-plm&roles=admin`.
4. Load `/plm`, set `localStorage.auth_token`, reload.
5. Run panel interactions:
   - Where-Used: set item_id, recursive=true, maxLevels=3, click 查询.
   - BOM Compare: set left/right IDs, include substitutes + effectivity, click 对比.
   - Substitutes: set bom_line_id, click 查询.
6. Capture panel screenshots + full-page regression screenshot.

## Output
Artifacts saved under `docs/artifacts/`:
- `plm-ui-where-used-<timestamp>.png`
- `plm-ui-bom-compare-<timestamp>.png`
- `plm-ui-substitutes-<timestamp>.png`
- `plm-ui-regression-<timestamp>.png`
