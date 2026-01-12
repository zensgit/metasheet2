# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260112_134447

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260112_134447.json

## Data
- Search query: MS-BOM-A-1768196687
- Product ID: aecba37d-1dee-4159-8e6e-8c45d61e0904
- Where-used child ID: 2293bafc-4d1b-4a90-acd5-6ed52d4d4433
- Where-used expect: n/a
- BOM compare left/right: aecba37d-1dee-4159-8e6e-8c45d61e0904 / 9c55f083-0468-43f9-87f1-d41bc7832037
- BOM compare expect: MetaSheet BOM Child Z 1768196687
- Substitute BOM line: 129ca17c-42c5-4acd-b6c6-b4b54056f9dc
- Substitute expect: MetaSheet BOM Substitute 1768196687

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260112_134447.png
