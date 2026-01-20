# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_163900

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_163900.json
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_163900-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_163900.json

## Data
- Search query: UI-CMP-A-1768898341
- Product ID: 232842b7-8f3f-4e4f-bbb9-8681bb4f153a
- Where-used child ID: c4d9163b-f990-40dc-b741-a6c46d838877
- Where-used expect: R0
- BOM child ID: c4d9163b-f990-40dc-b741-a6c46d838877
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T16:39
- BOM filter: 010
- BOM compare left/right: 232842b7-8f3f-4e4f-bbb9-8681bb4f153a / c0dc7c3f-c3c9-4cb4-84e7-f74c1538c073
- BOM compare expect: UI Child Z
- Substitute BOM line: d0c627b1-009e-443b-a835-02cb47a3bdbd
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768898341.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768898341
- Approval product number: UI-CMP-A-1768898341
- Item number-only load: UI-CMP-A-1768898341

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
- Screenshot: artifacts/plm-ui-regression-20260120_163900.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_163900.json
