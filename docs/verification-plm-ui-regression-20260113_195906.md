# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260113_195906

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260113_195906.json

## Data
- Search query: UI-CMP-A-1768305549
- Product ID: 2b59ac9a-24f0-414f-b070-54aa4a20a84e
- Where-used child ID: 9c319f3b-026d-4fd8-975b-e23543278ecc
- Where-used expect: R1,R2
- BOM compare left/right: 2b59ac9a-24f0-414f-b070-54aa4a20a84e / 5f2e941c-9266-4699-a0ff-7fef26aa64a7
- BOM compare expect: UI Child Z
- Substitute BOM line: b1fa3d93-698b-45d6-8f2f-998910beb872
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260113_195906.png
