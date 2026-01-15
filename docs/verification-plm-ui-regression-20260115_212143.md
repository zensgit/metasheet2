# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260115_212143

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7788
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260115_173732.json

## Data
- Search query: UI-CMP-A-1768469854
- Product ID: 785d314c-6e59-4fde-96d2-370f13bb1fa6
- Where-used child ID: 8ffac749-0544-4307-906e-01eab64b3270
- Where-used expect: R1,R2
- BOM compare left/right: 785d314c-6e59-4fde-96d2-370f13bb1fa6 / 129c9e48-8c98-4863-8582-16c2e4e34869
- BOM compare expect: UI Child Z
- Substitute BOM line: 07f0bdc9-b3e6-4cfe-b15c-63cca8ea282f
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768469854.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768469854
- Approval product number: UI-CMP-A-1768469854
- Item number-only load: UI-CMP-A-1768469854

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata.
- Approvals table loads with expected approval record.
- Screenshot: artifacts/plm-ui-regression-20260115_212143.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260115_212143.json
