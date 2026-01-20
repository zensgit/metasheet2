# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_093613

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_093613.json

## Data
- Search query: UI-CMP-A-1768872980
- Product ID: eeb0f8af-3fc1-4968-b912-2985054d3880
- Where-used child ID: 326bbb08-8adb-4aa7-8680-9846d48f6a4a
- Where-used expect: R0
- BOM child ID: 326bbb08-8adb-4aa7-8680-9846d48f6a4a
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T09:36
- BOM filter: 010
- BOM compare left/right: eeb0f8af-3fc1-4968-b912-2985054d3880 / 1a5b39c4-d3d6-42e9-b83d-f86530187682
- BOM compare expect: UI Child Z
- Substitute BOM line: 382ef864-ba6c-472f-abe8-6f3cb753e423
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768872980.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768872980
- Approval product number: UI-CMP-A-1768872980
- Item number-only load: UI-CMP-A-1768872980

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
- Screenshot: artifacts/plm-ui-regression-20260120_093613.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_093613.json
