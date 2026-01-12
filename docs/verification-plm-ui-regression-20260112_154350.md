# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260112_154350

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-latest.json

## Data
- Search query: MS-BOM-A-1768203800
- Product ID: e4f91f1d-04b5-40e2-a049-0fd028b3681d
- Where-used child ID: dbd59279-61cd-49f6-b03f-b50c18707a64
- Where-used expect: n/a
- BOM compare left/right: e4f91f1d-04b5-40e2-a049-0fd028b3681d / 75f7eb2a-e717-4a1b-97ad-03427c6dc854
- BOM compare expect: MetaSheet BOM Child Z 1768203800
- Substitute BOM line: 29292f67-5188-4e33-8712-f290dffe0b5b
- Substitute expect: MetaSheet BOM Substitute 1768203800

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260112_154350.png
