# Verification: PLM UI Regression (Search -> Detail -> BOM Tools) - 20260120_202035

## Goal
Verify the end-to-end PLM UI flow: search -> select -> load product -> where-used -> BOM compare -> substitutes -> documents -> approvals.

## Environment
- UI: http://127.0.0.1:8899/plm
- API: http://127.0.0.1:7778
- PLM: http://127.0.0.1:7910
- PLM_TENANT_ID: tenant-1
- PLM_ORG_ID: org-1
- BOM tools source: artifacts/plm-bom-tools-20260120_202035.json
- PLM_HEALTH_URLS: /api/v1/health,/health
- Status: pass
- Error screenshot: artifacts/plm-ui-regression-20260120_202035-error.png
- Error response: artifacts/plm-ui-regression-last-response-20260120_202035.json
- Failure bundle: n/a

## Data
- Search query: UI-CMP-A-1768911640
- Product ID: 73f6668d-1225-4c97-8bec-388fbbd67ac6
- Where-used child ID: 83b363f6-0845-4bf9-a607-b9a28f477461
- Where-used expect: R0
- BOM child ID: 83b363f6-0845-4bf9-a607-b9a28f477461
- BOM find #: 010
- BOM refdes: R0
- BOM depth: 1
- BOM effective at: 2026-01-20T20:20
- BOM filter: 010
- BOM compare left/right: 73f6668d-1225-4c97-8bec-388fbbd67ac6 / 09a085d6-dcaf-4510-a21b-87a28c4256f1
- BOM compare expect: UI Child Z
- Substitute BOM line: b44ac2ef-5615-40ac-bfaf-c9c23e406302
- Substitute expect: UI Substitute
- Document name: UI-DOC-1768911640.txt
- Document role: drawing
- Document revision: A
- Approval title: UI ECO 1768911640
- Approval product number: UI-CMP-A-1768911640
- Item number-only load: UI-CMP-A-1768911640

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
- Screenshot: artifacts/plm-ui-regression-20260120_202035.png
- Item number artifact: artifacts/plm-ui-regression-item-number-20260120_202035.json
