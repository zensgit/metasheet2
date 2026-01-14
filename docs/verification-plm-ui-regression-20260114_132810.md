# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260114_132810

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260114_132810.json

## Data
- Search query: UI-CMP-A-1768368492
- Product ID: f50f53a3-4408-45b2-95c8-baffcd49c892
- Where-used child ID: a29becf8-62ac-40bd-9402-c22c34ee0fef
- Where-used expect: R1,R2
- BOM compare left/right: f50f53a3-4408-45b2-95c8-baffcd49c892 / af099f8b-fcab-4dfe-84ed-195c5be10a85
- BOM compare expect: UI Child Z
- Substitute BOM line: 0fb51af2-d80a-4cf5-be10-64b4a3cb0af2
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260114_132810.png
