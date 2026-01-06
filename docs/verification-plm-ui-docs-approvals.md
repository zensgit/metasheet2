# PLM UI documents/approvals integration verification

Date: 2026-01-06

## Summary
- UI `/plm` renders product search/detail + documents + approvals.
- Verified using dev token and mock PLM adapter (no external PLM required).

## Environment
- Backend: `pnpm --filter @metasheet/core-backend dev`
- Frontend: `VITE_API_BASE=http://127.0.0.1:7778 pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
- Auth: `GET /api/auth/dev-token` stored in `localStorage.auth_token`

## Steps performed
1. Opened `http://127.0.0.1:8899/plm` and set `auth_token`.
2. Clicked **Search** → returned 3 mock products.
3. Clicked **Use** on first product → detail panel populated.
4. Clicked **Load documents** → documents table rendered (mock `Spec.pdf`).
5. Clicked **Load approvals** → approvals empty state (expected in mock mode).

## Observed results
- Auth pill shows `Token set`.
- Search: `Total 3, showing 3`.
- Product detail shows name/code/version/status and description.
- Documents list contains one row (`Spec.pdf`, type `specification`).
- Approvals list empty (mock mode returns none).

## Notes
- Mock PLM is used when `PLM_BASE_URL` is not configured.
- For real Yuantus, set `PLM_BASE_URL` + `PLM_API_MODE=yuantus` and supply credentials.
