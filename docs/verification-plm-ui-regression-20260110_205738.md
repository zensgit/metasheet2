# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260110_205738

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260110_205738.json

## Data
- Search query: UI-CMP-A-1768049858
- Product ID: 06880dac-bd12-4097-abe0-e36b031d78e3
- Where-used child ID: 552a060e-123e-4f33-a82f-d070761409b9
- Where-used expect: R1,R2
- BOM compare left/right: 06880dac-bd12-4097-abe0-e36b031d78e3 / 041f07f4-e2ee-4a3d-bb79-eee874da523b
- BOM compare expect: UI Child Z
- Substitute BOM line: bbfec30f-7383-41fa-a34b-420daef8740c
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260110_205738.png
