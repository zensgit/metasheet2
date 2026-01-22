# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260122_001137

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260122_0011.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260122_001137-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260122_001137.json
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1769011881
- Product ID: ddeeb9f0-c884-47a7-b8ea-d4058ec7a433
- Where-used child ID: 055b23b8-c9b0-4527-a4de-0e2671557fc4
- Where-used expect: R0
- BOM child ID: 055b23b8-c9b0-4527-a4de-0e2671557fc4
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-22T00:11
- BOM filter: 010
- BOM compare left/right: ddeeb9f0-c884-47a7-b8ea-d4058ec7a433 / ff6745df-54fb-4166-98ea-08c0caad9b0f
- BOM compare expect: UI Child Z
- Substitute BOM line: 41c192d2-31f7-4379-9af2-e282adc487e2
- Substitute expect: UI Substitute
- Document name: UI-DOC-1769011881.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1769011881
- Approval product number: UI-CMP-A-1769011881
- Item number-only load: UI-CMP-A-1769011881

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
- Screenshot: artifacts/plm-ui-regression-20260122_001137.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260122_001137.json
