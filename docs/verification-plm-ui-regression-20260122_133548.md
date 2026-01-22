# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260122_133548

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260122_133548.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260122_133548-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260122_133548.json
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1769060154
- Product ID: 8ca505d8-0a9b-4407-9dc6-64d12d7a7899
- Where-used child ID: 4a267e17-7fcd-4b1b-b714-b5d7f014d1eb
- Where-used expect: R0
- BOM child ID: 4a267e17-7fcd-4b1b-b714-b5d7f014d1eb
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-22T13:35
- BOM filter: 010
- BOM compare left/right: 8ca505d8-0a9b-4407-9dc6-64d12d7a7899 / 7258a6d8-f2be-4d98-a877-09e45fa8ae72
- BOM compare expect: UI Child Z
- Substitute BOM line: f4d99987-7eb0-4e61-93b5-130553986b11
- Substitute expect: UI Substitute
- Document name: UI-DOC-1769060154.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1769060154
- Approval product number: UI-CMP-A-1769060154
- Item number-only load: UI-CMP-A-1769060154

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
- Screenshot: artifacts/plm-ui-regression-20260122_133548.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260122_133548.json
