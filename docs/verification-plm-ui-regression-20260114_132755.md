# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260114_132755

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260114_1327.json

## Data
- Search query: UI-CMP-A-1768368455
- Product ID: af02612e-2029-4af0-aa8f-31a2ada01b0d
- Where-used child ID: ff4ccfcc-c175-4aeb-a5aa-7a37f1a364eb
- Where-used expect: R1,R2
- BOM compare left/right: af02612e-2029-4af0-aa8f-31a2ada01b0d / 72fff483-5875-4909-ac5c-9267c7224b2c
- BOM compare expect: UI Child Z
- Substitute BOM line: 00ca7b82-e671-4019-9ffe-4affb636aa76
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260114_132755.png
