# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260112_152705

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260112_152705.json

## Data
- Search query: MS-BOM-A-1768202825
- Product ID: 21f0065b-2055-436d-a984-8565825b9f25
- Where-used child ID: cda466f3-9398-49d4-a483-52342fe22091
- Where-used expect: n/a
- BOM compare left/right: 21f0065b-2055-436d-a984-8565825b9f25 / 24079dde-2e64-45f1-8c9d-88ab60a1b5a2
- BOM compare expect: MetaSheet BOM Child Z 1768202825
- Substitute BOM line: 3a614eba-9f45-4151-a07b-9f368fdec69e
- Substitute expect: MetaSheet BOM Substitute 1768202825

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260112_152705.png
