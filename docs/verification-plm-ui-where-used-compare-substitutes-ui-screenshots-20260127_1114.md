# Verification - PLM UI Screenshots (Where-Used / BOM Compare / Substitutes)

Date: 2026-01-27

## Environment
- Yuantus PLM: http://127.0.0.1:7910
- MetaSheet core-backend: http://127.0.0.1:7778
- MetaSheet web: http://127.0.0.1:8899
- Core-backend env:
  - PLM_API_MODE=yuantus
  - PLM_BASE_URL=http://127.0.0.1:7910
  - PLM_TENANT_ID=tenant-1
  - PLM_ORG_ID=org-1
  - PLM_USERNAME=admin
  - PLM_PASSWORD=admin
  - RBAC_TOKEN_TRUST=true (dev-only)

## Data
- P1: 65b77bcc-9a45-41e5-aeda-029519be9dc9
- P2: ed88f795-fc5d-40bd-9c49-cd579a0ddd30
- C1: 073d4add-4b86-418a-8e74-9476acdb5930
- C2: 3b8804bf-1e11-4c7c-afef-ddca36ed1f0e
- BOM line P1 -> C1: 34816b5e-3da5-48df-9b54-effd5382bd63

## Steps
1. Open `/plm` in headless Chromium.
2. Inject dev token into `localStorage.auth_token`.
3. Run panel queries:
   - Where-Used (recursive, maxLevels=3)
   - BOM Compare (left=P1, right=P2, include substitutes + effectivity)
   - Substitutes (bom_line_id P1->C1)
4. Capture screenshots.

## Artifacts
- `docs/artifacts/plm-ui-where-used-20260127_1114.png`
- `docs/artifacts/plm-ui-bom-compare-20260127_1114.png`
- `docs/artifacts/plm-ui-substitutes-20260127_1114.png`
- `docs/artifacts/plm-ui-regression-20260127_1114.png`

## Result
All panels rendered with data and screenshots captured successfully.
