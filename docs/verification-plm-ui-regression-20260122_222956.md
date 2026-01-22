# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260122_222956

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260122_2229.json

## Data
- Search query: UI-CMP-A-1769092179
- Product ID: 2e4c130b-f7ab-4606-baa4-1b9fd099432b
- Where-used child ID: bf553257-874f-4e4f-b491-f527ad90259c
- Where-used expect: R0
- BOM child ID: bf553257-874f-4e4f-b491-f527ad90259c
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-22T22:29
- BOM filter: 010
- BOM compare left/right: 2e4c130b-f7ab-4606-baa4-1b9fd099432b / 6c8de434-cabc-4e6a-b5f1-3951c30bd0b7
- BOM compare expect: UI Child Z
- Substitute BOM line: 8d0d5ff3-ad91-4ec6-8c8f-d5cbfc089815
- Substitute expect: UI Substitute
- Document name: UI-DOC-1769092179.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1769092179
- Approval product number: UI-CMP-A-1769092179
- Item number-only load: UI-CMP-A-1769092179

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
- Approval action controls visible (approve 1, reject 1).
- Approval history panel loaded with no table.
- Screenshot: artifacts/plm-ui-regression-20260122_222956.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260122_222956.json
