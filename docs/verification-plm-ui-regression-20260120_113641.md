# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_113641

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_113641.json

## Data
- Search query: UI-CMP-A-1768880207
- Product ID: 3e08212e-db2f-47e4-85f9-e4e63d4715fd
- Where-used child ID: 91e71541-bdc9-4527-9b42-184c41563c76
- Where-used expect: R1,R2
- BOM child ID: 91e71541-bdc9-4527-9b42-184c41563c76
- BOM find #: 010
- BOM refdes: n/a
- BOM depth: 1
- BOM effective at: 2026-01-20T11:36
- BOM filter: 010
- BOM compare left/right: 3e08212e-db2f-47e4-85f9-e4e63d4715fd / 5df08df9-81de-4edd-a407-9c216310ed31
- BOM compare expect: UI Child Z
- Substitute BOM line: 2eac8036-254f-4a12-b362-66f1fc56cfba
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768880207.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768880207
- Approval product number: UI-CMP-A-1768880207
- Item number-only load: UI-CMP-A-1768880207

## Results
- Search returns matching row and selection loads product detail.
- Item number-only load repopulates Product ID.
- Product detail copy actions executed.
- BOM child actions executed (copy + switch).
- BOM detail validation executed (find_num/refdes + depth/effective + filter).
- BOM/Where-Used filter presets import/export/share/group/clear/conflict dialogs validated.
- BOM tree view renders with expandable nodes.
- BOM expand-to-depth button is enabled.
- BOM tree export button is enabled.
- Where-used query completes.
- BOM compare completes.
- Substitutes query completes.
- Documents table loads with expected document metadata and extended columns.
- Approvals table loads with expected approval metadata and extended columns.
- Screenshot: artifacts/plm-ui-regression-20260120_113641.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_113641.json
