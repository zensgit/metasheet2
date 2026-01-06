# PLM UI BOM tools verification

Date: 2026-01-06

## Summary
- UI `/plm` includes where-used, BOM compare, and substitutes panels.
- Verified against mock PLM responses via federation query endpoint.

## Environment
- Backend: `pnpm --filter @metasheet/core-backend dev`
- Frontend: `VITE_API_BASE=http://127.0.0.1:7778 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
- Auth: `GET /api/auth/dev-token` stored in `localStorage.auth_token`

## Steps performed
1. Opened `http://127.0.0.1:8899/plm` and confirmed auth pill shows `Token set`.
2. Clicked **Search** and selected product `1`.
3. Where-used: set Item ID `1`, recursive `true`, max levels `5`, clicked **Query**.
4. BOM compare: left `1`, right `2`, clicked **Compare**.
5. Substitutes: bom line id `line-1`, clicked **Query**.

## Observed results
- Where-used: `Total 0` with raw payload available (mock).
- BOM compare: summary `Added 1 / Removed 1 / Changed 1` with empty lists (mock).
- Substitutes: empty list with raw payload (mock).

## Notes
- For real Yuantus PLM, configure `PLM_BASE_URL` + `PLM_API_MODE=yuantus` and provide credentials.
