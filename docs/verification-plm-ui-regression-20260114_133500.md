# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260114_133500

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260114_133500.json

## Data
- Search query: UI-CMP-A-1768368905
- Product ID: 6d9a956c-bab5-4312-8bce-8ca0db13d64c
- Where-used child ID: 67678b15-81aa-45a1-98e4-7bb0019e5773
- Where-used expect: R1,R2
- BOM compare left/right: 6d9a956c-bab5-4312-8bce-8ca0db13d64c / 6ae9346d-6e12-4a82-8c5a-402d73b0865b
- BOM compare expect: UI Child Z
- Substitute BOM line: d18e4442-ee0d-42be-9dab-09fd1eea4106
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260114_133500.png
