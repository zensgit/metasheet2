# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260112_133307

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260112_130845.json

## Data
- Search query: MS-BOM-A-1768194525
- Product ID: 34e23df1-adc9-4d89-a980-e94d2100ce7b
- Where-used child ID: 0d6b04b9-4205-40e6-8b31-5cea99248d51
- Where-used expect: n/a
- BOM compare left/right: 34e23df1-adc9-4d89-a980-e94d2100ce7b / 456b53aa-63ff-4d48-984e-1dd52b658f33
- BOM compare expect: MetaSheet BOM Child Z 1768194525
- Substitute BOM line: add083fd-47c0-4668-a25f-e027e822fdbe
- Substitute expect: MetaSheet BOM Substitute 1768194525

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260112_133307.png
