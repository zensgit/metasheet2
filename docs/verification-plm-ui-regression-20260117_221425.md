# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260117_221425

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7911
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260117_205457.json

## Data
- Search query: UI-CMP-A-1768654499
- Product ID: 3b710472-daad-460e-bac5-87fcc05266b7
- Where-used child ID: bf598ae6-1f38-4c84-9c71-93e2255ca699
- Where-used expect: R-A1
- BOM child ID: bf598ae6-1f38-4c84-9c71-93e2255ca699
- BOM find #: 010
- BOM refdes: R-A1
- BOM depth: 1
- BOM effective at: 2026-01-17T22:14
- BOM filter: 010
- BOM compare left/right: 3b710472-daad-460e-bac5-87fcc05266b7 / 6d980c22-9fa1-4f5d-8d78-0f2627464088
- BOM compare expect: UI Child Z
- Substitute BOM line: 4a9ec850-1fc4-4fc7-909a-ebeda69c7996
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768654499.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768654499
- Approval product number: UI-CMP-A-1768654499
- Item number-only load: UI-CMP-A-1768654499

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
- Screenshot: artifacts/plm-ui-regression-20260117_221425.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260117_221425.json
