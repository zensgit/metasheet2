# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260113_152549

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260113_1525.json

## Data
- Search query: UI-CMP-A-1768289131
- Product ID: ce96ad79-0455-463a-8c62-69feb69849ff
- Where-used child ID: f3b3d375-32c3-4d96-a192-d492965b2586
- Where-used expect: R1,R2
- BOM compare left/right: ce96ad79-0455-463a-8c62-69feb69849ff / e3912744-7745-498f-9b22-22de505fa8c0
- BOM compare expect: UI Child Z
- Substitute BOM line: 2e000b59-309a-4f5f-9baf-f8422ad22e21
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260113_152549.png
