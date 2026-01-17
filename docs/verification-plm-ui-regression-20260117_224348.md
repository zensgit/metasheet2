# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260117_224348

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260117_224348.json

## Data
- Search query: UI-CMP-A-1768661030
- Product ID: 352bd5fc-ebd3-4181-8b53-f59c2c4b4cea
- Where-used child ID: ace78521-0d22-48b3-8033-1c64346cc2d2
- Where-used expect: R-A1
- BOM child ID: ace78521-0d22-48b3-8033-1c64346cc2d2
- BOM find #: 010
- BOM refdes: R-A1
- BOM depth: 1
- BOM effective at: 2026-01-17T22:43
- BOM filter: 010
- BOM compare left/right: 352bd5fc-ebd3-4181-8b53-f59c2c4b4cea / 5aaeb47c-9914-458c-95d4-96c5fc594da0
- BOM compare expect: UI Child Z
- Substitute BOM line: 3d9d96bc-12b7-4889-a841-16ce3569a19c
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768661030.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768661030
- Approval product number: UI-CMP-A-1768661030
- Item number-only load: UI-CMP-A-1768661030

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Product detail copy actions executed.
- BOM child actions executed (copy + switch).
- BOM detail validation executed (find_num/refdes + depth/effective + filter).
- BOM tree view renders with expandable nodes.
- BOM expand-to-depth button is enabled.
- BOM tree export button is enabled.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata and extended columns.
- Approvals table loads with expected approval metadata and extended columns.
- Screenshot: artifacts/plm-ui-regression-20260117_224348.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260117_224348.json
