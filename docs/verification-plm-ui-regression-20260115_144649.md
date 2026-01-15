# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_144649

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_144649.json

## Data
- Search query: UI-CMP-A-1768459609
- Product ID: 6792aa5a-7e6c-4640-adf6-f16a93477216
- Where-used child ID: f9640505-fbac-4a22-8c4d-e66578fe5f43
- Where-used expect: R1,R2
- BOM compare left/right: 6792aa5a-7e6c-4640-adf6-f16a93477216 / 0ca8ff11-6093-4e1c-8cd4-77442e46ac40
- BOM compare expect: UI Child Z
- Substitute BOM line: 6e85e175-a83c-4313-bf34-c5b19ba5f1dc
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260115_144649.png
