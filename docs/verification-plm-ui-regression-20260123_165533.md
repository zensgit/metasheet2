# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260123_165533

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260123_1636.json

## Data
- Search query: UI-CMP-A-1769157422
- Product ID: dca76a3a-8a8e-48b6-98b2-3126d218a196
- Where-used child ID: 50f03969-cffa-43d3-812f-87c90c6564da
- Where-used expect: R1,R2
- BOM compare left/right: dca76a3a-8a8e-48b6-98b2-3126d218a196 / ebf05885-e63c-43c3-8db3-3f9b7e6947fa
- BOM compare expect: UI Child Z
- Substitute BOM line: 12bc4d52-79fe-4687-8728-f72e5a3166fa
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260123_165533.png
