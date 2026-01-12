# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260112_140709

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-latest.json

## Data
- Search query: MS-BOM-A-1768197984
- Product ID: ecbf5434-79ab-4a91-a8c3-3b61e0beaf7b
- Where-used child ID: 19961731-ea45-453b-967d-bb8f3e199e20
- Where-used expect: n/a
- BOM compare left/right: ecbf5434-79ab-4a91-a8c3-3b61e0beaf7b / 4136ceca-fe6b-4d53-a089-fdc92e804056
- BOM compare expect: MetaSheet BOM Child Z 1768197984
- Substitute BOM line: c1346e94-4176-4cd6-b024-30f42a2c2880
- Substitute expect: MetaSheet BOM Substitute 1768197984

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260112_140709.png
