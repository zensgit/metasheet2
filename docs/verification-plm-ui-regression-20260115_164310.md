# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_164310

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7788
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_164310.json

## Data
- Search query: UI-CMP-A-1768466600
- Product ID: 13a00a29-cb89-4f5b-a134-ce6b94c2d063
- Where-used child ID: 0fc36593-f7cf-46ea-9089-a7c40c7fa45b
- Where-used expect: R1,R2
- BOM compare left/right: 13a00a29-cb89-4f5b-a134-ce6b94c2d063 / f1f6ed2d-a511-4526-8635-145087fcb68d
- BOM compare expect: UI Child Z
- Substitute BOM line: 963b8081-3af5-45af-80ab-4e96f824bebe
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260115_164310.png
