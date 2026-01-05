# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260105_212131

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260105_0835.json

## Data
- Search query: UI-CMP-A-1767573354
- Product ID: 0d285b2e-07d6-46c9-a013-e5aea4e5d516
- Where-used child ID: b6f4ebe9-41bf-483a-a956-c8aecd08b573
- Where-used expect: R1,R2
- BOM compare left/right: 0d285b2e-07d6-46c9-a013-e5aea4e5d516 / 40d6fbbd-6217-48fd-ad8e-06a995ca58b6
- BOM compare expect: UI Child Z
- Substitute BOM line: e988e9ad-7c22-443b-bbd3-f768cd0094a9
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/smoke/plm-ui-regression-20260105_212131.png
