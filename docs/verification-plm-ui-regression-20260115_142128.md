# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_142128

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_142128.json

## Data
- Search query: UI-CMP-A-1768458088
- Product ID: ff8ceb4c-eb52-4cef-9e00-a67a748a06bc
- Where-used child ID: 429cf56c-bd88-4a51-8c3e-be9715465349
- Where-used expect: R1,R2
- BOM compare left/right: ff8ceb4c-eb52-4cef-9e00-a67a748a06bc / ddde8006-a169-419d-a37b-88cfd0f4f4ad
- BOM compare expect: UI Child Z
- Substitute BOM line: 2aa87f56-f56e-4d1d-bd96-375c0c380976
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260115_142128.png
