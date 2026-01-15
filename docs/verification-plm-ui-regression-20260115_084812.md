# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_084812

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_084812.json

## Data
- Search query: UI-CMP-A-1768438103
- Product ID: 1f9d2c1e-5a81-46b3-b211-5b52a2e00463
- Where-used child ID: eaa414ad-b001-45b9-8fe4-883c32e4b643
- Where-used expect: R1,R2
- BOM compare left/right: 1f9d2c1e-5a81-46b3-b211-5b52a2e00463 / 914efe84-26c5-44c9-92bc-10eb6eb2a5ca
- BOM compare expect: UI Child Z
- Substitute BOM line: 2659a304-95ab-4353-a549-df7df6a94d2d
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260115_084812.png
