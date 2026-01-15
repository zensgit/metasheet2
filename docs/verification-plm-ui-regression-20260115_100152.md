# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_100152

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_100152.json

## Data
- Search query: UI-CMP-A-1768442512
- Product ID: 15565759-3f69-4438-8e95-2f6bc7acedb4
- Where-used child ID: 4311db04-0ea3-4ec5-ab9a-873230d8bc26
- Where-used expect: R1,R2
- BOM compare left/right: 15565759-3f69-4438-8e95-2f6bc7acedb4 / 3b692e06-c1f0-4531-99bf-daef001182c5
- BOM compare expect: UI Child Z
- Substitute BOM line: 2e4a9d89-dfe6-404a-b899-7f0b86829053
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260115_100152.png
