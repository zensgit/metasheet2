# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260110_205054

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260110_205054.json

## Data
- Search query: UI-CMP-A-1768049454
- Product ID: 40816c7d-e9b7-4e19-b9e9-9a7c3917acb9
- Where-used child ID: 4bfc11ae-cee8-493f-aeec-2f2a5601c618
- Where-used expect: R1,R2
- BOM compare left/right: 40816c7d-e9b7-4e19-b9e9-9a7c3917acb9 / 5d1e1f4d-2de9-4d85-819d-547b10c3fca7
- BOM compare expect: UI Child Z
- Substitute BOM line: ac07a92e-1f1d-44cb-af7b-38f7a14ff25b
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260110_205054.png
