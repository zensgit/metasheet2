# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260110_170622

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260110_170622.json

## Data
- Search query: UI-CMP-A-1768035982
- Product ID: 66f07f46-eaf6-4cc1-9630-9fc57d3f4579
- Where-used child ID: d292c393-917f-4568-9be1-da18ab3c87f2
- Where-used expect: R1,R2
- BOM compare left/right: 66f07f46-eaf6-4cc1-9630-9fc57d3f4579 / 99491004-0642-44ef-81d7-66b8ff1e4698
- BOM compare expect: UI Child Z
- Substitute BOM line: 1f07b0f3-bdaa-488c-a675-76f863d2e2f8
- Substitute expect: UI Substitute

## Results
- Search returns matching row and selection loads product detail.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Screenshot: artifacts/plm-ui-regression-20260110_170622.png
