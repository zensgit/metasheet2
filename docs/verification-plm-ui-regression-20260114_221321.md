# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260114_221321

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260114_221321.json

## Data
- Search query: UI-CMP-A-1768400005
- Product ID: c9833005-1253-4c9c-8579-5cad3c3d052b
- Where-used child ID: d459a3ff-04cd-478b-a3b1-bdc9e3c700f9
- Where-used expect: R1,R2
- BOM compare left/right: c9833005-1253-4c9c-8579-5cad3c3d052b / a661ba7c-4d53-4dc0-80f6-18cc32e73a42
- BOM compare expect: UI Child Z
- Substitute BOM line: 6a85ca64-09a5-4e6c-be60-ff4ccb30a2f1
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260114_221321.png
